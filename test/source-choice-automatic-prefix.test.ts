import assert from "node:assert/strict";
import test from "node:test";
import type { CharacterProfile, StoryEventBeat } from "../src/shared/contracts.js";
import {
  sourceEventCanOccurWithoutPlayerChoice,
  sourceEventNextPlayerChoiceBeats,
  sourceEventRequiresExplicitPlayerChoice,
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
      chapterPosition: 3,
      chapterIndex: 3,
      lineStart: 1,
      lineEnd: 1,
    }],
  };
}

function event(beats: StoryEventBeat[]): SourceChoiceNavigationEvent {
  return {
    eventId: "event_test",
    description: "Test event",
    chapterPosition: 3,
    actors: ["Dorothy", "Toto", "Witch of the North"],
    targets: ["Dorothy", "Toto"],
    beats,
  };
}

test("involuntary source beats may bridge to the next meaningful player decision", () => {
  const cycloneEvent = event([
    beat(
      "Dorothy",
      "Rides inside the airborne house and waits through the storm.",
      "involuntary",
      "critical",
    ),
    beat(
      "Toto",
      "Falls toward the open trap door.",
      "involuntary",
      "significant",
    ),
    beat(
      "Dorothy",
      "Pulls Toto back into the room and closes the trap door.",
      "intentional",
      "significant",
    ),
  ]);

  const choices = sourceEventNextPlayerChoiceBeats(
    cycloneEvent,
    "Dorothy",
    [dorothyProfile],
  );
  assert.equal(choices.length, 1);
  assert.match(choices[0]!.action, /^Pulls Toto back/);
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      cycloneEvent,
      "Dorothy",
      [dorothyProfile],
    ),
    true,
  );
  assert.equal(
    sourceEventCanOccurWithoutPlayerChoice(
      cycloneEvent,
      "Dorothy",
      [dorothyProfile],
    ),
    false,
  );
});

test("an intentional NPC beat remains a hard boundary before a later player beat", () => {
  const explanationEvent = event([
    beat(
      "Witch of the North",
      "Explains that Dorothy's house killed the Wicked Witch of the East.",
      "intentional",
      "significant",
    ),
    beat(
      "Dorothy",
      "Denies killing anyone and explains that the cyclone carried her from Kansas.",
      "intentional",
      "significant",
    ),
  ]);

  assert.deepEqual(
    sourceEventNextPlayerChoiceBeats(
      explanationEvent,
      "Dorothy",
      [dorothyProfile],
    ),
    [],
  );
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      explanationEvent,
      "Dorothy",
      [dorothyProfile],
    ),
    false,
  );
  assert.equal(
    sourceEventCanOccurWithoutPlayerChoice(
      explanationEvent,
      "Dorothy",
      [dorothyProfile],
    ),
    true,
  );
});
