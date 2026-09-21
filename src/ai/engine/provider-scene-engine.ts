import {normalizeSceneDeaths} from '../../shared/scene-deaths.js';
import { canonicalBeatSceneEligible, generateCanonicalBeatScene } from './canonical-beat-scene.js';
import { establishSourceEventEntry } from './source-event-entry.js';
import { completedCharacterEventSequence } from "./character-runtime.js";
import { summarizeAcceptedSourceWindow, type TurnWindowEvent } from "./cross-event-window.js";
import { currentTurnExecution, planTurn, runPlannedTurn } from "./turn-contract.js";
import { flowDiagnostic } from "../../util/flow-trace.js";
import type {
  ChoiceStakes,
  GameState,
  Scene,
  StoryEventBeat,
  StoryMemory,
  SceneScope,
} from "../../shared/contracts.js";
import type {
  AiReasoningEffort,
  AiResponseRequest,
} from "../provider.js";
import {
  sceneSettingJsonSchemaForSourceChapters,
} from "../schema.js";
import {
  InvalidAiJsonError,
  SceneGenerationError,
  parseAiJson,
} from "./core.js";
import type {
  GeneratedScene,
  SourceContinuationCandidate,
} from "./core.js";
import {
  normalizeSceneTalkChoices,
} from "./dialogue.js";
import {
  stripEmbeddedChoiceMenu,
} from "./normalization.js";
import {
  findPlayerCharacterProfile,
  buildPlayerPerspective,
} from "./player.js";
import {
  ProviderSceneReviewer,
} from "./provider-scene-reviewer.js";
import {
  COMPACT_SCENE_STYLE_RULES,
  ORDERED_WINDOW_SCENE_STYLE_RULES,
  OBSERVED_SCENE_PROGRESSION_STYLE_RULES,
  SOURCE_GROUNDING_RULES,
  TURN_SCOPE_RULES,
  SCENE_SCOPE_RULES,
  RUNTIME_PARAMETER_RULES,
  STORY_MEMORY_RULES,
  SCENE_TITLE_RULES,
} from "./rules.js";
import {
  sceneUsesUnexpectedWritingSystem,
  buildWritingSystemReference,
  sceneRepeatsRecentNarrative,
  reviewedUnusableChoiceIndexes,
  hasPriorPlayerFacingScene,
  buildSceneRegenerationInstruction,
  buildGameContext,
} from "./scene-context.js";
import type {
  CompletedSceneAction,
  SceneRepetitionReview,
} from "./scene-context.js";
import {
  stripLeakedSceneMetadata,
  sceneLeaksInternalMetadata,
} from "./scene-text.js";
import {
  removeDuplicateChoices,
  removeRecentChoiceParaphrases,
  removeConsumedActionChoices,
  actionResolutionFailures,
  hasTooFewChoicesForActiveScene,
  playerScopeAliases,
  sceneScopeFailures,
  filterSceneScope,
  sceneScopeOrFallback,
  hasSourceContinuationChoiceFallback,
  sourceContinuationChoiceText,
  addSourceContinuationChoiceFallback,
  addSourceContinuationAnchorChoice,
  firstChoiceWasFiltered,
  promoteAnchorChoice,
  filteredAnchorChoiceFailures,
  shouldHandleMissingAnchorChoice,
  applyEstablishedEvent,
  developmentRepeatsHistory,
  removeChoicesWithPlayerIdentityReferences,
  sceneNonInteractableCharacters,
  repairGeneratedChoices,
  removeChoicesWithUnintroducedCharacters,
} from "./scene-validation.js";
import {
  visibleSourceEventNarrative,
  nextSignificantEventForCandidate,
  sourceSceneBeatReviewTargetId,
  buildSourceEventBeatProgressContext,
  buildSourceEventChoiceBeatState,
  sourceEventFirstPlayerChoiceBeatIndex,
  sourceEventHasReadyPlayerChoice,
  sourceEventPlayerChoiceBeats,
  reviewedVisibleSourceEvent,
  buildRequiredPlayerChoiceFallback,
} from "./source-navigation.js";
import type {
  SourceChoiceNavigationEvent,
  SourceEventBeatProgressContext,
} from "./source-navigation.js";
import {
  groundedSourceProgress,
  resolveGroundedSourceCandidate,
  reasoningEffortForTurn,
} from "./source.js";
import {
  openingCharacterContinuityFailures,
  buildImmediateTurnTransition,
  isGameStagnating,
  buildStagnationBreakingInstruction,
  buildAnchorChoiceInstruction,
} from "./turn.js";

type SceneGenerationMode = "interactive_turn" | "observed_scene_progression" | "source_continuation" | "opening";

type SceneDraftOutput = Omit<Scene, "choices"> & {
  choices?: Scene["choices"];
  playerAction: string;
  actionOutcome: string;
  actionResult: string;
  externalDevelopment: string;
  sourceChapterPosition: number | null;
  storyMemory?: StoryMemory;
};

function sourceBeatLogEntry(beat: StoryEventBeat, index: number) {
  return {
    index,
    actor: beat.actor,
    action: beat.action,
    agency: beat.agency,
    stakes: beat.stakes,
  };
}

function prepareSceneGeneration(
  state: GameState,
  sourceCandidates: readonly SourceContinuationCandidate[],
  mode: SceneGenerationMode,
  requiredSourceEvent: boolean,
  choiceStakes: ChoiceStakes | undefined,
  reasoningEffort: AiReasoningEffort,
) {
  const openingSourceEvent = mode === "opening"
    ? sourceCandidates[0]?.currentStoryEvent
    : undefined;
  const sourceBeatNavigationEvent = openingSourceEvent
    ?? nextSignificantEventForCandidate(sourceCandidates[0]);
  const sourceBeatProgress = buildSourceEventBeatProgressContext(
    sourceBeatNavigationEvent,
    state.sourceEventProgress,
  );
  const nextRequiredSourceBeat = sourceBeatProgress?.nextRequiredBeat;
  const nextRequiredBeatIsPlayerChoice =
    Boolean(nextRequiredSourceBeat)
    && sourceEventPlayerChoiceBeats(
      sourceBeatNavigationEvent && nextRequiredSourceBeat
        ? {
          ...sourceBeatNavigationEvent,
          beats: [nextRequiredSourceBeat],
        }
        : null,
      state.playerName,
      state.characterProfiles,
    ).length > 0;
  const openingNextRequiredBeatIsPlayerChoice =
    mode === "opening" && nextRequiredBeatIsPlayerChoice;
  const openingFirstPlayerBeatOffset =
    mode === "opening" && sourceBeatNavigationEvent && sourceBeatProgress
      ? sourceEventFirstPlayerChoiceBeatIndex(
        {
          ...sourceBeatNavigationEvent,
          beats: sourceBeatProgress.remainingBeats,
        },
        state.playerName,
        state.characterProfiles,
      )
      : -1;
  const openingFirstPlayerBeatIndex =
    openingFirstPlayerBeatOffset >= 0 && sourceBeatProgress
      ? (sourceBeatProgress.startBeatIndex + sourceBeatProgress.completedBeatIndexes.length) + openingFirstPlayerBeatOffset
      : -1;
  const openingWordBudget = mode === "opening" ? 600 : 120;
  const requiredSourceBeatProgress =
    requiredSourceEvent && nextRequiredSourceBeat
      ? sourceBeatProgress
      : null;
  const requiredSourceBeatIndex = requiredSourceBeatProgress
    ? (requiredSourceBeatProgress.startBeatIndex + requiredSourceBeatProgress.completedBeatIndexes.length)
    : undefined;
  if (sourceBeatProgress) {
    const completedCount = (sourceBeatProgress.startBeatIndex + sourceBeatProgress.completedBeatIndexes.length);
    flowDiagnostic(
      "OpenAI scene source beat context: "
      + JSON.stringify({
        event_id: sourceBeatProgress.eventId,
        completed_beats: sourceBeatProgress.completedBeats.map(
          (beat, index) => sourceBeatLogEntry(beat, index),
        ),
        next_required_beat: sourceBeatProgress.nextRequiredBeat
          ? sourceBeatLogEntry(
            sourceBeatProgress.nextRequiredBeat,
            completedCount,
          )
          : null,
        remaining_beats: sourceBeatProgress.remainingBeats.map(
          (beat, index) => sourceBeatLogEntry(beat, completedCount + index),
        ),
      }),
    );
  }
  const gameContext = buildGameContext(state, sourceCandidates, mode === "opening");
  const playerProfile = findPlayerCharacterProfile(
    state.playerName,
    state.characterProfiles,
  );
  const playerPerspective = buildPlayerPerspective(
    state.playerName,
    playerProfile,
    mode === "opening",
  );
  const writingSystemReference = buildWritingSystemReference(state);
  const immediateTurnTransition = buildImmediateTurnTransition(state);
  const isWorldEventTurn = immediateTurnTransition?.latest_input.kind === "world_event";
  const shouldReviewSemanticContinuity = mode === "opening"
    ? sourceCandidates.length > 0
    : (
      hasPriorPlayerFacingScene(state)
      || sourceCandidates.some((candidate) => Boolean(candidate.requiredEvent?.trim()))
    );
  const sceneSchema = sceneSettingJsonSchemaForSourceChapters(
    sourceCandidates.map((candidate) => candidate.chapterPosition),
  );
  const contract = currentTurnExecution()?.contract;
  const hasOrderedWindow = Boolean(contract
    && contract.allowedPlayerBeatIndexes.length + contract.requiredAutomaticBeatIndexes.length > 1);
  const sceneStyleRules = hasOrderedWindow ? ORDERED_WINDOW_SCENE_STYLE_RULES : mode === "observed_scene_progression"
    ? OBSERVED_SCENE_PROGRESSION_STYLE_RULES
    : mode === "opening"
      ? [
        ...COMPACT_SCENE_STYLE_RULES,
        `Opening scene text may use up to ${openingWordBudget} words when ordered pre-player beats require the extra room. This opening-specific budget overrides the generic 120-word compact target.`,
      ]
      : COMPACT_SCENE_STYLE_RULES;
  const turnReasoningEffort = reasoningEffortForTurn(
    reasoningEffort,
    choiceStakes,
  );
  return {
    sourceBeatNavigationEvent,
    sourceBeatProgress,
    openingNextRequiredBeatIsPlayerChoice,
    openingFirstPlayerBeatOffset,
    openingFirstPlayerBeatIndex,
    openingWordBudget,
    requiredSourceBeatProgress,
    requiredSourceBeatIndex,
    gameContext,
    playerPerspective,
    writingSystemReference,
    immediateTurnTransition,
    isWorldEventTurn,
    shouldReviewSemanticContinuity,
    sceneSchema,
    sceneStyleRules,
    turnReasoningEffort,
  };
}

