import test from 'node:test';
import assert from 'node:assert/strict';
import type {GameState, GameTurnHistoryEntry} from '../src/shared/contracts.js';
import {acceptedEntryHistory} from '../src/ai/engine/accepted-entry-history.js';
import {establishSourceBeatEntry, establishSourceEventEntry} from '../src/ai/engine/source-event-entry.js';

const saved = (turnNumber: number, text: string): GameTurnHistoryEntry => ({turnNumber, kind: 'choice',
  action: 'UNSELECTED_OR_INPUT_TEXT', scene: {title: 'Saved scene', text}, completedAt: 'now'});
const scene = {title: 'Toto Safe Inside', text: 'I pulled Toto inside and closed the trapdoor. The house still flew.', choices: [],
  sceneScope: {currentLocation: 'Farmhouse', peoplePresent: ['Dorothy', 'Toto'], peopleWithinSpeakingDistance: ['Dorothy', 'Toto']},
  storyMemory: {summary: 'Toto is safe inside the airborne house.', canonFacts: ['The trapdoor is closed.'], openThreads: []}};
const state = {playerName: 'Dorothy', parameters: [], characterProfiles: [], turnNumber: 5, scene,
  turnHistory: [saved(1, 'Toto hid beneath the bed in our farmhouse.'), saved(2, 'I reached under the bed and caught Toto.'),
    saved(3, 'Our house rose into the air.'), saved(4, 'I waited inside.'), saved(5, 'Toto slipped through the trapdoor.')],
  history: [{kind: 'choice', text: 'Invent a new bed'}]} as unknown as GameState;
const beat = {actor: 'Dorothy', action: 'Crawl to bed and sleep.', targets: ['Toto'], agency: 'intentional' as const,
  stakes: 'significant' as const, sourceReferences: [], automaticPreludeSourceExcerpt: 'Dorothy pulled Toto inside and shut the trapdoor.'};
const event = {eventId: 'sleep', sequence: 2, chapterPosition: 0, description: 'Rest', sourceReferences: [], beats: [beat]};
const candidate = {storyEvents: [event], sourceEventEntries: {sleep: {fromEventId: 'rescue', excerpt: beat.automaticPreludeSourceExcerpt, entryExcerpt: ''}}};
const checks = ['sourceSupport', 'continuity', 'playerAgency', 'nextEventUnperformed', 'entryReady', 'visibleCause', 'sceneScope', 'storyMemory', 'repetition'];
const verdict = (ready = true) => ({status: 'completed', output_text: JSON.stringify(Object.fromEntries(checks.map(k => [k,
  {supported: k !== 'entryReady' || ready, reason: ready ? 'Earlier bed remains established in this house.' : 'The bed was destroyed after its introduction.',
    ...(k === 'visibleCause' ? {causeStatus: 'not_required'} : {}), ...(k === 'entryReady' ? {repairTarget: 'none'} : {})}])))});

for (const route of ['beat', 'event'] as const) {
  test(`${route} entry can use earlier saved bed evidence without generating setup or another call`, async () => {
    const before = structuredClone(state);
    const calls: string[] = [];
    const call: Parameters<typeof establishSourceEventEntry>[5] = async (label, request) => {
      calls.push(label);
      const input = JSON.parse(request.input);
      assert.deepEqual(input.accepted_scene_history.scenes, state.turnHistory!.map(t => ({turnNumber: t.turnNumber, text: t.scene.text})));
      assert.doesNotMatch(JSON.stringify(input.accepted_scene_history), /UNSELECTED_OR_INPUT_TEXT|Invent a new bed/);
      assert.doesNotMatch(input.current_scene.text, /bed/);
      assert.match(request.instructions!, /Existing objects, knowledge and relevant causes need not be narrated again/);
      assert.match(request.instructions!, /later departures, losses, destruction/);
      return verdict();
    };
    const result = route === 'beat'
      ? await establishSourceBeatEntry(state, scene, candidate, event, [], 0, 'test', call)
      : await establishSourceEventEntry(state, scene, candidate, 'rescue', 'test', call);
    assert.equal(result, scene);
    assert.deepEqual(calls, [`source ${route} entry preflight review`]);
    assert.deepEqual(state, before);
  });
}

test('generation and final review retain intervening destruction and do not bypass a readiness rejection', async () => {
  const changed = {...state, turnHistory: [...state.turnHistory!, saved(5, 'The bed broke apart and fell out of the house.')]};
  const calls: string[] = [];
  await assert.rejects(() => establishSourceBeatEntry(changed, scene, candidate, event, [], 0, 'test', async (label, request) => {
    calls.push(label);
    const input = JSON.parse(request.input);
    assert.match(input.accepted_scene_history.scenes.at(-1).text, /bed broke apart/);
    assert.match(request.instructions!, /supersede earlier availability/);
    if (label === 'source beat entry') return {status: 'completed', output_text: JSON.stringify({text: '',
      sceneScope: scene.sceneScope, storyMemory: scene.storyMemory, peopleKilledInScene: []})};
    return verdict(false);
  }), /entryReady.*bed was destroyed/);
  assert.deepEqual(calls, ['source beat entry preflight review', 'source beat entry', 'source beat entry review']);
});

test('history respects rollback turn, empty authoritative history and legacy scene-only fallback', () => {
  assert.equal(acceptedEntryHistory({...state, turnNumber: 2}).scenes.length, 2);
  assert.deepEqual(acceptedEntryHistory({...state, turnHistory: []}).scenes, []);
  assert.deepEqual(acceptedEntryHistory({...state, turnHistory: undefined, history: [
    {kind: 'choice', text: 'Buy a bed'}, {kind: 'story', text: 'Pending narration'}, {kind: 'scene', text: 'An accepted room.'},
  ]}).scenes, [{turnNumber: null, text: 'An accepted room.'}]);
});

test('bounded history never keeps an early fact while dropping a later invalidating scene', () => {
  const bounded = acceptedEntryHistory({...state, turnHistory: [saved(1, 'A bed exists.'), saved(2, 'x'.repeat(32000)), saved(3, 'The bed burned.') ]});
  assert.deepEqual(bounded.scenes, [{turnNumber: 3, text: 'The bed burned.'}]);
  assert.equal(bounded.omittedEarlierScenes, 2);
});
