import assert from "node:assert/strict";
import test from "node:test";
import type { ImportedBook } from "../src/shared/contracts.js";
import type { AiResponseRequest } from "../src/ai/provider.js";
import { requestStagedChapterIndexes, validateGoalPlan, compileGoalEvents, flattenTimeline, type GoalPlan } from "../src/books/analyze/staged-index.js";
import { mergeChapterPartSourceIndexes } from "../src/books/source-index.js";
import { isReusableChapterSourceIndex } from "../src/books/source-index/reuse.js";

const output = (v: unknown) => ({status: "completed" as const, output_text: JSON.stringify(v)});
const success = () => output({valid: true, issues: [], previousFindings: []});
const refs = [{lineStart: 1, lineEnd: 1}];
const b = (actor: string, action: string) => ({sourceSemantics: {mode: "present" as const, narratedContent: null, intentionalRole: "other" as const, jointAction: null}, actor, action, resultingState: `${actor} has completed: ${action}`, agency: "intentional" as const, stakes: "significant" as const, references: refs, targets: []});
const goal = (startBeatIndex: number, endBeatIndex: number, name = "Complete the bounded goal"): GoalPlan => ({startBeatIndex, endBeatIndex, goal: name, boundaryReason: "The goal has completed before a different commitment"});
function fixture(beats = [b("Dorothy", "Starts retrieving Toto"), b("Aunt Em", "Descends"), b("Dorothy", "Catches Toto"), b("Dorothy", "Follows Aunt Em")]) {
  const text = "Dorothy starts retrieving Toto. Aunt Em descends. Dorothy catches Toto then follows Aunt Em. Scarecrow helps Tin Woodman.";
  const book: ImportedBook = {bookId: "test", sourceSha256: "test", title: "test", importedAt: "now", chapters: [{index: 0, title: "test", text}]};
  const part = {sourceId: "chapter_1_part_1", chapterPosition: 0, chapterIndex: 0, chapterTitle: "test", partIndex: 0, partCount: 1, lineStart: 1, lineEnd: 1, text};
  const timeline = {summary: "A source-backed timeline", significantEvents: [{description: "Present actions", references: refs, actors: [...new Set(beats.map(b => b.actor))], targets: [], beats}],
    characters: [...new Set(beats.map(b => b.actor))].map(name => ({name, aliases: [], references: refs})), actions: [], relationships: []};
  return {book, part, timeline};
}
const labels = (plans: GoalPlan[]) => Object.fromEntries(plans.map(p => [`beat_${p.startBeatIndex}`, {
  choiceText: p.goal, completion: `Completed ${p.goal}`, preconditions: ["Actor can begin"], interruptWhen: ["New danger blocks the goal"],
}]));
function providerFor(timeline: ReturnType<typeof fixture>["timeline"], plans: GoalPlan[], calls: string[]) {
  return async (request: AiResponseRequest) => {
    const stage = request.text!.format.name;
    calls.push(stage);
    if (stage === "bookrpg_source_timeline") {
      const schema = request.text!.format.schema as any;
      const properties = schema.properties.chapter_1_part_1.properties.significantEvents.items.properties.beats.items.anyOf[0].properties;
      assert.equal(properties.playerAction, undefined);
      assert.equal(properties.decisionBoundaryBefore, undefined);
      return output({chapter_1_part_1: timeline});
    }
    if (stage === "bookrpg_action_goal_plan") return output({groups: plans});
    if (stage === "bookrpg_action_goal_labels") {
      assert.match(request.input, /FROZEN GOALS/);
      assert.equal((request.text!.format.schema as any).properties.beat_0.properties.endBeatIndex, undefined);
      return output(labels(plans));
    }
    assert.match(stage, /review$/);
    return success();
  };
}

test("coverage rejects omitted Toto retrieval, overlaps and routine starts while allowing other actors inside a group", () => {
  const {timeline} = fixture();
  const event = timeline.significantEvents[0]!;
  assert.throws(() => validateGoalPlan(event, [goal(3, 3)]), /Unassigned intentional beats/);
  assert.throws(() => validateGoalPlan(event, [goal(0, 2), goal(1, 1), goal(2, 2), goal(3, 3)]), /more than one goal/);
  assert.equal(validateGoalPlan(event, [goal(0, 2), goal(1, 1), goal(3, 3)]).length, 3);
  const routine = structuredClone(event) as any;
  routine.beats[0].stakes = "routine";
  assert.throws(() => validateGoalPlan(routine, [goal(0, 2)]), /eligible beat/);
});

