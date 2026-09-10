import {
  SOURCE_CONTINUATION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_TEXT,
  SOURCE_ANCHOR_CHOICE_ID,
} from "../../shared/contracts.js";
import type {
  GameState,
  Scene,
  SceneScope,
  CharacterProfile,
} from "../../shared/contracts.js";
import type {
  SourceContinuationCandidate,
} from "./core.js";
import type {
  SourceChoiceNavigationEvent,
} from "./source-navigation.js";
import {
  findPlayerCharacterProfile,
} from "./player.js";
import {
  normalizeComparableChoiceText,
  comparableChoiceTokens,
  choiceTextsAreSimilar,
  normalizedScopeIdentity,
  extractLeakedExternalDevelopment,
  textMentionsCharacter,
  textNarratesCharacterArrival,
} from "./scene-text.js";
import {
  visibleSourceEventNarrative,
} from "./source-navigation.js";

export function removeDuplicateChoices(scene: Scene): Scene {
  const choices: Scene["choices"] = [];
  for (const choice of scene.choices) {
    if (choices.some((existing) => choiceTextsAreSimilar(existing.text, choice.text))) {
      continue;
    }
    choices.push(choice);
  }
  return { ...scene, choices };
}

export function removeRecentChoiceParaphrases(
  scene: Scene,
  history: GameState["history"],
): Scene {
  const recentChoices = history
    .filter((item) => item.kind === "choice")
    .slice(-6)
    .map((item) => item.text);
  return {
    ...scene,
    choices: scene.choices.filter(
      (choice) =>
        !recentChoices.some((recent) => choiceTextsAreSimilar(choice.text, recent)),
    ),
  };
}

export function sceneRepeatsConsumedAction(scene: Scene, actionText: string): boolean {
  return scene.choices.some(
    (choice) =>
      choice.type === "action"
      && choiceParaphrasesConsumedAction(choice.text, actionText),
  );
}

export function choiceParaphrasesConsumedAction(
  choiceText: string,
  actionText: string,
): boolean {
  if (choiceTextsAreSimilar(choiceText, actionText)) return true;
  const choiceTokens = comparableChoiceTokens(choiceText);
  const actionTokens = comparableChoiceTokens(actionText);
  if (choiceTokens.size === 0 || actionTokens.size === 0) return false;
  const shared = [...choiceTokens].filter((token) => actionTokens.has(token)).length;
  return shared >= 3
    && shared / Math.min(choiceTokens.size, actionTokens.size) >= 0.6;
}

export function removeConsumedActionChoices(scene: Scene, actionText: string): Scene {
  return {
    ...scene,
    choices: scene.choices.filter(
      (choice) =>
        choice.type !== "action"
        || !choiceParaphrasesConsumedAction(choice.text, actionText),
    ),
  };
}

const COMPLETED_EVENT_CHOICE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "can",
  "for",
  "he",
  "her",
  "his",
  "i",
  "me",
  "my",
  "she",
  "the",
  "them",
  "they",
  "to",
  "until",
  "while",
  "with",
]);

function completedEventChoiceToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("ing") && token.length > 5) {
    return token.slice(0, -3);
  }
  if (token.endsWith("ed") && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function completedEventChoiceTokens(text: string): Set<string> {
  return new Set(
    [...comparableChoiceTokens(text)]
      .filter((token) => !COMPLETED_EVENT_CHOICE_STOP_WORDS.has(token))
      .map(completedEventChoiceToken)
      .filter(Boolean),
  );
}

function completedEventLeadToken(text: string): string {
  const firstToken = [...comparableChoiceTokens(text)][0] ?? "";
  return completedEventChoiceToken(firstToken);
}

function choiceRepeatsCompletedEventBeat(
  choiceText: string,
  event: SourceChoiceNavigationEvent,
): boolean {
  const normalizedChoice = normalizeComparableChoiceText(choiceText);
  if (
    /^(?:check|discuss|examine|inspect|reflect|remember|thank)\b/u.test(normalizedChoice)
    || /^ask\b.*\b(?:about|how|what|when|whether|why)\b/u.test(normalizedChoice)
  ) {
    return false;
  }
  const choiceTokens = completedEventChoiceTokens(choiceText);
  if (choiceTokens.size === 0) return false;
  return (event.beats ?? []).some((beat) => {
    const beatTokens = completedEventChoiceTokens(beat.action);
    if (beatTokens.size === 0) return false;
    // Shared participants and objects do not establish a repeated action.
    // Also allow requests to perform the completed action ("Ask ... to oil").
    const beatAction = completedEventLeadToken(beat.action);
    if (!choiceTokens.has(beatAction)) return false;
    const shared = [...choiceTokens].filter((token) => beatTokens.has(token)).length;
    return (
      (choiceTokens.has("again") && shared >= 1)
      || (
        shared >= 2
        && (
          shared / Math.min(choiceTokens.size, beatTokens.size) >= 0.5
          || (
            shared >= 3
            && completedEventLeadToken(choiceText) === completedEventLeadToken(beat.action)
          )
        )
      )
    );
  });
}

export function removeChoicesRepeatingCompletedSourceEvent(
  scene: Scene,
  event: SourceChoiceNavigationEvent | null | undefined,
): Scene {
  if (!event?.beats?.length) return scene;
  return {
    ...scene,
    choices: scene.choices.filter(
      (choice) =>
        choice.type !== "action"
        || !choiceRepeatsCompletedEventBeat(choice.text, event),
    ),
  };
}

export function actionResolutionFailures(
  playerAction: string,
  actionOutcome: string,
  actionResult: string,
  consumedAction?: string,
): string[] {
  if (!consumedAction) {
    return playerAction.trim() || actionOutcome !== "none" || actionResult.trim()
      ? ["A turn without PLAYER ACTION must use empty playerAction/actionResult and actionOutcome 'none'."]
      : [];
  }
  return [
    ...(playerAction.trim() !== consumedAction.trim()
      ? ["playerAction did not exactly preserve the consumed PLAYER ACTION."]
      : []),
    ...(actionOutcome === "none"
      ? ["A PLAYER ACTION turn cannot use actionOutcome 'none'."]
      : []),
    ...(!actionResult.trim()
      ? ["PLAYER ACTION was not resolved because actionResult is empty."]
      : []),
  ];
}

export function hasTooFewChoicesForActiveScene(
  scene: Pick<Scene, "choices" | "outcome">,
  minimumChoices = 2,
): boolean {
  return (scene.outcome ?? "active") === "active"
    && scene.choices.length < minimumChoices
    && !hasSourceContinuationChoiceFallback(scene);
}

export function exactScopeIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function canonicalScopeName(
  value: string,
  profiles: readonly Pick<CharacterProfile, "name" | "aliases">[] | undefined,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || !profiles?.length) {
    return trimmed || undefined;
  }
  const identity = exactScopeIdentity(trimmed);
  return profiles.find((profile) =>
    [profile.name, ...profile.aliases].some(
      (candidate) => exactScopeIdentity(candidate) === identity,
    )
  )?.name;
}

