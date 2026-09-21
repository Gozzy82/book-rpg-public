import assert from "node:assert/strict";
import test from "node:test";
import type { AiResponse, AiResponseRequest } from "../src/ai/provider.js";
import { SOURCE_CONTINUATION_CHOICE_ID } from "../src/shared/contracts.js";
import type { GameState, StoryEventBeat } from "../src/shared/contracts.js";
import { TurnPipelineGameEngine } from "../src/ai/engine/turn-pipeline-engine.js";
import { planTurn, runPlannedTurn, runWithTurnBudget, currentTurnExecution, TurnBudget, TurnExecutionError, selectedIntentMatchesBeat } from "../src/ai/engine/turn-contract.js";
import { validateTurnEvidence } from "../src/ai/engine/turn-validator.js";
const state: GameState = { playerName: "Dorothy", characterProfiles: [], parameters: [], turnNumber: 3,
  scene: { title: "Farm", text: "I stand by Toto.", choices: [], sceneScope: {
      currentLocation: "Farm", peoplePresent: ["Dorothy", "Toto", "Aunt Em"], peopleWithinSpeakingDistance: ["Dorothy", "Toto", "Aunt Em"],
    } }, history: [], book: { bookId: "test", title: "Test adventure" }, selectedText: "", objective: "Go onward",
  gameId: "test-game", status: "active", victoryCondition: "Reach the next milestone",
  gameProfile: {category: "adventure", endingMode: "open_ended", description: "A journey through Oz."},
  createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
};
const beat = (actor: string, action: string, stakes: StoryEventBeat["stakes"] = "significant"): StoryEventBeat => ({ actor, action, stakes, agency: "intentional", targets: [], sourceReferences: [] });
const event = { eventId: "cyclone", description: "The cyclone approaches.", chapterPosition: 1, beats: [
    beat("Dorothy", "Starts after Toto"), beat("Aunt Em", "Throws open the trapdoor and climbs down"),
    beat("Dorothy", "Catches Toto and starts toward the cellar"),
  ] };
const contract = () => planTurn({ state, mode: "action", selectedIntent: "Start after Toto", event });
const output = (value: unknown): AiResponse => ({ status: "completed", output_text: JSON.stringify(value), incomplete_details: null });
const evidence = (indexes: number[]) => ({ peoplePresent: ["Dorothy", "Toto", "Aunt Em"],
  peopleWithinSpeakingDistance: ["Dorothy", "Toto", "Aunt Em"], latestVisibleSourceEventId: null,
  completedSourceEventBeatIndexes: indexes, futureActionSetupRequired: false,
  futureActionSetupSupported: true, futureActionSetupReason: "", reason: "Observed scene actions." });
const keyedEvidence = (request: AiResponseRequest, indexes: number[]) => ({...evidence(indexes),
  beat_observations: Object.fromEntries(Object.keys((request.text!.format.schema as any).properties.beat_observations.properties)
    .map(key => [key, {status: indexes.includes(Number(key.slice(5))) ? "completed" : "absent",
      evidence_sentence_ids: indexes.includes(Number(key.slice(5))) ? JSON.parse(request.input).candidate_sentences.map((s: any) => s.id) : []}]))});
class Probe extends TurnPipelineGameEngine {
  generate(...args: Parameters<TurnPipelineGameEngine["scene"]>) { return this.scene(...args); }
  baseScene(...args: Parameters<TurnPipelineGameEngine["scene"]>) { return super.scene(...args); }
  send(label: string, request: AiResponseRequest) { return this.createResponse(label, "test", request); }
  choices(...args: Parameters<TurnPipelineGameEngine["sceneChoices"]>) { return this.sceneChoices(...args); }
  review(...args: Parameters<TurnPipelineGameEngine["reviewScenePresence"]>) { return this.reviewScenePresence(...args); }
}
const presenceRequest = (): AiResponseRequest => ({ model: "test", turnContract: contract(), input: JSON.stringify({
    player_identity: "Dorothy", previous_completed_source_event_beat_indexes: [],
    candidate_scene: { player_action: "Start after Toto", text: "I start after Toto. Aunt Em climbs down. I catch Toto." },
    next_required_source_event_beat: { index: 0, ...event.beats[0] }, event_review_target: event,
    future_player_actions: [{ beatIndex: 2, ...event.beats[2] }],
  }), text: { format: { type: "json_schema", name: "bookrpg_scene_presence_review", schema: {}, strict: true } } });
