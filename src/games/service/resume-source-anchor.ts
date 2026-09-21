import type {GameChoice, GameState, ImportedBook, SceneScope} from '../../shared/contracts.js';
import {SOURCE_ANCHOR_CHOICE_ID, SOURCE_CONTINUATION_CHOICE_ID} from '../../shared/contracts.js';
import {assertGameSourceVersion} from '../../books/source-index/game-version.js';
import {bindSourceAnchorSelection} from '../source-anchor-selection.js';
import {buildSourceEventChoiceBeatState, buildRequiredPlayerChoiceFallback, nextSignificantEventForCandidate} from '../../ai/engine/source-navigation.js';
import {removeChoicesWithPlayerIdentityReferences, removeChoicesWithUnintroducedCharacters, removeDuplicateChoices, scopePeopleIncludeCharacter} from '../../ai/engine/scene-validation.js';
import {buildCanonicalNextEventCandidate, sourceWorldStateForGame} from './source-candidates.js';
import {resolveSourceEventActorTakeover} from './source-event-takeover.js';
import {invalidateSourceTarget, sourceTargetInvalidated} from '../return-bridges.js';

function lastTurnWasCanonical(game: GameState): boolean {
  const last=game.turnHistory?.at(-1);
  if(last?.kind==='continuation') return true;
  if(last?.kind!=='choice') return false;
  return Boolean(game.undoSnapshot?.scene.choices.some(c=>c.id===SOURCE_ANCHOR_CHOICE_ID
    && c.sourceAnchorRoute==='event' && c.text===last.action));
}
function usable(game:GameState,anchor:GameChoice):boolean {
  const scene={...game.scene,choices:[anchor]};
  const identity=removeChoicesWithPlayerIdentityReferences(scene,game.playerName,game.characterProfiles);
  return removeChoicesWithUnintroducedCharacters(identity,game).choices.some(c=>c.id===SOURCE_ANCHOR_CHOICE_ID);
}

/** Recover only menu/scope, never source progress or executed turns. */
export async function restoreResumeSourceAnchor(
  game:GameState, book:ImportedBook|undefined, previousAnchor:GameChoice|undefined,
  review:(state:GameState,anchor:GameChoice)=>Promise<SceneScope>,
):Promise<boolean>{
  if(game.narrativeMode === 'free' || game.activeConversation || game.status!=='active') return false;
  const current=game.scene.choices.find(c=>c.id===SOURCE_ANCHOR_CHOICE_ID);
  if(current && usable(game,current)) return false;
  if(!previousAnchor && (game.scene.choices[0]?.id===SOURCE_CONTINUATION_CHOICE_ID || !lastTurnWasCanonical(game))) return false;
  if(!book || !game.sourceCursor || !game.sourceIndexFingerprint) return false;
  assertGameSourceVersion(game,book);
  const candidate=buildCanonicalNextEventCandidate(book,game.sourceCursor,game.playerName,
    sourceWorldStateForGame(game,book,game.sourceCursor));
  const next=nextSignificantEventForCandidate(candidate);
  const remaining=buildSourceEventChoiceBeatState(next,game.sourceEventProgress).remainingEvent;
  const fallback=buildRequiredPlayerChoiceFallback(remaining,game.playerName,game.characterProfiles,game.scene.sceneScope);
  if(!fallback) {
    if(previousAnchor) throw new Error('Saved anchor no longer matches the immediate player action. No progress was changed.');
    return false; // Never skip an automatic prefix to offer a later player action.
  }
  const working=structuredClone(game);
  working.scene.choices=[fallback,...working.scene.choices.filter(c=>c.id!==SOURCE_ANCHOR_CHOICE_ID&&c.id!==SOURCE_CONTINUATION_CHOICE_ID)];
  bindSourceAnchorSelection(working,book);
  let anchor=working.scene.choices[0]!;
  if(!anchor.sourceBeatSelection) throw new Error('The restored anchor could not be bound to the saved source position.');
  const preserveSaved=Boolean(previousAnchor?.sourceBeatSelection
    && JSON.stringify(previousAnchor.sourceBeatSelection)===JSON.stringify(anchor.sourceBeatSelection));
  if(preserveSaved) {
    anchor=structuredClone(previousAnchor!); // Preserve an already reviewed label and exact requirements.
  }
  // Even when no requiredPresent names survived, assess the actual prose before restoring.
  const corrected=await review(game,anchor);
  if(!preserveSaved) anchor=buildRequiredPlayerChoiceFallback(remaining,game.playerName,game.characterProfiles,corrected)!;
  working.scene={...game.scene,sceneScope:corrected,choices:[anchor,...game.scene.choices.filter(c=>c.id!==SOURCE_ANCHOR_CHOICE_ID&&c.id!==SOURCE_CONTINUATION_CHOICE_ID)].slice(0,4)};
  bindSourceAnchorSelection(working,book);
  if(!usable(working,working.scene.choices[0]!)) throw new Error('The restored anchor is still unavailable in the saved scene. No progress was changed.');
  game.scene=working.scene;
  return true;
}


