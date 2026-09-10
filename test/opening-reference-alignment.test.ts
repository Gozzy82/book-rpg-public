import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalGameStartContext,
  firstNarrativeStoryEventForPlayer,
} from "../src/games/service/game-start.js";
import type { BookStoryEvent, ImportedBook, SourceReference } from "../src/shared/contracts.js";

const ref = (chapterPosition: number, lineStart: number, lineEnd = lineStart): SourceReference =>
  ({ chapterPosition, chapterIndex: chapterPosition, lineStart, lineEnd });

function event(sequence: number, chapterPosition: number, actors: string[], targets: string[], reference: SourceReference): BookStoryEvent {
  return {
    eventId: `event_${sequence}`, sequence, chapterPosition, actors, targets,
    category: "other", description: `Event ${sequence}`,
    sourceReferences: [reference],
  };
}

function book(): ImportedBook {
  // Reduced from the supplied Oz index: Oz is first mentioned in chapter 4,
  // discussed as Great Oz in chapter 7, and acts in the throne room in chapter 13.
  return {
    bookId: "oz", title: "Oz", sourceSha256: "test", importedAt: "2026-09-08",
    chapters: Array.from({ length: 14 }, (_, index) => ({
      index, title: `Chapter ${index}`, text: "A narrative line.\n".repeat(180),
    })),
    worldBible: {
      summary: "", characters: ["Oz", "Toto"], locations: [],
      characterProfiles: [
        { name: "Oz", aliases: ["Great Oz"], role: "", description: "", traits: [], relationships: [], storyArc: "",
          sourceReferences: [ref(4, 101, 104), ref(7, 67, 78), ref(13, 116, 167)] },
        { name: "Toto", aliases: [], role: "", description: "", traits: [], relationships: [], storyArc: "",
          sourceReferences: [ref(3, 36, 40), ref(3, 57, 91)] },
      ],
    },
    storyEvents: [
      event(1, 3, ["Dorothy"], ["Toto"], ref(3, 45, 62)),
      event(2, 3, ["Toto", "Dorothy"], [], ref(3, 63, 91)),
      event(18, 7, ["Tin Woodman"], ["Great Oz"], ref(7, 98, 153)),
      event(19, 7, ["Scarecrow", "Tin Woodman"], ["Great Oz"], ref(7, 154, 165)),
      event(45, 13, ["Dorothy", "Oz"], ["Dorothy", "Oz"], ref(13, 116, 143)),
    ],
  };
}

test("Oz starts at his acting event rather than an unrelated later mention as a target", () => {
  for (const identity of ["Oz", "Great Oz"]) {
    const start = canonicalGameStartContext(book(), identity);
    assert.equal(start.candidate.currentStoryEvent?.eventId, "event_45");
    assert.equal(start.sourceCursor.chapterPosition, 13);
    assert.equal(start.candidate.storyEvents?.[0]?.eventId, "event_45");
  }
});

test("a source-referenced passive participant keeps its earlier opening", () => {
  assert.equal(firstNarrativeStoryEventForPlayer(book(), "Toto")?.eventId, "event_1");
});

test("actor roles remain usable when character references do not cover the acting event", () => {
  const value = book();
  value.worldBible!.characterProfiles![0]!.sourceReferences = [ref(4, 101, 104)];
  assert.equal(firstNarrativeStoryEventForPlayer(value, "Oz")?.eventId, "event_45");
});

test("legacy target-only indexes without character references keep their fallback", () => {
  const value = book();
  value.worldBible!.characterProfiles![1]!.sourceReferences = [];
  value.storyEvents = value.storyEvents!.filter(e => e.eventId === "event_1");
  assert.equal(firstNarrativeStoryEventForPlayer(value, "Toto")?.eventId, "event_1");
});
