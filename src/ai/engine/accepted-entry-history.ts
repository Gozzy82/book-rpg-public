import type {GameState} from '../../shared/contracts.js';

export const ACCEPTED_ENTRY_HISTORY_POLICY = 'ACCEPTED VISIBLE HISTORY: accepted_scene_history contains already saved player-visible scene prose in chronological order, before current_scene and candidate_transition. It is evidence of what the player has seen, unlike pending actions, hidden memory or future source. Existing objects, knowledge and relevant causes need not be narrated again just because current_scene omits them. For example, a bed shown earlier in the same farmhouse remains established after rescuing Toto. Read the entire supplied sequence: later departures, losses, destruction, changed location, resolved threats and other changed circumstances supersede earlier availability or causes. Earlier presence does not establish current reach across locations. Never restore an obsolete fact or replay an earlier action. Use current_scene for the latest situation. The history may be a bounded suffix; omitted older scenes are unknown, not proof of absence. Do not invent missing events or treat an unrelated earlier stimulus as the cause of a new action.';

const MAX_HISTORY_CHARS = 32000;

/** Complete scenes only, in a contiguous suffix: never select an old fact while
 * dropping a later scene that could invalidate it. No choices, summaries or drafts. */
export function acceptedEntryHistory(state: GameState) {
  const fromTurns = state.turnHistory !== undefined;
  const available = fromTurns
    ? state.turnHistory!.filter(turn => state.turnNumber === undefined || turn.turnNumber <= state.turnNumber)
      .map(turn => ({turnNumber: turn.turnNumber, text: turn.scene.text}))
    : (state.history ?? []).filter(item => item.kind === 'scene')
      .map(item => ({turnNumber: null, text: item.text}));
  let start = available.length;
  let chars = 0;
  while (start > 0) {
    const size = available[start - 1]!.text.length;
    if (chars + size > MAX_HISTORY_CHARS) break;
    chars += size;
    start--;
  }
  return {source: fromTurns ? 'turnHistory' : 'legacy_scene_history',
    omittedEarlierScenes: start, scenes: available.slice(start)};
}
