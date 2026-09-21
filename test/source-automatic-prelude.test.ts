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
  automaticPreludeEndState?: string;
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
            resultingState: "The farmhouse is airborne inside the cyclone with Dorothy and Toto still in the room.",
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
            resultingState: "Dorothy remains seated inside the airborne farmhouse while Toto moves around the room.",
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
            resultingState: "Toto is suspended at the open trapdoor while Dorothy remains inside the farmhouse room.",
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
            resultingState: "Toto is safely back in the room with Dorothy and the trapdoor is closed.",
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

test("generic story events keep indexed resulting states without character-specific preludes", () => {
  const [event] = buildBookStoryEvents(book);
  assert.ok(event?.beats);

  assert.equal(
    event.beats[0]?.resultingState,
    "The farmhouse is airborne inside the cyclone with Dorothy and Toto still in the room.",
  );
  for (const beat of event.beats as IndexedStoryEventBeat[]) {
    assert.equal(beat.automaticPreludeSourceExcerpt, undefined);
    assert.equal(beat.automaticPreludeEndState, undefined);
    assert.equal("automaticPreludeSourceReferences" in beat, false);
  }
});

test("character significant events preserve beat resultingState and add prelude end state only to that character's beats", () => {
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

  assert.equal(
    dorothyBeats[1]!.resultingState,
    "Dorothy remains seated inside the airborne farmhouse while Toto moves around the room.",
  );
  assert.equal(
    dorothyBeats[3]!.resultingState,
    "Toto is safely back in the room with Dorothy and the trapdoor is closed.",
  );
  assert.equal(
    totoBeats[2]!.resultingState,
    "Toto is suspended at the open trapdoor while Dorothy remains inside the farmhouse room.",
  );

  assert.equal(dorothyBeats[0]!.automaticPreludeSourceExcerpt, undefined);
  assert.equal(dorothyBeats[0]!.automaticPreludeEndState, undefined);
  assert.equal(
    dorothyBeats[1]!.automaticPreludeSourceExcerpt,
    lines.slice(62, 71).join("\n"),
  );
  assert.equal(
    dorothyBeats[1]!.automaticPreludeEndState,
    "The farmhouse is airborne inside the cyclone with Dorothy and Toto still in the room.",
  );
  assert.equal(dorothyBeats[2]!.automaticPreludeSourceExcerpt, undefined);
  assert.equal(dorothyBeats[2]!.automaticPreludeEndState, undefined);
  assert.equal(
    dorothyBeats[3]!.automaticPreludeSourceExcerpt,
    lines.slice(62, 79).join("\n"),
  );
  assert.equal(
    dorothyBeats[3]!.automaticPreludeEndState,
    "Toto is suspended at the open trapdoor while Dorothy remains inside the farmhouse room.",
  );

  assert.equal(totoBeats[0]!.automaticPreludeSourceExcerpt, undefined);
  assert.equal(totoBeats[1]!.automaticPreludeSourceExcerpt, undefined);
  assert.equal(
    totoBeats[2]!.automaticPreludeSourceExcerpt,
    lines.slice(62, 78).join("\n"),
  );
  assert.equal(
    totoBeats[2]!.automaticPreludeEndState,
    "Dorothy remains seated inside the airborne farmhouse while Toto moves around the room.",
  );
  assert.equal(totoBeats[3]!.automaticPreludeSourceExcerpt, undefined);
  assert.equal(totoBeats[3]!.automaticPreludeEndState, undefined);
});

test("production canonical source candidate carries character pre-state and post-state into next_required_beat", () => {
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
  assert.equal(
    requiredBeat.automaticPreludeEndState,
    "The farmhouse is airborne inside the cyclone with Dorothy and Toto still in the room.",
  );
  assert.equal(
    requiredBeat.resultingState,
    "Dorothy remains seated inside the airborne farmhouse while Toto moves around the room.",
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
    context.next_significant_event_progress.next_required_beat.automaticPreludeEndState,
    "The farmhouse is airborne inside the cyclone with Dorothy and Toto still in the room.",
  );
  assert.equal(
    context.next_significant_event_progress.next_required_beat.resultingState,
    "Dorothy remains seated inside the airborne farmhouse while Toto moves around the room.",
  );
  assert.equal(
    context.next_significant_event_progress.next_required_beat.sourceReferencesExcerpt,
    lines.slice(71, 78).join("\n"),
  );
});

test("production canonical source candidate also preserves intentional character pre-state and post-state", () => {
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
    lines.slice(62, 79).join("\n"),
  );
  assert.equal(
    requiredBeat.automaticPreludeEndState,
    "Toto is suspended at the open trapdoor while Dorothy remains inside the farmhouse room.",
  );
  assert.equal(
    requiredBeat.resultingState,
    "Toto is safely back in the room with Dorothy and the trapdoor is closed.",
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
    lines.slice(62, 79).join("\n"),
  );
  assert.equal(
    context.next_significant_event_progress.next_required_beat.automaticPreludeEndState,
    "Toto is suspended at the open trapdoor while Dorothy remains inside the farmhouse room.",
  );
  assert.equal(
    context.next_significant_event_progress.next_required_beat.resultingState,
    "Toto is safely back in the room with Dorothy and the trapdoor is closed.",
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

