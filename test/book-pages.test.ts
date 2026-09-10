import assert from "node:assert/strict";
import test from "node:test";
import { countBookPages, getBookPage } from "../src/books/pages.js";
import type { ImportedBook } from "../src/shared/contracts.js";

function numberedWords(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(" ");
}

const book: Pick<ImportedBook, "chapters"> = {
  chapters: [
    {
      index: 4,
      title: "Opening",
      text: numberedWords("opening-", 301),
    },
    {
      index: 9,
      title: "Later",
      text: numberedWords("later-", 600),
    },
    {
      index: 10,
      title: "Empty section",
      text: " \n\t ",
    },
  ],
};

test("virtual book pages contain at most 300 words and restart at chapter boundaries", () => {
  assert.equal(countBookPages(book), 4);

  const firstPage = getBookPage(book, 1);
  assert.equal(firstPage?.text.split(" ").length, 300);
  assert.equal(firstPage?.text.startsWith("opening-1 "), true);
  assert.equal(firstPage?.text.endsWith(" opening-300"), true);

  const secondPage = getBookPage(book, 2);
  assert.deepEqual(secondPage, {
    pageNumber: 2,
    pageCount: 4,
    chapterPosition: 0,
    chapterTitle: "Opening",
    text: "opening-301",
  });

  const thirdPage = getBookPage(book, 3);
  assert.equal(thirdPage?.chapterPosition, 1);
  assert.equal(thirdPage?.chapterTitle, "Later");
  assert.equal(thirdPage?.text.startsWith("later-1 "), true);
});

test("virtual page text normalizes whitespace for exact passage matching", () => {
  const page = getBookPage({
    chapters: [{ index: 0, title: "Spacing", text: "alpha\n\n beta\tgamma" }],
  }, 1);

  assert.equal(page?.text, "alpha beta gamma");
});

test("invalid virtual page numbers are rejected", () => {
  assert.equal(getBookPage(book, 0), undefined);
  assert.equal(getBookPage(book, 5), undefined);
  assert.equal(getBookPage(book, 1.5), undefined);
  assert.equal(getBookPage(book, Number.MAX_SAFE_INTEGER + 1), undefined);
});
