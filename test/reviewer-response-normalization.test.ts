import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeReviewerResponse,
} from "../src/ai/engine/provider-paced-bookrpg-engine.js";
import {
  SOURCE_CONTINUATION_CHOICE_TEXT,
} from "../src/shared/contracts.js";

function completed(output: Record<string, unknown>) {
  return {
    status: "completed" as const,
    output_text: JSON.stringify(output),
    incomplete_details: null,
  };
}

test("opening repetition review cannot reject the absence of an unselected player action", () => {
  const response = normalizeReviewerResponse(
    "scene repetition review",
    {
      model: "test",
      input: JSON.stringify({
        immediate_transition: null,
        recent_prior_scenes: [],
        candidate_scene: { text: "Dorothy studies the Scarecrow on his pole." },
      }),
    },
    completed({
      repeatsPriorScene: true,
      latestInputResolvedFaithfully: true,
      preservesPlayerPerspective: true,
      preservesPlayerAgency: false,
      staysWithinTurnScope: true,
      playerAgencyFailureReason:
        "No explicit player action or decision is taken in this opening beat.",
      requiredEventOccurred: false,
      reason: "The opening has not advanced player agency.",
    }),
  );
  const review = JSON.parse(response.output_text);

  assert.equal(review.repeatsPriorScene, false);
  assert.equal(review.preservesPlayerAgency, true);
  assert.equal(review.playerAgencyFailureReason, "");
});

test("opening presence review infers the completed prelude prefix from a supported first player boundary", () => {
  const response = normalizeReviewerResponse(
    "scene presence review",
    {
      model: "test",
      input: JSON.stringify({
        event_review_target_mode: "opening_progression",
        previous_completed_source_event_beat_indexes: [],
        future_player_actions: [
          { beatIndex: 1, action: "Winks and nods to Dorothy" },
          { beatIndex: 3, action: "Speaks to Dorothy" },
        ],
      }),
    },
    completed({
      peoplePresent: ["Scarecrow", "Dorothy"],
      peopleWithinSpeakingDistance: ["Scarecrow", "Dorothy"],
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: true,
      futureActionSetupSupported: true,
      futureActionSetupReason: "Dorothy can see the Scarecrow on his pole.",
      reason: "The wink is immediately executable.",
    }),
  );
  const review = JSON.parse(response.output_text);

  assert.deepEqual(review.completedSourceEventBeatIndexes, [0]);
});

test("system source continuation remains usable even when the semantic choice reviewer rejects it", () => {
  const response = normalizeReviewerResponse(
    "scene choice review",
    {
      model: "test",
      input: JSON.stringify({
        candidate_scene: {
          choices: [
            {
              type: "action",
              text: SOURCE_CONTINUATION_CHOICE_TEXT,
              character: null,
            },
          ],
        },
      }),
    },
    completed({
      anchorChoiceIndex: null,
      unusableChoiceIndexes: [0],
      unusableChoicesReason: "This is not a meaningful player-controlled route.",
      reason: "The next beat is NPC-driven.",
    }),
  );
  const review = JSON.parse(response.output_text);

  assert.deepEqual(review.unusableChoiceIndexes, []);
  assert.equal(review.unusableChoicesReason, "");
  assert.equal(review.anchorChoiceIndex, null);
});
