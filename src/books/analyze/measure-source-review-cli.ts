import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { configuredIndexModel } from "../../ai/provider.js";
import { dataDir, loadAiApiKey, loadDotEnv } from "../../util/env.js";
import { createDefaultResponse } from "./identity.js";
import { repairReviewedSourceFields, replaySourceReviewV2 } from "./staged-index.js";
import type { SourceReviewRecord } from "./source-review-evidence.js";
import { formatAnalysisPart, type ChapterAnalysisPart } from "./batching.js";

loadDotEnv(); loadAiApiKey();
const args = process.argv.slice(2);
if (args.length !== 2 || !["--from", "--repair-from"].includes(args[0]!)) throw new Error('Usage: npm run measure:source-review -- --from "path/to/requests.json" OR --repair-from "path/to/result.json"');
const inputFile = path.resolve(args[1]!);
const repairMode = args[0] === "--repair-from";
const saved = repairMode ? JSON.parse(await fs.readFile(inputFile, "utf8")) : undefined;
const previous: SourceReviewRecord | undefined = saved?.reviews?.at(-1);
if (repairMode && (saved?.reviewVersion !== 2 || !previous || saved.error)) throw new Error("Expected a completed v2 review result");
const originalFile = repairMode ? path.resolve(saved.inputFile) : inputFile;
const captured = JSON.parse(await fs.readFile(originalFile, "utf8"));
if (!Array.isArray(captured)) throw new Error("Expected a captured requests.json array");
const reviews = captured.filter(c => c.request?.text?.format?.name === "bookrpg_source_timeline_review");
if (!reviews.length || reviews.length > 2) throw new Error("Replay expects one or two captured source reviews; it never regenerates beats");
// Use the stored source in result.json; the book repository is never read or written.
const capturedResult = JSON.parse(await fs.readFile(path.join(path.dirname(originalFile), "result.json"), "utf8"));
const chapter = capturedResult.book?.chapters?.[0];
if (!chapter || typeof chapter.text !== "string") throw new Error("Missing captured chapter source in result.json");
const part: ChapterAnalysisPart = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: chapter.index,
  chapterTitle: chapter.title, partIndex: 0, partCount: 1, lineStart: 1, lineEnd: chapter.text.trim().split(/\r?\n/).length, text: chapter.text};
const marker = "COMPILED TIMELINE (derived narration fields are expected):\n";
const timelines = reviews.map(c => {
  const input = c.request.input;
  if (typeof input !== "string" || !input.includes(marker)) throw new Error("Captured review lacks a compiled timeline");
  if (!input.includes(formatAnalysisPart(part))) throw new Error("Captured request source does not match the sibling result.json or is a different source part");
  return JSON.parse(input.slice(input.indexOf(marker) + marker.length));
});
if (repairMode && createHash("sha256").update(chapter.text).digest("hex") !== saved.sourceHash) throw new Error("Saved source hash does not match the captured source");
const directory = path.join(dataDir(), "source-review-replays", new Date().toISOString().replaceAll(":", "-"));
await fs.mkdir(directory, {recursive: true});
const records: SourceReviewRecord[] = [];
const requests: unknown[] = [];
const log: string[] = [];
const model = configuredIndexModel();
const provider = createDefaultResponse();
let calls = 0;
let error: string | undefined;
const writeLog = (message: string) => {log.push(message); console.error(message);};
const boundedProvider: typeof provider = async request => {
  if (++calls > 2) throw new Error("Two-call budget reached");
  const started = Date.now();
  try {
    const response = await provider(request);
    requests.push({request, response, elapsedMs: Date.now() - started});
    return response;
  } catch (cause) {
    requests.push({request, error: cause instanceof Error ? cause.message : String(cause), elapsedMs: Date.now() - started});
    throw cause;
  } finally {await fs.writeFile(path.join(directory, "requests.json"), JSON.stringify(requests, null, 2));}
};
try {
  let candidates = timelines;
  if (repairMode) {
    writeLog("Repairing saved review " + previous!.timelineHash + "; approved blocking fields: " +
      JSON.stringify(previous!.issues?.filter(i => i.severity === "blocking").map(i => i.repairFields)));
    const repaired = await repairReviewedSourceFields(boundedProvider, model, "medium", part, previous!);
    await fs.writeFile(path.join(directory, "repair.json"), JSON.stringify(repaired, null, 2));
    for (const change of repaired.changes) writeLog("Source repair change " + JSON.stringify(change));
    candidates = [repaired.timeline];
  }
  for (const timeline of candidates) {
    await replaySourceReviewV2(boundedProvider, model, "medium", part, timeline, {
      previous: records.at(-1) ?? previous,
      onRecord: async record => {records.push(record); await fs.writeFile(path.join(directory, "reviews.json"), JSON.stringify(records, null, 2));},
      log: writeLog,
    });
  }
} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); process.exitCode = 1; }
finally {
  const report = {reviewVersion: 2, inputFile: originalFile, repairFrom: repairMode ? inputFile : undefined, previousReview: previous, sourceHash: createHash("sha256").update(chapter.text).digest("hex"),
    productionBookChanged: false, generatedBeats: false, calls: requests.length, error,
    completed: !error, finalTimelineAccepted: records.at(-1)?.valid === true,
    capturedReviews: reviews.map(c => c.response), reviews: records};
  await fs.writeFile(path.join(directory, "result.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(directory, "review.log"), log.join("\n") + "\n");
  console.log(JSON.stringify({directory, completed: report.completed, finalTimelineAccepted: report.finalTimelineAccepted, calls: requests.length, error, generatedBeats: false, productionBookChanged: false}, null, 2));
}