for (const [name, beats, plans, expected] of [
  ["Toto retrieval", undefined, [goal(0, 2, "Retrieve Toto"), goal(1, 1, "Descend"), goal(3, 3, "Follow Aunt Em")], [0, 2]],
  ["neck arms and legs remain one rescue", [b("Dorothy", "Fetches oil"), b("Dorothy", "Oils neck"), b("Scarecrow", "Loosens neck"), b("Dorothy", "Oils arms"), b("Tin Woodman", "Requests oil on legs"), b("Dorothy", "Oils legs")], [goal(0, 5, "Free Tin Woodman"), goal(2, 2, "Loosen neck"), goal(4, 4, "Guide the rescue")], [0, 1, 3, 5]],
  ["framed storytelling", [b("Tin Woodman", "Begins telling his history"), b("Tin Woodman", "Recounts the witch's attack"), b("Tin Woodman", "Recounts the rain and rust")], [goal(0, 2, "Tell the entire account")], [0, 1, 2]],
] as const) {
  test(`production stages: ${name}`, async () => {
    const {book, part, timeline} = fixture(beats ? [...beats] : undefined);
    const sourceEvent = timeline.significantEvents[0]!;
    timeline.significantEvents = sourceEvent.beats.map(beat => ({...sourceEvent, beats: [beat]}));
    const calls: string[] = [];
    let saved = "";
    const result = await requestStagedChapterIndexes(providerFor(timeline, [...plans], calls), "test", book, [part], 1, () => {}, async () => { saved = JSON.stringify(book); });
    assert.deepEqual([...result.validationErrors], []);
    const index = result.indexes.get(part.sourceId)!;
    assert.deepEqual(index.significantEvents[0]!.beats[0]!.playerAction!.playerBeatIndexes, expected);
    assert.deepEqual(calls, ["bookrpg_source_timeline", "bookrpg_source_timeline_review", "bookrpg_action_goal_plan", "bookrpg_action_goal_review", "bookrpg_action_goal_labels", "bookrpg_action_goal_label_review"]);
    assert.ok(isReusableChapterSourceIndex(mergeChapterPartSourceIndexes(0, 0, index.summary, [index])));
    const restored = JSON.parse(saved) as ImportedBook;
    const resumed = await requestStagedChapterIndexes(async () => {throw new Error("Approved stages must survive restart");}, "test", restored, [part], 1, () => {}, async () => {});
    assert.equal(resumed.indexes.size, 1);
  });
}

test("rejected fragmentation reopens the goal stage without rebuilding source or writing misleading labels", async () => {
  const {book, part, timeline} = fixture();
  const plans = [goal(0, 2), goal(1, 1), goal(3, 3)];
  const calls: string[] = [];
  const normal = providerFor(timeline, plans, calls);
  let reviews = 0;
  const provider = async (request: AiResponseRequest) => {
    if (request.text!.format.name === "bookrpg_action_goal_plan" && reviews > 0) {
      const previous = JSON.parse(request.input.split("PREVIOUS REJECTED GOAL PLAN (untrusted):\n")[1]!.split("\n")[0]!);
      assert.deepEqual(previous, plans);
    }
    if (request.text!.format.name === "bookrpg_action_goal_review" && ++reviews === 1) return output({valid: false, issues: [{target: "groups", reason: "Retrieval is one goal across Aunt Em descending"}]});
    return normal(request);
  };
  const rejected = await requestStagedChapterIndexes(provider, "test", book, [part], 1, () => {}, async () => {});
  assert.equal(rejected.indexes.size, 0);
  assert.ok(!calls.includes("bookrpg_action_goal_labels"));
  const restored = JSON.parse(JSON.stringify(book));
  const accepted = await requestStagedChapterIndexes(provider, "test", restored, [part], 2, () => {}, async () => {});
  assert.equal(accepted.indexes.size, 1);
  assert.equal(calls.filter(c => c === "bookrpg_source_timeline").length, 1);
  assert.equal(calls.filter(c => c === "bookrpg_action_goal_plan").length, 2);
});

test("old index is re-audited and historical actor defects reopen source before grouping", async () => {
  const {book, part, timeline} = fixture();
  book.chapters[0]!.sourceIndex = {...mergeChapterPartSourceIndexes(0, 0, timeline.summary, [timeline]), schemaVersion: 11} as any;
  const calls: string[] = [];
  const normal = providerFor(timeline, [goal(0, 2), goal(1, 1), goal(3, 3)], calls);
  let reviews = 0;
  const provider = async (request: AiResponseRequest) => {
    if (request.text!.format.name === "bookrpg_source_timeline_review" && ++reviews === 1) return output({valid: false, issues: [{target: "source", reason: "Historical actors must be narrated by the present storyteller"}]});
    return normal(request);
  };
  const first = await requestStagedChapterIndexes(provider, "test", book, [part], 1, () => {}, async () => {});
  assert.equal(first.indexes.size, 0);
  assert.equal(calls.length, 0, "legacy candidate goes directly to audit, not automatic approval");
  const second = await requestStagedChapterIndexes(provider, "test", book, [part], 2, () => {}, async () => {});
  assert.equal(second.indexes.size, 1);
  assert.equal(calls[0], "bookrpg_source_timeline");
});

