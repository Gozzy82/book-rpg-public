import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { measureGoalReview, type GoalPlan } from "../src/books/analyze/staged-index.js";

const json = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/import-goals/${name}.json`, import.meta.url), "utf8"));
const probes = await json("review-probes") as Array<{name: string; sourceFixture: string; plans: GoalPlan[]; labels?: Record<string, unknown>; expectedTarget: "groups" | "labels" | "conditions" | null}>;

for (const probe of probes) {
  test(`fixed review probe routes through production audit: ${probe.name}`, async () => {
    const source = await json(probe.sourceFixture);
    const controlled = await json(`${probe.sourceFixture}.timeline`);
    const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: "review fixture", partIndex: 0, partCount: 1, lineStart: 1, lineEnd: source.text.split("\n").length, text: source.text};
    let calls = 0;
    const result = await measureGoalReview(async request => {
      calls++;
      assert.equal(request.text!.format.name, probe.labels ? "bookrpg_action_goal_label_review" : "bookrpg_action_goal_review");
      assert.ok(!request.input.includes("expectedTarget"));
      assert.ok(!request.input.includes(probe.name));
      assert.match(request.instructions!, /commitment to a concrete action and its immediate execution are one goal/);
      assert.match(request.instructions!, /COMPLETION IS OBSERVED OUTCOME/);
      if (probe.labels && probe.sourceFixture === "toto") {
        const evidence = JSON.parse(request.input.split("GOAL OUTCOME EVIDENCE (observed endpoint, not desired success):\n")[1]!.split("\nGOAL START CONTEXTS")[0]!);
        const follow = evidence.find((e: any) => e.startBeatIndex === 6);
        assert.equal(follow.endBeatIndex, 10);
        assert.match(follow.endpointBeat.resultingState, /floor/);
      }
      return {status: "completed", output_text: JSON.stringify({valid: probe.expectedTarget === null, issues: probe.expectedTarget ? [{target: probe.expectedTarget, reason: "Controlled test verdict for the intended defect"}] : []})};
    }, "test", part, controlled.timeline, probe.plans, probe.labels, "medium");
    assert.equal(calls, 1);
    assert.equal(result.verdict, probe.expectedTarget ? "rejected" : "accepted");
    if (result.verdict === "rejected") assert.equal(result.target, probe.expectedTarget);
    const failure = await measureGoalReview(async () => {throw new Error("Transport failed");}, "test", part, controlled.timeline, probe.plans, probe.labels, "medium");
    assert.equal(failure.verdict, "error", "transport failure is not successful detection of the injected defect");
  });
}

test("positive and negative controls differ only in the intended defect", () => {
  const bad = probes[0]!, good = probes[1]!;
  assert.deepEqual(bad.plans, good.plans);
  const patched = structuredClone(bad.labels!);
  (patched.beat_6 as any).completion = (good.labels!.beat_6 as any).completion;
  assert.deepEqual(patched, good.labels);
  assert.match((bad.labels!.beat_6 as any).completion, /reaches the shelter/);
  assert.match((good.labels!.beat_6 as any).completion, /without reaching the shelter/);
  assert.deepEqual(probes[2]!.plans.map(p => [p.startBeatIndex, p.endBeatIndex]), [[0, 0], [1, 1], [2, 7]]);
  assert.deepEqual(probes[3]!.plans.map(p => [p.startBeatIndex, p.endBeatIndex]), [[0, 0], [1, 7]]);
});

test("question interruption control removes only the after-completion condition", () => {
  const bad = probes.find(p => p.name === "question-after-completion")!;
  const good = probes.find(p => p.name === "question-empty-conditions-control")!;
  assert.deepEqual(bad.plans, good.plans);
  const fixed = structuredClone(bad.labels!);
  (fixed.beat_0 as any).interruptWhen = [];
  assert.deepEqual(fixed, good.labels);
});
