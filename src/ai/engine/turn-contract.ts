import { playerActionAt } from "../../shared/player-actions.js";
import type { PlayerAction } from "../../shared/contracts.js";
import { buildCharacterRuntimeState, boundCharacterProfilePayload } from "./character-runtime.js";
import { sourceReferenceKey } from "../../books/source-index/chapter-index.js";
import { completeSourceSentences } from "./opening-source-evidence.js";
import { renderTurnScript } from "./turn-script.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { GameState, StoryEventBeat } from "../../shared/contracts.js";
import { worldRulesForGame } from "../../shared/world-rules.js";
import { findPlayerCharacterProfile } from "./player.js";
import { expandCrossEventWindow, type SourceEventEntryMap, type TurnBeatOrigin, type TurnWindowEvent } from "./cross-event-window.js";
export interface TurnContract {
  readonly version: 1;
  readonly sourceBeatSelection?: Readonly<import("../../shared/contracts.js").SourceBeatSelection>;
  readonly selectedPlayerAction?: Readonly<PlayerAction>;
  readonly nextPlayerAction?: Readonly<PlayerAction>;
  /** Turn counter for diagnostics; durable concurrency is enforced by the repository ETag. */
  readonly turnNumber: number;
  readonly mode: "opening" | "action" | "dialogue" | "observe" | "source_continue";
  readonly player: string;
  readonly playerAliases: readonly string[];
  readonly selectedIntent: string | null;
  readonly worldRules: readonly string[];
  readonly sourceProgression: "required" | "optional";
  readonly contextJson: string;
  readonly sourceEvidence: Readonly<Record<number, string>>;
  readonly eventId: string | null;
  /** Turn-local flat indexes map back to their persisted event-local source beats here. */
  readonly beatOrigins?: readonly Readonly<TurnBeatOrigin>[];
  readonly nextPlayerDecisionOrigin?: Readonly<TurnBeatOrigin> | null;
  readonly startBeatIndex?: number;
  readonly completedBeatIndexes: readonly number[];
  readonly allowedPlayerBeatIndexes: readonly number[];
  readonly requiredAutomaticBeatIndexes: readonly number[];
  readonly nextPlayerDecision: number | null;
  readonly beats: readonly Readonly<StoryEventBeat>[];
}
import { playerControlsBeat } from "../../shared/turn-policy.js";
export { playerControlsBeat } from "../../shared/turn-policy.js";
/** Conservative source authorization. Similar words alone do not authorize another act.
 * Synonyms that cannot be established deterministically stay subject to scene review.
 */
