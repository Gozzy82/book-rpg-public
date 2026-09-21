import { measureSourceReviewProbe, type SourceReviewProbe } from "./measure-source-probes.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { configuredIndexModel, configuredAiReasoningEffort, type AiResponseRequest } from "../../ai/provider.js";
import type { ImportedBook } from "../../shared/contracts.js";
import { loadAiApiKey, loadDotEnv } from "../../util/env.js";
import { createDefaultResponse } from "./identity.js";
import { checkPrimaryGoal, checkPrimaryGoalPlan, type ExpectedPrimaryGoal } from "./measure-goal-check.js";
import { measureIndexStage, measureGoalReview, measureSourceReview, measureSourceFieldRepair, type SourceReviewFixture, type GoalPlan, type SourceRepairFixture, type LabelRepairFixture } from "./staged-index.js";

// Deliberately separate from import: no writes to the user's book library.
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log('npm run measure:import -- [--models MODEL,MODEL] [--efforts low,medium,high] [--stage source|source-repair|source-review|source-fields|source-summary|source-probes|groups|both|review|repair] [--runs 1] [--attempts 1] [--review-model MODEL] [--out DIRECTORY]\nDefaults: both stages, medium reasoning, one run and one attempt. Source trials stop after source review. Group trials use controlled timelines independently; neither is an end-to-end import test. Uses three fixed source excerpts. Records provider acceptance separately from manual semantic acceptance. Repeats are independent; one attempt per trial by default; --attempts explicitly enables retries. --stage review runs three fixed negative review cases and three positive controls, one call each; expected answers are withheld. --stage repair tests only oil label repair on a fixed reviewed plan (at most 2 calls). --stage source-repair uses the two captured rejected source candidates (oil/story), one repair plus source review each, at most 4 calls total per configuration/run. --stage source-review replays only the source review on the two saved repaired timelines from 2026-09-16T07-49-19.850Z: at most 2 calls per configuration/run, no generation or repair. --stage source-fields uses the same saved timelines with scoped field repairs, one repair and one source review each: at most 4 calls per configuration/run. --stage source-summary uses the already repaired 08:10 story timeline and permits only /summary: at most 2 calls per configuration/run. --stage source-probes runs two fixed source-review controls, one call each. Expected verdicts and repair paths are withheld; at most 2 calls per configuration/run. This makes real, billable model calls.');
  process.exit(0);
}
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]!, value = args[i + 1];
  if (!["--stage", "--models", "--efforts", "--runs", "--attempts", "--review-model", "--out"].includes(key) || !value || value.startsWith("--")) throw new Error(`Invalid argument ${key}; use --help`);
  options.set(key, value);
}
const stageOption = options.get("--stage") || "both";
if (!["source", "source-repair", "source-review", "source-fields", "source-summary", "source-probes", "groups", "both", "review", "repair"].includes(stageOption)) throw new Error("Use --stage source, source-repair, source-review, source-fields, source-summary, source-probes, groups, both, review or repair");
const stages: Array<"source" | "source-repair" | "source-review" | "source-fields" | "source-summary" | "source-probes" | "groups" | "review" | "repair"> = stageOption === "both" ? ["source", "groups"] : [stageOption as "source" | "source-repair" | "source-review" | "source-fields" | "source-summary" | "source-probes" | "groups" | "review" | "repair"];
loadDotEnv(); loadAiApiKey();
const models = (options.get("--models") || configuredIndexModel()).split(",").map(s => s.trim()).filter(Boolean);
const efforts = (options.get("--efforts") || "medium").split(",").map(s => configuredAiReasoningEffort(s.trim()));
const runs = Number(options.get("--runs") || 1);
if (!Number.isInteger(runs) || runs < 1 || runs > 20 || !models.length || !efforts.length) throw new Error("Use 1-20 runs and at least one model and effort");
const maxAttempts = Number(options.get("--attempts") || 1);
if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error("Use 1-5 attempts per trial");
if (["review", "repair", "source-repair", "source-review", "source-fields", "source-summary", "source-probes"].includes(stageOption) && maxAttempts !== 1) throw new Error("Fixed review/repair probes use exactly one attempt; use --runs for independent repeats");
const directory = path.resolve(options.get("--out") || `data/import-measurements/${new Date().toISOString().replaceAll(":", "-")}`);
type Probe = {name: string; sourceFixture: string; plans: GoalPlan[]; labels?: Record<string, unknown>; expectedTarget: "groups" | "labels" | "conditions" | null; rubric: string};
type Fixture = {name: string; owner: string; rubric: string; text: string; probe?: Probe; sourceProbe?: SourceReviewProbe};
let fixtures: Fixture[] = await Promise.all(["toto", "oil", "story"].map(async name => JSON.parse(await readFile(new URL(`../../../test/fixtures/import-goals/${name}.json`, import.meta.url), "utf8")) as {name: string; owner: string; rubric: string; text: string}));
if (stageOption === "source-probes") {
  const probes = JSON.parse(await readFile(new URL("../../../test/fixtures/import-goals/source-review-probes.json", import.meta.url), "utf8")) as SourceReviewProbe[];
  fixtures = probes.map(sourceProbe => ({...fixtures.find(f => f.name === sourceProbe.sourceFixture)!, name: sourceProbe.name, rubric: sourceProbe.rubric, sourceProbe}));
}
if (stageOption === "review") {
  const probes = JSON.parse(await readFile(new URL("../../../test/fixtures/import-goals/review-probes.json", import.meta.url), "utf8")) as Probe[];
  fixtures = probes.map(probe => ({...fixtures.find(f => f.name === probe.sourceFixture)!, name: probe.name, rubric: probe.rubric, probe}));
}
if (["source-repair", "source-review", "source-fields", "source-summary"].includes(stageOption)) fixtures = fixtures.filter(f => f.name !== "toto");
if (stageOption === "source-summary") fixtures = fixtures.filter(f => f.name === "story");
if (stageOption === "repair") fixtures = fixtures.filter(f => f.name === "oil");
console.log(`Planned: ${fixtures.length * stages.length * models.length * efforts.length * runs} independent trials (${stages.join(", ")}), at most ${maxAttempts} attempt(s) each. Source: up to 2 calls; groups: up to 4 calls per first attempt. Review probes: 1 call each (three negative cases and three positive controls). Repair: at most 2 calls (labels and review), with no source generation or replanning. Source repair: up to 2 calls per case, no fresh baseline generation or goal planning. Source review replay: 1 call per case, no generation or repair. Source fields: up to 2 calls per case, field patch plus review. Source summary: one story case, up to 2 calls, summary patch plus current-timeline review. Source probes: 2 controls, 1 review call each, no repairs. No automatic model escalation.`);
const provider = createDefaultResponse();
await mkdir(directory, {recursive: true});
const summaries: unknown[] = [];
let ordinal = 0;
for (let repeat = 1; repeat <= runs; repeat++) {
  // Rotate order across repeats to reduce time-of-day/order bias.
  const configurations = models.flatMap(model => efforts.map(effort => ({model, effort})));
  const offset = (repeat - 1) % configurations.length;
  for (const {model, effort} of [...configurations.slice(offset), ...configurations.slice(0, offset)]) {
    for (const fixture of fixtures) for (const stage of stages) {
      const runDirectory = path.join(directory, `${++ordinal}-${fixture.name}-${stage}`);
      await mkdir(runDirectory); // Refuse to mix a new trial with existing artifacts.
      const sourceSha256 = createHash("sha256").update(fixture.text).digest("hex");
      const book: ImportedBook = {bookId: fixture.name, sourceSha256, title: fixture.name, importedAt: new Date().toISOString(), chapters: [{index: 0, title: fixture.name, text: fixture.text}]};
      const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: fixture.name, partIndex: 0, partCount: 1, lineStart: 1, lineEnd: fixture.text.split("\n").length, text: fixture.text};
      const controlled = stage !== "source" && stage !== "source-repair" && stage !== "source-review" && stage !== "source-fields" && stage !== "source-summary" && stage !== "source-probes" ? JSON.parse(await readFile(new URL(`../../../test/fixtures/import-goals/${fixture.probe?.sourceFixture ?? fixture.name}.timeline.json`, import.meta.url), "utf8")) as {version: number; provenance: string; sourceSha256: string; timeline: Record<string, unknown>; expectedPrimaryGoal: ExpectedPrimaryGoal} : undefined;
      const repair = stage === "repair" ? JSON.parse(await readFile(new URL("../../../test/fixtures/import-goals/oil.label-repair.json", import.meta.url), "utf8")) as LabelRepairFixture : undefined;
      if (repair) await writeFile(path.join(runDirectory, "repair-fixture.json"), JSON.stringify(repair, null, 2));
      const sourceReview = ["source-review", "source-fields", "source-summary"].includes(stage) ? JSON.parse(await readFile(new URL(`../../../test/fixtures/import-goals/${fixture.name}.${stage === "source-summary" ? "source-summary" : "source-review"}.json`, import.meta.url), "utf8")) as SourceReviewFixture : undefined;
      if (sourceReview) await writeFile(path.join(runDirectory, "source-review-fixture.json"), JSON.stringify(sourceReview, null, 2));
      const sourceRepair = stage === "source-repair" ? JSON.parse(await readFile(new URL(`../../../test/fixtures/import-goals/${fixture.name}.source-repair.json`, import.meta.url), "utf8")) as SourceRepairFixture : undefined;
      if (sourceRepair) await writeFile(path.join(runDirectory, "source-repair-fixture.json"), JSON.stringify(sourceRepair, null, 2));
      const measurement = sourceRepair ? {stage: "source-repair" as const, sourceSha256, repair: sourceRepair} : repair && controlled ? {stage: "repair" as const, timeline: controlled.timeline, sourceSha256: controlled.sourceSha256, repair} : controlled ? {stage: "groups" as const, timeline: controlled.timeline, sourceSha256: controlled.sourceSha256} : {stage: "source" as const};
      if (controlled) await writeFile(path.join(runDirectory, "controlled-timeline.json"), JSON.stringify(controlled, null, 2));
      const calls: Array<{stage: string; model: string; effort: string | undefined; ms: number; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; error?: string}> = [];
      const measured = async (request: AiResponseRequest) => {
        const review = request.text?.format.name.includes("review");
        const actual = {...request, model: review && options.has("--review-model") ? options.get("--review-model")! : model,
          reasoning: {effort: review && options.has("--review-model") ? "medium" as const : ["bookrpg_action_goal_labels", "bookrpg_action_goal_conditions"].includes(request.text?.format.name || "") ? "low" as const : effort}};
        const start = Date.now();
        try {
          const response = await provider(actual);
          calls.push({stage: actual.text?.format.name || "unknown", model: actual.model, effort: actual.reasoning.effort, ms: Date.now() - start,
            inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null, reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? null});
          await writeFile(path.join(runDirectory, `call-${calls.length}.json`), JSON.stringify({request: actual, response}, null, 2));
          return response;
        } catch (error) {
          calls.push({stage: actual.text?.format.name || "unknown", model: actual.model, effort: actual.reasoning.effort, ms: Date.now() - start, inputTokens: null, outputTokens: null, reasoningTokens: null, error: String(error)});
          throw error;
        } finally {
          await writeFile(path.join(runDirectory, "calls.json"), JSON.stringify(calls, null, 2));
        }
      };
      const started = Date.now();
      const attempts: unknown[] = [];
      let accepted = false;
      let probePassed: boolean | null = null;
      let reviewOutcome: Awaited<ReturnType<typeof measureGoalReview>> | undefined;
      let primaryGoalCheck: boolean | null = null;
      let finalPrimaryGoalCheck: boolean | null = null;
      const planChecks: Array<{attempt: number; passed: boolean}> = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`${fixture.name}/${stage}: ${model}/${effort}, repeat ${repeat}, attempt ${attempt}`);
        if (fixture.sourceProbe) {
          const result = await measureSourceReviewProbe(measured, model, part, fixture.sourceProbe, effort);
          reviewOutcome = result.outcome; probePassed = result.probePassed;
          attempts.push({attempt, reviewOutcome, probePassed});
          await writeFile(path.join(runDirectory, "source-review-probe.json"), JSON.stringify(fixture.sourceProbe, null, 2));
          console.log(`${fixture.name}: ${probePassed ? "PASS" : "FAIL"} (${reviewOutcome.verdict}); inspect the reason as well as the repair path`);
          break;
        }
        if (sourceReview) {
          if (stage === "source-fields" || stage === "source-summary") {
            const repair = stage === "source-summary" ? (sourceReview as import("./staged-index.js").SourceFieldRepairFixture).repair : JSON.parse(await readFile(new URL(`../../../test/fixtures/import-goals/${fixture.name}.source-fields.json`, import.meta.url), "utf8"));
            await writeFile(path.join(runDirectory, "field-repair-scope.json"), JSON.stringify(repair, null, 2));
            const {timeline, ...outcome} = await measureSourceFieldRepair(measured, model, part, {...sourceReview, repair}, effort);
            reviewOutcome = outcome;
            if (timeline) await writeFile(path.join(runDirectory, "repaired-timeline.json"), JSON.stringify(timeline, null, 2));
          } else reviewOutcome = await measureSourceReview(measured, model, part, sourceReview, effort);
          accepted = reviewOutcome.verdict === "accepted";
          attempts.push({attempt, reviewOutcome});
          console.log(`${fixture.name}: ${reviewOutcome.verdict}${"reason" in reviewOutcome ? `: ${reviewOutcome.reason}` : ""}`);
          break;
        }
        if (fixture.probe && controlled) {
          reviewOutcome = await measureGoalReview(measured, model, part, controlled.timeline, fixture.probe.plans, fixture.probe.labels, effort);
          probePassed = fixture.probe.expectedTarget === null ? reviewOutcome.verdict === "accepted"
            : reviewOutcome.verdict === "rejected" && reviewOutcome.target === fixture.probe.expectedTarget;
          attempts.push({attempt, reviewOutcome});
          await writeFile(path.join(runDirectory, "review-probe.json"), JSON.stringify(fixture.probe, null, 2));
          console.log(`${fixture.name}: ${probePassed ? "PASS" : "FAIL"} (${reviewOutcome.verdict}); inspect reason to confirm the intended defect was identified`);
          break;
        }
        const result = await measureIndexStage(measured, model, book, part, attempt, console.log,
          async () => { await writeFile(path.join(runDirectory, "checkpoint.json"), JSON.stringify(book, null, 2)); }, measurement, {sourceEffort: effort, goalEffort: effort, goalModel: model}, controlled ? async (timeline, plans) => {
            primaryGoalCheck = checkPrimaryGoalPlan(timeline, plans, controlled.expectedPrimaryGoal);
            planChecks.push({attempt, passed: primaryGoalCheck});
            await writeFile(path.join(runDirectory, `goal-plan-${attempt}.json`), JSON.stringify({plans, expected: controlled.expectedPrimaryGoal, primaryGoalCheck}, null, 2));
            console.log(`${fixture.name}: primary goal boundary check ${primaryGoalCheck ? "PASS" : "FAIL"} (before semantic review and labels)`);
          } : undefined);
        attempts.push({attempt, errors: Object.fromEntries(result.validationErrors)});
        const index = result.artifacts.get(part.sourceId);
        if (index) {
          accepted = true;
          if (controlled) finalPrimaryGoalCheck = checkPrimaryGoal(index, controlled.expectedPrimaryGoal);
          await writeFile(path.join(runDirectory, (stage === "source" || stage === "source-repair") ? "timeline.json" : "grouped-index.json"), JSON.stringify(index, null, 2));
          break;
        }
      }
      const total = (key: "inputTokens" | "outputTokens") => calls.every(c => c[key] !== null) ? calls.reduce((n, c) => n + c[key]!, 0) : null;
      const summary = {stage, fixture: fixture.name, sourceSha256, model, effort, reviewModel: options.get("--review-model") || model,
        repeat, maxAttempts, sourceProbeVersion: fixture.sourceProbe?.fixtureVersion, acceptedByStage: stage === "review" || stage === "source-probes" ? null : accepted, probePassed, reviewOutcome, primaryGoalCheck, finalPrimaryGoalCheck, planChecks, endToEndImportTested: false, reviewOnly: stage === "source-review" || stage === "source-probes", repairOnly: stage === "repair" || stage === "source-repair" || stage === "source-fields" || stage === "source-summary", controlledTimelineVersion: controlled?.version, controlledTimelineProvenance: controlled?.provenance, manualSemanticAcceptance: "pending", rubric: stage !== "source" && stage !== "source-repair" && stage !== "source-review" && stage !== "source-fields" && stage !== "source-summary" && stage !== "source-probes" ? fixture.rubric : "Source-backed identities, complete meaningful actions, intentionality versus ability/automatic state, chronology, references and narration framing; no goal boundaries judged.", attempts,
        calls: calls.length, elapsedMs: Date.now() - started, inputTokens: total("inputTokens"), outputTokens: total("outputTokens"), artifacts: runDirectory};
      summaries.push(summary);
      await writeFile(path.join(runDirectory, "result.json"), JSON.stringify(summary, null, 2));
      await writeFile(path.join(directory, "summary.json"), JSON.stringify(summaries, null, 2));
    }
  }
}
console.log(`Results: ${path.join(directory, "summary.json")}. Review the three rubrics and resulting indexes before selecting a model or importing a full book.`);
