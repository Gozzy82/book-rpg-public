import assert from "node:assert/strict";
import test from "node:test";
import type { AiResponseRequest } from "../src/ai/provider.js";
import type { GameState } from "../src/shared/contracts.js";
import { TurnPipelineGameEngine } from "../src/ai/engine/turn-pipeline-engine.js";
import { buildSceneChoiceReviewContext, buildSceneRepetitionReviewContext } from "../src/ai/engine/scene-context.js";
import { withCurrentBeatOnlyGenerationContext } from "../src/ai/engine/provider-bookrpg-engine.js";
import { WORLD_RULE_POLICY, DIALOGUE_SUGGESTION_TIMELINE_RULES } from "../src/ai/engine/rules.js";
import {
  CHOICE_EXECUTION_POLICY,
  EVENT_COMPLETION_POLICY,
  PLAYER_PERSPECTIVE_POLICY,
  PRESENCE_POLICY,
  TURN_PROGRESSION_POLICY,
  withSharedStoryPolicy,
} from "../src/ai/engine/shared-policy.js";

class RequestProbe extends TurnPipelineGameEngine {
  send(label: string, request: AiResponseRequest) {
    return this.createResponse(label, "policy-test", request);
  }
}

function assertRulesOnce(request: AiResponseRequest, rules: readonly string[]) {
  const lines = (request.instructions ?? "").split("\n");
  for (const rule of rules) assert.equal(lines.filter((line) => line === rule).length, 1, rule);
}

test("production provider applies identical policy to creation, repair phases and reviews after adapters", async () => {
  const captured: AiResponseRequest[] = [];
  const engine = new RequestProbe({
    provider: "openai",
    model: "test",
    async createResponse(request) {
      captured.push(request);
      return { status: "completed", output_text: "{}", incomplete_details: null };
    },
  });
  for (const label of ["scene", "opening prelude", "opening boundary", "dialogue response", "scene repetition review", "scene presence review", "scene choices", "scene choice review", "source anchor route review", "world rule compliance review", "loss avoidability review"]) {
    await engine.send(label, {
      model: "test",
      instructions: `LOCAL ${label}\n${WORLD_RULE_POLICY.join("\n")}`,
      input: "{}",
    });
    const request = captured.at(-1)!;
    assert.match(request.instructions!, new RegExp(`LOCAL ${label}`));
    assertRulesOnce(request, WORLD_RULE_POLICY);
    if (["scene", "opening prelude", "opening boundary", "dialogue response", "scene repetition review"].includes(label)) {
      assertRulesOnce(request, PLAYER_PERSPECTIVE_POLICY);
      assertRulesOnce(request, TURN_PROGRESSION_POLICY);
    }
    if (["scene", "scene presence review"].includes(label)) assertRulesOnce(request, PRESENCE_POLICY);
    if (["scene choices", "scene choice review"].includes(label)) assertRulesOnce(request, CHOICE_EXECUTION_POLICY);
    assert.ok(!request.instructions!.includes(DIALOGUE_SUGGESTION_TIMELINE_RULES[0]));
  }
});

test("shared policy survives retries without duplication or changes to schemas, evidence or token budgets", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: "CURRENT BEAT ONLY",
    instructions: "Repair only the failed requirement.",
    max_output_tokens: 1234,
    text: { format: { type: "json_schema", name: "test", strict: true, schema: { type: "object" } } },
  };
  const once = withSharedStoryPolicy("scene choices", request);
  assert.deepEqual(withSharedStoryPolicy("scene choices", once), once);
  assert.equal(once.input, request.input);
  assert.equal(once.text, request.text);
  assert.equal(once.max_output_tokens, 1234);
  assert.equal(withSharedStoryPolicy("chapter analysis", request), request);
  assertRulesOnce(withSharedStoryPolicy("scene event alignment", request), EVENT_COMPLETION_POLICY);
});

test("applying policy cannot restore future source data removed from generation context", () => {
  const bounded = withCurrentBeatOnlyGenerationContext("scene", {
    model: "test",
    instructions: "Keep the current decision pending.",
    input: 'GAME CONTEXT:\n' + JSON.stringify({
      player_identity: "Scarecrow",
      upcoming_source_material: [{ excerpt: "SECRET FUTURE SCENE" }],
      next_significant_event_progress: {
        next_required_beat: { actor: "Scarecrow", action: "Ask Dorothy to remove the pole", sourceReferencesExcerpt: "CURRENT SOURCE" },
        remaining_beats: [{ action: "SECRET FUTURE ACTION" }],
      },
    }),
  });
  const final = withSharedStoryPolicy("scene", bounded);
  assert.equal(final.input, bounded.input);
  assert.doesNotMatch(final.input, /SECRET FUTURE/);
  assert.match(final.input, /Ask Dorothy to remove the pole/);
});

test("continuity and choice reviewers receive the same ordered conflicting world rules as generation", () => {
  const parameters = ["Toto cannot speak.", "Toto can now speak."];
  const state = {
    playerName: "Dorothy", parameters, characterProfiles: [], history: [],
    selectedText: "Toto stands nearby.", objective: "Travel onward.",
    scene: { title: "Road", text: "I stand beside Toto.", choices: [] },
  } as unknown as GameState;
  const candidate = state.scene;
  for (const context of [buildSceneRepetitionReviewContext(state, candidate), buildSceneChoiceReviewContext(state, candidate)]) {
    assert.deepEqual(JSON.parse(context).runtime_parameters, parameters);
  }
  assert.match(WORLD_RULE_POLICY.join("\n"), /newest \(last\) world rule wins/);
  assert.match(WORLD_RULE_POLICY.join("\n"), /overridden by a newer conflicting rule is not a compliance requirement/);
});
