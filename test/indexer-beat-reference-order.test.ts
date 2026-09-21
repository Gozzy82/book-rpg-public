import assert from "node:assert/strict";
import test from "node:test";
import {
  validateStoryEventBeatReferenceOrder,
} from "../src/books/analyze/output.js";
import type {
  ChapterPartSourceIndex,
} from "../src/books/source-index.js";

function indexWithBeatRanges(
  ranges: Array<[number, number]>,
): ChapterPartSourceIndex {
  return {
    summary: "Cyclone approaches the farmhouse.",
    characters: [],
    actions: [],
    relationships: [],
    significantEvents: [{
      description: "The family reacts to the cyclone.",
      actors: [],
      targets: [],
      beats: ranges.map(([lineStart, lineEnd], index) => ({
        actor: index === 1 ? "Toto" : "Aunt Em",
        action: `Beat ${index}`,
        targets: [],
        agency: "intentional" as const,
        stakes: "significant" as const,
        references: [{
          lineStart,
          lineEnd,
        }],
      })),
      references: [{
        lineStart: Math.min(...ranges.map(([start]) => start)),
        lineEnd: Math.max(...ranges.map(([, end]) => end)),
      }],
    }],
  };
}

test("rejects a spanning earlier beat when later evidence continues beyond it", () => {
  const index = indexWithBeatRanges([
    [54, 59],
    [57, 58],
    [58, 60],
  ]);

  assert.throws(
    () => validateStoryEventBeatReferenceOrder(index),
    /beat 0 source range 54-59 spans intervening beat 1 range 57-58/i,
  );
});

test("allows a nested later beat when there is no evidence of interleaving past the earlier beat", () => {
  const index = indexWithBeatRanges([
    [63, 67],
    [65, 67],
  ]);

  assert.doesNotThrow(() => validateStoryEventBeatReferenceOrder(index));
});

test("accepts chronological overlapping edge ranges that do not contain a later beat", () => {
  const index = indexWithBeatRanges([
    [54, 56],
    [57, 58],
    [58, 60],
  ]);

  assert.doesNotThrow(() => validateStoryEventBeatReferenceOrder(index));
});

test("allows identical source ranges for genuinely simultaneous atomic beats", () => {
  const index = indexWithBeatRanges([
    [57, 57],
    [57, 57],
  ]);

  assert.doesNotThrow(() => validateStoryEventBeatReferenceOrder(index));
});



test("allows successive actions sharing the earlier beat's final source line", () => {
  const index = indexWithBeatRanges([[18, 20], [20, 20], [20, 21]]);
  index.significantEvents[0]!.beats[0]!.action = "Explains the route, finishing on line 20";
  index.significantEvents[0]!.beats[1]!.action = "Acknowledges the explanation later on line 20";
  index.significantEvents[0]!.beats[2]!.action = "Sets off after the acknowledgement";
  assert.doesNotThrow(() => validateStoryEventBeatReferenceOrder(index));
});

test("equal endpoints do not establish that an earlier beat continues after an intervening action", () => {
  for (const ranges of [
    [[15, 20], [18, 20], [20, 21]],
    [[18, 20], [19, 20], [20, 22]],
  ] as Array<Array<[number, number]>>) {
    assert.doesNotThrow(() => validateStoryEventBeatReferenceOrder(indexWithBeatRanges(ranges)));
  }
});

test("still rejects strictly interior evidence with a later continuation", () => {
  assert.throws(() => validateStoryEventBeatReferenceOrder(indexWithBeatRanges([
    [18, 21], [20, 20], [20, 22],
  ])), /spans intervening beat/);
});
