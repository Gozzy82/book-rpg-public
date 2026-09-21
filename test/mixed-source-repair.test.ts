import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { combineSourceRepairScopes } from "../src/books/analyze/source-event-repair.js";
import { requestStagedChapterIndexes } from "../src/books/analyze/staged-index.js";
import { buildChapterAnalysisBatches } from "../src/books/analyze/batching.js";
import type { ImportedBook } from "../src/shared/contracts.js";
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/import-goals/mixed-source-repair.json", import.meta.url), "utf8"));
const reply = (value: unknown) => ({status: "completed" as const, output_text: JSON.stringify(value)});

test("captured mixed review preserves the timeline and repairs only event 3 across restart", async () => {
  const book: ImportedBook = {bookId: "probe", sourceSha256: "source", title: "Oz", importedAt: "now", chapters: [{index: 3, title: "Cyclone", text: fixture.sourceText}]};
  const parts = buildChapterAnalysisBatches(book).flatMap(b => b.parts);
  const calls: string[] = [];
  let reviews = 0;
  const provider = async (request: any) => {
    const stage = request.text.format.name; calls.push(stage);
    if (stage === "bookrpg_source_timeline") return reply({[parts[0]!.sourceId]: fixture.timeline});
    if (stage === "bookrpg_source_timeline_review") {
      assert.match(request.instructions, /OVERLAPPING ACTIONS/);
      return reply(++reviews === 1 ? {...fixture.verdict, previousFindings: [], issues: fixture.verdict.issues.map((i: any) => ({...i, severity: "blocking", origin: "initial", previousIssueIndex: null,
        claim: i.reason, sourceEvidence: "Fixture lines 72-78", impact: "Fixture chronology affects progression"}))} : {valid: true, issues: [], previousFindings: fixture.verdict.issues.map((_: any, i: number) => ({previousIssueIndex: i, status: "resolved", reason: "The event replacement corrects the fixture defect"}))});
    }
    assert.equal(stage, "bookrpg_source_event_repair");
    assert.deepEqual(Object.keys(request.text.format.schema.properties), ["event_3", "removeCharacterNames"]);
    const event = structuredClone(fixture.timeline.significantEvents[3]);
    event.beats = [event.beats[2], event.beats[1], event.beats[0]];
    return reply({event_3: event});
  };
  const first = await requestStagedChapterIndexes(provider, "test", book, parts, 1, () => {}, async () => {}, {sharedEventsOnly: true});
  assert.equal(first.invalidParts.length, 1);
  const cp = book.importAnalysis!.parts[parts[0]!.sourceId] as any;
  assert.ok(cp.timeline);
  assert.deepEqual(cp.sourceEventRepair.eventIndexes, [3]);
  assert.equal(cp.sourceRepair, undefined);
  const preserved = structuredClone(cp.timeline.significantEvents);
  const restored = JSON.parse(JSON.stringify(book));
  const second = await requestStagedChapterIndexes(provider, "test", restored, parts, 2, () => {}, async () => {}, {sharedEventsOnly: true});
  assert.deepEqual([...second.validationErrors], []);
  const events = second.indexes.get(parts[0]!.sourceId)!.significantEvents;
  for (let i = 0; i < events.length; i++) if (i !== 3) assert.deepEqual(events[i], preserved[i]);
  assert.deepEqual(calls, ["bookrpg_source_timeline", "bookrpg_source_timeline_review", "bookrpg_source_event_repair", "bookrpg_source_timeline_review"]);
});

test("mixed scopes retain independent fields without widening event replacement", () => {
  assert.deepEqual(combineSourceRepairScopes([...fixture.verdict.issues, {repairFields: ["/summary", "/significantEvents/4/description"], repairEventIndexes: []}]),
    {fields: ["/summary", "/significantEvents/4/description"], eventIndexes: [3]});
  assert.deepEqual(combineSourceRepairScopes([{repairFields: ["/summary"], repairEventIndexes: []}]), {fields: ["/summary"]});
  for (const invalid of [{repairFields: [], repairEventIndexes: []}, {repairFields: [], repairEventIndexes: [-1]}, {repairFields: [null], repairEventIndexes: []}]) {
    assert.deepEqual(combineSourceRepairScopes([...fixture.verdict.issues, invalid]), {});
  }
});
