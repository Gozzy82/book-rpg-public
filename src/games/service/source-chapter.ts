import type {
  ImportedBook,
} from "../../shared/contracts.js";

export function normalizedOffsetThroughSourceLine(text: string, lineEnd: number): number {
  return text
    .split(/\r?\n/u)
    .slice(0, Math.max(0, lineEnd))
    .join("\n")
    .replace(/\s+/g, " ")
    .length;
}

export const SOURCE_CONTINUATION_EXCERPT_CHARS = 6_000;

export const SOURCE_EVENT_LOOKAHEAD = 2;

export const OPENING_STORY_SO_FAR_CHAPTERS = 3;

export type ImportedChapter = ImportedBook["chapters"][number];

export function chapterSummary(chapter: ImportedChapter): string {
  const indexedEvents = chapter.sourceIndex?.significantEvents
    ?.map((event) => event.description.trim())
    .filter(Boolean);
  return indexedEvents?.length
    ? indexedEvents.join(" ")
    : chapter.sourceIndex?.summary?.trim()
    || chapter.summary?.trim()
    || "";
}

export function hasIndexedStoryContent(chapter: ImportedChapter): boolean {
  return Boolean(
    chapter.sourceIndex
    && (
      (chapter.sourceIndex.significantEvents?.length ?? 0) > 0
      ||
      chapter.sourceIndex.characters.length > 0
      || chapter.sourceIndex.actions.length > 0
      || chapter.sourceIndex.relationships.length > 0
    ),
  );
}

export function isKnownNonStoryChapter(chapter: ImportedChapter): boolean {
  return (
    /^not story content\b/iu.test(chapterSummary(chapter))
    || /\b(?:front matter|publication (?:details|notes)|copyright notices?|bibliographic details?|title page|no narrative content)\b/iu
      .test(chapterSummary(chapter))
  )
    && !hasIndexedStoryContent(chapter);
}
