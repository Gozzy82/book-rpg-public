import type { TurnDecision } from "./turn-validator.js";
import type {
  CharacterRelationship,
  CharacterProfile,
  GameState,
  ImportedBook,
  Scene,
  SceneScope,
  ChapterActionObservation,
  StoryEventBeat,
} from "../../shared/contracts.js";
import {
  sourceReferenceKey,
} from "../../books/source-index/chapter-index.js";
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
  choiceTextsAreSimilar,
  stripLeakedSceneMetadata,
  textMentionsCharacter,
} from "./scene-text.js";
import {
  filterSceneScopeForState,
} from "./scene-validation.js";
import {
  buildSourceChoiceNavigationContext,
  buildSourceEventBeatProgressContext,
  sourceEventPlayerChoiceBeats,
} from "./source-navigation.js";
import {
  SOURCE_GROUNDING_EXCERPT_CHARS,
} from "./source.js";
import {
  buildImmediateTurnTransition,
} from "./turn.js";

export const WRITING_SYSTEMS = [
  ["Latin", /\p{Script=Latin}/gu],
  ["Cyrillic", /\p{Script=Cyrillic}/gu],
  ["Greek", /\p{Script=Greek}/gu],
  ["Arabic", /\p{Script=Arabic}/gu],
  ["Hebrew", /\p{Script=Hebrew}/gu],
  ["Devanagari", /\p{Script=Devanagari}/gu],
  ["Han", /\p{Script=Han}/gu],
  ["Hiragana", /\p{Script=Hiragana}/gu],
  ["Katakana", /\p{Script=Katakana}/gu],
  ["Hangul", /\p{Script=Hangul}/gu],
  ["Thai", /\p{Script=Thai}/gu],
] as const;

