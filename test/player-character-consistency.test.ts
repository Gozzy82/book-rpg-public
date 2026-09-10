import assert from "node:assert/strict";
import test from "node:test";
import type { CharacterProfile } from "../src/shared/contracts.js";
import {
  buildPlayerPerspective,
} from "../src/ai/engine/player.js";

test("player perspective preserves profile-backed perceived limitations and unmet goals", () => {
  const scarecrow: CharacterProfile = {
    name: "Scarecrow",
    aliases: ["the Scarecrow"],
    role: "Companion",
    description: "A living scarecrow who believes he has no brains and wants the Wizard of Oz to give him some.",
    traits: ["earnest", "kind"],
    relationships: [],
    actions: [],
    storyArc: "Travels to Oz seeking brains.",
    significantEvents: [],
    sourceReferences: [],
  };

  const perspective = buildPlayerPerspective("Scarecrow", scarecrow);

  assert.match(perspective, /believes he has no brains/i);
  assert.match(
    perspective,
    /Do not make the player confidently claim to already possess a capability, quality, knowledge, or condition/i,
  );
  assert.match(perspective, /profile says they believe they lack or are currently seeking to gain/i);
});
