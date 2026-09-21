import assert from "node:assert/strict";
import test from "node:test";

import type { GameState, Scene } from "../src/shared/contracts.js";
import type { AiResponseRequest } from "../src/ai/provider.js";
import type { SourceContinuationCandidate } from "../src/ai/engine/core.js";
import {
  hasAutomaticOrderedSourceBoundary,
  withAddressedActionResponseReview,
} from "../src/ai/engine/provider-guarded-paced-bookrpg-engine.js";

const sceneScope: Scene["sceneScope"] = {
  currentLocation: "Edge of a grove",
  peoplePresent: ["Tin Woodman", "Dorothy", "Scarecrow"],
  peopleWithinSpeakingDistance: ["Tin Woodman", "Dorothy", "Scarecrow"],
};

const joinEvent = {
  eventId: "join-party",
  sequence: 22,
  description: "The Tin Woodman joins Dorothy and the Scarecrow on their journey to Oz.",
  category: "other",
  chapterPosition: 7,
  actors: ["Dorothy", "Tin Woodman", "Scarecrow"],
  targets: ["Tin Woodman", "Dorothy", "Scarecrow"],
  beats: [
    {
      actor: "Dorothy",
      action: "Explains that she and the Scarecrow are traveling to Oz for help",
      targets: ["Tin Woodman"],
      agency: "intentional",
      stakes: "significant",
      sourceReferences: [],
    },
    {
      actor: "Tin Woodman",
      action: "Asks whether Oz could give him a heart",
      targets: ["Dorothy"],
      agency: "intentional",
      stakes: "significant",
      sourceReferences: [],
    },
  ],
} as const;

function state(completedBeatIndexes: number[] = []): GameState {
  return {
    playerName: "Tin Woodman",
    characterProfiles: [
      { name: "Tin Woodman", aliases: ["Woodman"] },
      { name: "Dorothy", aliases: [] },
      { name: "Scarecrow", aliases: [] },
    ],
    sourceEventProgress: completedBeatIndexes.length > 0
      ? { eventId: "join-party", completedBeatIndexes }
      : undefined,
  } as GameState;
}

const candidate = {
  requiredEventId: "join-party",
  requiredEvent: joinEvent.description,
  requiredEventCategory: joinEvent.category,
  requiredEventActors: [...joinEvent.actors],
  requiredEventTargets: [...joinEvent.targets],
  requiredEventBeats: [...joinEvent.beats],
  storyEvents: [joinEvent],
} as unknown as SourceContinuationCandidate;

test("keeps an NPC beat ahead of the next player decision behind source continuation", () => {
  assert.equal(
    hasAutomaticOrderedSourceBoundary(
      { sceneScope },
      state(),
      [candidate],
    ),
    true,
  );
});

test("releases the player choice after the preceding NPC beat is complete", () => {
  assert.equal(
    hasAutomaticOrderedSourceBoundary(
      { sceneScope },
      state([0]),
      [candidate],
    ),
    false,
  );
});

test("scene repetition review requires a substantive response to addressed actions", () => {
  const request = {
    input: "{}",
    instructions: "base review",
  } as AiResponseRequest;
  const guarded = withAddressedActionResponseReview("scene repetition review", request);

  assert.match(
    guarded.instructions ?? "",
    /A gaze, smile, nod, thoughtful pose, silence, atmosphere/u,
  );
  assert.match(
    guarded.instructions ?? "",
    /latestInputFailureType 'stalled'/u,
  );
  assert.equal(withAddressedActionResponseReview("scene", request), request);
});
