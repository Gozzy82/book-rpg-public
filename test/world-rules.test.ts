import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKRPG_WORLD_RULE_RULES,
  bookRpgWorldRulesFromRequest,
  withBookRpgWorldRuleTerminology,
} from "../src/ai/engine.js";
import type { GameState } from "../src/shared/contracts.js";
import {
  BOOKRPG_WORLD_RULE_PREFIX,
  displayWorldRule,
  migrateLegacyWorldRules,
  storedWorldRule,
  worldRulesForGame,
} from "../src/shared/world-rules.js";

test("recurring BookRPG world rules stay visibly active while applicable", () => {
  const rules = BOOKRPG_WORLD_RULE_RULES.join("\n");

  assert.match(
    rules,
    /continuous, constant, always-on, frequent, repeated, recurring, or per-scene observable behavior/i,
  );
  assert.match(
    rules,
    /every generated scene where the affected character is present/i,
  );
  assert.match(rules, /at least one concrete observable sign/i);
  assert.match(
    rules,
    /do not omit an applicable recurring behavior merely because the main plot beat is unrelated/i,
  );
});

test("AI requests expose BookRPG world rules instead of generic runtime parameters", () => {
  const normalized = withBookRpgWorldRuleTerminology({
    model: "test-model",
    instructions: [
      "runtime_parameters are persistent user-authored overrides.",
      "When parameters conflict, the newest wins.",
      "When a parameter explicitly describes recurring behavior, apply it.",
    ].join("\n"),
    input: JSON.stringify({ runtime_parameters: ["Dorothy constantly passes gas."] }),
  });

  assert.match(normalized.instructions ?? "", /BookRPG world rules/i);
  assert.doesNotMatch(normalized.instructions ?? "", /runtime_parameters/i);
  assert.match(normalized.input, /bookrpg_world_rules/);
  assert.doesNotMatch(normalized.input, /runtime_parameters/);
});

test("world-rule enforcement can recover active rules from a normalized gameplay request", () => {
  const normalized = withBookRpgWorldRuleTerminology({
    model: "test-model",
    input: [
      "GAME CONTEXT:",
      JSON.stringify({
        runtime_parameters: [
          "Dorothy constantly passes gas.",
          "The road is always yellow, even when someone says \"]\" aloud.",
        ],
      }, null, 2),
    ].join("\n"),
  });

  assert.deepEqual(bookRpgWorldRulesFromRequest(normalized), [
    "Dorothy constantly passes gas.",
    "The road is always yellow, even when someone says \"]\" aloud.",
  ]);
});

test("requests without BookRPG world rules skip enforcement extraction", () => {
  assert.deepEqual(bookRpgWorldRulesFromRequest({
    model: "test-model",
    input: JSON.stringify({ scene: "No overrides are active." }),
  }), []);
});

test("legacy parameter saves migrate to worldRules without changing their meaning", () => {
  const legacyRule = "Dorothy constantly passes gas.";
  const game = {
    parameters: [legacyRule],
  } as unknown as GameState;

  assert.equal(migrateLegacyWorldRules(game), true);
  assert.deepEqual(game.worldRules, [legacyRule]);
  assert.deepEqual(worldRulesForGame(game), [legacyRule]);
  assert.deepEqual(game.parameters, game.worldRules);
});

test("legacy parameter writes are promoted before the next save", () => {
  const game = {
    worldRules: ["The road is always yellow."],
    parameters: ["Dorothy constantly passes gas."],
  } as unknown as GameState;

  assert.equal(migrateLegacyWorldRules(game), true);
  assert.deepEqual(game.worldRules, ["Dorothy constantly passes gas."]);
  assert.deepEqual(game.parameters, game.worldRules);
});

test("stored BookRPG world-rule labels are hidden from the web-facing text", () => {
  const visible = "Dorothy constantly passes gas.";
  const stored = storedWorldRule(visible);

  assert.equal(stored, `${BOOKRPG_WORLD_RULE_PREFIX}${visible}`);
  assert.equal(displayWorldRule(stored), visible);
  assert.equal(storedWorldRule(stored), stored);
});
