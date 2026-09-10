import {
  FREE_ACTION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_TEXT,
} from "../../shared/contracts.js";
import type {
  Scene,
  StoryMemory,
  SceneScope,
} from "../../shared/contracts.js";
import type {
  GeneratedScene,
} from "./core.js";
import {
  stripEmbeddedChoiceMenu,
} from "./normalization.js";
import {
  normalizeComparableChoiceText,
  stripLeakedSceneMetadata,
} from "./scene-text.js";
import {
  hasTooFewChoicesForActiveScene,
  sceneScopeOrFallback,
  addSourceContinuationChoiceFallback,
  removeDuplicateChoices,
} from "./scene-validation.js";

export function normalizeSceneTalkChoices(
  scene: Scene,
  requireActiveSceneChoices = true,
): Scene {
  const outcome = scene.outcome ?? "active";
  const outcomeReason = scene.outcomeReason?.trim() || (
    outcome === "active" ? "The objective is still in progress." : "The game has ended."
  );
  const sceneWithFallback = addSourceContinuationChoiceFallback({ ...scene, outcome });
  const normalizedScene = removeDuplicateChoices({
    ...sceneWithFallback,
    text: stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(scene.text)),
    outcome,
    outcomeReason,
    choices: (outcome === "active" ? sceneWithFallback.choices : []).map((choice) => {
      const isSourceContinuationFallback =
        choice.id === SOURCE_CONTINUATION_CHOICE_ID
        && choice.type === "action"
        && (
          choice.text === "Continue story"
          || choice.text === SOURCE_CONTINUATION_CHOICE_TEXT
          || choice.text.startsWith("And so we continue toward: ")
          || choice.text.startsWith("And so we continue to the moment when ")
        );
      const id = choice.id === FREE_ACTION_CHOICE_ID
          || (choice.id === SOURCE_CONTINUATION_CHOICE_ID && !isSourceContinuationFallback)
        ? `${choice.id}_generated`
        : choice.id;
      if (choice.type === "action") {
        return {
          id,
          type: choice.type,
          text: choice.text,
          ...(choice.character ? { character: choice.character } : {}),
          ...(choice.requiredPresentCharacters
            ? { requiredPresentCharacters: choice.requiredPresentCharacters }
            : {}),
          ...(choice.requiredAbsentCharacters
            ? { requiredAbsentCharacters: choice.requiredAbsentCharacters }
            : {}),
          ...(choice.sourceEventId ? { sourceEventId: choice.sourceEventId } : {}),
          ...(choice.sourceAnchorRoute
            ? { sourceAnchorRoute: choice.sourceAnchorRoute }
            : {}),
          ...(choice.stakes ? { stakes: choice.stakes } : {}),
        };
      }

      const character = choice.character?.trim()
        || /^talk to\s+(.+?)\s*$/iu.exec(choice.text)?.[1]?.trim();
      if (!character) {
        throw new Error(`Talk choice ${choice.id} is missing a character`);
      }
      return {
        id,
        type: choice.type,
        text: `Talk to ${character}`,
        character,
        ...(choice.requiredPresentCharacters
          ? { requiredPresentCharacters: choice.requiredPresentCharacters }
          : {}),
        ...(choice.requiredAbsentCharacters
          ? { requiredAbsentCharacters: choice.requiredAbsentCharacters }
          : {}),
        ...(choice.sourceEventId ? { sourceEventId: choice.sourceEventId } : {}),
        ...(choice.sourceAnchorRoute
          ? { sourceAnchorRoute: choice.sourceAnchorRoute }
          : {}),
        ...(choice.stakes ? { stakes: choice.stakes } : {}),
      };
    }),
  });
  if (requireActiveSceneChoices && hasTooFewChoicesForActiveScene(normalizedScene)) {
    throw new Error("An active scene must offer at least two distinct choices");
  }
  return normalizedScene;
}

export interface DialogueSceneOutput {
  title: string;
  playerUtterance: string;
  playerIntent: string;
  intentType: "question" | "statement" | "accusation" | "threat" | "departure" | "action" | "other";
  responseSpeaker: string;
  responseAnchor: string;
  characterResponse: string;
  narration: string;
  sourceChapterPosition?: number | null;
  storyMemory?: StoryMemory;
  sceneScope?: SceneScope;
  choices?: Scene["choices"];
  outcome: NonNullable<Scene["outcome"]>;
  outcomeReason: string;
}

export function formatDialogueScene(
  character: string,
  output: DialogueSceneOutput,
  playerName?: string,
  playerText?: string,
  previousSceneScope?: SceneScope,
  requireActiveSceneChoices = true,
): GeneratedScene {
  let response = output.characterResponse.trim();
  if (!response) {
    throw new Error(`OpenAI returned an empty response for ${character}`);
  }
  const speakerPrefix = `${character}:`;
  while (response.toLocaleLowerCase().startsWith(speakerPrefix.toLocaleLowerCase())) {
    response = response.slice(speakerPrefix.length).trimStart();
  }
  if (!response) {
    throw new Error(`OpenAI returned only a speaker label for ${character}`);
  }
  const narration = output.narration.trim();
  if (!narration) {
    throw new Error("OpenAI returned empty dialogue narration");
  }

  return {
    ...normalizeSceneTalkChoices({
    title: output.title,
    text: [
      ...(playerName && playerText
        ? [`${playerName}: "${playerText}"`, ""]
        : []),
      `${character}: ${response}`,
      "",
      narration,
    ].join("\n"),
    choices: output.choices ?? [],
    sceneScope: sceneScopeOrFallback(output.sceneScope, previousSceneScope),
    outcome: output.outcome,
    outcomeReason: output.outcomeReason,
    }, requireActiveSceneChoices),
    ...(output.storyMemory ? { storyMemory: output.storyMemory } : {}),
  };
}

export function dialogueAttributionFailures(
  output: DialogueSceneOutput,
  playerText: string,
  character: string,
): string[] {
  const utterance = output.playerUtterance.toLocaleLowerCase();
  const anchor = output.responseAnchor.trim().toLocaleLowerCase();
  return [
    ...(output.playerUtterance.trim() !== playerText.trim()
      ? ["playerUtterance did not exactly preserve the player's latest words."]
      : []),
    ...(normalizeComparableChoiceText(output.responseSpeaker)
        !== normalizeComparableChoiceText(character)
      ? [`responseSpeaker must be exactly ${JSON.stringify(character)}.`]
      : []),
    ...(!anchor || anchor.length < 3 || !utterance.includes(anchor)
      ? ["responseAnchor must copy a meaningful phrase from playerUtterance."]
      : []),
    ...(!output.characterResponse.trim()
      ? ["characterResponse is empty."]
      : []),
    ...(!output.narration.trim()
      ? ["narration is empty."]
      : []),
  ];
}

export function dialogueChoiceStructureFailures(
  choices: Scene["choices"],
  outcome: Scene["outcome"] = "active",
): string[] {
  return [
    ...(hasTooFewChoicesForActiveScene({ choices, outcome })
      ? [
          `Only ${choices.length} distinct usable choice(s) were returned for an active dialogue; at least 2 are required.`,
        ]
      : []),
    ...choices.flatMap((choice) => {
      if (choice.type !== "talk") return [];
      if (!choice.character?.trim()) {
        return [`Talk choice ${JSON.stringify(choice.id)} is missing a target character.`];
      }
      return [];
    }),
  ];
}
