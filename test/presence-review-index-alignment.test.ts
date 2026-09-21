import assert from "node:assert/strict";
import test from "node:test";

import type { AiResponse, AiResponseRequest } from "../src/ai/provider.js";
import {
  correctOpeningDecisionBoundaryReview,
  withAbsolutePresenceBeatIndex,
} from "../src/ai/engine/provider-guarded-paced-bookrpg-engine.js";

function presenceRequest(input: Record<string, unknown>): AiResponseRequest {
  return {
    model: "gpt-5-nano",
    input: JSON.stringify(input),
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_scene_presence_review",
        strict: true,
        schema: { type: "object", additionalProperties: true },
      },
    },
  };
}

test("local next-required beat index is translated to the absolute event index", () => {
  const request = presenceRequest({
    player_identity: "Tin Woodman",
    previous_completed_source_event_beat_indexes: [0, 1, 2, 3, 4, 5],
    next_required_source_event_beat: {
      index: 0,
      actor: "Tin Woodman",
      action: "Lowers his axe and leans it against the tree",
      agency: "intentional",
    },
  });

  const transformed = withAbsolutePresenceBeatIndex("scene presence review", request);
  const parsed = JSON.parse(transformed.input) as Record<string, any>;
  assert.equal(parsed.next_required_source_event_beat.index, 6);
});

test("already-absolute next-required beat index is preserved", () => {
  const request = presenceRequest({
    player_identity: "Tin Woodman",
    previous_completed_source_event_beat_indexes: [0, 1, 2, 3, 4],
    next_required_source_event_beat: {
      index: 5,
      actor: "Tin Woodman",
      action: "Confirms that he made the groan",
      agency: "intentional",
    },
  });

  assert.equal(withAbsolutePresenceBeatIndex("scene presence review", request), request);
});

test("a complete opening prefix validates the immediate player boundary", () => {
  const request = presenceRequest({
    event_review_target_mode: "opening_progression",
    future_player_actions: [{ beatIndex: 5, action: "Starts after Toto" }],
  });
  const response: AiResponse = {
    status: "completed",
    output_text: JSON.stringify({
      peoplePresent: ["Dorothy", "Toto"],
      peopleWithinSpeakingDistance: ["Dorothy"],
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [0, 1, 2, 3, 4],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason: "Reviewer incorrectly says the next boundary is not executable.",
      reason: "All preceding beats are complete.",
    }),
    incomplete_details: null,
  };

  const corrected = correctOpeningDecisionBoundaryReview(request, response);
  assert.equal(corrected.status, "completed");
  const output = JSON.parse(corrected.output_text) as Record<string, unknown>;
  assert.equal(output.futureActionSetupRequired, true);
  assert.equal(output.futureActionSetupSupported, true);
  assert.match(String(output.futureActionSetupReason), /current decision boundary/);
});