export function writingSystemCount(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

export function sceneUsesUnexpectedWritingSystem(
  scene: Pick<Scene, "title" | "text" | "choices">,
  referenceText: string,
): boolean {
  const outputText = [
    scene.title,
    scene.text,
    ...scene.choices.map((choice) => choice.text),
  ].join("\n");
  return WRITING_SYSTEMS.some(([, pattern]) =>
    writingSystemCount(outputText, pattern) >= 2
    && writingSystemCount(referenceText, pattern) === 0
  );
}

export function buildWritingSystemReference(state: GameState): string {
  return [
    state.book.title,
    state.book.author ?? "",
    state.selectedText,
    state.wholeBookSummary ?? "",
    ...state.characterProfiles?.flatMap((profile) => [
      profile.name,
      ...profile.aliases,
      profile.role,
      profile.description,
      ...profile.traits,
      profile.storyArc,
    ]) ?? [],
    ...state.history.map((item) => item.text),
  ].join("\n");
}

export function sceneRepeatsCurrentNarrative(
  scene: Pick<Scene, "text">,
  currentScene: Pick<Scene, "text">,
): boolean {
  const normalize = (text: string): string =>
    stripEmbeddedChoiceMenu(text).normalize("NFKC").replace(/\s+/g, " ").trim();
  const currentText = normalize(currentScene.text);
  return Boolean(currentText)
    && choiceTextsAreSimilar(normalize(scene.text), currentText);
}

export function sceneRepeatsRecentNarrative(
  scene: Pick<Scene, "text">,
  state: Pick<GameState, "scene" | "history">,
): boolean {
  return [
    state.scene.text,
    ...state.history
      .filter((item) => item.kind === "scene")
      .slice(-4)
      .map((item) => item.text),
  ].some((text) => sceneRepeatsCurrentNarrative(scene, { text }));
}

export interface SceneRepetitionReview {
  repeatsPriorScene: boolean;
  latestInputResolvedFaithfully: boolean;
  preservesPlayerPerspective: boolean;
  latestInputFailureType?:
    | "none"
    | "stalled"
    | "omitted"
    | "contradicted"
    | "identity_or_roles";
  preservesPlayerAgency: boolean;
  staysWithinTurnScope: boolean;
  latestInputFailureReason?: string;
  playerPerspectiveFailureReason?: string;
  playerAgencyFailureReason?: string;
  turnScopeFailureReason?: string;
  requiredEventOccurred: boolean;
  nonInteractableCharacters?: string[];
  nonInteractableCharactersReason?: string;
  reason: string;
}

export interface ChoiceRejectionFeedback {
  text: string;
  role: "anchor" | "alternative" | "unknown";
  reason: string;
}

export interface SceneChoiceReview {
  anchorChoiceIndex: number | null;
  unusableChoiceIndexes: number[];
  unusableChoicesReason: string;
  reason: string;
}

export interface CompletedSceneAction {
  playerAction: string;
  actionResult: string;
}

export interface DialogueSceneReviewContext {
  playerUtterance: string;
  responseSpeaker: string;
  characterResponse: string;
  narration: string;
}

export interface ScenePresenceReview {
  peopleKilledInScene?: string[];
  turnValidation?: TurnDecision;
  peoplePresent: string[];
  peopleWithinSpeakingDistance: string[];
  latestVisibleSourceEventId: string | null;
  completedSourceEventBeatIndexes: number[];
  futureActionSetupRequired: boolean;
  futureActionSetupSupported: boolean;
  futureActionSetupReason: string;
  reason: string;
}

export function normalizeIndependentReviewFailures(
  review: SceneRepetitionReview,
): SceneRepetitionReview {
  const hasStructuredFailureReasons =
    review.latestInputFailureReason !== undefined
    && review.playerAgencyFailureReason !== undefined
    && review.turnScopeFailureReason !== undefined;
  if (!hasStructuredFailureReasons) return review;

  return {
    ...review,
    latestInputResolvedFaithfully:
      review.latestInputResolvedFaithfully
      || !review.latestInputFailureReason?.trim(),
    preservesPlayerAgency:
      review.preservesPlayerAgency
      || !review.playerAgencyFailureReason?.trim(),
    staysWithinTurnScope:
      review.staysWithinTurnScope
      || !review.turnScopeFailureReason?.trim(),
  };
}

export function reviewedUnusableChoiceIndexes(
  review: SceneChoiceReview | undefined,
  choiceCount: number,
): number[] {
  return [...new Set(review?.unusableChoiceIndexes ?? [])].filter(
    (index) =>
      Number.isInteger(index)
      && index >= 0
      && index < choiceCount,
  );
}

export const SCENE_REPETITION_REVIEW_OUTPUT_TOKENS = [3_200, 6_400] as const;
export const SCENE_CHOICE_REVIEW_OUTPUT_TOKENS = [800, 1_600, 3_200] as const;
export const SCENE_PRESENCE_REVIEW_OUTPUT_TOKENS = [3_200, 6_400] as const;

export function recentScenesForRepetitionReview(
  state: Pick<GameState, "scene" | "history">,
): Array<{ title?: string; text: string; development?: string; sceneScope?: SceneScope }> {
  const scenes = [
    ...state.history
      .filter((item) => item.kind === "scene")
      .map((item) => ({
        text: stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(item.text)),
        development: item.development?.trim() || undefined,
        sceneScope: item.sceneScope,
      })),
    {
      title: state.scene.title,
      text: stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(state.scene.text)),
      development: state.scene.development?.trim() || undefined,
      sceneScope: state.scene.sceneScope,
    },
  ];
  const unique: typeof scenes = [];
  const seen = new Set<string>();
  for (const scene of scenes.toReversed()) {
    if (!scene.text || seen.has(scene.text)) continue;
    seen.add(scene.text);
    unique.push(scene);
    if (unique.length === 4) break;
  }
  return unique.reverse();
}

export function hasPriorPlayerFacingScene(
  state: Pick<GameState, "scene" | "history">,
): boolean {
  return recentScenesForRepetitionReview(state).length > 0;
}

