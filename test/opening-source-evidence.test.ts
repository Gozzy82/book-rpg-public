import assert from "node:assert/strict";
import test from "node:test";
import { completeSourceSentences } from "../src/ai/engine/opening-source-evidence.js";
import { TurnPipelineGameEngine } from "../src/ai/engine/turn-pipeline-engine.js";
import { planTurn } from "../src/ai/engine/turn-contract.js";
import { validateTurnEvidence } from "../src/ai/engine/turn-validator.js";
import type { AiResponseRequest } from "../src/ai/provider.js";
import type { GameState, StoryEventBeat } from "../src/shared/contracts.js";

const totoExcerpt = "Toto jumped out of Dorothy’s arms and hid under the bed, and the girl";
const emExcerpt = "started to get him. Aunt Em, badly frightened, threw open the trap door in the\nfloor and climbed down the ladder into the small, dark hole. Dorothy caught";
const safeEmExcerpt = "Aunt Em, badly frightened, threw open the trap door in the\nfloor and climbed down the ladder into the small, dark hole.";

test("line-boundary fragments cannot import the next player action into opening evidence", () => {
  assert.equal(completeSourceSentences(totoExcerpt), "");
  assert.equal(completeSourceSentences(emExcerpt), safeEmExcerpt);
  assert.equal(completeSourceSentences('Aunt Em dropped her work. “Run for the cellar!”'), 'Aunt Em dropped her work. “Run for the cellar!”');
});

class Probe extends TurnPipelineGameEngine {
  send(request: AiResponseRequest) { return this.createResponse("scene", "test", request); }
}

test("production opening preserves mandatory beats while bounding every excerpt copy and reserving JSON space", async () => {
  let captured: AiResponseRequest | undefined;
  const engine = new Probe({provider: "openai", model: "test", async createResponse(request) {
    captured = request;
    return {status: "completed", output_text: "{}", incomplete_details: null};
  }});
  const request: AiResponseRequest = {model: "test", max_output_tokens: 1600,
    input: "OPENING PRELUDE:\nPRELUDE BEAT 0 — Toto: Jumps from Dorothy’s arms and hides under the bed.\n"
      + "PRELUDE BEAT 1 — Aunt Em: Throws open the trapdoor and climbs down the ladder.\nGAME CONTEXT:\n"
      + JSON.stringify({player_identity: "Dorothy", next_significant_event_progress: {
        remaining_beats: [{sourceReferencesExcerpt: totoExcerpt}, {sourceReferencesExcerpt: emExcerpt}],
      }}),
  };
  await engine.send(request);
  assert.ok(captured);
  assert.equal(captured.max_output_tokens, 2400);
  assert.doesNotMatch(captured.input, /started to get him|Dorothy caught|and the girl/);
  assert.match(captured.input, /Jumps from Dorothy’s arms and hides under the bed/);
  assert.match(captured.input, /Aunt Em, badly frightened/);
  assert.match(request.input, /Dorothy caught/); // Original evidence is unchanged.
  await engine.send({...request, max_output_tokens: 3200});
  assert.equal(captured.max_output_tokens, 3200);
});

const beat = (actor: string, action: string): StoryEventBeat => ({actor, action, targets: [],
  agency: "intentional", stakes: "significant", sourceReferences: []});
const state = {playerName: "Dorothy", characterProfiles: [], parameters: []} as unknown as GameState;
const event = {eventId: "cyclone", beats: [
  beat("Uncle Henry", "Recognizes the approaching cyclone and runs toward the livestock sheds."),
  beat("Aunt Em", "Drops her work, reaches the doorway, and orders Dorothy to run to the cellar."),
  {...beat("Toto", "Jumps from Dorothy’s arms and hides under the bed."), agency: "involuntary" as const},
  beat("Aunt Em", "Throws open the trapdoor and climbs down into the cellar."),
  beat("Dorothy", "Catches Toto and begins following Aunt Em toward the cellar."),
]};

test("catching Toto alone already violates the unselected compound player boundary", () => {
  const decision = validateTurnEvidence(planTurn({state, mode: "opening", event}), {
    completedSourceEventBeatIndexes: [0,1,2,3], partiallyPerformedSourceEventBeatIndexes: [4],
  });
  assert.equal(decision.status, "repair_scene");
  assert.deepEqual(decision.observedPartialBeatIndexes, [4]);
  assert.deepEqual(decision.authorizedCompletedBeatIndexes, [0,1,2,3]);
  assert.ok(decision.findings.some(finding => finding.code === "unselected_player_action"));
});

test("gapped opening progress names the missing required action rather than only later indexes", () => {
  const decision = validateTurnEvidence(planTurn({state, mode: "opening", event}), {
    completedSourceEventBeatIndexes: [0,2,3],
  });
  assert.equal(decision.status, "repair_scene");
  const missing = decision.findings.find(finding => finding.code === "missing_required_progress");
  assert.ok(missing);
  assert.match(missing.message, /Drops her work, reaches the doorway, and orders Dorothy/);
  assert.deepEqual(decision.authorizedCompletedBeatIndexes, [0]);
});
