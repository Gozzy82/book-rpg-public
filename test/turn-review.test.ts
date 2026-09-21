import assert from "node:assert/strict";
import test from "node:test";
import type { AiResponse, AiResponseRequest } from "../src/ai/provider.js";
import type { GameState, StoryEventBeat } from "../src/shared/contracts.js";
import { planTurn, TurnExecutionError } from "../src/ai/engine/turn-contract.js";
import { withTurnReview, decodeTurnReview } from "../src/ai/engine/turn-review.js";
import { validateTurnEvidence } from "../src/ai/engine/turn-validator.js";
import { TurnPipelineGameEngine } from "../src/ai/engine/turn-pipeline-engine.js";
const beat = (actor: string, action: string): StoryEventBeat => ({actor, action, agency: "intentional", stakes: "significant", targets: [], sourceReferences: []});
const event = {eventId: "woodman", beats: [
  beat("Dorothy", "Finds the spring"), beat("Dorothy", "Hears a groan"), beat("Dorothy", "Fetches oil"),
  beat("Dorothy", "Oils the neck"), beat("Dorothy", "Oils the arms"),
  beat("Tin Woodman", "Lowers and sets aside his axe"), beat("Dorothy", "Oils the legs until he can move freely"),
  beat("Tin Woodman", "Asks to join the journey"),
]};
const state = {playerName: "Tin Woodman", characterProfiles: [], parameters: [], history: [],
  scene: {title: "Forest", text: "My upper joints are free.", choices: []},
  sourceEventProgress: {eventId: "woodman", completedBeatIndexes: [0,1,2,3,4]},
} as unknown as GameState;
const contract = planTurn({state, event, mode: "action", selectedIntent: event.beats[5]!.action});
const candidate = "I lower the axe and rest it against the tree. Dorothy oils my legs until I can move freely.";
const request = (): AiResponseRequest => ({model: "test", turnContract: contract, input: JSON.stringify({candidate_scene: {text: candidate}, future_events: "UNRELATED LOOKAHEAD"}),
  text: {format: {type: "json_schema", name: "review", strict: true, schema: {type: "object", additionalProperties: false, properties: {
    completedSourceEventBeatIndexes: {type: "array", items: {type: "integer"}}, partiallyPerformedSourceEventBeatIndexes: {type: "array", items: {type: "integer"}},
  }, required: ["completedSourceEventBeatIndexes", "partiallyPerformedSourceEventBeatIndexes"]}}}});
const output = (v: any): AiResponse => ({status: "completed", output_text: JSON.stringify({
  turnScopeFindings: v.staysWithinTurnScope === false
    ? [{reason: v.turnScopeFailureReason ?? "", quote: v.turnScopeViolationQuote ?? ""}] : [], ...v,
}), incomplete_details: null});
const observations = () => ({beat_5: {status: "completed", evidence_sentence_ids: [1]},
  beat_6: {status: "completed", evidence_sentence_ids: [2]}, beat_7: {status: "absent", evidence_sentence_ids: []}});
test("review keys retain the index's absolute action mapping and remove unrelated lookahead", () => {
  const prepared = withTurnReview("scene presence review", request(), contract);
  const input = JSON.parse(prepared.input);
  assert.deepEqual(input.beat_definitions.map((b: any) => b.key), ["beat_5", "beat_6", "beat_7"]);
  assert.equal(input.beat_definitions[1].action, event.beats[6]!.action);
  assert.doesNotMatch(prepared.input, /UNRELATED/);
  const decoded = JSON.parse(decodeTurnReview("scene presence review", prepared, output({beat_observations: observations(), completedSourceEventBeatIndexes: [5,7]})).output_text);
  assert.deepEqual(decoded.completedSourceEventBeatIndexes, [5,6]);
});
test("missing or fabricated sentence references is unavailable, never accepted", () => {
  const prepared = withTurnReview("scene presence review", request(), contract);
  const bad = observations(); bad.beat_6.evidence_sentence_ids = [999];
  assert.throws(() => decodeTurnReview("scene presence review", prepared, output({beat_observations: bad})), TurnExecutionError);
});
test("opening without selected input cannot fail action resolution but retains actual agency violations", () => {
  const opening = planTurn({state: {...state, sourceEventProgress: undefined}, event, mode: "opening"});
  const prepared = withTurnReview("scene repetition review", request(), opening);
  const decoded = JSON.parse(decodeTurnReview("scene repetition review", prepared, output({preservesPlayerAgency: false,
    playerAgencyViolationQuote: "I lower the axe and rest it against the tree.", latestInputResolvedFaithfully: false, repeatsPriorScene: true})).output_text);
  assert.equal(decoded.latestInputResolvedFaithfully, true);
  assert.equal(decoded.preservesPlayerAgency, false);
  assert.equal(decoded.repeatsPriorScene, false);
});
test("the repair reason retains the concrete obstacle to the next decision", () => {
  const result = validateTurnEvidence(contract, {completedSourceEventBeatIndexes: [5,6], futureActionSetupRequired: true,
    futureActionSetupSupported: false, futureActionSetupReason: "Dorothy has already left speaking distance."});
  assert.ok(result.findings.some(f => f.code === "missing_setup" && f.message.includes("left speaking distance")));
});
class Probe extends TurnPipelineGameEngine {
  send(request: AiResponseRequest) {return this.createResponse("scene presence review", "test", request);}
}
test("production retries ungrounded review once against the same candidate", async () => {
  const seen: AiResponseRequest[] = [];
  const engine = new Probe({provider: "openai", model: "test", async createResponse(req) {
    seen.push(req);
    const values = observations(); if (seen.length === 1) values.beat_6.evidence_sentence_ids = [999];
    return output({beat_observations: values, peoplePresent: ["Tin Woodman", "Dorothy"], peopleWithinSpeakingDistance: ["Tin Woodman", "Dorothy"],
      latestVisibleSourceEventId: null, futureActionSetupRequired: false, futureActionSetupSupported: true, futureActionSetupReason: "", reason: "Visible."});
  }});
  const response = JSON.parse((await engine.send(request())).output_text);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.input, seen[1]!.input);
  assert.deepEqual(response.completedSourceEventBeatIndexes, [0,1,2,3,4,5,6]);
  assert.equal(response.turnValidation.status, "accepted");
});