test("source continuation writes pending involuntary beats instead of only refreshing the future menu", async () => {
  const reachedWriter = new Error("automatic scene requested");
  let choiceCalls = 0;
  class ContinuationProbe extends Probe {
    protected override scene(..._args: Parameters<Probe["scene"]>): ReturnType<Probe["scene"]> {
      return Promise.reject(reachedWriter);
    }
    protected override sceneChoices(..._args: Parameters<Probe["sceneChoices"]>): ReturnType<Probe["sceneChoices"]> {
      choiceCalls++;
      return Promise.reject(new Error("premature menu"));
    }
  }
  const airborne = {...event, beats: [
    {...beat("Toto", "Runs around barking"), agency: "involuntary" as const},
    {...beat("Toto", "Falls through the trapdoor"), agency: "involuntary" as const},
    beat("Dorothy", "Pulls Toto back and closes the trapdoor"),
  ]};
  const engine = new ContinuationProbe({provider: "openai", model: "test", async createResponse() { throw new Error("unexpected model call"); }});
  const candidates = [{chapterPosition: 1, chapterTitle: "Cyclone", summary: "", excerpt: "Toto falls.",
    nextTextOffset: 100, requiredEvent: airborne.description, requiredEventId: airborne.eventId, storyEvents: [airborne]}];
  const menuEngine = new Probe({provider: "openai", model: "test", async createResponse() { throw new Error("premature menu generation"); }});
  const choices = await menuEngine.choices(state.scene, state, candidates);
  assert.equal(choices[0]?.id, SOURCE_CONTINUATION_CHOICE_ID);
  await assert.rejects(engine.continueFromSource(state, candidates),
    error => error === reachedWriter);
  assert.equal(choiceCalls, 0);
});
test("required canonical turns never fall back to the legacy scene writer", async () => {
  let modelCalls = 0;
  const engine = new Probe({ provider: "openai", model: "test", async createResponse() {
    modelCalls++;
    throw new Error("legacy writer must not be called");
  } });
  const invalidEvent = {
    ...event,
    beats: event.beats.map((item) => ({ ...item, resultingState: undefined })),
  };
  const required = planTurn({
    state,
    mode: "observe",
    sourceProgression: "required",
    event: invalidEvent,
  });
  await assert.rejects(
    () => runPlannedTurn(required, () => engine.baseScene(
      "Continue canon",
      state,
      undefined,
      [{
        chapterPosition: 1,
        chapterTitle: "Cyclone",
        summary: "",
        excerpt: "",
        nextTextOffset: 1,
        requiredEvent: invalidEvent.description,
        requiredEventId: invalidEvent.eventId,
        requiredEventBeats: invalidEvent.beats,
        storyEvents: [invalidEvent],
      }],
      4,
      "observed_scene_progression",
      true,
    )),
    /Canonical progression is already at a player decision boundary/,
  );
  assert.equal(modelCalls, 0);
});

