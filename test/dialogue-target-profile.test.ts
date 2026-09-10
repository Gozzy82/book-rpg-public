import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDialogueTargetCharacterProfile,
} from "../src/ai/engine/scene-context.js";
import type { CharacterProfile } from "../src/shared/contracts.js";

test("dialogue target profile stays compact and includes only the player relationship", () => {
  const profiles: CharacterProfile[] = [
    {
      name: "Scarecrow",
      aliases: ["the Scarecrow"],
      role: "Traveller",
      description: "A living figure made of straw.",
      traits: ["earnest"],
      relationships: [],
      storyArc: "Seeks brains from Oz.",
      actions: [],
      significantEvents: [],
      sourceReferences: [],
    },
    {
      name: "Dorothy Gale",
      aliases: ["Dorothy"],
      role: "Traveller from Kansas",
      description: "A determined girl trying to return home.",
      traits: ["kind", "practical"],
      relationships: [
        {
          character: "the Scarecrow",
          description: "Freed him from his pole and travels beside him.",
          sourceReferences: [],
        },
        {
          character: "Toto",
          description: "Her loyal dog.",
          sourceReferences: [],
        },
      ],
      storyArc: "Eventually returns to Kansas.",
      actions: [{
        description: "Frees the Scarecrow.",
        targets: [{ character: "Scarecrow" }],
        sourceReferences: [],
      }],
      significantEvents: [{
        eventId: "event_future",
        sequence: 99,
        description: "A future event that must not enter the dialogue profile.",
        category: "other",
        chapterPosition: 9,
        actors: ["Dorothy Gale"],
        targets: [],
        sourceReferences: [],
      }],
      sourceReferences: [],
    },
  ];

  const profile = buildDialogueTargetCharacterProfile(
    "Dorothy",
    "Scarecrow",
    profiles,
  );

  assert.deepEqual(profile, {
    name: "Dorothy Gale",
    aliases: ["Dorothy"],
    role: "Traveller from Kansas",
    description: "A determined girl trying to return home.",
    traits: ["kind", "practical"],
    relationships: [{
      character: "the Scarecrow",
      description: "Freed him from his pole and travels beside him.",
    }],
  });
  assert.equal("actions" in profile!, false);
  assert.equal("significantEvents" in profile!, false);
  assert.equal("storyArc" in profile!, false);
  assert.equal("sourceReferences" in profile!, false);
});

test("dialogue target profile is null when the target has no known profile", () => {
  assert.equal(
    buildDialogueTargetCharacterProfile("Unknown", "Scarecrow", []),
    null,
  );
});
