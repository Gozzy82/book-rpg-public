import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {preparePreludeRebuild} from '../src/books/source-index/prepare-prelude-rebuild.js';
import type {ImportedBook} from '../src/shared/contracts.js';
const original: ImportedBook = JSON.parse(await fs.readFile(new URL('./fixtures/oz-gulf-action-phases.json', import.meta.url), 'utf8'));
const patch = JSON.parse(await fs.readFile(new URL('./fixtures/repairs/oz-first-gulf.json', import.meta.url), 'utf8'));
const response = (v: unknown) => ({status: 'completed', output_text: JSON.stringify(v)});
const proposal = {starts: patch.beats.map((b: any, beatIndex: number) => ({beatIndex, chapterPosition: 0, line: b.start.line, quote: b.start.quote})),
  issues: [], preconditionIssues: ['Mounted passenger condition is premature.']};

test('normal prelude review finishes despite unrelated metadata and preserves the complete original index', async () => {
  const before = structuredClone(original); const calls: string[] = [];
  const result = await preparePreludeRebuild(original, {eventId: patch.eventId, model: 'test', createResponse: async request => {
    const name = request.text!.format.name; calls.push(name);
    if (name === 'source_action_boundaries') return response(proposal);
    if (name === 'source_action_boundary_review') return response({valid: true, issues: [], preconditionIssues: proposal.preconditionIssues});
    throw new Error('Ordinary prelude rebuild must not review or repair groups: ' + name);
  }});
  assert.equal(calls.length, 2);
  assert.equal(result.report.reviewScope, 'preludes');
  assert.equal(result.report.groupReviewStatus, 'not_requested');
  assert.equal(result.report.reviewStatus, 'passed');
  assert.equal(result.report.boundaryPreconditionIssues.length, 2);
  assert.deepEqual(result.report.conditionRepairs, []);
  assert.deepEqual(result.report.audited, []);
  const withoutDerived = JSON.parse(JSON.stringify(result.book), (key, value) =>
    ['sourceActionStart', 'automaticPreludeSourceExcerpt', 'automaticPreludeEndState'].includes(key) ? undefined : value);
  const baseline = JSON.parse(JSON.stringify(original), (key, value) =>
    ['sourceActionStart', 'automaticPreludeSourceExcerpt', 'automaticPreludeEndState'].includes(key) ? undefined : value);
  assert.deepEqual(withoutDerived, baseline);
  assert.deepEqual(original, before);
});

test('real boundary rejection still blocks ordinary prelude approval', async () => {
  let calls = 0;
  const result = await preparePreludeRebuild(original, {eventId: patch.eventId, model: 'test', createResponse: async () =>
    response(++calls === 1 ? proposal : {valid: false, issues: [{beatIndex: 1, kind: 'wrong_start', reason: 'Wrong first action.', preludeQuote: null}]})});
  assert.equal(result.report.reviewed, false);
  assert.equal(result.report.reviewStatus, 'failed');
  assert.ok(result.report.issues.length);
});

test('event patch requires full group review and reports its rejection unchanged', async () => {
  for (const rejected of [false, true]) {
    const calls: string[] = [];
    const result = await preparePreludeRebuild(original, {eventId: patch.eventId, eventPatch: patch, model: 'test', createResponse: async request => {
      const name = request.text!.format.name; calls.push(name);
      if (name === 'source_action_boundary_review') return response({valid: true, issues: []});
      if (name === 'bookrpg_player_action_group_review') return response(rejected
        ? {valid: false, issues: [{eventIndex: 0, beatIndexes: [2], repairTarget: 'source', reason: 'Material location contradiction.'}]}
        : {valid: true, issues: []});
      throw Error('Unexpected call: ' + name);
    }});
    assert.deepEqual(calls, ['source_action_boundary_review', 'bookrpg_player_action_group_review']);
    assert.equal(result.report.reviewScope, 'event_patch');
    assert.equal(result.report.reviewStatus, rejected ? 'failed' : 'passed');
    assert.equal(result.report.groupReviewStatus, rejected ? 'failed' : 'passed');
    assert.equal(result.report.reviewed, !rejected);
    if (rejected) assert.match(JSON.stringify(result.report.issues), /Material location contradiction/);
  }
});