test("capability rejection survives otherwise positive repetition findings", () => {
  const speechContract = {...contract, contextJson: JSON.stringify({character_runtime: {characters: [{name: "Toto", speech: {mode: "nonverbal"}}]}})};
  const req = {...request(), input: JSON.stringify({candidate_scene: {text: 'Toto says, "Hello."'}})};
  const prepared = withTurnReview("scene repetition review", req, speechContract);
  const decoded = JSON.parse(decodeTurnReview("scene repetition review", prepared, output({preservesPlayerAgency: true,
    playerAgencyViolationQuote: "", respectsCharacterCapabilities: false, characterCapabilityFailureReason: "Toto speaks a human sentence.",
    characterCapabilityViolationCharacter: "Toto", characterCapabilityViolationQuote: 'Toto says, "Hello."',
    staysWithinTurnScope: true, latestInputResolvedFaithfully: true})).output_text);
  assert.equal(decoded.staysWithinTurnScope, false);
  assert.match(decoded.turnScopeFailureReason, /Toto speaks/);
});

test("unknown speech capability cannot support an indexed nonverbal rejection", () => {
  const prepared = withTurnReview("scene repetition review", request(), contract);
  assert.deepEqual((prepared.text!.format.schema as any).properties.respectsCharacterCapabilities.enum, [true]);
  assert.throws(() => decodeTurnReview("scene repetition review", prepared, output({preservesPlayerAgency: true, staysWithinTurnScope: true,
    respectsCharacterCapabilities: false, characterCapabilityFailureReason: "Aunt Em cannot speak.", characterCapabilityViolationCharacter: "Aunt Em",
    characterCapabilityViolationQuote: candidate})), /Unknown capability/);
});

test("unexplained scope rejection triggers a review retry rather than accepting or rejecting the scene", () => {
  const prepared = withTurnReview("scene repetition review", request(), contract);
  assert.throws(() => decodeTurnReview("scene repetition review", prepared, output({preservesPlayerAgency: true,
    respectsCharacterCapabilities: true, staysWithinTurnScope: false, turnScopeFailureReason: "", reason: "The authorized window completed."})), /Scope rejection requires/);
});

test("a grounded scope rejection remains negative", () => {
  const prepared = withTurnReview("scene repetition review", request(), contract);
  const response = JSON.parse(decodeTurnReview("scene repetition review", prepared, output({preservesPlayerAgency: true,
    respectsCharacterCapabilities: true, staysWithinTurnScope: false, turnScopeFailureReason: "A claimed checkpoint reversal.",
    turnScopeViolationQuote: "Dorothy oils my legs until I can move freely."})).output_text);
  assert.equal(response.staysWithinTurnScope, false);
});

test("presence evidence is reconstructed from candidate sentences rather than a model quote", () => {
  const prepared = withTurnReview("scene presence review", request(), contract);
  const value = {...observations(), beat_6: {...observations().beat_6, quote: "Forged source passage."}};
  const decoded = JSON.parse(decodeTurnReview("scene presence review", prepared, output({beat_observations: value})).output_text);
  assert.equal(decoded.beat_observations.beat_6.quote, "Dorothy oils my legs until I can move freely.");
  assert.deepEqual(JSON.parse(prepared.input).candidate_sentences.map((s: any) => s.id), [1,2]);
});

