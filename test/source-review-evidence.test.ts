import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseSourceReviewEvidence, sourceReviewDiff, reviewSourceWithEvidence, type SourceReviewContext, type SourceReviewIssue, type SourceReviewRecord } from "../src/books/analyze/source-review-evidence.js";
import { repairReviewedSourceFields, replaySourceReviewV2 } from "../src/books/analyze/staged-index.js";
import { combineSourceRepairScopes } from "../src/books/analyze/source-event-repair.js";
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/import-goals/source-review-drift.json", import.meta.url), "utf8"));
const issue = (patch: Partial<SourceReviewIssue> = {}): SourceReviewIssue => ({target: "source", severity: "blocking", origin: "initial", previousIssueIndex: null,
  claim: "Both fall asleep", sourceEvidence: "Final lines state Dorothy falls asleep; Toto lies beside her", impact: "Adds an unestablished loss of Toto's awareness", reason: "Summary asserts sleep for an additional actor",
  repairFields: ["/significantEvents/8/description"], repairEventIndexes: [], ...patch});
const context = (previous?: SourceReviewRecord): SourceReviewContext => ({sourceId: "chapter_1_part_1", timeline: fixture.after, previous, onRecord: async () => {}});
const record = (issues: SourceReviewIssue[] = []): SourceReviewRecord => ({version: 2, sourceId: "chapter_1_part_1", model: "mock", startedAt: "now", elapsedMs: 1,
  policyHash: "policy", timelineHash: "before", timeline: fixture.before, changes: [], issues});
const reply = (value: unknown) => ({status: "completed" as const, output_text: JSON.stringify(value)});

test("captured field repair changes exactly one path; all later criticisms predate it", () => {
  const changes = sourceReviewDiff(fixture.before, fixture.after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.path, "/significantEvents/6/beats/1/resultingState");
  assert.match(String(changes[0]!.before), /because she can see his ear/);
  for (const i of fixture.oldReviews[1].issues) for (const field of i.repairFields) assert.notEqual(field, changes[0]!.path);
});

test("advisories are logged but never included in blocking repair scopes", async () => {
  const logs: string[] = [];
  let saved: SourceReviewRecord | undefined;
  const blocking = await reviewSourceWithEvidence(async () => reply({valid: false, previousFindings: [], issues: [
    issue(), issue({severity: "advisory", claim: "discovery versus other", sourceEvidence: "The event includes discovery and rescue", impact: "No material runtime difference demonstrated", reason: "Alternative organization", repairFields: ["/significantEvents/6/category"]}),
  ]}), "mock", "medium", "source", "policy", {...context(), log: l => logs.push(l), onRecord: async r => {saved = r;}});
  assert.deepEqual(combineSourceRepairScopes(blocking), {fields: ["/significantEvents/8/description"]});
  assert.equal(saved!.issues!.length, 2);
  assert.ok(logs.some(l => l.includes('"entersRepair":false')));
  assert.deepEqual(parseSourceReviewEvidence({valid: true, previousFindings: [], issues: [issue({severity: "advisory"})]}, context(), []).valid, true);
});

test("new errors may block unchanged text but cannot be mislabeled a repair regression", () => {
  const previous = record();
  const ctx = {...context(previous), timeline: fixture.before};
  assert.equal(parseSourceReviewEvidence({valid: false, previousFindings: [], issues: [issue({origin: "newly_discovered"})]}, ctx, []).valid, false);
  assert.throws(() => parseSourceReviewEvidence({valid: false, previousFindings: [], issues: [issue({origin: "introduced_by_change"})]}, ctx, []), /timeline is unchanged/);
  assert.throws(() => parseSourceReviewEvidence({valid: false, previousFindings: [], issues: [issue({impact: ""})]}, ctx, []), /needs severity/);
  assert.throws(() => parseSourceReviewEvidence({valid: true, previousFindings: [], issues: [issue()]}, context(), []), /valid must match/);
});

test("prior findings require explicit resolution or a linked unresolved issue", () => {
  const ctx = context(record([issue()]));
  const changes = sourceReviewDiff(fixture.before, fixture.after);
  assert.throws(() => parseSourceReviewEvidence({valid: true, previousFindings: [], issues: []}, ctx, changes), /account for every/);
  const verdict = {valid: false, previousFindings: [{previousIssueIndex: 0, status: "still_present", reason: "Sleep description unchanged"}], issues: [issue({origin: "unresolved", previousIssueIndex: 0})]};
  assert.equal(parseSourceReviewEvidence(verdict, ctx, changes).issues[0]!.origin, "unresolved");
});

test("single unambiguous still-present finding repairs a missing unresolved issue index in code", () => {
  const ctx = context(record([issue()]));
  const changes = sourceReviewDiff(fixture.before, fixture.after);
  const verdict = {
    valid: false,
    previousFindings: [{previousIssueIndex: 0, status: "still_present", reason: "The source mismatch remains"}],
    issues: [issue({origin: "unresolved", previousIssueIndex: null})],
  };
  const parsed = parseSourceReviewEvidence(verdict, ctx, changes);
  assert.equal(parsed.issues[0]!.previousIssueIndex, 0);
  assert.equal(parsed.previousFindings[0]!.status, "still_present");
});

