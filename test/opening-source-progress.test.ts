import assert from "node:assert/strict";
import test from "node:test";

import {
  openingSceneWordBudget,
} from "../src/ai/engine/provider-turn-engine.js";
import {
  sourceEventFirstPlayerChoiceBeatIndex,
} from "../src/ai/engine/source-navigation.js";

const cycloneEvent = {
  eventId: "cyclone",
  description: "A cyclone approaches the Kansas farmhouse.",
  chapterPosition: 0,
  beats: [
    { actor: null, action: "Wind rises.", targets: [], agency: "external" as const, stakes: "significant" as const, sourceReferences: [] },
    { actor: "Uncle Henry", action: "Warns Aunt Em.", targets: [], agency: "intentional" as const, stakes: "significant" as const, sourceReferences: [] },
    { actor: "Uncle Henry", action: "Runs to the sheds.", targets: [], agency: "intentional" as const, stakes: "significant" as const, sourceReferences: [] },
    { actor: "Aunt Em", action: "Orders Dorothy to the cellar.", targets: ["Dorothy"], agency: "intentional" as const, stakes: "critical" as const, sourceReferences: [] },
    { actor: "Toto", action: "Hides under the bed.", targets: [], agency: "intentional" as const, stakes: "significant" as const, sourceReferences: [] },
    { actor: "Aunt Em", action: "Climbs into the cellar.", targets: [], agency: "intentional" as const, stakes: "critical" as const, sourceReferences: [] },
    { actor: "Dorothy", action: "Catches Toto and starts toward the cellar.", targets: ["Toto"], agency: "intentional" as const, stakes: "critical" as const, sourceReferences: [] },
    { actor: "Dorothy", action: "Falls as the house shakes.", targets: [], agency: "involuntary" as const, stakes: "significant" as const, sourceReferences: [] },
  ],
};

test("Dorothy opening keeps six prelude beats visible before her first decision", () => {
  const firstPlayerBeatIndex = sourceEventFirstPlayerChoiceBeatIndex(
    cycloneEvent,
    "Dorothy",
    [],
  );

  assert.equal(firstPlayerBeatIndex, 6);
  assert.equal(openingSceneWordBudget(firstPlayerBeatIndex), 600);
  assert.deepEqual(
    cycloneEvent.beats.slice(0, firstPlayerBeatIndex).map((beat) => beat.action),
    [
      "Wind rises.",
      "Warns Aunt Em.",
      "Runs to the sheds.",
      "Orders Dorothy to the cellar.",
      "Hides under the bed.",
      "Climbs into the cellar.",
    ],
  );
  assert.equal(
    cycloneEvent.beats[firstPlayerBeatIndex]?.action,
    "Catches Toto and starts toward the cellar.",
  );
});

test("Scarecrow opening still starts at his first player decision", () => {
  const event = {
    eventId: "free_scarecrow",
    description: "Dorothy discovers and frees the Scarecrow.",
    chapterPosition: 0,
    beats: [
      { actor: "Scarecrow", action: "Winks and nods.", targets: ["Dorothy"], agency: "intentional" as const, stakes: "significant" as const, sourceReferences: [] },
      { actor: "Scarecrow", action: "Says the pole is stuck.", targets: ["Dorothy"], agency: "intentional" as const, stakes: "significant" as const, sourceReferences: [] },
      { actor: "Dorothy", action: "Lifts him down.", targets: ["Scarecrow"], agency: "intentional" as const, stakes: "critical" as const, sourceReferences: [] },
    ],
  };

  const firstPlayerBeatIndex = sourceEventFirstPlayerChoiceBeatIndex(
    event,
    "Scarecrow",
    [],
  );

  assert.equal(firstPlayerBeatIndex, 0);
  assert.equal(openingSceneWordBudget(firstPlayerBeatIndex), 600);
});

test("opening word budget is always capped at exactly 600 words", () => {
  assert.equal(openingSceneWordBudget(0), 600);
  assert.equal(openingSceneWordBudget(1), 600);
  assert.equal(openingSceneWordBudget(3), 600);
  assert.equal(openingSceneWordBudget(5), 600);
  assert.equal(openingSceneWordBudget(6), 600);
  assert.equal(openingSceneWordBudget(20), 600);
});
