import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type {ImportedBook} from '../src/shared/contracts.js';
import type {ChapterPartSourceIndex} from '../src/books/source-index.js';
import type {ChapterAnalysisPart} from '../src/books/analyze/batching.js';
import {ACTION_ENTRY_PHASE_POLICY} from '../src/shared/source-transition-policy.js';
import {resolveActionBoundaries} from '../src/books/source-index/action-boundaries.js';
import {reviewAndRepairPreconditions} from '../src/books/analyze/precondition-repair.js';
import {preconditionSourceContexts} from '../src/books/analyze/player-action-review.js';
import {sourcePreludeEvidence} from '../src/books/source-index/story-events.js';
const book: ImportedBook = JSON.parse(await fs.readFile(new URL('./fixtures/oz-gulf-action-phases.json', import.meta.url), 'utf8'));
const event = {...book.storyEvents![0]!, beats: book.storyEvents![0]!.beats!.slice(0, 2)};
const chapter = book.chapters[0]!;
const part: ChapterAnalysisPart = {sourceId: event.eventId, chapterPosition: 0, chapterIndex: chapter.index, chapterTitle: chapter.title,
  partIndex: 0, partCount: 1, lineStart: 1, lineEnd: chapter.text.trim().split('\n').length, text: chapter.text.trim()};
const index: ChapterPartSourceIndex = {summary: '', characters: [], actions: [], relationships: [], significantEvents: [{
  description: event.description, actors: event.actors, targets: event.targets, references: [],
  beats: event.beats.map(({sourceReferences, ...b}, i) => ({...b, references: sourceReferences.map(({lineStart, lineEnd}) => ({lineStart, lineEnd})),
    sourceActionStart: {line: i ? 49 : 42, column: 0}})),
}]};
const response = (v: unknown) => ({status: 'completed', output_text: JSON.stringify(v)});
const issue = {eventIndex: 0, beatIndexes: [1], repairTarget: 'player_action', reason: 'Mounting at line 58 follows the Lion’s commitment at 49; it is preparation inside the carrying goal.'};
const replacement = ['The travelers are together at the gulf with a plan to cross one at a time.', 'The Lion can reach the gulf’s edge and attempt the jump.'];
const patch = {changes: [{eventIndex: 0, beatIndex: 1, preconditions: replacement,
  reason: issue.reason, evidence: [{line: 48, quote: 'carry us all over on your back, one at a time.'}]}], unresolved: []};

test('actual gulf source separates prior plan from commitment, invitation, mounting and jump', () => {
  const context = preconditionSourceContexts(part, index)[1]!;
  assert.ok(context.priorSource.some(l => l.line === 48 && l.text.includes('one at a time')));
  assert.ok(context.priorSource.every(l => l.line < 49));
  assert.ok(context.executionSource.some(l => l.line === 49 && l.text.includes('I’ll try')));
  assert.ok(context.executionSource.some(l => l.line === 56 && l.text.includes('get on my back')));
  assert.ok(context.executionSource.some(l => l.line === 58 && l.text.includes('sat upon')));
  assert.ok(context.executionSource.some(l => l.line === 62 && l.text.includes('great spring')));
  assert.ok(context.executionSource.every(l => l.line <= 65));
});

test('boundary review keeps the player commitment and boarding out of automatic prelude', async () => {
  let calls = 0;
  const starts = await resolveActionBoundaries(async request => {
    calls++;
    assert.ok(request.instructions!.includes(ACTION_ENTRY_PHASE_POLICY));
    if (calls === 1) return response({starts: [{beatIndex: 0, chapterPosition: 0, line: 42, quote: 'But the Scarecrow said'},
      {beatIndex: 1, chapterPosition: 0, line: 49, quote: '“Well, I’ll try it,”'}], issues: []});
    const supplied = JSON.parse(request.input.split('PROPOSED STARTS AND EXACT PRELUDES:\n')[1]!);
    assert.doesNotMatch(supplied[1].excerpt, /I’ll try|sat upon|great spring/);
    return response({valid: true, issues: []});
  }, 'test', book, event);
  const result = sourcePreludeEvidence(book, event.beats.map((b, i) => ({...b, sourceActionStart: starts[i]})), 1);
  assert.match(result.excerpt!, /one at a time/);
  assert.doesNotMatch(result.excerpt!, /I’ll try|sat upon/);
  assert.equal(calls, 2);
});

