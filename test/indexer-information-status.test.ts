import assert from "node:assert/strict";
import test from "node:test";
import {
  requestChapterSourceIndexes,
} from "../src/books/analyze/requests.js";
import type {
  ImportedBook,
} from "../src/shared/contracts.js";

test("chapter index prompt preserves whether dialogue contains new or already-known information", async () => {
  let instructions = "";
  const book: ImportedBook = {
    bookId: "oz-information-status",
    sourceSha256: "sha256",
    title: "The Wonderful Wizard of Oz",
    author: "L. Frank Baum",
    chapters: [{
      index: 0,
      title: "How Dorothy Saved the Scarecrow",
      text: "Dorothy explains why she wants to return home and refers to the Scarecrow's lack of brains as the reason he cannot understand her attachment to home.",
    }],
    importedAt: "2026-09-09T00:00:00.000Z",
  };

  await requestChapterSourceIndexes(
    async (request) => {
      instructions = String(request.instructions ?? "");
      return {
        output_text: JSON.stringify({
          chapter_1_part_1: {
            summary: "Dorothy explains why home matters to her.",
            significantEvents: [{
              description: "Dorothy explains her attachment to home to the Scarecrow.",
              beats: [{
                actor: "Dorothy",
                action: "Explains why she wants to return home, referring to the Scarecrow's lack of brains as the reason he cannot understand her attachment.",
                targets: ["Scarecrow"],
                agency: "intentional",
                stakes: "significant",
                references: [{ lineStart: 1, lineEnd: 1 }],
              }],
              references: [{ lineStart: 1, lineEnd: 1 }],
            }],
            characters: [
              {
                name: "Dorothy",
                aliases: [],
                references: [{ lineStart: 1, lineEnd: 1 }],
              },
              {
                name: "Scarecrow",
                aliases: [],
                references: [{ lineStart: 1, lineEnd: 1 }],
              },
            ],
            actions: [],
            relationships: [],
          },
        }),
        status: "completed",
      };
    },
    "test-model",
    book,
    [{
      sourceId: "chapter_1_part_1",
      chapterPosition: 0,
      chapterIndex: 0,
      chapterTitle: "How Dorothy Saved the Scarecrow",
      partIndex: 0,
      partCount: 1,
      lineStart: 1,
      lineEnd: 1,
      text: book.chapters[0]!.text,
    }],
    1,
    1,
    new Map(),
  );

  assert.match(instructions, /Preserve the information status of dialogue and exposition/i);
  assert.match(instructions, /already known, merely referenced, repeated, clarified, explained, challenged, or used as reasoning/i);
  assert.match(instructions, /Never rewrite already-known information as though one character newly tells, reveals, discovers, or teaches it to another/i);
  assert.match(instructions, /Dorothy explains why she wants to return home/i);
  assert.match(instructions, /do not describe her as newly telling Scarecrow that he lacks brains/i);
  assert.match(instructions, /tells, reveals, learns, discovers, realizes, informs, or explains-that only when/i);
});