function buildSceneRequest(context: {
  attempt: number;
  turnReasoningEffort: ReturnType<typeof reasoningEffortForTurn>;
  model: string;
  mode: SceneGenerationMode;
  openingWordBudget: number;
  isWorldEventTurn: boolean;
  requiredSourceEvent: boolean;
  requiredSourceBeatProgress: SourceEventBeatProgressContext | null;
  openingFirstPlayerBeatOffset: number;
  openingNextRequiredBeatIsPlayerChoice: boolean;
  sourceCandidates: readonly SourceContinuationCandidate[];
  sceneStyleRules: readonly string[];
  turnInstruction: string;
  immediateTurnTransition: ReturnType<typeof buildImmediateTurnTransition>;
  playerPerspective: string;
  gameContext: string;
  sceneSchema: Record<string, unknown>;
  maxOutputTokens: number;
}): AiResponseRequest {
  const {
    attempt,
    turnReasoningEffort,
    model,
    mode,
    openingWordBudget,
    isWorldEventTurn,
    requiredSourceEvent,
    requiredSourceBeatProgress,
    openingFirstPlayerBeatOffset,
    openingNextRequiredBeatIsPlayerChoice,
    sourceCandidates,
    sceneStyleRules,
    turnInstruction,
    immediateTurnTransition,
    playerPerspective,
    gameContext,
    sceneSchema,
    maxOutputTokens,
  } = context;
  return {
    model,
    reasoning: {
      effort: attempt === 0 ? turnReasoningEffort : "low",
    },
    instructions: [
      "You are the game engine for BookRPG.",
      "Create an interactive scene inspired by the supplied book context, but do not quote long passages from the source.",
      "Use the bounded source passage, relevant character profiles, game profile, story memory, and upcoming source material as background for the setting, character relationships, and role-specific stakes.",
      "story_so_far and upcoming_source_material may contain canonical events after the selected passage. Do not reveal those events as spoilers, treat them as already known to the player, or force them to occur after the interactive timeline diverges.",
      "established_event is authoritative structured timeline state. When present in an opening scene, its narrative is inserted by the application before your text; begin with the immediate aftermath and do not repeat or contradict the event.",
      "When established_event is null, do not invent a completed major event merely from later information in story_so_far or upcoming_source_material.",
      "The player_identity field is authoritative. Keep that character or persona consistent in narration, knowledge, dialogue, and available actions.",
      "When player_character_profile is present, treat it as authoritative for the player's identity, role, physical nature, and capabilities.",
      ...RUNTIME_PARAMETER_RULES,
      "Never infer that the player is the source passage's viewpoint character unless player_identity explicitly names that character.",
      "The turn instruction is newer than every entry in GAME CONTEXT. Resolve it instead of repeating or continuing an older player action.",
      "When IMMEDIATE TURN TRANSITION is present, previous_scene has already happened and latest_input is the exact option, dialogue, event, or scene-continuation request to resolve now. Do not recap or replay it. Treat its setting, positions, props, physical conditions, ongoing activity, relationships, and atmosphere as established state until this turn visibly changes them.",
      ...(isWorldEventTurn
        ? [
          "This is a WORLD EVENT turn, not a PLAYER ACTION turn. Make latest_input.text occur externally; never assign its initiating action, decision, intent, or hidden action metadata to player_identity.",
          "Use the WORLD EVENT as this turn's one major plot beat. Show only its direct immediate reactions and observable consequences, then stop before another independently initiated event, voluntary player action, major decision, or substantial time/location transition.",
          "For this WORLD EVENT turn, return playerAction: '', actionResult: '', and actionOutcome: 'none'. Put later player actions only in choices and do not enact them in scene text.",
        ]
        : []),
      "For an option, dialogue, or event, begin at its consequence. For scene_continuation, paint the next observable beat from the previous scene's final moment while preserving its established state.",
      "Continue causally from current_scene and the latest history. Preserve established world-state facts unless the current turn changes them.",
      "Keep the scene internally consistent from first sentence to last. Once this scene establishes that a character is present or has arrived, later prose and the resulting decision point must not place them before arrival, await their return, or prepare for them to come home unless their departure is visibly narrated first.",
      "current_significant_event is the latest canonical event already reached. Do not replay, restate, or move backward before it.",
      ...(currentTurnExecution() ? [
        "The ORDERED TURN SCRIPT alone defines required source progression and the stop boundary. Complete its entire ordered_execution, including automatic follow-up, then stop before next_decision. Do not truncate the window to one beat. On an optional source route, resolve the selected action without forcing canonical progression.",
      ] : [
      ...(requiredSourceEvent
        ? [
          "The selected source-continuation route requires progress in the current source event, but only the next ordered beat is mandatory now.",
          "Visibly complete next_significant_event_progress.next_required_beat in this scene. Do not require or summarize every later remaining beat.",
          "After the required beat and its immediate inseparable consequence, stop at the next meaningful decision or observable beat boundary. Later remaining beats stay future unless they follow automatically without crossing a player decision boundary.",
          "Do not mark the source event complete unless every beat is actually completed.",
          `Required beat to complete now: ${requiredSourceBeatProgress?.nextRequiredBeat?.action ?? "the next required source beat"}`,
        ]
        : [
          "upcoming_source_material is optional canonical reference, not a required route, unless the player explicitly selected the source-continuation option.",
          "In an ordinary player turn, adapt a compatible source development only when it follows naturally from latest_input or occurs independently without choosing another action for the player. If the interactive timeline has diverged, follow the divergence instead.",
          "next_significant_event is a possible source development, not an obligation. Do not steer toward it merely to restore the book's original plot.",
          "Do not depict next_significant_event as completed when reaching it still requires another voluntary player decision or an unmet causal prerequisite. In that case, establish the nearest immediate setup, pressure, opportunity, or transition toward it.",
          "When the next source-backed development requires another voluntary player decision, do not make it happen in this turn and keep sourceChapterPosition null.",
        ]),
      "Preserve the source development's narrative function, participants, and consequences where possible, but never undo completed player actions or established interactive world changes.",
      "next_significant_event_progress is authoritative cumulative state. Never repeat completed_beats or skip next_required_beat for a later remaining beat. If next_required_beat is a meaningful player-controlled action that latest_input did not select, establish only its prerequisites and leave it as a choice; otherwise resolve it before later remaining_beats. Do not claim the event complete until remaining_beats is empty.",
      ...(mode === "opening" && openingFirstPlayerBeatOffset > 0
        ? [
          "OPENING AUTOMATIC PREFIX: the first meaningful player-controlled beat lies later in the ordered event. Before presenting any menu, visibly complete every still-unfinished ordered beat before that player beat, including intentional NPC actions as well as world, external, involuntary, and routine beats. Stop immediately before the player beat and leave it wholly unperformed so it can become option 1.",
        ]
        : []),
      ...(openingNextRequiredBeatIsPlayerChoice
        ? [
          "OPENING HARD STOP: next_significant_event_progress.next_required_beat belongs to player_identity and has not been selected. Do not perform, paraphrase as completed, or hide that action in narration or metadata. Establish only its prerequisites, stop immediately before the action, and offer it as a choice.",
        ]
        : []),
      "next_player_future_actions lists meaningful player-controlled beats from that event, with source excerpts. Treat an item as still future unless latest_input or the selected SOURCE ANCHOR explicitly authorizes that same action.",
      "Only prepare a future player action when it is the next required ordered beat. Never jump across intervening NPC, external, involuntary, or other source beats merely to stage a later player beat.",
      "When latest_input and the established world state remain causally compatible with the source route, use the current next player beat plus its source_excerpt to infer and visibly establish its physical and social prerequisites at the decision point.",
      "Never speak, decide, or perform an unselected next_player_future_action for the player. Stop before it so the choice generator can offer it.",
      "If latest_input or established interactive state has diverged incompatibly, follow that divergence and do not force, reconstruct, or prepare the source action.",
      ...SOURCE_GROUNDING_RULES,
      ...TURN_SCOPE_RULES,
      ]),
      ...SCENE_SCOPE_RULES,
      "The prior scene's choice menu is absent from GAME CONTEXT because it is not world state. Any unselected_options supplied in IMMEDIATE TURN TRANSITION are rejection constraints, not events to reconstruct.",
      "If an absent character becomes available during this turn, explicitly narrate their arrival before any speech, answer, gesture, or other interaction from them.",
      "An absent or not-yet-introduced character may be mentioned as a memory, relationship, or person elsewhere, but must not appear, arrive, speak, respond, or interact until the source context or this scene introduces them.",
      "Use the writing system and language established by the source passage and game context. Do not insert words from an unrelated language or writing system.",
      "Set externalDevelopment to a concise description of the concrete external event, discovery, environmental change, NPC action, arrival, accident, threat, or opportunity introduced this turn. Use an empty string only when no such development occurs.",
      "externalDevelopment is hidden metadata. Never mention its field name, label, value, or existence in actionResult, scene text, titles, choices, or any player-facing prose.",
      "When STAGNATION BREAK REQUIRED appears, externalDevelopment must be non-empty and the described development must visibly happen in scene text.",
      "Copy PLAYER ACTION exactly and completely into playerAction. If there is no PLAYER ACTION, use an empty string.",
      "Set actionOutcome to succeeded, partially_succeeded, failed, or interrupted for a PLAYER ACTION, and to none only when there is no PLAYER ACTION.",
      "Set actionResult to hidden metadata containing a concise, concrete account of what happened because of PLAYER ACTION. Use an empty string only when this turn has no PLAYER ACTION.",
      "Never expose actionResult as a separate summary in player-facing prose. The scene text itself must naturally show the action and its immediate consequences before continuing.",
      "When PLAYER ACTION asks, demands, questions, guarantees, promises, signals, orders, or otherwise addresses someone, actionResult must include that person's immediate substantive response or observable refusal.",
      "actionResult must describe visible execution of the exact selected act rather than restate an intention. Starting or trying is fulfilled by visibly beginning the attempt; its ultimate goal may remain pending. Never turn a selected attempt into a successful outcome reserved for the next unselected player beat. Match actionResult and actionOutcome to the prose and the scope of the selected act.",
      "An imperative, request, or merely desired outcome in PLAYER ACTION may fail; never treat it as automatically successful. However, a player-controlled act phrased as already completed, or an explicitly stated immediate observation or world fact, is authoritative user narration and must not be downgraded into an attempt or contradicted.",
      "Preserve the actor, target, and direction of PLAYER ACTION in both the scene and its choices. Never substitute the target performing a mirrored action back at the player.",
      "This is fictional roleplay. Do not silently replace a harmful, crude, coercive, or morally objectionable PLAYER ACTION with a safer decision. Show the concrete attempt and consequences. Another character may stop or interrupt it only through a specific action narrated on the page.",
      "Use objective and victoryCondition as the persistent goal.",
      "Respect game_profile.endingMode when deciding how the game can end.",
      "Set outcome to 'active' while the goal remains unresolved.",
      "For endingMode 'win', set outcome to 'won' only when victoryCondition has concretely happened.",
      "For endingMode 'completion', use 'completed' at the natural narrative conclusion; do not call completion a win.",
      "For endingMode 'open_ended', keep outcome 'active' and provide meaningful milestones instead of inventing a final victory.",
      "Set outcome to 'lost' only when the role's objective has become irreversibly impossible.",
      "For an investigation whose victoryCondition requires a confession, only an explicit admission by the actual culprit counts. Suspicion, accusation, bluffing, or a witness statement alone never counts.",
      "A credible bluff or sustained extreme psychological pressure may cause a plausible confession even without complete forensic proof; do not postpone a confession forever once the culprit plausibly breaks.",
      "For 'won' or 'lost', explain the result in outcomeReason.",
      ...STORY_MEMORY_RULES,
      ...SCENE_TITLE_RULES,
      ...sceneStyleRules,
    ].join("\n"),
    input: `${turnInstruction}`
      + (immediateTurnTransition
        ? `\n\nIMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):\n${JSON.stringify(immediateTurnTransition, null, 2)}`
        : "")
      + `\n\nPLAYER PERSPECTIVE RULES:\n${playerPerspective}`
      + `\n\nGAME CONTEXT:\n${gameContext}`,
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_scene",
        strict: true,
        schema: sceneSchema,
      },
    },
    max_output_tokens: maxOutputTokens,
  };
}

