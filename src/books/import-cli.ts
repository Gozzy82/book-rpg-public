import fs from "node:fs/promises";
import { createImportRun } from "./analyze/import-run.js";
import { resumeAcceptedSourceReview } from "./analyze/resume-source-review.js";
import path from "node:path";
import { importCharacterAnchors, SharedRouteGap, queueSharedRouteRepair } from "./analyze/character-anchor-import.js";
import { configuredIndexModel } from "../ai/provider.js";
import { analyzeBook } from "./analyze.js";
import {
  enrichCharacterProfilesWithDynamics,
  hasCompleteCharacterDynamics,
} from "./analyze/character-dynamics.js";
import { createDefaultResponse } from "./analyze/identity.js";
import { readEpub } from "./epub.js";
import { parseImportArguments } from "./import-options.js";
import {
  exportKindleAnalysisCheckpoint,
  exportKindlePackage,
} from "./kindle-package.js";
import { getBook, saveBook } from "./repository.js";
import {
  isReusableChapterSourceIndex,
} from "./source-index/reuse.js";
import { dataDir, loadAiApiKey, loadDotEnv } from "../util/env.js";
import {
  WORLD_BIBLE_SCHEMA_VERSION,
} from "../shared/contracts.js";

loadDotEnv();
loadAiApiKey();

let filePath: string;
let reanalyze: boolean;
let characters: string[] | undefined;
let sourceReview: string | undefined;
try {
  ({ filePath, reanalyze, characters, sourceReview } = parseImportArguments(process.argv.slice(2)));
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
    const retainedCast = characters ?? existingBook.characterAnchors?.playableCharacters ?? existingBook.anchorImport?.playableCharacters;
    if (retainedCast?.length) book.anchorImport = {version: 1, playableCharacters: retainedCast, events: {}};
    console.error(
      "Reanalyzing chapter source indexes and whole-book character index;"
      + " previously saved analysis will not be reused...",
    );
    await saveBook(book);
    console.error(
      "Cleared previously saved analysis; new chapter checkpoints can now be resumed without --reanalyze.",
    );
  } else {
    book.importAnalysis = existingBook.importAnalysis;
    book.anchorImport = existingBook.anchorImport;
    book.characterAnchors = existingBook.characterAnchors;
    book.chapters = book.chapters.map((chapter, index) => {
      const existingChapter = existingBook.chapters[index];
      // Older indexes are retained only as candidates for the new source audit.
      const previousSourceIndex = existingChapter?.sourceIndex;
      return existingChapter?.summary || previousSourceIndex
        ? {
            ...chapter,
            summary: existingChapter?.summary,
            ...(previousSourceIndex ? { sourceIndex: previousSourceIndex } : {}),
          }
        : chapter;
    });
    book.worldBible = existingBook.worldBible;
  }
}
if (sourceReview) {
  if (fakeAi) throw new Error("--source-review cannot be used with BOOKRPG_FAKE_AI");
  const resumed = await resumeAcceptedSourceReview(book, sourceReview);
  await saveBook(book);
  console.error("Resuming accepted source review: " + JSON.stringify(resumed));
}
if (fakeAi) {
  console.error("Skipping AI book analysis because BOOKRPG_FAKE_AI=1.");
} else {
  const runDirectory = path.join(dataDir(), "import-runs", new Date().toISOString().replaceAll(":", "-"));
  await fs.mkdir(runDirectory, {recursive: true});
  const log = (message: string) => {
    console.error(message);
  };
  const run = createImportRun(createDefaultResponse(), {
    maxCalls: Number(process.env.BOOKRPG_IMPORT_MAX_CALLS ?? 500),
    maxTokens: Number(process.env.BOOKRPG_IMPORT_MAX_TOKENS ?? 5_000_000),
    log, record: async event => {await fs.appendFile(path.join(runDirectory, "calls.jsonl"), JSON.stringify(event) + "\n");},
  });
  console.error("Import run: " + runDirectory);
  try {
  // An in-progress extraction must not expose a stale runtime projection as approved.
  book.anchorImport ??= {version: 1, playableCharacters: characters ?? book.characterAnchors?.playableCharacters ?? [], events: {}};
  delete book.characterAnchors;
  await saveBook(book);
  for (let sourcePass = 0; sourcePass < 2; sourcePass++) {
    const analysis = await analyzeBook(book, {
      sharedEventsOnly: true, createResponse: run.provider,
      saveStageProgress: async () => { await saveBook(book); },
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

    if (book.worldBible && !hasCompleteCharacterDynamics(book.worldBible)) {
      book.worldBible = await enrichCharacterProfilesWithDynamics(
        book,
        book.worldBible,
        run.provider,
        configuredIndexModel(),
        console.error,
      );
      await saveBook(book);
      await exportKindleAnalysisCheckpoint(book);
    }

    try {
      await importCharacterAnchors(book, run.provider, configuredIndexModel(), {
        characters, save: async () => { await saveBook(book); },
      });
      break;
    } catch (error) {
      if (!(error instanceof SharedRouteGap) || sourcePass === 1) throw error;
      console.error(`Repairing shared source evidence once: ${error.message}`);
      queueSharedRouteRepair(book, error);
      await saveBook(book);
    }
  }
  } catch (error) {
    await saveBook(book);
    await fs.writeFile(path.join(runDirectory, "error.json"), JSON.stringify({message: error instanceof Error ? error.message : String(error),
      ...run.stats, limits: run.limits, resume: "Run import again without --reanalyze or --source-review"}, null, 2));
    throw error;
  } finally {
    await fs.writeFile(path.join(runDirectory, "usage.json"), JSON.stringify({...run.stats, limits: run.limits}, null, 2));
  }
}
await saveBook(book);
const kindlePackage = (
  book.worldBible?.schemaVersion === WORLD_BIBLE_SCHEMA_VERSION
  && book.chapters.every((chapter) =>
    isReusableChapterSourceIndex(chapter.sourceIndex)
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
  playableCharacters: book.characterAnchors?.playableCharacters ?? [],
  anchorRoutes: book.characterAnchors?.routes.length ?? 0,
  indexedCharacters: book.worldBible?.characterProfiles?.length ?? 0,
  characterDynamics: book.worldBible?.characterProfiles?.filter(
    (profile) => Boolean(profile.dynamics),
  ).length ?? 0,
  summarized: Boolean(book.worldBible?.summary),
  kindlePackage,
}, null, 2));