export function selectedIntentMatchesBeat(intent: string, action: string): boolean {
  const normalize = (value: string) => (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token, index) => !(index === 0 && token === "i"))
    .map(token => token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token)
    .join(" ");
  return Boolean(normalize(intent)) && normalize(intent) === normalize(action);
}
export function planTurn(input: {
  state: Pick<GameState, "playerName" | "characterProfiles" | "parameters" | "worldRules" | "turnNumber" | "sourceEventProgress"> & Partial<Pick<GameState, "scene" | "history" | "storyMemory" | "playerActionVersion">>;
  mode: TurnContract["mode"];
  selectedIntent?: string;
  sourceBeatSelection?: import("../../shared/contracts.js").SourceBeatSelection;
  currentEventSequence?: number | null;
  sourceProgression?: "required" | "optional";
  sourceReferenceExcerpts?: Readonly<Record<string, string>>;
  /** Validated semantic intent review; only a contiguous immediate player prefix is eligible. */
  reviewedSelectedPrefixLength?: number;
  /** Semantic review can authorize only the validated first pending indexed goal. */
  reviewedPlayerAction?: boolean;
  event?: TurnWindowEvent | null;
  /** Ordered source lookahead used only to extend a required canonical window across direct event boundaries. */
  followingEvents?: readonly TurnWindowEvent[];
  /** Source-backed gaps are hard batching boundaries and retain the existing entry/continuation path. */
  sourceEventEntries?: SourceEventEntryMap;
}): TurnContract {
  const { state, mode, event } = input;
  const sourceProgression = mode === "opening" ? "required" : input.sourceProgression ?? "required";
  const profile = findPlayerCharacterProfile(state.playerName, state.characterProfiles);
  const aliases = [...new Set([state.playerName, ...(profile ? [profile.name, ...profile.aliases] : [])])];
  const expandedWindow = expandCrossEventWindow({
    event,
    followingEvents: input.followingEvents,
    sourceEventEntries: input.sourceEventEntries,
    playerAliases: aliases,
    // Optimize only pinned canonical actions and automatic source continuation.
    // Openings/free text keep their established event-local boundaries.
    allowCrossEvent: sourceProgression === "required"
      && (Boolean(input.sourceBeatSelection) || mode === "source_continue"),
  });
  const beats = expandedWindow.beats;
  const beatOrigins = expandedWindow.beatOrigins;
  const completed = Boolean(event?.eventId) && state.sourceEventProgress?.eventId === event?.eventId
    ? [...state.sourceEventProgress!.completedBeatIndexes] : [];
  const startBeatIndex = state.sourceEventProgress?.eventId === event?.eventId ? state.sourceEventProgress?.startBeatIndex ?? 0 : 0;
  if (!Number.isInteger(startBeatIndex) || startBeatIndex < 0 || (startBeatIndex > 0 && startBeatIndex >= beats.length))
    throw new TurnExecutionError("review_unavailable", "Invalid source event start boundary.");
  const intent = mode === "opening" || mode === "observe" ? null : input.selectedIntent?.trim() || null;
  const allowed: number[] = [];
  const automatic: number[] = [];
  let nextPlayerDecision: number | null = null;
  const selectedPrefix: number[] = [];
  const candidatePrefix: number[] = [];
  // One explicitly selected compound action may cover adjacent player beats only.
  for (let index = startBeatIndex; index < beats.length; index++) {
    if (completed.includes(index))
      continue;
    if (!playerControlsBeat(beats[index]!, aliases))
      break;
    candidatePrefix.push(index);
    if (intent && selectedIntentMatchesBeat(intent, candidatePrefix.map(i => beats[i]!.action).join(" and "))) {
      selectedPrefix.splice(0, selectedPrefix.length, ...candidatePrefix);
    }
  }
  if (input.reviewedSelectedPrefixLength !== undefined) {
    const count = input.reviewedSelectedPrefixLength;
    if (!intent || !Number.isInteger(count) || count < 0 || count > candidatePrefix.length) {
      throw new TurnExecutionError("review_unavailable", "Intent review returned an invalid authorization window.");
    }
    selectedPrefix.splice(0, selectedPrefix.length, ...candidatePrefix.slice(0, count));
  }
  const firstPending = beats.findIndex((_, i) => i >= startBeatIndex && !completed.includes(i));
  const selection = input.sourceBeatSelection;
  const firstPlayer = beats.findIndex((beat, i) => i >= startBeatIndex && !completed.includes(i) && playerControlsBeat(beat, aliases));
  if (selection && (mode !== "action" || sourceProgression !== "required" || !intent
    || selection.eventId !== event?.eventId || !Number.isInteger(selection.beatIndex)
    || selection.beatIndex !== firstPlayer || firstPlayer < 0)) {
    throw new TurnExecutionError("review_unavailable", "The saved anchor selection no longer matches the next player beat.");
  }
  const actionGroup = state.playerActionVersion === 2 && sourceProgression === "required"
    ? playerActionAt(beats, selection ? firstPlayer : firstPending, aliases) : undefined;
  if (selection) {
    const expectedKind = actionGroup ? "player_action" : "beat";
    const expectedEnd = actionGroup?.endBeatIndex ?? firstPlayer;
    if (selection.kind !== expectedKind || selection.endBeatIndex !== expectedEnd
      || selection.actionId !== actionGroup?.id
      || (actionGroup?.id && JSON.stringify(selection.playerBeatIndexes) !== JSON.stringify(actionGroup.playerBeatIndexes))) {
      throw new TurnExecutionError("review_unavailable", "The saved anchor action window changed.");
    }
    selectedPrefix.splice(0, selectedPrefix.length, firstPlayer);
  }
  // Exact full-goal input is explicit consent. Narrow inputs retain the legacy boundary.
  const selectedPlayerAction = (mode === "action" || mode === "dialogue") && intent && actionGroup
    && (Boolean(selection) || intent.trim() === actionGroup.choiceText || input.reviewedPlayerAction === true) ? actionGroup : undefined;
  if (input.reviewedPlayerAction && !selectedPlayerAction) throw new TurnExecutionError("review_unavailable", "Intent review cannot authorize a missing or ineligible player goal.");
  let crossedAutomaticBoundary = false;
  for (let index = startBeatIndex; index < beats.length; index++) {
    if (completed.includes(index))
      continue;
    const beat = beats[index]!;
    if (playerControlsBeat(beat, aliases)) {
      // This maps an explicit input to a source beat; it never credits completion.
      // Only the explicit indexed player goal can span an automatic boundary.
      if (selectedPlayerAction?.playerBeatIndexes.includes(index) || (!selectedPlayerAction && (Boolean(selection) || !crossedAutomaticBoundary) && selectedPrefix.includes(index)))
        allowed.push(index);
      else {
        nextPlayerDecision = index;
        break;
      }
    }
    else {
      // End the pilot precisely at goal completion, without unrelated automatic epilogues.
      if (!selection && selectedPlayerAction && index > selectedPlayerAction.endBeatIndex) break;
      if (sourceProgression === "required") automatic.push(index);
      crossedAutomaticBoundary = true;
    }
  }
  const nextPlayerAction = state.playerActionVersion === 2 && sourceProgression === "required"
    ? playerActionAt(beats, nextPlayerDecision, aliases) : undefined;
  for (const action of [selectedPlayerAction, nextPlayerAction]) if (action) {
    Object.freeze(action.playerBeatIndexes); Object.freeze(action.preconditions); Object.freeze(action.interruptWhen); Object.freeze(action);
  }
  const sourceEvidence: Record<number, string> = {};
  for (const index of [...allowed, ...automatic]) {
    const excerpts = [...new Set((beats[index]!.sourceReferences ?? []).map(sourceReferenceKey))]
      .flatMap(key => input.sourceReferenceExcerpts?.[key] ? [input.sourceReferenceExcerpts[key]!] : []);
    sourceEvidence[index] = excerpts.map(completeSourceSentences).filter(Boolean).join("\n\n");
  }
  const characterRuntime = buildCharacterRuntimeState(state, input.currentEventSequence ?? null);
  const contextJson = JSON.stringify({
    character_runtime: characterRuntime,
    current_scene: state.scene ? {title: state.scene.title, text: state.scene.text, sceneScope: state.scene.sceneScope} : null,
    recent_history: (state.history ?? []).slice(-3), story_memory: state.storyMemory ?? null,
    player_profile: mode === "opening" ? {name: profile?.name ?? state.playerName, aliases}
      : profile ? JSON.parse(boundCharacterProfilePayload(JSON.stringify(profile), characterRuntime)) : {name: state.playerName, aliases},
  });
  for (const origin of beatOrigins) Object.freeze(origin);
  Object.freeze(beatOrigins);
  for (const beat of beats) {
    if (beat.targets)
      Object.freeze(beat.targets);
    if (beat.sourceReferences) {
      beat.sourceReferences.forEach(Object.freeze);
      Object.freeze(beat.sourceReferences);
    }
    for (const action of [beat.playerAction, beat.characterActionGroup]) if (action) {
      Object.freeze(action.playerBeatIndexes); Object.freeze(action.preconditions);
      Object.freeze(action.interruptWhen); Object.freeze(action);
    }
    Object.freeze(beat);
  }
  return Object.freeze({ version: 1, sourceBeatSelection: selection ? Object.freeze({...selection, ...(selection.playerBeatIndexes ? {playerBeatIndexes: Object.freeze([...selection.playerBeatIndexes])} : {})}) : undefined, selectedPlayerAction, nextPlayerAction, sourceProgression, contextJson, sourceEvidence: Object.freeze(sourceEvidence), turnNumber: state.turnNumber ?? 0, mode, player: state.playerName,
    playerAliases: Object.freeze(aliases), selectedIntent: intent, worldRules: Object.freeze([...worldRulesForGame(state)]),
    eventId: event?.eventId ?? null, beatOrigins,
    nextPlayerDecisionOrigin: nextPlayerDecision === null ? null : beatOrigins[nextPlayerDecision] ?? null,
    startBeatIndex, completedBeatIndexes: Object.freeze(completed),
    allowedPlayerBeatIndexes: Object.freeze(allowed), requiredAutomaticBeatIndexes: Object.freeze(automatic),
    nextPlayerDecision, beats: Object.freeze(beats) });
}
export class TurnExecutionError extends Error {
  constructor(readonly code: "budget_exhausted" | "world_rule_violation" | "review_unavailable", message: string) {
    super(message);
    this.name = "TurnExecutionError";
  }
}
export class TurnBudget {
  calls = 0;
  reservedOutputTokens = 0;
  private readonly started = Date.now();
  constructor(readonly maxCalls = 48, readonly maxOutputTokens = 120000, readonly maxDurationMs = 300000) { }
  canReserve(calls: number, tokens: number): boolean {
    return this.calls + calls <= this.maxCalls && this.reservedOutputTokens + tokens <= this.maxOutputTokens
      && Date.now() - this.started < this.maxDurationMs;
  }
  reserve(tokens: number) {
    if (this.calls >= this.maxCalls || this.reservedOutputTokens + tokens > this.maxOutputTokens
      || Date.now() - this.started >= this.maxDurationMs) {
      throw new TurnExecutionError("budget_exhausted", "This turn exhausted its generation/review budget. No rejected draft was accepted.");
    }
    this.calls++;
    this.reservedOutputTokens += tokens;
  }
}
export interface TurnExecution {
  readonly contract: TurnContract;
  readonly budget: TurnBudget;
}
const execution = new AsyncLocalStorage<TurnExecution>();
const budgets = new AsyncLocalStorage<TurnBudget>();
export const currentTurnBudget = () => execution.getStore()?.budget ?? budgets.getStore();
export function runWithTurnBudget<T>(work: () => Promise<T>, budget = currentTurnBudget() ?? new TurnBudget()): Promise<T> {
  return budgets.run(budget, work);
}
export const currentTurnExecution = () => execution.getStore();
export function runPlannedTurn<T>(contract: TurnContract, work: () => Promise<T>, budget = currentTurnBudget() ?? new TurnBudget()): Promise<T> {
  return execution.run({ contract, budget }, work);
}
/** One bounded script, rendered after legacy adapters for both writing and review. */
export function turnContractInstructions(contract: TurnContract, includeSourceEvidence = true): string {
  return [
    "TURN CONTRACT (authoritative authorization; do not expose to the player):",
    JSON.stringify({ mode: contract.mode, player: contract.player, selected_intent: contract.sourceBeatSelection ? contract.selectedPlayerAction?.completion ?? contract.beats[contract.sourceBeatSelection.beatIndex]?.action : contract.selectedIntent, selected_choice_value: contract.sourceBeatSelection ?? null, active_world_rules: contract.worldRules,
      allowed_player_beat_indexes: contract.allowedPlayerBeatIndexes,
      required_automatic_beat_indexes: contract.requiredAutomaticBeatIndexes,
      next_unselected_player_beat_index: contract.nextPlayerDecision }),
    renderTurnScript(contract, includeSourceEvidence),
    "Never report a forbidden visible action as absent. Report the evidence; the validator separates observed actions from authorized progress.",
    "If required automatic progress is missing, the turn needs automatic continuation or scene repair; it is not a fully accepted player decision boundary.",
  ].join("\n");
}