export function ensureRequiredPlayerChoiceFirst(
  scene: Scene,
  fallback: Scene["choices"][number] | undefined,
): Scene {
  if (!fallback || (scene.outcome ?? "active") !== "active") return scene;
  const withFallback = removeDuplicateChoices({
    ...scene,
    choices: repairGeneratedChoices([
      fallback,
      ...scene.choices.filter((choice) => choice.id !== fallback.id),
    ]),
  });
  const routed = promoteAnchorChoice(withFallback, 0, fallback.sourceEventId);
  return {
    ...routed,
    // Preserve the required-choice identity while clearing route tags on alternatives.
    choices: routed.choices.slice(0, 4).map((choice, index) => index === 0
      ? {...choice, id: fallback.id} : choice),
  };
}

export abstract class ProviderSceneEngine extends ProviderSceneReviewer {
  private async buildAndReviewSceneChoices(context: {
    setting: Scene;
    choiceReviewState: GameState;
    sourceCandidates: readonly SourceContinuationCandidate[];
    consumedAction?: string;
    completedSourceEventId?: string;
    reviewedUnavailableCharacters: readonly string[];
    completedAction?: CompletedSceneAction;
    embeddedChoices?: Scene["choices"];
    state: GameState;
    reviewSourceCandidate?: SourceContinuationCandidate;
    reviewedVisibleEvent: SourceChoiceNavigationEvent | null;
    eventReviewTargetId?: string;
    isFinalObservedProgressionAttempt: boolean;
    attempt: number;
    maxAttempts: number;
    skipSemanticChoiceReview?: boolean;
  }) {
    if (!this.centralReviewValidation) return this.buildAndReviewSceneChoicesInScope(context);
    const event = nextSignificantEventForCandidate(context.sourceCandidates[0], context.completedSourceEventId);
    const local = Boolean(context.setting.sourceActionOutcome) || currentTurnExecution()?.contract.sourceProgression === "optional";
    const contract = planTurn({state: {...context.choiceReviewState, scene: context.setting}, mode: "observe",
      sourceProgression: local ? "optional" : "required", event: local ? null : event,
      currentEventSequence: completedCharacterEventSequence(context.choiceReviewState, context.sourceCandidates)});
    return runPlannedTurn(contract, () => this.buildAndReviewSceneChoicesInScope(local
      ? {...context, sourceCandidates: [], reviewSourceCandidate: undefined} : context));
  }

