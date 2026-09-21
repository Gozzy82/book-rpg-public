import assert from 'node:assert/strict';
import test from 'node:test';
import type {ImportedBook, BookStoryEvent, StoryEventBeat} from '../src/shared/contracts.js';
import {sourcePreludeEvidence, validateSourceActionStart} from '../src/books/source-index/story-events.js';
import {ActionBoundaryReviewError, actionBoundaryKey, resolveActionBoundaries} from '../src/books/source-index/action-boundaries.js';
import {rebuildSourcePreludes} from '../src/books/source-index/rebuild-preludes.js';

const ref = (lineStart: number, lineEnd = lineStart) => ({chapterPosition: 0, chapterIndex: 1, lineStart, lineEnd});
const beat = (action: string, sourceReferences: ReturnType<typeof ref>[]): StoryEventBeat => ({actor: 'Lion', action, agency: 'intentional', stakes: 'significant', targets: [], sourceReferences});
const text = 'Dorothy helps her friends.\nThey talk about Toto.\nDorothy asks why. Lion explains his fear.\nThey discuss Oz.\nLater corroboration of the rescue.';
const beats = [beat('Helps her friends', [ref(1), ref(5)]), beat('Explains his fear', [ref(3)])];
const event = {eventId: 'lion', sequence: 1, chapterPosition: 0, description: 'Conversation', actors: ['Lion'], targets: [], sourceReferences: [ref(1, 5)], beats} as BookStoryEvent;
const book = {bookId: 'oz', chapters: [{index: 1, title: 'Lion', text}], storyEvents: [event], worldBible: {characterProfiles: [{name: 'Lion', aliases: [], significantEvents: [event]}]}} as unknown as ImportedBook;
const start = {chapterPosition: 0, chapterIndex: 1, line: 3, column: 18, quote: 'Lion explains'};
const proposal = {starts: [{beatIndex: 0, chapterPosition: 0, line: 1, quote: 'Dorothy helps'}, {beatIndex: 1, chapterPosition: 0, line: 3, quote: 'Lion explains'}], issues: []};
const response = (value: unknown) => ({status: 'completed', output_text: JSON.stringify(value)});