test("label-only rejection preserves the reviewed plan across restart", async () => {
  const {book, part, timeline} = fixture();
  const calls: string[] = [];
  const normal = providerFor(timeline, [goal(0, 2), goal(1, 1), goal(3, 3)], calls);
  let reviews = 0;
  const provider = async (request: AiResponseRequest) => {
    if (request.text!.format.name === "bookrpg_action_goal_label_review" && ++reviews === 1) return output({valid: false, issues: [{target: "labels", reason: "Label promises a future goal"}]});
    return normal(request);
  };
  const first = await requestStagedChapterIndexes(provider, "test", book, [part], 1, () => {}, async () => {});
  assert.equal(first.indexes.size, 0);
  const restored = JSON.parse(JSON.stringify(book));
  const second = await requestStagedChapterIndexes(provider, "test", restored, [part], 2, () => {}, async () => {});
  assert.equal(second.indexes.size, 1);
  assert.equal(calls.filter(c => c === "bookrpg_action_goal_plan").length, 1);
  assert.equal(calls.filter(c => c === "bookrpg_action_goal_labels").length, 2);
});

test("changed source invalidates intermediate checkpoints and missing v12 coverage is not reusable", async () => {
  const {book, part, timeline} = fixture();
  const calls: string[] = [];
  const normal = providerFor(timeline, [goal(0, 2), goal(1, 1), goal(3, 3)], calls);
  await requestStagedChapterIndexes(normal, "test", book, [part], 1, () => {}, async () => {});
  const changed = {...part, text: part.text + " A change."};
  await requestStagedChapterIndexes(normal, "test", book, [changed], 1, () => {}, async () => {});
  assert.equal(calls.filter(c => c === "bookrpg_source_timeline").length, 2);
  const incomplete = mergeChapterPartSourceIndexes(0, 0, timeline.summary, [timeline]);
  assert.equal(isReusableChapterSourceIndex(incomplete), false);
});


test("goals cross source event containers, then runtime endpoints are rebased without changing evidence", async () => {
  const {book, part, timeline} = fixture();
  const original = structuredClone(timeline.significantEvents[0]!);
  timeline.significantEvents = [
    {...original, description: "Starts retrieval", beats: original.beats.slice(0, 1)},
    {...original, description: "Em descends", beats: original.beats.slice(1, 2)},
    {...original, description: "Catches Toto", beats: original.beats.slice(2, 3)},
    {...original, description: "Follows Em", beats: original.beats.slice(3)},
  ];
  const plans = [goal(0, 2, "Retrieve Toto"), goal(1, 1, "Descend"), goal(3, 3, "Follow")];
  const calls: string[] = [];
  const normal = providerFor(timeline, plans, calls);
  const result = await requestStagedChapterIndexes(async request => {
    if (request.text!.format.name === "bookrpg_action_goal_plan") {
      const full = JSON.parse(request.input.split("COMPLETE IMMUTABLE TIMELINE (absolute source-part beat indexes):\n")[1]!);
      assert.equal(full.beats.length, 4);
      assert.deepEqual(full.beats.map((b: any) => b.beatIndex), [0, 1, 2, 3]);
    }
    return normal(request);
  }, "test", book, [part], 1, () => {}, async () => {});
  assert.deepEqual([...result.validationErrors], []);
  const events = result.indexes.get(part.sourceId)!.significantEvents;
  assert.equal(events.length, 2);
  assert.deepEqual(events[0]!.beats[0]!.playerAction!.playerBeatIndexes, [0, 2]);
  assert.equal(events[0]!.beats[0]!.playerAction!.endBeatIndex, 2);
  assert.deepEqual(events[1]!.beats[0]!.playerAction!.playerBeatIndexes, [0]);
  assert.equal(events[1]!.beats[0]!.playerAction!.endBeatIndex, 0);
  assert.deepEqual(events.flatMap(e => e.beats.map(b => [b.actor, b.action, b.references])), original.beats.map(b => [b.actor, b.action, b.references]));
  assert.equal(calls.filter(c => c === "bookrpg_source_timeline").length, 1);
});

test("overlapping actor windows transitively merge event containers", () => {
  const {timeline} = fixture([b("Dorothy", "Starts"), b("Scarecrow", "Starts"), b("Dorothy", "Finishes"), b("Scarecrow", "Finishes")]);
  const original = timeline.significantEvents[0]!;
  timeline.significantEvents = original.beats.map(beat => ({...original, beats: [beat]}));
  const events = compileGoalEvents(timeline, flattenTimeline(timeline), [goal(0, 2), goal(1, 3)]);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.beats.length, 4);
});

test("source review cannot reject goal groups that do not exist; invalid verdict preserves timeline", async () => {
  const {book, part, timeline} = fixture();
  const calls: string[] = [];
  const normal = providerFor(timeline, [goal(0, 2), goal(1, 1), goal(3, 3)], calls);
  const logs: string[] = [];
  let reviews = 0;
  const provider = async (request: AiResponseRequest) => {
    if (request.text!.format.name === "bookrpg_source_timeline_review") {
      assert.deepEqual((request.text!.format.schema as any).properties.issues.items.properties.target.enum, ["source"]);
      assert.match(request.instructions!, /Persistent source-backed state remains valid/);
      if (++reviews === 1) return output({valid: false, issues: [{target: "groups", reason: "Split the rescue"}]});
    }
    return normal(request);
  };
  const first = await requestStagedChapterIndexes(provider, "test", book, [part], 1, s => logs.push(s), async () => {});
  assert.equal(first.indexes.size, 0);
  assert.ok(logs.some(l => l.includes("Rejected chapter_1_part_1: Invalid audit issue")));
  const second = await requestStagedChapterIndexes(provider, "test", book, [part], 2, () => {}, async () => {});
  assert.equal(second.indexes.size, 1);
  assert.equal(calls.filter(c => c === "bookrpg_source_timeline").length, 1);
});