  private async buildAndReviewSceneChoicesInScope(context: Parameters<ProviderSceneEngine["buildAndReviewSceneChoices"]>[0]) {
    const {
      setting,
      choiceReviewState,
      sourceCandidates,
      consumedAction,
      completedSourceEventId,
      reviewedUnavailableCharacters,
      completedAction,
      embeddedChoices,
      state,
      reviewSourceCandidate,
      reviewedVisibleEvent,
      eventReviewTargetId,
      isFinalObservedProgressionAttempt,
      attempt,
      maxAttempts,
      skipSemanticChoiceReview,
    } = context;
    const generatedChoices = repairGeneratedChoices(
      embeddedChoices ?? (
        (setting.outcome ?? "active") === "active"
          ? await this.sceneChoices(
            setting,
            choiceReviewState,
            sourceCandidates,
            consumedAction,
            completedSourceEventId,
            [],
            [],
            reviewedUnavailableCharacters,
            completedAction,
            skipSemanticChoiceReview,
          )
          : []
      ),
    );
    const choicesLeakInternalMetadata = sceneLeaksInternalMetadata(
      ...generatedChoices.map((choice) => choice.text),
    );
    const cleanedDraft: Scene = {
      ...setting,
      choices: generatedChoices,
    };
    const actionFilteredScene = consumedAction
      ? removeConsumedActionChoices(cleanedDraft, consumedAction)
      : cleanedDraft;
    const identityFilteredScene = removeChoicesWithPlayerIdentityReferences(
      actionFilteredScene,
      state.playerName,
      state.characterProfiles,
    );
    const introducedCharacterScene = removeChoicesWithUnintroducedCharacters(
      identityFilteredScene,
      state,
      visibleSourceEventNarrative(sourceCandidates),
      reviewedUnavailableCharacters,
    );
    const distinctScene = removeDuplicateChoices(introducedCharacterScene);
    const filteredScene = removeRecentChoiceParaphrases(distinctScene, state.history);
    const choiceNavigationEvent = buildSourceEventChoiceBeatState(
      nextSignificantEventForCandidate(sourceCandidates[0], completedSourceEventId),
      choiceReviewState.sourceEventProgress,
    ).remainingEvent;
    const requiresExplicitPlayerChoice = sourceEventHasReadyPlayerChoice(
      choiceNavigationEvent,
      state.playerName,
      state.characterProfiles,
      setting.sceneScope,
    );
    const requiredPlayerFallback = requiresExplicitPlayerChoice
      ? buildRequiredPlayerChoiceFallback(
        choiceNavigationEvent,
        state.playerName,
        state.characterProfiles,
        setting.sceneScope,
        currentTurnExecution()?.contract.nextPlayerAction?.choiceText,
      )
      : undefined;
    const continuationText = sourceContinuationChoiceText(sourceCandidates[0]);
    const scene = requiresExplicitPlayerChoice
      ? ensureRequiredPlayerChoiceFirst(filteredScene, requiredPlayerFallback)
      : addSourceContinuationChoiceFallback(
        filteredScene,
        continuationText,
      );
    const hadNoUsableChoices = (scene.outcome ?? "active") === "active"
      && scene.choices.length === 0;
    const hasInsufficientChoices = hasTooFewChoicesForActiveScene(scene);
    const anchorChoiceWasFiltered = requiredPlayerFallback
      ? false
      : firstChoiceWasFiltered(
        generatedChoices,
        scene.choices,
        scene.outcome,
      );
    const choiceValidationFailures = [
      ...(hadNoUsableChoices && attempt < maxAttempts - 1
        ? [
          "No usable player choices remained. Generate 2 to 4 distinct, immediately "
          + "playable options; include a route toward the next indexed story event "
          + "when possible without forcing an unselected player action.",
        ]
        : []),
      ...(hasInsufficientChoices
        ? [
          `Only ${scene.choices.length} distinct usable choice(s) remained; at least 2 are required.`,
        ]
        : []),
      ...filteredAnchorChoiceFailures(
        anchorChoiceWasFiltered,
        attempt,
        maxAttempts,
      ),
      ...(choicesLeakInternalMetadata
        ? ["Player-facing title, prose or choices exposed hidden control metadata such as externalDevelopment or OPENING PRELUDE. Use an in-world title and remove control labels."]
        : []),
    ];
    let anchorOrderedScene = scene;
    if (
      choiceValidationFailures.length === 0
      && (scene.outcome ?? "active") === "active"
      && !skipSemanticChoiceReview
    ) {
      let choiceReview = await this.reviewSceneChoices(
        choiceReviewState,
        scene,
        reviewSourceCandidate,
        completedSourceEventId,
        completedAction,
      );
      const unusableChoiceIndexes = reviewedUnusableChoiceIndexes(
        choiceReview,
        scene.choices.length,
      );
      if (unusableChoiceIndexes.length > 0) {
        const unusableIndexes = new Set(unusableChoiceIndexes);
        const acceptedChoices = scene.choices.filter(
          (_choice, index) => !unusableIndexes.has(index),
        );
        const rejectedChoiceFeedback = scene.choices.flatMap((choice, index) => unusableIndexes.has(index)
          ? [{text: choice.text, role: index === 0 ? "anchor" as const : "alternative" as const,
            reason: choiceReview.unusableChoicesReason || choiceReview.reason}] : []);
        const retainedReviewedChoices = acceptedChoices.length >= 2 && (!requiresExplicitPlayerChoice || !unusableIndexes.has(0));
        const reviewedAnchor = choiceReview.anchorChoiceIndex === null ? undefined : scene.choices[choiceReview.anchorChoiceIndex];
        const repairedChoices =
          retainedReviewedChoices
            ? acceptedChoices
            : await this.sceneChoices(
              setting,
              choiceReviewState,
              sourceCandidates,
              consumedAction,
              completedSourceEventId,
              acceptedChoices,
              rejectedChoiceFeedback,
              reviewedUnavailableCharacters,
              completedAction,
              skipSemanticChoiceReview,
            );
        anchorOrderedScene = requiresExplicitPlayerChoice
          ? ensureRequiredPlayerChoiceFirst(
            { ...scene, choices: repairedChoices },
            requiredPlayerFallback,
          )
          : { ...scene, choices: repairedChoices };
        flowDiagnostic(
          `${this.client.provider} scene choice scope review removed `
          + `${unusableChoiceIndexes.length} unusable choice(s): `
          + `${choiceReview.unusableChoicesReason || choiceReview.reason}`,
        );
        if (hasTooFewChoicesForActiveScene(anchorOrderedScene)) {
          choiceValidationFailures.push(
            "The semantic choice scope review left fewer than two immediately usable choices.",
          );
        }
        if (
          sceneLeaksInternalMetadata(
            ...anchorOrderedScene.choices.map((choice) => choice.text),
          )
        ) {
          choiceValidationFailures.push(
            "Player-facing title, prose or choices exposed hidden control metadata such as externalDevelopment or OPENING PRELUDE. Use an in-world title and remove control labels.",
          );
        }
        if (retainedReviewedChoices) {
          const anchorIndex = reviewedAnchor ? acceptedChoices.indexOf(reviewedAnchor) : -1;
          choiceReview = {...choiceReview, anchorChoiceIndex: anchorIndex >= 0 ? anchorIndex : null,
            unusableChoiceIndexes: [], unusableChoicesReason: ''};
        } else if (choiceValidationFailures.length === 0) {
          choiceReview = await this.reviewSceneChoices(
            choiceReviewState,
            anchorOrderedScene,
            reviewSourceCandidate,
            completedSourceEventId,
            completedAction,
          );
          const rejected = new Set(reviewedUnusableChoiceIndexes(choiceReview, anchorOrderedScene.choices.length));
          if (rejected.size > 0) {
            const retained = anchorOrderedScene.choices.filter((_choice, index) => !rejected.has(index));
            if (retained.length >= 2 && !rejected.has(0)) {
              const anchor = choiceReview.anchorChoiceIndex === null ? undefined : anchorOrderedScene.choices[choiceReview.anchorChoiceIndex];
              anchorOrderedScene = {...anchorOrderedScene, choices: retained};
              const anchorIndex = anchor ? retained.indexOf(anchor) : -1;
              choiceReview = {...choiceReview, anchorChoiceIndex: anchorIndex >= 0 ? anchorIndex : null};
            } else {
              choiceValidationFailures.push("Regenerated choices still contradicted the confirmed SceneScope or completed scene state.");
            }
          }
        }
      }
      if (shouldHandleMissingAnchorChoice({
        hasValidationFailures: choiceValidationFailures.length > 0,
        activeScene: true,
        anchorChoiceIndex: choiceReview.anchorChoiceIndex,
        finalAttempt: isFinalObservedProgressionAttempt,
        sourceEventOccurred: reviewedVisibleEvent?.eventId === eventReviewTargetId,
      })) {
        if (requiresExplicitPlayerChoice) {
          const fallback = requiredPlayerFallback
            ?? buildRequiredPlayerChoiceFallback(
              choiceNavigationEvent,
              state.playerName,
              state.characterProfiles,
              setting.sceneScope,
            );
          if (fallback) {
            anchorOrderedScene = ensureRequiredPlayerChoiceFirst(
              anchorOrderedScene,
              fallback,
            );
          } else {
            choiceValidationFailures.push(
              "No offered choice explicitly asks the player to perform the consequential next source event.",
            );
          }
        } else if (!hasSourceContinuationChoiceFallback(anchorOrderedScene)) {
          anchorOrderedScene = addSourceContinuationAnchorChoice(
            anchorOrderedScene,
            continuationText,
          );
        }
      } else if (
        choiceValidationFailures.length === 0
        && requiresExplicitPlayerChoice
        && requiredPlayerFallback
      ) {
        anchorOrderedScene = ensureRequiredPlayerChoiceFirst(
          anchorOrderedScene,
          requiredPlayerFallback,
        );
      } else if (
        choiceValidationFailures.length === 0
        && choiceReview.anchorChoiceIndex !== null
      ) {
        anchorOrderedScene = promoteAnchorChoice(
          anchorOrderedScene,
          choiceReview.anchorChoiceIndex,
          choiceNavigationEvent?.eventId ?? undefined,
        );
      }
    }

    return {
      generatedChoices,
      scene,
      anchorOrderedScene,
      choiceValidationFailures,
      hasInsufficientChoices,
      anchorChoiceWasFiltered,
    };
  }

