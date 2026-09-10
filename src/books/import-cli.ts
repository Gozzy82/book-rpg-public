import path from "node:path";
import { analyzeBook } from "./analyze.js";
import { readEpub } from "./epub.js";
import { parseImportArguments } from "./import-options.js";
import {
  exportKindleAnalysisCheckpoint,
  exportKindlePackage,
} from "./kindle-package.js";
import { getBook, saveBook } from "./repository.js";
import {
  attachCharacterSignificantEvents,
} from "./source-index/character-events.js";
import { loadAiApiKey, loadDotEnv } from "../util/env.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
  WORLD_BIBLE_SCHEMA_VERSION,
} from "../shared/contracts.js";

loadDotEnv();
loadAiApiKey();

let filePath: string;
let reanalyze: boolean;
try {
  ({ filePath, reanalyze } = parseImportArguments(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const book = readEpub(path.resolve(filePath));
const existingBook = await getBook(book.bookId);
const fakeAi = process.env.BOOKRPG_FAKE_AI === "1";
if (existingBook?.sourceSha256 === book.sourceSha256) {
  book.importedAt = existingBook.importedAt;
  book.gameProfile = existingBook.gameProfile;

  if (reanalyze) {
    console.error(
      "Reanalyzing chapter source indexes and whole-book character index;"
      + " previously saved analysis will not be reused...",
    );
  } else {
    book.chapters = book.chapters.map((chapter, index) => {
      const existingChapter = existingBook.chapters[index];
      return existingChapter?.summary || existingChapter?.sourceIndex
        ? {
            ...chapter,
            summary: existingChapter.summary,
            sourceIndex: existingChapter.sourceIndex,
          }
        : chapter;
    });
    book.worldBible = existingBook.worldBible;
  }
}
if (fakeAi) {
  console.error("Skipping AI book analysis because BOOKRPG_FAKE_AI=1.");
} else {
  const analysis = await analyzeBook(book, {
    saveProgress: async () => {
      await saveBook(book);
      await exportKindleAnalysisCheckpoint(book);
    },
  });
  book.chapters = book.chapters.map((chapter, index) => {
    const summary = analysis.chapterSummaries[index];
    if (!summary) {
      throw new Error(`Missing generated summary for chapter ${index + 1}`);
    }
    return { ...chapter, summary };
  });
  book.worldBible = analysis.worldBible;
  attachCharacterSignificantEvents(book);
}
await saveBook(book);
const kindlePackage = (
  book.worldBible?.schemaVersion === WORLD_BIBLE_SCHEMA_VERSION
  && book.chapters.every(
    (chapter) => chapter.sourceIndex?.schemaVersion === CHAPTER_SOURCE_INDEX_VERSION,
  )
)
  ? await exportKindlePackage(book)
  : undefined;
console.log(JSON.stringify({
  bookId: book.bookId,
  sourceSha256: book.sourceSha256,
  title: book.title,
  author: book.author,
  chapters: book.chapters.length,
  chapterSummaries: book.chapters.filter((chapter) => Boolean(chapter.summary)).length,
  chapterSourceIndexes: book.chapters.filter((chapter) => Boolean(chapter.sourceIndex)).length,
  indexedCharacters: book.worldBible?.characterProfiles?.length ?? 0,
  summarized: Boolean(book.worldBible?.summary),
  kindlePackage,
}, null, 2));
