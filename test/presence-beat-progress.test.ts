import assert from "node:assert/strict";
import test from "node:test";
import type { AiResponse, AiResponseRequest } from "../src/ai/provider.js";
import {
  correctScenePresenceBeatOrder,
} from "../src/ai/engine/provider-engine-base.js";

function reviewRequest(
  mode: "scene_completion" | "opening_progression",
  beatCount: number,
  previousCompleted: number[] = [],
  futurePlayerBeatIndexes: number[] = [],
): AiResponseRequest {
  return {
    model: "test",
    input: JSON.stringify({
      event_review_target: {
        eventId: "event_test",
        beats: Array.from({ length: beatCount }, (_value, index) => ({
          actor: `Actor ${index}`,
          action: `Beat ${index}`,
        })),
      },
      event_review_target_mode: mode,
      previous_completed_source_event_beat_indexes: previousCompleted,
      future_player_actions: futurePlayerBeatIndexes.map((beatIndex) => ({ beatIndex })),
    }),
  } as AiResponseRequest;
}

function reviewResponse(
  completedSourceEventBeatIndexes: number[],
  overrides: Record<string, unknown> = {},
): AiResponse {
  return {
    output_text: JSON.stringify({
      peoplePresent: [],
      peopleWithinSpeakingDistance: [],
      latestVisibleSourceEventId: "event_test",
      completedSourceEventBeatIndexes,
      futureActionSetupRequired: false,
      futureActionSetupSupported: true,
      futureActionSetupReason: "",
      reason: "test",
      ...overrides,
    }),
  } as AiResponse;
}

test("normal scene presence backfills ordered beats before a detected later beat", () => {
  const corrected = correctScenePresenceBeatOrder(
    reviewRequest("scene_completion", 5, [0, 1]),
    reviewResponse([4]),
  );
  const review = JSON.parse(corrected.output_text) as {
    completedSourceEventBeatIndexes: number[];
  };

  assert.deepEqual(review.completedSourceEventBeatIndexes, [2, 3, 4]);
});

test("opening presence does not backfill across missing ordered beats", () => {
  const corrected = correctScenePresenceBeatOrder(
    reviewRequest("opening_progression", 5, [], [4]),
    reviewResponse([3]),
  );
  const review = JSON.parse(corrected.output_text) as {
    completedSourceEventBeatIndexes: number[];
    futureActionSetupSupported: boolean;
    futureActionSetupReason: string;
  };

  assert.deepEqual(review.completedSourceEventBeatIndexes, []);
  assert.equal(review.futureActionSetupSupported, false);
  assert.match(review.futureActionSetupReason, /missing ordered source beats 0-3/i);
});

test("opening player boundary is not rejected merely because the choice is not enacted yet", () => {
  const corrected = correctScenePresenceBeatOrder(
    reviewRequest("opening_progression", 2, [], [0]),
    reviewResponse([], {
      latestVisibleSourceEventId: null,
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason:
        "Earliest future beat has not been visibly enacted; the player has not performed it yet.",
    }),
  );
  const review = JSON.parse(corrected.output_text) as {
    completedSourceEventBeatIndexes: number[];
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
    futureActionSetupReason: string;
  };

  assert.deepEqual(review.completedSourceEventBeatIndexes, []);
  assert.equal(review.futureActionSetupRequired, true);
  assert.equal(review.futureActionSetupSupported, true);
  assert.match(review.futureActionSetupReason, /opening decision boundary/i);
});
