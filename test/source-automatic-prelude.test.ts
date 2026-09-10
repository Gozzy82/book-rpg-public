import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_GROUNDING_RULES,
} from "../src/ai/engine/rules.js";
import {
  buildGameContext,
} from "../src/ai/engine/scene-context.js";
import {
  attachCharacterSignificantEvents,
} from "../src/books/source-index/character-events.js";
import {
  buildBookStoryEvents,
} from "../src/books/source-index/story-events.js";
import {
  buildCanonicalNextEventCandidate,
} from "../src/games/service/source-candidates.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
} from "../src/shared/contracts.js";
import type {
  GameState,
  ImportedBook,
  StoryEventBeat,
} from "../src/shared/contracts.js";

type IndexedStoryEventBeat = StoryEventBeat & {
  automaticPreludeSourceExcerpt?: string;
};

const lines = Array.from({ length: 84 }, (_, index) => `Line ${index + 1}`);

const book: ImportedBook = {
  bookId: "oz",
  sourceSha256: "sha256",
  title: "The Wonderful Wizard of Oz",
  importedAt: "2026-09-08T00:00:00.000Z",
  chapters: [{
    index: 3,
    title: "The Cyclone",
    text: lines.join("\n"),
    sourceIndex: {
      schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
      summary: "The cyclone carries Dorothy's house away.",
      characters: [],
      actions: [],
      relationships: [],
      significantEvents: [{
        description: "Dorothy and Toto are carried away in the cyclone.",
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 3,
          lineStart: 63,
          lineEnd: 84,
        }],
        beats: [
          {
            actor: null,
            action: "The house spins, rises through the air, and is carried far from Kansas by the cyclone.",
            targets: [],
            agency: "external",
            stakes: "critical",
            sourceReferences: [{
              chapterPosition: 0,
              chapterIndex: 3,
              lineStart: 63,
              lineEnd: 71,
            }],
          },
          {
            actor: "Dorothy",
            action: "Rides inside the airborne house and waits through the storm.",
            targets: [],
            agency: "involuntary",
            stakes: "critical",
            sourceReferences: [{
              chapterPosition: 0,
              chapterIndex: 3,
              lineStart: 72,
              lineEnd: 78,
            }],
          },
          {
            actor: "Toto",
            action: "Falls toward the open trap door.",
            targets: [],
            agency: "involuntary",
            stakes: "significant",
            sourceReferences: [{
              chapterPosition: 0,
              chapterIndex: 3,
              lineStart: 79,
              lineEnd: 81,
            }],
          },
          {
            actor: "Dorothy",
            action: "Pulls Toto back into the room and closes the trap door.",
            targets: ["Toto"],
            agency: "intentional",
            stakes: "significant",
            sourceReferences: [{
              chapterPosition: 0,
              chapterIndex: 3,
              lineStart: 80,
              lineEnd: 84,
            }],
          },
        ],
      }],
    },
  }],
};

function attachProfiles(bookToAttach: ImportedBook): void {
  bookToAttach.storyEvents = buildBookStoryEvents(bookToAttach);
  bookToAttach.worldBible = {
    characterProfiles: [
      {
        name: "Dorothy",
        aliases: ["Dorothy Gale"],
        role: "",
        description: "",
        traits: [],
        relationships: [],
        actions: [],
        storyArc: "",
        significantEvents: [],
        sourceReferences: [],
      },
      {
        name: "Toto",
        aliases: [],
        role: "",
        description: "",
        traits: [],
        relationships: [],
        actions: [],
        storyArc: "",
        significantEvents: [],
        sourceReferences: [],
      },
    ],
  } as NonNullable<ImportedBook["worldBible"]>;
  attachCharacterSignificantEvents(bookToAttach);
}

test("generic story events do not carry character-specific preludes", () => {
  const [event] = buildBookStoryEvents(book);
  assert.ok(event?.beats);

  for (const beat of event.beats as IndexedStoryEventBeat[]) {
    assert.equal(beat.automaticPreludeSourceExcerpt, undefined);
    assert.equal("automaticPreludeSourceReferences" in beat, false);
  }
});

test("character significant events add preludes to that character's intentional and involuntary beats", () => {
  const attachedBook = structuredClone(book);
  attachProfiles(attachedBook);

  const dorothy = attachedBook.worldBible!.characterProfiles.find(
    (profile) => profile.name === "Dorothy",
  )!;
  const toto = attachedBook.worldBible!.characterProfiles.find(
    (profile) => profile.name === "Toto",
  )!;
  const dorothyBeats = dorothy.significantEvents![0]!.beats as IndexedStoryEventBeat[];
  const totoBeats = toto.significantEvents![0]!.beats as IndexedStoryEventBeat[];

  assert.equal(dorothyBeats[0]!.automaticPreludeSourceExcerpt, undefined);
  assert.equal(
    dorothyBeats[1]!.automaticPreludeSourceExcerpt,
    lines.slice(62, 71).join("\n"),
  );
  assert.equal(dorothyBeats[2]!.automaticPreludeSourceExcerpt, undefined);
  assert.equal(
    dorothyBeats[3]!.automaticPreludeSourceExcerpt,
    lines.slice(62, 81).join("\n"),
  );

  assert.equal(totoBeats[0]!.automaticPreludeSourceExcerpt, undefined);
  assert.equal(totoBeats[1]!.automaticPreludeSourceExcerpt, undefined);
  assert.equal(
    totoBeats[2]!.automaticPreludeSourceExcerpt,
    lines.slice(62, 78).join("\n"),
  );
  assert.equal(totoBeats[3]!.automaticPreludeSourceExcerpt, undefined);
});