  private async validateSceneDraft(context: {
    output: SceneDraftOutput;
    state: GameState;
    consumedAction?: string;
    sourceCandidates: readonly SourceContinuationCandidate[];
    requiredSourceEvent: boolean;
    isWorldEventTurn: boolean;
    attempt: number;
    maxAttempts: number;
    openingWordBudget: number;
    mode: SceneGenerationMode;
    stagnating: boolean;
    isFinalObservedProgressionAttempt: boolean;
    writingSystemReference: ReturnType<typeof buildWritingSystemReference>;
    sourceBeatNavigationEvent: SourceChoiceNavigationEvent | null | undefined;
    requiredSourceBeatProgress: SourceEventBeatProgressContext | null;
    shouldReviewSemanticContinuity: boolean;
  }) {
    const {
      output,
      state,
      consumedAction,
      sourceCandidates,
      requiredSourceEvent,
      isWorldEventTurn,
      attempt,
      maxAttempts,
      openingWordBudget,
      mode,
      stagnating,
      isFinalObservedProgressionAttempt,
      writingSystemReference,
      sourceBeatNavigationEvent,
      requiredSourceBeatProgress,
      shouldReviewSemanticContinuity,
    } = context;
    const {
      playerAction,
      actionOutcome,
      actionResult,
      externalDevelopment,
      sourceChapterPosition,
      storyMemory,
      choices: embeddedChoices,
      ...draft
    } = output;
    const resolvedPlayerAction = isWorldEventTurn ? "" : playerAction;
    const resolvedActionOutcome = isWorldEventTurn ? "none" : actionOutcome;
    const resolvedActionResult = isWorldEventTurn ? "" : actionResult;
    const immediateActionFailures = actionResolutionFailures(
      resolvedPlayerAction,
      resolvedActionOutcome,
      resolvedActionResult,
      consumedAction,
    );
    if (immediateActionFailures.length > 0) {
      return {
        accepted: false as const,
        validationFailures: immediateActionFailures,
        forceReanchor: false,
      };
    }
    const completedAction = consumedAction
      ? {
        playerAction: resolvedPlayerAction,
        actionResult: resolvedActionResult,
      }
      : undefined;
    if (
      sceneLeaksInternalMetadata(
        resolvedActionResult,
        draft.title,
        draft.text,
      )
    ) {
      return {
        accepted: false as const,
        validationFailures: [
          "Player-facing title, prose or choices exposed hidden control metadata such as externalDevelopment or OPENING PRELUDE. Use an in-world title and remove control labels.",
        ],
        forceReanchor: false,
      };
    }
    const sourceCandidate = resolveGroundedSourceCandidate(
      sourceChapterPosition,
      sourceCandidates,
    ) ?? (
        requiredSourceEvent && sourceChapterPosition === null
          ? sourceCandidates[0]
          : undefined
      );
    if (sourceChapterPosition !== null && !sourceCandidate) {
      flowDiagnostic(
        `${this.client.provider} scene draft ${attempt + 1}/${maxAttempts} returned unsupported `
        + `sourceChapterPosition ${sourceChapterPosition}; source progress will not advance.`,
      );
    }
    const settingText = stripLeakedSceneMetadata(
      stripEmbeddedChoiceMenu(applyEstablishedEvent(state, draft.text)),
    );
    const sceneWordCount = settingText.trim()
      ? settingText.trim().split(/\s+/u).length
      : 0;
    const explicitlyUnavailable = sourceCandidates.flatMap(
      (candidate) => candidate.unavailableCharacters ?? [],
    );
    const unavailableCharacters = [
      ...sceneNonInteractableCharacters(
        state,
        { title: draft.title, text: settingText },
        explicitlyUnavailable,
      ),
    ];
    const proposedSceneScope = filterSceneScope(
      sceneScopeOrFallback(draft.sceneScope, state.scene.sceneScope),
      {
        playerName: state.playerName,
        playerAliases: playerScopeAliases(
          state.playerName,
          state.characterProfiles,
        ),
        knownCharacterProfiles: state.characterProfiles,
        nonInteractableCharacters: unavailableCharacters,
      },
    );
    const proposedSetting: Scene = {
      ...draft,
      choices: [],
      sceneScope: proposedSceneScope,
      text: settingText,
      development: externalDevelopment.trim() || undefined,
    };
    const repeatsCurrentNarrative =
      sceneRepeatsRecentNarrative(draft, state)
      || sceneRepeatsRecentNarrative(proposedSetting, state);
    const repeatsRecentDevelopment = stagnating
      && developmentRepeatsHistory(externalDevelopment, state.history);
    const validationFailures = [
      ...sceneScopeFailures(proposedSetting.sceneScope, {
        playerName: state.playerName,
        playerAliases: playerScopeAliases(
          state.playerName,
          state.characterProfiles,
        ),
        knownCharacterProfiles: state.characterProfiles,
        nonInteractableCharacters: unavailableCharacters,
      }),
      ...(repeatsCurrentNarrative && !isFinalObservedProgressionAttempt
        ? ["The narrative substantially repeats a recent scene's events, actions, setting beats, or imagery instead of advancing the world state."]
        : []),
      ...(sceneUsesUnexpectedWritingSystem(proposedSetting, writingSystemReference)
        ? ["The draft inserted a writing system absent from the established context."]
        : []),
      ...(mode === "opening"
        ? [
          ...(sceneWordCount > openingWordBudget
            ? [
              `Opening scene text contains ${sceneWordCount} words; keep it at or below the opening budget of ${openingWordBudget} words and stop at the immediate next player decision.`,
            ]
            : []),
        ]
        : []),
      ...(stagnating && !externalDevelopment.trim() && !isFinalObservedProgressionAttempt
        ? ["Stagnation requires a concrete externalDevelopment."]
        : []),
      ...(
        mode === "observed_scene_progression"
          && !externalDevelopment.trim()
          && !isFinalObservedProgressionAttempt
          ? [
            "Observed scene progression requires a concrete non-player or environmental "
            + "development that visibly changes the scene.",
          ]
          : []
      ),
      ...(
        requiredSourceEvent
          && Boolean(sourceBeatNavigationEvent?.beats?.length)
          && !requiredSourceBeatProgress
          ? ["Direct source continuation requires a next ordered source beat."]
          : []
      ),
      ...(repeatsRecentDevelopment && !isFinalObservedProgressionAttempt
        ? ["externalDevelopment repeats a recent development instead of introducing a new fact."]
        : []),
    ];
    let semanticRepeat = false;
    const reviewSourceCandidate = sourceCandidate ?? sourceCandidates[0];
    const recoveryCandidate = sourceCandidates.find((candidate) => candidate.recovery);
    const shouldEnforceSemanticRepetition = !isFinalObservedProgressionAttempt
      && (
        !recoveryCandidate
        || attempt < maxAttempts - 1
      );
    let repetitionReview: SceneRepetitionReview | undefined;
    if (validationFailures.length === 0 && shouldReviewSemanticContinuity) {
      repetitionReview = await this.reviewSceneRepetition(
        state,
        { ...proposedSetting, actionResult: resolvedActionResult },
        reviewSourceCandidate,
        requiredSourceEvent,
        Boolean(sourceCandidate && sourceChapterPosition !== null),
        false,
        undefined,
      );
      const aiNonInteractableFailures = sceneScopeFailures(
        proposedSetting.sceneScope,
        {
          playerName: state.playerName,
          playerAliases: playerScopeAliases(
            state.playerName,
            state.characterProfiles,
          ),
          knownCharacterProfiles: state.characterProfiles,
          nonInteractableCharacters: repetitionReview.nonInteractableCharacters,
        },
      ).filter((failure) => failure.includes("non-interactable character"));
      if (aiNonInteractableFailures.length > 0) {
        validationFailures.push(
          ...aiNonInteractableFailures,
          "The semantic continuity review found that "
          + `${repetitionReview.nonInteractableCharacters!.join(", ")} `
          + "are dead or otherwise not physically interactable: "
          + `${repetitionReview.nonInteractableCharactersReason?.trim() || repetitionReview.reason}`,
        );
      }
      if (!repetitionReview.latestInputResolvedFaithfully) {
        validationFailures.push(
          "The semantic continuity review found that the draft did not faithfully resolve "
          + "the latest input while preserving player identity and actor/target roles: "
          + `${repetitionReview.latestInputFailureReason?.trim() || repetitionReview.reason}`,
        );
      }
      if (repetitionReview.preservesPlayerPerspective === false) {
        validationFailures.push(
          "The semantic continuity review found that the narration switched away from "
          + `the player's first-person perspective: ${repetitionReview.playerPerspectiveFailureReason?.trim() || repetitionReview.reason}`,
        );
      }
      if (!repetitionReview.preservesPlayerAgency) {
        validationFailures.push(
          "The semantic continuity review found that the draft performed a consequential "
          + "player action that was not selected: "
          + `${repetitionReview.playerAgencyFailureReason?.trim() || repetitionReview.reason}`,
        );
      }
      if (!repetitionReview.staysWithinTurnScope) {
        validationFailures.push(
          "The semantic continuity review found that the draft advanced beyond the selected "
          + "action and its immediate consequences: "
          + `${repetitionReview.turnScopeFailureReason?.trim() || repetitionReview.reason}`,
        );
      }
      const recoveryEventOccurred = sourceCandidates.some(
        (candidate) => candidate.recovery,
      ) && repetitionReview.requiredEventOccurred;
      semanticRepeat = Boolean(
        shouldEnforceSemanticRepetition
        && repetitionReview.repeatsPriorScene
        && !recoveryEventOccurred
      );
    }
    if (validationFailures.length > 0) {
      return {
        accepted: false as const,
        validationFailures,
        forceReanchor:
          repeatsCurrentNarrative || repeatsRecentDevelopment || semanticRepeat,
      };
    }
    const reviewedUnavailableCharacters = [
      ...new Set([
        ...unavailableCharacters,
        ...(repetitionReview?.nonInteractableCharacters ?? []),
      ]),
    ];
    return {
      accepted: true as const,
      storyMemory,
      embeddedChoices,
      resolvedPlayerAction,
      completedAction,
      proposedSetting,
      proposedSceneScope,
      reviewedUnavailableCharacters,
      semanticRepeat,
      repetitionReview,
      sourceCandidate,
      reviewSourceCandidate,
    };
  }

