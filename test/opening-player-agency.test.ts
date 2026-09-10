import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlayerPerspective,
} from "../src/ai/engine/player.js";

test("opening perspective forbids inventing the player's first meaningful decision", () => {
  const openingPerspective = buildPlayerPerspective("Toto", undefined, true);
  const ordinaryPerspective = buildPlayerPerspective("Toto", undefined, false);

  assert.match(openingPerspective, /opening scene with no selected player action yet/i);
  assert.match(openingPerspective, /do not invent a consequential voluntary action/i);
  assert.match(openingPerspective, /promise, goal, departure, speech, or decision/i);
  assert.doesNotMatch(ordinaryPerspective, /opening scene with no selected player action yet/i);
});
