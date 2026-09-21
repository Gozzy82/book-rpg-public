import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withTurnReview } from "../src/ai/engine/turn-review.js";
import { buildTurnScript, renderTurnScript } from "../src/ai/engine/turn-script.js";
import { validateTurnEvidence } from "../src/ai/engine/turn-validator.js";
import { scenePresenceReviewJsonSchema } from "../src/ai/schema.js";
import type { TurnContract } from "../src/ai/engine/turn-contract.js";
import type { AiResponseRequest } from "../src/ai/provider.js";

const contract: TurnContract = JSON.parse(fs.readFileSync(new URL("./fixtures/selected-retrieval-contract.json", import.meta.url), "utf8"));
test("pinned critical action uses bounded reasoning and reserves room for scene output without changing free-choice settings", () => {
  const request: AiResponseRequest = {model: "test", input: "unchanged", reasoning: {effort: "high"}, max_output_tokens: 2400};
  const bounded = withTurnReview("scene", request, contract);
  assert.equal(bounded.reasoning!.effort, "low");
  assert.equal(bounded.max_output_tokens, 4000);
  assert.equal(bounded.input, request.input);
  assert.deepEqual(withTurnReview("scene", request, {...contract, sourceBeatSelection: undefined}), request);
  const low = withTurnReview("scene", {...request, reasoning: {effort: "low"}, max_output_tokens: 8000}, contract);
  assert.equal(low.reasoning!.effort, "low");
  assert.equal(low.max_output_tokens, 8000);
});