test('same-line question is included without answer, despite later corroboration', () => {
  const result = sourcePreludeEvidence(book, [beats[0]!, {...beats[1]!, sourceActionStart: start}], 1);
  assert.deepEqual(result.issues, []);
  assert.equal(result.warnings?.length, 1);
  assert.equal(result.excerpt, 'Dorothy helps her friends.\nThey talk about Toto.\nDorothy asks why. ');
  assert.deepEqual(result.actionStart, start);
  assert.doesNotMatch(result.excerpt!, /Lion explains|corroboration/);
});
test('explicit onset supports setup inside the first beat evidence too', () => {
  const result = sourcePreludeEvidence(book, [{...beats[1]!, sourceActionStart: start}], 0);
  assert.equal(result.excerpt, 'Dorothy asks why. ');
});
test('invalid quote, column, chapter and out-of-evidence onset are rejected', () => {
  for (const invalid of [{...start, column: 19}, {...start, column: -1}, {...start, quote: ''}, {...start, chapterIndex: 9}, {...start, line: 4, column: 0, quote: 'They'}])
    assert.throws(() => validateSourceActionStart(book, beats[1]!, invalid), /Invalid source action start/);
});
test('true reversed action order remains an error with valid overlapping evidence', () => {
  const late = {...beat('Later', [ref(3)]), sourceActionStart: start};
  const earlier = {...beat('Earlier', [ref(1)]), sourceActionStart: {...start, line: 1, column: 0, quote: 'Dorothy'}};
  assert.match(sourcePreludeEvidence(book, [late, earlier], 1).issues.join(), /out of order/);
});
test('resolver derives exact columns and independently reviews actual extracted setup', async () => {
  let calls = 0;
  const result = await resolveActionBoundaries(async request => {
    calls++;
    if (calls === 1) return response(proposal);
    assert.match(request.instructions!, /FIRST performance/);
    const preludes = JSON.parse(request.input.split('PROPOSED STARTS AND EXACT PRELUDES:\n')[1]!);
    assert.match(preludes[1].excerpt, /Dorothy asks why/);
    assert.doesNotMatch(preludes[1].excerpt, /Lion explains/);
    return response({valid: true, issues: []});
  }, 'test', book, event);
  assert.equal(calls, 2); assert.deepEqual(result[1], start);
});
test('exact quote alone does not approve a semantically wrong onset', async () => {
  let calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => response(++calls === 1 ? proposal : {valid: false, issues: [{beatIndex: 1, kind: 'wrong_start', reason: 'Earlier action already performed.', preludeQuote: null}]}), 'test', book, event), /Earlier action/);
});
test('incomplete, duplicate, ambiguous and fabricated model boundaries cannot reach review', async () => {
  const cases = [
    {...proposal, starts: proposal.starts.slice(0, 1)},
    {...proposal, starts: [proposal.starts[0], proposal.starts[0]]},
    {...proposal, starts: [proposal.starts[0], {...proposal.starts[1], quote: 'Not in source'}]},
    {...proposal, issues: ['Action cannot be separated']},
  ];
  for (const candidate of cases) {
    let calls = 0;
    await assert.rejects(resolveActionBoundaries(async () => {calls++; return response(candidate);}, 'test', book, event));
    assert.equal(calls, candidate.starts.some(s => s?.quote === 'Not in source') ? 2 : 1);
  }
  const repeated = {...book, chapters: [{...book.chapters[0]!, text: text.replace('Lion explains his fear.', 'Lion explains. Lion explains.')} ]};
  await assert.rejects(resolveActionBoundaries(async () => response(proposal), 'test', repeated, event), /ambiguous/);
});
test('targeted rebuild preserves unrelated events, annotations and original evidence', () => {
  const original = structuredClone(book);
  const other = {...event, eventId: 'other'};
  original.storyEvents!.push(other);
  original.worldBible!.characterProfiles![0]!.significantEvents!.push(other);
  for (const e of [original.storyEvents![0]!, original.worldBible!.characterProfiles![0]!.significantEvents![0]!]) e.beats![1]!.sourceActionStart = start;
  const before = structuredClone(original);
  const rebuilt = rebuildSourcePreludes(original, 'lion');
  assert.deepEqual(rebuilt.book.storyEvents![1], other);
  assert.deepEqual(rebuilt.book.worldBible!.characterProfiles![0]!.significantEvents![1], other);
  assert.deepEqual(original, before);
  assert.ok(rebuilt.report.every(r => r.eventId === 'lion'));
  assert.deepEqual(rebuilt.book.storyEvents![0]!.beats![1]!.sourceReferences, [ref(3)]);
  assert.throws(() => rebuildSourcePreludes(original, 'absent'), /Unknown/);
  assert.equal(actionBoundaryKey(event), actionBoundaryKey({...event, beats: event.beats!.map(b => ({...b, resultingState: 'annotation'}))}));
});


test('actual Oz index includes Dorothy question at 67–68 and excludes Lion answer at 69', async () => {
  const fs = await import('node:fs/promises');
  const original: ImportedBook = JSON.parse(await fs.readFile(new URL('./fixtures/oz-lion-action-boundaries.json', import.meta.url), 'utf8'));
  const event = original.storyEvents![0]!;
  const originalRefs = structuredClone(event.beats![1]!.sourceReferences);
  const old = sourcePreludeEvidence(original, event.beats!, 1);
  assert.doesNotMatch(old.excerpt!, /What makes you a coward/);
  event.beats![1]!.sourceActionStart = {chapterPosition: 0, chapterIndex: 8, line: 69, column: 0, quote: '“It’s a mystery,” replied the Lion.'};
  const repaired = sourcePreludeEvidence(original, event.beats!, 1);
  assert.deepEqual(repaired.issues, []);
  assert.match(repaired.excerpt!, /What makes you a coward/);
  assert.match(repaired.excerpt!, /as big as a small horse/);
  assert.doesNotMatch(repaired.excerpt!, /It’s a mystery/);
  assert.deepEqual(event.beats![1]!.sourceReferences, originalRefs);
  assert.deepEqual(repaired.references.map(r => [r.lineStart, r.lineEnd]), [[48, 68]]);
});