export function buildSceneRepetitionReviewContext(
  state: Pick<
    GameState,
    | "scene"
    | "history"
    | "playerName"
    | "characterProfiles"
    | "objective"
    | "selectedText"
    | "parameters"
  >,
  candidate: Pick<Scene, "title" | "text" | "development" | "sceneScope"> & {
    actionResult?: string;
  },
  dialogue?: DialogueSceneReviewContext,
): string {
  const priorScenes = recentScenesForRepetitionReview(state);
  const playerProfile = findPlayerCharacterProfile(
    state.playerName,
    state.characterProfiles,
  );

  return JSON.stringify({
    player_identity: state.playerName,
    runtime_parameters: state.parameters ?? [],
    player_identity_aliases: playerProfile
      ? [playerProfile.name, ...playerProfile.aliases]
      : [state.playerName],
    objective: state.objective,
    source_passage: state.selectedText,
    immediate_transition: buildImmediateTurnTransition(state) ?? null,
    recent_prior_scenes: priorScenes,
    candidate_scene: {
      title: candidate.title,
      text: stripLeakedSceneMetadata(
        stripEmbeddedChoiceMenu(dialogue?.narration ?? candidate.text),
      ),
      ...(dialogue
        ? {
            dialogue: {
              player_utterance: dialogue.playerUtterance,
              response_speaker: dialogue.responseSpeaker,
              character_response: dialogue.characterResponse,
            },
          }
        : {}),
      development: candidate.development?.trim() || null,
      sceneScope: candidate.sceneScope ?? null,
      action_result: candidate.actionResult?.trim() || null,
    },
  }, null, 2);
}

export function buildSceneChoiceReviewContext(
  state: Pick<
    GameState,
    | "scene"
    | "history"
    | "playerName"
    | "characterProfiles"
    | "objective"
    | "selectedText"
    | "parameters"
  >,
  candidate: Pick<
    Scene,
    "title" | "text" | "development" | "choices" | "sceneScope" | "outcomeReason"
  >,
  completedAction?: CompletedSceneAction,
): string {
  const playerProfile = findPlayerCharacterProfile(
    state.playerName,
    state.characterProfiles,
  );

  return JSON.stringify({
    player_identity: state.playerName,
    runtime_parameters: state.parameters ?? [],
    player_identity_aliases: playerProfile
      ? [playerProfile.name, ...playerProfile.aliases]
      : [state.playerName],
    objective: state.objective,
    source_passage: state.selectedText,
    recent_prior_scenes: recentScenesForRepetitionReview(state),
    candidate_scene: {
      title: candidate.title,
      text: stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(candidate.text)),
      development: candidate.development?.trim() || null,
      outcomeReason: candidate.outcomeReason?.trim() || null,
      playerAction: completedAction?.playerAction.trim() || null,
      actionResult: completedAction?.actionResult.trim() || null,
      sceneScope: candidate.sceneScope ?? null,
      choices: candidate.choices.map((choice) => ({
        type: choice.type,
        text: choice.text,
        character: choice.character ?? null,
      })),
    },
  }, null, 2);
}

export function buildSceneRegenerationInstruction(
  instruction: string,
  consumedAction?: string,
  validationFailures: readonly string[] = [],
  rejectedChoices: readonly string[] = [],
): string {
  return [
    instruction,
    "",
    "REGENERATION REQUIRED: The previous draft repeated the current scene or left an active scene without a usable new choice.",
    ...(validationFailures.length > 0
      ? [`REJECTED BECAUSE:\n- ${validationFailures.join("\n- ")}`]
      : []),
    ...(rejectedChoices.length > 0
      ? [
          "DO NOT END AT A DECISION POINT THAT ONLY SUPPORTS THESE REJECTED CHOICES OR PARAPHRASES:",
          ...rejectedChoices.map((choice) => `- ${JSON.stringify(choice)}`),
        ]
      : []),
    ...(consumedAction
      ? [
          `Resolve ${JSON.stringify(consumedAction)} in the narrative instead of leaving it as the next decision.`,
          "The consumed action must be visibly resolved before the new decision point.",
        ]
      : []),
    "If the outcome remains 'active', end at a concrete decision point. Choices are generated separately after the scene is approved.",
    "Do not embed a choice menu in the scene text or output.",
    "Narrate this turn's concrete result and do not copy the current scene text or its old choices.",
  ].join("\n");
}

