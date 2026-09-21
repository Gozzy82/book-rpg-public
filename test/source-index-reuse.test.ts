import assert from "node:assert/strict";
import test from "node:test";

import {
  isReusableChapterSourceIndex,
} from "../src/books/source-index/reuse.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
} from "../src/shared/contracts.js";
import type {
  ChapterSourceIndex,
} from "../src/shared/contracts.js";

function sourceIndexWithBeat(resultingState?: string): ChapterSourceIndex {
  return {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "A chapter summary.",
    significantEvents: [{
      description: "Something happens.",
      sourceReferences: [{
        chapterPosition: 0,
        chapterIndex: 1,
        lineStart: 1,
        lineEnd: 1,
      }],
      beats: [{
        actor: "Dorothy",
        action: "Moves toward the cellar.",
        sourceSemantics: {mode: "present", narratedContent: null, intentionalRole: "meaningful", jointAction: null},
        ...(resultingState === undefined ? {} : { resultingState }),
        targets: [],
        agency: "intentional",
        stakes: "significant",
        playerAction: {id: "action_c0_e0_b0", kind: "player_action", playerBeatIndexes: [0], endBeatIndex: 0,
          choiceText: "Move toward the cellar", completion: "Dorothy is partway across the room.",
          boundaryReason: "The crossing is interrupted", preconditions: ["The path is accessible"], interruptWhen: ["The house shakes"]},
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 1,
          lineStart: 1,
          lineEnd: 1,
        }],
      }],
    }],
    characters: [],
    actions: [],
    relationships: [],
  };
}

test("reuses current chapter source indexes only when every beat has a postcondition", () => {
  assert.equal(
    isReusableChapterSourceIndex(
      sourceIndexWithBeat("Dorothy is partway across the room."),
    ),
    true,
  );
  assert.equal(isReusableChapterSourceIndex(sourceIndexWithBeat()), false);
  assert.equal(isReusableChapterSourceIndex(sourceIndexWithBeat("   ")), false);
});

test("accepts chapters without significant-event beats when the current schema and summary are valid", () => {
  const sourceIndex: ChapterSourceIndex = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "Front matter only.",
    significantEvents: [],
    characters: [],
    actions: [],
    relationships: [],
  };

  assert.equal(isReusableChapterSourceIndex(sourceIndex), true);
});

test("an event without atomic beats cannot masquerade as a complete v7 checkpoint", () => {
  const index = sourceIndexWithBeat("After the action.");
  delete index.significantEvents![0]!.beats;
  assert.equal(isReusableChapterSourceIndex(index), false);
});


test("pre-boundary-audit v7 indexes are rebuilt even when every postcondition is non-empty", () => {
  const oldIndex = {...sourceIndexWithBeat("Toto is under the bed while Dorothy has begun retrieving him."), schemaVersion: 7};
  assert.equal(isReusableChapterSourceIndex(oldIndex as unknown as ChapterSourceIndex), false);
});