test('actual Oz pick boundary excludes pick; fabricated prelude evidence gets one full rereview', async () => {
  const fs = await import('node:fs/promises');
  const original: ImportedBook = JSON.parse(await fs.readFile(new URL('./fixtures/oz-lion-action-boundaries.json', import.meta.url), 'utf8'));
  const event = {...original.storyEvents![0]!, beats: original.storyEvents![0]!.beats!.slice(0, 2)};
  let calls = 0;
  const starts = await resolveActionBoundaries(async request => {
    calls++;
    if (calls === 1) return response({starts: [
      {beatIndex: 0, chapterPosition: 0, line: 48, quote: 'pick'},
      {beatIndex: 1, chapterPosition: 0, line: 69, quote: '“It’s a mystery,”'},
    ], issues: []});
    const input = request.input.split('PROPOSED STARTS AND EXACT PRELUDES:\n')[1]!.split('\nLITERAL EVIDENCE CHECK FAILED:')[0]!;
    const preludes = JSON.parse(input);
    assert.ok(preludes[0].excerpt.endsWith('watched her '));
    assert.doesNotMatch(preludes[0].excerpt, /pick/);
    assert.equal(preludes[0].boundaryLine.excludedActionAndRemainder, 'pick');
    if (calls === 2) return response({valid: false, issues: [{beatIndex: 0, kind: 'prelude_contains_action', reason: 'Prelude contains watched her pick.', preludeQuote: 'watched her pick'}]});
    assert.match(request.input, /is not present in its exact excerpt/);
    assert.match(request.input, /full independent review again/);
    return response({valid: true, issues: []});
  }, 'test', original, event);
  assert.equal(calls, 3);
  assert.equal(starts[0]!.quote, 'pick');
});

test('repeated unsupported review claims fail closed and retain exact diagnostic evidence', async () => {
  const {ActionBoundaryReviewError} = await import('../src/books/source-index/action-boundaries.js');
  let calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => response(++calls === 1 ? proposal : {valid: false, issues: [
    {beatIndex: 1, kind: 'prelude_contains_action', reason: 'Answer is included.', preludeQuote: 'Lion explains'},
  ]}), 'test', book, event), (error: unknown) => {
    assert.ok(error instanceof ActionBoundaryReviewError);
    assert.match(error.message, /unsupported evidence/);
    const diagnostics = error.diagnostics as any;
    assert.equal(diagnostics.reviews.length, 2);
    assert.deepEqual(diagnostics.starts[1], start);
    assert.doesNotMatch(diagnostics.preludes[1].excerpt, /Lion explains/);
    assert.equal(diagnostics.preludes[1].boundaryLine.excludedActionAndRemainder, 'Lion explains his fear.');
    return true;
  });
  assert.equal(calls, 3);
});

test('a supported semantic failure after rereview still blocks the repair', async () => {
  let calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => {
    calls++;
    if (calls === 1) return response(proposal);
    return response({valid: false, issues: calls === 2
      ? [{beatIndex: 1, kind: 'prelude_contains_action', reason: 'Answer is included.', preludeQuote: 'Lion explains'}]
      : [{beatIndex: 1, kind: 'missing_setup', reason: 'Required arrival is missing.', preludeQuote: null}]});
  }, 'test', book, event), /Required arrival is missing/);
  assert.equal(calls, 3);
});

test('literal prelude evidence rejects directly without retry', async () => {
  let calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => response(++calls === 1 ? proposal : {valid: false, issues: [
    {beatIndex: 1, kind: 'prelude_contains_action', reason: 'Source contradicts the claimed boundary.', preludeQuote: 'Dorothy asks why.'},
  ]}), 'test', book, event), /Source contradicts/);
  assert.equal(calls, 2);
});

test('mixed supported and fabricated rejection is never retried into an approval', async () => {
  let calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => response(++calls === 1 ? proposal : {valid: false, issues: [
    {beatIndex: 1, kind: 'prelude_contains_action', reason: 'Answer is included.', preludeQuote: 'Lion explains'},
    {beatIndex: 1, kind: 'wrong_start', reason: 'An earlier performance exists in source.', preludeQuote: null},
  ]}), 'test', book, event), /An earlier performance exists/);
  assert.equal(calls, 2);
});

