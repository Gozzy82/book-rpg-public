import assert from "node:assert/strict";
import test from "node:test";
import type { CharacterProfile, StoryEventBeat } from "../src/shared/contracts.js";
import {
  buildRequiredPlayerChoiceFallback,
  buildSourceEventChoiceBeatState,
  sourceEventNextPlayerChoiceBeats,
  sourceEventRequiresExplicitPlayerChoice,
  type SourceChoiceNavigationEvent,
} from "../src/ai/engine/source-navigation.js";

const profiles: CharacterProfile[] = [
  {
    name: "Scarecrow",
    aliases: ["the Scarecrow", "Wise Scarecrow"],
    role: "",
    description: "",
    traits: [],
    relationships: [],
    storyArc: "",
  },
  {
    name: "Dorothy",
    aliases: ["girl"],
    role: "",
    description: "",
    traits: [],
    relationships: [],
    storyArc: "",
  },
];

function beat(
  actor: string,
  action: string,
  agency: StoryEventBeat["agency"] = "intentional",
  stakes: StoryEventBeat["stakes"] = "significant",
): StoryEventBeat {
  return {
    actor,
    action,
    targets: [],
    agency,
    stakes,
    sourceReferences: [],
  };
}

const openingEvent: SourceChoiceNavigationEvent = {
  eventId: "event_scarecrow_opening",
  description: "Dorothy discovers and frees the Scarecrow.",
  chapterPosition: 5,
  actors: ["Scarecrow", "Dorothy"],
  beats: [
    beat("Scarecrow", "Winks and nods at Dorothy from his pole."),
    beat("Scarecrow", "Asks Dorothy to remove the pole from his back."),
    beat("Dorothy", "Lifts the Scarecrow off the pole.", "intentional", "critical"),
    beat("Scarecrow", "Explains that he wants Oz to give him brains."),
    beat("Dorothy", "Invites the Scarecrow to travel with her.", "intentional", "critical"),
    beat("Scarecrow", "Accepts Dorothy's invitation and joins the journey.", "intentional", "critical"),
  ],
};

test("Scarecrow opening exposes only the immediate player source beat", () => {
  assert.deepEqual(
    sourceEventNextPlayerChoiceBeats(openingEvent, "Scarecrow", profiles)
      .map((candidate) => candidate.action),
    ["Winks and nods at Dorothy from his pole."],
  );
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      openingEvent,
      "Scarecrow",
      profiles,
      {
        currentLocation: "Cornfield",
        peoplePresent: ["Scarecrow", "Dorothy"],
        peopleWithinSpeakingDistance: ["Scarecrow", "Dorothy"],
      },
    ),
    true,
  );
});

test("automatic bridge beats may precede only one immediate player source beat", () => {
  const bridgedEvent: SourceChoiceNavigationEvent = {
    ...openingEvent,
    beats: [
      beat("Scarecrow", "Stumbles when the road breaks beneath him.", "involuntary", "routine"),
      beat("Scarecrow", "Winks and nods at Dorothy from his pole."),
      beat("Scarecrow", "Asks Dorothy to remove the pole from his back."),
    ],
  };
  assert.deepEqual(
    sourceEventNextPlayerChoiceBeats(bridgedEvent, "Scarecrow", profiles)
      .map((candidate) => candidate.action),
    ["Winks and nods at Dorothy from his pole."],
  );
});

test("completed brains disclosure is never offered again as the next Scarecrow beat", () => {
  const stateAfterTurnThree = buildSourceEventChoiceBeatState(openingEvent, {
    eventId: openingEvent.eventId,
    completedBeatIndexes: [0, 1, 2, 3, 4],
  });
  assert.deepEqual(
    sourceEventNextPlayerChoiceBeats(
      stateAfterTurnThree.remainingEvent,
      "Scarecrow",
      profiles,
    ).map((candidate) => candidate.action),
    ["Accepts Dorothy's invitation and joins the journey."],
  );
});

test("required fallback never bundles the following Scarecrow beat", () => {
  const fallback = buildRequiredPlayerChoiceFallback(
    openingEvent,
    "Scarecrow",
    profiles,
    {
      currentLocation: "Cornfield",
      peoplePresent: ["Scarecrow", "Dorothy"],
      peopleWithinSpeakingDistance: ["Scarecrow", "Dorothy"],
    },
  );

  assert.ok(fallback);
  assert.match(fallback.text, /^Wink and nod at Dorothy from my pole$/u);
  assert.doesNotMatch(fallback.text, /remove the pole|brains|invitation/iu);
  assert.equal(fallback.sourceAnchorRoute, "event");
  assert.deepEqual(fallback.requiredPresentCharacters, ["Dorothy"]);
});