import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type {ImportedBook} from '../src/shared/contracts.js';
import {applyEventPatch} from '../src/books/source-index/event-patch.js';
import {preparePreludeRebuild} from '../src/books/source-index/prepare-prelude-rebuild.js';
import {rebuildSourcePreludes} from '../src/books/source-index/rebuild-preludes.js';
const book: ImportedBook = JSON.parse(await fs.readFile(new URL('./fixtures/oz-second-gulf-index.json', import.meta.url), 'utf8'));
const patch = JSON.parse(await fs.readFile(new URL('./fixtures/repairs/oz-second-gulf.json', import.meta.url), 'utf8'));

test('second gulf repair adds threat and both crossings to every event copy, with valid boundaries', () => {
  const before = structuredClone(book);
  const result = applyEventPatch(book, patch, patch.eventId);
  assert.equal(result.affectedCopies, 6);
  assert.deepEqual(book, before);
  const events = [...result.book.storyEvents!, ...result.book.worldBible!.characterProfiles!.flatMap(p => p.significantEvents ?? [])];
  for (const event of events) {
    assert.equal(event.beats!.length, 9);
    assert.equal(event.beats![2]!.agency, 'external');
    assert.match(event.beats![2]!.action, /begin crossing the tree bridge/);
    assert.match(event.beats![2]!.resultingState!, /Crossing has begun/);
    assert.doesNotMatch(event.beats![2]!.resultingState!, /on the departure side|on the departure bank/);
    assert.equal(event.beats![4]!.actor, 'The Tin Woodman');
    assert.equal(event.beats![5]!.actor, 'The Scarecrow');
    assert.equal(event.beats![6]!.playerAction!.endBeatIndex, 6);
    assert.equal(event.beats![7]!.playerAction!.endBeatIndex, 7);
    assert.equal(event.beats![8]!.playerAction!.endBeatIndex, 8);
    assert.match(event.beats![8]!.resultingState!, /safe together on the destination bank/);
  }
  const rebuilt = rebuildSourcePreludes(result.book, patch.eventId);
  assert.deepEqual(rebuilt.report.flatMap(r => r.issues), []);
  assert.equal(applyEventPatch(rebuilt.book, patch, patch.eventId).changes.length, 0);
});

test('structural repair refuses changed source, copies, overrides and invalid replacement indexes atomically', () => {
  for (const change of [
    (b: ImportedBook, p: any) => {b.chapters[9]!.text += '\n'; b.chapters[9]!.text = b.chapters[9]!.text.replace('the Tin Woodman followed', 'the Tin Woodman stayed');},
    (b: ImportedBook, p: any) => {b.worldBible!.characterProfiles!.find(x => x.significantEvents?.length)!.significantEvents![0]!.beats![3]!.action = 'Different action';},
    (b: ImportedBook, p: any) => {b.storyEvents![0]!.beats![3]!.characterActionGroup = null;},
    (b: ImportedBook, p: any) => {p.beats[4].playerAction.endBeatIndex = 100;},
    (b: ImportedBook, p: any) => {p.beats[4].actor = 'Unknown visitor';},
    (b: ImportedBook, p: any) => {p.beats[4].sourceActionStart.quote = 'not in book';},
  ]) {
    const input = structuredClone(book), candidate = structuredClone(patch);
    change(input, candidate); const before = structuredClone(input);
    assert.throws(() => applyEventPatch(input, candidate, patch.eventId));
    assert.deepEqual(input, before);
  }
});

test('structural source review failure blocks application and further model review', async () => {
  let calls = 0;
  const result = await preparePreludeRebuild(book, {eventId: patch.eventId, eventPatch: patch, model: 'test',
    createResponse: async request => {
      calls++;
      assert.equal(request.text?.format.name, 'bookrpg_structural_event_patch_review');
      const input = JSON.parse(request.input);
      assert.match(input.source.text, /the Tin Woodman followed/);
      assert.equal(input.replacementBeats.length, 9);
      return {status: 'completed', output_text: JSON.stringify({valid: false, reason: 'Needs source correction.'})};
    }});
  assert.equal(calls, 1);
  assert.equal(result.report.reviewed, false);
  assert.ok(result.report.issues.length);
});

test('complete preparation reviews source changes, boundaries and groups before declaring success', async () => {
  const calls: string[] = [];
  const result = await preparePreludeRebuild(book, {eventId: patch.eventId, eventPatch: patch, model: 'test',
    createResponse: async request => {
      calls.push(request.text!.format.name);
      return {status: 'completed', output_text: JSON.stringify({valid: true, reason: 'Supported by source.', issues: []})};
    }});
  assert.equal(result.report.reviewed, true);
  assert.deepEqual(result.report.issues, []);
  assert.equal(calls[0], 'bookrpg_structural_event_patch_review');
  assert.equal(calls.length, 3);
  const lion = result.book.worldBible!.characterProfiles!.find(p => p.name === 'Cowardly Lion')!;
  const roar = lion.significantEvents![0]!.beats![6]! as any;
  assert.match(roar.automaticPreludeSourceExcerpt, /the Tin Woodman followed/);
  assert.match(roar.automaticPreludeSourceExcerpt, /the Scarecrow came next/);
  assert.doesNotMatch(roar.automaticPreludeSourceExcerpt, /so loud and terrible a roar/);
});

test('chapter event copies are repaired too, while unrelated data stays unchanged', () => {
  const input = structuredClone(book);
  const event = input.storyEvents![0]!;
  input.chapters[9]!.sourceIndex = {schemaVersion: 1, summary: 'Unchanged summary', actions: [], characters: [], relationships: [],
    significantEvents: [{description: event.description, beats: structuredClone(event.beats), sourceReferences: event.sourceReferences}]} as any;
  input.storyEvents!.push({...structuredClone(event), eventId: 'unrelated'});
  const result = applyEventPatch(input, patch, patch.eventId);
  assert.equal(result.affectedCopies, 7);
  assert.equal(result.book.chapters[9]!.sourceIndex!.significantEvents![0]!.beats!.length, 9);
  assert.deepEqual(result.book.storyEvents![1], input.storyEvents![1]);
  assert.equal(result.book.chapters[9]!.text, input.chapters[9]!.text);
});
