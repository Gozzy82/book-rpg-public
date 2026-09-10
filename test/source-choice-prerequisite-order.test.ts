import assert from "node:assert/strict";
import test from "node:test";
import type { CharacterProfile, StoryEventBeat } from "../src/shared/contracts.js";
import {
  buildRequiredPlayerChoiceFallback,
  sourceEventNextPlayerChoiceBeats,
  type SourceChoiceNavigationEvent,
} from "../src/ai/engine/source-navigation.js";

const dorothyProfile: CharacterProfile = {
  name: "Dorothy",
  aliases: ["girl"],
  role: "Kansas child",
  description: "",
  traits: [],
  relationships: [],
  storyArc: "",
};

function beat(
  actor: string | null,
  action: string,
  agency: StoryEventBeat["agency"],
  stakes: StoryEventBeat["stakes"],
): StoryEventBeat {
  return {
    actor,
    action,
    targets: [],
    agency,
    stakes,
    sourceReferences: [{
      chapterPosition: 4,
      chapterIndex: 4,
      lineStart: 1,
      lineEnd: 1,
    }],
  };
}

const event: SourceChoiceNavigationEvent = {
  eventId: "event_arrival_context",
  description: "Dorothy arrives in Oz and reacts to learning what happened.",
  chapterPosition: 4,
  actors: ["Witch of the North", "Dorothy"],
  targets: ["Dorothy"],
  beats: [
    beat(
      null,
      "The farmhouse lands and the storm becomes still.",
      "external",
      "significant",
    ),
    beat(
      "Witch of the North",
      "Explains that Dorothy's house killed the Wicked Witch of the East.",
      "intentional",
      "significant",
    ),
    beat(
      "Dorothy",
      "Denies killing anyone and explains that she was carried from Kansas by a cyclone.",
      "intentional",
      "significant",
    ),
  ],
};

test("does not expose a later player beat while earlier source prerequisites remain", () => {
  assert.deepEqual(
    sourceEventNextPlayerChoiceBeats(event, "Dorothy", [dorothyProfile]),
    [],
  );

  assert.equal(
    buildRequiredPlayerChoiceFallback(
      event,
      "Dorothy",
      [dorothyProfile],
      {
        currentLocation: "Cyclone-borne farmhouse",
        peoplePresent: ["Dorothy"],
        peopleWithinSpeakingDistance: ["Dorothy"],
      },
    ),
    undefined,
  );
});

test("exposes the player beat once preceding source beats have been completed", () => {
  const remainingEvent: SourceChoiceNavigationEvent = {
    ...event,
    beats: event.beats!.slice(2),
  };

  assert.deepEqual(
    sourceEventNextPlayerChoiceBeats(
      remainingEvent,
      "Dorothy",
      [dorothyProfile],
    ).map((sourceBeat) => sourceBeat.action),
    [
      "Denies killing anyone and explains that she was carried from Kansas by a cyclone.",
    ],
  );

  const fallback = buildRequiredPlayerChoiceFallback(
    remainingEvent,
    "Dorothy",
    [dorothyProfile],
    {
      currentLocation: "Munchkinland beside the farmhouse",
      peoplePresent: ["Dorothy", "Witch of the North"],
      peopleWithinSpeakingDistance: ["Dorothy", "Witch of the North"],
    },
  );

  assert.ok(fallback);
  assert.match(fallback.text, /^Deny killing anyone/);
});
