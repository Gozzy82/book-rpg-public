import {
  createHash,
  randomUUID,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CharacterAction,
  CharacterProfile,
  CharacterRelationship,
  ImportedBook,
  SourceReference,
} from "../../shared/contracts.js";
import {
  normalizeCharacterIdentity,
} from "../source-index.js";

export const KINDLE_PACKAGE_SCHEMA_VERSION = 12;

export const INDEX_PAGE_SIZE = 25;

export const CHAPTER_TEXT_MAX_LINES = 100;

export const CHAPTER_TEXT_TARGET_CHARS = 12_000;

export const EVENT_PAGE_TARGET_CHARS = 12_000;

export interface KindleSourceReference extends SourceReference {
  chapterFile: string;
  textFiles: string[];
}

export interface KindleRelationship {
  characterId: string;
  character: string;
  description: string;
  sourceReferences: KindleSourceReference[];
}

export interface KindleIncomingAction extends KindleAction {
  actor: {
    characterId: string;
    character: string;
  };
}

export interface KindleAction {
  description: string;
  targets: Array<{
    characterId: string;
    character: string;
  }>;
  sourceReferences: KindleSourceReference[];
}

export interface KindleCharacterDetail {
  schemaVersion: typeof KINDLE_PACKAGE_SCHEMA_VERSION;
  characterId: string;
  name: string;
  aliases: string[];
  firstSeen: KindleSourceReference;
  overviewFile: string;
  timelineIndexScope: "whole_book";
  timeline: Array<{
    chapterPosition: number;
    chapterIndex: number;
    file: string;
  }>;
}

export interface KindleCharacterCatalogEntry {
  characterId: string;
  name: string;
  aliases: string[];
  detailFile: string;
  overviewFile: string;
  firstSeen: KindleSourceReference;
}

export interface KindlePackageResult {
  packageId: string;
  directory: string;
  manifestFile: string;
  characterCount: number;
  chapterCount: number;
}

export interface KindleAnalysisCheckpointResult {
  analysisId: string;
  directory: string;
  checkpointFile: string;
  completedChapterCount: number;
  characterCandidateCount: number;
}

export function packagePath(...segments: string[]): string {
  return segments.join("/");
}

export function chapterFilename(chapterPosition: number): string {
  return packagePath(
    "chapters",
    String(chapterPosition).padStart(4, "0"),
    "index.json",
  );
}

export function chapterTextFilename(chapterPosition: number, chunkIndex: number): string {
  return packagePath(
    "chapters",
    String(chapterPosition).padStart(4, "0"),
    "text",
    `${String(chunkIndex).padStart(4, "0")}.json`,
  );
}

export interface ChapterTextChunk {
  lineStart: number;
  lineEnd: number;
  file: string;
  lines: string[];
}

export function chapterTextChunks(chapterPosition: number, text: string): ChapterTextChunk[] {
  const lines = text.trim().split(/\r?\n/);
  const chunks: ChapterTextChunk[] = [];
  let chunkLines: string[] = [];
  let chunkChars = 0;
  let lineStart = 1;

  const flush = (): void => {
    if (chunkLines.length === 0) return;
    const chunkIndex = chunks.length;
    chunks.push({
      lineStart,
      lineEnd: lineStart + chunkLines.length - 1,
      file: chapterTextFilename(chapterPosition, chunkIndex),
      lines: chunkLines,
    });
    lineStart += chunkLines.length;
    chunkLines = [];
    chunkChars = 0;
  };

  for (const line of lines) {
    if (
      chunkLines.length > 0
      && (
        chunkLines.length >= CHAPTER_TEXT_MAX_LINES
        || chunkChars + line.length > CHAPTER_TEXT_TARGET_CHARS
      )
    ) {
      flush();
    }
    chunkLines.push(line);
    chunkChars += line.length;
  }
  flush();
  return chunks;
}

