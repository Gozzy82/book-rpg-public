import assert from 'node:assert/strict';
import test from 'node:test';
import type {ImportedBook, StoryEventBeat} from '../src/shared/contracts.js';
import {sourcePreludeEvidence, sourcePreludeForBeat} from '../src/books/source-index/story-events.js';
import {rebuildSourcePreludes} from '../src/books/source-index/rebuild-preludes.js';
import {reviewPlayerActionGroups} from '../src/books/analyze/player-action-review.js';
const ref = (start: number, end = start, chapterPosition = 0) => ({chapterPosition, chapterIndex: chapterPosition + 1, lineStart: start, lineEnd: end});
const beat = (action: string, references: ReturnType<typeof ref>[]): StoryEventBeat => ({actor: 'Lion', action, agency: 'intentional', stakes: 'significant', targets: [], sourceReferences: references});
const book = {chapters: [{index: 1, title: 'Lion', text: ['Dorothy helps the Woodman up.', 'They talk about Toto.', 'Dorothy asks why Lion is a coward.', 'Lion explains his fear.', 'They discuss Oz.'].join('\n')}]};
const beats = [beat('Helps the Woodman up', [ref(1)]), beat('Explains his fear', [ref(4)])];
test('prelude includes the omitted question and stops before the unselected answer', () => {
  const result = sourcePreludeEvidence(book, beats, 1);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.references, [ref(1, 3)]);
  assert.match(result.excerpt!, /Dorothy asks why/);
  assert.doesNotMatch(result.excerpt!, /Lion explains|discuss Oz/);
  assert.equal(sourcePreludeForBeat(book, beats, 1), result.excerpt);
});
test('continuous evidence fills gaps between earlier references too', () => {
  const result = sourcePreludeEvidence(book, [beat('First', [ref(1)]), beat('Second', [ref(3)]), beat('Next', [ref(5)])], 2);
  assert.equal(result.excerpt, book.chapters[0]!.text.split('\n').slice(0, 4).join('\n'));
});
test('overlap is reported and the shared pending-action line never leaks', () => {
  const result = sourcePreludeEvidence(book, [beat('Before', [ref(1, 4)]), beats[1]!], 1);
  assert.match(result.issues[0]!, /overlap/);
  assert.doesNotMatch(result.excerpt!, /Lion explains/);
});
test('cross-chapter gap includes the complete intervening passage', () => {
  const chapters = [...book.chapters, {index: 2, title: 'Next', text: 'A question.\nAn answer.'}];
  const result = sourcePreludeEvidence({chapters}, [beats[0]!, beat('Answer', [ref(2, 2, 1)])], 1);
  assert.deepEqual(result.references, [ref(1, 5), ref(1, 1, 1)]);
  assert.match(result.excerpt!, /A question/); assert.doesNotMatch(result.excerpt!, /An answer/);
});
test('missing and invalid boundaries cannot be certified', () => {
  assert.match(sourcePreludeEvidence(book, [beats[0]!, beat('Missing', [])], 1).issues[0]!, /no source boundary/);
  assert.throws(() => sourcePreludeEvidence(book, [beats[0]!, beat('Invalid', [ref(99)])], 1), /Cannot extract/);
});
test('rebuild replaces stale excerpts while preserving character-specific annotations and original input', () => {
  const event = {eventId: 'lion', sequence: 1, chapterPosition: 0, description: 'Lion speaks', actors: ['Lion'], targets: [], sourceReferences: [ref(1, 4)], beats};
  const grouped = {...beats[1]!, characterActionGroup: {marker: 'preserve'}, automaticPreludeSourceExcerpt: 'stale'};
  const original = {...book, bookId: 'oz', storyEvents: [event], worldBible: {characterProfiles: [{name: 'Lion', aliases: [], significantEvents: [{...event, beats: [beats[0]!, grouped]}]}]}} as unknown as ImportedBook;
  const before = structuredClone(original), rebuilt = rebuildSourcePreludes(original);
  const enriched = rebuilt.book.worldBible!.characterProfiles![0]!.significantEvents![0]!.beats![1]! as typeof grouped;
  assert.match(enriched.automaticPreludeSourceExcerpt, /Dorothy asks why/);
  assert.deepEqual(enriched.characterActionGroup, grouped.characterActionGroup);
  assert.deepEqual(rebuilt.book.storyEvents, original.storyEvents);
  assert.deepEqual(original, before);
  assert.equal(rebuilt.report.filter(r => r.issues.length).length, 0);
  assert.deepEqual(rebuildSourcePreludes(rebuilt.book).book, rebuilt.book);
});
test('import review requires precondition source evidence and rejects ambiguous setup boundaries', async () => {
  const index = {summary: '', significantEvents: [{description: '', actors: ['Lion'], targets: [], references: [{lineStart: 1, lineEnd: 4}], beats: [{...beats[1], references: [{lineStart: 4, lineEnd: 4}], playerAction: {preconditions: ['Dorothy has asked why.'], playerBeatIndexes: [0], endBeatIndex: 0}}]}], characters: [], actions: [], relationships: []} as any;
  await assert.rejects(() => reviewPlayerActionGroups(async request => {
    assert.match(request.instructions!, /PRECONDITION EVIDENCE/);
    assert.match(request.instructions!, /PRELUDE COVERAGE/);
    assert.match(request.instructions!, /shares a line with the pending action/);
    return {status: 'completed', output_text: JSON.stringify({valid: false, issues: [{eventIndex: 0, beatIndexes: [0], repairTarget: 'source', reason: 'Question and answer share the entry boundary; split setup evidence.'}]})};
  }, 'test', {sourceId: 'lion', chapterPosition: 0, chapterIndex: 1, chapterTitle: 'Lion', partIndex: 0, partCount: 1, lineStart: 1, lineEnd: 5, text: book.chapters[0]!.text}, index), /split setup evidence/);
});

test('rebuild CLI writes a reviewable copy and report without altering the input file', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prelude-cli-'));
  try {
    const event = {eventId: 'lion', sequence: 1, chapterPosition: 0, description: 'Lion speaks', actors: ['Lion'], targets: [], sourceReferences: [ref(1, 4)], beats};
    const input = JSON.stringify({...book, bookId: 'oz', storyEvents: [event], worldBible: {characterProfiles: [{name: 'Lion', aliases: [], significantEvents: [event]}]}});
    const file = path.join(dir, 'book.json'); await fs.writeFile(file, input);
    const {stdout} = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/books/rebuild-source-preludes-cli.ts', '--file', file], {env: {...process.env, BOOKRPG_DATA_DIR: dir}});
    const result = JSON.parse(stdout);
    assert.equal(result.applied, false); assert.equal(result.reviewed, false); assert.equal(result.issues, 0);
    assert.equal(await fs.readFile(file, 'utf8'), input);
    const output = JSON.parse(await fs.readFile(path.join(result.directory, 'rebuilt-book.json'), 'utf8'));
    assert.match(output.worldBible.characterProfiles[0].significantEvents[0].beats[1].automaticPreludeSourceExcerpt, /Dorothy asks why/);
    assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, 'report.json'), 'utf8')).coverage.length, 4);
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/books/rebuild-source-preludes-cli.ts', '--file', file, '--apply'], {env: {...process.env, BOOKRPG_DATA_DIR: dir}}), /separate rebuilt-book/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