test('phase repair replaces mounted-before-selection without changing actions, goals or boundary', async () => {
  let calls = 0; const before = structuredClone(index);
  const result = await reviewAndRepairPreconditions(async request => {
    calls++;
    assert.ok(request.instructions!.includes(ACTION_ENTRY_PHASE_POLICY));
    if (calls === 1) return response({valid: false, issues: [issue]});
    if (calls === 2) {
      const input = JSON.parse(request.input);
      assert.ok(input.preconditionSourceContexts[1].executionSource.some((l: any) => l.line === 58));
      return response(patch);
    }
    assert.match(request.input, /ORIGINAL INDEX BEFORE CONDITION REPAIR/);
    return response({valid: true, issues: []});
  }, 'test', part, index);
  const expected = structuredClone(index);
  expected.significantEvents[0]!.beats[1]!.playerAction!.preconditions = replacement;
  assert.deepEqual(result.index, expected); assert.deepEqual(index, before); assert.equal(calls, 3);
});

test('execution evidence cannot be used to pretend that boarding already happened at entry', async () => {
  let calls = 0;
  await assert.rejects(reviewAndRepairPreconditions(async () => response(++calls === 1 ? {valid: false, issues: [issue]} : {
    ...patch, changes: [{...patch.changes[0], evidence: [{line: 58, quote: 'The Scarecrow sat upon the Lion’s back'}]}],
  }), 'test', part, index), /not present before the action/);
  assert.equal(calls, 2);
});

const proposedStarts = [{beatIndex: 0, chapterPosition: 0, line: 42, quote: 'But the Scarecrow said'},
  {beatIndex: 1, chapterPosition: 0, line: 49, quote: '“Well, I’ll try it,”'}];

test('reported gulf phase defect reaches condition repair after independent boundary approval', async () => {
  const notes: unknown[] = []; let calls = 0;
  const starts = await resolveActionBoundaries(async request => {
    calls++;
    assert.match(request.instructions!, /Report incorrect indexed preconditions separately in preconditionIssues/);
    return response(calls === 1
      ? {starts: proposedStarts, issues: [], preconditionIssues: [issue.reason]}
      : {valid: true, issues: [], preconditionIssues: [issue.reason]});
  }, 'test', book, event, (stage, issues) => notes.push({stage, issues}));
  assert.deepEqual(notes, [{stage: 'proposal', issues: [issue.reason]}, {stage: 'review', issues: [issue.reason]}]);
  const input = structuredClone(index);
  input.significantEvents[0]!.beats.forEach((b, i) => { b.sourceActionStart = starts[i]!; });
  const result = await reviewAndRepairPreconditions(async () => {
    calls++;
    return response(calls === 3 ? {valid: false, issues: [issue]} : calls === 4 ? patch : {valid: true, issues: []});
  }, 'test', part, input);
  assert.equal(calls, 5);
  assert.deepEqual(result.index.significantEvents[0]!.beats[1]!.playerAction!.preconditions, replacement);
  assert.equal(result.index.significantEvents[0]!.beats[1]!.sourceActionStart!.line, 49);
  assert.deepEqual(input.significantEvents[0]!.beats[1]!.playerAction!.preconditions,
    index.significantEvents[0]!.beats[1]!.playerAction!.preconditions);
});

test('precondition notes do not bypass real boundary failures or missing coordinates', async () => {
  for (const candidate of [
    {starts: proposedStarts, issues: ['Cannot separate the source action'], preconditionIssues: [issue.reason]},
    {starts: [], issues: [], preconditionIssues: [issue.reason]},
    {starts: proposedStarts, issues: [], preconditionIssues: [123]},
  ]) {
    let calls = 0;
    await assert.rejects(resolveActionBoundaries(async () => { calls++; return response(candidate); }, 'test', book, event),
      /Unresolved action boundaries|Missing or duplicate|Invalid action boundary response/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => response(++calls === 1
    ? {starts: proposedStarts, issues: [], preconditionIssues: [issue.reason]}
    : {valid: false, preconditionIssues: [issue.reason], issues: [{beatIndex: 1, kind: 'wrong_start',
      reason: 'The action starts earlier in the source.', preludeQuote: null}]}), 'test', book, event), /review rejected/);
  assert.equal(calls, 2);
});