export function canonicalScopeIdentity(
  value: string,
  profiles: readonly Pick<CharacterProfile, "name" | "aliases">[] | undefined,
): string {
  return normalizedScopeIdentity(canonicalScopeName(value, profiles) ?? value);
}
export function playerScopeAliases(
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
): string[] {
  const profile = findPlayerCharacterProfile(playerName, profiles);
  return profile ? [profile.name, ...profile.aliases] : [];
}

export interface SceneScopeValidationContext {
  playerName?: string;
  playerAliases?: readonly string[];
  nonInteractableCharacters?: readonly string[];
  knownCharacterProfiles?: readonly Pick<CharacterProfile, "name" | "aliases">[];
}

export function sceneScopeFailures(
  sceneScope: SceneScope | undefined,
  context: SceneScopeValidationContext = {},
): string[] {
  if (!sceneScope) return ["sceneScope is missing."];
  const location = sceneScope.currentLocation.trim();
  const present = sceneScope.peoplePresent.map((person) => person.trim());
  const speaking = sceneScope.peopleWithinSpeakingDistance.map((person) => person.trim());
  const scopeIdentity = (person: string) =>
    canonicalScopeIdentity(person, context.knownCharacterProfiles);
  const presentIdentities = new Set(present.map(scopeIdentity));
  const playerIdentities = new Set(
    [context.playerName ?? "", ...(context.playerAliases ?? [])]
      .filter((identity) => identity.trim())
      .map(scopeIdentity),
  );
  const nonInteractableIdentities = new Set(
    (context.nonInteractableCharacters ?? []).map(scopeIdentity),
  );
  return [
    ...(!location ? ["sceneScope.currentLocation is empty."] : []),
    ...(present.some((person) => !person)
      ? ["sceneScope.peoplePresent contains an empty name."]
      : []),
    ...(speaking.some((person) => !person)
      ? ["sceneScope.peopleWithinSpeakingDistance contains an empty name."]
      : []),
    ...present
      .filter((person) =>
        person && !playerIdentities.has(scopeIdentity(person))
          && !canonicalScopeName(person, context.knownCharacterProfiles)
      )
      .map((person) =>
        `sceneScope lists unknown or unqualified identity ${JSON.stringify(person)} as present.`
      ),
    ...speaking
      .filter((person) =>
        person && !playerIdentities.has(scopeIdentity(person))
          && !canonicalScopeName(person, context.knownCharacterProfiles)
      )
      .map((person) =>
        `sceneScope lists unknown or unqualified identity ${JSON.stringify(person)} within speaking distance.`
      ),
    ...(new Set(present.map(scopeIdentity)).size !== present.length
      ? ["sceneScope.peoplePresent contains duplicate people."]
      : []),
    ...(new Set(speaking.map(scopeIdentity)).size !== speaking.length
      ? ["sceneScope.peopleWithinSpeakingDistance contains duplicate people."]
      : []),
    ...present
      .filter((person) => !playerIdentities.has(scopeIdentity(person))
        && nonInteractableIdentities.has(scopeIdentity(person)))
      .map((person) =>
        `sceneScope lists non-interactable character ${JSON.stringify(person)} as present.`
      ),
    ...speaking
      .filter((person) => !playerIdentities.has(scopeIdentity(person))
        && nonInteractableIdentities.has(scopeIdentity(person)))
      .map((person) =>
        `sceneScope lists non-interactable character ${JSON.stringify(person)} within speaking distance.`
      ),
    ...speaking
      .filter((person) => !presentIdentities.has(scopeIdentity(person)))
      .map((person) =>
        `sceneScope lists ${JSON.stringify(person)} within speaking distance but not present.`
      ),
  ];
}

export function filterSceneScope(
  sceneScope: SceneScope,
  context: SceneScopeValidationContext = {},
): SceneScope {
  const excludedIdentities = new Set(
    (context.nonInteractableCharacters ?? [])
      .filter((identity) => identity.trim())
      .map((identity) =>
        canonicalScopeIdentity(identity, context.knownCharacterProfiles)
      ),
  );
  // The player is an explicit member of both lists, including in older saves.
  // Presence does not make the player an NPC or grant human speech to animals.
  const playerName = context.playerName?.trim();
  const player = playerName
    ? canonicalScopeName(playerName, context.knownCharacterProfiles) ?? playerName
    : undefined;
  const playerIdentities = new Set(
    [playerName, ...(context.playerAliases ?? [])]
      .filter((name): name is string => Boolean(name?.trim()))
      .map((name) => canonicalScopeIdentity(name, context.knownCharacterProfiles)),
  );
  const canonicalName = (name: string) =>
    player && playerIdentities.has(canonicalScopeIdentity(name, context.knownCharacterProfiles))
      ? player
      : canonicalScopeName(name, context.knownCharacterProfiles);
  if (player) excludedIdentities.delete(normalizedScopeIdentity(player));
  const seenPresent = new Set<string>();
  const peoplePresent = [...sceneScope.peoplePresent, ...(player ? [player] : [])]
    .map(canonicalName)
    .filter((person) => {
      const identity = normalizedScopeIdentity(person ?? "");
      if (
        !identity
        || excludedIdentities.has(identity)
        || seenPresent.has(identity)
      ) {
        return false;
      }
      seenPresent.add(identity);
      return true;
    })
    .filter((person): person is string => Boolean(person));
  const seenSpeaking = new Set<string>();
  const peopleWithinSpeakingDistance = [...sceneScope.peopleWithinSpeakingDistance, ...(player ? [player] : [])]
    .map(canonicalName)
    .filter((person) => {
      const identity = normalizedScopeIdentity(person ?? "");
      if (
        !identity
        || !seenPresent.has(identity)
        || excludedIdentities.has(identity)
        || seenSpeaking.has(identity)
      ) {
        return false;
      }
      seenSpeaking.add(identity);
      return true;
    })
    .filter((person): person is string => Boolean(person));
  return {
    currentLocation: sceneScope.currentLocation.trim() || "Unspecified location",
    peoplePresent,
    peopleWithinSpeakingDistance,
  };
}

