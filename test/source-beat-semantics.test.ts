import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateSourceBeatSemantics } from "../src/shared/source-beat-semantics.js";
import { flattenTimeline, compileGoalEvents, measureIndexStage, requestStagedChapterIndexes } from "../src/books/analyze/staged-index.js";
import { mergeChapterPartSourceIndexes, buildBookStoryEvents } from "../src/books/source-index.js";
import { isReusableChapterSourceIndex } from "../src/books/source-index/reuse.js";
import type { ImportedBook } from "../src/shared/contracts.js";
const read = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/import-goals/${name}.json`, import.meta.url), "utf8"));

test("narrated accidents retain the teller's intentional agency; meaningful starts cannot be routine", async () => {
  const story = flattenTimeline((await read("story.timeline")).timeline);
  validateSourceBeatSemantics(story.beats);
  const injury = story.beats.find(b => b.sourceSemantics?.narratedContent?.includes("left leg"))!;
  assert.ok(injury);
  injury.agency = "involuntary";
  assert.throws(() => validateSourceBeatSemantics(story.beats), /narration must be intentional/);
  const toto = flattenTimeline((await read("toto.timeline")).timeline);
  assert.equal(toto.beats[2]!.sourceSemantics!.intentionalRole, "meaningful");
  toto.beats[2]!.stakes = "routine";
  assert.throws(() => validateSourceBeatSemantics(toto.beats), /meaningful action/);
});

test("joint actor representations cannot invent progress, omit partners or split into different event containers", async () => {
  const index = (await read("oil.timeline")).timeline;
  const flat = flattenTimeline(index);
  validateSourceBeatSemantics(flat.beats);
  const bad = structuredClone(flat.beats);
  bad[13]!.resultingState = "Dorothy has only begun; Scarecrow must finish later.";
  assert.throws(() => validateSourceBeatSemantics(bad), /without invented intermediate progress/);
  assert.throws(() => validateSourceBeatSemantics(flat.beats.filter((_, i) => i !== 14)), /every participant/);
  const compiled = compileGoalEvents(index, flat, []);
  assert.ok(compiled.some(e => e.beats.length === 2 && e.beats[0]!.sourceSemantics?.jointAction?.id === "leg_oiling"));
  const merged = mergeChapterPartSourceIndexes(0, 0, index.summary, [index, index]);
  assert.equal(merged.schemaVersion, 17);
  const persisted = merged.significantEvents!.flatMap(e => e.beats!);
  validateSourceBeatSemantics(persisted);
  const ids = new Set(persisted.flatMap(b => b.sourceSemantics?.jointAction ? [b.sourceSemantics.jointAction.id] : []));
  assert.equal(ids.size, 2, "part-local joint IDs cannot collide after merge");
  const events = buildBookStoryEvents({bookId: "test", chapters: [{index: 0, title: "test", text: "test", sourceIndex: merged}]});
  assert.ok(events.some(e => e.beats?.some(b => b.sourceSemantics?.jointAction)));
});

test("source schema requires explicit semantics; invalid source cannot proceed to review or goals", async () => {
  const source = await read("toto"), controlled = await read("toto.timeline");
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: "toto", partIndex: 0, partCount: 1, lineStart: 1, lineEnd: 6, text: source.text};
  const book: ImportedBook = {bookId: "test", title: "test", sourceSha256: controlled.sourceSha256, importedAt: "now", chapters: [{index: 0, title: "test", text: source.text}]};
  let calls = 0;
  const result = await measureIndexStage(async request => {
    calls++;
    if (request.text!.format.name === "bookrpg_source_field_repair") {
      const fields = JSON.parse(request.input.split("APPROVED FIELD MAP:\n")[1]!);
      const values = Object.fromEntries(Object.entries(fields).map(([key, path]) => [key,
        (path as string).slice(1).split("/").reduce((value: any, segment) => value[segment], controlled.timeline)]));
      return {status: "completed", output_text: JSON.stringify({...values, scopeCheck: {matchesDefect: true, reason: "Fixture maps the inconsistent classification."}})}; // Still inconsistent: must not reach review/goals.
    }
    assert.equal(request.text!.format.name, "bookrpg_source_timeline");
    const schema = (request.text!.format.schema as any).properties.chapter_1_part_1.properties.significantEvents.items.properties.beats.items;
    assert.ok(schema.anyOf.every((branch: any) => branch.required.includes("sourceSemantics")));
    assert.match(request.instructions!, /CURRENT actor is intentionally telling/);
    assert.match(request.instructions!, /PASSIVE PERCEPTION IS AUTOMATIC/);
    assert.match(request.instructions!, /agency=involuntary and intentionalRole=other/);
    controlled.timeline.significantEvents[2].beats[0].stakes = "routine";
    return {status: "completed", output_text: JSON.stringify({[part.sourceId]: controlled.timeline})};
  }, "test", book, part, 1, () => {}, async () => {}, {stage: "source"});
  assert.equal(calls, 2);
  assert.equal(result.artifacts.size, 0);
  assert.match(result.validationErrors.get(part.sourceId)!, /meaningful action/);
});

test("v13 approved timelines lose approvals and remain untrusted candidates", async () => {
  const source = await read("toto"), controlled = await read("toto.timeline");
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: "toto", partIndex: 0, partCount: 1, lineStart: 1, lineEnd: 6, text: source.text};
  for (const e of controlled.timeline.significantEvents) for (const b of e.beats) delete b.sourceSemantics;
  const fingerprint = createHash("sha256").update(JSON.stringify({version: 2, source: controlled.sourceSha256, part})).digest("hex");
  const book: ImportedBook = {bookId: "test", title: "test", sourceSha256: controlled.sourceSha256, importedAt: "now", chapters: [{index: 0, title: "test", text: source.text}], importAnalysis: {version: 1, parts: {[part.sourceId]: {fingerprint, timeline: controlled.timeline, sourceReviewed: true, events: {0: {planReviewed: true, reviewed: true}}}}}};
  const result = await requestStagedChapterIndexes(async () => {throw new Error("Unannotated candidate must first fail structural validation");}, "test", book, [part], 1, () => {}, async () => {});
  assert.equal(result.indexes.size, 0);
  assert.match(result.validationErrors.get(part.sourceId)!, /missing sourceSemantics/);
  const cp = book.importAnalysis!.parts[part.sourceId] as any;
  assert.deepEqual(cp.candidate, controlled.timeline);
  assert.deepEqual(cp.events, {});
  assert.equal(cp.sourceReviewed, undefined);
  const merged = mergeChapterPartSourceIndexes(0, 0, "old", [controlled.timeline]);
  assert.equal(isReusableChapterSourceIndex(merged), false, "changing the version alone cannot approve unannotated source");
});

test("narration compiler derives present state without turning historical accidents into current injuries", async () => {
  const { compileSourceTimeline } = await import("../src/books/analyze/source-timeline-compiler.js");
  const fixture = await read("story.source-repair");
  const original = structuredClone(fixture.candidate);
  assert.throws(() => compileSourceTimeline(original), /must not supply independently generated/);
  const wire = structuredClone(original);
  for (const event of wire.significantEvents) for (const beat of event.beats) {
    if (beat.sourceSemantics.intentionalRole !== "other") beat.sourceSemantics.intentionalRole = "meaningful";
    if (beat.sourceSemantics.mode === "narration") for (const key of ["action", "agency", "resultingState"]) delete beat[key];
  }
  const compiled = compileSourceTimeline(wire) as any;
  const narrations = compiled.significantEvents.flatMap((e: any) => e.beats).filter((b: any) => b.sourceSemantics.mode === "narration");
  assert.ok(narrations.length > 10);
  for (const beat of narrations) {
    assert.equal(beat.agency, "intentional");
    assert.equal(beat.resultingState, `${beat.actor} has recounted: ${beat.sourceSemantics.narratedContent.trim()}`);
    assert.ok(beat.action.startsWith("Recounts: "));
  }
  assert.deepEqual(fixture.candidate, original, "captured failure must remain unchanged");
  const broken = structuredClone(narrations);
  broken[0].resultingState = "Tin Woodman has lost his leg now";
  assert.throws(() => validateSourceBeatSemantics(broken), /compiled current telling/);
});

for (const name of ["oil", "story"]) test(`captured ${name} source repair uses one repair and review, never goals or automatic retries`, async () => {
  const source = await read(name), controlled = await read(`${name}.timeline`), repair = await read(`${name}.source-repair`);
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: name, partIndex: 0, partCount: 1, lineStart: 1, lineEnd: source.text.split("\n").length, text: source.text};
  const createBook = (): ImportedBook => ({bookId: "test", title: name, sourceSha256: repair.sourceSha256, importedAt: "now", chapters: [{index: 0, title: name, text: source.text}]});
  const wire = structuredClone(controlled.timeline);
  for (const e of wire.significantEvents) for (const b of e.beats) if (b.sourceSemantics.mode === "narration") {
    delete b.action; delete b.agency; delete b.resultingState;
  }
  const measurement = {stage: "source-repair" as const, sourceSha256: repair.sourceSha256, repair};
  for (const reject of [false, true]) {
    const calls: string[] = [];
    const result = await measureIndexStage(async request => {
      calls.push(request.text!.format.name);
      if (calls.length === 1) {
        assert.equal(calls[0], "bookrpg_source_timeline_repair");
        assert.ok(request.input.includes(JSON.stringify(repair.candidate)));
        assert.ok(request.instructions!.includes(repair.defect));
        const branches = (request.text!.format.schema as any).properties.chapter_1_part_1.properties.significantEvents.items.properties.beats.items.anyOf;
        assert.equal(branches[1].properties.agency, undefined);
        assert.equal(branches[1].properties.resultingState, undefined);
        assert.deepEqual(branches[1].properties.sourceSemantics.properties.intentionalRole.enum, ["meaningful", "other"]);
        return {status: "completed", output_text: JSON.stringify({[part.sourceId]: wire})};
      }
      assert.equal(calls[1], "bookrpg_source_timeline_review");
      assert.match(request.instructions!, /Never reject a source beat solely over start-versus-continuation/);
      assert.doesNotMatch(request.input, /PREVIOUS UNTRUSTED CANDIDATE/);
      return {status: "completed", output_text: JSON.stringify({valid: !reject, issues: reject ? [{target: "source", reason: "Narration content is not supported by this source"}] : []})};
    }, "test", createBook(), part, 1, () => {}, async () => {}, measurement);
    assert.equal(calls.length, 2);
    assert.equal(result.artifacts.size, reject ? 0 : 1);
    if (reject) assert.match(result.validationErrors.get(part.sourceId)!, /not supported/);
  }
  const noCall = async (): Promise<never> => {throw new Error("Provider must not be called");};
  await assert.rejects(measureIndexStage(noCall, "test", createBook(), part, 2, () => {}, async () => {}, measurement), /one attempt/);
  await assert.rejects(measureIndexStage(noCall, "test", createBook(), part, 1, () => {}, async () => {}, {...measurement, repair: {...repair, sourceSha256: "wrong"}}), /matching source hash/);
});

test("v14 source approvals cannot bypass v15 narration and role validation", async () => {
  const source = await read("oil"), repair = await read("oil.source-repair");
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: "oil", partIndex: 0, partCount: 1, lineStart: 1, lineEnd: source.text.split("\n").length, text: source.text};
  const fingerprint = createHash("sha256").update(JSON.stringify({version: 3, source: repair.sourceSha256, part})).digest("hex");
  const book: ImportedBook = {bookId: "old", title: "old", sourceSha256: repair.sourceSha256, importedAt: "now", chapters: [{index: 0, title: "old", text: source.text}], importAnalysis: {version: 1, parts: {[part.sourceId]: {fingerprint, timeline: repair.candidate, sourceReviewed: true, events: {0: {planReviewed: true, reviewed: true}}}}}};
  const result = await requestStagedChapterIndexes(async () => {throw new Error("Old candidate should be validated first");}, "test", book, [part], 1, () => {}, async () => {});
  assert.equal(result.indexes.size, 0);
  const cp = book.importAnalysis!.parts[part.sourceId] as any;
  assert.deepEqual(cp.candidate, repair.candidate);
  assert.deepEqual(cp.events, {});
  assert.equal(cp.sourceReviewed, undefined);
});