test('phase repair still fails when the full independent rereview rejects it', async () => {
  const before = structuredClone(index); let calls = 0;
  await assert.rejects(reviewAndRepairPreconditions(async () => response(++calls === 2 ? patch
    : {valid: false, issues: [issue]}), 'test', part, index));
  assert.equal(calls, 3);
  assert.deepEqual(index, before);
});

test('complete gulf event handles wrapped Tin Woodman onset then repairs conditions without moving actions', async () => {
  const fullEvent = structuredClone(book.storyEvents![0]!);
  const original = structuredClone(fullEvent);
  const startsProposal = {starts: [
    {beatIndex: 0, chapterPosition: 0, line: 47, quote: '“Then we are all right,”'},
    {beatIndex: 1, chapterPosition: 0, line: 49, quote: '“Well, I’ll try it,”'},
    {beatIndex: 2, chapterPosition: 0, line: 66, quote: 'Dorothy thought she would go next;'},
    {beatIndex: 3, chapterPosition: 0, line: 69, quote: 'The Lion went back'},
  ], issues: [], preconditionIssues: [issue.reason]};
  let calls = 0;
  const starts = await resolveActionBoundaries(async request => {
    if (++calls === 1) return response(startsProposal);
    const preludes = JSON.parse(request.input.split('PROPOSED STARTS AND EXACT PRELUDES:\n')[1]!);
    assert.equal(preludes.length, 4);
    assert.match(preludes[3].excerpt, /she was safe on the other side\. $/);
    assert.doesNotMatch(preludes[3].excerpt, /The Lion went back|a third time and got the Tin Woodman/);
    assert.equal(preludes[3].boundaryLine.excludedActionAndRemainder, 'The Lion went back');
    return response({valid: true, issues: [], preconditionIssues: [issue.reason]});
  }, 'test', book, fullEvent);
  assert.equal(calls, 2);
  const fullIndex: ChapterPartSourceIndex = {summary: '', characters: [], actions: [], relationships: [], significantEvents: [{
    description: fullEvent.description, actors: fullEvent.actors, targets: fullEvent.targets, references: [],
    beats: fullEvent.beats!.map(({sourceReferences, ...b}, i) => ({...b, sourceActionStart: starts[i]!,
      references: sourceReferences.map(({lineStart, lineEnd}) => ({lineStart, lineEnd}))})),
  }]};
  const contexts = preconditionSourceContexts(part, fullIndex);
  assert.equal(contexts.length, 4);
  assert.ok(contexts[3]!.executionSource.some(l => l.line === 69 && l.text === 'The Lion went back'));
  const result = await reviewAndRepairPreconditions(async () => response(++calls === 3
    ? {valid: false, issues: [issue]} : calls === 4 ? patch : {valid: true, issues: []}), 'test', part, fullIndex);
  assert.equal(calls, 5);
  fullEvent.beats!.forEach((b, i) => {
    b.sourceActionStart = starts[i]!;
    b.playerAction!.preconditions = result.index.significantEvents[0]!.beats[i]!.playerAction!.preconditions;
  });
  const last = sourcePreludeEvidence(book, fullEvent.beats!, 3);
  assert.deepEqual(last.issues, []);
  assert.match(last.excerpt!, /she was safe on the other side\. $/);
  assert.deepEqual(fullEvent.beats!.map(b => b.sourceReferences), original.beats!.map(b => b.sourceReferences));
  assert.deepEqual(fullEvent.beats![3]!.sourceReferences.map(r => [r.lineStart, r.lineEnd]), [[70, 72]]);
  assert.deepEqual(fullEvent.beats![1]!.playerAction!.preconditions, replacement);
});
