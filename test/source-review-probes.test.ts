import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { applySourceFieldRepair, sourceFieldRepairSchema } from "../src/books/analyze/source-field-repair.js";
import { measureSourceReviewProbe, type SourceReviewProbe } from "../src/books/analyze/measure-source-probes.js";
import { measureSourceFieldRepair } from "../src/books/analyze/staged-index.js";
const read = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/import-goals/${name}.json`, import.meta.url), "utf8"));
const output = (v: unknown) => ({status: "completed", output_text: JSON.stringify(v && typeof v === "object" && Object.keys(v).some(k => k.startsWith("field_")) ? {scopeCheck: {matchesDefect: true, reason: "Fixture targets match the defect."}, ...v} : v)});
async function fixtures() {
  const probes = await read("source-review-probes") as SourceReviewProbe[];
  const source = await read("story");
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: "story", partIndex: 0, partCount: 1, lineStart: 1, lineEnd: source.text.split("\n").length, text: source.text};
  return {probes, part};
}

test("source controls differ only by the extraneous character reference, preserving supported comprehension", async () => {
  const {probes} = await fixtures();
  const [positive, negative] = probes;
  const scope = {fields: [negative!.expectedRepairField!], reason: "Extraneous character occurrence"};
  const original = structuredClone(negative!.timeline);
  const corrected = applySourceFieldRepair(original, scope, {field_0: null});
  assert.deepEqual(corrected, positive!.timeline);
  assert.deepEqual(original, negative!.timeline);
  assert.match(JSON.stringify((corrected.significantEvents as any[])[9].beats[1].resultingState), /understands.*because he believes he cannot love without one/);
  for (const path of ["/characters/7/name", "/characters/7/references", "/characters/7/references/2/lineStart", "/characters/7/references/99"]) {
    assert.throws(() => sourceFieldRepairSchema(original, {fields: [path], reason: "test"}), /Unrepairable/);
  }
  assert.throws(() => applySourceFieldRepair(original, scope, {field_0: {lineStart: 15, lineEnd: 18}}), /Invalid repair value/);
  assert.throws(() => sourceFieldRepairSchema(original, {fields: [0, 1, 2].map(i => `/characters/7/references/${i}`), reason: "Remove all"}), /retain at least one/);
  assert.deepEqual(original, negative!.timeline);
});

test("source probes withhold expected answers and require the specific defect, not any rejection", async () => {
  const {probes, part} = await fixtures();
  for (const probe of probes) {
    let calls = 0;
    const result = await measureSourceReviewProbe(async request => {
      calls++;
      assert.equal(request.text!.format.name, "bookrpg_source_timeline_review");
      assert.doesNotMatch(request.input, /expectedRepairField|rubric|source-control|08:17 repaired story/);
      assert.match(request.instructions!, /Understanding a speaker's belief is not adopting/);
      return output({valid: probe.expectedRepairField === null, issues: probe.expectedRepairField ? [{target: "source", reason: "Extraneous occurrence at lines 40-41", repairFields: [probe.expectedRepairField]}] : []});
    }, "test", part, probe, "medium");
    assert.equal(calls, 1); assert.equal(result.probePassed, true);
  }
  const negative = probes[1]!;
  const wrong = await measureSourceReviewProbe(async () => output({valid: false, issues: [{target: "source", reason: "Unrelated state objection", repairFields: ["/significantEvents/9/beats/1/resultingState"]}]}), "test", part, negative, "medium");
  assert.equal(wrong.probePassed, false);
  const error = await measureSourceReviewProbe(async () => {throw new Error("Transport failure");}, "test", part, negative, "medium");
  assert.equal(error.outcome.verdict, "error"); assert.equal(error.probePassed, false);
});

test("character-reference field repair uses production review and changes no other source evidence", async () => {
  const {probes, part} = await fixtures();
  const [positive, negative] = probes;
  let calls = 0;
  const result = await measureSourceFieldRepair(async request => {
    calls++;
    if (calls === 1) {
      assert.equal(request.text!.format.name, "bookrpg_source_field_repair");
      assert.deepEqual((request.text!.format.schema as any).properties.field_0, {type: "null"});
      return output({field_0: null});
    }
    assert.equal(request.text!.format.name, "bookrpg_source_timeline_review");
    assert.match(request.instructions!, /\/characters\/C\/references\/R/);
    const timeline = JSON.parse(request.input.split("COMPILED TIMELINE (derived narration fields are expected):\n")[1]!);
    assert.deepEqual(timeline, positive!.timeline);
    return output({valid: true, issues: []});
  }, "test", part, {...negative!, repair: {fields: [negative!.expectedRepairField!], reason: "Extraneous character reference"}}, "medium");
  assert.equal(result.verdict, "accepted", "reason" in result ? result.reason : undefined); assert.equal(calls, 2);
  assert.deepEqual(result.timeline, positive!.timeline);
});

test("version 2 controls retain source text and distinguish present framing/commitments from narrated history", async () => {
  const {probes, part} = await fixtures();
  const {createHash} = await import("node:crypto");
  for (const probe of probes) {
    assert.equal(probe.fixtureVersion, 2);
    assert.equal(probe.sourceSha256, createHash("sha256").update(part.text).digest("hex"));
    const t = probe.timeline as any;
    const frame = t.significantEvents[0].beats[2];
    assert.equal(frame.sourceSemantics.mode, "present");
    assert.equal(frame.sourceSemantics.narratedContent, null);
    assert.match(frame.action, /^Begins telling/);
    assert.deepEqual(frame.targets, []);
    for (const beat of t.significantEvents[8].beats.slice(2)) {
      assert.equal(beat.sourceSemantics.mode, "present");
      assert.equal(beat.sourceSemantics.narratedContent, null);
      assert.match(beat.resultingState, /has not yet|neither.*has occurred/);
    }
    assert.deepEqual(t.characters[2].references, [{lineStart: 51, lineEnd: 52}]);
    assert.match(t.significantEvents[4].beats[2].sourceSemantics.narratedContent, /one-legged man/);
    assert.match(t.significantEvents[9].description, /both understand/);
    assert.match(t.actions.find((a: any) => a.actor === "Dorothy").description, /understands/);
    assert.equal(t.significantEvents.flatMap((e: any) => e.beats).length, 33);
  }
});

