import assert from "node:assert/strict";
import test from "node:test";

import {
  sourceEventPlayerChoiceBeats,
  sourceEventRequiresExplicitPlayerChoice,
} from "../src/ai/engine/source-navigation.js";
import {
  resolveSourceEventActorTakeover,
} from "../src/games/service/source-event-takeover.js";
import {
  buildCanonicalNextEventCandidate,
} from "../src/games/service/source-candidates.js";
import type {
  BookStoryEvent,
  CharacterProfile,
  ImportedBook,
  StoryEventBeat,
} from "../src/shared/contracts.js";

function beat(
  actor: string | null,
  action: string,
  targets: string[] = [],
): StoryEventBeat {
  return {
    actor,
    action,
    targets,
    agency: actor ? "intentional" : "external",
    stakes: "significant",
    sourceReferences: [],
  };
}

function event(
  eventId: string,
  sequence: number,
  description: string,
  actors: string[],
  targets: string[],
  beats?: StoryEventBeat[],
): BookStoryEvent {
  return {
    eventId,
    sequence,
    description,
    category: "other",
    chapterPosition: 0,
    actors,
    targets,
    ...(beats ? { beats } : {}),
    sourceReferences: [],
  };
}

function profile(name: string, aliases: string[] = []): CharacterProfile {
  return {
    name,
    aliases,
    role: "character",
    description: name,
    traits: [],
    relationships: [],
    storyArc: "",
  };
}

const profiles = [
  profile("Scarecrow"),
  profile("Dorothy", ["Dorothy Gale"]),
  profile("Tin Woodman", ["Tin Man"]),
];

function book(storyEvents: BookStoryEvent[]): ImportedBook {
  return {
    bookId: "oz-takeover",
    sourceSha256: "source",
    title: "The Wonderful Wizard of Oz",
    chapters: [{
      index: 0,
      title: "The Road",
      text: "Scarecrow starts. Dorothy opens the gate. The journey continues.",
    }],
    storyEvents,
    worldBible: {
      summary: "Oz",
      characters: profiles.map((item) => item.name),
      characterProfiles: profiles,
      locations: [],
    },
    importedAt: "2026-09-05T00:00:00.000Z",
  };
}

const dorothyDead = {
  irreversiblyUnavailableCharacterIdentities: ["dorothy", "dorothygale"],
};

test("player takes over a future beat when actor-target direction remains valid", () => {
  const sourceEvent = event(
    "event_gate",
    1,
    "Dorothy opens the gate for Tin Woodman.",
    ["Dorothy"],
    ["Tin Woodman"],
    [beat("Dorothy", "Opens the gate for Tin Woodman.", ["Tin Woodman"])],
  );

  const resolution = resolveSourceEventActorTakeover(
    sourceEvent,
    book([sourceEvent]),
    "Scarecrow",
    dorothyDead,
  );

  assert.deepEqual(resolution.invalidatingActors, []);
  assert.deepEqual(resolution.takeovers, [{
    beatIndex: 0,
    fromActor: "Dorothy",
    toActor: "Scarecrow",
    action: "Opens the gate for Tin Woodman.",
  }]);
  assert.deepEqual(resolution.event.actors, ["Scarecrow"]);
  assert.equal(resolution.event.beats?.[0]?.actor, "Scarecrow");
  assert.equal(
    resolution.event.beats?.[0]?.action,
    "Opens the gate for Tin Woodman.",
  );
  assert.equal(
    sourceEventPlayerChoiceBeats(resolution.event, "Scarecrow", profiles).length,
    1,
  );
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      resolution.event,
      "Scarecrow",
      profiles,
    ),
    true,
  );
});

