import test from "node:test";
import assert from "node:assert/strict";
import {createImportRun, ImportRunStopped} from "../src/books/analyze/import-run.js";
import {sourceFieldRepairJobs} from "../src/books/analyze/source-field-repair.js";
import {sourceEventRepairJobs, assertNoNewExactDuplicateBeats} from "../src/books/analyze/source-event-repair.js";
import {analyzeBook} from "../src/books/analyze/orchestrator.js";
import {buildChapterAnalysisBatches} from "../src/books/analyze/batching.js";
import type {ImportedBook} from "../src/shared/contracts.js";
const reply = (v: unknown) => ({status: "completed" as const, output_text: JSON.stringify(v)});

test("temporary failures retry the identical request, semantic errors do not, and budgets halt", async () => {
  let calls = 0;
  const requests: unknown[] = [];
  const run = createImportRun(async request => {
    requests.push(request);
    if (++calls < 3) throw Object.assign(new Error("temporary"), {status: 503});
    return {...reply({}), usage: {input_tokens: 6, output_tokens: 4, total_tokens: 10}};
  }, {maxCalls: 3, maxTokens: 10, wait: async () => {}, log: () => {}});
  const request = {model: "mock", input: "test"};
  await run.provider(request);
  assert.ok(requests.every(r => r === request));
  await assert.rejects(run.provider(request), ImportRunStopped);
  assert.deepEqual(run.stats, {calls: 3, tokens: 10});
  let errors = 0;
  const other = createImportRun(async () => {errors++; throw new Error("semantic");});
  await assert.rejects(other.provider(request), /semantic/);
  assert.equal(errors, 1);
});

test("authorization and quota failures stop the entire run immediately", async () => {
  for (const error of [{status: 401}, {status: 403}, {status: 429, error: {code: "insufficient_quota"}}]) {
    const run = createImportRun(async () => {throw error;});
    await assert.rejects(run.provider({model: "mock", input: "test"}), ImportRunStopped);
    assert.equal(run.stats.calls, 1);
  }
});

test("repair units keep correlated beat fields together and separate unrelated summary defects", () => {
  const action = "/significantEvents/3/beats/3/action", state = "/significantEvents/3/beats/3/resultingState";
  const jobs = sourceFieldRepairJobs({fields: ["/summary", action, state], reason: "mixed",
    evidence: [{path: "/summary", findings: [{reason: "wrong causal subject"}]},
      {path: action, findings: [{reason: "ability is not action"}]}, {path: state, findings: [{reason: "unsupported completion"}]}]});
  assert.deepEqual(jobs.map(j => j.fields), [["/summary"], [action, state]]);
  assert.ok(!JSON.stringify(jobs[1]).includes("wrong causal subject"));
  const events = sourceEventRepairJobs({eventIndexes: [2, 6, 7], reason: "mixed",
    findings: [{repairEventIndexes: [2], reason: "missing question"}, {repairEventIndexes: [6, 7], reason: "duplicate across boundary"}]});
  assert.deepEqual(events.map(j => j.eventIndexes), [[2], [6, 7]]);
});

test("new exact duplicate beats are rejected without inventing semantic equivalence", () => {
  const beat = {actor: "Dorothy", action: "Crosses", references: [{lineStart: 1, lineEnd: 2}]};
  const before = {significantEvents: [{beats: [beat]}, {beats: []}]};
  assert.throws(() => assertNoNewExactDuplicateBeats(before, {significantEvents: [{beats: [beat]}, {beats: [beat]}]}), /duplicated/);
  assert.doesNotThrow(() => assertNoNewExactDuplicateBeats(before, {significantEvents: [{beats: [beat]}, {beats: [{...beat, actor: "Toto"}]}]}));
});

test("an unresolved early chapter does not block later batches or discard their checkpoints", async () => {
  const book: ImportedBook = {bookId: "test", sourceSha256: "source", title: "Test", importedAt: "now",
    chapters: [0, 1].map(index => ({index, title: "Chapter " + index, text: "A scene in a book. ".repeat(30)}))};
  const maxSourceCharsPerRequest = 1100;
  assert.equal(buildChapterAnalysisBatches(book, maxSourceCharsPerRequest).length, 2);
  const generationOrder: string[] = [];
  await assert.rejects(analyzeBook(book, {sharedEventsOnly: true, maxSourceCharsPerRequest, log: () => {},
    saveProgress: async () => {}, saveStageProgress: async () => {}, createResponse: async request => {
      if (request.text?.format.name === "bookrpg_source_timeline_review") return reply({valid: true, issues: [], previousFindings: []});
      assert.equal(request.text?.format.name, "bookrpg_source_timeline");
      const id = Object.keys((request.text!.format.schema as any).properties)[0]!;
      generationOrder.push(id);
      if (id === "chapter_1_part_1") throw new Error("unresolved first chapter");
      return reply({[id]: {summary: "Reviewed chapter", characters: [], relationships: [], actions: [], significantEvents: []}});
    }}), /Import paused after 5 source rounds/);
  assert.deepEqual(generationOrder.slice(0, 3), ["chapter_1_part_1", "chapter_2_part_1", "chapter_1_part_1"]);
  assert.ok(book.chapters[1]!.sourceIndex);
  assert.equal(generationOrder.filter(id => id === "chapter_2_part_1").length, 1);
});
