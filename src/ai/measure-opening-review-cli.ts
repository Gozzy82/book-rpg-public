import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { configuredAiModel } from "./provider.js";
import { loadDotEnv, loadAiApiKey } from "../util/env.js";
import { createDefaultResponse } from "../books/analyze/identity.js";
import { openingReviewRequest, scoreOpeningReview, type OpeningReviewFixture } from "./engine/measure-opening-review.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("npm run measure:opening -- [--model MODEL] [--out DIRECTORY]\nFive fixed presence reviews: four captured openings and one explicit unauthorized retrieval. One attempt each; no scene generation, repair, retries or gameplay writes. Default: configured scene model, medium reasoning. Billable model calls.");
  process.exit(0);
}
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!["--model", "--out"].includes(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith("--") || options.has(args[i]!)) throw new Error("Invalid arguments; use --help");
  options.set(args[i]!, args[i + 1]!);
}
loadDotEnv(); loadAiApiKey();
const model = options.get("--model") || configuredAiModel();
const fixture: OpeningReviewFixture = JSON.parse(await readFile(new URL("../../test/fixtures/opening-review.json", import.meta.url), "utf8"));
const directory = path.resolve(options.get("--out") || `data/opening-review-measurements/${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(directory, {recursive: true});
await writeFile(path.join(directory, "fixture.json"), JSON.stringify(fixture, null, 2));
const createResponse = createDefaultResponse();
const results: unknown[] = [];
console.log(`Five presence reviews, ${model}/medium, one attempt each. No generation or retries.`);
for (const [i, sample] of fixture.cases.entries()) {
  const started = Date.now();
  console.log(`${i + 1}/${fixture.cases.length}: ${sample.name}`);
  const request = openingReviewRequest(fixture, i, model);
  await writeFile(path.join(directory, `${sample.name}-request.json`), JSON.stringify(request, null, 2));
  try {
    const response = await createResponse(request);
    await writeFile(path.join(directory, `${sample.name}-response.json`), JSON.stringify(response, null, 2));
    const score = scoreOpeningReview(fixture, i, request, response);
    results.push({name: sample.name, model, elapsedMs: Date.now() - started, usage: response.usage, ...score});
    console.log(score.passed ? "PASS" : "FAIL (see report evidence)");
  } catch (error) {
    results.push({name: sample.name, model, passed: false, elapsedMs: Date.now() - started, error: String(error)});
    console.log("ERROR (saved, no retry)");
  }
  await writeFile(path.join(directory, "report.json"), JSON.stringify(results, null, 2));
}
console.log(`Saved ${directory}`);