test("player does not take over a beat that would become self-targeted", () => {
  const sourceEvent = event(
    "event_question",
    1,
    "Dorothy asks Scarecrow what to do next.",
    ["Dorothy", "Scarecrow"],
    ["Scarecrow"],
    [beat("Dorothy", "Asks Scarecrow what to do next.", ["Scarecrow"])],
  );

  const resolution = resolveSourceEventActorTakeover(
    sourceEvent,
    book([sourceEvent]),
    "Scarecrow",
    dorothyDead,
  );

  assert.deepEqual(resolution.takeovers, []);
  assert.deepEqual(resolution.invalidatingActors, ["Dorothy"]);
  assert.equal(resolution.event.beats?.[0]?.actor, "Dorothy");
});

test("completed beats keep their original actor and are not reassigned retroactively", () => {
  const sourceEvent = event(
    "event_partial",
    1,
    "Dorothy opens the gate and Scarecrow crosses it.",
    ["Dorothy", "Scarecrow"],
    [],
    [
      beat("Dorothy", "Opens the gate."),
      beat("Scarecrow", "Crosses through the gate."),
    ],
  );

  const resolution = resolveSourceEventActorTakeover(
    sourceEvent,
    book([sourceEvent]),
    "Scarecrow",
    {
      ...dorothyDead,
      sourceEventProgress: {
        eventId: "event_partial",
        completedBeatIndexes: [0],
      },
    },
  );

  assert.deepEqual(resolution.invalidatingActors, []);
  assert.deepEqual(resolution.takeovers, []);
  assert.equal(resolution.event.beats?.[0]?.actor, "Dorothy");
  assert.equal(resolution.event.beats?.[1]?.actor, "Scarecrow");
});

test("canonical navigation inherits an orphaned dead-actor event before later player events", () => {
  const events = [
    event(
      "event_start",
      0,
      "Scarecrow starts along the road.",
      ["Scarecrow"],
      [],
      [beat("Scarecrow", "Starts along the road.")],
    ),
    event(
      "event_gate",
      1,
      "Dorothy opens a gate blocking the road.",
      ["Dorothy"],
      [],
      [beat("Dorothy", "Opens the gate blocking the road.")],
    ),
    event(
      "event_continue",
      2,
      "Scarecrow continues down the road.",
      ["Scarecrow"],
      [],
      [beat("Scarecrow", "Continues down the road.")],
    ),
  ];
  const currentBook = book(events);

  const candidate = buildCanonicalNextEventCandidate(
    currentBook,
    {
      chapterPosition: 0,
      textOffset: 0,
      eventId: "event_start",
    },
    "Scarecrow",
    dorothyDead,
  );

  assert.equal(candidate?.requiredEventId, "event_gate");
  assert.deepEqual(candidate?.requiredEventActors, ["Scarecrow"]);
  assert.equal(candidate?.requiredEventBeats?.[0]?.actor, "Scarecrow");
  assert.deepEqual(
    candidate?.storyEvents?.map((item) => item.eventId),
    ["event_gate", "event_continue"],
  );
});

test("canonical navigation still skips an orphaned event when takeover is impossible", () => {
  const events = [
    event(
      "event_start",
      0,
      "Scarecrow starts along the road.",
      ["Scarecrow"],
      [],
      [beat("Scarecrow", "Starts along the road.")],
    ),
    event(
      "event_question",
      1,
      "Dorothy asks Scarecrow what to do next.",
      ["Dorothy", "Scarecrow"],
      ["Scarecrow"],
      [beat("Dorothy", "Asks Scarecrow what to do next.", ["Scarecrow"])],
    ),
    event(
      "event_continue",
      2,
      "Scarecrow continues down the road.",
      ["Scarecrow"],
      [],
      [beat("Scarecrow", "Continues down the road.")],
    ),
  ];
  const currentBook = book(events);

  const candidate = buildCanonicalNextEventCandidate(
    currentBook,
    {
      chapterPosition: 0,
      textOffset: 0,
      eventId: "event_start",
    },
    "Scarecrow",
    dorothyDead,
  );

  assert.equal(candidate?.requiredEventId, "event_continue");
});