export function buildDialogueContinuationInstruction(
  playerName: string,
  character: string,
  playerText: string,
): string {
  return [
    `PLAYER: ${JSON.stringify(playerName)}`,
    `TARGET CHARACTER: ${JSON.stringify(character)}`,
    `PLAYER'S UTTERANCE: ${JSON.stringify(playerText)}`,
    "",
    "Treat PLAYER'S UTTERANCE as the authoritative latest player intent, even when it changes or abandons the previous topic.",
    "Respond to its actual meaning, tone, and speech act instead of continuing the prior conversational plan.",
    `If ${playerName} declares that they are leaving, stopping, refusing, or taking an action, the scene must address and enact that intent unless another character credibly prevents it.`,
    "If the declared action irreversibly abandons the objective, use outcome 'lost' and explain why; do not force the old objective to continue.",
    `The player's utterance has already been spoken by ${playerName} to ${character}.`,
    `Begin the new scene with ${character}'s clearly attributed response to that utterance.`,
    `${character} must respond substantively now with concrete information, an observable emotional reaction, a meaningful refusal, or a deliberate lie.`,
    `Do not let ${character} merely promise to answer later, repeat the question, or give an empty acknowledgement.`,
    `Do not describe ${playerName} as answering, reacting to, or receiving their own utterance.`,
    `After ${character}'s response, continue the scene from ${playerName}'s perspective.`,
    `Every new choice must follow from the latest player intent and a specific detail, inconsistency, refusal, or emotional cue in ${character}'s response.`,
    "Do not offer choices that simply repeat or paraphrase the question that was just answered.",
  ].join("\n");
}

export function buildCanonBlock(state: GameState) {
  const presentCharacters = state.scene.sceneScope
    ? filterSceneScopeForState(state.scene.sceneScope, state).peoplePresent
    : [];
  const establishedEventFact = state.establishedEvent
    ? [
        `${state.establishedEvent.actor} ${state.establishedEvent.action} `
          + `${state.establishedEvent.target}.`,
        ...state.establishedEvent.immediateConsequences,
      ]
    : [];
  return {
    worldRules: state.parameters ?? [],
    tone: state.gameProfile.description,
    playerIdentity: state.playerName,
    immutableFacts: [
      ...establishedEventFact,
      ...(state.storyMemory?.canonFacts ?? []),
    ].slice(-12),
    presentCharacters,
    knownSourceCharacters: state.sourceIntroducedCharacters ?? [],
    continuityRules: [
      "Player-facing established facts override future summaries and source material.",
      "Unselected choices have not happened.",
      "Never change the player identity or swap actor and target roles.",
    ],
  };
}

function profileMatchesIdentities(
  profile: Pick<CharacterProfile, "name" | "aliases">,
  identities: ReadonlySet<string>,
): boolean {
  return [profile.name, ...profile.aliases].some((identity) =>
    identities.has(identity.trim().toLocaleLowerCase())
  );
}

type SceneCharacterProfile = Pick<
  CharacterProfile,
  "name" | "aliases" | "role" | "description" | "traits" | "storyArc"
> & {
  relationships: Array<Pick<CharacterRelationship, "character" | "description">>;
};

function compactSceneCharacterProfile(
  profile: CharacterProfile,
): SceneCharacterProfile {
  return {
    name: profile.name,
    aliases: profile.aliases,
    role: profile.role,
    description: profile.description,
    traits: profile.traits,
    relationships: profile.relationships.map((relationship) => ({
      character: relationship.character,
      description: relationship.description,
    })),
    storyArc: profile.storyArc,
  };
}

