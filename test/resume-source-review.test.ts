import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { resumeAcceptedSourceReview } from "../src/books/analyze/resume-source-review.js";
import { requestStagedChapterIndexes } from "../src/books/analyze/staged-index.js";
import { buildChapterAnalysisBatches } from "../src/books/analyze/batching.js";
import type { ImportedBook } from "../src/shared/contracts.js";
const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/import-goals/source-review-drift.json", import.meta.url), "utf8"));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "accepted-source-"));
  const probe = path.join(directory, "probe");
  await fs.mkdir(probe);
  const timeline = structuredClone(fixture.after);
  timeline.significantEvents[8].description = "Dorothy falls asleep; Toto lies beside her.";
  const review = {version: 2, valid: true, issues: [], timeline, timelineHash: hash(JSON.stringify(timeline)),
    sourceId: "chapter_1_part_1", model: "mock", startedAt: "now", elapsedMs: 1, policyHash: "mock", changes: []};
  const chapter = {index: fixture.source.index, title: fixture.source.title, text: fixture.source.text};
  const sourceBook = {bookId: "oz", sourceSha256: "epub-hash", title: "Oz", importedAt: "now", chapters: [chapter]};
  const book: ImportedBook = {...sourceBook, chapters: [
    {index: 0, title: "Frontmatter", text: "Title page"}, chapter,
  ]};
  const report = {reviewVersion: 2, completed: true, finalTimelineAccepted: true,
    inputFile: path.join(probe, "requests.json"), sourceHash: hash(chapter.text), reviews: [review]};
  await fs.writeFile(path.join(probe, "result.json"), JSON.stringify({book: sourceBook}));
  const reportFile = path.join(directory, "result.json");
  await fs.writeFile(reportFile, JSON.stringify(report));
  return {directory, book, report, reportFile};
}

test("accepted probe timeline resumes a different production chapter position without AI calls", async () => {
  const f = await setup();
  try {
    const resumed = await resumeAcceptedSourceReview(f.book, f.reportFile);
    assert.equal(resumed.sourceId, "chapter_2_part_1");
    const part = buildChapterAnalysisBatches(f.book).flatMap(b => b.parts).find(p => p.chapterPosition === 1)!;
    const result = await requestStagedChapterIndexes(async () => {throw new Error("Must reuse accepted source");},
      "mock", f.book, [part], 1, () => {}, async () => {}, {sharedEventsOnly: true});
    assert.equal(result.invalidParts.length, 0);
    assert.equal(result.indexes.size, 1);
    assert.equal(result.indexes.get(part.sourceId)!.significantEvents[8]!.description,
      "Dorothy falls asleep; Toto lies beside her.");
  } finally {await fs.rm(f.directory, {recursive: true, force: true});}
});

test("wrong EPUB, changed source, rejected verdict and corrupted timeline cannot seed checkpoints", async () => {
  const f = await setup();
  try {
    for (const alter of [
      (book: ImportedBook, report: any) => {book.sourceSha256 = "other";},
      (book: ImportedBook, report: any) => {book.chapters[1]!.text += " altered";},
      (book: ImportedBook, report: any) => {report.finalTimelineAccepted = false;},
      (book: ImportedBook, report: any) => {report.reviews[0].timelineHash = "wrong";},
      (book: ImportedBook, report: any) => {report.reviews[0].issues = [{severity: "blocking"}];},
    ]) {
      const book = structuredClone(f.book), report = structuredClone(f.report);
      alter(book, report);
      await fs.writeFile(f.reportFile, JSON.stringify(report));
      await assert.rejects(resumeAcceptedSourceReview(book, f.reportFile));
      assert.equal(book.importAnalysis, undefined);
    }
  } finally {await fs.rm(f.directory, {recursive: true, force: true});}
});
