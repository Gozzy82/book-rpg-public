import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {PreconditionRepairError, reviewAndRepairPreconditions, reviewRebuildCandidate} from '../src/books/analyze/precondition-repair.js';
import {preconditionSourceContexts, PlayerActionReviewRejection} from '../src/books/analyze/player-action-review.js';
import type {ChapterPartSourceIndex} from '../src/books/source-index.js';
import type {ChapterAnalysisPart} from '../src/books/analyze/batching.js';
const book = JSON.parse(await fs.readFile(new URL('./fixtures/oz-lion-action-boundaries.json', import.meta.url), 'utf8'));
const event = book.storyEvents[0], chapter = book.chapters[0];
const lines = [48,69,92,94,95,97];
const index: ChapterPartSourceIndex = {summary: '', characters: [], actions: [], relationships: [], significantEvents: [{
  description: event.description, actors: event.actors, targets: event.targets, references: [],
  beats: event.beats.map(({sourceReferences, ...b}: any, i: number) => ({...b, references: sourceReferences.map(({lineStart,lineEnd}: any) => ({lineStart,lineEnd})), sourceActionStart: {line: lines[i], column: i === 0 ? 63 : 0}})),
}]};
const part: ChapterAnalysisPart = {sourceId: 'lion', chapterPosition: 0, chapterIndex: 8, chapterTitle: chapter.title, partIndex: 0, partCount: 1, lineStart: 1, lineEnd: chapter.text.trim().split('\n').length, text: chapter.text.trim()};
const issue = {eventIndex: 0, beatIndexes: [5], repairTarget: 'player_action', reason: 'Prior willingness is established only by later acceptance, not before the request.'};
const rejection = {valid: false, issues: [issue]};
const patch = {changes: [{eventIndex: 0, beatIndex: 5, preconditions: ['The travelers are going to Oz.'], reason: 'Keep the established destination; remove assumptions about future acceptance and knowledge first acquired during the question.', evidence: [{line: 92, quote: 'I am going to the Great Oz'}]}], unresolved: []};
const response = (value: unknown) => ({status: 'completed', output_text: JSON.stringify(value)});

test('actual Oz contexts include earlier speech and exclude the pending action', () => {
  const contexts = preconditionSourceContexts(part, index);
  assert.match(JSON.stringify(contexts[2]!.priorSource), /King of Beasts/);
  assert.ok(contexts[2]!.priorSource.some(l => l.line === 78));
  assert.ok(contexts[3]!.priorSource.some(l => l.line === 83 && l.text.includes('heart disease')));
  assert.ok(contexts[1]!.priorSource.some(l => l.line === 67 && l.text.includes('What makes you a coward')));
  assert.ok(contexts[0]!.priorSource.at(-1)!.text.endsWith('watched her '));
  assert.doesNotMatch(contexts[0]!.priorSource.at(-1)!.text, /pick/);
  assert.ok(contexts[5]!.priorSource.every(l => l.line < 97));
});
test('repairs only rejected preconditions, with source evidence and independent full review', async () => {
  const before = structuredClone(index); let calls = 0;
  const result = await reviewAndRepairPreconditions(async request => {
    calls++;
    if (calls === 1) {
      assert.match(request.instructions!, /Earlier speech by the same actor/);
      assert.match(request.instructions!, /aid recipients/);
      assert.match(request.input, /PRECONDITION SOURCE CONTEXTS/);
      return response(rejection);
    }
    if (calls === 2) return response(patch);
    assert.match(request.input, /ORIGINAL INDEX BEFORE CONDITION REPAIR/);
    assert.match(request.instructions!, /Reject deletion of a necessary valid/);
    return response({valid: true, issues: []});
  }, 'test', part, index);
  const expected = structuredClone(index);
  expected.significantEvents[0]!.beats[5]!.playerAction!.preconditions = patch.changes[0]!.preconditions;
  assert.deepEqual(result.index, expected);
  assert.deepEqual(index, before);
  assert.equal(result.changes.length, 1); assert.equal(calls, 3);
});
test('source issues block without attempting a precondition-only repair', async () => {
  let calls = 0;
  await assert.rejects(reviewAndRepairPreconditions(async () => {calls++; return response({valid: false, issues: [{...issue, repairTarget: 'source'}]});}, 'test', part, index), PlayerActionReviewRejection);
  assert.equal(calls, 1);
});
test('future evidence, invented quotes, unrelated groups and source mutations are rejected', async () => {
  for (const change of [
    {...patch.changes[0], evidence: [{line: 103, quote: 'You will be very welcome'}]},
    {...patch.changes[0], evidence: [{line: 92, quote: 'Not in source'}]},
    {...patch.changes[0], beatIndex: 1},
    {...patch.changes[0], action: 'Changed action'},
  ]) {
    let calls = 0;
    await assert.rejects(reviewAndRepairPreconditions(async () => response(++calls === 1 ? rejection : {changes: [change], unresolved: []}), 'test', part, index));
    assert.equal(calls, 2);
  }
});
test('dropping a valid prerequisite cannot bypass the final full review', async () => {
  const before = structuredClone(index); let calls = 0;
  await assert.rejects(reviewAndRepairPreconditions(async () => {
    calls++;
    if (calls === 1) return response(rejection);
    if (calls === 2) return response({changes: [{...patch.changes[0], preconditions: []}], unresolved: []});
    return response({valid: false, issues: [{...issue, reason: 'Necessary established destination was removed.'}]});
  }, 'test', part, index), /Necessary established destination/);
  assert.equal(calls, 3); assert.deepEqual(index, before);
});
test('accepted groups are unchanged and require no repair call', async () => {
  let calls = 0;
  const result = await reviewAndRepairPreconditions(async () => {calls++; return response({valid: true, issues: []});}, 'test', part, index);
  assert.equal(result.index, index); assert.deepEqual(result.changes, []); assert.equal(calls, 1);
});

test('explicit event patches retain original review issues without any automatic repair', async () => {
  const before = structuredClone(index); let calls = 0;
  await assert.rejects(reviewRebuildCandidate(async () => {calls++; return response(rejection);}, 'test', part, index, true), error => {
    assert.ok(error instanceof PlayerActionReviewRejection);
    assert.deepEqual(error.issues, rejection.issues);
    return true;
  });
  assert.equal(calls, 1); assert.deepEqual(index, before);
  const result = await reviewRebuildCandidate(async () => response({valid: true, issues: []}), 'test', part, index, true);
  assert.equal(result.index, index); assert.deepEqual(result.changes, []);
});

test('failed repair evidence preserves review, proposed condition, quote, actual line and entry boundary', async () => {
  const before = structuredClone(index); let calls = 0;
  const invalid = {...patch, changes: [{...patch.changes[0], evidence: [{line: 92, quote: 'Not in source'}]}]};
  await assert.rejects(reviewRebuildCandidate(async () => response(++calls === 1 ? rejection : invalid), 'test', part, index, false), error => {
    assert.ok(error instanceof PreconditionRepairError);
    const d = error.diagnostics as any;
    assert.deepEqual(d.reviewIssues, rejection.issues);
    assert.deepEqual(d.proposedRepair, invalid);
    assert.equal(d.beatIndex, 5);
    assert.equal(d.boundary.line, 97);
    assert.deepEqual(d.evidence, {line: 92, quote: 'Not in source'});
    assert.match(d.suppliedSourceLine, /I am going to the Great Oz/);
    assert.equal(d.allowedPriorLine, d.suppliedSourceLine);
    return true;
  });
  assert.equal(calls, 2); assert.deepEqual(index, before);
});
