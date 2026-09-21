import assert from "node:assert/strict";
import test from "node:test";

import {
  chapterSourceIndexSchema,
} from "../src/books/analyze/batching.js";
import {
  CHAPTER_SOURCE_INDEX_INSTRUCTIONS,
} from "../src/books/analyze/requests.js";
import {
  mergeChapterPartSourceIndexes,
  parseChapterPartSourceIndex,
} from "../src/books/source-index/chapter-index.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
} from "../src/shared/contracts.js";

const part = {
  sourceId: "chapter_1_part_1",
  chapterPosition: 0,
  chapterIndex: 3,
  chapterTitle: "The Cyclone",
  partIndex: 0,
  partCount: 1,
  lineStart: 1,
  lineEnd: 2,
  text: "Aunt Em descends into the cellar.\nDorothy catches Toto and starts across the room.",
};

test("chapter source schema requires resultingState for every generated beat", () => {
  const schema = chapterSourceIndexSchema([part]) as any;
  const beatSchema = schema.properties.chapter_1_part_1
    .properties.significantEvents.items.properties.beats.items;

  assert.ok(beatSchema.required.includes("resultingState"));
  assert.equal(beatSchema.properties.resultingState.type, "string");
});

test("chapter indexing instructions keep resultingState source-bounded", () => {
  const instructions = CHAPTER_SOURCE_INDEX_INSTRUCTIONS.join("\n");

  assert.match(instructions, /For every beat, also write resultingState/i);
  assert.match(instructions, /first identify the complete ordered sequence/);
  assert.match(instructions, /POSTCONDITION AUDIT/);
  assert.match(instructions, /LOOKAHEAD COMPATIBILITY/);
  assert.match(instructions, /prerequisite for a later beat may be established by an intervening beat/);
  assert.match(instructions, /Dorothy starting retrieval is the next intentional beat/);
  assert.match(instructions, /immediately after that beat has completed and before the next beat starts/i);
  assert.match(instructions, /whether a destination has or has not yet been reached/i);
  assert.match(instructions, /catch ends with Toto held, before movement toward the cellar/i);
});

test("parsed and merged source beats preserve resultingState", () => {
  const parsed = parseChapterPartSourceIndex({
    summary: "Aunt Em enters the cellar before Dorothy starts after her.",
    significantEvents: [{
      description: "The family moves toward the cyclone cellar.",
      beats: [{
        actor: "Aunt Em",
        action: "Climbs down into the cyclone cellar.",
        resultingState: "Aunt Em is inside the cyclone cellar; Dorothy and Toto remain in the farmhouse room and the trapdoor is open.",
        targets: [],
        agency: "intentional",
        stakes: "significant",
        references: [{ lineStart: 1, lineEnd: 1 }],
      }, {
        actor: "Dorothy",
        action: "Catches Toto and starts across the room toward the cellar.",
        resultingState: "Dorothy is carrying Toto partway across the farmhouse room toward the open trapdoor; she has not reached the cellar.",
        targets: ["Toto", "Aunt Em"],
        agency: "intentional",
        stakes: "significant",
        references: [{ lineStart: 2, lineEnd: 2 }],
      }],
      references: [{ lineStart: 1, lineEnd: 2 }],
    }],
    characters: [
      { name: "Aunt Em", aliases: [], references: [{ lineStart: 1, lineEnd: 1 }] },
      { name: "Dorothy", aliases: [], references: [{ lineStart: 2, lineEnd: 2 }] },
      { name: "Toto", aliases: [], references: [{ lineStart: 2, lineEnd: 2 }] },
    ],
    actions: [],
    relationships: [],
  }, {
    sourceId: part.sourceId,
    chapterIndex: part.chapterIndex,
    lineStart: part.lineStart,
    lineEnd: part.lineEnd,
    sourceText: part.text,
  });

  assert.match(parsed.significantEvents[0]!.beats[1]!.resultingState ?? "", /has not reached the cellar/);

  const merged = mergeChapterPartSourceIndexes(0, 3, parsed.summary, [parsed]);
  assert.equal(merged.schemaVersion, CHAPTER_SOURCE_INDEX_VERSION);
  assert.match(
    merged.significantEvents?.[0]?.beats?.[1]?.resultingState ?? "",
    /partway across the farmhouse room/,
  );
});

test("legacy parser input without resultingState remains readable but does not invent one", () => {
  const parsed = parseChapterPartSourceIndex({
    summary: "A legacy beat.",
    significantEvents: [{
      description: "Dorothy moves.",
      beats: [{
        actor: "Dorothy",
        action: "Moves across the room.",
        targets: [],
        agency: "intentional",
        stakes: "routine",
        references: [{ lineStart: 2, lineEnd: 2 }],
      }],
      references: [{ lineStart: 2, lineEnd: 2 }],
    }],
    characters: [
      { name: "Dorothy", aliases: [], references: [{ lineStart: 2, lineEnd: 2 }] },
    ],
    actions: [],
    relationships: [],
  }, {
    sourceId: part.sourceId,
    chapterIndex: part.chapterIndex,
    lineStart: part.lineStart,
    lineEnd: part.lineEnd,
    sourceText: part.text,
  });

  assert.equal(parsed.significantEvents[0]!.beats[0]!.resultingState, undefined);
});
test("a missing immediate prelude checkpoint does not reuse an older potentially stale state", async () => {
  const { sourcePreludeEndStateForBeat } = await import("../src/books/source-index/story-events.js");
  const beats = [{resultingState: "The door is open."}, {action: "The door changes."}, {action: "The next choice."}] as any;
  assert.equal(sourcePreludeEndStateForBeat(beats, 2), undefined);
});