export interface SideTurnAnchorRestoreResult {
  restored: boolean;
  invalidated: boolean;
  reason?: string;
}

/**
 * A side interaction does not consume or re-earn a canonical player decision.
 * Rebuild slot 1 from the same server-owned beat selection. The display label
 * is derived again from that source beat plus current scope; only durable
 * world-state incompatibility is allowed to retire the target.
 */
export function restoreSideTurnSourceAnchor(
  game: GameState,
  book: ImportedBook | undefined,
  previousAnchor: GameChoice | undefined,
): SideTurnAnchorRestoreResult {
  const selection = previousAnchor?.sourceBeatSelection;
  if (
    game.narrativeMode === 'free'
    || game.activeConversation
    || game.status !== 'active'
    || !selection
    || previousAnchor?.id !== SOURCE_ANCHOR_CHOICE_ID
    || previousAnchor.sourceAnchorRoute !== 'event'
  ) {
    return {restored:false, invalidated:false};
  }
  if (!book || !game.sourceCursor || !game.sourceIndexFingerprint) {
    return {restored:false, invalidated:false};
  }
  assertGameSourceVersion(game, book);

  if (sourceTargetInvalidated(game, selection.eventId, selection.beatIndex)) {
    return {restored:false, invalidated:true, reason:'Canonical target was already invalidated.'};
  }

  const requiredLivingCharacters = [
    ...(previousAnchor.requiredPresentCharacters ?? []),
    ...(previousAnchor.character ? [previousAnchor.character] : []),
  ];
  const deadRequired = requiredLivingCharacters.filter(name =>
    scopePeopleIncludeCharacter(
      game.confirmedDeadCharacters ?? [],
      name,
      game.characterProfiles ?? [],
    )
  );
  if (deadRequired.length > 0) {
    const reason = `Canonical target requires dead character(s): ${deadRequired.join(', ')}.`;
    invalidateSourceTarget(game, selection, [reason]);
    return {restored:false, invalidated:true, reason};
  }

  const event = book.storyEvents?.find(candidate => candidate.eventId === selection.eventId);
  if (!event?.beats?.length) {
    return {restored:false, invalidated:false};
  }
  const progress = game.sourceEventProgress?.eventId === selection.eventId
    ? game.sourceEventProgress
    : undefined;
  if (
    progress
    && (
      progress.completedBeatIndexes.includes(selection.beatIndex)
      || (progress.startBeatIndex ?? 0) > selection.beatIndex
    )
  ) {
    return {restored:false, invalidated:false, reason:'Canonical target is already behind saved source progress.'};
  }

  // Evaluate only the selected action window. A later impossible actor must not
  // retire an earlier still-possible player decision in the same event.
  const selectedEvent = {
    ...event,
    beats: event.beats.slice(selection.beatIndex, selection.endBeatIndex + 1),
  };
  const worldState = sourceWorldStateForGame(game, book, game.sourceCursor);
  const availability = resolveSourceEventActorTakeover(
    selectedEvent,
    book,
    game.playerName,
    {...worldState, sourceEventProgress: undefined},
  );
  if (availability.invalidatingActors.length > 0) {
    const reason = `Canonical target requires permanently unavailable actor(s): ${availability.invalidatingActors.join(', ')}.`;
    invalidateSourceTarget(game, selection, [reason]);
    return {restored:false, invalidated:true, reason};
  }

  const remaining = buildSourceEventChoiceBeatState(
    event,
    game.sourceEventProgress,
  ).remainingEvent;
  const fallback = buildRequiredPlayerChoiceFallback(
    remaining,
    game.playerName,
    game.characterProfiles,
    game.scene.sceneScope,
  );
  if (!fallback) {
    return {restored:false, invalidated:false, reason:'The same canonical player decision is not the immediate pending player beat.'};
  }

  // The label is regenerated deterministically from the same source beat and
  // current scope. Generic/local alternatives may be deduplicated against it,
  // but they never inherit the server-owned canonical value merely by similarity.
  const working = structuredClone(game);
  working.scene = removeDuplicateChoices({
    ...working.scene,
    choices: [
      fallback,
      ...working.scene.choices.filter(choice =>
        choice.id !== SOURCE_ANCHOR_CHOICE_ID
        && choice.id !== SOURCE_CONTINUATION_CHOICE_ID
      ),
    ].slice(0, 4),
  });
  bindSourceAnchorSelection(working, book);
  const restored = working.scene.choices[0];
  if (
    restored?.id !== SOURCE_ANCHOR_CHOICE_ID
    || !restored.sourceBeatSelection
    || JSON.stringify(restored.sourceBeatSelection) !== JSON.stringify(selection)
  ) {
    return {restored:false, invalidated:false, reason:'The canonical target changed while rebuilding the menu.'};
  }
  game.scene = working.scene;
  return {restored:true, invalidated:false};
}
