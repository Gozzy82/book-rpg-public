import test from 'node:test';
import assert from 'node:assert/strict';
import {goalStartContexts} from '../src/books/analyze/staged-index.js';
import type {ChapterPartSourceIndex} from '../src/books/source-index.js';
type Event = ChapterPartSourceIndex['significantEvents'][number];
const participants = ['Dorothy', 'Scarecrow', 'Toto'];
const jointAction = {id: 'forest-entry', participants, resultingState: 'All three are inside the forest.'};
const joint = participants.map(actor => ({actor, action: 'Enters the forest with the companions.', resultingState: jointAction.resultingState,
  agency: 'intentional', stakes: 'significant', targets: [], references: [],
  sourceSemantics: {mode: 'present', narratedContent: null, intentionalRole: 'meaningful', jointAction}}));
const prior = {...joint[0], action: 'Reaches the forest edge.', resultingState: 'The travelers are at the forest edge.', sourceSemantics: undefined};
for (const withPrior of [false, true]) test(`all joint participants use the shared prior state (${withPrior ? 'after travel' : 'opening'})`, () => {
  const beats = withPrior ? [prior, ...joint] : joint;
  const offset = withPrior ? 1 : 0;
  const event = {beats} as Event;
  const plans = joint.map((_, i) => ({startBeatIndex: i + offset, endBeatIndex: i + offset, goal: 'Enter the forest', boundaryReason: 'Arrival'}));
  const before = structuredClone(event);
  const contexts = goalStartContexts(event, plans);
  for (const [i, context] of contexts.entries()) {
    assert.equal(context.startBeatIndex, i + offset);
    assert.equal(context.actor, participants[i]);
    assert.equal(context.preconditionCutoffBeatIndex, offset);
    assert.equal(context.lastCompletedBeatIndex, withPrior ? 0 : null);
    assert.equal(context.precedingResultingState, withPrior ? prior.resultingState : null);
  }
  assert.deepEqual(event, before);
});
test('a later separate action sees the completed joint outcome', () => {
  const event = {beats: [...joint, {...prior, action: 'Asks for shelter.'}]} as Event;
  const context = goalStartContexts(event, [{startBeatIndex: 3, endBeatIndex: 3, goal: 'Ask for shelter', boundaryReason: 'Question asked'}])[0]!;
  assert.equal(context.preconditionCutoffBeatIndex, 3);
  assert.equal(context.lastCompletedBeatIndex, 2);
  assert.equal(context.precedingResultingState, jointAction.resultingState);
});
