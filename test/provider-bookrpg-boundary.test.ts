import assert from "node:assert/strict";
import test from "node:test";
import type { AiResponseRequest } from "../src/ai/provider.js";
import {
  guardScenePresenceReviewPlayerBoundary,
} from "../src/ai/engine/provider-bookrpg-engine.js";

function guardedCompletedIndexes(
  player: string,
  playerAction: string,
  sourceAction: string,
  beatIndex: number,
): number[] {
  const request: AiResponseRequest = {
    model: "test-model",
    input: JSON.stringify({
      player_identity: player,
      candidate_scene: {
        player_action: playerAction,
      },
      next_required_source_event_beat: {
        index: beatIndex,
        actor: player,
        action: sourceAction,
      },
      future_player_actions: [{
        beatIndex,
        action: sourceAction,
      }],
    }),
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_scene_presence_review",
        strict: true,
        schema: {},
      },
    },
  };
  const response = guardScenePresenceReviewPlayerBoundary(request, {
    output_text: JSON.stringify({
      completedSourceEventBeatIndexes: [beatIndex],
      latestVisibleSourceEventId: null,
    }),
  });
  const output = JSON.parse(response.output_text) as {
    completedSourceEventBeatIndexes?: number[];
  };
  return output.completedSourceEventBeatIndexes ?? [];
}

test("selected Scarecrow beat survives me-to-him perspective normalization", () => {
  assert.deepEqual(
    guardedCompletedIndexes(
      "Scarecrow",
      "Explain that he has no brains and ask whether Oz might give me some",
      "Explains that he has no brains and asks whether Oz might give him some",
      1,
    ),
    [1],
  );
});

test("selected Tin Woodman beat survives me-to-him perspective normalization", () => {
  assert.deepEqual(
    guardedCompletedIndexes(
      "Tin Woodman",
      "Move freely and thank Dorothy and the Scarecrow for releasing me",
      "Moves freely and thanks Dorothy and the Scarecrow for releasing him",
      8,
    ),
    [8],
  );
});