export function contentPages<T>(items: T[]): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  let pageChars = 0;
  for (const item of items) {
    const itemChars = JSON.stringify(item).length;
    if (page.length > 0 && pageChars + itemChars > EVENT_PAGE_TARGET_CHARS) {
      pages.push(page);
      page = [];
      pageChars = 0;
    }
    page.push(item);
    pageChars += itemChars;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

export function characterFilename(characterId: string): string {
  return packagePath("characters", characterId, "profile.json");
}

export function characterTimelineFilename(
  characterId: string,
  chapterPosition: number,
): string {
  return packagePath(
    "characters",
    characterId,
    "timeline",
    String(chapterPosition).padStart(4, "0"),
    "index.json",
  );
}

export function characterTimelineShardFilename(
  characterId: string,
  chapterPosition: number,
  shard: string,
): string {
  return packagePath(
    "characters",
    characterId,
    "timeline",
    String(chapterPosition).padStart(4, "0"),
    `${shard}.json`,
  );
}

export function characterOverviewFilename(characterId: string): string {
  return packagePath("characters", characterId, "overview.json");
}

export function characterAvailabilityFilename(chapterPosition: number): string {
  return packagePath(
    "characters",
    "availability",
    `${String(chapterPosition).padStart(4, "0")}.json`,
  );
}

export function compareReferences(left: SourceReference, right: SourceReference): number {
  return left.chapterPosition - right.chapterPosition
    || left.lineStart - right.lineStart
    || left.lineEnd - right.lineEnd;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareByKindleReference(
  left: { sourceReferences: KindleSourceReference[] },
  right: { sourceReferences: KindleSourceReference[] },
): number {
  const leftReference = left.sourceReferences[0];
  const rightReference = right.sourceReferences[0];
  if (!leftReference || !rightReference) return 0;
  return compareReferences(leftReference, rightReference);
}

export function validateReference(book: ImportedBook, reference: SourceReference): void {
  const chapter = book.chapters[reference.chapterPosition];
  const lineCount = chapter?.text.trim().split(/\r?\n/).length;
  if (
    !chapter
    || chapter.index !== reference.chapterIndex
    || !Number.isInteger(reference.lineStart)
    || !Number.isInteger(reference.lineEnd)
    || reference.lineStart < 1
    || reference.lineStart > reference.lineEnd
    || !lineCount
    || reference.lineEnd > lineCount
  ) {
    throw new Error(`Invalid source reference in character index: ${JSON.stringify(reference)}`);
  }
}

export function kindleReferences(
  book: ImportedBook,
  references: SourceReference[] | undefined,
  field: string,
): KindleSourceReference[] {
  if (!references?.length) {
    throw new Error(`Cannot export ${field} without source references`);
  }
  const seen = new Set<string>();
  return references
    .map((reference) => {
      validateReference(book, reference);
      return {
        ...reference,
        chapterFile: chapterFilename(reference.chapterPosition),
        textFiles: chapterTextChunks(
          reference.chapterPosition,
          book.chapters[reference.chapterPosition]!.text,
        )
          .filter((chunk) =>
            chunk.lineEnd >= reference.lineStart
            && chunk.lineStart <= reference.lineEnd
          )
          .map((chunk) => chunk.file),
      };
    })
    .filter((reference) => {
      const key = [
        reference.chapterPosition,
        reference.chapterIndex,
        reference.lineStart,
        reference.lineEnd,
      ].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareReferences);
}

export function requireCharacterId(
  value: string | undefined,
  profilesById: ReadonlyMap<string, CharacterProfile>,
  field: string,
): string {
  if (!value || !profilesById.has(value)) {
    throw new Error(`Cannot export unresolved character ID for ${field}`);
  }
  return value;
}

export function kindleAction(
  book: ImportedBook,
  action: CharacterAction,
  profilesById: Map<string, CharacterProfile>,
  field: string,
): KindleAction {
  return {
    description: action.description,
    targets: action.targets.map((target, index) => {
      const characterId = requireCharacterId(
        target.characterId,
        profilesById,
        `${field} target ${index + 1}`,
      );
      return {
        characterId,
        character: profilesById.get(characterId)!.name,
      };
    }),
    sourceReferences: kindleReferences(book, action.sourceReferences, field),
  };
}

export function kindleRelationship(
  book: ImportedBook,
  relationship: CharacterRelationship,
  profilesById: Map<string, CharacterProfile>,
  field: string,
): KindleRelationship {
  const characterId = requireCharacterId(
    relationship.characterId,
    profilesById,
    field,
  );
  return {
    characterId,
    character: profilesById.get(characterId)!.name,
    description: relationship.description,
    sourceReferences: kindleReferences(book, relationship.sourceReferences, field),
  };
}

export function foldedSearchKey(value: string): string {
  return normalizeCharacterIdentity(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}

export function searchShardKey(value: string): string {
  const first = foldedSearchKey(value)[0] ?? "";
  return /^[a-z0-9]$/.test(first) ? first : "_";
}

export function addLookup(
  lookup: Record<string, string[]>,
  key: string,
  characterId: string,
): void {
  if (!key) return;
  const matches = lookup[key] ?? [];
  if (!matches.includes(characterId)) {
    lookup[key] = [...matches, characterId].sort();
  }
}

export async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  try {
    if (await fs.readFile(filename, "utf8") === serialized) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, serialized, "utf8");
  try {
    await fs.rename(temporary, filename);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

export function packageFingerprint(book: ImportedBook): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
    book: {
      bookId: book.bookId,
      sourceSha256: book.sourceSha256,
      title: book.title,
      author: book.author,
      importedAt: book.importedAt,
    },
    chapters: book.chapters.map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      text: chapter.text,
      sourceIndex: chapter.sourceIndex,
    })),
    storyEvents: book.storyEvents,
    worldBible: book.worldBible,
  }));
  return hash.digest("hex").slice(0, 20);
}

export function analysisId(book: ImportedBook): string {
  const digest = createHash("sha256")
    .update(`${book.bookId}\0${book.sourceSha256}`)
    .digest("hex")
    .slice(0, 20);
  return `analysis_${digest}`;
}

export function candidateId(
  book: ImportedBook,
  chapterPosition: number,
  name: string,
): string {
  const digest = createHash("sha256")
    .update(`${book.bookId}\0${chapterPosition}\0${normalizeCharacterIdentity(name)}`)
    .digest("hex")
    .slice(0, 20);
  return `candidate_${digest}`;
}

export function validateBookId(bookId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(bookId)) {
    throw new Error("Cannot export a book with an unsafe book ID");
  }
}