export function buildDialogueTargetCharacterProfile(
  targetCharacter: string,
  playerName: string,
  profiles: readonly CharacterProfile[] | undefined,
) {
  const availableProfiles = profiles ?? [];
  const normalizeIdentity = (identity: string): string =>
    identity.trim().toLocaleLowerCase();
  const matchesIdentity = (
    profile: Pick<CharacterProfile, "name" | "aliases">,
    identity: string,
  ): boolean => {
    const normalizedIdentity = normalizeIdentity(identity);
    return [profile.name, ...profile.aliases].some(
      (candidate) => normalizeIdentity(candidate) === normalizedIdentity,
    );
  };
  const targetProfile = availableProfiles.find((profile) =>
    matchesIdentity(profile, targetCharacter)
  );
  if (!targetProfile) return null;

  const playerProfile = availableProfiles.find((profile) =>
    matchesIdentity(profile, playerName)
  );
  const playerIdentities = new Set(
    [playerName, playerProfile?.name, ...(playerProfile?.aliases ?? [])]
      .filter((identity): identity is string => Boolean(identity?.trim()))
      .map(normalizeIdentity),
  );

  return {
    name: targetProfile.name,
    aliases: targetProfile.aliases,
    role: targetProfile.role,
    description: targetProfile.description,
    traits: targetProfile.traits,
    relationships: targetProfile.relationships
      .filter((relationship) =>
        playerIdentities.has(normalizeIdentity(relationship.character))
      )
      .map((relationship) => ({
        character: relationship.character,
        description: relationship.description,
      })),
  };
}

function nearbySceneCharacterProfiles(state: GameState): CharacterProfile[] {
  if (!state.scene.sceneScope) return [];

  const nearbyIdentities = new Set(
    filterSceneScopeForState(state.scene.sceneScope, state).peoplePresent.map(
      (identity) => identity.trim().toLocaleLowerCase(),
    ),
  );
  const playerProfile = findPlayerCharacterProfile(state.playerName, state.characterProfiles);
  return (state.characterProfiles ?? []).filter((profile) =>
    profile !== playerProfile && profileMatchesIdentities(profile, nearbyIdentities)
  );
}

function relevantOpeningCharacterProfiles(
  state: GameState,
  sourceCandidates: readonly SourceContinuationCandidate[],
): CharacterProfile[] {
  const relevantIdentities = new Set<string>();
  const addIdentity = (identity: string | undefined) => {
    const normalized = identity?.trim().toLocaleLowerCase();
    if (normalized) relevantIdentities.add(normalized);
  };
  const addEventCharacters = (
    event: { actors?: readonly string[]; targets?: readonly string[] } | undefined,
  ) => {
    event?.actors?.forEach(addIdentity);
    event?.targets?.forEach(addIdentity);
  };

  addIdentity(state.playerName);
  state.scene.sceneScope?.peoplePresent.forEach(addIdentity);
  state.scene.sceneScope?.peopleWithinSpeakingDistance.forEach(addIdentity);
  addIdentity(state.establishedEvent?.actor);
  addIdentity(state.establishedEvent?.target);

  const candidate = sourceCandidates[0];
  addEventCharacters(candidate?.currentStoryEvent);
  candidate?.requiredEventActors?.forEach(addIdentity);
  candidate?.requiredEventTargets?.forEach(addIdentity);
  const nextStoryEvent = candidate?.storyEvents
    ?.filter((event) =>
      !candidate.currentStoryEvent
      || event.sequence > candidate.currentStoryEvent.sequence
    )
    .sort((left, right) => left.sequence - right.sequence)[0];
  addEventCharacters(nextStoryEvent);

  return (state.characterProfiles ?? []).filter((profile) =>
    profileMatchesIdentities(profile, relevantIdentities)
    || sourceCandidates.some((sourceCandidate) =>
      textMentionsCharacter(
        sourceCandidate.excerpt,
        profile.name,
        state.characterProfiles,
      )
    )
  );
}

