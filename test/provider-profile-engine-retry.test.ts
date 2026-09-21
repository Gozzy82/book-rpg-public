import assert from "node:assert/strict";
import test from "node:test";

import type { AiClient, AiResponseRequest } from "../src/ai/provider.js";
import type { GameState } from "../src/shared/contracts.js";
import type { SourceContinuationCandidate } from "../src/ai/engine/core.js";
import { ProviderProfileEngine } from "../src/ai/engine/provider-profile-engine.js";

class TestProfileEngine extends ProviderProfileEngine {
  async selectSourceCandidate(
    _state: GameState,
    _candidates: readonly SourceContinuationCandidate[],
  ): Promise<SourceContinuationCandidate | undefined> {
    return undefined;
  }

  async selectSourceEvent(
    _state: GameState,
    _candidate: SourceContinuationCandidate,
  ): Promise<SourceContinuationCandidate | undefined> {
    return undefined;
  }

  callSceneResponse(request: AiResponseRequest) {
    return this.createResponse("scene", "book", request);
  }
}

test("profile engine leaves incomplete scene retrying to the outer scene loop", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      return {
        output_text: "",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      };
    },
  };
  const engine = new TestProfileEngine(client, "high");

  const response = await engine.callSceneResponse({
    model: "test-model",
    reasoning: { effort: "high" },
    instructions: "Generate one scene.",
    input: "Current turn.",
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_scene",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: [],
        },
      },
    },
    max_output_tokens: 1_600,
  });

  assert.equal(response.status, "incomplete");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.max_output_tokens, 1_600);
  assert.equal(requests[0]?.reasoning?.effort, "high");
});
