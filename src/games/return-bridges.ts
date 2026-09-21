import {worldRulesForGame} from '../shared/world-rules.js';
import {createHash, randomUUID} from 'node:crypto';
import type {GameState, ImportedBook, SourceBeatSelection} from '../shared/contracts.js';

export interface ReturnBridge {
  id: string;
  eventId: string;
  targetBeatIndex?: number;
  reentryStartBeatIndex?: number;
  selectionReason?: string;
  obsoleteEvidence?: string[];
  sourceBeatSelection?: SourceBeatSelection;
  /** Automatic/NPC source beats that must be played canonically before the target player action.
   * These beats are reserved: free-world lead-in prose must not perform them. */
  canonicalPrelude?: {
    eventId: string;
    startBeatIndex: number;
    targetEventId: string;
    targetBeatIndex: number;
    beats: Array<{eventId: string; beatIndex: number; actor: string | null; action: string}>;
  };
  /** Cached source action and readiness conditions; absent on legacy plans. */
  target?: {action: string; resultingState: string; requiredSituation: string};
  originProgress?: string;
  departureLocation?: string;
  steps?: Array<{action: string; location: string; scene: string}>;
  /** Optional source-grounded mini-story that can be woven into a future free scene.
   * Legacy persisted plans may omit this and fall back to setup. */
  leadIn?: string;
  setup: string;
  choiceText: string;
  locationTerms: string[];
  presentCharacters: string[];
  availableCharacters: string[];
  indexVersion: string;
  originCursor: string;
  rulesVersion: string;
  createdAt: number;
  expiresAt: number;
  status: 'ready' | 'offered' | 'used' | 'retired';
}
export function bridgeBeatSelection(bridge: ReturnBridge): SourceBeatSelection {
  return bridge.sourceBeatSelection ?? {kind:'beat', eventId:bridge.eventId,
    beatIndex:bridge.targetBeatIndex!, endBeatIndex:bridge.targetBeatIndex!};
}
/** A new entry boundary never credits skipped beats as completed. Call only on an execution draft. */
export function applyBridgeEntry(game: GameState, bridge: ReturnBridge): void {
  const entryEventId = bridge.canonicalPrelude?.eventId ?? bridge.eventId;
  const entryBeatIndex = bridge.canonicalPrelude?.startBeatIndex ?? bridge.reentryStartBeatIndex;
  if (entryBeatIndex === undefined) return;
  const previous = game.sourceEventProgress;
  game.sourceEventProgress = {eventId:entryEventId, startBeatIndex:entryBeatIndex,
    completedBeatIndexes:previous?.eventId === entryEventId ? [...previous.completedBeatIndexes] : []};
}
export interface InvalidatedSourceTarget {
  eventId: string;
  beatIndex: number;
  endBeatIndex: number;
  indexVersion: string;
  originCursor: string;
  evidence: string[];
  invalidatedAt: number;
}
export interface ReturnPlanning {
  activeBridgeId?: string;
  bridges: ReturnBridge[];
  /** Durable canonical player targets that free play must not route back to again. */
  invalidatedTargets?: InvalidatedSourceTarget[];
  /** Snapshot of only the dependencies used by our trigger matcher. */
  lastMatched?: string;
  generation: number;
  job?: {revision: number; dueAt: number; token?: string; leaseUntil?: number};
  retryAfter?: number;
  lastAttemptSituation?: string;
  lastAttemptStock?: string;
  failures?: number;
}
export const BRIDGE_TARGET = 3;
export const BRIDGE_REFILL_BELOW = 2;
export const BRIDGE_COOLDOWN_MS = 60_000;
export const BRIDGE_LIFETIME_MS = 24 * 60 * 60_000;
export const normalizeBridgeTerm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function storyCode(kind: 'scene' | 'event' | 'bridge', key: string): string {
  return `#brpg_${kind}_${digest(key).slice(0, 24)}`;
}
export function rulesVersion(game: GameState): string {
  return digest(worldRulesForGame(game));
}
export function bridgeSituation(game: GameState): string {
  return digest({scope: game.scene.sceneScope, deaths: game.confirmedDeadCharacters ?? [],
    rules: rulesVersion(game), index: game.sourceIndexFingerprint, cursor: game.sourceCursor,
    progress: game.sourceEventProgress, status: game.status});
}
function invalidationMatches(
  invalidation: InvalidatedSourceTarget,
  eventId: string,
  beatIndex: number,
  game: GameState,
): boolean {
  return invalidation.eventId === eventId
    && beatIndex >= invalidation.beatIndex
    && beatIndex <= invalidation.endBeatIndex
    && invalidation.indexVersion === (game.sourceIndexFingerprint ?? '')
    && invalidation.originCursor === digest(game.sourceCursor ?? null);
}
export function sourceTargetInvalidated(
  game: GameState,
  eventId: string,
  beatIndex: number,
): boolean {
  return (game.returnPlanning?.invalidatedTargets ?? [])
    .some(invalidation => invalidationMatches(invalidation, eventId, beatIndex, game));
}
export function invalidateSourceTarget(
  game: GameState,
  selection: SourceBeatSelection,
  evidence: readonly string[],
  now = Date.now(),
): void {
  const planning = game.returnPlanning ??= {bridges: [], generation: 0};
  const normalizedEvidence = [...new Set(evidence.map(item => item.trim()).filter(Boolean))];
  const marker: InvalidatedSourceTarget = {
    eventId: selection.eventId,
    beatIndex: selection.beatIndex,
    endBeatIndex: selection.endBeatIndex,
    indexVersion: game.sourceIndexFingerprint ?? '',
    originCursor: digest(game.sourceCursor ?? null),
    evidence: normalizedEvidence.length ? normalizedEvidence : ['Canonical target became irreversibly unavailable.'],
    invalidatedAt: now,
  };
  const existing = planning.invalidatedTargets?.find(item =>
    item.eventId === marker.eventId
    && item.beatIndex === marker.beatIndex
    && item.endBeatIndex === marker.endBeatIndex
    && item.indexVersion === marker.indexVersion
    && item.originCursor === marker.originCursor
  );
  if (existing) {
    existing.evidence = [...new Set([...existing.evidence, ...marker.evidence])];
    existing.invalidatedAt = now;
  } else {
    planning.invalidatedTargets = [...(planning.invalidatedTargets ?? []), marker].slice(-24);
  }
  for (const bridge of planning.bridges) {
    if (
      bridge.eventId === marker.eventId
      && bridge.targetBeatIndex !== undefined
      && bridge.targetBeatIndex >= marker.beatIndex
      && bridge.targetBeatIndex <= marker.endBeatIndex
    ) {
      bridge.status = 'retired';
      bridge.obsoleteEvidence = [...marker.evidence];
      if (planning.activeBridgeId === bridge.id) delete planning.activeBridgeId;
    }
  }
  planning.generation += 1;
  delete planning.job;
  delete planning.lastMatched;
  delete planning.lastAttemptSituation;
  delete planning.lastAttemptStock;
  delete planning.retryAfter;
}
export function bridgeStillPossible(bridge: ReturnBridge, game: GameState, now = Date.now()): boolean {
  const dead = new Set((game.confirmedDeadCharacters ?? []).map(normalizeBridgeTerm));
  return Boolean(bridge.target && bridge.departureLocation && bridge.selectionReason && Number.isInteger(bridge.targetBeatIndex)) && bridge.status === 'ready' && bridge.expiresAt > now
    && bridge.indexVersion === (game.sourceIndexFingerprint ?? '')
    && bridge.rulesVersion === rulesVersion(game)
    && bridge.originCursor === digest(game.sourceCursor ?? null)
    && !sourceTargetInvalidated(game, bridge.eventId, bridge.targetBeatIndex!)
    && !bridge.availableCharacters.some(name => dead.has(normalizeBridgeTerm(name)))
    && (bridge.originProgress === undefined || bridge.originProgress === digest(game.sourceEventProgress ?? null))
    && (game.sourceCursor?.eventId !== bridge.eventId
      || (game.sourceEventProgress?.eventId === bridge.eventId && bridge.targetBeatIndex !== undefined
        && bridge.targetBeatIndex >= (game.sourceEventProgress.startBeatIndex ?? 0)
        && !game.sourceEventProgress.completedBeatIndexes.includes(bridge.targetBeatIndex)));
}
export function matchesBridge(bridge: ReturnBridge, game: GameState): boolean {
  const location = ` ${normalizeBridgeTerm(game.scene.sceneScope?.currentLocation ?? '')} `;
  const present = new Set((game.scene.sceneScope?.peoplePresent ?? []).map(normalizeBridgeTerm));
  return bridgeStillPossible(bridge, game)
    && bridge.locationTerms.some(term => location.includes(` ${normalizeBridgeTerm(term)} `))
    && bridge.presentCharacters.every(name => present.has(normalizeBridgeTerm(name)));
}
/** Inventory changes can require refill even when the player stays in one place. */
export function bridgeStock(game: GameState, now = Date.now()): string {
  return digest((game.returnPlanning?.bridges ?? [])
    .filter(b => bridgeStillPossible(b, game, now))
    .map(b => b.id).sort());
}
/** Local matching also refreshes after scene changes: a free intermediate step may establish readiness. */
export function takeMatchingBridge(game: GameState): ReturnBridge | undefined {
  const planning = game.returnPlanning;
  if (!planning) return undefined;
  const active = planning.bridges.find(b => b.id === planning.activeBridgeId && bridgeStillPossible(b, game));
  if (active) return active;
  delete planning.activeBridgeId;
  const fingerprint = `${planning.generation}:${bridgeSituation(game)}:${digest(game.scene.text)}`;
  if (planning.lastMatched === fingerprint) return undefined;
  planning.lastMatched = fingerprint;
  return planning.bridges.find(bridge => matchesBridge(bridge, game));
}
/** Called atomically with gameplay saves; preserves a worker lease across new turns. */
export function updateReturnPlanning(game: GameState, now = Date.now()): void {
  const planning = game.returnPlanning ??= {bridges: [], generation: 0};
  for (const bridge of planning.bridges) {
    if (bridge.status === 'ready' && (!bridgeStillPossible(bridge, game, now)
      || (bridge.departureLocation && bridge.id !== planning.activeBridgeId
        && normalizeBridgeTerm(bridge.departureLocation) !== normalizeBridgeTerm(game.scene.sceneScope?.currentLocation ?? '')))) bridge.status = 'retired';
  }
  if (!planning.bridges.some(b => b.id === planning.activeBridgeId && (b.status === 'ready' || b.status === 'offered'))) delete planning.activeBridgeId;
  // Keep bounded history; references also live in immutable turn metadata.
  planning.bridges = [...planning.bridges.filter(b => b.status === 'ready' || b.status === 'offered'),
    ...planning.bridges.filter(b => b.status === 'retired' || b.status === 'used').slice(-12)];
  if (game.narrativeMode !== 'free' || game.status !== 'active') { delete planning.job; return; }
  if (planning.activeBridgeId) { delete planning.job; return; }
  if (planning.bridges.filter(b => bridgeStillPossible(b, game, now)).length >= BRIDGE_REFILL_BELOW) return;
  if (planning.lastAttemptSituation === bridgeSituation(game)
    && planning.lastAttemptStock === bridgeStock(game, now) && !planning.job) return;
  // Persist delayed work now, so the timer can refill even without another turn.
  planning.job = {...planning.job, revision: game.gameRevision ?? 0,
    dueAt: planning.job?.dueAt ?? Math.max(now + 1_000, planning.retryAfter ?? 0)};
}
export function newSceneCode(game: GameState): string {
  return storyCode('scene', `${game.gameId}:${randomUUID()}`);
}
export function exportStoryTrace(game: GameState, book: ImportedBook): string {
  const lines = ['BookRPG story trace — IDs are lookup metadata, not story prose.',
    `Book: ${book.title}`, `Game: ${game.gameId}`, `Player: ${game.playerName}`];
  for (const turn of game.turnHistory ?? []) lines.push('',
    `SCENE ${turn.storyCode ?? storyCode('scene', `${game.gameId}:${turn.completedAt}:${turn.turnNumber}`)}`,
    `Turn ${turn.turnNumber}; action: ${turn.action}`,
    ...(turn.bridgeId ? [`BRIDGE ${turn.bridgeId}`] : []),
    ...(turn.sourceEventId ? [`EVENT ${storyCode('event', `${book.bookId}:${turn.sourceEventId}`)} (${turn.sourceEventId})`] : []),
    turn.scene.title, turn.scene.text);
  // Index gives exact IDs and source descriptions without implying events happened in this save.
  lines.push('', 'CANONICAL LOOKUP — reference only; these events are NOT automatically completed.');
  for (const event of book.storyEvents ?? []) lines.push(
    `${storyCode('event', `${book.bookId}:${event.eventId}`)} (${event.eventId})`, event.description);
  return lines.join('\n');
}

/** Retire all alternatives for an irreversibly invalidated canonical target. */
export function retireObsoleteBridge(game: GameState, target: ReturnBridge, evidence: string[]): void {
  if (target.targetBeatIndex === undefined) return;
  invalidateSourceTarget(game, bridgeBeatSelection(target), evidence);
}
