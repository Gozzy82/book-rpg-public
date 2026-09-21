import type {
  AiResponse,
} from "../../ai/provider.js";
import type {
  CharacterIdentityResolution,
} from "../../shared/contracts.js";
import {
  buildVerifiedIdentityResolver,
  parseChapterPartSourceIndex,
} from "../source-index.js";
import type {
  ChapterPartSourceIndex,
} from "../source-index.js";
import {
  MAX_ANALYSIS_OUTPUT_TOKENS,
  MIN_CHAPTER_SOURCE_OUTPUT_TOKENS,
  sourceId,
  formatAnalysisPart,
} from "./batching.js";
import type {
  ChapterAnalysisPart,
} from "./batching.js";

export function requireOutputText(response: AiResponse, subject: string): string {
  if (response.status === "incomplete") {
    throw new Error(
      `OpenAI returned an incomplete ${subject}:`
      + ` ${JSON.stringify(response.incomplete_details)}`,
    );
  }
  const output = response.output_text.trim();
  if (output) return output;

  const detail = response.status === "incomplete"
    ? `incomplete: ${JSON.stringify(response.incomplete_details)}`
    : `status: ${response.status}`;
  throw new Error(`OpenAI returned an empty ${subject} (${detail})`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateStoryEventBeatReferenceOrder(
  index: ChapterPartSourceIndex,
): void {
  for (const event of index.significantEvents) {
    const beats = event.beats ?? [];
    for (let earlierIndex = 0; earlierIndex < beats.length; earlierIndex += 1) {
      const earlierBeat = beats[earlierIndex]!;
      for (let laterIndex = earlierIndex + 1; laterIndex < beats.length; laterIndex += 1) {
        const laterBeat = beats[laterIndex]!;
        for (const earlierReference of earlierBeat.references) {
          for (const laterReference of laterBeat.references) {
            const identicalRange =
              earlierReference.lineStart === laterReference.lineStart
              && earlierReference.lineEnd === laterReference.lineEnd;
            if (identicalRange) continue;

            // Line ranges cannot order separate clauses within their shared final
            // line. Equal endpoints alone do not establish an interleaved action.
            const earlierContainsLater =
              earlierReference.lineStart < laterReference.lineStart
              && earlierReference.lineEnd > laterReference.lineEnd;
            if (!earlierContainsLater) continue;

            const laterEvidenceContinuesPastEarlierBeat = beats
              .slice(laterIndex + 1)
              .some((followingBeat) =>
                followingBeat.references.some((followingReference) =>
                  followingReference.lineStart <= earlierReference.lineEnd
                  && followingReference.lineEnd > earlierReference.lineEnd
                )
              );
            if (!laterEvidenceContinuesPastEarlierBeat) continue;

            throw new Error(
              `Significant event beat ${earlierIndex} source range `
              + `${earlierReference.lineStart}-${earlierReference.lineEnd} spans intervening beat `
              + `${laterIndex} range ${laterReference.lineStart}-${laterReference.lineEnd} while later `
              + "beat evidence continues beyond the earlier range. Keep each beat atomic and contiguous: "
              + "split actions before and after the intervening beat into separate beats and use the "
              + "narrowest source range for each.",
            );
          }
        }
      }
    }
  }
}

export function mergeSupplementalCharacterProfileOutput(
  worldBibleOutput: string,
  supplementalOutput: string,
  requiredNames: readonly string[],
  identityResolutions: readonly CharacterIdentityResolution[] = [],
): { output: string; omittedNames: string[] } {
  const worldBible: unknown = JSON.parse(worldBibleOutput);
  const supplemental: unknown = JSON.parse(supplementalOutput);
  if (
    !isRecord(worldBible)
    || !Array.isArray(worldBible.characterProfiles)
    || !isRecord(supplemental)
    || !Array.isArray(supplemental.characterProfiles)
  ) {
    throw new Error("OpenAI returned invalid supplemental character profiles");
  }

  const resolveIdentity = buildVerifiedIdentityResolver(identityResolutions);
  const suppliedLabels = new Set<string>();
  for (const value of supplemental.characterProfiles) {
    if (!isRecord(value) || typeof value.name !== "string") {
      throw new Error("OpenAI returned an invalid supplemental character profile");
    }
    suppliedLabels.add(resolveIdentity(value.name));
    if (Array.isArray(value.aliases)) {
      for (const alias of value.aliases) {
        if (typeof alias === "string") {
          suppliedLabels.add(resolveIdentity(alias));
        }
      }
    }
  }
  const omitted = requiredNames.filter(
    (name) => !suppliedLabels.has(resolveIdentity(name)),
  );
  return {
    output: JSON.stringify({
      ...worldBible,
      characterProfiles: [
        ...worldBible.characterProfiles,
        ...supplemental.characterProfiles,
      ],
    }),
    omittedNames: omitted,
  };
}

export function mergeSupplementalCharacterProfiles(
  worldBibleOutput: string,
  supplementalOutput: string,
  requiredNames: readonly string[],
  identityResolutions: readonly CharacterIdentityResolution[] = [],
): string {
  const result = mergeSupplementalCharacterProfileOutput(
    worldBibleOutput,
    supplementalOutput,
    requiredNames,
    identityResolutions,
  );
  if (result.omittedNames.length > 0) {
    throw new Error(
      `OpenAI omitted requested supplemental profiles: ${result.omittedNames.join(", ")}`,
    );
  }
  return result.output;
}

export function parseChapterSourceIndexes(
  output: string,
  parts: ChapterAnalysisPart[],
  batchNumber: number,
): {
  indexes: Map<string, ChapterPartSourceIndex>;
  invalidParts: ChapterAnalysisPart[];
  validationErrors: Map<string, string>;
} {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) {
    throw new Error(`OpenAI returned an invalid chapter source index for batch ${batchNumber}`);
  }

  const expectedIds = new Set(parts.map((part) => part.sourceId));
  const actualIds = Object.keys(parsed);
  const unexpected = actualIds.filter((id) => !expectedIds.has(id));
  if (unexpected.length > 0) {
    throw new Error(
      `OpenAI returned mismatched chapter source indexes for batch ${batchNumber}`
      + ` (unexpected: ${unexpected.join(", ")})`,
    );
  }

  const indexes = new Map<string, ChapterPartSourceIndex>();
  const invalidParts: ChapterAnalysisPart[] = [];
  const validationErrors = new Map<string, string>();
  for (const part of parts) {
    try {
      const index = parseChapterPartSourceIndex(parsed[part.sourceId], {
        sourceId: part.sourceId,
        chapterIndex: part.chapterIndex,
        lineStart: part.lineStart,
        lineEnd: part.lineEnd,
        sourceText: part.text,
      });
      validateStoryEventBeatReferenceOrder(index);
      indexes.set(part.sourceId, index);
    } catch (error) {
      invalidParts.push(part);
      validationErrors.set(
        part.sourceId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { indexes, invalidParts, validationErrors };
}

export function formatChapterRange(parts: ChapterAnalysisPart[]): string {
  const positions = [...new Set(parts.map((part) => part.chapterPosition + 1))];
  const first = positions[0];
  const last = positions.at(-1);
  return first === last ? String(first) : `${first}-${last}`;
}

export function chapterSourceOutputTokenLimit(
  parts: ChapterAnalysisPart[],
  attempt: number,
): number {
  const formattedSourceChars = parts.reduce(
    (total, part) => total + formatAnalysisPart(part).length,
    0,
  );
  const initialLimit = Math.max(
    MIN_CHAPTER_SOURCE_OUTPUT_TOKENS,
    parts.length * 2_500,
    Math.ceil(formattedSourceChars * 0.75),
  );
  return Math.min(
    MAX_ANALYSIS_OUTPUT_TOKENS,
    initialLimit * (2 ** (attempt - 1)),
  );
}

