import test from "node:test";
import assert from "node:assert/strict";
import type { BookStoryEvent, GameState, ImportedBook, StoryEventBeat } from "../src/shared/contracts.js";
import { buildCanonicalNextEventCandidate, sourceCandidateForKnownEvent } from "../src/games/service/source-candidates.js";

const ref = (line: number) => ({
  chapterPosition: 0,
  chapterIndex: 0,
  lineStart: line,
  lineEnd: line,
});

function beat(
  actor: string | null,
  action: string,
  line: number,
  targets: string[] = [],
): StoryEventBeat {
  return {
    actor,
    action,
    targets,
    agency: actor ? "intentional" : "external",
    stakes: "significant",
    resultingState: `${action} is complete.`,
    sourceReferences: [ref(line)],
  };
}

function event(
  eventId: string,
  sequence: number,
  line: number,
  beats: StoryEventBeat[],
  actors: string[],
  targets: string[] = [],
): BookStoryEvent {
  return {
    eventId,
    sequence,
    description: eventId,
    category: "other",
    chapterPosition: 0,
    actors,
    targets,
    beats,
    sourceReferences: [ref(line)],
  };
}

function book(events: BookStoryEvent[], lines: string[]): ImportedBook {
  return {
    bookId: "cross-event-lookahead",
    title: "Cross-event lookahead",
    sourceSha256: "fixture",
    importedAt: "2026-09-19T00:00:00.000Z",
    chapters: [{index: 0, title: "Chapter", text: lines.join("\n"), summary: ""}],
    storyEvents: events,
    worldBible: {
      summary: "",
      characters: ["Dorothy", "Aunt Em", "Toto"],
      locations: [],
      characterProfiles: [{
        name: "Dorothy",
        aliases: [],
        role: "",
        description: "",
        traits: [],
        relationships: [],
        storyArc: "",
      }],
    },
  };
}

test("canonical candidate looks through NPC-only events to the next player decision", () => {
  const prior = event("prior", 0, 1, [beat("Dorothy", "Waits at the doorway.", 1)], ["Dorothy"]);
  const watch = event("watch", 1, 2, [
    beat("Dorothy", "Watches the darkening sky.", 2),
  ], ["Dorothy"]);
  const warning = event("warning", 2, 3, [
    beat("Aunt Em", "Warns Dorothy about the storm.", 3, ["Dorothy"]),
  ], ["Aunt Em"], ["Dorothy"]);
  const toto = event("toto", 3, 4, [
    beat("Toto", "Hides under the bed.", 4),
    beat("Dorothy", "Starts retrieving Toto.", 5, ["Toto"]),
  ], ["Toto", "Dorothy"], ["Toto"]);
  const fixture = book(
    [prior, watch, warning, toto],
    ["Prior.", "Watch.", "Warning.", "Toto hides.", "Dorothy reaches."],
  );

  const candidate = buildCanonicalNextEventCandidate(
    fixture,
    {chapterPosition: 0, textOffset: "Prior.".length, eventId: prior.eventId},
    "Dorothy",
  );

  assert.equal(candidate?.requiredEventId, watch.eventId);
  assert.deepEqual(
    candidate?.storyEvents?.map((candidateEvent) => candidateEvent.eventId),
    [watch.eventId, warning.eventId, toto.eventId],
  );
  assert.equal(candidate?.storyEvents?.[2]?.beats?.[1]?.actor, "Dorothy");
});