  private async reviewSceneProgress(context: {
    state: GameState;
    proposedSetting: Scene;
    proposedSceneScope: SceneScope;
    resolvedPlayerAction: string;
    reviewedUnavailableCharacters: readonly string[];
    sourceCandidates: readonly SourceContinuationCandidate[];
    sourceBeatNavigationEvent: SourceChoiceNavigationEvent | null | undefined;
    mode: SceneGenerationMode;
    sourceBeatProgress: SourceEventBeatProgressContext | null;
    openingFirstPlayerBeatIndex: number;
    openingFirstPlayerBeatOffset: number;
    requiredSourceBeatProgress: SourceEventBeatProgressContext | null;
    requiredSourceBeatIndex?: number;
    semanticRepeat: boolean;
    repetitionReview?: SceneRepetitionReview;
    sourceCandidate?: SourceContinuationCandidate;
    reviewSourceCandidate?: SourceContinuationCandidate;
    requiredSourceEvent: boolean;
  }) {
    const {
      state,
      proposedSetting,
      proposedSceneScope,
      resolvedPlayerAction,
      reviewedUnavailableCharacters,
      sourceCandidates,
      sourceBeatNavigationEvent,
      mode,
      sourceBeatProgress,
      openingFirstPlayerBeatIndex,
      openingFirstPlayerBeatOffset,
      requiredSourceBeatProgress,
      requiredSourceBeatIndex,
      semanticRepeat,
      repetitionReview,
      sourceCandidate,
      reviewSourceCandidate,
      requiredSourceEvent,
    } = context;
    const eventReviewTargetId = sourceSceneBeatReviewTargetId(
      sourceBeatNavigationEvent,
      undefined,
    );
    const presenceReview = await this.reviewScenePresence(
      state,
      { ...proposedSetting, playerAction: resolvedPlayerAction },
      reviewedUnavailableCharacters,
      sourceCandidates,
      eventReviewTargetId,
      mode === "opening",
    );
    const setting: Scene = {
      ...proposedSetting,
      peopleKilledInScene: normalizeSceneDeaths(presenceReview.peopleKilledInScene, state.characterProfiles),
      sourceActionOutcome: presenceReview.turnValidation?.status === "accepted" ? presenceReview.turnValidation.actionOutcome : undefined,
      sceneScope: filterSceneScope(
        {
          currentLocation: proposedSceneScope.currentLocation,
          peoplePresent: presenceReview.peoplePresent,
          peopleWithinSpeakingDistance:
            presenceReview.peopleWithinSpeakingDistance,
        },
        {
          playerName: state.playerName,
          playerAliases: playerScopeAliases(
            state.playerName,
            state.characterProfiles,
          ),
          knownCharacterProfiles: state.characterProfiles,
          nonInteractableCharacters: [...reviewedUnavailableCharacters, ...normalizeSceneDeaths(presenceReview.peopleKilledInScene, state.characterProfiles)],
        },
      ),
    };
    const reviewedVisibleEvent = reviewedVisibleSourceEvent(
      sourceCandidates[0],
      presenceReview.latestVisibleSourceEventId,
    );
    const reviewedSourceEventProgress = eventReviewTargetId
      ? reviewedVisibleEvent?.eventId === eventReviewTargetId
        ? null
        : presenceReview.completedSourceEventBeatIndexes.length > 0 || (state.sourceEventProgress?.eventId === eventReviewTargetId && Boolean(state.sourceEventProgress.startBeatIndex))
          ? {
            eventId: eventReviewTargetId,
            ...(state.sourceEventProgress?.eventId === eventReviewTargetId && state.sourceEventProgress.startBeatIndex ? {startBeatIndex: state.sourceEventProgress.startBeatIndex} : {}),
            completedBeatIndexes:
              presenceReview.completedSourceEventBeatIndexes,
          }
          : undefined
      : undefined;
    const choiceReviewState = eventReviewTargetId
      ? { ...state, sourceEventProgress: reviewedSourceEventProgress ?? undefined }
      : state;
    const candidateOpeningProgressEvent = mode === "opening"
      ? reviewedVisibleEvent
      : undefined;
    const openingProgressEvent:
      | { eventId: string; chapterPosition: number; }
      | undefined = candidateOpeningProgressEvent?.eventId
        ? {
          eventId: candidateOpeningProgressEvent.eventId,
          chapterPosition: candidateOpeningProgressEvent.chapterPosition,
        }
        : undefined;
    const reviewedCompletedSourceEventId =
      eventReviewTargetId
        && reviewedVisibleEvent?.eventId === eventReviewTargetId
        ? reviewedVisibleEvent.eventId
        : undefined;
    const completedSourceEventId = requiredSourceEvent
      ? reviewedCompletedSourceEventId
      : mode === "opening"
        ? openingProgressEvent?.eventId
        : reviewedCompletedSourceEventId;
    const previousCompletedBeatCount =
      state.sourceEventProgress
        && state.sourceEventProgress.eventId === eventReviewTargetId
        ? state.sourceEventProgress.completedBeatIndexes.length
        : 0;
    const confirmedBeatProgress =
      reviewedVisibleEvent?.eventId === eventReviewTargetId
      || presenceReview.completedSourceEventBeatIndexes.length > previousCompletedBeatCount;
    const requiredBeatCompleted =
      requiredSourceBeatIndex === undefined
      || presenceReview.completedSourceEventBeatIndexes.includes(requiredSourceBeatIndex)
      || reviewedVisibleEvent?.eventId === eventReviewTargetId;
    const openingAutomaticPrefixIndexes =
      mode === "opening"
        && sourceBeatProgress
        && openingFirstPlayerBeatIndex > (sourceBeatProgress.startBeatIndex + sourceBeatProgress.completedBeatIndexes.length)
        ? Array.from(
          {
            length:
              openingFirstPlayerBeatIndex
              - (sourceBeatProgress.startBeatIndex + sourceBeatProgress.completedBeatIndexes.length),
          },
          (_value, index) =>
            (sourceBeatProgress.startBeatIndex + sourceBeatProgress.completedBeatIndexes.length) + index,
        )
        : [];
    const openingAutomaticPrefixCompleted =
      openingAutomaticPrefixIndexes.every((index) =>
        presenceReview.completedSourceEventBeatIndexes.includes(index)
      );
    const openingPlayerBeatWasPerformed =
      openingFirstPlayerBeatIndex >= 0
      && (
        presenceReview.completedSourceEventBeatIndexes.includes(
          openingFirstPlayerBeatIndex,
        )
        || reviewedVisibleEvent?.eventId === eventReviewTargetId
      );
    const presenceValidationFailures = [
      ...(mode === "opening" ? openingCharacterContinuityFailures(
        setting.text, state, sourceCandidates, setting.sceneScope,
      ) : []),
      ...(presenceReview.turnValidation?.status === "repair_scene"
        || (this.centralReviewValidation && presenceReview.turnValidation?.status === "needs_automatic_continuation")
        ? presenceReview.turnValidation.findings.map(finding => finding.message) : []),
      ...sceneScopeFailures(setting.sceneScope, {
        playerName: state.playerName,
        playerAliases: playerScopeAliases(
          state.playerName,
          state.characterProfiles,
        ),
        knownCharacterProfiles: state.characterProfiles,
        nonInteractableCharacters: reviewedUnavailableCharacters,
      }),
      ...(
        mode === "opening"
          && openingFirstPlayerBeatOffset > 0
          && !openingAutomaticPrefixCompleted
          ? [
            "The opening stopped before reaching the first meaningful player decision. Visibly complete every ordered NPC/world/involuntary/routine beat before that player beat in the same opening, then stop immediately before the player action so it can be option 1.",
          ]
          : []
      ),
      ...(
        mode === "opening"
          && openingFirstPlayerBeatIndex >= 0
          && openingPlayerBeatWasPerformed
          ? [
            "The opening performed the first meaningful player beat before it was selected. Leave that player beat entirely future and present it as option 1.",
          ]
          : []
      ),
      ...(
        presenceReview.turnValidation?.status !== "needs_automatic_continuation"
          && presenceReview.futureActionSetupRequired
          && !presenceReview.futureActionSetupSupported
          ? [
            "The scene did not establish the physical and social prerequisites "
            + "for the current next required player beat and source excerpt: "
            + (presenceReview.futureActionSetupReason?.trim() || presenceReview.reason),
          ]
          : []
      ),
      ...(
        requiredSourceBeatProgress
          && !requiredBeatCompleted
          && !presenceReview.turnValidation?.actionOutcome
          ? [
            "Direct source continuation did not visibly complete the required next source beat.",
            `Required beat ${requiredSourceBeatIndex}: ${requiredSourceBeatProgress.nextRequiredBeat?.action ?? "unknown beat"}.`,
            ...(requiredSourceBeatProgress.completedBeats.length > 0
              ? [
                "Do not replay already completed beats while correcting this failure: "
                + requiredSourceBeatProgress.completedBeats
                  .map((beat, index) =>
                    `${requiredSourceBeatProgress.completedBeatIndexes[index]}: ${beat.action}`
                  )
                  .join(" | "),
              ]
              : []),
          ]
          : []
      ),
      ...(
        semanticRepeat && !confirmedBeatProgress && !presenceReview.turnValidation?.actionOutcome
          ? [
            `The semantic repetition review found that the draft repeats prior narrative state without confirmed source-beat progress: ${repetitionReview?.reason ?? "no new ordered beat was confirmed"}`,
          ]
          : []
      ),
    ];
    let verifiedSourceCandidate = mode === "opening"
      ? undefined
      : sourceCandidate?.requiredEvent
        ? undefined
        : sourceCandidate;
    if (
      eventReviewTargetId
      && reviewSourceCandidate?.requiredEvent
      && reviewedVisibleEvent?.eventId === eventReviewTargetId
    ) {
      verifiedSourceCandidate = reviewSourceCandidate;
    }
    return {
      setting,
      presenceReview,
      eventReviewTargetId,
      reviewedVisibleEvent,
      reviewedSourceEventProgress,
      choiceReviewState,
      openingProgressEvent,
      completedSourceEventId,
      presenceValidationFailures,
      verifiedSourceCandidate,
    };
  }