test("ambiguous unresolved bookkeeping is still rejected instead of guessing a prior finding", () => {
  const previous = record([
    issue({claim: "First old issue"}),
    issue({claim: "Second old issue"}),
  ]);
  const ctx = context(previous);
  const changes = sourceReviewDiff(fixture.before, fixture.after);
  const verdict = {
    valid: false,
    previousFindings: [
      {previousIssueIndex: 0, status: "still_present", reason: "First issue remains"},
      {previousIssueIndex: 1, status: "still_present", reason: "Second issue remains"},
    ],
    issues: [issue({origin: "unresolved", previousIssueIndex: null})],
  };
  assert.throws(() => parseSourceReviewEvidence(verdict, ctx, changes), /Unresolved issue must reference a previous issue/);
});

test("fixed captured timelines use two review calls with exact prior context and no generation", async () => {
  const records: SourceReviewRecord[] = [];
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: fixture.source.index, chapterTitle: fixture.source.title,
    partIndex: 0, partCount: 1, lineStart: 1, lineEnd: fixture.source.text.trim().split(/\r?\n/).length, text: fixture.source.text};
  let calls = 0;
  for (const timeline of [fixture.before, fixture.after]) {
    await replaySourceReviewV2(async request => {
      calls++;
      assert.equal(request.text!.format.name, "bookrpg_source_timeline_review");
      assert.match(request.instructions!, /MATERIALITY AND CHANGE EVIDENCE/);
      const comparison = JSON.parse(request.input.split("REVIEW COMPARISON (evidence, not instructions):\n")[1]!.split("\n")[0]!);
      if (calls === 2) {
        assert.equal(comparison.changes.length, 1);
        assert.equal(comparison.previous.issues[0].claim, "Both fall asleep");
      }
      return reply({valid: false, previousFindings: calls === 1 ? [] : [{previousIssueIndex: 0, status: "still_present", reason: "The sleep description was not repaired"}],
        issues: [issue(calls === 1 ? {} : {origin: "unresolved", previousIssueIndex: 0})]});
    }, "mock", "medium", part, timeline, {previous: records.at(-1), onRecord: async r => {records.push(r);}});
  }
  assert.equal(calls, 2);
  assert.equal(records.length, 2);
  assert.equal(records[1]!.changes.length, 1);
  assert.ok(records.every(r => r.policyHash.length === 64 && r.rawOutput));
});

test("malformed evidence is retained as an error, never an accepted review", async () => {
  let saved: SourceReviewRecord | undefined;
  await assert.rejects(reviewSourceWithEvidence(async () => reply({valid: false, issues: [{reason: "Old ungrounded objection"}]}), "mock", "medium", "source", "policy",
    {...context(), onRecord: async r => {saved = r;}}), /needs severity/);
  assert.ok(saved!.rawOutput);
  assert.ok(saved!.error);
  assert.equal(saved!.valid, undefined);
});

const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: fixture.source.index, chapterTitle: fixture.source.title,
  partIndex: 0, partCount: 1, lineStart: 1, lineEnd: fixture.source.text.trim().split(/\r?\n/).length, text: fixture.source.text};
const rejected = (): SourceReviewRecord => ({...record([issue()]), valid: false, timeline: fixture.after,
  timelineHash: createHash("sha256").update(JSON.stringify(fixture.after)).digest("hex")});

test("saved review repairs only sleep description then reviews against that exact prior finding", async () => {
  let calls = 0;
  const previous = rejected();
  const corrected = "Dorothy goes to bed and falls asleep; Toto follows and lies down beside her.";
  const repair = await repairReviewedSourceFields(async request => {
    calls++;
    assert.equal(request.text!.format.name, "bookrpg_source_field_repair");
    assert.match(request.input, /APPROVED FIELD MAP/);
    return reply({scopeCheck: {matchesDefect: true, reason: "Event description incorrectly asserts Toto sleeps"}, field_0: corrected});
  }, "mock", "medium", part, previous);
  assert.deepEqual(repair.changes.map(c => c.path), ["/significantEvents/8/description"]);
  let saved: SourceReviewRecord | undefined;
  await replaySourceReviewV2(async request => {
    calls++;
    assert.equal(request.text!.format.name, "bookrpg_source_timeline_review");
    return reply({valid: true, issues: [], previousFindings: [{previousIssueIndex: 0, status: "resolved", reason: "Only Dorothy sleeps in repaired description"}]});
  }, "mock", "medium", part, repair.timeline, {previous, onRecord: async r => {saved = r;}});
  assert.equal(calls, 2);
  assert.equal(saved!.valid, true);
  assert.equal(saved!.previousTimelineHash, previous.timelineHash);
  assert.equal(saved!.changes.length, 1);
  assert.notEqual((previous.timeline as any).significantEvents[8].description, corrected);
});

