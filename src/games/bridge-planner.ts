import {playerActionAt} from '../shared/player-actions.js';
import {withFlowTrace, traceEvent} from '../util/flow-trace.js';
import {findCharacterProfile} from '../shared/character-dynamics.js';
import {playerControlsBeat} from '../shared/turn-policy.js';
import {assertGameSourceVersion} from '../books/source-index/game-version.js';
import {randomUUID} from 'node:crypto';
import type {GameState, ImportedBook} from '../shared/contracts.js';
import {createAiClient, type AiClient} from '../ai/provider.js';
import {freeWorldContext, jsonRequest, readAiJson} from '../ai/free-world.js';
import {runAsUser} from '../auth/user-context.js';
import {getBook} from '../books/repository.js';
import {changeReturnPlanning, pendingReturnPlanningGames} from './repository.js';
import {BRIDGE_TARGET, BRIDGE_COOLDOWN_MS, BRIDGE_LIFETIME_MS, bridgeStillPossible,
  digest, bridgeSituation, bridgeStock, normalizeBridgeTerm, rulesVersion, sourceTargetInvalidated,
  storyCode, type ReturnBridge} from './return-bridges.js';

const text = {type: 'string'};
const texts = {type: 'array', items: text};
const schema = {type: 'object', additionalProperties: false, properties: {
  incompatibleReason: {type: ['string', 'null']},
  bridges: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {
    eventId: text, leadIn: text, setup: text, choiceText: text, requiredSituation: text, locationTerms: texts,
    presentCharacters: texts, availableCharacters: texts,
  }, required: ['eventId', 'leadIn', 'setup', 'choiceText', 'requiredSituation', 'locationTerms', 'presentCharacters', 'availableCharacters']}},
}, required: ['bridges', 'incompatibleReason']};
export function planningEvents(game: GameState, book: ImportedBook) {
  const events = [...(book.storyEvents ?? [])].sort((a,b) => a.sequence - b.sequence);
  const current = events.find(e => e.eventId === game.sourceCursor?.eventId);
  const progress = game.sourceEventProgress;
  const pending = events.find(e => e.eventId === progress?.eventId && e.beats?.some((_, i) =>
    i >= (progress?.startBeatIndex ?? 0) && !progress?.completedBeatIndexes.includes(i)));
  // Do not drop an entire event because one participant is unavailable. Durable
  // target invalidations are beat-local, so a later viable player beat in the
  // same event must remain eligible for a new return bridge.
  return events.filter(e =>
    e.eventId === pending?.eventId
    || (!pending && !current)
    || e.sequence > (pending ?? current)!.sequence
  );
}
export async function planReturnBridges(game: GameState, book: ImportedBook, client?: AiClient): Promise<ReturnBridge[]> {
  assertGameSourceVersion(game, book);
  const slots = BRIDGE_TARGET - (game.returnPlanning?.bridges.filter(b => bridgeStillPossible(b, game)).length ?? 0);
  const eligible = planningEvents(game, book);
  if (slots <= 0 || !eligible.length || (!client && process.env.BOOKRPG_FAKE_AI === '1')) return [];
  const progress = game.sourceEventProgress;
  const profile = findCharacterProfile(game.playerName, game.characterProfiles);
  const aliases = [game.playerName, ...(profile ? [profile.name, ...profile.aliases] : [])];
  const eventProgress = (event: typeof eligible[number]) => ({
    completedBeatIndexes: event.eventId === progress?.eventId ? progress.completedBeatIndexes : [],
    startBeatIndex: event.eventId === progress?.eventId ? progress.startBeatIndex ?? 0 : 0,
  });
  const ai = client ?? createAiClient(undefined, {timeoutMs: 90_000, maxRetries: 0});
  // Count events with pending player actions, not automatic/NPC-only events.
  // Reserve room per event so a long current event cannot hide later entry points.
  const candidates: Array<{event: typeof eligible[number]; beatIndex: number; skipsObsolete: boolean}> = [];
  let skipsObsolete = false;
  const searchedEventIds: string[] = [];
  let actionEvents = 0;
  for (const event of eligible) {
    searchedEventIds.push(event.eventId);
    let eventActions = 0;
    const p = eventProgress(event);
    for (let i = p.startBeatIndex; i < (event.beats?.length ?? 0) && eventActions < 4; i++) {
      const beat = event.beats![i]!;
      if (p.completedBeatIndexes.includes(i) || beat.agency !== 'intentional' || !playerControlsBeat(beat, aliases)) continue;
      const obsolete = sourceTargetInvalidated(game, event.eventId, i)
        || game.returnPlanning?.bridges.some(b => b.obsoleteEvidence?.length && b.eventId === event.eventId
          && b.targetBeatIndex === i && b.indexVersion === (game.sourceIndexFingerprint ?? '')
          && b.originCursor === digest(game.sourceCursor ?? null));
      if (obsolete) {
        skipsObsolete = true;
        const group = game.playerActionVersion === 2 ? playerActionAt(event.beats!, i, aliases) : undefined;
        if (group) i = group.endBeatIndex;
        continue;
      }
      candidates.push({event, beatIndex:i, skipsObsolete});
      eventActions++;
      const group = game.playerActionVersion === 2 ? playerActionAt(event.beats!, i, aliases) : undefined;
      if (group) i = group.endBeatIndex;
    }
    if (eventActions && ++actionEvents >= 4) break;
  }
  if (!candidates.length) return [];
  const targets = candidates.map(({event,beatIndex}) => ({eventId:event.eventId,beatIndex,
    description:event.description, beat:event.beats![beatIndex], ...eventProgress(event)}));
  traceEvent('bridge_planning.candidates', {targets, searchedEventIds, actionEvents, location:game.scene.sceneScope?.currentLocation});
  // The earliest pending player decision is sticky. Free play may make the route
  // longer, but it cannot silently skip to a later book beat. Only a durable
  // invalidation marker removes a target from this ordered candidate list.
  const selectedIndex = 0;
  const {event,beatIndex} = candidates[selectedIndex]!;
  const selected = {
    eventId: event.eventId,
    beatIndex,
    reason: candidates[selectedIndex]!.skipsObsolete
      ? 'Earliest pending player action after an explicitly invalidated source target.'
      : 'Earliest pending non-invalidated player action.',
  };
  traceEvent('bridge_planning.target_selected', selected);
  const beat = event.beats![beatIndex]!;
  const group = game.playerActionVersion === 2 ? playerActionAt(event.beats ?? [], beatIndex, aliases) : undefined;

  // A later player target is reachable only after an earlier player boundary was
  // explicitly invalidated. Preserve only automatic/NPC source beats AFTER the
  // last invalidated player boundary and BEFORE the chosen target. Those beats
  // are the canonical re-entry prelude; free-world prose must not invent them.
  const preludeBeats: Array<{eventId:string;beatIndex:number;actor:string|null;action:string}> = [];
  for (const routeEvent of eligible) {
    if (routeEvent.sequence > event.sequence) break;
    const p = eventProgress(routeEvent);
    const limit = routeEvent.eventId === event.eventId ? beatIndex : routeEvent.beats?.length ?? 0;
    for (let i = p.startBeatIndex; i < limit; i++) {
      if (p.completedBeatIndexes.includes(i)) continue;
      const routeBeat = routeEvent.beats?.[i];
      if (!routeBeat) continue;
      if (routeBeat.agency === 'intentional' && playerControlsBeat(routeBeat, aliases)) {
        // Everything before an invalidated player boundary belongs to the route
        // that can no longer be followed. Start the canonical prelude only after
        // its whole action group.
        preludeBeats.length = 0;
        const skippedGroup = game.playerActionVersion === 2 ? playerActionAt(routeEvent.beats ?? [], i, aliases) : undefined;
        if (skippedGroup) i = skippedGroup.endBeatIndex;
        continue;
      }
      preludeBeats.push({eventId:routeEvent.eventId,beatIndex:i,actor:routeBeat.actor ?? null,action:routeBeat.action});
    }
    if (routeEvent.eventId === event.eventId) break;
  }
  const canonicalPrelude = preludeBeats.length ? {
    eventId:preludeBeats[0]!.eventId,
    startBeatIndex:preludeBeats[0]!.beatIndex,
    targetEventId:event.eventId,
    targetBeatIndex:beatIndex,
    beats:preludeBeats,
  } : undefined;
  const next = {eventId:event.eventId, beatIndex, actor:beat.actor, action:group?.choiceText ?? beat.action,
    resultingState:beat.resultingState, preconditions:group?.preconditions ?? []};
  const focus = {sourceCursor: game.sourceCursor ?? null, sourceEventProgress: progress ?? null,
    preferredEventId: event.eventId, nextIntentionalPlayerBeat: next,
    ...(canonicalPrelude ? {canonicalPrelude} : {})};
  const events = [event];
  traceEvent('bridge_planning.context', {gameId:game.gameId, revision:game.gameRevision, slots, focus,
    eligibleEventIds:[event.eventId]});
  const result = await readAiJson(ai, jsonRequest(ai, 'bookrpg_return_bridge_planning', [
    'Prepare optional intermediate opportunities connecting future free-world situations to supplied canonical events. This is background planning, not scene writing.',
    `Return zero to ${slots} short bridges, preferably for different plausible situations. A bridge can be one scene; do not write a fixed multi-scene script.`,
    'The current scene location is the departure point for every bridge. Devise a plausible optional route FROM HERE to the source-required target situation, preserving its exact location. If different, setup should motivate a free intermediate step toward that destination; never call the departure location sufficient simply because the action is physically possible there. Do not assume the player follows the route. Do not replay completed travel or move people without their narrated journey.',
    'All bridges must target the single supplied event and the exact selected intentional player beat in focus.nextIntentionalPlayerBeat. Prepare distinct alternatives for that SAME target, based on current location, proximity, recent actions and plausible immediate situations. Include an opportunity usable at the current location when possible. Existing bridges do not exclude this event; avoid duplicating their setup.',
    'incompatibleReason must be null unless established played facts make this event incompatible. If incompatible, return no bridges and a concrete reason citing those facts. An empty bridge list, lack of inspiration, an unmet future trigger, or preferring a later scene is NOT incompatibility. Never assume future landing, travel, sleep or meetings have already occurred.',
    'Choose eventId exclusively from supplied events. Keep source chronology, causal prerequisites, actor availability and current world rules. The nearest viable event is preferred; a later event must be reachable without pretending earlier required events happened.',
    'locationTerms are concrete words or phrases likely to appear in future sceneScope.currentLocation, matched as whole normalized phrases (OR). presentCharacters are exact canonical names that must all be present; availableCharacters must all be alive. Use only supplied known character names.',
    'Entry triggers use only location and character presence/availability; no untracked possessions or knowledge. The scene review separately checks requiredSituation before allowing an anchor. Avoid a location term as broad as the entire world.',
    'requiredSituation describes the source-grounded location, participants and physical/causal prerequisites for the target action to be executable NOW. Separate prerequisites from the action itself: do not require the action to have already happened. Read the target resultingState and source evidence for location constraints; do not omit the source-required location merely because the action could also be performed elsewhere.',
    'choiceText must perform exactly the target intentional player action, but its player-facing wording may adapt to the actual played history and current situation. Preserve the same target meaning/value; do not turn contextual relabeling into a different beat. Travel needed to reach its location is a free intermediate choice, never an anchor. setup may motivate that travel without performing it. Do not suggest repeating travel already completed. The current trigger location may differ from the required target location.',
    'leadIn is a short causal mini-story (normally two to five sentences) derived from the supplied event, target beat and exact source evidence. It is story material for a later free scene: connect the current/departure situation toward requiredSituation and setup without pretending skipped source events happened.',
    'When focus.canonicalPrelude is present, every listed beat is RESERVED for the canonical pipeline after the player follows the bridge. leadIn, setup and requiredSituation must not narrate, assume or require any reserved action/result. In particular, do not make an NPC move, open/close something, hide, arrive, warn, reveal or otherwise perform a listed prelude beat. Stop immediately before the first reserved beat can happen.',
    'leadIn may use grounded NPC or external developments that do not require player consent only when they are NOT listed in focus.canonicalPrelude. It must not perform choiceText, the target player beat, any other unchosen meaningful player action, or the target event as a completed fact. Do not teleport characters, force travel, reveal private future knowledge or assume missing possessions. End at or just before setup so the next voluntary step remains genuinely available.',
    'setup is the final plausible visible stimulus/opportunity (a sound, clue or conversation opening) created or supported by the lead-in. choiceText voluntarily follows it. Nothing has happened merely because it is planned.',
    'Respect capabilities and geography; an NPC cannot know future events without a grounded reason. No resurrection, teleportation or forced plot restoration. Return fewer bridges or none rather than inventing impossible connections.',
  ].join('\n'), {...freeWorldContext(game), focus, slots,
    wholeBookSummary: book.worldBible?.summary ?? book.chapters.map(c => c.summary ?? '').join('\n'),
    existingBridges: game.returnPlanning?.bridges.filter(b => bridgeStillPossible(b, game)) ?? [], events: events.map(e => ({eventId: e.eventId,
    description: e.description, actors: e.actors, targets: e.targets, beats: e.beats, ...eventProgress(e),
    sourceEvidence: e.sourceReferences.map(r => book.chapters[r.chapterPosition]?.text.trim().split(/\r?\n/).slice(r.lineStart - 1, r.lineEnd).join('\n') ?? '').join('\n').slice(0, 6000)}))}, schema, 2600));
  if (!Array.isArray(result?.bridges) || result.bridges.length > slots) throw new Error('Invalid bridge planning result');
  traceEvent('bridge_planning.proposed', result);
  if (result.incompatibleReason != null) {
    if (typeof result.incompatibleReason !== 'string' || !result.incompatibleReason.trim() || result.bridges.length)
      throw new Error('Invalid bridge incompatibility');
    traceEvent('bridge_planning.fallback', {eventId:event.eventId, reason:result.incompatibleReason});
    return [];
  }
  const names = new Set((book.worldBible?.characterProfiles ?? []).flatMap(c => [c.name, ...c.aliases]));
  names.add(game.playerName);
  const selectedEndBeatIndex = group?.endBeatIndex ?? beatIndex;
  const routeRequiredCharacters = [
    ...(canonicalPrelude?.beats.flatMap(item => item.actor ? [item.actor] : []) ?? []),
    ...(event.beats ?? [])
      .slice(beatIndex, selectedEndBeatIndex + 1)
      .flatMap(item => item.actor ? [item.actor] : []),
  ];
  const now = Date.now();
  return result.bridges.map((b: any) => {
    const event = events.find(e => e.eventId === b.eventId);
    if (!event || ![b.setup, b.choiceText, b.requiredSituation].every(s => typeof s === 'string' && s.trim() && s.length <= 900)
      || typeof b.leadIn !== 'string' || !b.leadIn.trim() || b.leadIn.length > 1800
      || !Array.isArray(b.locationTerms) || !b.locationTerms.length || b.locationTerms.length > 5
      || !b.locationTerms.every((s: unknown) => typeof s === 'string' && normalizeBridgeTerm(s).length >= 3 && s.length <= 80)
      || ![b.presentCharacters, b.availableCharacters].every(a => Array.isArray(a) && a.length <= 12 && a.every(n => names.has(n)))) throw new Error('Invalid bridge conditions');
    return {id: storyCode('bridge', `${game.gameId}:${randomUUID()}`), eventId: event.eventId,
      leadIn: b.leadIn, setup: b.setup, choiceText: b.choiceText,
      departureLocation: game.scene.sceneScope?.currentLocation,
      locationTerms: game.scene.sceneScope?.currentLocation ? [game.scene.sceneScope.currentLocation] : b.locationTerms,
      targetBeatIndex: beatIndex,
      ...(canonicalPrelude ? {canonicalPrelude}
        : selectedIndex > 0 || candidates[selectedIndex]!.skipsObsolete ? {reentryStartBeatIndex:beatIndex} : {}),
      selectionReason:selected.reason,
      sourceBeatSelection: {eventId:event.eventId, beatIndex, endBeatIndex:group?.endBeatIndex ?? beatIndex, kind:group ? 'player_action' as const : 'beat' as const, ...(group ? {actionId:group.id, playerBeatIndexes:group.playerBeatIndexes} : {})},
      target: {action: group?.choiceText ?? beat.action, resultingState: [beat.resultingState, group?.completion].filter(Boolean).join('\n'), requiredSituation: [b.requiredSituation, ...(group?.preconditions ?? [])].join('\n')}, originProgress: digest(game.sourceEventProgress ?? null),
      presentCharacters: b.presentCharacters,
      availableCharacters: [...new Set<string>([...b.availableCharacters, ...routeRequiredCharacters])],
      originCursor: digest(game.sourceCursor ?? null), indexVersion: game.sourceIndexFingerprint ?? '', rulesVersion: rulesVersion(game),
      createdAt: now, expiresAt: now + BRIDGE_LIFETIME_MS, status: 'ready' as const};
  });
}
const LEASE_MS = 10 * 60_000;
export async function runReturnPlanningJob(gameId: string,
  planner = planReturnBridges, now = Date.now()): Promise<boolean> {
  const token = randomUUID();
  const claimed = await changeReturnPlanning(gameId, game => {
    const job = game.returnPlanning?.job;
    if (!job || game.narrativeMode !== 'free' || game.status !== 'active'
      || job.dueAt > now || (job.leaseUntil ?? 0) > now) return false;
    job.token = token; job.leaseUntil = now + LEASE_MS;
    job.revision = game.gameRevision ?? 0;
    return true;
  });
  if (!claimed) return false;
  return await withFlowTrace('returnPlanning', {gameId, revision:claimed.gameRevision}, async () => {
  let plans: ReturnBridge[] = [];
  let error: unknown;
  try {
    const book = await getBook(claimed.book.bookId);
    if (!book) throw new Error('Book unavailable');
    const snapshot = {...claimed, characterProfiles: book.worldBible?.characterProfiles};
    plans = await planner(snapshot, book);
    traceEvent('bridge_planning.validated', {bridges:plans});
  } catch (e) { error = e; traceEvent('bridge_planning.error', e); console.error('Return planning failed:', e instanceof Error ? e.message : e); }
  await changeReturnPlanning(gameId, current => {
    const p = current.returnPlanning;
    if (p?.job?.token !== token) { traceEvent('bridge_planning.discarded', {reason:'lease replaced'}); return false; }
    delete p.job;
    if (current.gameRevision !== claimed.gameRevision) {
      traceEvent('bridge_planning.discarded', {reason:'game revision changed', plannedRevision:claimed.gameRevision,currentRevision:current.gameRevision});
      if (current.narrativeMode === 'free' && current.status === 'active')
        p.job = {revision: current.gameRevision ?? 0, dueAt: Date.now() + 1000};
      return true;
    }
    if (!error && current.narrativeMode === 'free' && current.status === 'active') {
      p.bridges.push(...plans.filter(b => bridgeStillPossible(b, current)));
      traceEvent('bridge_planning.published', {bridges:p.bridges});
      p.generation++;
      delete p.lastMatched;
    }
    p.lastAttemptSituation = bridgeSituation(current);
    p.lastAttemptStock = bridgeStock(current);
    p.failures = error ? (p.failures ?? 0) + 1 : 0;
    p.retryAfter = Date.now() + BRIDGE_COOLDOWN_MS * Math.max(1, p.failures);
    // Retry transient failures without a user turn; an empty search waits for a situation change.
    if (error && p.failures < 3 && current.narrativeMode === 'free' && current.status === 'active'
      && p.bridges.filter(b => bridgeStillPossible(b, current)).length < 2)
      p.job = {revision: current.gameRevision ?? 0, dueAt: p.retryAfter};
    return true;
  });
  return true;
  });
}
let running = false;
export async function drainReturnPlanning(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // One job per process at a time; leases coordinate replicas. Gameplay never waits.
    for (const game of await pendingReturnPlanningGames()) {
      if ((game.returnPlanning?.job?.dueAt ?? Infinity) > Date.now()) continue;
      await runAsUser({userId: game.ownerId ?? 'local-development', displayName: 'Planning worker', provider: 'internal'},
        () => runReturnPlanningJob(game.gameId));
    }
  } catch (e) { console.error('Return planning worker:', e instanceof Error ? e.message : e); }
  finally { running = false; }
}
export function startReturnPlanningWorker(): () => void {
  const timer = setInterval(() => { void drainReturnPlanning(); }, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
