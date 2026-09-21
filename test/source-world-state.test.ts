import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalNextEventCandidate,
  sourceEventInvalidatingActors,
  sourceWorldStateForGame,
} from "../src/games/service/source-candidates.js";
import type {
  BookStoryEvent,
  CharacterProfile,
  GameState,
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

const storyEvents: BookStoryEvent[] = [
  event(
    "event_start",
    0,
    "Scarecrow starts along the road.",
    ["Scarecrow"],
    [],
    [beat("Scarecrow", "Starts along the road.")],
  ),
  event(
    "event_dorothy",
    1,
    "Dorothy asks Scarecrow what they should do next.",
    ["Dorothy", "Scarecrow"],
    ["Scarecrow"],
    [
      beat("Dorothy", "Asks Scarecrow what they should do next.", ["Scarecrow"]),
      beat("Scarecrow", "Answers Dorothy.", ["Dorothy"]),
    ],
  ),
  event(
    "event_tin",
    2,
    "Tin Woodman warns Scarecrow about the road ahead.",
    ["Tin Woodman", "Scarecrow"],
    ["Scarecrow"],
    [beat("Tin Woodman", "Warns Scarecrow about the road ahead.", ["Scarecrow"])],
  ),
];

function book(): ImportedBook {
  return {
    bookId: "oz",
    sourceSha256: "source",
    title: "The Wonderful Wizard of Oz",
    chapters: [{
      index: 0,
      title: "The Road",
      text: "Scarecrow starts along the road. Dorothy speaks. Tin Woodman warns him.",
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

function game(): GameState {
  return {
    gameId: "game_test",
    book: { bookId: "oz", title: "The Wonderful Wizard of Oz" },
    characterProfiles: profiles,
    playerName: "Scarecrow",
    gameProfile: {
      category: "adventure",
      endingMode: "open_ended",
      description: "test",
    },
    objective: "Continue the journey",
    victoryCondition: "Keep going",
    status: "active",
    selectedText: "Scarecrow starts along the road.",
    sourceCursor: {
      chapterPosition: 0,
      textOffset: 0,
      eventId: "event_start",
    },
    storyMemory: {
      summary: "Scarecrow killed Dorothy. Dorothy is dead.",
      openThreads: [],
      canonFacts: ["Dorothy is dead after Scarecrow killed her."],
    },
    scene: {
      title: "After Dorothy's death",
      text: "Dorothy lies dead beside the road.",
      choices: [],
    },
    history: [],
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

test("AI-confirmed death becomes irreversible source world state", () => {
  const current = game();
  current.confirmedDeadCharacters = ["Dorothy"];
  const state = sourceWorldStateForGame(
    current,
    book(),
    current.sourceCursor!,
  );

  assert.ok(state.irreversiblyUnavailableCharacterIdentities.includes("dorothy"));
  assert.ok(state.irreversiblyUnavailableCharacterIdentities.includes("dorothygale"));
});

test("Dorothy's denial followed by a greeting does not establish her death", () => {
  const currentGame = game();
  currentGame.storyMemory = {
    summary: "Dorothy is in Oz.",
    openThreads: [],
    canonFacts: [
      "Dorothy denied killing anyone",
      "Witch of the North greeted Dorothy and offered guidance toward Emerald City",
    ],
  };
  currentGame.scene.text = "Dorothy listens beside Toto.";
  const worldState = sourceWorldStateForGame(currentGame, book(), currentGame.sourceCursor!);
  assert.deepEqual(worldState.irreversiblyUnavailableCharacterIdentities, []);
  assert.equal(
    buildCanonicalNextEventCandidate(book(), currentGame.sourceCursor!, "Scarecrow", worldState)?.requiredEventId,
    "event_dorothy",
  );
});

test("death detection does not mistake a later participant or a victim's owner for the victim", () => {
  for (const text of [
    "The house killed the witch and freed Dorothy",
    "The witch was killed by Dorothy",
    "The monster killed Dorothy's companion",
    "The monster killed\nDorothy escaped",
  ]) {
    const currentGame = game();
    currentGame.storyMemory = { summary: text, openThreads: [], canonFacts: [] };
    currentGame.scene.text = "Dorothy walks along the road.";
    assert.deepEqual(
      sourceWorldStateForGame(currentGame, book(), currentGame.sourceCursor!)
        .irreversiblyUnavailableCharacterIdentities,
      [],
      text,
    );
  }
});

test("structured victim identity becomes unavailable without scanning the death sentence", () => {
  const currentGame = game();
  currentGame.confirmedDeadCharacters = ["Dorothy"];
  currentGame.storyMemory = {
    summary: "The monster killed Dorothy Gale.", openThreads: [], canonFacts: [],
  };
  currentGame.scene.text = "The road falls silent.";
  assert.deepEqual(
    sourceWorldStateForGame(currentGame, book(), currentGame.sourceCursor!)
      .irreversiblyUnavailableCharacterIdentities.sort(),
    ["dorothy", "dorothygale"],
  );
});

test("canonical navigation skips a future event that requires a dead actor", () => {
  const currentGame = game();
  currentGame.confirmedDeadCharacters = ["Dorothy"];
  const currentBook = book();
  const worldState = sourceWorldStateForGame(
    currentGame,
    currentBook,
    currentGame.sourceCursor!,
  );

  const candidate = buildCanonicalNextEventCandidate(
    currentBook,
    currentGame.sourceCursor!,
    currentGame.playerName,
    worldState,
  );

  assert.equal(candidate?.requiredEventId, "event_tin");
  assert.deepEqual(
    candidate?.storyEvents?.map((item) => item.eventId),
    ["event_tin"],
  );
});

test("a dead target does not invalidate an event performed by a living actor", () => {
  const worldState = {
    irreversiblyUnavailableCharacterIdentities: ["dorothy"],
  };
  const inspectBody = event(
    "event_body",
    3,
    "Tin Woodman examines Dorothy's body.",
    ["Tin Woodman"],
    ["Dorothy"],
    [beat("Tin Woodman", "Examines Dorothy's body.", ["Dorothy"])],
  );

  assert.deepEqual(sourceEventInvalidatingActors(inspectBody, worldState), []);
});

test("completed dead-actor beats do not invalidate later living-actor beats", () => {
  const mixedEvent = event(
    "event_mixed",
    4,
    "Dorothy speaks before Scarecrow acts.",
    ["Dorothy", "Scarecrow"],
    [],
    [
      beat("Dorothy", "Calls out to Scarecrow.", ["Scarecrow"]),
      beat("Scarecrow", "Walks on alone."),
    ],
  );
  const worldState = {
    irreversiblyUnavailableCharacterIdentities: ["dorothy"],
    sourceEventProgress: {
      eventId: "event_mixed",
      completedBeatIndexes: [0],
    },
  };

  assert.deepEqual(sourceEventInvalidatingActors(mixedEvent, worldState), []);
});

test("an unavailable actor in a remaining required beat invalidates the event", () => {
  const mixedEvent = event(
    "event_mixed",
    4,
    "Scarecrow acts before Dorothy must answer.",
    ["Scarecrow", "Dorothy"],
    [],
    [
      beat("Scarecrow", "Calls out to Dorothy.", ["Dorothy"]),
      beat("Dorothy", "Answers Scarecrow.", ["Scarecrow"]),
    ],
  );
  const worldState = {
    irreversiblyUnavailableCharacterIdentities: ["dorothy"],
    sourceEventProgress: {
      eventId: "event_mixed",
      completedBeatIndexes: [0],
    },
  };

  assert.deepEqual(
    sourceEventInvalidatingActors(mixedEvent, worldState),
    ["Dorothy"],
  );
});


test("unreviewed prose, including actual-looking death text, never infers death", () => {
  for (const text of [
    "Oz would not send her home unless she first killed the Wicked Witch of the West.",
    "Dorothy is dead.", "The monster killed Dorothy.", "Dorothy might die.",
  ]) {
    const current = game();
    current.scene.text = text;
    assert.deepEqual(sourceWorldStateForGame(current, book(), current.sourceCursor!).irreversiblyUnavailableCharacterIdentities, []);
  }
});
