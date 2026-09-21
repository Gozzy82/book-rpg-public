import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openingReviewRequest, scoreOpeningReview, type OpeningReviewFixture } from "../src/ai/engine/measure-opening-review.js";
import { buildTurnScript } from "../src/ai/engine/turn-script.js";

const fixture: OpeningReviewFixture = JSON.parse(readFileSync(new URL("./fixtures/opening-review.json", import.meta.url), "utf8"));
test("opening entry checkpoint comes from the preceding indexed end state even without character prelude enrichment", () => {
  const c = fixture.contract;
  assert.equal(c.beats[3]!.automaticPreludeEndState, undefined);
  const script = buildTurnScript(c);
  assert.equal(script.next_decision!.precondition, c.beats[2]!.resultingState);
  assert.equal(script.next_decision!.precondition_after_beat_index, 2);
  assert.equal(script.next_decision!.entry_action.action, c.beats[3]!.action);
  assert.equal(script.next_decision!.action, c.nextPlayerAction!.choiceText);
  assert.notEqual(script.next_decision!.precondition, c.beats[3]!.resultingState);
});

test("captured opening replay uses current production policies and preserves prose without leaking expected answers", () => {
  assert.equal(fixture.cases.length, 5);
  for (let i = 0; i < fixture.cases.length; i++) {
    const request = openingReviewRequest(fixture, i, "test");
    assert.equal(JSON.parse(request.input).candidate_scene.text, fixture.cases[i]!.scene.text);
    assert.match(request.instructions!, /ACTOR AND TEMPORAL EVIDENCE/);
    assert.match(request.instructions!, /ENTRY STATE CHECKPOINT/);
    assert.match(request.instructions!, /BEGIN next_decision.entry_action/);
    assert.doesNotMatch(request.input + request.instructions, /expectedNextStatus|expectedSetup|sourceLog|retrieval-executed|opening-1/);
    assert.equal(new Set((request.text!.format.schema as any).required).size, (request.text!.format.schema as any).required.length);
  }
  assert.ok(fixture.cases[4]!.scene.text.startsWith(fixture.cases[3]!.scene.text));
  assert.match(fixture.cases[4]!.scene.text.slice(fixture.cases[3]!.scene.text.length), /reach beneath it to retrieve/);
});

function response(request: ReturnType<typeof openingReviewRequest>, nextStatus: string, setup = true) {
  const sentences = JSON.parse(request.input).candidate_sentences;
  return {status: "completed", output_text: JSON.stringify({
    peoplePresent: ["Dorothy", "Aunt Em", "Toto"], peopleWithinSpeakingDistance: ["Dorothy", "Aunt Em"], latestVisibleSourceEventId: null,
    futureActionSetupRequired: true, futureActionSetupSupported: setup, futureActionSetupReason: "test", reason: "test",
    checkpoint_observations: Object.fromEntries([0,1,2].map(i => [`beat_${i}`, {observed_state: "The automatic checkpoint is visible.", matches: true, reason: "", evidence_sentence_ids: [sentences.at(-1).id]}])),
    final_checkpoint: {observed_state: "Toto is under the bed; Dorothy has not retrieved him.", matches: true, reason: "", evidence_sentence_ids: [sentences.at(-1).id]},
    beat_observations: Object.fromEntries([0, 1, 2, 3].map(i => [`beat_${i}`, {
      status: i === 3 ? nextStatus : "completed", evidence_sentence_ids: i === 3 && nextStatus === "absent" ? [] : [sentences.at(-1).id],
    }])),
  })};
}

test("probe scoring retains real unselected-action rejection and does not bypass setup failures", () => {
  const positive = openingReviewRequest(fixture, 0, "test");
  assert.equal(scoreOpeningReview(fixture, 0, positive, response(positive, "absent")).passed, true);
  assert.equal(scoreOpeningReview(fixture, 0, positive, response(positive, "completed")).passed, false);
  assert.equal(scoreOpeningReview(fixture, 0, positive, response(positive, "absent", false)).passed, false);
  const negative = openingReviewRequest(fixture, 4, "test");
  const correct = scoreOpeningReview(fixture, 4, negative, response(negative, "completed"));
  assert.equal(correct.passed, true);
  assert.equal(correct.decision.status, "repair_scene");
  assert.equal(scoreOpeningReview(fixture, 4, negative, response(negative, "absent")).passed, false);
  assert.throws(() => scoreOpeningReview(fixture, 0, positive, {status: "incomplete", output_text: ""}), /Incomplete/);
});
