import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { applySourceFieldRepair, sourceFieldRepairSchema } from "../src/books/analyze/source-field-repair.js";
import { measureSourceFieldRepair, requestStagedChapterIndexes } from "../src/books/analyze/staged-index.js";
import type { ImportedBook } from "../src/shared/contracts.js";
const read = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/import-goals/${name}.json`, import.meta.url), "utf8"));
const output = (v: unknown) => ({status: "completed", output_text: JSON.stringify(v && typeof v === "object" && Object.keys(v).some(k => k.startsWith("field_")) ? {scopeCheck: {matchesDefect: true, reason: "Fixture targets match the defect."}, ...v} : v)});
async function fixture(name: string) {
  const f = await read(`${name}.source-review`), source = await read(name), repair = await read(`${name}.source-fields`);
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: name, partIndex: 0, partCount: 1, lineStart: 1, lineEnd: source.text.split("\n").length, text: source.text};
  return {f: {...f, repair}, part};
}
const storyValues = {field_0: "Rain rusted his joints and he remained in the woods until help came.", field_1: "Is interested in the account and understands why the Tin Woodman wants a heart.", field_2: "Dorothy understands why the Tin Woodman wants a new heart.", field_3: "The old woman wanted the Munchkin girl to remain and do cooking and housework.", field_4: null, field_5: "The Scarecrow listens to the Tin Woodman's explanation."};

test("source field patch is atomic and cannot expand scope or change joint actions", async () => {
  const {f} = await fixture("oil"), original = structuredClone(f.timeline);
  for (const path of ["/significantEvents/0/beats/0/actor", "/significantEvents/0/beats", "/significantEvents/7/beats/0/resultingState", "/significantEvents/6/beats/0/action", "/__proto__/polluted", "/relationships/999"]) {
    assert.throws(() => sourceFieldRepairSchema(f.timeline, {fields: [path], reason: "defect"}), /Unrepairable|cannot change/);
  }
  assert.throws(() => applySourceFieldRepair(f.timeline, f.repair, {field_0: [], actor: "Scarecrow"}), /exactly/);
  assert.throws(() => applySourceFieldRepair(f.timeline, f.repair, {field_0: "Dorothy"}), /Invalid repair value/);
  const repaired = applySourceFieldRepair(f.timeline, f.repair, {field_0: []}) as any;
  const expected = structuredClone(original); expected.significantEvents[6].beats[0].targets = [];
  assert.deepEqual(repaired, expected);
  assert.deepEqual(f.timeline, original);
});

test("narration field patch derives only current telling fields and removes only the designated relationship", async () => {
  const {f} = await fixture("story");
  const original = structuredClone(f.timeline);
  const result = applySourceFieldRepair(f.timeline, f.repair, storyValues) as any;
  const expected = structuredClone(original);
  const b = expected.significantEvents[7].beats[3];
  b.sourceSemantics.narratedContent = storyValues.field_0;
  b.action = `Recounts: ${storyValues.field_0}`;
  b.resultingState = `Tin Woodman has recounted: ${storyValues.field_0}`;
  expected.significantEvents[9].beats[0].action = storyValues.field_1;
  expected.significantEvents[9].beats[0].resultingState = storyValues.field_2;
  expected.relationships[3].description = storyValues.field_3;
  expected.relationships[8].description = storyValues.field_5;
  expected.relationships.splice(7, 1);
  assert.deepEqual(result, expected);
  assert.deepEqual(f.timeline, original);
  assert.throws(() => applySourceFieldRepair(f.timeline, f.repair, {...storyValues, field_5: []}), /Invalid repair value/);
  assert.deepEqual(f.timeline, original, "late invalid values cannot partially mutate source");
});

for (const name of ["oil", "story"]) test(`${name} field-repair measurement stops after one patch and review`, async () => {
  const {f, part} = await fixture(name);
  for (const accept of [true, false]) {
    const calls: string[] = [];
    const result = await measureSourceFieldRepair(async request => {
      calls.push(request.text!.format.name);
      if (calls.length === 1) {
        assert.equal(calls[0], "bookrpg_source_field_repair");
        assert.deepEqual((request.text!.format.schema as any).required, [...f.repair.fields.map((_: string, i: number) => `field_${i}`), "scopeCheck"]);
        return output(name === "oil" ? {field_0: []} : storyValues);
      }
      assert.equal(calls[1], "bookrpg_source_timeline_review");
      return output({valid: accept, issues: accept ? [] : [{target: "source", reason: "Still unsupported", repairFields: []}]});
    }, "test", part, f, "medium");
    assert.equal(calls.length, 2);
    assert.equal(result.verdict, accept ? "accepted" : "rejected");
    assert.ok(result.timeline, "rejected patched output remains inspectable");
  }
  let calls = 0;
  const badHash = await measureSourceFieldRepair(async () => {calls++; return output({});}, "test", part, {...f, sourceSha256: "wrong"}, "medium");
  assert.equal(badHash.verdict, "error"); assert.equal(calls, 0);
});

test("production saves field scope, survives restart and blocks out-of-scope patch before review", async () => {
  const {f, part} = await fixture("oil");
  const wire = structuredClone(f.timeline);
  for (const e of wire.significantEvents) for (const b of e.beats) if (b.sourceSemantics.mode === "narration") {delete b.action; delete b.agency; delete b.resultingState;}
  let book: ImportedBook = {bookId: "test", title: "oil", sourceSha256: f.sourceSha256, importedAt: "now", chapters: [{index: 0, title: "oil", text: part.text}]};
  let calls: string[] = [];
  await requestStagedChapterIndexes(async request => {
    calls.push(request.text!.format.name);
    return request.text!.format.name === "bookrpg_source_timeline" ? output({[part.sourceId]: wire}) : output({valid: false, issues: [{target: "source", reason: f.repair.reason, repairFields: f.repair.fields}]});
  }, "test", book, [part], 1, () => {}, async () => {});
  assert.deepEqual(calls, ["bookrpg_source_timeline", "bookrpg_source_timeline_review"]);
  book = JSON.parse(JSON.stringify(book));
  const original = structuredClone((book.importAnalysis!.parts[part.sourceId] as any).timeline);
  calls = [];
  await requestStagedChapterIndexes(async request => {calls.push(request.text!.format.name); return output({field_0: [], extra: "unauthorized"});}, "test", book, [part], 2, () => {}, async () => {});
  assert.deepEqual(calls, ["bookrpg_source_field_repair"]);
  let cp = book.importAnalysis!.parts[part.sourceId] as any;
  assert.deepEqual(cp.timeline, original); assert.ok(cp.sourceRepair); assert.equal(cp.sourceReviewed, undefined);
  book = JSON.parse(JSON.stringify(book)); calls = [];
  await requestStagedChapterIndexes(async request => {
    const name = request.text!.format.name; calls.push(name);
    if (name === "bookrpg_source_field_repair") return output({field_0: []});
    if (name === "bookrpg_source_timeline_review") return output({valid: true, issues: []});
    throw new Error("Stop test at goal planning");
  }, "test", book, [part], 3, () => {}, async () => {});
  cp = book.importAnalysis!.parts[part.sourceId] as any;
  assert.deepEqual(calls, ["bookrpg_source_field_repair", "bookrpg_source_timeline_review", "bookrpg_action_goal_plan"]);
  assert.equal(cp.sourceReviewed, true); assert.equal(cp.sourceRepair, undefined);
  const expected = structuredClone(original); expected.significantEvents[6].beats[0].targets = [];
  assert.deepEqual(cp.timeline, expected);
});

test("summary repair changes only summary and current review cannot see the prior candidate", async () => {
  const f = await read("story.source-summary"), source = await read("story");
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: "story", partIndex: 0, partCount: 1, lineStart: 1, lineEnd: source.text.split("\n").length, text: source.text};
  const original = structuredClone(f.timeline);
  const summary = "The Tin Woodman tells his companions how the enchanted axe and tin replacements cost him his heart. He describes rust immobilizing him until help came and his intention to ask Oz for a heart.";
  const expected = {...structuredClone(original), summary};
  assert.deepEqual(applySourceFieldRepair(f.timeline, f.repair, {field_0: summary}), expected);
  assert.throws(() => applySourceFieldRepair(f.timeline, f.repair, {field_0: ""}), /Invalid repair value/);
  assert.throws(() => applySourceFieldRepair(f.timeline, f.repair, {field_0: summary, field_1: []}), /exactly/);
  for (const accept of [true, false]) {
    let calls = 0;
    const result = await measureSourceFieldRepair(async request => {
      calls++;
      if (calls === 1) {
        assert.equal(request.text!.format.name, "bookrpg_source_field_repair");
        assert.deepEqual((request.text!.format.schema as any).required, ["field_0", "scopeCheck"]);
        return output({field_0: summary});
      }
      assert.equal(request.text!.format.name, "bookrpg_source_timeline_review");
      assert.doesNotMatch(request.input, /PREVIOUS UNTRUSTED CANDIDATE|OLD_CANDIDATE_ONLY/);
      const current = JSON.parse(request.input.split("COMPILED TIMELINE (derived narration fields are expected):\n")[1]!);
      assert.deepEqual(current, expected);
      assert.match(request.instructions!, /only the CURRENT compiled timeline/);
      return output({valid: accept, issues: accept ? [] : [{target: "source", reason: "A current summary fact remains unsupported", repairFields: ["/summary"]}]});
    }, "test", part, {...f, previousCandidate: {summary: "OLD_CANDIDATE_ONLY"}}, "medium");
    assert.equal(calls, 2);
    assert.equal(result.verdict, accept ? "accepted" : "rejected");
    assert.deepEqual(result.timeline, expected);
    assert.deepEqual(f.timeline, original);
  }
});


test('field repair without explicit scope verification cannot mutate or proceed to review', async () => {
  const {f, part} = await fixture('oil');
  const before = structuredClone(f.timeline);
  let calls = 0;
  const result = await measureSourceFieldRepair(async () => {
    calls++;
    return {status: 'completed', output_text: JSON.stringify({field_0: []})};
  }, 'test', part, f, 'medium');
  assert.equal(calls, 1);
  assert.equal(result.verdict, 'error');
  assert.match(result.reason!, /scope verification/);
  assert.deepEqual(f.timeline, before);
});