test("source benchmark stops before grouping and cannot seed a production approval", async () => {
  const {measureIndexStage} = await import("../src/books/analyze/staged-index.js");
  const {book, part, timeline} = fixture();
  const calls: string[] = [];
  const provider = providerFor(timeline, [goal(0, 2), goal(1, 1), goal(3, 3)], calls);
  const result = await measureIndexStage(provider, "test", book, part, 1, () => {}, async () => {}, {stage: "source"});
  assert.equal(result.artifacts.size, 1);
  assert.deepEqual(calls, ["bookrpg_source_timeline", "bookrpg_source_timeline_review"]);
  calls.length = 0;
  await requestStagedChapterIndexes(provider, "test", book, [part], 1, () => {}, async () => {});
  assert.equal(calls[0], "bookrpg_source_timeline", "measurement approvals cannot be reused by import");
});

for (const [name, plans, ownerMembers] of [
  ["toto", [goal(0, 1), goal(2, 5), goal(3, 4), goal(6, 6)], [2, 5]],
  ["oil", [goal(0, 0), goal(1, 8), goal(2, 14), goal(7, 14), goal(11, 11), goal(12, 12), goal(15, 15)], [2, 3, 4, 6, 9, 13]],
  ["story", [goal(0, 0), goal(1, 7)], [1, 2, 3, 4, 5, 6, 7]],
] as const) {
  test(`controlled ${name} benchmark runs real grouping stages without source calls`, async () => {
    const {readFile} = await import("node:fs/promises");
    const {measureIndexStage} = await import("../src/books/analyze/staged-index.js");
    const source = JSON.parse(await readFile(new URL(`./fixtures/import-goals/${name}.json`, import.meta.url), "utf8"));
    const controlled = JSON.parse(await readFile(new URL(`./fixtures/import-goals/${name}.timeline.json`, import.meta.url), "utf8"));
    const {book, part} = fixture();
    part.text = source.text;
    part.lineEnd = source.text.split("\n").length;
    book.chapters[0]!.text = source.text;
    const calls: string[] = [];
    const provider = providerFor(controlled.timeline, [...plans], calls);
    const measurement = {stage: "groups" as const, timeline: controlled.timeline, sourceSha256: controlled.sourceSha256};
    const result = await measureIndexStage(provider, "test", book, part, 1, () => {}, async () => {}, measurement);
    assert.deepEqual([...result.validationErrors], []);
    assert.deepEqual(calls, ["bookrpg_action_goal_plan", "bookrpg_action_goal_review", "bookrpg_action_goal_labels", "bookrpg_action_goal_label_review"]);
    const index = result.artifacts.get(part.sourceId)!;
    const {checkPrimaryGoal} = await import("../src/books/analyze/measure-goal-check.js");
    assert.equal(checkPrimaryGoal(index, controlled.expectedPrimaryGoal), true);
    assert.equal(checkPrimaryGoal(index, {...controlled.expectedPrimaryGoal, playerBeatIndexes: [999]}), false);
    let offset = 0;
    const memberships: number[][] = [];
    for (const event of index.significantEvents) {
      for (const beat of event.beats) if (beat.actor === source.owner && beat.playerAction) memberships.push(beat.playerAction.playerBeatIndexes.map(i => i + offset));
      offset += event.beats.length;
    }
    assert.ok(memberships.some(m => JSON.stringify(m) === JSON.stringify(ownerMembers)));
    await assert.rejects(measureIndexStage(provider, "test", book, {...part, text: part.text + " changed"}, 1, () => {}, async () => {}, measurement), /source hash/);
    const rejectionCalls: string[] = [];
    const rejected = await measureIndexStage(async request => {
      rejectionCalls.push(request.text!.format.name);
      if (request.text!.format.name === "bookrpg_action_goal_review") return output({valid: false, issues: [{target: "source", reason: "Controlled fixture needs investigation"}]});
      return provider(request);
    }, "test", {...book, importAnalysis: undefined}, part, 1, () => {}, async () => {}, measurement);
    assert.equal(rejected.artifacts.size, 0);
    assert.ok(!rejectionCalls.some(s => s.startsWith("bookrpg_source")));
  });
}

