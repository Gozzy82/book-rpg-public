import assert from "node:assert/strict";
import { parseWorldBibleOutput } from "../src/books/source-index/profiles.js";
import { filterSceneScope } from "../src/ai/engine/scene-validation.js";
import test from "node:test";
import {
  requestChapterSourceIndexes,
} from "../src/books/analyze/requests.js";
import {
  resolveCharacterIdentities,
} from "../src/books/analyze/identity.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
} from "../src/shared/contracts.js";
import type {
  ImportedBook,
} from "../src/shared/contracts.js";

test("chapter index prompt limits aliases to stable identity labels", async () => {
  let instructions = "";
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{
      index: 0,
      title: "One",
      text: "Dorothy enters.",
    }],
    importedAt: "2026-01-01T00:00:00.000Z",
  };

  await requestChapterSourceIndexes(
    async (request) => {
      instructions = String(request.instructions ?? "");
      return {
        output_text: JSON.stringify({
          chapter_1_part_1: {
            summary: "Dorothy enters.",
            significantEvents: [],
            characters: [{
              name: "Dorothy",
              aliases: [],
              references: [{ lineStart: 1, lineEnd: 1 }],
            }],
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
      chapterTitle: "One",
      partIndex: 0,
      partCount: 1,
      lineStart: 1,
      lineEnd: 1,
      text: "Dorothy enters.",
    }],
    1,
    1,
    new Map(),
  );

  assert.match(instructions, /stable name-like identity labels/i);
  assert.match(instructions, /source-backed shortened name/i);
  assert.match(instructions, /standalone identifier/i);
  assert.match(instructions, /form of address is not an alias merely because/i);
  assert.match(instructions, /mistaken belief, assumption, praise, insult/i);
  assert.match(instructions, /when uncertain, omit the alias/i);
  assert.match(instructions, /adaptations, films, sequels/i);
});

test("identity verification preserves a source-backed shortened character name", async () => {
  const reference = {
    chapterPosition: 0,
    chapterIndex: 0,
    lineStart: 1,
    lineEnd: 2,
  };
  const book: ImportedBook = {
    bookId: "short-alias",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{
      index: 0,
      title: "One",
      text: "The Cowardly Lion stepped forward.\nThe Lion roared at the road.",
      summary: "The Cowardly Lion steps forward and roars.",
      sourceIndex: {
        schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
        summary: "The Cowardly Lion steps forward and roars.",
        significantEvents: [],
        characters: [{
          name: "Cowardly Lion",
          aliases: ["Lion"],
          sourceReferences: [reference],
        }],
        actions: [],
        relationships: [],
      },
    }],
    importedAt: "2026-01-01T00:00:00.000Z",
  };

  const resolutions = await resolveCharacterIdentities(
    book,
    async () => ({
      output_text: JSON.stringify({
        identity_1: {
          decision: "same_person",
          confidence: 0.99,
          evidenceReferenceIndexes: [0, 1],
        },
      }),
      status: "completed",
    }),
    "test-model",
    () => undefined,
  );

  assert.equal(resolutions[0]?.decision, "same_person");
  assert.deepEqual(
    book.chapters[0]?.sourceIndex?.characters[0]?.aliases,
    ["Lion"],
  );
});

test("identity verification treats descriptive titles as non-aliases", async () => {
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{
      index: 0,
      title: "One",
      text: "Dorothy was called a noble Sorceress.",
      summary: "Dorothy is called a sorceress.",
      sourceIndex: {
        schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
        summary: "Dorothy is called a sorceress.",
        significantEvents: [],
        characters: [{
          name: "Dorothy",
          aliases: ["Sorceress"],
          sourceReferences: [{
            chapterPosition: 0,
            chapterIndex: 0,
            lineStart: 1,
            lineEnd: 1,
          }],
        }],
        actions: [],
        relationships: [],
      },
    }],
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  let instructions = "";

  const resolutions = await resolveCharacterIdentities(
    book,
    async (request) => {
      instructions = String(request.instructions ?? "");
      return {
        output_text: JSON.stringify({
          identity_1: {
            decision: "uncertain",
            confidence: 0.99,
            evidenceReferenceIndexes: [0],
          },
        }),
        status: "completed",
      };
    },
    "test-model",
    () => undefined,
  );

  assert.match(instructions, /safe identity-alias pair/i);
  assert.match(instructions, /explicit source evidence linking their identities/i);
  assert.match(instructions, /sorceress/i);
  assert.match(instructions, /choose uncertain rather than same_person/i);
  assert.equal(resolutions[0]?.decision, "uncertain");
  assert.deepEqual(book.chapters[0]?.sourceIndex?.characters[0]?.aliases, []);
});

for (const decision of ["different_people", "uncertain"] as const) {
  test(`re-indexing keeps the northern witch separate from Glinda when identity is ${decision}`, () => {
    const reference = { chapterPosition: 0, chapterIndex: 0, lineStart: 1, lineEnd: 1 };
    const names = ["Glinda", "Witch of the North"];
    const book: ImportedBook = {
      bookId: "oz-identities",
      title: "The Wonderful Wizard of Oz",
      sourceSha256: "sha",
      importedAt: "2026-09-08T00:00:00Z",
      chapters: [{
        index: 0,
        title: "Witches",
        text: "The Witch of the North welcomes Dorothy. Glinda rules in the South.",
        sourceIndex: {
          schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
          summary: "Two distinct witches.",
          characters: names.map((name) => ({ name, aliases: [], sourceReferences: [reference] })),
          significantEvents: [],
          actions: [],
          relationships: [],
        },
      }],
    };
    const bible = parseWorldBibleOutput(JSON.stringify({
      summary: "Two witches help Dorothy at different stages of her journey.",
      characterProfiles: names.map((name) => ({
        name,
        aliases: name === "Glinda" ? ["Witch of the North"] : [],
        role: "Witch",
        description: name,
        traits: ["helpful"],
        storyArc: "Helps Dorothy.",
      })),
      locations: [],
    }), book, [{
      canonicalName: "Glinda",
      alias: "Witch of the North",
      decision,
      confidence: 0.99,
      sourceReferences: [reference],
    }]);
    assert.deepEqual(bible.characterProfiles?.find((p) => p.name === "Glinda")?.aliases, []);
    assert.ok(bible.characterProfiles?.some((p) => p.name === "Witch of the North"));
    const scope = filterSceneScope({
      currentLocation: "Farmhouse doorway",
      peoplePresent: ["Witch of the North"],
      peopleWithinSpeakingDistance: ["Witch of the North"],
    }, { knownCharacterProfiles: bible.characterProfiles });
    assert.deepEqual(scope.peoplePresent, ["Witch of the North"]);
    assert.deepEqual(scope.peopleWithinSpeakingDistance, ["Witch of the North"]);
  });
}
