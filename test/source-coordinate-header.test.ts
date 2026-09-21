import test from 'node:test';
import assert from 'node:assert/strict';
import {formatAnalysisPart, sourceId} from '../src/books/analyze/batching.js';
import {reviewPlayerActionGroups} from '../src/books/analyze/player-action-review.js';
import type {ChapterPartSourceIndex} from '../src/books/source-index.js';

for (const chapterPosition of [0, 9]) {
  test(`source header preserves stored chapter position ${chapterPosition} and independent spine index`, () => {
    const formatted = formatAnalysisPart({chapterPosition, chapterIndex: 23, chapterTitle: 'A chapter',
      sourceId: sourceId(chapterPosition, 2), partIndex: 1, partCount: 3, lineStart: 45, lineEnd: 45, text: 'A source line.'});
    assert.ok(formatted.includes(`CHAPTER_POSITION: ${chapterPosition}\n`));
    assert.ok(formatted.includes(`CHAPTER_NUMBER: ${chapterPosition + 1}\n`));
    assert.ok(formatted.includes('EPUB_SPINE_INDEX: 23\n'));
    assert.ok(formatted.includes(`SOURCE_ID: chapter_${chapterPosition + 1}_part_2\n`));
    assert.match(formatted, /LINE 45: A source line\./);
    assert.match(formatted, /BASES: position\/column=0; number\/line=1/);
  });
}

test('group reviewer receives identical stored and header chapter coordinates for the reported case', async () => {
  const start = {chapterPosition: 9, chapterIndex: 9, line: 49, column: 0, quote: 'The Lion tries.'};
  const index: ChapterPartSourceIndex = {summary: '', characters: [], actions: [], relationships: [], significantEvents: [{
    description: 'Crossing', actors: ['Lion'], targets: [], references: [{lineStart: 49, lineEnd: 49}], beats: [{
      actor: 'Lion', action: 'Tries crossing', agency: 'intentional', stakes: 'significant', targets: [],
      references: [{lineStart: 49, lineEnd: 49}], sourceActionStart: start,
      playerAction: {kind: 'player_action', endBeatIndex: 0, playerBeatIndexes: [0], choiceText: 'Try crossing',
        completion: 'The attempt is complete.', boundaryReason: 'One attempt.', preconditions: [], interruptWhen: []},
    }],
  }]};
  const before = structuredClone(index);
  await reviewPlayerActionGroups(async request => {
    assert.match(request.instructions!, /zero-based CHAPTER_POSITION/);
    assert.match(request.input, /CHAPTER_POSITION: 9\n/);
    assert.match(request.input, /CHAPTER_NUMBER: 10\n/);
    const candidate = JSON.parse(request.input.split('CANDIDATE INDEX:\n')[1]!);
    assert.deepEqual(candidate.significantEvents[0].beats[0].sourceActionStart, start);
    return {status: 'completed', output_text: JSON.stringify({valid: true, issues: []})};
  }, 'test', {sourceId: 'chapter_10_part_1', chapterPosition: 9, chapterIndex: 9, chapterTitle: 'Gulf',
    partIndex: 0, partCount: 1, lineStart: 49, lineEnd: 49, text: 'The Lion tries.'}, index);
  assert.deepEqual(index, before);
});