test("retrieval review keys literal start and movement scope to the existing index endpoints", () => {
  const request = withTurnReview("scene presence review", {model: "test", input: JSON.stringify({candidate_scene: {text: "I reach under the bed."}}),
    text: {format: {type: "json_schema", name: "review", strict: true, schema: scenePresenceReviewJsonSchema}}}, contract);
  const schema = request.text!.format.schema as any;
  assert.match(schema.properties.beat_observations.properties.beat_3.description, /visibly starting\/trying completes/);
  assert.match(request.instructions!, /automatic accident after the group's endpoint does not undo/);
  assert.match(request.instructions!, /action AND its compatible checkpoint/);
  assert.match(request.instructions!, /before later beats supersede it/);
  const script = buildTurnScript(contract);
  assert.deepEqual(script.ordered_execution.map(b => b.beat_index), [3, 4, 5, 6]);
  assert.equal(script.ordered_execution[0]!.resulting_state, contract.beats[3]!.resultingState);
  assert.equal(script.ordered_execution.at(-1)!.resulting_state, contract.beats[6]!.resultingState);
  assert.equal(script.player_action!.endBeatIndex, 5);
  assert.match(renderTurnScript(contract), /grouping removes extra menu stops, not chronology/);
});

test("correct completion does not require the cellar; missing starts and unresolved groups still fail", () => {
  const evidence = {completedSourceEventBeatIndexes: [3, 4, 5, 6], futureActionSetupRequired: false, futureActionSetupSupported: true,
    player_action_resolution: {status: "completed", beforeBeatIndex: null, reason: "The bounded retrieval and movement completed before the automatic fall.", causeEstablished: false}};
  assert.equal(validateTurnEvidence(contract, evidence).status, "accepted");
  assert.notEqual(validateTurnEvidence(contract, {...evidence, completedSourceEventBeatIndexes: [4, 5, 6], partiallyPerformedSourceEventBeatIndexes: [3]}).status, "accepted");
  assert.notEqual(validateTurnEvidence(contract, {...evidence, player_action_resolution: {...evidence.player_action_resolution, status: "unresolved"}}).status, "accepted");
});

const overrun = JSON.parse(fs.readFileSync(new URL("./fixtures/cellar-overrun.json", import.meta.url), "utf8"));
import { decodeTurnReview } from "../src/ai/engine/turn-review.js";
import { TurnExecutionError } from "../src/ai/engine/turn-contract.js";

test("canonical scene adapter removes conflicting free-input route planning but preserves goals and repair feedback", () => {
  const input = overrun.legacy_scene_input.replace("IMMEDIATE TURN TRANSITION", "REJECTED BECAUSE:\n- Final posture contradicts the source.\n\nIMMEDIATE TURN TRANSITION");
  const prepared = withTurnReview("scene", {model: "test", input, reasoning: {effort: "medium"}}, contract);
  const payload = JSON.parse(prepared.input);
  assert.equal(prepared.reasoning!.effort, "low");
  assert.match(payload.repair_feedback, /Final posture/);
  assert.ok(payload.game_profile && payload.objective && payload.victoryCondition);
  assert.equal(payload.selected_choice_label, contract.selectedIntent);
  assert.doesNotMatch(prepared.input, /OPTION 1 ANCHOR ROUTE|upcoming_source_material|previous_scene/);
  assert.ok(prepared.input.length < overrun.legacy_scene_input.length / 3);
});

function checkpointRequest(text = overrun.candidate.text) {
  return withTurnReview("scene presence review", {model: "test", input: JSON.stringify({candidate_scene: {text}}),
    text: {format: {type: "json_schema", name: "review", strict: true, schema: scenePresenceReviewJsonSchema}}}, contract);
}
function checkpointResponse() {
  const raw = JSON.parse(overrun.presence_response.output_text);
  const match = {observed_state: "The corresponding action endpoint is visible.", matches: true, reason: "", evidence_sentence_ids: [2]};
  return {...raw, checkpoint_observations: Object.fromEntries([3,4,5,6].map(i => [`beat_${i}`, {...match}])), final_checkpoint: {...match}};
}
function assess(value: unknown) {
  const response = {...overrun.presence_response, output_text: JSON.stringify(value)};
  return validateTurnEvidence(contract, JSON.parse(decodeTurnReview("scene presence review", checkpointRequest(), response).output_text));
}

test("captured cellar approval cannot omit checkpoint assessments or reverse source evidence order", () => {
  assert.throws(() => decodeTurnReview("scene presence review", checkpointRequest(), overrun.presence_response), TurnExecutionError);
  // Even blanket positive state verdicts cannot hide the logged catch-before-descent evidence.
  const decision = assess(checkpointResponse());
  assert.equal(decision.status, "repair_scene");
  assert.ok(decision.findings.some(f => f.message.includes("starts before")));
});

test("physical checkpoint contradictions block a completed group even when beat numbers are contiguous", () => {
  const raw = checkpointResponse();
  raw.beat_observations.beat_5.evidence_sentence_ids = [12]; // isolate checkpoint gate from order gate
  raw.checkpoint_observations.beat_6 = {observed_state: "Dorothy braces on a chair and keeps walking.", matches: false,
    reason: "She never sits down on the floor.", evidence_sentence_ids: [12]};
  raw.final_checkpoint = {observed_state: "Dorothy and Toto are in the cellar.", matches: false,
    reason: "The authorized final state leaves her seated upstairs, short of the cellar.", evidence_sentence_ids: [15]};
  const decision = assess(raw);
  assert.equal(decision.status, "repair_scene");
  assert.ok(decision.findings.some(f => f.message.includes("never sits")));
  assert.ok(decision.findings.some(f => f.message.includes("in the cellar")));
});

test("ordered retrieval plus final seated checkpoint remains acceptable", () => {
  const text = "I reach for Toto under the bed. Aunt Em opens the trapdoor and descends while I am still reaching. I catch Toto and start across the room toward her. The house shakes and I fall seated on the floor, holding Toto short of the cellar.";
  const raw = checkpointResponse();
  for (const [offset, index] of [3,4,5,6].entries()) {
    raw.beat_observations[`beat_${index}`].evidence_sentence_ids = [offset + 1];
    raw.checkpoint_observations[`beat_${index}`].evidence_sentence_ids = [offset + 1];
  }
  raw.final_checkpoint.evidence_sentence_ids = [4];
  raw.player_action_resolution.evidence_sentence_ids = [1,3];
  const response = {...overrun.presence_response, output_text: JSON.stringify(raw)};
  const result = JSON.parse(decodeTurnReview("scene presence review", checkpointRequest(text), response).output_text);
  assert.equal(validateTurnEvidence(contract, result).status, "accepted");
});

test("scene reviews receive visible prose, never the writer's claimed action result or development", () => {
  for (const label of ["scene presence review", "scene repetition review"]) {
    const request = withTurnReview(label, {model: "test", input: JSON.stringify({candidate_scene: {
      title: "At the trapdoor", text: "I wait beside Toto.", action_result: "UNOBSERVED_COMPLETE_RESCUE",
      development: "UNOBSERVED_SLEEP", sceneScope: {currentLocation: "UNOBSERVED_CELLAR"},
    }}), text: {format: {type: "json_schema", name: "review", strict: true, schema: scenePresenceReviewJsonSchema}}}, contract);
    assert.deepEqual(JSON.parse(request.input).candidate_scene, {title: "At the trapdoor", text: "I wait beside Toto."});
    assert.doesNotMatch(request.input, /UNOBSERVED/);
  }
});

test("menu review starts with enough headroom and preserves a larger retry budget", () => {
  const base = {model: "test", input: JSON.stringify({candidate_scene: {text: "I sit with Toto.", choices: []}}), max_output_tokens: 800};
  assert.equal(withTurnReview("scene choice review", base, contract).max_output_tokens, 1600);
  assert.equal(withTurnReview("scene choice review", {...base, max_output_tokens: 3200}, contract).max_output_tokens, 3200);
});

const lift = JSON.parse(fs.readFileSync(new URL('./fixtures/automatic-lift.json', import.meta.url), 'utf8'));
test('captured automatic lift uses bounded generation and never replays a historical selected choice', () => {
  const request = withTurnReview('scene', lift.request, lift.contract);
  assert.equal(JSON.parse(request.input).selected_choice_label, null);
  assert.match(request.instructions!, /There is no selected player action/);
  assert.doesNotMatch(request.input, /GAME CONTEXT|PLAYER ACTION|STAGNATION BREAK/);
  assert.deepEqual((request.text!.format.schema as any).properties.playerAction.enum, ['']);
  assert.deepEqual((request.text!.format.schema as any).properties.actionOutcome.enum, ['none']);
  const script=buildTurnScript(lift.contract);
  assert.deepEqual(script.ordered_execution.map(b=>b.beat_index),[0]);
  assert.equal(script.next_decision!.beat_index,1);
  assert.equal(script.next_decision!.must_remain_unperformed,true);
});

test('automatic lift review distinguishes inherited posture from a new deliberate wait without bypassing agency', () => {
  const request=withTurnReview('scene presence review',{model:'test',input:JSON.stringify({candidate_scene:{text:'The house rises; I am still seated with Toto.'}}),
    text:{format:{type:'json_schema',name:'review',strict:true,schema:scenePresenceReviewJsonSchema}}},lift.contract);
  assert.match(request.instructions!,/PERSISTENCE IS NOT A NEW ACTION/);
  assert.match(request.instructions!,/deliberate waiting DOES execute it/);
  const base={completedSourceEventBeatIndexes:[0],futureActionSetupRequired:true,futureActionSetupSupported:true};
  assert.equal(validateTurnEvidence(lift.contract,base).status,'accepted');
  assert.equal(validateTurnEvidence(lift.contract,{...base,partiallyPerformedSourceEventBeatIndexes:[1]}).status,'repair_scene');
});
