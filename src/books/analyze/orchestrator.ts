import { ImportRunStopped } from "./import-run.js";
import { requestStagedChapterIndexes } from "./staged-index.js";
import {
  configuredIndexModel,
} from "../../ai/provider.js";
import {
  WORLD_BIBLE_SCHEMA_VERSION,
} from "../../shared/contracts.js";
import type {
  ImportedBook,
} from "../../shared/contracts.js";
import {
  buildVerifiedIdentityResolver,
  mergeChapterPartSourceIndexes,
  buildBookStoryEvents,
  parseWorldBibleOutput,
} from "../source-index.js";
import type {
  ChapterPartSourceIndex,
} from "../source-index.js";
import {
  MAX_SOURCE_CHARS_PER_REQUEST,
  MAX_ANALYSIS_OUTPUT_TOKENS,
  MAX_CHAPTER_SUMMARY_WORDS,
  MAX_WORLD_BIBLE_ATTEMPTS,
  MAX_SUPPLEMENTAL_PROFILE_ATTEMPTS,
  GENERIC_OBSERVED_PROFILE_DESCRIPTION,
  CHARACTER_PROFILE_DESCRIPTION_RULES,
  worldBibleSchema,
  supplementalCharacterProfilesSchema,
  sourceId,
  buildChapterAnalysisBatches,
} from "./batching.js";
import type {
  AnalyzeBookOptions,
  BookAnalysis,
} from "./batching.js";
import {
  requireOutputText,
  mergeSupplementalCharacterProfileOutput,
  formatChapterRange,
} from "./output.js";
import {
  createDefaultResponse,
  resolveCharacterIdentities,
} from "./identity.js";

import { isReusableChapterSourceIndex } from "../source-index/reuse.js";

const MAX_CHAPTER_SOURCE_INDEX_ATTEMPTS = 5;