  private async canonicalScene(state: GameState, consumedAction: string | undefined,
    sourceCandidates: readonly SourceContinuationCandidate[], mode: SceneGenerationMode): Promise<GeneratedScene> {
    const contract = currentTurnExecution()!.contract;
    const candidate = sourceCandidates[0];
    const target = mode === 'opening' ? candidate?.currentStoryEvent ?? nextSignificantEventForCandidate(candidate)
      : nextSignificantEventForCandidate(candidate);
    if (!candidate || target?.eventId !== contract.eventId) throw new SceneGenerationError(['Canonical event no longer matches the planned source window.'], 1);

    const result = await generateCanonicalBeatScene(state, contract, sourceCandidates,
      {beat: process.env.BOOKRPG_BEAT_MODEL?.trim() || this.model,
        review: process.env.BOOKRPG_SCENE_CONTENT_REVIEW?.trim().toLowerCase() === 'true',
        rewrite: process.env.BOOKRPG_REWRITE_MODEL?.trim() || (this.client.provider === 'openai' ? 'gpt-5.6-luna' : this.model)},
      (label, request) => this.createCanonicalSceneResponse(label, state.book.bookId, request));

    const windowEvents: TurnWindowEvent[] = [];
    const seenEventIds = new Set<string>();
    const addWindowEvent = (event: TurnWindowEvent | null | undefined) => {
      if (!event?.eventId || seenEventIds.has(event.eventId)) return;
      seenEventIds.add(event.eventId);
      windowEvents.push(event);
    };
    addWindowEvent(target);
    candidate.storyEvents?.forEach(addWindowEvent);

    // Runtime plans always carry origins. The fallback keeps older serialized
    // TurnContract fixtures/readers compatible with the pre-cross-event shape.
    const beatOrigins = contract.beats.map((_beat, index) =>
      contract.beatOrigins?.[index] ?? {eventId: contract.eventId, beatIndex: index});
    const nextDecisionOrigin = contract.nextPlayerDecisionOrigin
      ?? (contract.nextPlayerDecision === null ? null : beatOrigins[contract.nextPlayerDecision] ?? null);

    const acceptedWindow = summarizeAcceptedSourceWindow({
      primaryEventId: contract.eventId,
      primaryStartBeatIndex: contract.startBeatIndex,
      primaryCompletedBeatIndexes: contract.completedBeatIndexes,
      beatOrigins,
      completedFlatBeatIndexes: result.completedBeatIndexes,
      events: windowEvents,
    });
    const completedSourceEventId = acceptedWindow.lastCompletedEventId;
    // Being positioned inside an event is durable progress even when this scene
    // intentionally stops before its first player beat and therefore completes
    // zero beats (notably setup-only openings). Preserve the old event-local
    // zero-progress marker instead of treating it as "no source progress".
    const sourceEventProgress = acceptedWindow.sourceEventProgress
      ?? (completedSourceEventId
        ? null
        : contract.eventId
          ? {
            eventId: contract.eventId,
            ...(contract.startBeatIndex ? {startBeatIndex: contract.startBeatIndex} : {}),
            completedBeatIndexes: [...contract.completedBeatIndexes],
          }
          : undefined);
    const crossedEventBoundary = result.completedBeatIndexes.some((flatIndex) => {
      const eventId = beatOrigins[flatIndex]?.eventId;
      return Boolean(eventId && eventId !== contract.eventId);
    });
    const nextDecisionEventId = nextDecisionOrigin?.eventId ?? null;
    const rewriteModel = process.env.BOOKRPG_REWRITE_MODEL?.trim()
      || (this.client.provider === 'openai' ? 'gpt-5.6-luna' : this.model);

    // The canonical rewrite receives the immediate next-decision prelude itself.
    // Do not run a second source-beat entry model/review after the scene. Only
    // explicit sourceEventEntries gaps remain a separate transition because they
    // represent source material between completed indexed events.
    const currentEventCompleted = Boolean(
      contract.eventId && acceptedWindow.completedEventIds.includes(contract.eventId),
    );
    const withEntry = currentEventCompleted && (result.scene.outcome ?? 'active') === 'active'
      ? await establishSourceEventEntry(
        state,
        result.scene,
        candidate,
        contract.eventId!,
        rewriteModel,
        (label, request) => this.createCanonicalSceneResponse(label, state.book.bookId, request),
      )
      : result.scene;

    const {storyMemory, ...setting} = withEntry;
    const choiceState = {
      ...state,
      scene: setting,
      storyMemory,
      sourceEventProgress: sourceEventProgress ?? undefined,
    };
    const finalIndex = result.completedBeatIndexes.at(-1)!;
    const selectedCompletionIndex = [...contract.allowedPlayerBeatIndexes]
      .filter((index) => result.completedBeatIndexes.includes(index))
      .at(-1);
    const completedAction = consumedAction
      ? {
        playerAction: consumedAction,
        actionResult: contract.beats[selectedCompletionIndex ?? finalIndex]?.resultingState ?? "",
      }
      : undefined;
    const completedNavigationEvent = completedSourceEventId
      ? (completedSourceEventId === target.eventId
        ? target
        : candidate.storyEvents?.find((event) => event.eventId === completedSourceEventId) ?? null)
      : null;
    const eventReviewTargetId = sourceEventProgress?.eventId
      ?? nextDecisionEventId
      ?? completedSourceEventId
      ?? contract.eventId!;

    const choices = await this.buildAndReviewSceneChoices({
      setting,
      choiceReviewState: choiceState,
      sourceCandidates,
      consumedAction,
      completedSourceEventId,
      reviewedUnavailableCharacters: [...result.unavailable, ...(setting.peopleKilledInScene ?? [])],
      completedAction,
      embeddedChoices: undefined,
      state,
      reviewSourceCandidate: candidate,
      reviewedVisibleEvent: completedNavigationEvent,
      eventReviewTargetId,
      isFinalObservedProgressionAttempt: false,
      attempt: 0,
      maxAttempts: 1,
      skipSemanticChoiceReview: true,
    });
    if (choices.choiceValidationFailures.length) throw new SceneGenerationError(choices.choiceValidationFailures, 1);

    flowDiagnostic('Canonical scene accepted source beat progress: ' + JSON.stringify({
      event_id: contract.eventId,
      previous_completed_beat_indexes: contract.completedBeatIndexes,
      completed_flat_beat_indexes: result.completedBeatIndexes,
      completed_event_ids: acceptedWindow.completedEventIds,
      source_event_progress: sourceEventProgress,
      crossed_event_boundary: crossedEventBoundary,
      next_player_decision: nextDecisionOrigin,
      review_mode: result.review ? 'single' : 'disabled',
    }));

    // A partial final event keeps event-scoped progress authoritative. When every
    // batched event is complete, advancing to the last completed event lets the
    // normal cursor normalizer derive the exact source end from its references.
    const completedEvent = completedSourceEventId
      ? windowEvents.find((event) => event.eventId === completedSourceEventId)
      : undefined;
    const sourceProgress = completedEvent && !acceptedWindow.sourceEventProgress
      ? {
        chapterPosition: completedEvent.chapterPosition ?? target.chapterPosition,
        textOffset: candidate.nextTextOffset,
        eventId: completedSourceEventId!,
      }
      : undefined;

    return {
      ...normalizeSceneTalkChoices(choices.anchorOrderedScene),
      storyMemory,
      sourceEventProgress,
      ...(sourceProgress ? {sourceProgress} : {}),
    };
  }