for (const [name, firstAction, badCondition, goodCondition] of [
  ["story commitment", "Offers to tell his story", "Tin Woodman has committed to telling his story", "Tin Woodman is present and able to speak"],
  ["oiling explanation", "Requests oil and explains the treatment", "The requested treatment has already been explained", "Tin Woodman is rusted and unable to move"],
]) {
  test(`before-first-beat context and label-only repair: ${name}`, async () => {
    const {goalStartContexts} = await import("../src/books/analyze/staged-index.js");
    const {GOAL_START_POLICY} = await import("../src/books/analyze/action-goal-policy.js");
    const {book, part, timeline} = fixture([
      b("Tin Woodman", firstAction!), b("Dorothy", "Responds to his request"),
    ]);
    const plans = [goal(0, 0), goal(1, 1)];
    const context = goalStartContexts(timeline.significantEvents[0]!, plans);
    assert.equal(context[0]!.lastCompletedBeatIndex, null);
    assert.equal(context[0]!.precedingResultingState, null);
    assert.equal(context[0]!.firstBeatNotYetExecuted.action, firstAction);
    assert.equal(context[1]!.lastCompletedBeatIndex, 0);
    assert.equal(context[1]!.precedingResultingState, timeline.significantEvents[0]!.beats[0]!.resultingState);
    const calls: string[] = [];
    const normal = providerFor(timeline, plans, calls);
    let labelAttempt = 0, reviewAttempt = 0;
    const contextInputs: string[] = [];
    const provider = async (request: AiResponseRequest) => {
      const stage = request.text!.format.name;
      if (stage === "bookrpg_action_goal_labels" || stage === "bookrpg_action_goal_label_review") {
        calls.push(stage);
        assert.ok(request.instructions!.includes(GOAL_START_POLICY));
        const supplied = request.input.split("GOAL START CONTEXTS (immediately before each first beat):\n")[1]!.split("\nLABELED EVENT:")[0]!;
        contextInputs.push(supplied);
        assert.deepEqual(JSON.parse(supplied), context);
        if (stage === "bookrpg_action_goal_labels") {
          const value = labels(plans);
          value.beat_0!.preconditions = [++labelAttempt === 1 ? badCondition! : goodCondition!];
          value.beat_1!.preconditions = ["Tin Woodman has made his request"];
          return output(value);
        }
        if (++reviewAttempt === 1) return output({valid: false, issues: [{target: "labels", reason: `${badCondition} is established by first beat 0, not before it.`}]});
        return success();
      }
      return normal(request);
    };
    const rejected = await requestStagedChapterIndexes(provider, "test", book, [part], 1, () => {}, async () => {});
    assert.equal(rejected.indexes.size, 0);
    const resumed = await requestStagedChapterIndexes(provider, "test", JSON.parse(JSON.stringify(book)), [part], 2, () => {}, async () => {});
    assert.equal(resumed.indexes.size, 1);
    const beats = resumed.indexes.get(part.sourceId)!.significantEvents[0]!.beats;
    assert.deepEqual(beats[0]!.playerAction!.preconditions, [goodCondition]);
    assert.deepEqual(beats[1]!.playerAction!.preconditions, ["Tin Woodman has made his request"]);
    assert.equal(new Set(contextInputs).size, 1, "writer and reviewer use identical before-action evidence across repair");
    assert.equal(calls.filter(c => c === "bookrpg_source_timeline").length, 1);
    assert.equal(calls.filter(c => c === "bookrpg_action_goal_plan").length, 1);
    assert.equal(calls.filter(c => c === "bookrpg_action_goal_labels").length, 2);
  });
}

for (const broadOffer of [false, true]) {
  test(`measurement preserves ${broadOffer ? "failed" : "passed"} oil boundary check after label rejection`, async () => {
    const {readFile} = await import("node:fs/promises");
    const {measureIndexStage} = await import("../src/books/analyze/staged-index.js");
    const {checkPrimaryGoalPlan} = await import("../src/books/analyze/measure-goal-check.js");
    const source = JSON.parse(await readFile(new URL("./fixtures/import-goals/oil.json", import.meta.url), "utf8"));
    const controlled = JSON.parse(await readFile(new URL("./fixtures/import-goals/oil.timeline.json", import.meta.url), "utf8"));
    const {book, part} = fixture();
    part.text = source.text;
    part.lineEnd = source.text.split("\n").length;
    const plans = broadOffer
      ? [goal(0, 14), goal(1, 14), goal(7, 14), goal(15, 15)]
      : [goal(0, 1), goal(1, 14), goal(2, 14), goal(7, 14), goal(15, 15)];
    const calls: string[] = [];
    const provider = providerFor(controlled.timeline, plans, calls);
    let observed: boolean | null = null;
    const result = await measureIndexStage(async request => {
      if (request.text!.format.name === "bookrpg_action_goal_review") {
        assert.equal(observed, !broadOffer, "measurement runs before even the goal review");
      }
      if (request.text!.format.name === "bookrpg_action_goal_label_review") {
        return output({valid: false, issues: [{target: "labels", reason: "A later label defect must not erase the independent plan result"}]});
      }
      return provider(request);
    }, "test", book, part, 1, () => {}, async () => {},
    {stage: "groups", timeline: controlled.timeline, sourceSha256: controlled.sourceSha256}, {},
    async (timeline, capturedPlans) => {
      observed = checkPrimaryGoalPlan(timeline, capturedPlans, controlled.expectedPrimaryGoal);
      capturedPlans.length = 0;
      timeline.beats.length = 0; // Observers cannot mutate the production partition.
    });
    assert.equal(result.artifacts.size, 0);
    assert.equal(observed, !broadOffer);
    assert.ok(result.validationErrors.get(part.sourceId)!.includes("later label defect"));
  });
}

