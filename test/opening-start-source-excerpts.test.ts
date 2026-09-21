import assert from "node:assert/strict";
import test from "node:test";
import { sourceReferenceKey } from "../src/books/source-index/chapter-index.js";
import { canonicalGameStartContext } from "../src/games/service/game-start.js";
import type { ImportedBook, SourceReference } from "../src/shared/contracts.js";

function reference(lineStart: number, lineEnd = lineStart): SourceReference {
  return {
    chapterPosition: 0,
    chapterIndex: 0,
    lineStart,
    lineEnd,
  };
}

test("canonical opening candidate includes exact source excerpts for each opening beat", () => {
  const warning = reference(1);
  const sheds = reference(2);
  const hides = reference(3);
  const follows = reference(4);
  const book = {
    title: "Opening excerpt fixture",
    author: "Fixture",
    chapters: [
      {
        index: 0,
        title: "Chapter One",
        text: [
          "Uncle Henry warns Aunt Em about the cyclone.",
          "Uncle Henry runs toward the sheds.",
          "Toto jumps from Dorothy's arms and hides under the bed.",
          "Dorothy starts after Toto.",
        ].join("\n"),
      },
    ],
    storyEvents: [
      {
        eventId: "event_opening",
        sequence: 1,
        description: "A cyclone approaches the farmhouse.",
        category: "other",
        chapterPosition: 0,
        actors: ["Uncle Henry", "Toto", "Dorothy"],
        targets: ["Aunt Em", "Dorothy"],
        sourceReferences: [warning, sheds, hides, follows],
        beats: [
          {
            actor: "Uncle Henry",
            action: "Warns Aunt Em about the cyclone",
            targets: ["Aunt Em"],
            agency: "intentional",
            stakes: "significant",
            sourceReferences: [warning],
          },
          {
            actor: "Uncle Henry",
            action: "Runs toward the sheds",
            targets: [],
            agency: "intentional",
            stakes: "significant",
            sourceReferences: [sheds],
          },
          {
            actor: "Toto",
            action: "Jumps from Dorothy's arms and hides under the bed",
            targets: [],
            agency: "involuntary",
            stakes: "significant",
            sourceReferences: [hides],
          },
          {
            actor: "Dorothy",
            action: "Starts after Toto",
            targets: ["Toto"],
            agency: "intentional",
            stakes: "significant",
            sourceReferences: [follows],
          },
        ],
      },
    ],
  } as unknown as ImportedBook;

  const candidate = canonicalGameStartContext(book, "Dorothy").candidate;

  assert.equal(
    candidate.sourceReferenceExcerpts?.[sourceReferenceKey(warning)],
    "Uncle Henry warns Aunt Em about the cyclone.",
  );
  assert.equal(
    candidate.sourceReferenceExcerpts?.[sourceReferenceKey(sheds)],
    "Uncle Henry runs toward the sheds.",
  );
  assert.equal(
    candidate.sourceReferenceExcerpts?.[sourceReferenceKey(hides)],
    "Toto jumps from Dorothy's arms and hides under the bed.",
  );
  assert.equal(
    candidate.sourceReferenceExcerpts?.[sourceReferenceKey(follows)],
    "Dorothy starts after Toto.",
  );
});