test("production preserves forbidden observations while protecting authorized cursor", async () => {
  const raw = output(evidence([0, 1, 2]));
  const engine = new Probe({ provider: "openai", model: "test", async createResponse() { return raw; } });
  const response = JSON.parse((await engine.send("scene presence review", presenceRequest())).output_text);
  assert.equal(response.turnValidation.status, "repair_scene");
  assert.deepEqual(response.turnValidation.observedCompletedBeatIndexes, [0, 1, 2]);
  assert.deepEqual(response.completedSourceEventBeatIndexes, [0, 1]);
  assert.equal(response.futureActionSetupSupported, false);
  assert.equal(response.latestVisibleSourceEventId, null);
  assert.deepEqual(JSON.parse(raw.output_text).completedSourceEventBeatIndexes, [0, 1, 2]);
});
test("missing follow-up is explicitly pending, never a successful decision boundary", async () => {
  const engine = new Probe({ provider: "openai", model: "test", async createResponse() { return output(evidence([0])); } });
  const response = JSON.parse((await engine.send("scene presence review", presenceRequest())).output_text);
  assert.equal(response.turnValidation.status, "needs_automatic_continuation");
  assert.equal(response.futureActionSetupSupported, false);
  assert.deepEqual(response.completedSourceEventBeatIndexes, [0]);
  assert.equal(validateTurnEvidence(contract(), evidence([0, 1])).status, "accepted");
});
test("late observations never manufacture an unseen prefix", () => {
  const decision = validateTurnEvidence(contract(), evidence([1]));
  assert.equal(decision.status, "repair_scene");
  assert.deepEqual(decision.authorizedCompletedBeatIndexes, []);
  assert.deepEqual(decision.observedCompletedBeatIndexes, [1]);
});
test("planner resolves aliases, preserves rule order and freezes source snapshots", () => {
  const source = { ...state, playerName: "Dot", worldRules: ["Toto is silent.", "Toto now barks."],
    characterProfiles: [{ name: "Dorothy", aliases: ["Dot"] }] } as GameState;
  const planned = planTurn({ state: source, mode: "opening", event });
  assert.equal(planned.nextPlayerDecision, 0);
  assert.deepEqual(planned.allowedPlayerBeatIndexes, []);
  assert.deepEqual(planned.worldRules, source.worldRules);
  assert.ok(Object.isFrozen(planned.beats[0]));
  assert.ok(Object.isFrozen(planned.beats[0]!.sourceReferences));
  assert.ok(!Object.isFrozen(event.beats[0]));
  const routine = planTurn({ state, mode: "opening", event: { ...event, beats: [beat("Dorothy", "Breathes", "routine"), ...event.beats] } });
  assert.deepEqual(routine.requiredAutomaticBeatIndexes, [0]);
  assert.equal(validateTurnEvidence(routine, evidence([])).status, "repair_scene");
});
test("similar action words and negation do not grant source authorization", () => {
  assert.equal(selectedIntentMatchesBeat("Do not start after Toto", "Starts after Toto"), false);
  assert.equal(selectedIntentMatchesBeat("Catch Toto and leave the cellar", "Catch Toto and enter the cellar"), false);
  assert.equal(selectedIntentMatchesBeat("Start after Toto", "Starts after Toto"), true);
});
test("present talk targets do not erase capability rejections", async () => {
  const engine = new Probe({ provider: "openai", model: "test", async createResponse() {
      return output({ unusableChoiceIndexes: [0], unusableChoicesReason: "Unsupported human speech required from Toto", anchorChoiceIndex: null });
    } });
  const response = await engine.send("scene choice review", { model: "test", input: JSON.stringify({ player_identity: "Dorothy",
      candidate_scene: { ...state.scene, choices: [{ type: "talk", character: "Toto", text: "Talk to Toto" }] },
    }) + "\n\nCHOICE NAVIGATION EVENT:\n\nnull" });
  assert.deepEqual(JSON.parse(response.output_text).unusableChoiceIndexes, [0]);
});
for (const unavailable of [false, true]) {
  test(`world rule ${unavailable ? "unavailable review" : "exhausted repairs"} rejects the draft`, async () => {
    let writes = 0, reviews = 0;
    const engine = new Probe({ provider: "openai", model: "test", async createResponse(request) {
        if (request.text?.format.name === "bookrpg_world_rule_compliance_review") {
          reviews++;
          return unavailable ? { ...output({}), output_text: "invalid json" }
            : output({ satisfied: false, failedRules: ["Toto always barks."], reason: "Silent Toto" });
        }
        writes++;
        return output({ text: "I stand beside a silent Toto." });
      } });
    await assert.rejects(engine.send("scene", { model: "test", input: JSON.stringify({ bookrpg_world_rules: ["Toto always barks."] }) }), (error: unknown) => error instanceof TurnExecutionError && error.code === (unavailable ? "review_unavailable" : "world_rule_violation"));
    assert.equal(reviews, unavailable ? 1 : 3);
    assert.equal(writes, unavailable ? 1 : 3);
  });
}
test("writer and reviewer receive one contract; private metadata never goes to the client", async () => {
  const captured: AiResponseRequest[] = [];
  const engine = new Probe({ provider: "openai", model: "test", async createResponse(request) {
      captured.push(request);
      return output(evidence([0, 1]));
    } });
  const planned = contract();
  await runPlannedTurn(planned, async () => {
    await engine.send("scene", { model: "test", input: "{}" });
    await engine.send("scene presence review", presenceRequest());
  });
  const tail = (request: AiResponseRequest) => request.instructions!.split("TURN CONTRACT")[1];
  assert.equal(tail(captured[0]!), tail(captured[1]!));
  for (const request of captured) {
    assert.equal(request.turnContract, undefined);
    assert.doesNotMatch(request.instructions!, /may infer the missing ordered prefix/);
    assert.match(tail(request), /setup_only/);
    assert.match(tail(request), /must_remain_unperformed/);
  }
});
test("shared call budget bounds nested planned scenes before another model call", async () => {
  let calls = 0;
  const engine = new Probe({ provider: "openai", model: "test", async createResponse() { calls++; return output({}); } });
  // Leave room for three 2,400-token scene reservations: only the call limit should stop the third.
  const budget = new TurnBudget(2, 10_000);
  await assert.rejects(runWithTurnBudget(async () => {
    for (let turn = 0; turn < 3; turn++) {
      await runPlannedTurn(contract(), () => engine.send("scene", { model: "test", input: "{}", max_output_tokens: 10 }));
    }
  }, budget), (error: unknown) => error instanceof TurnExecutionError && error.code === "budget_exhausted");
  assert.equal(calls, 2);
  assert.equal(budget.calls, 2);
  assert.equal(budget.reservedOutputTokens, 4_800);
});
test("concurrent turns do not share authorization or budgets", async () => {
  const results = await Promise.all(["Dorothy", "Toto"].map(playerName => {
    const planned = planTurn({ state: { ...state, playerName }, mode: "opening", event });
    return runPlannedTurn(planned, async () => {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(currentTurnExecution()?.contract.player, playerName);
      currentTurnExecution()!.budget.reserve(1);
      return currentTurnExecution()!.budget;
    });
  }));
  assert.notEqual(results[0], results[1]);
  assert.deepEqual(results.map(b => b.calls), [1, 1]);
  assert.equal(currentTurnExecution(), undefined);
});
test("pending automatic progress bypasses player menu generation", async () => {
  let calls = 0;
  const engine = new Probe({ provider: "openai", model: "test", async createResponse() { calls++; return output({}); } });
  const pendingState = { ...state, sourceEventProgress: { eventId: event.eventId, completedBeatIndexes: [0] } };
  const candidates = [{ chapterPosition: 1, chapterTitle: "Cyclone", summary: "", excerpt: "", nextTextOffset: 0,
      requiredEventId: event.eventId, storyEvents: [event] }];
  const choices = await engine.choices(state.scene, pendingState, candidates);
  assert.equal(calls, 0);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]!.id, SOURCE_CONTINUATION_CHOICE_ID);
});
test("presence postprocessing retains central violations instead of inferring success", async () => {
  const engine = new Probe({ provider: "openai", model: "test", async createResponse(request) { return output(keyedEvidence(request, [0, 1, 2])); } });
  const candidates = [{ chapterPosition: 1, chapterTitle: "Cyclone", summary: "", excerpt: "", nextTextOffset: 0,
      requiredEventId: event.eventId, storyEvents: [event] }];
  const result = await runPlannedTurn(contract(), () => engine.review(state, { ...state.scene, text: "I start after Toto. Aunt Em climbs down. I catch Toto.", playerAction: "Start after Toto" }, [], candidates, event.eventId));
  assert.equal(result.turnValidation?.status, "repair_scene");
  assert.equal(result.futureActionSetupSupported, false);
  assert.equal(result.latestVisibleSourceEventId, null);
});
test("explicit compound intent authorizes adjacent player beats but never crosses an NPC boundary", () => {
  const compoundEvent = { ...event, beats: [beat("Dorothy", "Starts after Toto"), beat("Dorothy", "Calls his name"), ...event.beats.slice(1)] };
  const planned = planTurn({ state, mode: "action", selectedIntent: "Start after Toto and call his name", event: compoundEvent });
  assert.deepEqual(planned.allowedPlayerBeatIndexes, [0, 1]);
  assert.deepEqual(planned.requiredAutomaticBeatIndexes, [2]);
  assert.equal(planned.nextPlayerDecision, 3);
  assert.equal(validateTurnEvidence(planned, evidence([0, 1, 2, 3])).status, "repair_scene");
});
test("opening rechecks cannot erase previously observed unselected actions", async () => {
  let calls = 0;
  const openingEvent = { ...event, beats: [event.beats[1]!, event.beats[0]!] };
  const engine = new Probe({ provider: "openai", model: "test", async createResponse(request) {
      calls++;
      return output(keyedEvidence(request, calls === 1 ? [1] : [0]));
    } });
  const candidates = [{ chapterPosition: 1, chapterTitle: "Cyclone", summary: "", excerpt: "", nextTextOffset: 0,
      currentStoryEvent: openingEvent }];
  const result = await runPlannedTurn(planTurn({ state, mode: "opening", event: openingEvent }), () => engine.review(state, {...state.scene, text: "I start after Toto."}, [], candidates, openingEvent.eventId, true));
  assert.equal(calls, 1);
  assert.equal(result.turnValidation?.status, "repair_scene");
  assert.deepEqual(result.turnValidation?.observedCompletedBeatIndexes, [1]);
});
test("malformed presence evidence cannot become an accepted empty review", async () => {
  const engine = new Probe({ provider: "openai", model: "test", async createResponse() { return output({}); } });
  await assert.rejects(engine.send("scene presence review", presenceRequest()), (error: unknown) => error instanceof TurnExecutionError && error.code === "review_unavailable");
});
test("output and deadline limits fail before spending another call", () => {
  const tokens = new TurnBudget(10, 5);
  assert.throws(() => tokens.reserve(6), TurnExecutionError);
  assert.equal(tokens.calls, 0);
  const elapsed = new TurnBudget(10, 100, 0);
  assert.throws(() => elapsed.reserve(1), TurnExecutionError);
  assert.equal(elapsed.calls, 0);
});