  protected async scene(
    instruction: string,
    state: GameState,
    consumedAction?: string,
    sourceCandidates: readonly SourceContinuationCandidate[] = [],
    maxAttempts = 4,
    mode: SceneGenerationMode = "interactive_turn",
    requiredSourceEvent = false,
    choiceStakes?: ChoiceStakes,
    sourceBeatSelection?: import("../../shared/contracts.js").SourceBeatSelection,
  ): Promise<GeneratedScene> {
    const planned = currentTurnExecution()?.contract;
    if (this.centralReviewValidation && planned && canonicalBeatSceneEligible(planned)) {
      return this.canonicalScene(state, consumedAction, sourceCandidates, mode);
    }
    if (this.centralReviewValidation && planned?.sourceProgression === 'required') {
      const indexes = [...planned.allowedPlayerBeatIndexes, ...planned.requiredAutomaticBeatIndexes];
      const reason = indexes.length === 0 && planned.nextPlayerDecision !== null
        ? 'Canonical progression is already at a player decision boundary; no scene may be generated before that choice is selected.'
        : 'Required canonical progression has no valid staged execution window. Indexed resulting states and a pinned canonical route are required.';
      throw new SceneGenerationError([reason], 1);
    }
    const stagnating = isGameStagnating(state);
    let anchorRecoveryRequired = stagnating;
    let anchorChoiceRequired = false;
    const applyStagnationBreak = (
      candidateInstruction: string,
      forceReanchor = false,
    ): string => {
      anchorRecoveryRequired ||= forceReanchor;
      const recoveryInstruction = anchorRecoveryRequired
        ? buildStagnationBreakingInstruction(
          candidateInstruction,
          sourceCandidates.length > 0,
        )
        : candidateInstruction;
      return anchorChoiceRequired
        ? buildAnchorChoiceInstruction(
          recoveryInstruction,
          sourceCandidates.length > 0,
        )
        : recoveryInstruction;
    };
    let turnInstruction = applyStagnationBreak(instruction);
    const {
      sourceBeatNavigationEvent,
      sourceBeatProgress,
      openingNextRequiredBeatIsPlayerChoice,
      openingFirstPlayerBeatOffset,
      openingFirstPlayerBeatIndex,
      openingWordBudget,
      requiredSourceBeatProgress,
      requiredSourceBeatIndex,
      gameContext,
      playerPerspective,
      writingSystemReference,
      immediateTurnTransition,
      isWorldEventTurn,
      shouldReviewSemanticContinuity,
      sceneSchema,
      sceneStyleRules,
      turnReasoningEffort,
    } = prepareSceneGeneration(
      state,
      sourceCandidates,
      mode,
      requiredSourceEvent,
      choiceStakes,
      this.reasoningEffort,
    );
    let maxOutputTokens = mode === "observed_scene_progression" ? 2_200 : 1_600;
    let lastValidationFailures: string[] = [];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const isFinalObservedProgressionAttempt =
        mode === "observed_scene_progression" && attempt === maxAttempts - 1;
      const response = await this.createResponse(
        "scene",
        state.book.bookId,
        buildSceneRequest({
          attempt,
          turnReasoningEffort,
          model: this.model,
          mode,
          openingWordBudget,
          isWorldEventTurn,
          requiredSourceEvent,
          requiredSourceBeatProgress,
          openingFirstPlayerBeatOffset,
          openingNextRequiredBeatIsPlayerChoice,
          sourceCandidates,
          sceneStyleRules,
          turnInstruction,
          immediateTurnTransition,
          playerPerspective,
          gameContext,
          sceneSchema,
          maxOutputTokens,
        }),
      );
      if (response.status === "incomplete") {
        const details = JSON.stringify(response.incomplete_details) ?? "no details";
        const failure = `AI scene response was incomplete: ${details}`;
        if (!details.includes("max_output_tokens")) {
          throw new Error(failure);
        }
        lastValidationFailures = [failure];
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${failure}`,
        );
        maxOutputTokens *= 2;
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            instruction,
            consumedAction,
            lastValidationFailures,
          ),
        );
        continue;
      }
      let output: SceneDraftOutput;
      try {
        output = parseAiJson<SceneDraftOutput>(
          response.output_text,
          "OpenAI scene",
        );
      } catch (error) {
        if (!(error instanceof InvalidAiJsonError)) throw error;
        lastValidationFailures = [error.message];
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${error.message}`,
        );
        maxOutputTokens *= 2;
        const regenerationInstruction = buildSceneRegenerationInstruction(
          instruction,
          consumedAction,
          lastValidationFailures,
        );
        turnInstruction = applyStagnationBreak(regenerationInstruction);
        continue;
      }
      const validation = await this.validateSceneDraft({
        output,
        state,
        consumedAction,
        sourceCandidates,
        requiredSourceEvent,
        isWorldEventTurn,
        attempt,
        maxAttempts,
        openingWordBudget,
        mode,
        stagnating,
        isFinalObservedProgressionAttempt,
        writingSystemReference,
        sourceBeatNavigationEvent,
        requiredSourceBeatProgress,
        shouldReviewSemanticContinuity,
      });
      if (!validation.accepted) {
        lastValidationFailures = validation.validationFailures;
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${validation.validationFailures.join(" ")}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            instruction,
            consumedAction,
            validation.validationFailures,
          ),
          validation.forceReanchor,
        );
        continue;
      }
      const {
        storyMemory,
        embeddedChoices,
        resolvedPlayerAction,
        completedAction,
        proposedSetting,
        proposedSceneScope,
        reviewedUnavailableCharacters,
        semanticRepeat,
        repetitionReview,
        sourceCandidate,
        reviewSourceCandidate,
      } = validation;
      const {
        setting,
        presenceReview,
        eventReviewTargetId,
        reviewedVisibleEvent,
        reviewedSourceEventProgress,
        choiceReviewState,
        openingProgressEvent,
        completedSourceEventId,
        presenceValidationFailures,
        verifiedSourceCandidate,
      } = await this.reviewSceneProgress({
        state,
        proposedSetting,
        proposedSceneScope,
        resolvedPlayerAction,
        reviewedUnavailableCharacters,
        sourceCandidates,
        sourceBeatNavigationEvent,
        mode,
        sourceBeatProgress,
        openingFirstPlayerBeatIndex,
        openingFirstPlayerBeatOffset,
        requiredSourceBeatProgress,
        requiredSourceBeatIndex,
        semanticRepeat,
        repetitionReview,
        sourceCandidate,
        reviewSourceCandidate,
        requiredSourceEvent,
      });
      if (presenceValidationFailures.length > 0) {
        lastValidationFailures = presenceValidationFailures;
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${presenceValidationFailures.join(" ")}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            instruction,
            consumedAction,
            presenceValidationFailures,
          ),
        );
        continue;
      }
      const {
        generatedChoices,
        scene,
        anchorOrderedScene,
        choiceValidationFailures,
        hasInsufficientChoices,
        anchorChoiceWasFiltered,
      } = await this.buildAndReviewSceneChoices({
        setting,
        choiceReviewState,
        sourceCandidates,
        consumedAction,
        completedSourceEventId,
        reviewedUnavailableCharacters: [...reviewedUnavailableCharacters, ...(setting.peopleKilledInScene ?? [])],
        completedAction,
        embeddedChoices,
        state,
        reviewSourceCandidate,
        reviewedVisibleEvent,
        eventReviewTargetId,
        isFinalObservedProgressionAttempt,
        attempt,
        maxAttempts,
      });
      lastValidationFailures = choiceValidationFailures;
      if (choiceValidationFailures.length === 0) {
        if (eventReviewTargetId) {
          flowDiagnostic(
            "OpenAI scene accepted source beat progress: "
            + JSON.stringify({
              event_id: eventReviewTargetId,
              previous_completed_beat_indexes:
                state.sourceEventProgress?.eventId === eventReviewTargetId
                  ? state.sourceEventProgress.completedBeatIndexes
                  : [],
              completed_beat_indexes: presenceReview.completedSourceEventBeatIndexes,
              event_completed: reviewedSourceEventProgress === null,
              source_event_progress: reviewedSourceEventProgress ?? null,
            }),
          );
        }
        const openingCursor = state.sourceCursor;
        const sourceProgress = openingProgressEvent
          ? {
            chapterPosition: openingProgressEvent.chapterPosition,
            textOffset:
              openingCursor?.chapterPosition === openingProgressEvent.chapterPosition
                ? openingCursor.textOffset
                : sourceCandidates[0]?.nextTextOffset ?? 0,
            eventId: openingProgressEvent.eventId,
          }
          : verifiedSourceCandidate
            ? groundedSourceProgress(verifiedSourceCandidate)
            : undefined;
        return {
          ...normalizeSceneTalkChoices(anchorOrderedScene),
          ...(storyMemory ? { storyMemory } : {}),
          ...(sourceProgress ? { sourceProgress } : {}),
          ...(reviewedSourceEventProgress !== undefined
            ? { sourceEventProgress: reviewedSourceEventProgress }
            : {}),
        };
      }

      const usableChoiceIds = new Set(scene.choices.map((choice) => choice.id));
      const rejectedChoices = generatedChoices
        .filter((choice) => !usableChoiceIds.has(choice.id))
        .map((choice) => choice.text);
      flowDiagnostic(
        `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${choiceValidationFailures.join(" ")}`,
      );
      const regenerationInstruction = buildSceneRegenerationInstruction(
        instruction,
        consumedAction,
        choiceValidationFailures,
        rejectedChoices,
      );
      anchorChoiceRequired ||= hasInsufficientChoices || anchorChoiceWasFiltered;
      turnInstruction = applyStagnationBreak(
        regenerationInstruction,
        false,
      );
    }

    throw new SceneGenerationError(lastValidationFailures, maxAttempts);
  }
}

