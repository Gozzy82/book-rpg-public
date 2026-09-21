import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type {ImportedBook} from '../src/shared/contracts.js';
import {applyEventPatch} from '../src/books/source-index/event-patch.js';
import {rebuildSourcePreludes} from '../src/books/source-index/rebuild-preludes.js';
import {resolveActionBoundaries} from '../src/books/source-index/action-boundaries.js';
import {reviewAndRepairPreconditions} from '../src/books/analyze/precondition-repair.js';
import type {ChapterPartSourceIndex} from '../src/books/source-index.js';
const fixture: ImportedBook = JSON.parse(await fs.readFile(new URL('./fixtures/oz-gulf-action-phases.json', import.meta.url), 'utf8'));
const patch = JSON.parse(await fs.readFile(new URL('./fixtures/repairs/oz-first-gulf.json', import.meta.url), 'utf8'));
const id = patch.eventId;
const response = (value: unknown) => ({status: 'completed', output_text: JSON.stringify(value)});
function withCopies() {
  const book = structuredClone(fixture);
  book.storyEvents!.push({...structuredClone(book.storyEvents![0]!), eventId: 'unrelated'});
  book.worldBible = {...book.worldBible, characterProfiles: ['The Cowardly Lion', 'Dorothy', 'The Scarecrow'].map(name => ({
    name, aliases: [], significantEvents: structuredClone(book.storyEvents),
  }))} as ImportedBook['worldBible'];
  return book;
}

test('source-locked event patch updates every copy, preserves unrelated data, and is idempotent', () => {
  const original = withCopies(), before = structuredClone(original);
  const result = applyEventPatch(original, patch, id);
  assert.equal(result.affectedCopies, 4);
  assert.equal(result.changes.length, 16);
  assert.deepEqual(original, before);
  const events = [result.book.storyEvents![0]!, ...result.book.worldBible!.characterProfiles!.map(p => p.significantEvents![0]!)];
  for (const event of events) {
    assert.equal(event.beats![0]!.playerAction!.endBeatIndex, 0);
    assert.match(event.beats![0]!.playerAction!.completion, /decision.*remains open/);
    assert.doesNotMatch(event.beats![1]!.playerAction!.preconditions.join(), /has mounted/);
    assert.match(event.beats![2]!.resultingState!, /Lion are on the far side/);
    assert.match(event.beats![3]!.playerAction!.choiceText, /Return for the Tin Woodman/);
    assert.equal(event.beats![3]!.sourceActionStart!.line, 69);
    event.beats!.forEach((beat, i) => {
      assert.equal(beat.actor, before.storyEvents![0]!.beats![i]!.actor);
      assert.equal(beat.action, before.storyEvents![0]!.beats![i]!.action);
      assert.deepEqual(beat.sourceReferences, before.storyEvents![0]!.beats![i]!.sourceReferences);
      assert.deepEqual(beat.playerAction!.playerBeatIndexes, [i]);
    });
  }
  assert.deepEqual(result.book.storyEvents![1], before.storyEvents![1]);
  assert.deepEqual(result.book.chapters, before.chapters);
  assert.deepEqual(applyEventPatch(result.book, patch, id).book, result.book);
  assert.equal(applyEventPatch(result.book, patch, id).changes.length, 0);
});

test('patch rejects stale source, changed beats or incompatible groups without partial mutation', () => {
  for (const mutate of [
    (b: ImportedBook) => { b.chapters[0]!.text = b.chapters[0]!.text.replace('The Lion went back', 'The Lion stayed'); },
    (b: ImportedBook) => { b.worldBible!.characterProfiles![1]!.significantEvents![0]!.beats![0]!.actor = 'Dorothy'; },
    (b: ImportedBook) => { b.storyEvents![0]!.beats![1]!.playerAction!.endBeatIndex = 3; },
    (b: ImportedBook) => { b.storyEvents![0]!.beats![3]!.sourceReferences[0]!.lineStart = 69; },
  ]) {
    const book = withCopies(); mutate(book); const before = structuredClone(book);
    assert.throws(() => applyEventPatch(book, patch, id), /Patch|patch/);
    assert.deepEqual(book, before);
  }
  const bad = structuredClone(patch); bad.beats[0].playerAction.endBeatIndex = 3;
  assert.throws(() => applyEventPatch(fixture, bad, id), /only replace/);
});

test('disabled character groups stay disabled; compatible overrides receive corrected text', () => {
  const book = withCopies();
  const beats = book.worldBible!.characterProfiles![0]!.significantEvents![0]!.beats!;
  beats[0]!.characterActionGroup = null;
  beats[1]!.characterActionGroup = structuredClone(beats[1]!.playerAction!);
  const updated = applyEventPatch(book, patch, id).book.worldBible!.characterProfiles![0]!.significantEvents![0]!.beats!;
  assert.equal(updated[0]!.characterActionGroup, null);
  assert.deepEqual(updated[1]!.characterActionGroup!.preconditions, patch.beats[1].playerAction.preconditions);
});

test('rebuild uses corrected checkpoint and stops before the final return', () => {
  const updated = applyEventPatch(withCopies(), patch, id).book;
  const rebuilt = rebuildSourcePreludes(updated, id);
  assert.ok(rebuilt.report.every(r => !r.issues.length));
  const lion = rebuilt.book.worldBible!.characterProfiles![0]!.significantEvents![0]!;
  assert.match(lion.beats![3]!.automaticPreludeEndState!, /Lion are on the far side/);
  const excerpt = (lion.beats![3] as any).automaticPreludeSourceExcerpt;
  assert.match(excerpt, /she was safe on the other side\. $/);
  assert.doesNotMatch(excerpt, /The Lion went back/);
});

test('explicit patch boundaries skip discovery but still require independent audit and whole-event review', async () => {
  const book = applyEventPatch(fixture, patch, id).book, event = book.storyEvents![0]!;
  let calls = 0;
  const starts = await resolveActionBoundaries(async request => {
    calls++;
    assert.match(request.input, /PROPOSED STARTS AND EXACT PRELUDES/);
    return response({valid: true, issues: []});
  }, 'test', book, event, undefined, event.beats!.map(b => b.sourceActionStart!));
  assert.equal(calls, 1);
  assert.deepEqual(starts, event.beats!.map(b => b.sourceActionStart));
  const index: ChapterPartSourceIndex = {summary: '', characters: [], actions: [], relationships: [], significantEvents: [{
    description: event.description, actors: event.actors, targets: event.targets, references: [],
    beats: event.beats!.map(({sourceReferences, ...b}) => ({...b, references: sourceReferences.map(({lineStart, lineEnd}) => ({lineStart, lineEnd}))})),
  }]};
  const chapter = book.chapters[0]!;
  await reviewAndRepairPreconditions(async request => {
    calls++;
    assert.match(request.instructions!, /PROPOSAL VERSUS EXECUTION/);
    assert.match(request.instructions!, /Intermediate steps such as boarding/);
    assert.match(request.input, /Return for the Tin Woodman/);
    return response({valid: true, issues: []});
  }, 'test', {sourceId: id, chapterPosition: 0, chapterIndex: chapter.index, chapterTitle: chapter.title,
    partIndex: 0, partCount: 1, lineStart: 1, lineEnd: chapter.text.trim().split('\n').length, text: chapter.text.trim()}, index);
  assert.equal(calls, 2);
  await assert.rejects(resolveActionBoundaries(async () => response({valid: false, issues: [{beatIndex: 3,
    kind: 'wrong_start', reason: 'A genuine source mismatch.', preludeQuote: null}]}),
  'test', book, event, undefined, starts), /genuine source mismatch/);
});
