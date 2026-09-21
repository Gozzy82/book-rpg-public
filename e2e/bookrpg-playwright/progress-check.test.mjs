import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPlayableResponse, assertTurnProgress} from './progress-check.mjs';

const before = {gameId: 'tin', status: 'active', turnHistory: [{turnNumber: 15}],
  scene: {text: 'We leave the campsite.', choices: [{id: 'anchor'}]}};
const after = {...before, turnHistory: [...before.turnHistory, {turnNumber: 16}],
  scene: {text: 'We reach the next gulf, beside an uncut tree.', choices: [{id: 'chop'}]}};
test('new saved scene at a player choice passes', () => assert.doesNotThrow(() => assertTurnProgress(before, after)));
test('HTTP success with a continuation failure fails even after partial progress', () => {
  assert.throws(() => assertTurnProgress(before, {...after, notice: {code: 'STORY_CONTINUATION_UNAVAILABLE', message: 'No anchor'}}), /voortgang mislukt/);
});
test('unresolved automatic continuation fails even with new text and history', () => {
  assert.throws(() => assertTurnProgress(before, {...after, scene: {...after.scene, choices: [{id: '__bookrpg_source_continuation__'}]}}), /niet afgerond/);
});
test('rewording without a stored turn is not success', () => {
  assert.throws(() => assertTurnProgress(before, {...after, turnHistory: before.turnHistory}), /opgeslagen beurt/);
});
test('same prose and wrong game are rejected', () => {
  assert.throws(() => assertTurnProgress(before, {...after, scene: before.scene}), /dezelfde/);
  assert.throws(() => assertTurnProgress(before, {...after, gameId: 'lion'}), /ander spel/);
});
test('terminal scenes need no menu; optional source route with real choices is allowed', () => {
  assert.doesNotThrow(() => assertTurnProgress(before, {...after, status: 'completed', scene: {...after.scene, choices: []}}));
  assert.doesNotThrow(() => assertPlayableResponse({...after, scene: {...after.scene, choices: [{id: 'local'}, {id: '__bookrpg_source_continuation__'}]}}));
});

const {resolveAutomaticContinuations} = await import('./progress-check.mjs');
const auto = n => ({...after, turnHistory: [{turnNumber: n}], scene: {text: `Automatic scene ${n}`, choices: [{id: '__bookrpg_source_continuation__'}]}});
const playable = n => ({...auto(n), scene: {...auto(n).scene, choices: [{id: 'player'}]}});
test('budget pauses resume until a player choice, without spending a player choice', async () => {
  const hops = [];
  const result = await resolveAutomaticContinuations(auto(1), async (previous, hop) => {
    hops.push(hop);
    assert.equal(previous.turnHistory[0].turnNumber, hop);
    return hop < 3 ? auto(hop + 1) : playable(4);
  });
  assert.deepEqual(hops, [1, 2, 3]);
  assert.deepEqual(result, playable(4));
});
test('playable and terminal responses need no continuation requests', async () => {
  for (const initial of [playable(1), {...auto(1), status: 'completed', scene: {text: 'The end.', choices: []}}]) {
    assert.equal(await resolveAutomaticContinuations(initial, () => assert.fail('Unexpected request')), initial);
  }
});
test('automatic resume still fails on no progress, wrong game and explicit failure notices', async () => {
  for (const next of [auto(1), {...auto(2), gameId: 'wrong'}, {...auto(2), notice: {code: 'STORY_CONTINUATION_UNAVAILABLE', message: 'Rejected'}}]) {
    await assert.rejects(resolveAutomaticContinuations(auto(1), async () => next));
  }
  await assert.rejects(resolveAutomaticContinuations(auto(1), async () => {throw Error('HTTP 400');}), /HTTP 400/);
});
test('automatic continuation has a hard limit even while the story progresses', async () => {
  let calls = 0;
  await assert.rejects(resolveAutomaticContinuations(auto(1), async () => auto(++calls + 1), 3), /na 3 vervolgpogingen/);
  assert.equal(calls, 3);
});