export function buildGameContext(
  state: GameState,
  sourceCandidates: readonly SourceContinuationCandidate[] = [],
  opening = false,
): string {
  const playerCharacterProfile = findPlayerCharacterProfile(
    state.playerName,
    state.characterProfiles,
  );
  const characterProfiles = opening
    ? relevantOpeningCharacterProfiles(state, sourceCandidates)
    : nearbySceneCharacterProfiles(state);
  const sceneCharacterProfiles = characterProfiles.map(
    compactSceneCharacterProfile,
  );
  const openingCharacterIdentities = characterProfiles.map((profile) => ({
    name: profile.name,
    aliases: profile.aliases,
  }));
  const openingPlayerIdentity = playerCharacterProfile
    ? {
        name: playerCharacterProfile.name,
        aliases: playerCharacterProfile.aliases,
      }
    : null;
  const currentScene = {
    ...state.scene,
    text: stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(state.scene.text)),
    choices: [],
  };
  const currentSceneContext = currentScene.text.trim() ? currentScene : null;
  const historyWindow = state.history.slice(-9).map((item) => {
    if (item.kind !== "scene") return item;
    const text = stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(item.text));
    return text === item.text ? item : { ...item, text };
  });
  const currentSceneHistoryIndex = historyWindow.findLastIndex(
    (item) => item.kind === "scene" && item.text === currentScene.text,
  );
  const currentSourceChapterPosition = state.sourceCursor?.chapterPosition
    ?? state.position?.chapterIndex;
  const openingEvent = sourceCandidates[0]?.currentStoryEvent ?? null;
  const currentSignificantEvent = opening ? null : openingEvent;
  const nextSignificantEvent = buildSourceChoiceNavigationContext(
    sourceCandidates[0],
    state.playerName,
    state.characterProfiles,
  );
  const beatProgressEvent = opening ? openingEvent : nextSignificantEvent;
  const nextSignificantEventProgress = buildSourceEventBeatProgressContext(
    beatProgressEvent,
    state.sourceEventProgress,
  );
  const nextRequiredBeat = nextSignificantEventProgress?.nextRequiredBeat;
  const openingEvents = opening
    ? [
        ...(openingEvent ? [openingEvent] : []),
        ...(sourceCandidates[0]?.storyEvents ?? []),
      ].filter(
        (event, index, events) =>
          events.findIndex((candidate) => candidate.eventId === event.eventId) === index,
      )
    : [];
  const openingPlayerFutureActions = openingEvents.flatMap((event) => {
    const playerBeats = sourceEventPlayerChoiceBeats(
      event,
      state.playerName,
      state.characterProfiles,
    );
    return playerBeats.map((beat) => ({
      event_id: event.eventId,
      event_description: event.description,
      beat_index: event.beats?.indexOf(beat) ?? -1,
      action: beat.action,
      targets: beat.targets,
      agency: beat.agency,
      stakes: beat.stakes,
      source_excerpt:
        buildBeatSourceReferencesExcerpt(
          beat,
          sourceCandidates[0]?.sourceReferenceExcerpts,
        )
        || sourceCandidates[0]?.excerpt
        || "",
    }));
  });
  const remainingNextEvent = nextSignificantEvent
    ? {
        ...nextSignificantEvent,
        beats: nextSignificantEventProgress?.remainingBeats
          ?? nextSignificantEvent.beats,
      }
    : null;
  const nextPlayerFutureActions = opening
    ? []
    : sourceEventPlayerChoiceBeats(
        remainingNextEvent,
        state.playerName,
        state.characterProfiles,
      ).map((beat) => ({
        event_id: nextSignificantEvent?.eventId ?? null,
        event_description: nextSignificantEvent?.description ?? "",
        beat_index: nextSignificantEvent?.beats?.indexOf(beat) ?? -1,
        action: beat.action,
        targets: beat.targets,
        agency: beat.agency,
        stakes: beat.stakes,
        source_excerpt:
          buildBeatSourceReferencesExcerpt(
            beat,
            sourceCandidates[0]?.sourceReferenceExcerpts,
          )
          || sourceCandidates[0]?.excerpt
          || "",
      }));
  const sourceReferencesExcerpt = nextRequiredBeat
    ? (
        buildBeatSourceReferencesExcerpt(
          nextRequiredBeat,
          sourceCandidates[0]?.sourceReferenceExcerpts,
        )
        || sourceCandidates[0]?.excerpt
        || ""
      )
    : "";
  const remainingBeatsWithSourceReferences = (
    nextSignificantEventProgress?.remainingBeats ?? []
  ).map((beat) => ({
    ...beat,
    sourceReferencesExcerpt: buildBeatSourceReferencesExcerpt(
      beat,
      sourceCandidates[0]?.sourceReferenceExcerpts,
    ),
  }));
  const canon = buildCanonBlock(state);
  const recentHistory = historyWindow
    .filter((_item, index) => index !== currentSceneHistoryIndex)
    .slice(-8)
    .map((item) => ({
      ...item,
      text: item.text.length > 2_500 ? `${item.text.slice(0, 2_500)}…` : item.text,
    }));

  return JSON.stringify({
    book: state.book,
    character_profiles: opening
      ? openingCharacterIdentities
      : sceneCharacterProfiles,
    runtime_parameters: state.parameters ?? [],
    source_guidance_mode: opening ? "optional_opening_reference" : "continuity_reference",
    story_so_far: opening ? (sourceCandidates[0]?.storySoFar ?? []) : [],
    canon: opening
      ? { ...canon, tone: state.gameProfile.category }
      : canon,
    story_memory: state.storyMemory ?? {
      summary: "",
      openThreads: [],
      canonFacts: [],
    },
    player_identity: state.playerName,
    player_character_profile: opening
      ? openingPlayerIdentity
      : (
          playerCharacterProfile
            ? compactSceneCharacterProfile(playerCharacterProfile)
            : null
        ),
    game_profile: opening
      ? {
          category: state.gameProfile.category,
          endingMode: state.gameProfile.endingMode,
        }
      : state.gameProfile,
    objective: state.objective,
    victoryCondition: state.victoryCondition,
    status: state.status,
    position: state.position,
    source_cursor: state.sourceCursor ?? null,
    current_significant_event: currentSignificantEvent,
    next_significant_event: opening ? null : nextSignificantEvent,
    next_significant_event_progress: !nextSignificantEventProgress
      ? null
      : {
          event_id: nextSignificantEventProgress.eventId,
          completed_beat_indexes: nextSignificantEventProgress.completedBeatIndexes,
          completed_beats: nextSignificantEventProgress.completedBeats,
          next_required_beat: nextRequiredBeat
            ? {
                ...nextRequiredBeat,
                sourceReferencesExcerpt,
              }
            : null,
          remaining_beats: remainingBeatsWithSourceReferences,
        },
    opening_reference_event: opening ? openingEvent : null,
    opening_event_sequence: opening ? openingEvents : [],
    opening_player_future_actions: opening ? openingPlayerFutureActions : [],
    next_player_future_actions: opening ? [] : nextPlayerFutureActions,
    source_introduced_characters: state.sourceIntroducedCharacters ?? [],
    source_passage: state.selectedText,
    upcoming_source_material: sourceCandidates.map((candidate) => ({
      chapterPosition: candidate.chapterPosition,
      chapterTitle: candidate.chapterTitle,
      recoveryRoute: candidate.recovery ?? false,
      startsNewChapter: currentSourceChapterPosition !== undefined
        && candidate.chapterPosition > currentSourceChapterPosition,
      ...(candidate.requiredEvent ? { requiredEvent: candidate.requiredEvent } : {}),
      ...(candidate.requiredEventId ? { requiredEventId: candidate.requiredEventId } : {}),
      summary: candidate.summary,
      chapterSummary: candidate.chapterSummary ?? candidate.summary,
      excerpt: candidate.excerpt.slice(0, SOURCE_GROUNDING_EXCERPT_CHARS),
    })),
    current_scene: currentSceneContext,
    history: recentHistory,
  }, null, 2);
}

