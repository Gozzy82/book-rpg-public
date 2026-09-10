import assert from "node:assert/strict";
import test from "node:test";

import {
  SCENE_SCOPE_RULES,
  TURN_SCOPE_RULES,
} from "../src/ai/engine/rules.js";
import {
  buildSceneRegenerationInstruction,
} from "../src/ai/engine/scene-context.js";

test("source continuation rules do not transplant events into the current location", () => {
  const rules = SCENE_SCOPE_RULES.join("\n");

  assert.match(
    rules,
    /Never transplant a source-backed event, character, or prop into sceneScope\.currentLocation/,
  );
  assert.match(
    rules,
    /narrate a visible, causally plausible transition before depicting location-specific source events/,
  );
  assert.match(
    rules,
    /Do not carry prior peoplePresent or peopleWithinSpeakingDistance forward/,
  );
});

test("scene retries preserve rejection feedback as an explicit correction constraint", () => {
  const failure = "Narration uses third-person rather than first-person singular for the player character.";
  const retryInstruction = buildSceneRegenerationInstruction(
    "Continue the scene.",
    undefined,
    [failure],
  );

  assert.match(retryInstruction, /REGENERATION REQUIRED/);
  assert.match(retryInstruction, /REJECTED BECAUSE/);
  assert.ok(retryInstruction.includes(failure));

  const turnRules = TURN_SCOPE_RULES.join("\n");
  assert.match(
    turnRules,
    /treat every listed rejection as an authoritative correction constraint for the next draft/,
  );
});