test("production canonical source candidate carries involuntary character prelude into next_required_beat", () => {
  const attachedBook = structuredClone(book);
  attachProfiles(attachedBook);

  const candidate = buildCanonicalNextEventCandidate(
    attachedBook,
    { chapterPosition: 0, textOffset: 0 },
    "Dorothy",
  );
  assert.ok(candidate);
  const requiredBeat = candidate.requiredEventBeats?.[1] as IndexedStoryEventBeat;
  assert.equal(requiredBeat.agency, "involuntary");
  assert.equal(
    requiredBeat.automaticPreludeSourceExcerpt,
    lines.slice(62, 71).join("\n"),
  );

  const state = {
    book: { bookId: "oz", title: "The Wonderful Wizard of Oz" },
    playerName: "Dorothy",
    characterProfiles: attachedBook.worldBible!.characterProfiles,
    parameters: [],
    gameProfile: {
      category: "adventure",
      description: "Adventure",
      endingMode: "open_ended",
    },
    objective: "Survive the cyclone.",
    victoryCondition: "",
    status: "active",
    selectedText: "Kansas farm",
    history: [],
    sourceEventProgress: {
      eventId: candidate.requiredEventId,
      completedBeatIndexes: [0],
    },
    sourceIntroducedCharacters: ["Dorothy", "Toto"],
    scene: {
      title: "The Cyclone",
      text: "The house is already airborne in the storm.",
      choices: [],
      sceneScope: {
        currentLocation: "Airborne farmhouse",
        peoplePresent: ["Dorothy", "Toto"],
        peopleWithinSpeakingDistance: ["Dorothy", "Toto"],
      },
    },
  } as unknown as GameState;

  const context = JSON.parse(buildGameContext(state, [candidate]));
  assert.equal(
    context.next_significant_event_progress.next_required_beat.agency,
    "involuntary",
  );
  assert.equal(
    context.next_significant_event_progress.next_required_beat.automaticPreludeSourceExcerpt,
    lines.slice(62, 71).join("\n"),
  );
  assert.equal(
    context.next_significant_event_progress.next_required_beat.sourceReferencesExcerpt,
    lines.slice(71, 78).join("\n"),
  );
});

test("production canonical source candidate also preserves intentional character prelude", () => {
  const attachedBook = structuredClone(book);
  attachProfiles(attachedBook);

  const candidate = buildCanonicalNextEventCandidate(
    attachedBook,
    { chapterPosition: 0, textOffset: 0 },
    "Dorothy",
  );
  assert.ok(candidate);
  const requiredBeat = candidate.requiredEventBeats?.[3] as IndexedStoryEventBeat;
  assert.equal(requiredBeat.agency, "intentional");
  assert.equal(
    requiredBeat.automaticPreludeSourceExcerpt,
    lines.slice(62, 81).join("\n"),
  );

  const state = {
    book: { bookId: "oz", title: "The Wonderful Wizard of Oz" },
    playerName: "Dorothy",
    characterProfiles: attachedBook.worldBible!.characterProfiles,
    parameters: [],
    gameProfile: {
      category: "adventure",
      description: "Adventure",
      endingMode: "open_ended",
    },
    objective: "Survive the cyclone.",
    victoryCondition: "",
    status: "active",
    selectedText: "Kansas farm",
    history: [],
    sourceEventProgress: {
      eventId: candidate.requiredEventId,
      completedBeatIndexes: [0, 1, 2],
    },
    sourceIntroducedCharacters: ["Dorothy", "Toto"],
    scene: {
      title: "The Cyclone",
      text: "Toto slips toward the open trap door.",
      choices: [],
      sceneScope: {
        currentLocation: "Airborne farmhouse",
        peoplePresent: ["Dorothy", "Toto"],
        peopleWithinSpeakingDistance: ["Dorothy", "Toto"],
      },
    },
  } as unknown as GameState;

  const context = JSON.parse(buildGameContext(state, [candidate]));
  assert.equal(
    context.next_significant_event_progress.next_required_beat.automaticPreludeSourceExcerpt,
    lines.slice(62, 81).join("\n"),
  );
  assert.equal(
    context.next_significant_event_progress.next_required_beat.sourceReferencesExcerpt,
    lines.slice(79, 84).join("\n"),
  );
});

test("automatic prelude source is historical context and must not be replayed", () => {
  const rules = SOURCE_GROUNDING_RULES.join("\n");

  assert.match(rules, /automaticPreludeSourceExcerpt.*already-established causal source context/i);
  assert.match(rules, /never replay, re-perform, or present events from automaticPreludeSourceExcerpt/i);
  assert.match(rules, /continue from their resulting state/i);
  assert.match(rules, /leave next_required_beat as the action that is now pending/i);
});
