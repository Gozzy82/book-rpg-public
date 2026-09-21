import assert from "node:assert/strict";
import test from "node:test";
import type {
  AiResponse,
  AiResponseRequest,
} from "../src/ai/provider.js";
import {
  stripOpeningControlDataLeak,
} from "../src/ai/engine/provider-guarded-paced-bookrpg-engine.js";

const request = {
  model: "gpt-5-nano",
  input: [
    "OPENING PRELUDE:",
    "PRELUDE BEAT 0 — Uncle Henry: Recognizes that a cyclone is coming and calls to Aunt Em",
    "PRELUDE BEAT 1 — Aunt Em: Orders Dorothy to run for the cellar",
    "PRELUDE BEAT 2 — Toto: Jumps from Dorothy's arms and hides under the bed",
  ].join("\n"),
} as AiResponseRequest;

function response(text: string): AiResponse {
  return {
    status: "completed",
    output_text: JSON.stringify({
      title: "First Breath of the Storm",
      text,
    }),
    incomplete_details: null,
  } as AiResponse;
}

test("removes exact opening beat control-data restatements from player prose", () => {
  const result = stripOpeningControlDataLeak(
    request,
    response([
      "The wind hits the farmhouse hard.",
      "",
      "Uncle Henry: Recognizes that a cyclone is coming and calls to Aunt Em",
      "",
      "Aunt Em: Orders Dorothy to run for the cellar",
      "",
      "Toto: Jumps from Dorothy's arms and hides under the bed",
      "",
      "Toto vanishes beneath the bed while the floor shakes.",
    ].join("\n")),
  );

  const output = JSON.parse(result.output_text) as { text: string };
  assert.equal(
    output.text,
    "The wind hits the farmhouse hard.\n\nToto vanishes beneath the bed while the floor shakes.",
  );
});

test("does not strip ordinary dialogue or narrative actor references", () => {
  const text = [
    "Aunt Em grips the doorway.",
    "Dorothy: \"Where should I go?\"",
    "Aunt Em: \"Run for the cellar!\"",
  ].join("\n");
  const result = stripOpeningControlDataLeak(request, response(text));
  const output = JSON.parse(result.output_text) as { text: string };
  assert.equal(output.text, text);
});