test("known bridge target keeps its exact event while carrying canonical decision lookahead", () => {
  const prior = event("prior", 0, 1, [beat("Dorothy", "Waits at the doorway.", 1)], ["Dorothy"]);
  const target = event("target", 1, 2, [
    beat("Dorothy", "Watches the darkening sky.", 2),
  ], ["Dorothy"]);
  const automatic = event("automatic", 2, 3, [
    beat("Aunt Em", "Warns Dorothy about the storm.", 3, ["Dorothy"]),
  ], ["Aunt Em"], ["Dorothy"]);
  const next = event("next-player", 3, 4, [
    beat("Toto", "Hides under the bed.", 4),
    beat("Dorothy", "Starts retrieving Toto.", 5, ["Toto"]),
  ], ["Toto", "Dorothy"], ["Toto"]);
  const fixture = book(
    [prior, target, automatic, next],
    ["Prior.", "Target.", "Warning.", "Toto hides.", "Dorothy reaches."],
  );
  const game = {
    gameId: "bridge-lookahead",
    book: {bookId: fixture.bookId, title: fixture.title},
    playerName: "Dorothy",
    gameProfile: {category: "adventure", endingMode: "open_ended", description: ""},
    objective: "",
    victoryCondition: "",
    selectedText: "",
    status: "active",
    narrativeMode: "canonical",
    confirmedDeadCharacters: [],
    sourceCursor: {chapterPosition: 0, textOffset: "Prior.".length, eventId: prior.eventId},
    history: [],
    scene: {title: "Doorway", text: "I wait.", choices: []},
    createdAt: "",
    updatedAt: "",
  } as GameState;

  const candidate = sourceCandidateForKnownEvent(fixture, game, target.eventId);

  assert.equal(candidate?.requiredEventId, target.eventId);
  assert.equal(candidate?.requiredEvent, target.description);
  assert.deepEqual(
    candidate?.storyEvents?.map((candidateEvent) => candidateEvent.eventId),
    [target.eventId, automatic.eventId, next.eventId],
  );
  assert.equal(candidate?.storyEvents?.[2]?.beats?.[1]?.actor, "Dorothy");
});

test("canonical decision lookahead stops at an explicit source-entry gap", () => {
  const prior = event("prior", 0, 1, [beat("Dorothy", "Waits.", 1)], ["Dorothy"]);
  const first = event("first", 1, 2, [beat("Dorothy", "Acts.", 2)], ["Dorothy"]);
  // Line 3 is deliberately unindexed transition material between first and second.
  const second = event("second", 2, 4, [
    beat("Aunt Em", "Acts after the transition.", 4, ["Dorothy"]),
  ], ["Aunt Em"], ["Dorothy"]);
  const third = event("third", 3, 5, [
    beat("Dorothy", "Makes the next decision.", 5),
  ], ["Dorothy"]);
  const fixture = book(
    [prior, first, second, third],
    ["Prior.", "First.", "Time passes.", "Second.", "Third."],
  );

  const candidate = buildCanonicalNextEventCandidate(
    fixture,
    {chapterPosition: 0, textOffset: "Prior.".length, eventId: prior.eventId},
    "Dorothy",
  );

  assert.deepEqual(
    candidate?.storyEvents?.map((candidateEvent) => candidateEvent.eventId),
    [first.eventId, second.eventId],
  );
  assert.ok(candidate?.sourceEventEntries?.[second.eventId]);
});

test("canonical decision lookahead is hard-capped", () => {
  const lines = ["Prior."];
  const events: BookStoryEvent[] = [
    event("prior", 0, 1, [beat("Dorothy", "Waits.", 1)], ["Dorothy"]),
  ];
  for (let sequence = 1; sequence <= 10; sequence += 1) {
    lines.push(`NPC ${sequence}.`);
    events.push(event(
      `npc-${sequence}`,
      sequence,
      sequence + 1,
      [beat("Aunt Em", `NPC action ${sequence}.`, sequence + 1, ["Dorothy"])],
      ["Aunt Em"],
      ["Dorothy"],
    ));
  }
  lines.push("Dorothy finally acts.");
  events.push(event(
    "player-late",
    11,
    12,
    [beat("Dorothy", "Finally makes a decision.", 12)],
    ["Dorothy"],
  ));
  const fixture = book(events, lines);

  const candidate = buildCanonicalNextEventCandidate(
    fixture,
    {chapterPosition: 0, textOffset: "Prior.".length, eventId: "prior"},
    "Dorothy",
  );

  assert.equal(candidate?.storyEvents?.length, 8);
  assert.deepEqual(
    candidate?.storyEvents?.map((candidateEvent) => candidateEvent.eventId),
    Array.from({length: 8}, (_value, index) => `npc-${index + 1}`),
  );
});