function buildBeatSourceReferencesExcerpt(
  beat: StoryEventBeat,
  sourceReferenceExcerpts: Readonly<Record<string, string>> | undefined,
): string {
  const seen = new Set<string>();
  return beat.sourceReferences.flatMap((reference) => {
    const key = sourceReferenceKey(reference);
    if (seen.has(key)) return [];
    seen.add(key);
    const excerpt = sourceReferenceExcerpts?.[key];
    return excerpt === undefined ? [] : [excerpt];
  }).join("\n\n");
}

export interface PassageContext {
  chapterPosition?: number;
  chapterTitle?: string;
  passageEnd?: number;
  textThroughPassage: string;
}

export function findPassageContext(
  book: Pick<ImportedBook, "chapters">,
  selectedText: string,
  maxChars = 12_000,
): PassageContext {
  const passage = selectedText.trim().replace(/\s+/g, " ");
  for (const [chapterPosition, chapter] of book.chapters.entries()) {
    const normalizedChapter = chapter.text.replace(/\s+/g, " ");
    const passageStart = normalizedChapter.indexOf(passage);
    if (passageStart < 0) continue;

    const passageEnd = passageStart + passage.length;
    return {
      chapterPosition,
      chapterTitle: chapter.title,
      passageEnd,
      textThroughPassage: normalizedChapter.slice(Math.max(0, passageEnd - maxChars), passageEnd),
    };
  }

  return { textThroughPassage: passage };
}