test('one literal coordinate correction preserves valid starts and still requires independent audit', async () => {
  const invalid = {...proposal, starts: [proposal.starts[0], {...proposal.starts[1], line: 2}]};
  let calls = 0;
  const result = await resolveActionBoundaries(async request => {
    calls++;
    if (calls === 1) return response(invalid);
    if (calls === 2) {
      const feedback = JSON.parse(request.input.split('LITERAL COORDINATE ERRORS:\n')[1]!.split('\nReturn the complete')[0]!);
      assert.equal(feedback.errors[0].reason, 'quote_not_in_line');
      assert.equal(feedback.errors[0].sourceLine, 'They talk about Toto.');
      assert.equal(feedback.errors[0].beatIndex, 1);
      assert.equal(feedback.lockedStarts.length, 1);
      assert.equal(feedback.lockedStarts[0].beatIndex, 0);
      return response(proposal);
    }
    assert.match(request.input, /PROPOSED STARTS AND EXACT PRELUDES/);
    return response({valid: true, issues: []});
  }, 'test', book, event);
  assert.equal(calls, 3);
  assert.deepEqual(result[1], start);
});

test('failed coordinate correction records both proposals, offending quote and actual source line', async () => {
  const invalid = {...proposal, starts: [proposal.starts[0], {...proposal.starts[1], quote: 'Lion explains his fear. They discuss Oz.'}]};
  let calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => {calls++; return response(invalid);}, 'test', book, event), error => {
    assert.ok(error instanceof ActionBoundaryReviewError);
    const diagnostics = error.diagnostics as any;
    assert.equal(diagnostics.proposals.length, 2);
    assert.equal(diagnostics.details[0].quote, invalid.starts[1]!.quote);
    assert.equal(diagnostics.details[0].sourceLine, 'Dorothy asks why. Lion explains his fear.');
    assert.equal(diagnostics.details[0].reason, 'quote_not_in_line');
    return true;
  });
  assert.equal(calls, 2);
});

test('coordinate repair cannot change a valid start or bypass semantic boundary rejection', async () => {
  const invalid = {...proposal, starts: [proposal.starts[0], {...proposal.starts[1], line: 2}]};
  let calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => response(++calls === 1 ? invalid : {
    ...proposal, starts: [{...proposal.starts[0], quote: 'Dorothy'}, proposal.starts[1]],
  }), 'test', book, event), /changed a locked boundary/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => response(++calls === 1 ? invalid : calls === 2 ? proposal
    : {valid: false, issues: [{beatIndex: 1, kind: 'wrong_start', reason: 'The source action already began.', preludeQuote: null}]}),
  'test', book, event), /source action already began/);
  assert.equal(calls, 3);
});

test('ambiguous quote can be disambiguated only with exact source evidence and full audit', async () => {
  const repeated = {...book, chapters: [{...book.chapters[0]!, text: text.replace('Lion explains his fear.', 'Lion explains his fear. Lion explains again.')} ]};
  let calls = 0;
  const result = await resolveActionBoundaries(async () => response(++calls === 1 ? proposal : calls === 2
    ? {...proposal, starts: [proposal.starts[0], {...proposal.starts[1], quote: 'Lion explains his fear.'}]}
    : {valid: true, issues: []}), 'test', repeated, event);
  assert.equal(calls, 3);
  assert.equal(result[1]!.column, 18);
});

