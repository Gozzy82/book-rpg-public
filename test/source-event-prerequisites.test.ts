import assert from "node:assert/strict";
import test from "node:test";
import { missingPresentSourceEventCharacters } from "../src/games/service.js";
import type { GameState, ImportedBook } from "../src/shared/contracts.js";
import type { SourceContinuationCandidate } from "../src/ai/engine.js";

const characterProfiles = [
  {
    name: "Mary Maloney",
    aliases: ["Mary"],
    role: "Player",
    description: "Mary.",
    traits: [],
    relationships: [],
    storyArc: "",
  },
  {
    name: "Patrick Maloney",
    aliases: ["Patrick"],
    role: "Husband",
    description: "Patrick.",
    traits: [],
    relationships: [],
    storyArc: "",
  },
];

const book = {
  chapters: [],
  worldBible: {
    summary: "",
    characters: ["Mary Maloney", "Patrick Maloney"],
    characterProfiles,
    locations: [],
  },
} as unknown as ImportedBook;

function gameWithPresentCharacters(peoplePresent: string[]) {
  return {
    playerName: "Mary Maloney",
    scene: {
      title: "Waiting",
      text: "Mary waits at home.",
      choices: [],
      sceneScope: {
        currentLocation: "Home",
        peoplePresent,
        peopleWithinSpeakingDistance: peoplePresent,
      },
    },
  } satisfies Pick<GameState, "playerName" | "scene">;
}

const greetingEvent = {
  chapterPosition: 0,
  chapterTitle: "Story",
  summary: "Mary welcomes Patrick.",
  excerpt: "Patrick comes home and Mary welcomes him.",
  nextTextOffset: 100,
  requiredEvent: "Mary welcomes Patrick.",
  requiredEventId: "welcome-patrick",
  requiredEventCategory: "other",
  requiredEventActors: ["Mary Maloney"],
  requiredEventTargets: ["Patrick Maloney"],
} satisfies SourceContinuationCandidate;

test("player source event is blocked until a required NPC participant is present", () => {
  assert.deepEqual(
    missingPresentSourceEventCharacters(
      gameWithPresentCharacters([]),
      book,
      greetingEvent,
    ),
    ["Patrick Maloney"],
  );
});

test("player source event becomes executable once the required NPC is present", () => {
  assert.deepEqual(
    missingPresentSourceEventCharacters(
      gameWithPresentCharacters(["Patrick Maloney"]),
      book,
      greetingEvent,
    ),
    [],
  );
});

test("NPC-only source events are not blocked by the player-action preflight", () => {
  const npcEvent = {
    ...greetingEvent,
    requiredEvent: "Patrick arrives home.",
    requiredEventId: "patrick-arrives",
    requiredEventCategory: "arrival" as const,
    requiredEventActors: ["Patrick Maloney"],
    requiredEventTargets: [],
  };

  assert.deepEqual(
    missingPresentSourceEventCharacters(
      gameWithPresentCharacters([]),
      book,
      npcEvent,
    ),
    [],
  );
});
