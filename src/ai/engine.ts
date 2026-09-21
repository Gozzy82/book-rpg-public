import { FakeGameEngine } from "./engine/fake-game-engine.js";
import type { GameEngine } from "./engine/core.js";
import { TurnPipelineGameEngine } from "./engine/turn-pipeline-engine.js";
export { TurnPipelineGameEngine } from "./engine/turn-pipeline-engine.js";

export {
  InvalidAiJsonError,
  SceneGenerationError,
  parseAiJson,
} from "./engine/core.js";
export type {
  PlayerAvailability,
  GameEngine,
  GeneratedScene,
  ContinuationOptions,
  SourceContinuationCandidate,
  SourceContinuationResult,
} from "./engine/core.js";
export {
  COMPACT_SCENE_STYLE_RULES,
  OBSERVED_SCENE_PROGRESSION_STYLE_RULES,
  COMPACT_DIALOGUE_STYLE_RULES,
  PLAYER_EMBODIMENT_RULES,
  SOURCE_GROUNDING_RULES,
  FIRST_CHOICE_ANCHOR_RULES,
  CHOICE_TIMELINE_RULES,
  INFORMED_PLAYER_CHOICE_RULES,
  CHOICE_STAKES_RULES,
  TURN_SCOPE_RULES,
  SCENE_SCOPE_RULES,
  RUNTIME_PARAMETER_RULES,
  RUNTIME_PARAMETER_RULES as BOOKRPG_WORLD_RULE_RULES,
  STORY_MEMORY_RULES,
} from "./engine/rules.js";
export {
  stripEmbeddedChoiceMenu,
  normalizePlayerAvailability,
  normalizeEstablishedEvent,
  normalizeEstablishedEventAssessment,
} from "./engine/normalization.js";
export {
  choiceTextsAreSimilar,
  extractLeakedExternalDevelopment,
  stripLeakedSceneMetadata,
  sceneLeaksInternalMetadata,
} from "./engine/scene-text.js";
export {
  findPlayerCharacterProfile,
  buildPlayerPerspective,
} from "./engine/player.js";
export {
  visibleSourceEventNarrative,
  nextSignificantEventForCandidate,
  sourceEventPlayerChoiceBeats,
  sourceEventNextPlayerChoiceBeats,
  buildRequiredPlayerChoiceFallback,
  sourceEventRequiresExplicitPlayerChoice,
  sourceEventHasReliableNonPlayerActors,
  sourceEventCanOccurWithoutPlayerChoice,
  selectedAnchorRequiresSourceEvent,
  buildSourceChoiceNavigationContext,
  buildSourceEventBeatProgressContext,
  normalizeCompletedSourceEventBeatIndexes,
  reviewedSourceEventIdForBeatProgress,
  reviewedVisibleSourceEvent,
} from "./engine/source-navigation.js";
export type {
  SourceChoiceNavigationEvent,
  SourceChoiceNavigationContext,
  SourceEventBeatProgressContext,
} from "./engine/source-navigation.js";
export {
  buildSourceEventBlocks,
  resolveGroundedSourceCandidate,
  resolveSourceContinuationSelection,
  resolveRecoveryChapterSelection,
  buildSourceContinuationInstruction,
  buildSceneContinuationInstruction,
  configuredReasoningEffort,
  reasoningEffortForTurn,
  buildEventContinuationInstruction,
  buildActionContinuationInstruction,
  buildAnchorRouteContinuationInstruction,
  buildRequiredSourceRecoveryInstruction,
} from "./engine/source.js";
export {
  openingCharacterContinuityFailures,
  buildImmediateTurnTransition,
  isGameStagnating,
  buildStagnationBreakingInstruction,
  buildAnchorChoiceInstruction,
} from "./engine/turn.js";
export type {
  ImmediateTurnTransition,
} from "./engine/turn.js";
export {
  removeDuplicateChoices,
  removeRecentChoiceParaphrases,
  sceneRepeatsConsumedAction,
  choiceParaphrasesConsumedAction,
  removeConsumedActionChoices,
  removeChoicesRepeatingCompletedSourceEvent,
  actionResolutionFailures,
  hasTooFewChoicesForActiveScene,
  sceneScopeFailures,
  filterSceneScope,
  sceneScopeOrFallback,
  hasSourceContinuationChoiceFallback,
  sourceContinuationChoiceText,
  addSourceContinuationChoiceFallback,
  addSourceContinuationAnchorChoice,
  firstChoiceWasFiltered,
  promoteAnchorChoice,
  shouldHandleMissingAnchorChoice,
  applyEstablishedEvent,
  developmentRepeatsHistory,
  removeChoicesWithPlayerIdentityReferences,
  filterSceneScopeForState,
  repairGeneratedChoices,
  removeChoicesWithUnintroducedCharacters,
} from "./engine/scene-validation.js";
export type {
  SceneScopeValidationContext,
} from "./engine/scene-validation.js";
export {
  sceneUsesUnexpectedWritingSystem,
  buildWritingSystemReference,
  sceneRepeatsCurrentNarrative,
  sceneRepeatsRecentNarrative,
  buildSceneRepetitionReviewContext,
  buildSceneRegenerationInstruction,
  buildDialogueContinuationInstruction,
  buildCanonBlock,
  buildGameContext,
  findPassageContext,
  sourceLineAtNormalizedOffset,
  buildPlayerAvailabilityContext,
  sourceActionsCompletedAtSelectedMoment,
} from "./engine/scene-context.js";
export {
  normalizeSceneTalkChoices,
  formatDialogueScene,
  dialogueAttributionFailures,
  dialogueChoiceStructureFailures,
} from "./engine/dialogue.js";
export {
  ProviderGameEngine,
} from "./engine/provider-game-engine.js";
export {
  BookRpgProviderGameEngine,
  bookRpgWorldRulesFromRequest,
  withBookRpgWorldRuleTerminology,
} from "./engine/provider-bookrpg-engine.js";
export {
  PacedBookRpgProviderGameEngine,
  withAutomaticFollowupWindow,
  withSemanticAutomaticBeatReview,
} from "./engine/provider-paced-bookrpg-engine.js";
export {
  GuardedPacedBookRpgProviderGameEngine,
  enforceAutomaticFollowupReview,
} from "./engine/provider-guarded-paced-bookrpg-engine.js";
export {
  E2eRecoveryBookRpgProviderGameEngine,
  withConcreteAutomaticSceneWindow,
  normalizeOpeningBoundaryRepetitionReview,
  enforceFirstPersonPlayerIdentity,
} from "./engine/provider-e2e-recovery-engine.js";
export {
  E2eHardeningBookRpgProviderGameEngine,
  relaxMissingAutomaticFollowupReview,
  withNonInteractableConsistencyContract,
  withOpeningBoundaryReviewContract,
  withOpeningProgressReviewContract,
} from "./engine/provider-e2e-hardening-engine.js";

export function createGameEngine(): GameEngine {
  if (process.env.BOOKRPG_FAKE_AI === "1") return new FakeGameEngine();
  return new TurnPipelineGameEngine();
}

