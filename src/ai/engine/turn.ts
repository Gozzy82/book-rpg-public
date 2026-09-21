import type {
  GameState,
  SceneScope,
} from "../../shared/contracts.js";
import type {
  SourceContinuationCandidate,
} from "./core.js";
import {
  stripEmbeddedChoiceMenu,
} from "./normalization.js";
import {
  findPlayerCharacterProfile,
} from "./player.js";
import {
  normalizeComparableChoiceText,
  choiceTextsAreSimilar,
  extractLeakedExternalDevelopment,
  stripLeakedSceneMetadata,
  textMentionsCharacter,
} from "./scene-text.js";

export type ImmediateTurnInputKind =
  | "selected_option"
  | "player_dialogue"
  | "world_event"
  | "scene_continuation";

export interface ImmediateTurnTransition {
  previous_scene: {
    title: string;
    text: string;
    sceneScope?: SceneScope;
  };
  latest_input: {
    kind: ImmediateTurnInputKind;
    text: string;
    unselected_options?: string[];
  };
}

export function openingCharacterContinuityFailures(
  sceneText: string,
  state: Pick<
    GameState,
    "playerName" | "characterProfiles" | "sourceIntroducedCharacters"
  >,
  sourceCandidates: readonly SourceContinuationCandidate[],
  sceneScope?: SceneScope,
): string[] {
  if (sourceCandidates.length === 0 && !state.sourceIntroducedCharacters?.length) return [];
  const profiles = state.characterProfiles ?? [];
  const playerProfile = findPlayerCharacterProfile(state.playerName, profiles);
  const playerIdentities = [
    state.playerName,
    playerProfile?.name,
    ...(playerProfile?.aliases ?? []),
  ].filter((identity): identity is string => Boolean(identity?.trim()));
  const allowedIdentities = new Set(
    [
      ...playerIdentities,
      ...(state.sourceIntroducedCharacters ?? []),
    ]
      .filter((identity): identity is string => Boolean(identity?.trim()))
      .map(normalizeComparableChoiceText),
  );
  const reachedSourceContext = sourceCandidates
    .flatMap((candidate) => [
      candidate.requiredEvent,
      candidate.currentStoryEvent?.description,
      ...(candidate.requiredEventActors ?? []),
      ...(candidate.requiredEventTargets ?? []),
      ...(candidate.currentStoryEvent?.actors ?? []),
      ...(candidate.currentStoryEvent?.targets ?? []),
    ])
    .filter((description): description is string => Boolean(description?.trim()))
    .join("\n");

  // Check source introduction against AI-reviewed presence, never against
  // verbs in the prose. Mentioning an offscreen person does not introduce them.
  return profiles.flatMap((profile) => {
    const identities = [profile.name, ...profile.aliases];
    const isAllowed = identities.some((identity) =>
      allowedIdentities.has(normalizeComparableChoiceText(identity))
      || textMentionsCharacter(reachedSourceContext, identity, profiles)
    );
    if (
      isAllowed
      || !(sceneScope?.peoplePresent ?? []).some(person =>
        identities.some(identity => normalizeComparableChoiceText(identity) === normalizeComparableChoiceText(person))
      )
    ) {
      return [];
    }
    return [
      `The opening scene depicts ${profile.name} arriving or interacting before the source introduces that character.`,
    ];
  });
}

export function buildImmediateTurnTransition(
  state: Pick<GameState, "scene" | "history">,
): ImmediateTurnTransition | undefined {
  const previousSceneText = stripLeakedSceneMetadata(
    stripEmbeddedChoiceMenu(state.scene.text),
  );
  if (!previousSceneText) return undefined;

  const latestTurn = state.history.at(-1);
  if (
    !latestTurn
    || (
      latestTurn.kind !== "choice"
      && latestTurn.kind !== "dialogue"
      && latestTurn.kind !== "event"
      && latestTurn.kind !== "continuation"
    )
  ) {
    return undefined;
  }

  const kind: ImmediateTurnInputKind = latestTurn.kind === "choice"
    ? "selected_option"
    : latestTurn.kind === "dialogue"
      ? "player_dialogue"
      : latestTurn.kind === "event"
        ? "world_event"
        : "scene_continuation";
  const text = latestTurn.kind === "continuation"
    ? latestTurn.text.trim()
    : playerTurnText(latestTurn)?.trim();
  if (!text) return undefined;
  const normalizedSelectedOption = normalizeComparableChoiceText(text);
  const unselectedOptions = kind === "selected_option"
    ? state.scene.choices
        .filter(
          (choice) =>
            normalizeComparableChoiceText(choice.text) !== normalizedSelectedOption,
        )
        .map((choice) => choice.text)
    : kind === "scene_continuation"
      ? state.scene.choices.map((choice) => choice.text)
      : [];

  return {
    previous_scene: {
      title: state.scene.title,
      text: previousSceneText,
      ...(state.scene.sceneScope ? { sceneScope: state.scene.sceneScope } : {}),
    },
    latest_input: {
      kind,
      text,
      ...(unselectedOptions.length > 0
        ? { unselected_options: unselectedOptions }
        : {}),
    },
  };
}

