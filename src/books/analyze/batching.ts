import type {
  AiResponse,
  AiResponseRequest,
} from "../../ai/provider.js";
import type {
  ImportedBook,
} from "../../shared/contracts.js";

export const MAX_SOURCE_CHARS_PER_REQUEST = 60_000;

export const MAX_SOURCE_PARTS_PER_BATCH = 100;

export const MAX_ANALYSIS_OUTPUT_TOKENS = 64_000;

export const MIN_CHAPTER_SOURCE_OUTPUT_TOKENS = 8_000;

export const MAX_CHAPTER_SUMMARY_WORDS = 220;

export const MAX_WORLD_BIBLE_ATTEMPTS = 3;

export const MAX_SUPPLEMENTAL_PROFILE_ATTEMPTS = 3;

export const MAX_IDENTITY_CLAIMS_PER_BATCH = 15;

export const MAX_IDENTITY_REFERENCES_PER_CLAIM = 8;

export const MAX_IDENTITY_OUTPUT_TOKENS = 32_000;

export const GENERIC_OBSERVED_PROFILE_DESCRIPTION =
  "A character evidenced by the chapter source index.";

export const CHARACTER_PROFILE_DESCRIPTION_RULES = [
  "Begin each description with a literal, concrete identification of what the character is.",
  "For every nonhuman character, the first sentence MUST explicitly use a species or recognized creature-type noun supported by the source, such as whale, leviathan, dog, horse, bird, robot, or spirit.",
  "A proper name, title, metaphor, or symbolic label alone does not satisfy the species or creature-type requirement.",
  "State symbolic meaning or thematic importance only after making the character's literal nature clear.",
] as const;

export const characterProfileSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    aliases: {
      type: "array",
      items: { type: "string" },
    },
    role: { type: "string" },
    description: { type: "string" },
    traits: {
      type: "array",
      items: { type: "string" },
    },
    storyArc: { type: "string" },
  },
  required: [
    "name",
    "aliases",
    "role",
    "description",
    "traits",
    "storyArc",
  ],
} as const;

export const worldBibleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    characterProfiles: {
      type: "array",
      items: characterProfileSchema,
    },
    locations: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["summary", "characterProfiles", "locations"],
} as const;

export const supplementalCharacterProfilesSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    characterProfiles: {
      type: "array",
      minItems: 1,
      items: characterProfileSchema,
    },
  },
  required: ["characterProfiles"],
} as const;

export type CreateAnalysisResponse = (
  request: AiResponseRequest,
) => Promise<AiResponse>;

export interface AnalyzeBookOptions {
  createResponse?: CreateAnalysisResponse;
  log?: (message: string) => void;
  maxSourceCharsPerRequest?: number;
  model?: string;
  saveProgress?: () => Promise<void>;
}