test("choice review separates anchor routing from alternative usability and discards competing lookahead prose", () => {
  const req = {...request(), input: JSON.stringify({candidate_scene: {text: candidate, choices: [
    {text: "Ask to join the journey", character: "Dorothy"}, {text: "Inspect the axe"}]} })
    + '\nCHOICE NAVIGATION EVENT:\n' + JSON.stringify({eventId: "woodman"}) + '\nUPCOMING SOURCE ANCHOR MATERIAL:\nSECRET LATER EVENT',
    instructions: "Reject stalling alternatives."};
  const prepared = withTurnReview("scene choice review", req, contract);
  assert.doesNotMatch(prepared.input, /SECRET LATER EVENT/);
  assert.doesNotMatch(prepared.instructions!, /Reject stalling alternatives/);
  assert.match(prepared.instructions!, /TWO INDEPENDENT assessments/);
  assert.match(prepared.instructions!, /NEVER a reason for unusability/);
  assert.equal(JSON.parse(prepared.input).anchor_target.beat_index, 7);
  assert.equal(JSON.parse(prepared.input).candidate_scene.choices[0].actor,contract.player);
  assert.equal(JSON.parse(prepared.input).candidate_scene.choices[0].character,'Dorothy');
  assert.match(prepared.instructions!,/NEVER the action performer/);
});

test("choice generation cannot assign the player or a departed NPC as a required present participant", async () => {
  const { sceneChoiceMenuJsonSchema } = await import("../src/ai/schema.js");
  const req = {...request(), input: JSON.stringify({setting: {sceneScope: {peoplePresent: ["Tin Woodman", "Dorothy"]}}}),
    text: {format: {type: "json_schema" as const, name: "choices", strict: true, schema: sceneChoiceMenuJsonSchema}}};
  const prepared = withTurnReview("scene choices", req, contract);
  const properties = (prepared.text!.format.schema as any).properties.choices.items.properties;
  assert.deepEqual(properties.character.enum, [null, "Dorothy"]);
  assert.deepEqual(properties.requiredPresentCharacters.items.enum, ["Dorothy"]);
  assert.deepEqual(sceneChoiceMenuJsonSchema.properties.choices.items.properties.requiredPresentCharacters.items, {type: "string"});
});


test("canonical menu generation receives the exact next intentional beat without forcing alternatives", () => {
  const req = {...request(), input: JSON.stringify({setting: {text: candidate}, rejected_choices: [
    {text: "Leave Dorothy behind", role: "alternative", reason: "Do not assume an exit that has not been established."},
  ]})};
  const prepared = withTurnReview("scene choices", req, contract);
  const input = JSON.parse(prepared.input);
  assert.equal(input.required_anchor_decision.beat_index, 7);
  assert.equal(input.required_anchor_decision.action, event.beats[7]!.action);
  assert.equal(input.rejected_choices[0].role, "alternative");
  assert.match(prepared.instructions!, /does not constrain choices\[1\+\]/);
  const diverged = withTurnReview("scene choices", req, {...contract, sourceProgression: "optional"});
  assert.equal(JSON.parse(diverged.input).required_anchor_decision, undefined);
});


test("automatic-only generation cannot replay historical action metadata", () => {
  const automatic = {...contract, selectedIntent: null, requiredAutomaticBeatIndexes: [6]};
  const req = {...request(), text: {format: {type: "json_schema" as const, name: "scene", strict: true,
    schema: {type: "object", properties: {playerAction: {type: "string"}, actionResult: {type: "string"},
      actionOutcome: {type: "string"}, externalDevelopment: {type: "string"}}}}}};
  const prepared = withTurnReview("scene", req, automatic);
  const props = (prepared.text!.format.schema as any).properties;
  assert.deepEqual(props.playerAction.enum, [""]);
  assert.deepEqual(props.actionResult.enum, [""]);
  assert.deepEqual(props.actionOutcome.enum, ["none"]);
  assert.equal(props.externalDevelopment.minLength, 1);
  assert.equal((req.text.format.schema.properties.playerAction as any).enum, undefined);
});


test("scope assessment derives its result from grounded findings instead of contradictory booleans", () => {
  const prepared = withTurnReview("scene repetition review", request(), contract);
  const schema = prepared.text!.format.schema as any;
  assert.equal(schema.properties.staysWithinTurnScope, undefined);
  assert.ok(schema.required.includes("turnScopeFindings"));
  assert.equal(schema.properties.turnScopeFindings.items.properties.quote.minLength, 1);
  const accepted = JSON.parse(decodeTurnReview("scene repetition review", prepared, output({turnScopeFindings: []})).output_text);
  assert.equal(accepted.staysWithinTurnScope, true);
  assert.throws(() => decodeTurnReview("scene repetition review", prepared, output({turnScopeFindings: [{reason: "Unexpected action", quote: "Not in the candidate."}]})), /Scope rejection requires/);
  const rejected = JSON.parse(decodeTurnReview("scene repetition review", prepared, output({turnScopeFindings: [
    {reason: "First observed violation", quote: "I lower the axe"},
    {reason: "Second observed violation", quote: "until I can move freely."},
  ]})).output_text);
  assert.equal(rejected.staysWithinTurnScope, false);
  assert.match(rejected.turnScopeFailureReason, /Second observed violation/);
});