export function sceneScopeOrFallback(
  sceneScope: SceneScope | undefined,
  previousSceneScope?: SceneScope,
): SceneScope {
  return sceneScope ?? previousSceneScope ?? {
    currentLocation: "Unspecified location",
    peoplePresent: [],
    peopleWithinSpeakingDistance: [],
  };
}

export function hasSourceContinuationChoiceFallback(
  scene: Pick<Scene, "choices" | "outcome">,
): boolean {
  const choice = scene.choices[0];
  return (scene.outcome ?? "active") === "active"
    && scene.choices.length === 1
    && choice?.id === SOURCE_CONTINUATION_CHOICE_ID
    && choice.type === "action"
    && (
      choice.text === "Continue story"
      || choice.text === SOURCE_CONTINUATION_CHOICE_TEXT
      || choice.text.startsWith("And so we continue toward: ")
      || choice.text.startsWith("And so we continue to the moment when ")
    );
}

export function sourceContinuationChoiceText(
  _candidate?: SourceContinuationCandidate,
): string {
  return SOURCE_CONTINUATION_CHOICE_TEXT;
}

export function addSourceContinuationChoiceFallback(
  scene: Scene,
  text = SOURCE_CONTINUATION_CHOICE_TEXT,
): Scene {
  if ((scene.outcome ?? "active") !== "active" || scene.choices.length > 0) {
    return scene;
  }
  return addSourceContinuationAnchorChoice(scene, text);
}

export function addSourceContinuationAnchorChoice(
  scene: Scene,
  text = SOURCE_CONTINUATION_CHOICE_TEXT,
): Scene {
  if ((scene.outcome ?? "active") !== "active") return scene;
  const continuationChoice: Scene["choices"][number] = {
    id: SOURCE_CONTINUATION_CHOICE_ID,
    type: "action",
    text,
    stakes: "significant",
  };
  return {
    ...scene,
    choices: [
      continuationChoice,
      ...scene.choices.filter(
        (choice) => choice.id !== SOURCE_CONTINUATION_CHOICE_ID,
      ),
    ].slice(0, 4),
  };
}

export function firstChoiceWasFiltered(
  originalChoices: Scene["choices"],
  filteredChoices: Scene["choices"],
  outcome: Scene["outcome"],
): boolean {
  if ((outcome ?? "active") !== "active") return false;
  if (hasSourceContinuationChoiceFallback({ choices: filteredChoices, outcome })) {
    return false;
  }
  const originalFirstId = originalChoices[0]?.id;
  const filteredFirstId = filteredChoices[0]?.id;
  return Boolean(
    originalFirstId
    && filteredFirstId !== originalFirstId
    && filteredFirstId !== `${originalFirstId}_generated`,
  );
}

export function promoteAnchorChoice(
  scene: Scene,
  anchorChoiceIndex: number,
  sourceEventId?: string,
): Scene {
  if (anchorChoiceIndex < 0 || anchorChoiceIndex >= scene.choices.length) {
    return scene;
  }
  const anchorChoice = scene.choices[anchorChoiceIndex];
  if (!anchorChoice) return scene;
  const sourceAnchorRoute = anchorChoice.sourceAnchorRoute === "event"
      || anchorChoice.sourceAnchorRoute === "transition"
    ? anchorChoice.sourceAnchorRoute
    : "transition";
  const taggedAnchorChoice = anchorChoice.id === SOURCE_CONTINUATION_CHOICE_ID
    ? anchorChoice
    : {
        ...anchorChoice,
        id: SOURCE_ANCHOR_CHOICE_ID,
        ...(sourceEventId ? { sourceEventId } : {}),
        sourceAnchorRoute,
      };
  return {
    ...scene,
    choices: [
      taggedAnchorChoice,
      ...scene.choices.filter(
        (_choice, index) => index !== anchorChoiceIndex,
      ).map((choice) => {
        const {
          sourceAnchorRoute: _sourceAnchorRoute,
          sourceEventId: _sourceEventId,
          ...localChoice
        } = choice;
        return choice.id === SOURCE_ANCHOR_CHOICE_ID
          ? {
              ...localChoice,
              id: `${SOURCE_ANCHOR_CHOICE_ID}_generated`,
            }
          : localChoice;
      }),
    ],
  };
}

export const FILTERED_ANCHOR_CHOICE_FAILURE =
  "choices[0], the required anchor-directed option, was unusable after filtering.";

export function filteredAnchorChoiceFailures(
  anchorChoiceWasFiltered: boolean,
  attempt: number,
  maxAttempts: number,
): string[] {
  // On the final attempt, preserve an otherwise valid advancing scene and promote
  // its first remaining usable choice instead of rolling the whole turn back.
  return anchorChoiceWasFiltered && attempt < maxAttempts - 1
    ? [FILTERED_ANCHOR_CHOICE_FAILURE]
    : [];
}

export function shouldHandleMissingAnchorChoice(input: {
  hasValidationFailures: boolean;
  activeScene: boolean;
  anchorChoiceIndex: number | null;
  finalAttempt: boolean;
  sourceEventOccurred: boolean;
}): boolean {
  return !input.hasValidationFailures
    && input.activeScene
    && input.anchorChoiceIndex === null
    && !input.finalAttempt
    && !input.sourceEventOccurred;
}

