import type { BookPage, ImportedBook } from "../shared/contracts.js";

export const VIRTUAL_PAGE_WORD_COUNT = 300;

type BookText = Pick<ImportedBook, "chapters">;

function countWords(text: string): number {
  const matcher = /\S+/g;
  let count = 0;
  while (matcher.exec(text)) count += 1;
  return count;
}

function chapterPageCount(text: string): number {
  return Math.ceil(countWords(text) / VIRTUAL_PAGE_WORD_COUNT);
}

function extractChapterPage(text: string, pageIndex: number): string {
  const firstWord = pageIndex * VIRTUAL_PAGE_WORD_COUNT;
  const afterLastWord = firstWord + VIRTUAL_PAGE_WORD_COUNT;
  const matcher = /\S+/g;
  let wordIndex = 0;
  let start = -1;
  let end = text.length;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text))) {
    if (wordIndex === firstWord) start = match.index;
    if (wordIndex === afterLastWord) {
      end = match.index;
      break;
    }
    wordIndex += 1;
  }

  if (start < 0) return "";
  return text.slice(start, end).trim().replace(/\s+/g, " ");
}

export function countBookPages(book: BookText): number {
  return book.chapters.reduce(
    (total, chapter) => total + chapterPageCount(chapter.text),
    0,
  );
}

export function getBookPage(book: BookText, pageNumber: number): BookPage | undefined {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return undefined;

  const chapterPageCounts = book.chapters.map((chapter) => chapterPageCount(chapter.text));
  const pageCount = chapterPageCounts.reduce((total, count) => total + count, 0);
  if (pageNumber > pageCount) return undefined;

  let chapterPageNumber = pageNumber;
  for (const [chapterPosition, chapter] of book.chapters.entries()) {
    const pagesInChapter = chapterPageCounts[chapterPosition]!;
    if (chapterPageNumber > pagesInChapter) {
      chapterPageNumber -= pagesInChapter;
      continue;
    }

    return {
      pageNumber,
      pageCount,
      chapterPosition,
      chapterTitle: chapter.title,
      text: extractChapterPage(chapter.text, chapterPageNumber - 1),
    };
  }

  return undefined;
}
