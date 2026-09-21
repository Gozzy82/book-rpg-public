import test from "node:test";
import assert from "node:assert/strict";
import { parseImportArguments } from "../src/books/import-options.js";

test("import arguments keep cached analysis by default", () => {
  assert.deepEqual(
    parseImportArguments(["C:/book/story.epub"]),
    {
      filePath: "C:/book/story.epub",
      reanalyze: false,
    },
  );
});

test("import arguments support --reanalyze before or after the EPUB path", () => {
  assert.deepEqual(
    parseImportArguments(["C:/book/story.epub", "--reanalyze"]),
    {
      filePath: "C:/book/story.epub",
      reanalyze: true,
    },
  );
  assert.deepEqual(
    parseImportArguments(["--reanalyze", "C:/book/story.epub"]),
    {
      filePath: "C:/book/story.epub",
      reanalyze: true,
    },
  );
});

test("import arguments reject unknown options and missing paths", () => {
  assert.throws(
    () => parseImportArguments(["C:/book/story.epub", "--force"]),
    /Unknown option: --force/,
  );
  assert.throws(
    () => parseImportArguments(["--reanalyze"]),
    /Usage: npm run import -- path\/to\/book\.epub \[--reanalyze\]/,
  );
});


test("import accepts one saved source review but cannot discard checkpoints simultaneously", () => {
  assert.equal(parseImportArguments(["book.epub", "--source-review", "result.json"]).sourceReview, "result.json");
  assert.throws(() => parseImportArguments(["book.epub", "--source-review"]));
  assert.throws(() => parseImportArguments(["book.epub", "--source-review", "one", "--source-review", "two"]));
  assert.throws(() => parseImportArguments(["book.epub", "--source-review", "result.json", "--reanalyze"]));
});