export function applyEstablishedEvent(
  state: Pick<
    GameState,
    "establishedEvent" | "scene" | "history"
  >,
  sceneText: string,
): string {
  const initialScene = !state.scene.text.trim()
    && state.history.every((item) => item.kind === "start");
  const event = state.establishedEvent?.narrative.trim();
  if (!initialScene || !event) {
    return sceneText;
  }
  if (sceneText.trimStart().startsWith(event)) return sceneText;
  return `${event}\n\n${sceneText}`.trim();
}

export function developmentRepeatsHistory(
  development: string,
  history: GameState["history"],
): boolean {
  const candidate = development.trim();
  if (!candidate) return false;
  return history
    .filter((item) => item.kind === "scene")
    .slice(-4)
    .some((item) => {
      const previous = item.development?.trim()
        || extractLeakedExternalDevelopment(item.text);
      return Boolean(previous && choiceTextsAreSimilar(candidate, previous));
    });
}

export function removeChoicesWithPlayerIdentityReferences(
  scene: Scene,
  playerName: string,
  characterProfiles: readonly CharacterProfile[] | undefined = [],
): Scene {
  const profiles = characterProfiles ?? [];
  const playerProfile = findPlayerCharacterProfile(playerName, profiles);
  const playerIdentities = new Set(
    [
      playerName,
      playerProfile?.name,
      ...(playerProfile?.aliases ?? []),
    ]
      .filter((identity): identity is string => Boolean(identity?.trim()))
      .map(normalizeComparableChoiceText),
  );
  const isPlayerIdentity = (identity: string | undefined): boolean => Boolean(
    identity
    && playerIdentities.has(normalizeComparableChoiceText(identity)),
  );
  return {
    ...scene,
    choices: scene.choices.flatMap((choice) => {
      if (textMentionsCharacter(choice.text, playerName, profiles)) return [];

      const targetsPlayer = isPlayerIdentity(choice.character);
      const repairedChoice = { ...choice };
      if (targetsPlayer) delete repairedChoice.character;
      return [{
        ...repairedChoice,
        ...(choice.requiredPresentCharacters
          ? {
              requiredPresentCharacters:
                choice.requiredPresentCharacters.filter(
                  (identity) => !isPlayerIdentity(identity),
                ),
            }
          : {}),
        ...(choice.requiredAbsentCharacters
          ? {
              requiredAbsentCharacters:
                choice.requiredAbsentCharacters.filter(
                  (identity) => !isPlayerIdentity(identity),
                ),
            }
          : {}),
      }];
    }),
  };
}

export const GENERIC_CHARACTER_ROLE_WORDS = new Set([
  "central",
  "character",
  "figure",
  "key",
  "main",
  "major",
  "minor",
  "narrative",
  "primary",
  "protagonist",
  "recurring",
  "secondary",
  "supporting",
  "titular",
  "unknown",
  "unnamed",
]);

export function roleWordForms(word: string): string[] {
  const forms = new Set([word]);
  if (word === "police") return [...forms];
  if (word.endsWith("ies") && word.length > 3) {
    forms.add(`${word.slice(0, -3)}y`);
  } else if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) {
    forms.add(word.slice(0, -1));
  } else if (/[^aeiou]y$/u.test(word)) {
    forms.add(`${word.slice(0, -1)}ies`);
  } else if (/(?:ch|sh|x|z)$/u.test(word)) {
    forms.add(`${word}es`);
  } else {
    forms.add(`${word}s`);
  }
  return [...forms];
}

export function characterRoleReferences(profile: CharacterProfile): string[] {
  const references = new Set<string>();
  const roleSegments = profile.role
    .split(/[(),;/|]+/u)
    .map(normalizeComparableChoiceText)
    .filter(Boolean);
  for (const segment of roleSegments) {
    const words = segment
      .split(" ")
      .filter((word) =>
        word.length >= 4
        && !GENERIC_CHARACTER_ROLE_WORDS.has(word)
      );
    if (words.length === 0) continue;
    references.add(segment);
    for (const word of words) {
      for (const form of roleWordForms(word)) references.add(form);
    }
  }
  return [...references];
}

