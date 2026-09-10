import assert from "node:assert/strict";
import test from "node:test";
import type { Scene } from "../src/shared/contracts.js";
import {
  removeChoicesWithPlayerIdentityReferences,
} from "../src/ai/engine/scene-validation.js";

test("repairs player identity accidentally stored as action-choice metadata", () => {
  const scene = {
    choices: [
      {
        id: "wink-at-dorothy",
        type: "action",
        text: "Wink back and nod at Dorothy from my pole.",
        character: "Scarecrow",
        requiredPresentCharacters: ["Scarecrow", "Dorothy"],
        requiredAbsentCharacters: ["Scarecrow"],
        stakes: "significant",
      },
      {
        id: "talk-to-dorothy",
        type: "talk",
        text: "Talk to Dorothy",
        character: "Dorothy",
        requiredPresentCharacters: ["Dorothy"],
        requiredAbsentCharacters: [],
        stakes: "routine",
      },
    ],
  } as Scene;

  const repaired = removeChoicesWithPlayerIdentityReferences(
    scene,
    "Scarecrow",
  );

  assert.deepEqual(repaired.choices, [
    {
      id: "wink-at-dorothy",
      type: "action",
      text: "Wink back and nod at Dorothy from my pole.",
      requiredPresentCharacters: ["Dorothy"],
      requiredAbsentCharacters: [],
      stakes: "significant",
    },
    scene.choices[1],
  ]);
});

test("still removes a choice that names the player as a separate character", () => {
  const scene = {
    choices: [
      {
        id: "ask-the-player",
        type: "action",
        text: "Ask Scarecrow to wink at Dorothy.",
        character: "Dorothy",
        requiredPresentCharacters: ["Dorothy"],
        requiredAbsentCharacters: [],
        stakes: "significant",
      },
    ],
  } as Scene;

  const filtered = removeChoicesWithPlayerIdentityReferences(
    scene,
    "Scarecrow",
  );

  assert.deepEqual(filtered.choices, []);
});

test("removes a choice that refers to the player by a verified short alias", () => {
  const scene = {
    choices: [
      {
        id: "protect-from-lion",
        type: "action",
        text: "Take a protective stance beside Toto in case the Lion lunges again.",
        requiredPresentCharacters: ["Toto", "Cowardly Lion"],
        requiredAbsentCharacters: [],
        stakes: "significant",
      },
      {
        id: "own-the-mistake",
        type: "action",
        text: "Lower my head and apologize to Tin Woodman for denting his jaw.",
        requiredPresentCharacters: ["Tin Woodman"],
        requiredAbsentCharacters: [],
        stakes: "significant",
      },
    ],
  } as Scene;

  const filtered = removeChoicesWithPlayerIdentityReferences(
    scene,
    "Cowardly Lion",
    [{
      name: "Cowardly Lion",
      aliases: ["Lion"],
      role: "Companion",
      description: "A lion who believes himself cowardly.",
      traits: ["fearful"],
      relationships: [],
      storyArc: "Seeks courage.",
    }],
  );

  assert.deepEqual(filtered.choices, [scene.choices[1]]);
});
