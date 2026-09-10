import assert from "node:assert/strict";
import test from "node:test";
import type { AiResponseRequest } from "../src/ai/provider.js";
import {
  correctScenePresenceBeatOrder,
} from "../src/ai/engine/provider-engine-base.js";

test("opening setup review waits until preceding ordered beats reach the player boundary", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      event_review_target: {
        eventId: "cyclone",
        beats: Array.from({ length: 9 }, (_value, index) => ({
          actor: index === 8 ? "Dorothy" : "World",
          action: `beat-${index}`,
        })),
      },
      event_review_target_mode: "opening_progression",
      previous_completed_source_event_beat_indexes: [0, 1, 2, 3, 4, 5, 6],
      future_player_actions: [
        {
          beatIndex: 8,
          actor: "Dorothy",
          action: "Pull Toto back into the room and close the trapdoor.",
        },
      ],
    }),
  };
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason:
        "Dorothy cannot yet pull Toto back because the house-lift beat has not happened.",
    }),
  };

  const corrected = JSON.parse(
    correctScenePresenceBeatOrder(request, response).output_text,
  ) as {
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
    completedSourceEventBeatIndexes: number[];
  };

  assert.deepEqual(corrected.completedSourceEventBeatIndexes, []);
  assert.equal(corrected.futureActionSetupRequired, false);
  assert.equal(corrected.futureActionSetupSupported, true);
});

test("normal scene setup review also waits for preceding ordered beats", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      event_review_target: {
        eventId: "heart-choice",
        beats: [
          { actor: "Oz", action: "Offers the Tin Woodman a choice." },
          { actor: "Tin Woodman", action: "Chooses a heart." },
        ],
      },
      event_review_target_mode: "scene_completion",
      previous_completed_source_event_beat_indexes: [],
      future_player_actions: [
        {
          beatIndex: 1,
          actor: "Tin Woodman",
          action: "Chooses a heart.",
        },
      ],
    }),
  };
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason:
        "Oz is not present or reachable, so the Tin Woodman cannot choose a heart yet.",
    }),
  };

  const corrected = JSON.parse(
    correctScenePresenceBeatOrder(request, response).output_text,
  ) as {
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
    completedSourceEventBeatIndexes: number[];
  };

  assert.deepEqual(corrected.completedSourceEventBeatIndexes, []);
  assert.equal(corrected.futureActionSetupRequired, false);
  assert.equal(corrected.futureActionSetupSupported, true);
});

test("opening setup review still enforces prerequisites once the player beat is next", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      event_review_target: {
        eventId: "cyclone",
        beats: Array.from({ length: 9 }, (_value, index) => ({
          actor: index === 8 ? "Dorothy" : "World",
          action: `beat-${index}`,
        })),
      },
      event_review_target_mode: "opening_progression",
      previous_completed_source_event_beat_indexes: [0, 1, 2, 3, 4, 5, 6, 7],
      future_player_actions: [
        {
          beatIndex: 8,
          actor: "Dorothy",
          action: "Pull Toto back into the room and close the trapdoor.",
        },
      ],
    }),
  };
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason:
        "The room and open trapdoor are not established at the decision point.",
    }),
  };

  const corrected = JSON.parse(
    correctScenePresenceBeatOrder(request, response).output_text,
  ) as {
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
  };

  assert.equal(corrected.futureActionSetupRequired, true);
  assert.equal(corrected.futureActionSetupSupported, false);
});
