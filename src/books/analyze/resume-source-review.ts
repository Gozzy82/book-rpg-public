import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ImportedBook } from "../../shared/contracts.js";
import { buildChapterAnalysisBatches } from "./batching.js";
import { installAcceptedSourceReview } from "./staged-index.js";
import type { SourceReviewRecord } from "./source-review-evidence.js";

/** Replay reports retain the original probe path, whose result binds the reviewed text to the EPUB. */
export async function resumeAcceptedSourceReview(book: ImportedBook, reportFile: string) {
  const file = path.resolve(reportFile);
  const report = JSON.parse(await fs.readFile(file, "utf8"));
  if (report.reviewVersion !== 2 || report.completed !== true || report.finalTimelineAccepted !== true
    || report.error || typeof report.inputFile !== "string") throw new Error("Source review report was not successfully accepted");
  const review: SourceReviewRecord | undefined = report.reviews?.at(-1);
  if (!review) throw new Error("Source review report has no final review");
  const inputFile = path.resolve(path.dirname(file), report.inputFile);
  const captured = JSON.parse(await fs.readFile(path.join(path.dirname(inputFile), "result.json"), "utf8"));
  const sourceBook = captured.book;
  if (sourceBook?.bookId !== book.bookId || sourceBook?.sourceSha256 !== book.sourceSha256) {
    throw new Error("Source review belongs to a different book or EPUB version");
  }
  const chapter = sourceBook.chapters?.[0];
  if (sourceBook.chapters?.length !== 1 || typeof chapter?.text !== "string"
    || createHash("sha256").update(chapter.text).digest("hex") !== report.sourceHash) {
    throw new Error("Source review source text is missing or changed");
  }
  const matches = buildChapterAnalysisBatches(book).flatMap(batch => batch.parts).filter(part =>
    part.partCount === 1 && part.chapterIndex === chapter.index && part.chapterTitle === chapter.title && part.text === chapter.text);
  if (matches.length !== 1) throw new Error("Reviewed source does not match exactly one complete import chapter");
  const part = matches[0]!;
  installAcceptedSourceReview(book, part, review);
  return {reportFile: file, sourceId: part.sourceId, chapterNumber: part.chapterPosition + 1, timelineHash: review.timelineHash};
}
