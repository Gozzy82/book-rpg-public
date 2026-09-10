export {
  MAX_STARTING_CHARACTER_OPTIONS,
  PlayerUnavailableError,
  canonicalStartCharacters,
  isIndividualStartingCharacter,
  startingCharacterOptions,
  canonicalPlayerStartAvailability,
  canonicalGameStartContext,
} from "./service/game-start.js";
export {
  explicitPlayerChoiceRequiredNotice,
  storyContinuationUnavailableNotice,
  resolveFreeAction,
  isAnchorDirectedChoice,
  resolveEventText,
  eventGenerationFailureScene,
  // Legacy compatibility exports. New code should use world-rules.ts.
  resolveParameterText,
  appendGameParameter,
} from "./service/turn-input.js";
export {
  MAX_BOOKRPG_WORLD_RULES,
  appendWorldRule,
  visibleWorldRules,
  listWorldRules,
  addWorldRule,
  removeWorldRule,
} from "./service/world-rules.js";
export type {
  AddWorldRuleRequest,
  WorldRulesResponse,
} from "./service/world-rules.js";
export {
  titleForTurn,
  summarizeGames,
  listSavedGames,
  resumeGame,
} from "./service/game-state.js";
export {
  sourceIntroducedCharactersAtCursor,
  normalizeSourceProgress,
  missingPresentSourceEventCharacters,
  refreshCanonicalFirstChoice,
  buildSourceContinuationCandidates,
  buildSourceRecoveryCandidates,
  buildFutureSourceCandidates,
  buildSourceAnchorCandidates,
  buildSourceContextCandidates,
  buildCanonicalNextEventCandidate,
  buildSceneRecoveryCandidates,
  alignRecoveryCandidateToCursor,
  selectGroundedSourceCandidates,
  sourceCandidateForEvent,
  attemptSourceContinuation,
} from "./service/source-candidates.js";
export {
  startGame,
  continueFromSource,
  undoLastChoice,
  makeChoice,
  continueScene,
  initiateEvent,
  // Legacy compatibility endpoint only.
  setParameter,
  say,
} from "./service/operations.js";