test("conditions-only rejection survives restart and rejects attempts to change frozen completion", async () => {
  const {book, part, timeline} = fixture();
  const plans = [goal(0, 2), goal(1, 1), goal(3, 3)];
  const calls: string[] = [];
  const normal = providerFor(timeline, plans, calls);
  let reviews = 0, repairs = 0;
  const provider = async (request: AiResponseRequest) => {
    const stage = request.text!.format.name;
    if (stage === "bookrpg_action_goal_label_review") {
      assert.ok((request.text!.format.schema as any).properties.issues.items.properties.target.enum.includes("conditions"));
      assert.match(request.instructions!, /no answer is NOT an interruption/);
      if (++reviews === 1) return output({valid: false, issues: [{target: "conditions", reason: "No answer after asking cannot interrupt a completed question"}]});
      return success();
    }
    if (stage === "bookrpg_action_goal_conditions") {
      calls.push(stage);
      repairs++;
      const schema = request.text!.format.schema as any;
      assert.deepEqual(Object.keys(schema.properties.beat_0.properties), ["preconditions", "interruptWhen"]);
      assert.equal(schema.properties.beat_0.properties.preconditions.minItems, undefined);
      const patch: Record<string, unknown> = Object.fromEntries(plans.map(p => [`beat_${p.startBeatIndex}`, {preconditions: [], interruptWhen: []}]));
      if (repairs === 1) (patch.beat_0 as any).completion = "Invented successful arrival";
      return output(patch);
    }
    return normal(request);
  };
  const first = await requestStagedChapterIndexes(provider, "test", book, [part], 1, () => {}, async () => {});
  assert.equal(first.indexes.size, 0);
  const checkpoint = (book.importAnalysis!.parts[part.sourceId] as any).events[0];
  assert.equal(checkpoint.conditionsNeedRepair, true);
  const frozen = structuredClone(checkpoint.actions);
  const restored = JSON.parse(JSON.stringify(book));
  const second = await requestStagedChapterIndexes(provider, "test", restored, [part], 2, () => {}, async () => {});
  assert.equal(second.indexes.size, 0);
  assert.match(second.validationErrors.get(part.sourceId)!, /may only change/);
  assert.deepEqual(restored.importAnalysis.parts[part.sourceId].events[0].actions, frozen, "invalid patch is atomic");
  const third = await requestStagedChapterIndexes(provider, "test", JSON.parse(JSON.stringify(restored)), [part], 3, () => {}, async () => {});
  assert.equal(third.indexes.size, 1);
  const beats = third.indexes.get(part.sourceId)!.significantEvents[0]!.beats;
  for (const p of plans) assert.deepEqual(beats[p.startBeatIndex]!.playerAction, {...frozen[p.startBeatIndex], preconditions: [], interruptWhen: []});
  assert.equal(calls.filter(s => s === "bookrpg_source_timeline").length, 1);
  assert.equal(calls.filter(s => s === "bookrpg_action_goal_plan").length, 1);
  assert.equal(calls.filter(s => s === "bookrpg_action_goal_labels").length, 1);
  assert.equal(calls.filter(s => s === "bookrpg_action_goal_conditions").length, 2);
});

test("mixed completion and condition errors reopen labels rather than preserving wrong completion", async () => {
  const {book, part, timeline} = fixture();
  const calls: string[] = [];
  const normal = providerFor(timeline, [goal(0, 2), goal(1, 1), goal(3, 3)], calls);
  const first = await requestStagedChapterIndexes(async request => request.text!.format.name === "bookrpg_action_goal_label_review"
    ? output({valid: false, issues: [{target: "conditions", reason: "Unnecessary condition"}, {target: "labels", reason: "Wrong completion"}]})
    : normal(request), "test", book, [part], 1, () => {}, async () => {});
  assert.equal(first.indexes.size, 0);
  const state = (book.importAnalysis!.parts[part.sourceId] as any).events[0];
  assert.equal(state.actions, undefined);
  assert.equal(state.conditionsNeedRepair, undefined);
  assert.equal(state.planReviewed, true);
});

