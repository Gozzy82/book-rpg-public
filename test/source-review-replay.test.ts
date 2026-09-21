import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { measureSourceReview, measureIndexStage, type SourceReviewFixture } from "../src/books/analyze/staged-index.js";
import type { ImportedBook } from "../src/shared/contracts.js";
const read = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/import-goals/${name}.json`, import.meta.url), "utf8"));
async function fixture(name: string) {
  const source = await read(name);
  const capture = await read(`${name}.source-review`) as SourceReviewFixture;
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: name, partIndex: 0, partCount: 1, lineStart: 1, lineEnd: source.text.split("\n").length, text: source.text};
  return {capture, part};
}
for (const name of ["oil", "story"]) test(`source review replay: ${name} keeps captured content and uses exactly one review call`, async () => {
  const {capture, part} = await fixture(name);
  const original = structuredClone(capture);
  for (const verdict of ["accepted", "rejected", "error"]) {
    let calls = 0;
    const result = await measureSourceReview(async request => {
      calls++;
      assert.equal(request.text!.format.name, "bookrpg_source_timeline_review");
      assert.match(request.instructions!, /REQUIRED derived fields added by code/);
      assert.doesNotMatch(request.instructions!, /Do not supply independent|Supply the source-backed narratedContent only|Fill sourceSemantics/);
      assert.match(request.instructions!, /Judge whether the source supports/);
      assert.doesNotMatch(request.input, /PREVIOUS UNTRUSTED CANDIDATE/);
      const encoded = request.input.split("COMPILED TIMELINE (derived narration fields are expected):\n")[1]!;
      assert.deepEqual(JSON.parse(encoded), capture.timeline, "no source repairs or regenerated fields in review-only mode");
      if (verdict === "error") return {status: "completed", output_text: '{"valid":true,"issues":[{"target":"source","reason":"bad verdict"}]}'};
      return {status: "completed", output_text: JSON.stringify({valid: verdict === "accepted", issues: verdict === "rejected" ? [{target: "source", reason: "Source-backed listener understanding is missing"}] : []})};
    }, "test", part, capture, "medium");
    assert.equal(calls, 1);
    assert.equal(result.verdict, verdict);
    assert.deepEqual(capture, original);
  }
});

test("source review replay validates source hash and compiled fields before any call", async () => {
  const {capture, part} = await fixture("story");
  let calls = 0;
  const provider = async (): Promise<never> => {calls++; throw new Error("Must not call");};
  const hash = await measureSourceReview(provider, "test", part, {...capture, sourceSha256: "wrong"}, "medium");
  assert.equal(hash.verdict, "error");
  const broken = structuredClone(capture);
  const beat = (broken.timeline as any).significantEvents.flatMap((e: any) => e.beats).find((b: any) => b.sourceSemantics.mode === "narration");
  beat.resultingState = "The Tin Woodman loses his leg now";
  const invalid = await measureSourceReview(provider, "test", part, broken, "medium");
  assert.equal(invalid.verdict, "error");
  assert.equal(calls, 0);
});

test("source generation retains wire-format rules but production source review uses compiled-format rules", async () => {
  const {capture, part} = await fixture("oil");
  const wire = structuredClone(capture.timeline) as any;
  for (const event of wire.significantEvents) for (const beat of event.beats) if (beat.sourceSemantics.mode === "narration") {
    delete beat.action; delete beat.agency; delete beat.resultingState;
  }
  const book: ImportedBook = {bookId: "test", title: "oil", sourceSha256: capture.sourceSha256, importedAt: "now", chapters: [{index: 0, title: "oil", text: part.text}]};
  let calls = 0;
  const result = await measureIndexStage(async request => {
    calls++;
    if (calls === 1) {
      assert.equal(request.text!.format.name, "bookrpg_source_timeline");
      assert.match(request.instructions!, /Do not supply independent action, agency or resultingState/);
      return {status: "completed", output_text: JSON.stringify({[part.sourceId]: wire})};
    }
    assert.equal(request.text!.format.name, "bookrpg_source_timeline_review");
    assert.doesNotMatch(request.instructions!, /Do not supply independent/);
    assert.match(request.instructions!, /REQUIRED derived fields added by code/);
    return {status: "completed", output_text: JSON.stringify({valid: false, issues: [{target: "source", reason: "Unsupported addressee"}]})};
  }, "test", book, part, 1, () => {}, async () => {}, {stage: "source"});
  assert.equal(calls, 2);
  assert.equal(result.artifacts.size, 0, "source semantics are still reviewed, not auto-approved by the compiler");
});
