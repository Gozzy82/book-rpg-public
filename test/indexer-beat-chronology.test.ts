import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAPTER_SOURCE_INDEX_INSTRUCTIONS,
} from "../src/books/analyze/requests.js";

const instructions = CHAPTER_SOURCE_INDEX_INSTRUCTIONS.join("\n");

test("source indexer keeps same-actor actions separate across intervening moments", () => {
  assert.match(instructions, /one contiguous moment in the source/i);
  assert.match(instructions, /same actor.*another beat.*between them/i);
  assert.match(instructions, /Aunt Em drops her work.*Toto hides.*opens the trapdoor/i);
});

test("source indexer requires narrow per-beat references in beat order", () => {
  assert.match(instructions, /narrowest contiguous line range/i);
  assert.match(instructions, /Do not copy a broad event-level range onto every beat/i);
  assert.match(instructions, /ordering of beat source references must agree with the beat array/i);
});