test("semantic intent planning supports paraphrases without exposing the next player window", async () => {
  const {resolveTurnPlan} = await import("../src/ai/engine/turn-planner.js");
  const captured: AiResponseRequest[] = [];
  const engine = new Probe({provider: "openai", model: "test", async createResponse(request) {
    captured.push(request); return output({selectedPrefixLength: 1, reason: "Explicitly follows Toto"});
  }});
  const planned = await resolveTurnPlan({state, mode: "action", selectedIntent: "Follow Toto", event}, "test",
    request => engine.send("turn intent review", request));
  assert.deepEqual(planned.allowedPlayerBeatIndexes, [0]);
  assert.deepEqual(planned.requiredAutomaticBeatIndexes, [1]);
  assert.equal(planned.nextPlayerDecision, 2);
  assert.doesNotMatch(captured[0]!.input, /Catches Toto|trapdoor/);
  assert.deepEqual(planned.completedBeatIndexes, []);
  assert.equal(captured[0]!.max_output_tokens, 1600);
});

test("intent review cannot authorize a later window or turn unavailable evidence into consent", async () => {
  const {resolveTurnPlan} = await import("../src/ai/engine/turn-planner.js");
  await assert.rejects(resolveTurnPlan({state, mode: "action", selectedIntent: "Follow Toto", event}, "test",
    async () => ({status: "incomplete", output_text: "", incomplete_details: {reason: "max_output_tokens"}})), TurnExecutionError);
  for (const verdict of [{selectedPrefixLength: 2, reason: "too far"}, {}, {selectedPrefixLength: -1, reason: "invalid"}]) {
    await assert.rejects(resolveTurnPlan({state, mode: "action", selectedIntent: "Follow Toto", event}, "test",
      async () => output(verdict)), TurnExecutionError);
  }
  const declined = await resolveTurnPlan({state, mode: "action", selectedIntent: "Do not follow Toto", event}, "test",
    async () => output({selectedPrefixLength: 0, reason: "Explicit refusal"}));
  assert.deepEqual(declined.allowedPlayerBeatIndexes, []);
  assert.equal(validateTurnEvidence(declined, evidence([0])).status, "repair_scene");
});

test("canonical actions and openings need no semantic authorization call", async () => {
  const {resolveTurnPlan} = await import("../src/ai/engine/turn-planner.js");
  const noReview = async (): Promise<AiResponse> => {throw new Error("unexpected review");};
  const selected = await resolveTurnPlan({state, mode: "action", selectedIntent: "Start after Toto", event}, "test", noReview);
  assert.deepEqual(selected.allowedPlayerBeatIndexes, [0]);
  const opening = await resolveTurnPlan({state, mode: "opening", event}, "test", noReview);
  assert.deepEqual(opening.allowedPlayerBeatIndexes, []);
});