export function textMentionsNormalizedReference(text: string, reference: string): boolean {
  const normalizedText = normalizeComparableChoiceText(text);
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^| )${escaped}(?=$| )`, "u").test(normalizedText);
}

export function textEstablishesCharacterAbsent(
  text: string,
  character: string,
  characterProfiles: readonly CharacterProfile[] = [],
): boolean {
  const normalizedText = normalizeComparableChoiceText(text);
  const normalizedCharacter = normalizeComparableChoiceText(character);
  const profile = characterProfiles.find((candidate) =>
    [candidate.name, ...candidate.aliases].some(
      (identity) => normalizeComparableChoiceText(identity) === normalizedCharacter,
    )
  );
  const identities = [character, profile?.name, ...(profile?.aliases ?? [])]
    .filter((identity): identity is string => Boolean(identity?.trim()))
    .map(normalizeComparableChoiceText);

  return identities.some((identity) => {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [
      new RegExp(
        `\\b(?:wait(?:ing|s)?|await(?:ing|s)?|listen(?:ing|s)?|watch(?:ing|es)?)\\b(?: \\p{L}+){0,8} \\bfor\\b(?: \\p{L}+){0,5} ${escaped}(?: s)? \\b(?:return|arrival)\\b`,
        "iu",
      ),
      new RegExp(`\\b(?:before|until) ${escaped} \\b(?:returns|arrives)\\b`, "iu"),
      new RegExp(
        `\\b${escaped} \\b(?:has not|had not|hasnt|hadnt) arrived\\b`,
        "iu",
      ),
      new RegExp(
        `\\b${escaped} \\b(?:is|was) (?:not here|not present|absent|away|gone)\\b`,
        "iu",
      ),
      new RegExp(`\\b${escaped} \\b(?:has|had) left\\b`, "iu"),
      new RegExp(
        `\\bwhen\\b(?: \\p{L}+){0,12} ${escaped}(?: s)?\\b(?: \\p{L}+){0,6} \\b(?:arrives|returns|enters|comes|crosses|cross)\\b`,
        "iu",
      ),
      new RegExp(
        `\\b${escaped}(?: s)?\\b(?: \\p{L}+){0,5} \\b(?:coming home|returning|will arrive|will return|will enter)\\b`,
        "iu",
      ),
    ].some((pattern) => pattern.test(normalizedText));
  });
}

export function sceneNonInteractableCharacters(
  state: Pick<
    GameState,
    "characterProfiles" | "establishedEvent" | "scene" | "history" | "storyMemory"
  >,
  scene: Pick<Scene, "title" | "text">,
  explicitlyUnavailable: readonly string[] = [],
  aiReportedNonInteractable: readonly string[] = [],
): string[] {
  const profiles = state.characterProfiles ?? [];
  const currentNarrative = `${scene.title}\n${scene.text}`;
  const priorNarrative = `${state.scene.title}\n${state.scene.text}`;
  const deadIdentities = new Set(
    [
      ...(state.establishedEvent?.category === "death"
        ? [state.establishedEvent.target]
        : []),
      ...aiReportedNonInteractable,
    ].map(normalizedScopeIdentity),
  );
  const unavailableIdentities = new Set(
    explicitlyUnavailable.map(normalizedScopeIdentity),
  );
  const unavailableProfiles = profiles.filter((profile) => {
    const identities = [profile.name, ...profile.aliases];
    const isDead = identities.some((identity) =>
      deadIdentities.has(normalizedScopeIdentity(identity))
    );
    if (isDead) return true;
    const explicitlyUnavailableProfile = identities.some((identity) =>
      unavailableIdentities.has(normalizedScopeIdentity(identity))
    );
    const wasAbsent = textEstablishesCharacterAbsent(
      priorNarrative,
      profile.name,
      profiles,
    );
    const isAbsent = textEstablishesCharacterAbsent(
      currentNarrative,
      profile.name,
      profiles,
    );
    const arrivesNow = textNarratesCharacterArrival(
      currentNarrative,
      profile.name,
      profiles,
    );
    if (isAbsent) return true;
    return !arrivesNow && (explicitlyUnavailableProfile || wasAbsent);
  });
  const unavailable = unavailableProfiles
    .flatMap((profile) => [profile.name, ...profile.aliases]);
  const unmatchedExplicitlyUnavailable = explicitlyUnavailable.filter((identity) =>
    !textNarratesCharacterArrival(currentNarrative, identity, profiles)
  );
  return [...unavailable, ...unmatchedExplicitlyUnavailable];
}

export function filterSceneScopeForState(
  sceneScope: SceneScope,
  state: Pick<
    GameState,
    | "playerName"
    | "characterProfiles"
    | "establishedEvent"
    | "scene"
    | "history"
    | "storyMemory"
  >,
  scene: Pick<Scene, "title" | "text"> = state.scene,
  explicitlyUnavailable: readonly string[] = [],
  aiReportedNonInteractable: readonly string[] = [],
): SceneScope {
  return filterSceneScope(sceneScope, {
    playerName: state.playerName,
    playerAliases: playerScopeAliases(state.playerName, state.characterProfiles),
    knownCharacterProfiles: state.characterProfiles,
    nonInteractableCharacters: sceneNonInteractableCharacters(
      state,
      scene,
      explicitlyUnavailable,
      aiReportedNonInteractable,
    ),
  });
}

export function requiredSourceEventConcreteFailures(
  sceneText: string,
  candidate: SourceContinuationCandidate | undefined,
  characterProfiles: readonly CharacterProfile[] = [],
): string[] {
  if (candidate?.requiredEventCategory !== "arrival") return [];
  const participants = [
    ...(candidate.requiredEventActors ?? []),
    ...(candidate.requiredEventTargets ?? []),
  ].filter((identity, index, all) =>
    identity.trim() && all.indexOf(identity) === index
  );
  const arrivingParticipants = participants.filter((character) => {
    const normalizedCharacter = normalizedScopeIdentity(character);
    const profile = characterProfiles.find((knownProfile) =>
      [knownProfile.name, ...knownProfile.aliases].some(
        (identity) => normalizedScopeIdentity(identity) === normalizedCharacter,
      )
    );
    const fallbackFirstName = !profile && character.trim().includes(" ")
      ? character.trim().split(/\s+/u)[0]
      : undefined;
    return [character, profile?.name, ...(profile?.aliases ?? []), fallbackFirstName]
      .filter((identity): identity is string => Boolean(identity?.trim()))
      .some((identity) => {
        const escaped = identity.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(
          `(?:^|[.!?;,]\\s+|\\b(?:and|then)\\s+)${escaped}`
            + `(?:\\s+\\p{L}+){0,3}\\s+`
            + `(?:arrives|returns|enters|appears|comes (?:in|inside|home)|steps (?:in|inside|through)|is (?:here|back|home|present))\\b`,
          "iu",
        ).test(candidate.requiredEvent ?? "");
      });
  });
  if (arrivingParticipants.length === 0) return [];
  const depictsCompletedArrival = arrivingParticipants.some((character) =>
    textNarratesCharacterArrival(sceneText, character, characterProfiles)
    && !textEstablishesCharacterAbsent(sceneText, character, characterProfiles)
  );
  return depictsCompletedArrival
    ? []
    : [
        "The required arrival event is not visibly completed. Narrate a named participant "
        + "actually arriving or entering now; waiting, listening, anticipation, and conditional "
        + "or future arrival language do not complete the event.",
      ];
}

export function absentCharacterContinuityFailures(
  state: Pick<GameState, "scene" | "characterProfiles">,
  sceneText: string,
  actionResult: string,
  externalDevelopment: string,
): string[] {
  const profiles = state.characterProfiles ?? [];
  return profiles.flatMap((profile) => {
    if (!textEstablishesCharacterAbsent(state.scene.text, profile.name, profiles)) {
      return [];
    }
    if (
      textNarratesCharacterArrival(
        `${externalDevelopment}\n${sceneText}`,
        profile.name,
        profiles,
      )
    ) {
      return [];
    }

    const normalizedResult = normalizeComparableChoiceText(actionResult);
    const responseByAbsentCharacter = [profile.name, ...profile.aliases].some(
      (identity) => {
        const escaped = normalizeComparableChoiceText(identity)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(
          `\\b${escaped}\\b(?: \\p{L}+){0,8} \\b(?:answers|responds|replies|says|tells|nods|accepts|refuses|explains|outlines|asks|speaks)\\b`,
          "iu",
        ).test(normalizedResult);
      },
    );
    return responseByAbsentCharacter
      ? [`${profile.name} interacted while still established as absent; narrate their arrival before they can respond.`]
      : [];
  });
}

export function repairGeneratedChoices(
  choices: Scene["choices"],
): Scene["choices"] {
  return choices.flatMap((choice) => {
    const text = choice.text.trim();
    const firstActionWord = choice.type === "action"
      ? normalizeComparableChoiceText(text).split(" ")[0] ?? ""
      : "";
    const startsWithThirdPersonVerb = (
      ["does", "goes", "has", "is"].includes(firstActionWord)
      || (
        firstActionWord.endsWith("s")
        && !firstActionWord.endsWith("ss")
        && !["bias", "focus", "gas"].includes(firstActionWord)
      )
    );
    if (
      !text
      || (
        choice.type === "action"
        && (
          startsWithThirdPersonVerb
          || /^(?:ask|bring|call|choose|confront|follow|give|guide|hand|help|invite|join|lower|offer|open|raise|request|show|take|tell|touch|turn|welcome)$/iu.test(text)
        )
      )
    ) {
      return [];
    }
    const {
      sourceAnchorRoute: rawSourceAnchorRoute,
      ...choiceWithoutNullableRoute
    } = choice;
    const choiceWithRoute = rawSourceAnchorRoute === "event"
      || rawSourceAnchorRoute === "transition"
      ? { ...choiceWithoutNullableRoute, sourceAnchorRoute: rawSourceAnchorRoute }
      : choiceWithoutNullableRoute;
    const structuredCharacter = choice.character?.trim();
    const character = structuredCharacter?.toLocaleLowerCase() === "null"
      ? undefined
      : structuredCharacter;
    if (choice.type !== "talk") {
      const { character: _character, ...choiceWithoutCharacter } = choiceWithRoute;
      return [{
        ...choiceWithoutCharacter,
        text,
        ...(character ? { character } : {}),
      }];
    }
    const talkCharacter = character
      || /^talk to\s+(.+?)\s*$/iu.exec(choice.text)?.[1]?.trim();
    return talkCharacter
      ? [{
          ...choiceWithRoute,
          text: `Talk to ${talkCharacter}`,
          character: talkCharacter,
        }]
      : [];
  });
}

function sceneEstablishesPlayerCannotMove(scene: Pick<Scene, "title" | "text">): boolean {
  const narrative = normalizeComparableChoiceText(`${scene.title} ${scene.text}`);
  return [
    /\bi (?:am|remain|stay) (?:completely |still )?(?:motionless|immobile|immobilized|paralyzed|pinned|stuck)\b/u,
    /\bi (?:cannot|cant|can not) (?:move|walk|stand|turn|lift|lower|reach)\b/u,
    /\bmy (?:body|limbs|joints|legs) (?:are|remain) (?:completely |still )?(?:motionless|immobile|immobilized|paralyzed|pinned|stuck)\b/u,
    /\b(?:frozen|rusted|pinned|trapped|stuck) in place\b/u,
  ].some((pattern) => pattern.test(narrative));
}

function choiceAssumesPlayerCanMove(text: string): boolean {
  const choice = normalizeComparableChoiceText(text);
  if (/^(?:attempt|try|struggle|ask|call|signal|request|groan|speak|talk|wait|listen)\b/u.test(choice)) {
    return false;
  }
  return /^(?:(?:carefully|slowly|quietly|calmly|deliberately|cautiously|gently)\s+){0,2}(?:move|walk|step|run|approach|follow|go|leave|stand|turn|lower|raise|lift|reach|climb|carry|shoulder|set out)\b/u.test(
    choice,
  );
}

export function scopePeopleIncludeCharacter(
  people: readonly string[],
  character: string,
  profiles: readonly CharacterProfile[],
): boolean {
  const target = normalizedScopeIdentity(character);
  const profile = profiles.find((candidate) =>
    [candidate.name, ...candidate.aliases].some(
      (identity) => normalizedScopeIdentity(identity) === target,
    )
  );
  const accepted = new Set(
    [character, profile?.name, ...(profile?.aliases ?? [])]
      .filter((identity): identity is string => Boolean(identity?.trim()))
      .map(normalizedScopeIdentity),
  );
  return people.some((person) => accepted.has(normalizedScopeIdentity(person)));
}

function choiceDirectlyInteractsWithCharacter(
  text: string,
  character: string,
  profiles: readonly CharacterProfile[],
): boolean {
  if (!textMentionsCharacter(text, character, profiles)) return false;
  const normalizedText = normalizeComparableChoiceText(text);
  const profile = profiles.find((candidate) =>
    [candidate.name, ...candidate.aliases].some(
      (identity) =>
        normalizedScopeIdentity(identity) === normalizedScopeIdentity(character),
    )
  );
  return [character, profile?.name, ...(profile?.aliases ?? [])]
    .filter((identity): identity is string => Boolean(identity?.trim()))
    .map(normalizeComparableChoiceText)
    .some((identity) => {
      const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return [
        new RegExp(
          `\\b(?:approach|ask|confront|follow|greet|help|hug|invite|join|kiss|meet|question|tell|touch|welcome)\\b`
            + ` (?:the )?${escaped}(?= |$)`,
          "iu",
        ),
        new RegExp(
          `\\b(?:speak|talk)\\b(?: directly)? (?:to|with) (?:the )?${escaped}(?= |$)`,
          "iu",
        ),
        new RegExp(
          `\\b(?:give|hand|offer|send|show)\\b(?: \\p{L}+){0,5} \\bto\\b`
            + ` (?:the )?${escaped}(?= |$)`,
          "iu",
        ),
        new RegExp(
          `\\b(?:ask|request)\\b(?: \\p{L}+){0,5} \\bfrom\\b`
            + ` (?:the )?${escaped}(?= |$)`,
          "iu",
        ),
      ].some((pattern) => pattern.test(normalizedText));
    });
}

function choiceSeeksCharacterWithoutRequiringPresence(
  text: string,
  character: string,
  profiles: readonly CharacterProfile[],
): boolean {
  if (!textMentionsCharacter(text, character, profiles)) return false;
  const normalizedText = normalizeComparableChoiceText(text);
  const profile = profiles.find((candidate) =>
    [candidate.name, ...candidate.aliases].some(
      (identity) =>
        normalizedScopeIdentity(identity) === normalizedScopeIdentity(character),
    )
  );
  const identities = [character, profile?.name, ...(profile?.aliases ?? [])]
    .filter((identity): identity is string => Boolean(identity?.trim()))
    .map(normalizeComparableChoiceText);
  const directVerb =
    "(?:ask|question|tell|explain|speak|talk|greet|welcome|hand|give|show|touch|kiss|hug|join|confront|help|lead|guide|invite|follow)";

  return identities.some((identity) => {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const seeksPossibleSignal = [
      new RegExp(
        `\\b(?:listen|listening|watch|watching|look|looking|search|searching|scan|scanning|wait|waiting)\\b`
          + `(?: \\p{L}+){0,6} \\bfor\\b(?: \\p{L}+){0,6} ${escaped}(?: s)?(?= |$)`,
        "iu",
      ),
      new RegExp(
        `\\b(?:call|calling|shout|shouting|cry|crying)\\b`
          + `(?: \\p{L}+){0,4} \\b(?:for|to)\\b(?: \\p{L}+){0,3} ${escaped}(?= |$)`,
        "iu",
      ),
      new RegExp(
        `\\b(?:call|calling|shout|shouting|cry|crying)\\b`
          + `(?: \\p{L}+){0,5} ${escaped} s \\bname\\b`,
        "iu",
      ),
      new RegExp(
        `${escaped} s \\b(?:footsteps|steps|voice|movement|reply|answer|signal|signs)\\b`
          + `(?: \\p{L}+){0,6} \\b(?:might|may|could)\\b`
          + `(?: \\p{L}+){0,3} \\b(?:be heard|be seen|be noticed|be detected|appear)\\b`,
        "iu",
      ),
    ].some((pattern) => pattern.test(normalizedText));
    if (!seeksPossibleSignal) return false;

    return ![
      new RegExp(
        `\\b${directVerb}\\b(?: \\p{L}+){0,5} ${escaped}(?: s)?(?= |$)`,
        "iu",
      ),
      new RegExp(
        `${escaped}(?: s)?(?: \\p{L}+){0,6} \\b(?:and|then)\\b`
          + `(?: \\p{L}+){0,2} \\b${directVerb}\\b`,
        "iu",
      ),
      new RegExp(
        `${escaped}(?: s)?(?: \\p{L}+){0,8}`
          + " \\b(?:answers|replies|responds|reacts|agrees|refuses|arrives|returns|enters|joins|follows)\\b",
        "iu",
      ),
    ].some((pattern) => pattern.test(normalizedText));
  });
}

export function removeChoicesWithUnintroducedCharacters(
  scene: Scene,
  state: Pick<
    GameState,
    "scene" | "history" | "characterProfiles" | "playerName" | "sourceIntroducedCharacters"
  >,
  visibleSourceEventNarrative = "",
  unavailableCharacters: readonly string[] = [],
): Scene {
  const establishedNarrative = [
    scene.title,
    scene.text,
    ...(scene.sceneScope?.peoplePresent ?? []),
    visibleSourceEventNarrative,
    state.scene.title,
    state.scene.text,
    ...(state.scene.sceneScope?.peoplePresent ?? []),
    ...state.history
      .filter((item) => item.kind === "scene")
      .flatMap((item) => [item.text, ...(item.sceneScope?.peoplePresent ?? [])]),
  ].join("\n");
  const playerProfile = findPlayerCharacterProfile(
    state.playerName,
    state.characterProfiles,
  );
  const playerIdentities = new Set(
    [state.playerName, playerProfile?.name, ...(playerProfile?.aliases ?? [])]
      .filter((identity): identity is string => Boolean(identity?.trim()))
      .map(normalizeComparableChoiceText),
  );
  const sourceIntroducedCharacters = new Set(
    (state.sourceIntroducedCharacters ?? []).map(normalizeComparableChoiceText),
  );
  const profiles = state.characterProfiles ?? [];
  const explicitlyUnavailableCharacters = new Set(
    unavailableCharacters.map(normalizeComparableChoiceText),
  );
  const roleReferences = new Map(
    profiles.map((profile) => [profile, characterRoleReferences(profile)]),
  );
  const choices = scene.choices.map((choice): Scene["choices"][number] => {
    const requiredPresentCharacters = (choice.requiredPresentCharacters ?? [])
      .filter(
        (character) =>
          !playerIdentities.has(normalizeComparableChoiceText(character)),
      );
    const requiredAbsentCharacters = (choice.requiredAbsentCharacters ?? [])
      .filter(
        (character) =>
          !playerIdentities.has(normalizeComparableChoiceText(character)),
      );
    const signalSearchProfiles = choice.type === "action"
      ? profiles.filter((profile) => {
          const isPlayer = [profile.name, ...profile.aliases].some((identity) =>
            playerIdentities.has(normalizeComparableChoiceText(identity))
          );
          return !isPlayer
            && choiceSeeksCharacterWithoutRequiringPresence(
              choice.text,
              profile.name,
              profiles,
            );
        })
      : [];
    const matchesSignalSearchProfile = (character: string): boolean =>
      signalSearchProfiles.some(
        (profile) => canonicalScopeName(character, profiles) === profile.name,
      );
    const repairedRequiredPresent = requiredPresentCharacters.filter(
      (character) => !matchesSignalSearchProfile(character),
    );
    const repairedRequiredAbsent = [...requiredAbsentCharacters];
    for (const profile of signalSearchProfiles) {
      if (!repairedRequiredAbsent.some(
        (character) =>
          canonicalScopeName(character, profiles) === profile.name,
      )) {
        repairedRequiredAbsent.push(profile.name);
      }
    }
    const clearCharacter = choice.character
      && matchesSignalSearchProfile(choice.character);
    const { character: _character, ...choiceWithoutCharacter } = choice;

    return {
      ...(clearCharacter ? choiceWithoutCharacter : choice),
      ...(choice.requiredPresentCharacters || signalSearchProfiles.length > 0
        ? { requiredPresentCharacters: repairedRequiredPresent }
        : {}),
      ...(choice.requiredAbsentCharacters || signalSearchProfiles.length > 0
        ? { requiredAbsentCharacters: repairedRequiredAbsent }
        : {}),
    };
  });

  return {
    ...scene,
    choices: choices.filter((choice) => {
      if (
        choice.type === "action"
        && sceneEstablishesPlayerCannotMove(scene)
        && choiceAssumesPlayerCanMove(choice.text)
      ) {
        return false;
      }
      if (
        scene.sceneScope
        && scene.sceneScope.currentLocation !== "Unspecified location"
      ) {
        const missingRequiredCharacter = (
          choice.requiredPresentCharacters ?? []
        ).some((character) =>
          !scopePeopleIncludeCharacter(
            scene.sceneScope!.peoplePresent,
            character,
            profiles,
          )
        );
        const unexpectedlyPresentCharacter = (
          choice.requiredAbsentCharacters ?? []
        ).some((character) =>
          scopePeopleIncludeCharacter(
            scene.sceneScope!.peoplePresent,
            character,
            profiles,
          )
        );
        if (missingRequiredCharacter || unexpectedlyPresentCharacter) {
          return false;
        }
        const directlyInteractsWithAbsentCharacter = choice.type === "action"
          && profiles.some((profile) => {
            const isPlayer = [profile.name, ...profile.aliases].some((identity) =>
              playerIdentities.has(normalizeComparableChoiceText(identity))
            );
            return !isPlayer
              && !scopePeopleIncludeCharacter(
                scene.sceneScope!.peoplePresent,
                profile.name,
                profiles,
              )
              && choiceDirectlyInteractsWithCharacter(
                choice.text,
                profile.name,
                profiles,
              );
          });
        if (directlyInteractsWithAbsentCharacter) {
          return false;
        }
      }
      if (
        choice.type === "talk"
        && scene.sceneScope
        && scene.sceneScope.currentLocation !== "Unspecified location"
        && choice.character
        && !scopePeopleIncludeCharacter(
          scene.sceneScope.peopleWithinSpeakingDistance,
          choice.character,
          profiles,
        )
      ) {
        return false;
      }
      if (
        choice.type === "action"
        && choice.character
        && scene.sceneScope
        && scene.sceneScope.currentLocation !== "Unspecified location"
        && !playerIdentities.has(normalizeComparableChoiceText(choice.character))
        && !scopePeopleIncludeCharacter(
          scene.sceneScope.peoplePresent,
          choice.character,
          profiles,
        )
      ) {
        return false;
      }
      const explicitlyUnavailableProfile = profiles.find((profile) =>
        [profile.name, ...profile.aliases].some((identity) =>
          explicitlyUnavailableCharacters.has(normalizeComparableChoiceText(identity))
        )
        && choice.character
        && canonicalScopeName(choice.character, profiles) === profile.name
        && !textNarratesCharacterArrival(scene.text, profile.name, profiles)
      );
      if (explicitlyUnavailableProfile) {
        return false;
      }
      const choiceText = `${choice.text}\n${choice.character ?? ""}`;
      const namesExplicitlyUnavailableCharacter = unavailableCharacters.some((identity) =>
        choice.character
        && canonicalScopeName(choice.character, profiles)
          === canonicalScopeName(identity, profiles)
        && !textNarratesCharacterArrival(scene.text, identity, profiles)
      );
      if (namesExplicitlyUnavailableCharacter) {
        return false;
      }
      const absentProfiles = profiles.filter((profile) =>
        textEstablishesCharacterAbsent(
          `${scene.title}\n${scene.text}`,
          profile.name,
          profiles,
        )
      );
      const namesAbsentCharacter = absentProfiles.some((profile) =>
        choice.character
        && canonicalScopeName(choice.character, profiles) === profile.name
      );
      if (namesAbsentCharacter) {
        return false;
      }
      const namesUnintroducedProfile = profiles.some((profile) => {
        const identities = [profile.name, ...profile.aliases];
        const mentionsProfile = identities.some((identity) =>
          textMentionsCharacter(choiceText, identity, state.characterProfiles)
        );
        const isPlayer = identities.some((identity) =>
          playerIdentities.has(normalizeComparableChoiceText(identity))
        );
        const appearedEarlierInSource = identities.some((identity) =>
          sourceIntroducedCharacters.has(normalizeComparableChoiceText(identity))
        );
        return mentionsProfile
          && !isPlayer
          && !appearedEarlierInSource
          && !textMentionsCharacter(
            establishedNarrative,
            profile.name,
            state.characterProfiles,
          );
      });
      if (namesUnintroducedProfile) return false;

      const referencedByRole = profiles.filter((profile) =>
        roleReferences.get(profile)?.some((reference) =>
          textMentionsNormalizedReference(choiceText, reference)
        )
      );
      if (referencedByRole.length === 0) return true;

      return referencedByRole.some((profile) => {
        const identities = [profile.name, ...profile.aliases];
        const isPlayer = identities.some((identity) =>
          playerIdentities.has(normalizeComparableChoiceText(identity))
        );
        const appearedEarlierInSource = identities.some((identity) =>
          sourceIntroducedCharacters.has(normalizeComparableChoiceText(identity))
        );
        const appearedByIdentity = textMentionsCharacter(
          establishedNarrative,
          profile.name,
          state.characterProfiles,
        );
        const appearedByRole = roleReferences.get(profile)?.some((reference) =>
          textMentionsNormalizedReference(establishedNarrative, reference)
        ) ?? false;
        return isPlayer || appearedEarlierInSource || appearedByIdentity || appearedByRole;
      });
    }),
  };
}