export async function analyzeBook(
  book: ImportedBook,
  options: AnalyzeBookOptions = {},
): Promise<BookAnalysis> {
  let createResponse = options.createResponse;
  if (!createResponse) {
    createResponse = createDefaultResponse();
  }

  const log = options.log ?? console.error;
  const model = options.model || configuredIndexModel();
  const batches = buildChapterAnalysisBatches(
    book,
    options.maxSourceCharsPerRequest ?? MAX_SOURCE_CHARS_PER_REQUEST,
  );
  if (batches.length === 0) {
    throw new Error("Cannot analyze a book without chapters");
  }

  const allParts = batches.flatMap((batch) => batch.parts);
  const partialIndexes = new Map<string, ChapterPartSourceIndex>();
  let generatedChapterIndexes = false;
  const completedChapterPositions = new Set(
    book.chapters.flatMap((chapter, index) =>
      isReusableChapterSourceIndex(chapter.sourceIndex)
        && (!options.sharedEventsOnly || chapter.sourceIndex.extractionMode === "shared_events_v1")
        ? [index]
        : []
    ),
  );
  if (completedChapterPositions.size > 0) {
    log(
      `Reusing ${completedChapterPositions.size}/${book.chapters.length}`
      + " previously saved chapter source indexes...",
    );
  }

  const checkpointCompletedChapters = async (
    chapterPositions: Iterable<number>,
  ): Promise<void> => {
    let savedNewIndexes = false;
    for (const chapterPosition of chapterPositions) {
      if (completedChapterPositions.has(chapterPosition)) continue;
      const chapterParts = allParts.filter(
        (part) => part.chapterPosition === chapterPosition,
      );
      const partIndexes = chapterParts.map((part) => partialIndexes.get(part.sourceId));
      if (partIndexes.some((sourceIndex) => !sourceIndex)) continue;

      const completePartIndexes = partIndexes as ChapterPartSourceIndex[];
      let summary = completePartIndexes[0]?.summary;
      if (!summary) {
        throw new Error(`Missing analyzed source index for chapter ${chapterPosition + 1}`);
      }
      if (completePartIndexes.length > 1) {
        log(
          `Combining ${completePartIndexes.length} partial summaries for chapter`
          + ` ${chapterPosition + 1}/${book.chapters.length}...`,
        );
        const chapter = book.chapters[chapterPosition]!;
        const response = await createResponse({
          model,
          reasoning: { effort: "low" },
          instructions: [
            "Combine these consecutive partial summaries into one self-contained chapter summary.",
            "Preserve chronology, names, plot events, character development, and revealed facts.",
            "Do not add facts that are absent from the partial summaries.",
            `Use their language and stay under ${MAX_CHAPTER_SUMMARY_WORDS} words.`,
          ].join("\n"),
          input: [
            `BOOK: ${book.title}`,
            `CHAPTER: ${chapter.title}`,
            "",
            ...completePartIndexes.map((sourceIndex, partIndex) =>
              `[PART ${partIndex + 1}/${completePartIndexes.length}]\n${sourceIndex.summary}`
            ),
          ].filter(Boolean).join("\n\n"),
          max_output_tokens: 2_000,
        });
        summary = requireOutputText(
          response,
          `combined summary for chapter ${chapterPosition + 1}`,
        );
      }

      const chapter = book.chapters[chapterPosition]!;
      chapter.summary = summary;
      chapter.sourceIndex = mergeChapterPartSourceIndexes(
        chapterPosition,
        chapter.index,
        summary,
        completePartIndexes,
      );
      if (options.sharedEventsOnly) book.chapters[chapterPosition]!.sourceIndex!.extractionMode = "shared_events_v1";
      completedChapterPositions.add(chapterPosition);
      savedNewIndexes = true;
      generatedChapterIndexes = true;
    }
    if (savedNewIndexes && options.saveProgress) {
      await options.saveProgress();
      log(
        `Checkpointed ${completedChapterPositions.size}/${book.chapters.length}`
        + " completed chapter source indexes.",
      );
    }
  };

  // Round-robin repair queue: first give every chapter a chance, then retry only unresolved parts.
  let pendingParts = allParts.filter(part => !completedChapterPositions.has(part.chapterPosition));
  const finalErrors = new Map<string, string>();
  for (let attempt = 1; pendingParts.length && attempt <= MAX_CHAPTER_SOURCE_INDEX_ATTEMPTS; attempt++) {
    const pendingIds = new Set(pendingParts.map(part => part.sourceId));
    const nextPending: typeof pendingParts = [];
    log(`Source queue round ${attempt}/${MAX_CHAPTER_SOURCE_INDEX_ATTEMPTS}: ${pendingParts.length} pending parts`);
    for (const [index, batch] of batches.entries()) {
      const work = batch.parts.filter(part => pendingIds.has(part.sourceId));
      if (!work.length) continue;
      log(`Building chapter source indexes ${formatChapterRange(work)}/${book.chapters.length} (batch ${index + 1}/${batches.length}, round ${attempt})...`);
      try {
        const result = await requestStagedChapterIndexes(createResponse, model, book, work, attempt, log,
          options.saveStageProgress ?? options.saveProgress ?? (async () => {}), {sharedEventsOnly: options.sharedEventsOnly});
        for (const [id, sourceIndex] of result.indexes) {
          partialIndexes.set(id, sourceIndex);
          finalErrors.delete(id);
        }
        await checkpointCompletedChapters(new Set(work.map(part => part.chapterPosition)));
        nextPending.push(...result.invalidParts.filter(part => !completedChapterPositions.has(part.chapterPosition)));
        for (const [id, message] of result.validationErrors) {
          finalErrors.set(id, message);
          log(`Queued source repair ${id}: ${message}`);
        }
      } catch (error) {
        if (error instanceof ImportRunStopped) throw error;
        const message = error instanceof Error ? error.message : String(error);
        nextPending.push(...work.filter(part => !completedChapterPositions.has(part.chapterPosition)));
        for (const part of work) finalErrors.set(part.sourceId, message);
        log(`Source batch deferred: ${message}`);
      }
    }
    pendingParts = nextPending;
  }
  if (pendingParts.length) {
    throw new Error(`Import paused after ${MAX_CHAPTER_SOURCE_INDEX_ATTEMPTS} source rounds; ${completedChapterPositions.size}/${book.chapters.length} chapters saved. Unresolved: ${pendingParts.map(part => part.sourceId + " (" + finalErrors.get(part.sourceId) + ")").join("; ")}. Resume without --reanalyze.`);
  }

  const chapterSummaries = book.chapters.map((chapter, chapterPosition) => {
    const sourceIndex = chapter.sourceIndex;
    if (
      !isReusableChapterSourceIndex(sourceIndex)
    ) {
      throw new Error(`Missing final source index for chapter ${chapterPosition + 1}`);
    }
    chapter.summary = sourceIndex.summary;
    return sourceIndex.summary;
  });
  book.storyEvents = buildBookStoryEvents(book);
  if (
    !generatedChapterIndexes
    && book.worldBible?.schemaVersion === WORLD_BIBLE_SCHEMA_VERSION
  ) {
    log("Reusing the existing whole-book character index...");
    return { chapterSummaries, worldBible: book.worldBible };
  }

  const identityResolutions = await resolveCharacterIdentities(
    book,
    createResponse,
    model,
    log,
  );
  if (identityResolutions.length > 0 && options.saveProgress) {
    await options.saveProgress();
  }

  const chapterSourceIndexInput = book.chapters.map((chapter, index) => {
    const sourceIndex = chapter.sourceIndex;
    if (!sourceIndex) {
      throw new Error(`Missing source index for chapter ${index + 1}`);
    }
    return [
      `[CHAPTER SOURCE INDEX ${index + 1}: ${chapter.title}]`,
      JSON.stringify({
        chapterIndex: chapter.index,
        summary: sourceIndex.summary,
        characters: sourceIndex.characters,
        actions: sourceIndex.actions,
        relationships: sourceIndex.relationships,
      }),
    ].join("\n");
  });
  const observedCharacterCount = book.chapters.reduce(
    (total, chapter) => total + (chapter.sourceIndex?.characters.length ?? 0),
    0,
  );

  let validationFailure = "";
  const resolveVerifiedIdentity = buildVerifiedIdentityResolver(identityResolutions);
  const requiredRetryProfiles = new Map<string, string>();
  for (let attempt = 1; attempt <= MAX_WORLD_BIBLE_ATTEMPTS; attempt += 1) {
    log(
      attempt === 1
        ? "Creating whole-book character index from chapter source indexes..."
        : `Retrying whole-book character index (attempt ${attempt}/${MAX_WORLD_BIBLE_ATTEMPTS})...`,
    );
    const response = await createResponse({
      model,
      reasoning: { effort: "low" },
      instructions: [
        "Create a story-independent whole-book index from the supplied consecutive chapter source indexes.",
        "Write a detailed but concise summary covering the complete main plot, resolution, themes, and character arcs.",
        "Create exactly one profile for every distinct story character present in the chapter character observations.",
        "Order character profiles from most to least narratively important; the application publishes a core cast of about ten and never more than fifteen.",
        "Use only this book’s source evidence for identities. Do not import names or merge roles from adaptations, films, sequels, or general familiarity. Similar titles, benevolence, or narrative functions do not establish that two characters are the same person; require explicit source evidence linking their identities.",
        "Resolve aliases across chapters without merging different people. Canonical names and aliases must be unique after case and punctuation normalization.",
        "Every observed name and alias must occur exactly once, either as a canonical profile name or as an alias of that same profile.",
        "For each profile, include only its canonical name, aliases, narrative role, concise description, defining traits, and complete story arc.",
        ...CHARACTER_PROFILE_DESCRIPTION_RULES,
        "Do not output actions, relationships, or source references. The application attaches those deterministically from the validated chapter indexes after identity resolution.",
        "Never invent a profile, merge different people, or omit an observed identity.",
        "Ignore publisher material, tables of contents, introductions, endnotes, and commentary unless they are part of the story.",
        "Do not reproduce long passages or distinctive prose from the source.",
        "Use the main language of the supplied book.",
        validationFailure
          ? `The previous result failed validation: ${validationFailure}. Correct that structural or referential error.`
          : "",
      ].filter(Boolean).join("\n"),
      input: [
        `BOOK: ${book.title}`,
        book.author ? `AUTHOR: ${book.author}` : "",
        "",
        ...chapterSourceIndexInput,
      ].filter(Boolean).join("\n\n"),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_world_bible",
          strict: true,
          schema: worldBibleSchema,
        },
      },
      max_output_tokens: Math.min(
        MAX_ANALYSIS_OUTPUT_TOKENS,
        Math.max(8_000, observedCharacterCount * 400) * (2 ** (attempt - 1)),
      ),
    });

    try {
      let worldBibleOutput = requireOutputText(response, "whole-book character index");
      let worldBible = parseWorldBibleOutput(
        worldBibleOutput,
        book,
        identityResolutions,
      );
      let genericProfiles = worldBible.characterProfiles?.filter(
        (profile) =>
          profile.role === "Observed character"
          && profile.description === GENERIC_OBSERVED_PROFILE_DESCRIPTION,
      ) ?? [];
      const supplementalProfileAttempts = new Map<string, number>();
      while (genericProfiles.length > 0) {
        const missingNames = genericProfiles.map((profile) => profile.name);
        const exhaustedNames = missingNames.filter((name) =>
          (supplementalProfileAttempts.get(resolveVerifiedIdentity(name)) ?? 0)
            >= MAX_SUPPLEMENTAL_PROFILE_ATTEMPTS
        );
        if (exhaustedNames.length > 0) {
          throw new Error(
            "OpenAI omitted requested supplemental profiles after "
            + `${MAX_SUPPLEMENTAL_PROFILE_ATTEMPTS} attempts: ${exhaustedNames.join(", ")}`,
          );
        }
        const missingIdentityKeys = new Set(
          missingNames.map(resolveVerifiedIdentity),
        );
        for (const identity of missingIdentityKeys) {
          supplementalProfileAttempts.set(
            identity,
            (supplementalProfileAttempts.get(identity) ?? 0) + 1,
          );
        }
        for (const name of missingNames) {
          const identity = resolveVerifiedIdentity(name);
          requiredRetryProfiles.set(identity, name);
        }
        const relevantSourceIndexes = chapterSourceIndexInput.filter((_, index) =>
          book.chapters[index]?.sourceIndex?.characters.some((observation) =>
            [observation.name, ...observation.aliases].some((label) =>
              missingIdentityKeys.has(resolveVerifiedIdentity(label))
            )
          )
        );
        log(`Generating only missing character profiles: ${missingNames.join(", ")}...`);
        const supplementalResponse = await createResponse({
          model,
          reasoning: { effort: "low" },
          instructions: [
            "Create exactly one complete character profile for each name in REQUIRED PROFILES.",
            "Use only the supplied chapter source-index evidence.",
            "Do not omit, rename, merge, or add characters.",
            "Use each required name as the canonical profile name.",
            "Include aliases only when the evidence explicitly establishes them.",
            ...CHARACTER_PROFILE_DESCRIPTION_RULES,
            "Do not reproduce long passages or distinctive prose from the source.",
            "Use the main language of the supplied book.",
          ].join("\n"),
          input: [
            `BOOK: ${book.title}`,
            book.author ? `AUTHOR: ${book.author}` : "",
            `REQUIRED PROFILES: ${JSON.stringify(missingNames)}`,
            "",
            ...relevantSourceIndexes,
          ].filter(Boolean).join("\n\n"),
          text: {
            format: {
              type: "json_schema",
              name: "bookrpg_supplemental_character_profiles",
              strict: true,
              schema: supplementalCharacterProfilesSchema,
            },
          },
          max_output_tokens: Math.min(
            MAX_ANALYSIS_OUTPUT_TOKENS,
            Math.max(2_000, missingNames.length * 800),
          ),
        });
        const mergedSupplemental = mergeSupplementalCharacterProfileOutput(
          worldBibleOutput,
          requireOutputText(supplementalResponse, "supplemental character profiles"),
          missingNames,
          identityResolutions,
        );
        worldBibleOutput = mergedSupplemental.output;
        if (mergedSupplemental.omittedNames.length > 0) {
          log(
            "Supplemental character response omitted "
            + `${mergedSupplemental.omittedNames.join(", ")}; retrying missing profiles...`,
          );
        }
        worldBible = parseWorldBibleOutput(
          worldBibleOutput,
          book,
          identityResolutions,
        );
        genericProfiles = worldBible.characterProfiles?.filter(
          (profile) =>
            profile.role === "Observed character"
            && profile.description === GENERIC_OBSERVED_PROFILE_DESCRIPTION,
        ) ?? [];
      }
      const generatedIdentityLabels = new Set(
        (worldBible.characterProfiles ?? []).flatMap((profile) =>
          [profile.name, ...profile.aliases].map(resolveVerifiedIdentity)
        ),
      );
      const omittedRequiredRetryProfiles = [...requiredRetryProfiles]
        .filter(([normalizedName]) => !generatedIdentityLabels.has(normalizedName))
        .map(([, name]) => name);
      const omittedProfileNames = [...new Set(omittedRequiredRetryProfiles)];
      if (omittedProfileNames.length > 0) {
        throw new Error(
          "OpenAI omitted required core character profiles: "
          + omittedProfileNames.join(", "),
        );
      }
      return { chapterSummaries, worldBible };
    } catch (error) {
      validationFailure = error instanceof Error ? error.message : String(error);
      log(`Whole-book character index validation failed: ${validationFailure}`);
      if (attempt === MAX_WORLD_BIBLE_ATTEMPTS) {
        throw new Error(
          `OpenAI returned an invalid whole-book character index after`
          + ` ${MAX_WORLD_BIBLE_ATTEMPTS} attempts: ${validationFailure}`,
          { cause: error },
        );
      }
    }
  }

  throw new Error("Whole-book character index generation ended unexpectedly");
}


