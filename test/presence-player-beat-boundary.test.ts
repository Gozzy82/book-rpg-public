import assert from "node:assert/strict";
import test from "node:test";

import {
  guardScenePresenceReviewPlayerBoundary,
} from "../src/ai/engine/provider-bookrpg-engine.js";
import type {
  AiResponse,
  AiResponseRequest,
} from "../src/ai/provider.js";

function presenceRequest(input: Record<string, unknown>): AiResponseRequest {
  return {
    model: "test",
    input: JSON.stringify(input),
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_scene_presence_review",
        strict: true,
        schema: {},
      },
    },
  } as AiResponseRequest;
}

function presenceResponse(
  completedSourceEventBeatIndexes: number[],
  latestVisibleSourceEventId: string | null,
): AiResponse {
  return {
    status: "completed",
    output_text: JSON.stringify({
      peoplePresent: ["Scarecrow", "Dorothy"],
      peopleWithinSpeakingDistance: ["Scarecrow", "Dorothy"],
      latestVisibleSourceEventId,
      completedSourceEventBeatIndexes,
      futureActionSetupRequired: false,
      futureActionSetupSupported: true,
      futureActionSetupReason: "",
      reason: "test",
    }),
    incomplete_details: null,
  } as AiResponse;
}

test("presence review cannot complete later Scarecrow beats past the next unselected player decision", () => {
  const request = presenceRequest({
    player_identity: "Scarecrow",
    event_review_target: {
      eventId: "discover-scarecrow",
    },
    next_required_source_event_beat: {
      index: 0,
      actor: "Scarecrow",
      action: "Winks and nods while fixed to a pole in the cornfield.",
    },
    future_player_actions: [
      {
        beatIndex: 0,
        action: "Winks and nods while fixed to a pole in the cornfield.",
      },
      {
        beatIndex: 1,
        action: "Explains that the pole is stuck in his back and asks Dorothy to remove it.",
      },
    ],
    candidate_scene: {
      player_action: "Wink and nod while fixed to a pole in the cornfield",
    },
  });
  const guarded = guardScenePresenceReviewPlayerBoundary(
    request,
    presenceResponse([0, 1, 2], "discover-scarecrow"),
  );
  const review = JSON.parse(guarded.output_text) as {
    completedSourceEventBeatIndexes: number[];
    latestVisibleSourceEventId: string | null;
  };

  assert.deepEqual(review.completedSourceEventBeatIndexes, [0]);
  assert.equal(review.latestVisibleSourceEventId, null);
});

test("opening review stops before Dorothy's first unselected player beat", () => {
  const request = presenceRequest({
    player_identity: "Dorothy",
    event_review_target: {
      eventId: "cyclone",
    },
    next_required_source_event_beat: {
      index: 0,
      actor: null,
      action: "The storm rises across the prairie.",
    },
    future_player_actions: [
      {
        beatIndex: 5,
        action: "Retrieves Toto and starts toward the cellar.",
      },
    ],
    candidate_scene: {
      player_action: "",
    },
  });
  const guarded = guardScenePresenceReviewPlayerBoundary(
    request,
    presenceResponse([0, 1, 2, 3, 4, 5], "cyclone"),
  );
  const review = JSON.parse(guarded.output_text) as {
    completedSourceEventBeatIndexes: number[];
    latestVisibleSourceEventId: string | null;
  };

  assert.deepEqual(review.completedSourceEventBeatIndexes, [0, 1, 2, 3, 4]);
  assert.equal(review.latestVisibleSourceEventId, null);
});

test("automatic beats before the next player boundary remain reportable", () => {
  const request = presenceRequest({
    player_identity: "Scarecrow",
    event_review_target: {
      eventId: "event",
    },
    next_required_source_event_beat: {
      index: 0,
      actor: "Scarecrow",
      action: "Winks at Dorothy.",
    },
    future_player_actions: [
      { beatIndex: 0, action: "Winks at Dorothy." },
      { beatIndex: 2, action: "Asks Dorothy a question." },
    ],
    candidate_scene: {
      player_action: "Wink at Dorothy",
    },
  });
  const original = presenceResponse([0, 1], null);
  const guarded = guardScenePresenceReviewPlayerBoundary(request, original);
  const review = JSON.parse(guarded.output_text) as {
    completedSourceEventBeatIndexes: number[];
  };

  assert.deepEqual(review.completedSourceEventBeatIndexes, [0, 1]);
});