export interface ChapterAnalysisPart {
  sourceId: string;
  chapterPosition: number;
  chapterIndex: number;
  chapterTitle: string;
  partIndex: number;
  partCount: number;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface ChapterAnalysisBatch {
  parts: ChapterAnalysisPart[];
  input: string;
}

export interface BookAnalysis {
  chapterSummaries: string[];
  worldBible: NonNullable<ImportedBook["worldBible"]>;
}

export function splitText(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars);
    const paragraphBreak = candidate.lastIndexOf("\n\n");
    const sentenceBreak = candidate.lastIndexOf(". ");
    const splitAt = Math.max(paragraphBreak, sentenceBreak);
    const end = splitAt >= Math.floor(maxChars * 0.6) ? splitAt + 1 : maxChars;
    parts.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

export function sourceId(chapterPosition: number, partNumber: number): string {
  return `chapter_${chapterPosition + 1}_part_${partNumber}`;
}

export function formatPartHeader(
  chapterPosition: number,
  chapterIndex: number,
  chapterTitle: string,
  partNumber: number,
  partCount: number,
  lineStart: number,
  lineEnd: number,
): string {
  return [
    `SOURCE_ID: ${sourceId(chapterPosition, partNumber)}`,
    `CHAPTER_POSITION: ${chapterPosition + 1}`,
    `EPUB_SPINE_INDEX: ${chapterIndex}`,
    `TITLE: ${chapterTitle}`,
    `PART: ${partNumber}/${partCount}`,
    `SOURCE_LINES: ${lineStart}-${lineEnd}`,
    "LINE_NUMBERED_TEXT:",
  ].join("\n");
}

export function formatLineNumberedText(text: string, lineStart: number): string {
  const lines = text.split("\n");
  while (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines
    .map((line, index) => `LINE ${lineStart + index}: ${line}`)
    .join("\n");
}

export function formatAnalysisPart(part: ChapterAnalysisPart): string {
  const header = formatPartHeader(
    part.chapterPosition,
    part.chapterIndex,
    part.chapterTitle,
    part.partIndex + 1,
    part.partCount,
    part.lineStart,
    part.lineEnd,
  );
  return `${header}\n${formatLineNumberedText(part.text, part.lineStart)}`;
}

export interface SourceTextPart {
  text: string;
  lineStart: number;
  lineEnd: number;
}

export function splitSourceText(text: string, maxFormattedChars: number): SourceTextPart[] {
  const source = text.trim();
  if (!source) return [];
  if (!Number.isInteger(maxFormattedChars) || maxFormattedChars <= 0) {
    throw new Error("Source index text limit must be a positive integer");
  }

  const parts: SourceTextPart[] = [];
  let offset = 0;
  let currentLine = 1;
  while (offset < source.length) {
    let low = offset + 1;
    let high = Math.min(source.length, offset + maxFormattedChars);
    let bestEnd = offset;
    while (low <= high) {
      const candidateEnd = Math.floor((low + high) / 2);
      const formattedLength = formatLineNumberedText(
        source.slice(offset, candidateEnd),
        currentLine,
      ).length;
      if (formattedLength <= maxFormattedChars) {
        bestEnd = candidateEnd;
        low = candidateEnd + 1;
      } else {
        high = candidateEnd - 1;
      }
    }
    if (bestEnd === offset) {
      throw new Error(`Source index limit ${maxFormattedChars} is too small for line metadata`);
    }

    if (bestEnd < source.length) {
      const candidate = source.slice(offset, bestEnd);
      const paragraphBreak = candidate.lastIndexOf("\n\n");
      const sentenceBreak = candidate.lastIndexOf(". ");
      const preferredBreak = Math.max(
        paragraphBreak >= 0 ? paragraphBreak + 2 : 0,
        sentenceBreak >= 0 ? sentenceBreak + 2 : 0,
      );
      if (preferredBreak >= Math.floor(candidate.length * 0.6)) {
        bestEnd = offset + preferredBreak;
      }
    }

    const partText = source.slice(offset, bestEnd);
    const newlineCount = (partText.match(/\n/g) ?? []).length;
    const displayedLines = partText.split("\n");
    while (displayedLines.length > 1 && displayedLines.at(-1) === "") {
      displayedLines.pop();
    }
    parts.push({
      text: partText,
      lineStart: currentLine,
      lineEnd: currentLine + displayedLines.length - 1,
    });
    currentLine += newlineCount;
    offset = bestEnd;
  }
  return parts;
}

export function buildChapterAnalysisBatches(
  book: Pick<ImportedBook, "chapters">,
  maxChars = MAX_SOURCE_CHARS_PER_REQUEST,
): ChapterAnalysisBatch[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("Chapter analysis maxChars must be a positive integer");
  }

  const parts = book.chapters.flatMap((chapter, chapterPosition) => {
    const reservedHeader = formatPartHeader(
      chapterPosition,
      chapter.index,
      chapter.title,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    const maxFormattedTextChars = maxChars - reservedHeader.length - 1;
    if (maxFormattedTextChars <= 0) {
      throw new Error(
        `Chapter analysis limit ${maxChars} is too small for chapter ${chapterPosition + 1} metadata`,
      );
    }

    const chapterParts = splitSourceText(chapter.text, maxFormattedTextChars);
    if (chapterParts.length === 0) {
      throw new Error(`Chapter ${chapterPosition + 1} has no text to analyze`);
    }

    return chapterParts.map((part, partIndex): ChapterAnalysisPart => ({
      sourceId: sourceId(chapterPosition, partIndex + 1),
      chapterPosition,
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
      partIndex,
      partCount: chapterParts.length,
      lineStart: part.lineStart,
      lineEnd: part.lineEnd,
      text: part.text,
    }));
  });

  const batches: ChapterAnalysisBatch[] = [];
  let currentParts: ChapterAnalysisPart[] = [];
  let currentInput = "";

  for (const part of parts) {
    const formatted = formatAnalysisPart(part);
    if (formatted.length > maxChars) {
      throw new Error(`Chapter analysis source ${part.sourceId} exceeds the configured size limit`);
    }

    if (
      currentInput
      && (
        currentInput.length + 2 + formatted.length > maxChars
        || currentParts.length >= MAX_SOURCE_PARTS_PER_BATCH
      )
    ) {
      batches.push({ parts: currentParts, input: currentInput });
      currentParts = [];
      currentInput = "";
    }

    currentParts.push(part);
    currentInput = currentInput ? `${currentInput}\n\n${formatted}` : formatted;
  }

  if (currentInput) {
    batches.push({ parts: currentParts, input: currentInput });
  }
  return batches;
}

export function buildAnalysisChunks(
  book: Pick<ImportedBook, "chapters">,
  maxChars = MAX_SOURCE_CHARS_PER_REQUEST,
): string[] {
  const sections = book.chapters.flatMap((chapter) => {
    const heading = `[Book section ${chapter.index + 1}: ${chapter.title}]\n`;
    return splitText(chapter.text, Math.max(1, maxChars - heading.length))
      .map((part) => `${heading}${part}`);
  });
  const chunks: string[] = [];
  let current = "";

  for (const section of sections) {
    if (current && current.length + 2 + section.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${section}` : section;
  }

  if (current) chunks.push(current);
  return chunks;
}

export function sourceLineRangeSchema(part: ChapterAnalysisPart): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      lineStart: {
        type: "integer",
        minimum: part.lineStart,
        maximum: part.lineEnd,
      },
      lineEnd: {
        type: "integer",
        minimum: part.lineStart,
        maximum: part.lineEnd,
      },
    },
    required: ["lineStart", "lineEnd"],
  };
}

export function chapterSourceIndexSchema(parts: ChapterAnalysisPart[]): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const part of parts) {
    const references = {
      type: "array",
      minItems: 1,
      items: sourceLineRangeSchema(part),
    };
    properties[part.sourceId] = {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        significantEvents: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              description: { type: "string" },
              beats: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    actor: {
                      type: ["string", "null"],
                      description: "Exact character name for a character action or experience; null only for an environmental or otherwise actorless external beat.",
                    },
                    action: { type: "string" },
                    targets: {
                      type: "array",
                      items: { type: "string" },
                    },
                    agency: {
                      type: "string",
                      enum: ["intentional", "involuntary", "external", "ambiguous"],
                    },
                    stakes: {
                      type: "string",
                      enum: ["routine", "significant", "critical"],
                    },
                    references,
                  },
                  required: [
                    "actor",
                    "action",
                    "targets",
                    "agency",
                    "stakes",
                    "references",
                  ],
                },
              },
              references,
            },
            required: ["description", "beats", "references"],
          },
        },
        characters: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              aliases: {
                type: "array",
                items: { type: "string" },
              },
              references,
            },
            required: ["name", "aliases", "references"],
          },
        },
        actions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              actor: { type: "string" },
              description: { type: "string" },
              targets: {
                type: "array",
                items: { type: "string" },
              },
              references,
            },
            required: ["actor", "description", "targets", "references"],
          },
        },
        relationships: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              character: { type: "string" },
              relatedCharacter: { type: "string" },
              description: { type: "string" },
              references,
            },
            required: [
              "character",
              "relatedCharacter",
              "description",
              "references",
            ],
          },
        },
      },
      required: [
        "summary",
        "significantEvents",
        "characters",
        "actions",
        "relationships",
      ],
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: parts.map((part) => part.sourceId),
  };
}