test('wrapped source onset admits only the adjacent unfinished prefix, not earlier sentences or gaps', () => {
  const wrappedBook = {...book, chapters: [{index: 1, title: 'Source', text: 'Earlier event.\nDorothy arrives. The Lion went back\na third time and got the Tin Woodman.'}]};
  const wrappedBeat = beat('Carries the Tin Woodman', [ref(3)]);
  const boundary = {...start, line: 2, column: 17, quote: 'The Lion went back'};
  assert.doesNotThrow(() => validateSourceActionStart(wrappedBook, wrappedBeat, boundary));
  for (const invalid of [
    {...boundary, line: 1, column: 0, quote: 'Earlier event'},
    {...boundary, column: 0, quote: 'Dorothy arrives'},
    {...boundary, chapterIndex: 2},
    {...boundary, column: 18},
  ]) assert.throws(() => validateSourceActionStart(wrappedBook, wrappedBeat, invalid), /Invalid source action start/);
  for (const separator of ['.', '!', '?', '…']) {
    const separated = {...wrappedBook, chapters: [{...wrappedBook.chapters[0]!, text: `Earlier event.\nDorothy arrives. The Lion went back${separator}\na third time and got the Tin Woodman.`}]};
    assert.throws(() => validateSourceActionStart(separated, wrappedBeat, boundary), /Invalid source action start/);
  }
  const blank = {...wrappedBook, chapters: [{...wrappedBook.chapters[0]!, text: 'Earlier event.\nDorothy arrives. The Lion went back\n\na third time and got the Tin Woodman.'}]};
  assert.throws(() => validateSourceActionStart(blank, beat('Carry', [ref(4)]), boundary), /Invalid source action start/);
});

test('report 9 prior actions are attributed to their own beats and require a fresh full audit', async () => {
  const fs = await import('node:fs/promises');
  const original: ImportedBook = JSON.parse(await fs.readFile(new URL('./fixtures/oz-lion-action-boundaries.json', import.meta.url), 'utf8'));
  const captured = JSON.parse(await fs.readFile(new URL('./fixtures/oz-lion-boundary-review-history.json', import.meta.url), 'utf8'));
  const wrongHistoryVerdict = {...captured.review, issues: captured.review.issues.map((issue: any) => ({...issue, performedBeatIndex: issue.beatIndex - 1}))};
  for (const outcome of ['approve', 'repeat', 'real_failure'] as const) {
    let calls = 0;
    const run = () => resolveActionBoundaries(async request => {
      calls++;
      if (calls === 1) return response(captured.proposal);
      assert.match(request.instructions!, /RELATIVE TO each row/);
      const supplied = JSON.parse(request.input.split('PROPOSED STARTS AND EXACT PRELUDES:\n')[1]!.split('\nLITERAL EVIDENCE CHECK FAILED:')[0]!);
      assert.equal(supplied[1].pendingBeat.beatIndex, 1);
      assert.equal(supplied[1].precedingBeats[0].actor, 'Dorothy');
      assert.match(supplied[1].excerpt, /What makes you a coward/);
      assert.doesNotMatch(supplied[1].excerpt, /It’s a mystery/);
      assert.match(supplied[2].excerpt, /It’s a mystery/);
      if (calls === 2) return response(wrongHistoryVerdict);
      assert.match(request.input, /cited action is preceding beat 0/);
      assert.match(request.input, /full independent review again/);
      if (outcome === 'repeat') return response(wrongHistoryVerdict);
      if (outcome === 'real_failure') return response({valid: false, issues: [{beatIndex: 5, performedBeatIndex: null,
        kind: 'wrong_start', reason: 'The pending action begins earlier in this source.', preludeQuote: null}]});
      return response({valid: true, issues: []});
    }, 'test', original, original.storyEvents![0]!);
    if (outcome === 'approve') assert.equal((await run()).length, 6);
    else await assert.rejects(run(), outcome === 'repeat' ? /unsupported evidence/ : /pending action begins earlier/);
    assert.equal(calls, 3);
  }
});

test('a mixed earlier-history complaint and genuine pending action leak still blocks immediately', async () => {
  let calls = 0;
  await assert.rejects(resolveActionBoundaries(async () => response(++calls === 1 ? proposal : {valid: false, issues: [
    {beatIndex: 1, performedBeatIndex: 0, kind: 'prelude_contains_action', reason: 'Earlier history is included.', preludeQuote: 'Dorothy helps'},
    {beatIndex: 1, performedBeatIndex: 1, kind: 'prelude_contains_action', reason: 'A real pending action leak.', preludeQuote: 'Dorothy asks why.'},
  ]}), 'test', book, event), /real pending action leak/);
  assert.equal(calls, 2);
});
