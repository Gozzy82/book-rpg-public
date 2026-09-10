import assert from "node:assert/strict";
import test from "node:test";
import type {
  AiResponse,
  AiResponseRequest,
} from "../src/ai/provider.js";
import {
  normalizeOpeningSceneActionMetadata,
} from "../src/ai/engine/provider-turn-engine.js";

function sceneRequest(input: string): AiResponseRequest {
  return {
    model: "test-model",
    input,
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_scene",
        strict: true,
        schema: {},
      },
    },
  } as AiResponseRequest;
}

function sceneResponse(output: Record<string, unknown>): AiResponse {
  return {
    status: "completed",
    output_text: JSON.stringify(output),
  } as AiResponse;
}

test("opening scene responses cannot invent PLAYER ACTION metadata", () => {
  const request = sceneRequest(
    "There is no completed PLAYER ACTION in an opening. Stage the next decision.",
  );
  const response = sceneResponse({
    title: "Opening",
    text: "Dorothy approaches while I remain on the pole.",
    playerAction: "Wink and nod at Dorothy from my pole.",
    actionOutcome: "succeeded",
    actionResult: "Dorothy notices me.",
  });

  const normalized = normalizeOpeningSceneActionMetadata(request, response);
  const output = JSON.parse(normalized.output_text) as Record<string, unknown>;

  assert.equal(output.playerAction, "");
  assert.equal(output.actionOutcome, "none");
  assert.equal(output.actionResult, "");
  assert.equal(output.title, "Opening");
  assert.equal(output.text, "Dorothy approaches while I remain on the pole.");
});

test("ordinary scene responses keep their PLAYER ACTION metadata", () => {
  const request = sceneRequest("Resolve PLAYER ACTION exactly.");
  const response = sceneResponse({
    playerAction: "Open the door.",
    actionOutcome: "succeeded",
    actionResult: "The door opens.",
  });

  assert.strictEqual(normalizeOpeningSceneActionMetadata(request, response), response);
});