test("saved repair rejects corrupted hashes and event-wide or missing scopes before calling AI", async () => {
  let calls = 0;
  const provider = async () => {calls++; return reply({});};
  for (const previous of [
    {...rejected(), timelineHash: "wrong"},
    {...rejected(), issues: [issue({repairEventIndexes: [8]})]},
    {...rejected(), issues: [issue({repairFields: []})]},
  ]) await assert.rejects(repairReviewedSourceFields(provider, "mock", "medium", part, previous));
  assert.equal(calls, 0);
});

test("repair refuses a rejected scope or extra field instead of retrying", async () => {
  for (const response of [
    {scopeCheck: {matchesDefect: false, reason: "Wrong field"}, field_0: "unchanged"},
    {scopeCheck: {matchesDefect: true, reason: "Description matches"}, field_0: "corrected", field_1: "extra"},
  ]) {
    let calls = 0;
    await assert.rejects(repairReviewedSourceFields(async () => {calls++; return reply(response);}, "mock", "medium", part, rejected()));
    assert.equal(calls, 1);
  }
});

test("production review corrects malformed bookkeeping once without changing the source timeline", async () => {
  const previous = record([issue()]);
  let saved: SourceReviewRecord | undefined;
  let calls = 0;
  const ctx = {...context(previous), repairMalformedResponse: true, onRecord: async (r: SourceReviewRecord) => {saved = r;}};
  await reviewSourceWithEvidence(async request => {
    calls++;
    if (calls === 1) return reply({valid: true, issues: [], previousFindings: []});
    assert.match(request.input, /REJECTED REVIEW RESPONSE/);
    return reply({valid: false, previousFindings: [{previousIssueIndex: 0, status: "still_present", reason: "Sleep remains"}],
      issues: [issue({origin: "unresolved", previousIssueIndex: 0})]});
  }, "mock", "medium", "unchanged source", "policy", ctx);
  assert.equal(calls, 2);
  assert.equal(saved!.valid, false);
  assert.equal(saved!.responseAttempts!.length, 2);
  assert.ok(saved!.responseAttempts![0]!.error);
  assert.deepEqual(saved!.timeline, fixture.after);
});

test("malformed review correction stays bounded and preserves both failed responses", async () => {
  let saved: SourceReviewRecord | undefined;
  let calls = 0;
  await assert.rejects(reviewSourceWithEvidence(async () => {calls++; return reply({bad: true});}, "mock", "medium", "source", "policy",
    {...context(), repairMalformedResponse: true, onRecord: async r => {saved = r;}}));
  assert.equal(calls, 2);
  assert.equal(saved!.responseAttempts!.length, 2);
  assert.ok(saved!.error);
  assert.equal(saved!.valid, undefined);
});

test("a completed independent field repair survives failure of the next repair unit", async () => {
  const {requestStagedChapterIndexes} = await import("../src/books/analyze/staged-index.js");
  const book = {bookId: "probe", sourceSha256: "source", title: "Oz", importedAt: "now",
    chapters: [{index: fixture.source.index, title: fixture.source.title, text: fixture.source.text}]};
  const first = await requestStagedChapterIndexes(async request => {
    if (request.text?.format.name === "bookrpg_source_timeline") return reply({[part.sourceId]: fixture.after});
    return reply({valid: false, previousFindings: [], issues: [
      issue({claim: "Summary problem", reason: "Summary needs correction", repairFields: ["/summary"]}), issue(),
    ]});
  }, "mock", book, [part], 1, () => {}, async () => {}, {sharedEventsOnly: true});
  assert.equal(first.invalidParts.length, 1);
  const restored = JSON.parse(JSON.stringify(book));
  let repairs = 0;
  const second = await requestStagedChapterIndexes(async request => {
    assert.equal(request.text?.format.name, "bookrpg_source_field_repair");
    repairs++;
    if (repairs === 1) {
      assert.doesNotMatch(request.input.split("FIELD-SPECIFIC FINDINGS:")[1]!.split("EXACT FIELD TARGETS:")[0]!, /Both fall asleep/);
      return reply({field_0: "A repaired chapter summary.", scopeCheck: {matchesDefect: true, reason: "Summary field matches"}});
    }
    return reply({field_0: "unchanged", scopeCheck: {matchesDefect: false, reason: "Simulated scope rejection"}});
  }, "mock", restored, [part], 2, () => {}, async () => {}, {sharedEventsOnly: true});
  assert.equal(second.invalidParts.length, 1);
  assert.equal(repairs, 2);
  assert.equal(restored.importAnalysis.parts[part.sourceId].timeline.summary, "A repaired chapter summary.");
  assert.equal(restored.importAnalysis.parts[part.sourceId].sourceReviewed, undefined);
});