export function sourceLineAtNormalizedOffset(
  text: string,
  textOffset: number,
): number {
  const source = text.trim();
  const leadingWhitespaceLength = text.length - text.trimStart().length;
  const adjustedOffset = Math.max(
    0,
    textOffset - (leadingWhitespaceLength > 0 ? 1 : 0),
  );
  let normalizedLength = 0;
  let line = 1;
  let inWhitespace = false;

  for (const character of source) {
    const isWhitespace = /\s/u.test(character);
    if (isWhitespace) {
      if (!inWhitespace) normalizedLength += 1;
      inWhitespace = true;
    } else {
      normalizedLength += 1;
      inWhitespace = false;
    }
    if (normalizedLength >= adjustedOffset) return line;
    if (character === "\n") line += 1;
  }
  return line;
}

export function buildPlayerAvailabilityContext(
  state: GameState,
  book: ImportedBook,
): { context: string; resolvedPosition?: GameState["position"] } {
  const passage = findPassageContext(book, state.selectedText);
  const chapter = passage.chapterPosition === undefined
    ? undefined
    : book.chapters[passage.chapterPosition];
  const normalizedPlayerName = state.playerName.toLocaleLowerCase();
  const playerCharacterProfile = findPlayerCharacterProfile(
    state.playerName,
    book.worldBible?.characterProfiles,
  );
  const knownCharacter = (
    book.worldBible?.characters.some(
      (character) => character.toLocaleLowerCase() === normalizedPlayerName,
    )
    || Boolean(playerCharacterProfile)
  ) ?? false;
  const resolvedPosition = chapter
    ? {
        ...state.position,
        chapterIndex: passage.chapterPosition,
        chapterTitle: chapter.title,
      }
    : state.position;
  const completedSourceActions = sourceActionsCompletedAtSelectedMoment(
    book,
    state.selectedText,
  );

  return {
    context: JSON.stringify({
      book: state.book,
      whole_book_summary: book.worldBible?.summary ?? null,
      character_profiles: book.worldBible?.characterProfiles ?? [],
      book_game_profile: state.gameProfile,
      player_identity: state.playerName,
      player_character_profile: playerCharacterProfile ?? null,
      canonical_book_character: knownCharacter,
      position: resolvedPosition,
      story_text_ending_at_selected_moment: passage.textThroughPassage,
      source_actions_completed_by_selected_moment: completedSourceActions,
    }, null, 2),
    resolvedPosition,
  };
}

export function sourceActionsCompletedAtSelectedMoment(
  book: Pick<ImportedBook, "chapters">,
  selectedText: string,
): ChapterActionObservation[] {
  const passage = findPassageContext(book, selectedText);
  if (passage.chapterPosition === undefined || passage.passageEnd === undefined) {
    return [];
  }
  const chapter = book.chapters[passage.chapterPosition];
  if (!chapter) return [];
  const selectedSourceLine = sourceLineAtNormalizedOffset(
    chapter.text,
    passage.passageEnd,
  );
  return (chapter.sourceIndex?.actions ?? []).filter((action) =>
    action.sourceReferences.length > 0
    && action.sourceReferences.every((reference) =>
      reference.chapterPosition < passage.chapterPosition!
      || (
        reference.chapterPosition === passage.chapterPosition
        && reference.lineEnd <= selectedSourceLine
      )
    )
  );
}