for (const accepted of [true, false]) {
  test(`fixed oil label repair makes only two calls and ${accepted ? "preserves the plan" : "stops on review rejection"}`, async () => {
    const {readFile} = await import("node:fs/promises");
    const {measureIndexStage} = await import("../src/books/analyze/staged-index.js");
    const read = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/import-goals/${name}.json`, import.meta.url), "utf8"));
    const source = await read("oil"), controlled = await read("oil.timeline"), repair = await read("oil.label-repair");
    const {book, part} = fixture();
    part.text = source.text;
    part.lineEnd = source.text.split("\n").length;
    const calls: string[] = [];
    const result = await measureIndexStage(async request => {
      const stage = request.text!.format.name;
      calls.push(stage);
      assert.match(request.instructions!, /conditional execution guard, not a record/);
      if (stage === "bookrpg_action_goal_labels") {
        assert.match(request.instructions!, /PREVIOUS REJECTED LABELS/);
        assert.match(request.input, /GOAL OUTCOME EVIDENCE/);
        assert.equal((request.text!.format.schema as any).properties.beat_1.properties.endBeatIndex, undefined);
        return output(labels(repair.plans));
      }
      assert.equal(stage, "bookrpg_action_goal_label_review");
      return accepted ? success() : output({valid: false, issues: [{target: "labels", reason: "Endpoint still wrong"}]});
    }, "test", book, part, 1, () => {}, async () => {}, {stage: "repair", timeline: controlled.timeline, sourceSha256: controlled.sourceSha256, repair}, {},
    async (_, plans) => { assert.deepEqual(plans, repair.plans); });
    assert.deepEqual(calls, ["bookrpg_action_goal_labels", "bookrpg_action_goal_label_review"]);
    assert.equal(result.artifacts.size, accepted ? 1 : 0);
    const state = (book.importAnalysis!.parts[part.sourceId] as any).events[0];
    assert.deepEqual(state.plan, repair.plans);
    assert.equal(state.planReviewed, true);
    if (accepted) {
      const event = flattenTimeline(result.artifacts.get(part.sourceId)!);
      assert.equal(event.beats[1]!.playerAction!.endBeatIndex, 14);
      assert.deepEqual(event.beats[2]!.playerAction!.playerBeatIndexes, [2, 3, 4, 6, 9, 13]);
    }
    await assert.rejects(measureIndexStage(async () => {throw new Error("No call allowed");}, "test", book, part, 1, () => {}, async () => {},
      {stage: "repair", timeline: controlled.timeline, sourceSha256: controlled.sourceSha256, repair: {...repair, sourceSha256: "wrong"}}), /Repair fixture does not match/);
  });
}


test('wrong repair pointer is rejected atomically, then unchanged source is re-audited and correctly mapped', async () => {
  const observation = b('Dorothy', "Sees one of Toto's ears sticking up through the opening.");
  const decision = b('Dorothy', 'Stops worrying and resolves to wait calmly.');
  const {book, part, timeline} = fixture([observation, decision]);
  part.text = 'Dorothy saw one of his ears sticking up through the hole. She decided to wait calmly and see what the future would bring.';
  let reviews = 0, repairs = 0, generations = 0;
  const plans = [goal(1, 1, 'Wait calmly')];
  const calls: string[] = [];
  const normal = providerFor(timeline, plans, calls);
  const provider = async (request: AiResponseRequest) => {
    const name = request.text!.format.name;
    if (name === 'bookrpg_source_timeline') generations++;
    if (name === 'bookrpg_source_timeline_review') {
      reviews++;
      assert.match(request.input, /ZERO-BASED BEAT PATHS/);
      return reviews < 3 ? output({valid: false, issues: [{target: 'source', reason: 'Seeing the ear is an involuntary observation, not a deliberate act.',
        repairFields: [`/significantEvents/0/beats/${reviews === 1 ? 1 : 0}/agency`]}]}) : success();
    }
    if (name === 'bookrpg_source_field_repair') {
      repairs++;
      const targets = JSON.parse(request.input.split('EXACT FIELD TARGETS:\n')[1]!.split('\nAPPROVED FIELD MAP:')[0]!);
      assert.equal(targets[0].context.action, repairs === 1 ? decision.action : observation.action);
      return output({scopeCheck: {matchesDefect: repairs > 1, reason: repairs === 1 ? 'The pointer selects a decision to wait, not the ear observation.' : 'The pointer selects the observed ear.'}, field_0: 'involuntary'});
    }
    if (name === 'bookrpg_action_goal_labels') return output(labels(plans));
    return normal(request);
  };
  await requestStagedChapterIndexes(provider, 'test', book, [part], 1, () => {}, async () => {});
  const original = structuredClone((book.importAnalysis!.parts[part.sourceId] as any).timeline);
  await requestStagedChapterIndexes(provider, 'test', book, [part], 2, () => {}, async () => {});
  let checkpoint = book.importAnalysis!.parts[part.sourceId] as any;
  assert.deepEqual(checkpoint.timeline, original);
  assert.equal(checkpoint.sourceRepair, undefined);
  assert.match(checkpoint.error, /scope mismatch/);
  const restored = JSON.parse(JSON.stringify(book));
  await requestStagedChapterIndexes(provider, 'test', restored, [part], 3, () => {}, async () => {});
  const result = await requestStagedChapterIndexes(provider, 'test', restored, [part], 4, () => {}, async () => {});
  assert.deepEqual([...result.validationErrors], []);
  checkpoint = restored.importAnalysis.parts[part.sourceId];
  assert.deepEqual(checkpoint.timeline.significantEvents[0].beats[1], original.significantEvents[0].beats[1]);
  assert.equal(checkpoint.timeline.significantEvents[0].beats[0].agency, 'involuntary');
  assert.equal(generations, 1);
  assert.equal(repairs, 2);
});

test('structurally rejected goal plans survive restart and are supplied for repair before labels', async () => {
  const {book, part, timeline} = fixture();
  const invalid = [goal(0, 2), goal(1, 1), goal(2, 2), goal(3, 3)];
  const valid = [goal(0, 2), goal(1, 1), goal(3, 3)];
  const calls: string[] = [];
  const normal = providerFor(timeline, valid, calls);
  let plans = 0;
  const provider = async (request: AiResponseRequest) => {
    if (request.text!.format.name === 'bookrpg_action_goal_plan') {
      if (++plans === 1) return output({groups: invalid});
      const previous = JSON.parse(request.input.split('PREVIOUS REJECTED GOAL PLAN (untrusted):\n')[1]!.split('\n')[0]!);
      assert.deepEqual(previous, invalid);
      assert.match(request.instructions!, /more than one goal/);
    }
    return normal(request);
  };
  await requestStagedChapterIndexes(provider, 'test', book, [part], 1, () => {}, async () => {});
  const checkpoint = book.importAnalysis!.parts[part.sourceId] as any;
  assert.deepEqual(checkpoint.events[0].rejectedPlan, invalid);
  assert.equal(checkpoint.events[0].plan, undefined);
  assert.equal(checkpoint.sourceReviewed, true);
  assert.ok(!calls.includes('bookrpg_action_goal_labels'));
  const restored = JSON.parse(JSON.stringify(book));
  const result = await requestStagedChapterIndexes(provider, 'test', restored, [part], 2, () => {}, async () => {});
  assert.equal(result.indexes.size, 1);
  assert.equal(restored.importAnalysis.parts[part.sourceId].events[0].rejectedPlan, undefined);
  assert.equal(calls.filter(c => c === 'bookrpg_source_timeline').length, 1);
});

test('short beginning label survives production stages while completion and frozen endpoint remain separate', async () => {
  const {book, part, timeline} = fixture([b('Scarecrow', 'Begins telling his life story'), b('Scarecrow', 'Finishes the account with his wish for brains')]);
  const plans = [goal(0, 1, 'Tell his life story')];
  const calls: string[] = [];
  const normal = providerFor(timeline, plans, calls);
  const choiceText = 'Begin telling the story of your short life and creation';
  const completion = 'The Scarecrow has finished his account, including his wish for brains.';
  let review = false;
  const result = await requestStagedChapterIndexes(async request => {
    const name = request.text!.format.name;
    if (name === 'bookrpg_action_goal_labels') {
      assert.match(request.instructions!, /CONCISE CHOICE LABELS/);
      assert.doesNotMatch(request.instructions!, /Labels must communicate the full selected scope|Label the whole goal/);
      return output({beat_0: {choiceText, completion, preconditions: [], interruptWhen: []}});
    }
    if (name === 'bookrpg_action_goal_label_review') {
      review = true;
      assert.match(request.instructions!, /completion must accurately describe the observed state/);
      assert.match(request.instructions!, /brevit.*not a defect/);
      assert.match(request.input, /Begin telling the story/);
    }
    return normal(request);
  }, 'test', book, [part], 1, () => {}, async () => {});
  assert.deepEqual([...result.validationErrors], []);
  assert.equal(review, true);
  const action = result.indexes.get(part.sourceId)!.significantEvents[0]!.beats[0]!.playerAction!;
  assert.equal(action.choiceText, choiceText);
  assert.equal(action.completion, completion);
  assert.equal(action.endBeatIndex, 1);
  assert.deepEqual(action.playerBeatIndexes, [0, 1]);
});

test("shared-events production mode stops before all-character goal planning and resumes its own source checkpoint", async () => {
  const {book, part, timeline} = fixture();
  const calls: string[] = [];
  const response = await requestStagedChapterIndexes(providerFor(timeline, [], calls), "test", book, [part], 1, () => {}, async () => {}, {sharedEventsOnly: true});
  assert.deepEqual([...response.validationErrors], []);
  assert.deepEqual(calls, ["bookrpg_source_timeline", "bookrpg_source_timeline_review"]);
  const source = mergeChapterPartSourceIndexes(0, 0, timeline.summary, [response.indexes.get(part.sourceId)!]);
  source.extractionMode = "shared_events_v1";
  assert.equal(isReusableChapterSourceIndex(source), true);
  assert.ok(source.significantEvents!.flatMap(e => e.beats!).every(b => !b.playerAction));
  const resumed = await requestStagedChapterIndexes(async () => {throw new Error("No source regeneration");}, "test", JSON.parse(JSON.stringify(book)), [part], 1, () => {}, async () => {}, {sharedEventsOnly: true});
  assert.equal(resumed.indexes.size, 1);
});
