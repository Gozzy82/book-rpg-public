import assert from "node:assert/strict";
import test from "node:test";

import {
  contiguousReportedSourceBeatIndexes,
  shouldUseAutomaticOrderedSourceContinuation,
} from "../src/ai/engine/provider-scene-reviewer.js";
import {
  buildRequiredPlayerChoiceFallback,
  buildSourceEventChoiceBeatState,
  sourceEventFirstPlayerChoiceBeatIndex,
  sourceEventRequiresExplicitPlayerChoice,
} from "../src/ai/engine/source-navigation.js";
import {
  addSourceContinuationAnchorChoice,
} from "../src/ai/engine/scene-validation.js";

test("presence review never fills an unreported earlier source beat", () => {
  assert.deepEqual(
    contiguousReportedSourceBeatIndexes([], [1], 3),
    [],
  );
  assert.deepEqual(
    contiguousReportedSourceBeatIndexes([0], [2], 4),
    [0],
  );
});

test("presence review extends progress only across explicitly reported contiguous beats", () => {
  assert.deepEqual(
    contiguousReportedSourceBeatIndexes([0, 1], [2, 3], 4),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    contiguousReportedSourceBeatIndexes([], [0, 1], 4),
    [0, 1],
  );
});

test("ordered source beats without an immediate player choice use continuation", () => {
  const npcBeatEvent = {
    eventId: "free_scarecrow",
    description: "Dorothy frees the Scarecrow.",
    chapterPosition: 0,
    requiresExplicitPlayerChoice: false,
    currentlyAbsentCharacters: [],
    beats: [{
      actor: "Dorothy",
      action: "Lifts the Scarecrow off the pole and sets him on the ground.",
      agency: "intentional" as const,
      stakes: "critical" as const,
    }],
  };

  assert.equal(
    shouldUseAutomaticOrderedSourceContinuation(npcBeatEvent, false),
    true,
  );
  assert.equal(
    shouldUseAutomaticOrderedSourceContinuation(npcBeatEvent, true),
    false,
  );
  assert.equal(
    shouldUseAutomaticOrderedSourceContinuation(null, false),
    false,
  );
});

test("opening boundary reaches the first player beat behind intentional NPC beats", () => {
  const event = {
    eventId: "cyclone",
    description: "The cyclone approaches the farmhouse.",
    chapterPosition: 0,
    beats: [
      {
        actor: null,
        action: "The wind rises around the farmhouse.",
        targets: [],
        agency: "external" as const,
        stakes: "significant" as const,
        sourceReferences: [],
      },
      {
        actor: "Uncle Henry",
        action: "Warns Aunt Em about the approaching cyclone.",
        targets: ["Aunt Em"],
        agency: "intentional" as const,
        stakes: "critical" as const,
        sourceReferences: [],
      },
      {
        actor: "Uncle Henry",
        action: "Runs toward the sheds.",
        targets: [],
        agency: "intentional" as const,
        stakes: "significant" as const,
        sourceReferences: [],
      },
      {
        actor: "Toto",
        action: "Jumps from Dorothy's arms and hides under the bed.",
        targets: [],
        agency: "intentional" as const,
        stakes: "significant" as const,
        sourceReferences: [],
      },
    ],
  };

  assert.equal(
    sourceEventFirstPlayerChoiceBeatIndex(event, "Toto", []),
    3,
  );
  // The normal immediate-choice helper still refuses to skip those NPC
  // prerequisites. Opening generation must complete them in prose first.
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(event, "Toto", []),
    false,
  );

  const remainingAtDecision = buildSourceEventChoiceBeatState(event, {
    eventId: "cyclone",
    completedBeatIndexes: [0, 1, 2],
  }).remainingEvent;
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      remainingAtDecision,
      "Toto",
      [],
    ),
    true,
  );
  const optionOne = buildRequiredPlayerChoiceFallback(
    remainingAtDecision,
    "Toto",
    [],
  );
  assert.equal(optionOne?.text, "Jump from Dorothy's arms and hide under the bed");
  assert.equal(optionOne?.sourceAnchorRoute, "event");
});

test("stored progress prevents completed player beats from forcing another explicit choice", () => {
  const event = {
    eventId: "free_scarecrow",
    description: "Dorothy discovers and frees the Scarecrow.",
    chapterPosition: 0,
    beats: [
      {
        actor: "Scarecrow",
        action: "Winks and nods from the pole.",
        targets: ["Dorothy"],
        agency: "intentional" as const,
        stakes: "significant" as const,
        sourceReferences: [],
      },
      {
        actor: "Scarecrow",
        action: "Tells Dorothy the pole is stuck in his back.",
        targets: ["Dorothy"],
        agency: "intentional" as const,
        stakes: "significant" as const,
        sourceReferences: [],
      },
      {
        actor: "Dorothy",
        action: "Lifts the Scarecrow off the pole and sets him on the ground.",
        targets: ["Scarecrow"],
        agency: "intentional" as const,
        stakes: "critical" as const,
        sourceReferences: [],
      },
    ],
  };
  const remainingEvent = buildSourceEventChoiceBeatState(event, {
    eventId: "free_scarecrow",
    completedBeatIndexes: [0, 1],
  }).remainingEvent;

  assert.deepEqual(
    remainingEvent?.beats?.map((beat) => beat.action),
    ["Lifts the Scarecrow off the pole and sets him on the ground."],
  );
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      remainingEvent,
      "Scarecrow",
      [],
    ),
    false,
  );
});

test("automatic continuation is inserted before normal local alternatives", () => {
  const scene = addSourceContinuationAnchorChoice({
    title: "On the Road",
    text: "The road remains open in front of me.",
    outcome: "active",
    outcomeReason: "The journey continues.",
    choices: [
      {
        id: "look_around",
        type: "action",
        text: "Look around",
        stakes: "routine",
      },
      {
        id: "talk_to_dorothy",
        type: "talk",
        text: "Talk to Dorothy",
        character: "Dorothy",
        stakes: "routine",
      },
    ],
  }, "And events move forward");

  assert.equal(scene.choices.length, 3);
  assert.equal(scene.choices[0]?.text, "And events move forward");
  assert.equal(scene.choices[1]?.text, "Look around");
  assert.equal(scene.choices[2]?.text, "Talk to Dorothy");
});
