import path from "node:path";
import fs from "node:fs/promises";
import { getBook } from "../repository.js";
import { dataDir, loadAiApiKey, loadDotEnv } from "../../util/env.js";
import { configuredIndexModel } from "../../ai/provider.js";
import { createDefaultResponse } from "./identity.js";
import { buildChapterAnalysisBatches } from "./batching.js";
import { requestStagedChapterIndexes } from "./staged-index.js";
import { mergeChapterPartSourceIndexes } from "../source-index.js";
import { importCharacterAnchors } from "./character-anchor-import.js";
import { createAnchorProbeBook, attachAnchorProbeIdentities } from "./anchor-probe-book.js";

loadDotEnv();
loadAiApiKey();
const args = process.argv.slice(2);
const values: Record<string, string[]> = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]!;
  const value = args[i + 1];
  if (!["--book", "--chapter", "--character"].includes(key) || !value || value.startsWith("--")) {
    throw new Error('Usage: npm run measure:anchors -- --book ID --chapter NUMBER --character "Name" [--character "Name"]');
  }
  (values[key] ??= []).push(value);
}
const bookId = values["--book"]?.[0];
const chapterNumber = Number(values["--chapter"]?.[0]);
if (!bookId || !Number.isInteger(chapterNumber) || chapterNumber < 1 || !values["--character"]?.length
  || values["--book"]?.length !== 1 || values["--chapter"]?.length !== 1) throw new Error("Specify one book, one chapter number (1-based) and at least one character");
const original = await getBook(bookId);
// Deliberately isolated; neither saveBook nor production checkpoint APIs are used.
const book = createAnchorProbeBook(original, bookId, chapterNumber);
const chapter = book.chapters[0]!;
const directory = path.join(dataDir(), "anchor-probes", new Date().toISOString().replaceAll(":", "-"));
await fs.mkdir(directory, {recursive: true});
const requests: unknown[] = [];
const provider = createDefaultResponse();
const model = configuredIndexModel();
let calls = 0;
const measured: typeof provider = async request => {
  if (++calls > 16) throw new Error("Probe stopped at its 16-call budget; no production index was changed");
  const started = Date.now();
  try {
    const response = await provider(request);
    requests.push({request, response, elapsedMs: Date.now() - started});
    return response;
  } catch (error) {
    requests.push({request, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started});
    throw error;
  } finally {
    await fs.writeFile(path.join(directory, "requests.json"), JSON.stringify(requests, null, 2));
  }
};
let error: string | undefined;
try {
  const parts = buildChapterAnalysisBatches(book).flatMap(b => b.parts);
  let result = await requestStagedChapterIndexes(measured, model, book, parts, 1, console.error, async () => {}, {sharedEventsOnly: true});
  if (result.invalidParts.length && result.invalidParts.every(part => {
    const checkpoint = book.importAnalysis?.parts[part.sourceId] as {timeline?: unknown; sourceRepair?: unknown; sourceEventRepair?: unknown} | undefined;
    return checkpoint?.timeline && (checkpoint.sourceRepair || checkpoint.sourceEventRepair);
  })) {
    console.error("Applying one targeted source repair before continuing the probe...");
    const repaired = await requestStagedChapterIndexes(measured, model, book, result.invalidParts, 2, console.error, async () => {}, {sharedEventsOnly: true});
    for (const [id, index] of result.indexes) repaired.indexes.set(id, index);
    result = repaired;
  }
  if (result.invalidParts.length) throw new Error([...result.validationErrors.values()].join("\n"));
  const indexes = parts.map(part => result.indexes.get(part.sourceId)!);
  book.chapters[0]!.sourceIndex = {...mergeChapterPartSourceIndexes(0, chapter.index, indexes.map(i => i.summary).join("\n"), indexes), extractionMode: "shared_events_v1"};
  attachAnchorProbeIdentities(book, original?.worldBible?.characterProfiles);
  await importCharacterAnchors(book, measured, model, {characters: values["--character"]});
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(directory, "result.json"), JSON.stringify({productionBookChanged: false, originalChapterNumber: chapterNumber, model, calls: requests.length, error, book}, null, 2));
  console.log(JSON.stringify({directory, passed: !error, calls: requests.length, error, productionBookChanged: false}, null, 2));
}