export function hasRepeatedSimilarText(texts: readonly string[]): boolean {
  return texts.some(
    (text, index) =>
      texts.findIndex(
        (candidate) => choiceTextsAreSimilar(text, candidate),
      ) !== index,
  );
}

export function playerTurnText(
  item: GameState["history"][number],
): string | undefined {
  if (item.kind === "choice" || item.kind === "event") return item.text;
  if (item.kind !== "dialogue") return undefined;
  return item.text.replace(/^[^:\r\n]+:\s*/u, "");
}

export function isGameStagnating(state: Pick<GameState, "history">): boolean {
  const recentPlayerTurns = state.history
    .flatMap((item) => {
      const text = playerTurnText(item);
      return text ? [text] : [];
    })
    .slice(-6);
  const repeatedPlayerTurn = hasRepeatedSimilarText(recentPlayerTurns);
  const recentDevelopments = state.history
    .filter((item) => item.kind === "scene")
    .slice(-4)
    .flatMap((item) => {
      const development = item.development?.trim()
        || extractLeakedExternalDevelopment(item.text);
      return development ? [development] : [];
    });
  const repeatedDevelopment = hasRepeatedSimilarText(recentDevelopments);
  const recentSceneTexts = state.history
    .filter((item) => item.kind === "scene")
    .slice(-4)
    .map((item) => stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(item.text)));
  const repeatedScene = hasRepeatedSimilarText(recentSceneTexts);
  return repeatedPlayerTurn || repeatedDevelopment || repeatedScene;
}

export function buildStagnationBreakingInstruction(
  instruction: string,
  hasUpcomingSourceMaterial = false,
): string {
  const anchorInstruction = hasUpcomingSourceMaterial
    ? [
        "First try to adapt the earliest compatible concrete development in upcoming_source_material as the narrative anchor.",
        "When a source anchor is compatible and does not require a separate unchosen player action, make it visibly affect this turn and set sourceChapterPosition to its chapterPosition.",
        "When reaching the anchor requires a new player decision, stop at that decision point and make choices[0] the voluntary route toward it instead of enacting it.",
        "Do not skip an earlier compatible anchor for a later or invented development.",
      ]
    : [
        "No forward source excerpt is available. Re-anchor to an unresolved source-backed conflict, relationship, location, or pressure already established in source_passage, current_scene, recent history, or the objective.",
        "Use story_memory, character_profiles, and game_profile only to recover broad central pressure and character motives; do not reveal, replay, or force later events as if they had already happened.",
      ];
  return [
    instruction,
    "",
    "STAGNATION BREAK REQUIRED: Recent turns or a rejected draft have recycled the same situation or actions.",
    "Resolve the latest player input first, then steer the scene back toward a concrete source-backed narrative anchor instead of adding another variation on the loop.",
    ...anchorInstruction,
    "Bridge to the anchor causally from the established interactive state. Never reset the scene, undo completed player actions, discard user-created events, teleport characters, or claim the interactive divergence never happened.",
    "After resolving the current micro-decision, make the re-anchored development the scene's new decision point instead of lingering on the same activity.",
    "The re-anchoring development must visibly and concretely change the world state; do not merely restate routine, atmosphere, intention, or the existing dilemma.",
    "Do not manufacture novelty with an unrelated interruption while a compatible source-backed pressure can move the story.",
    "Only when no compatible source-backed anchor can move the scene may you introduce one new plausible external event, discovery, environmental change, NPC action, arrival, accident, threat, or opportunity.",
    "Every choice must respond to the re-anchored situation and must not repeat or paraphrase any choice from recent history.",
  ].join("\n");
}

export function buildAnchorChoiceInstruction(
  instruction: string,
  hasUpcomingSourceMaterial = false,
): string {
  const anchorInstruction = hasUpcomingSourceMaterial
    ? [
        "Identify the earliest compatible concrete development in upcoming_source_material.",
        "Make choices[0] an immediate action that would causally move the player toward that source anchor on the next turn.",
        "The choice should describe an immediate player action, investigation, conversation, or transition that naturally opens a path to the anchor; do not expose or summarize unrevealed source events in the choice text.",
      ]
    : [
        "Make choices[0] an immediate action that would move the player toward an unresolved source-backed conflict, relationship, location, or pressure already established in source_passage, current_scene, recent history, or the objective.",
        "Use story_memory, character_profiles, and game_profile only to recover broad central pressure and character motives; do not reveal later events in the choice.",
      ];
  return [
    instruction,
    "",
    "ANCHOR CHOICE REQUIRED: The rejected draft left too few usable choices at the current decision point.",
    "Resolve the latest player input first and preserve its immediate consequences.",
    ...anchorInstruction,
    "Keep the choice voluntary: do not make the player take it, and do not force its anticipated source development to happen in this scene unless it is already the direct consequence of the latest input.",
    "Other choices may pursue locally meaningful alternatives, but none may repeat the consumed action or recent choices.",
  ].join("\n");
}

