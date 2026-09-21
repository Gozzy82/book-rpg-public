import test from "node:test";
import assert from "node:assert/strict";
import { createAnchorProbeBook, attachAnchorProbeIdentities } from "../src/books/analyze/anchor-probe-book.js";
import { selectAnchorCharacters } from "../src/books/analyze/character-anchor-import.js";
import { CHAPTER_SOURCE_INDEX_VERSION, type ImportedBook, type CharacterProfile } from "../src/shared/contracts.js";

const original: ImportedBook = {bookId: "oz", sourceSha256: "hash", title: "Oz", importedAt: "now", chapters: [{index: 3, title: "Cyclone", text: "Dorothy catches Toto."}]};
function reviewed() {
  const book = createAnchorProbeBook(original, "oz", 1);
  book.chapters[0]!.sourceIndex = {schemaVersion: CHAPTER_SOURCE_INDEX_VERSION, extractionMode: "shared_events_v1", summary: "Dorothy catches Toto.",
    significantEvents: [], actions: [], relationships: [], characters: ["Dorothy", "Toto"].map(name => ({name, aliases: [], sourceReferences: [{chapterIndex: 3, chapterPosition: 0, lineStart: 1, lineEnd: 1}]}))};
  return book;
}
const noCall = async (): Promise<never> => {throw new Error("Explicit probe identities need no extra AI call");};

test("an interrupted import without worldBible can probe source-reviewed Dorothy and Toto", async () => {
  const snapshot = structuredClone(original);
  const book = reviewed();
  attachAnchorProbeIdentities(book);
  assert.deepEqual(await selectAnchorCharacters(book, noCall, "test", ["Dorothy", "Toto"]), ["Dorothy", "Toto"]);
  assert.deepEqual(original, snapshot);
  assert.equal(original.worldBible, undefined);
  assert.equal(book.worldBible!.schemaVersion, undefined);
});

test("probe keeps known aliases but never invents a requested actor absent from the reviewed chapter", async () => {
  const book = reviewed();
  attachAnchorProbeIdentities(book, [{name: "Dorothy Gale", aliases: ["Dorothy"]} as CharacterProfile]);
  assert.deepEqual(await selectAnchorCharacters(book, noCall, "test", ["Dorothy"]), ["Dorothy Gale"]);
  await assert.rejects(selectAnchorCharacters(book, noCall, "test", ["Lion"]), /Unknown or ambiguous/);
  assert.throws(() => attachAnchorProbeIdentities(createAnchorProbeBook(original, "oz", 1)), /Review the probe source/);
});

test("missing book, missing chapter and missing text have distinct diagnostics", () => {
  assert.throws(() => createAnchorProbeBook(undefined, "missing", 1), /Book missing was not found/);
  assert.throws(() => createAnchorProbeBook(original, "oz", 4), /Chapter position 4 does not exist/);
  assert.throws(() => createAnchorProbeBook({...original, chapters: [{index: 0, title: "Empty", text: " "}]}, "oz", 1), /has no source text/);
});
