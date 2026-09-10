import {
  createAiClient,
} from "../../ai/provider.js";
import {
  MIN_VERIFIED_IDENTITY_CONFIDENCE,
} from "../../shared/contracts.js";
import type {
  CharacterIdentityResolution,
  ImportedBook,
  SourceReference,
} from "../../shared/contracts.js";
import {
  cleanIdentityLabel,
  normalizeCharacterIdentity,
} from "../source-index.js";
import {
  MAX_IDENTITY_CLAIMS_PER_BATCH,
  MAX_IDENTITY_REFERENCES_PER_CLAIM,
  MAX_IDENTITY_OUTPUT_TOKENS,
} from "./batching.js";
import type {
  CreateAnalysisResponse,
} from "./batching.js";
import {
  requireOutputText,
  isRecord,
} from "./output.js";

export function createDefaultResponse(): CreateAnalysisResponse {
  const client = createAiClient();
  return async (request) => await client.createResponse(request);
}

export interface IdentityClaim {
  id: string;
  canonicalName: string;
  alias: string;
  sourceReferences: SourceReference[];
  eligibleForAi: boolean;
}

export function identityPairKey(left: string, right: string): string {
  return [normalizeCharacterIdentity(left), normalizeCharacterIdentity(right)]
    .sort()
    .join("\0");
}

export function sampleIdentityReferences(references: SourceReference[]): SourceReference[] {
  if (references.length <= MAX_IDENTITY_REFERENCES_PER_CLAIM) return references;
  return Array.from(
    { length: MAX_IDENTITY_REFERENCES_PER_CLAIM },
    (_, index) => references[Math.round(
      index * (references.length - 1) / (MAX_IDENTITY_REFERENCES_PER_CLAIM - 1),
    )]!,
  );
}

export const NON_IDENTITY_LABELS = new Set([
  "i", "me", "myself", "we", "us", "he", "him", "she", "her", "they", "them", "you",
  "ik", "mij", "me", "wij", "we", "hij", "hem", "zij", "haar", "jij", "je", "u",
  "ich", "mich", "wir", "er", "ihn", "sie", "du",
  "je", "moi", "nous", "il", "lui", "elle", "ils", "elles", "vous",
]);

export function isPlausibleIdentityLabel(value: string): boolean {
  const normalized = normalizeCharacterIdentity(value);
  const connectorWords = new Set([
    "de", "den", "der", "di", "du", "la", "le", "of", "the", "van", "von",
  ]);
  const words = value.trim().split(/\s+/);
  const hasDescriptiveWord = words.slice(1).some((word) => {
    const letters = word.replace(/[^\p{L}]/gu, "");
    if (!letters || connectorWords.has(letters.toLowerCase())) return false;
    return letters === letters.toLowerCase() && letters !== letters.toUpperCase();
  });
  return normalized.length >= 2
    && !NON_IDENTITY_LABELS.has(normalized)
    && normalized.split(" ").length <= 6
    && !hasDescriptiveWord;
}

export function findIdentityLabelReferences(
  book: ImportedBook,
  label: string,
): SourceReference[] {
  const needle = normalizeCharacterIdentity(label);
  if (!needle) return [];
  const references: SourceReference[] = [];
  for (const [chapterPosition, chapter] of book.chapters.entries()) {
    const lines = chapter.text.trim().split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      const haystack = ` ${normalizeCharacterIdentity(line)} `;
      if (haystack.includes(` ${needle} `)) {
        references.push({
          chapterPosition,
          chapterIndex: chapter.index,
          lineStart: lineIndex + 1,
          lineEnd: lineIndex + 1,
        });
      }
    }
  }
  return sampleIdentityReferences(references);
}

export function buildIdentityClaims(book: ImportedBook): IdentityClaim[] {
  const claims = new Map<string, Omit<IdentityClaim, "id" | "eligibleForAi">>();
  const addClaim = (
    canonicalName: string,
    rawAlias: string,
    sourceReferences: SourceReference[],
  ): void => {
    const alias = cleanIdentityLabel(rawAlias);
    if (
      !alias
      || normalizeCharacterIdentity(alias) === normalizeCharacterIdentity(canonicalName)
    ) {
      return;
    }
    const key = identityPairKey(canonicalName, alias);
    const existing = claims.get(key);
    const references = [...(existing?.sourceReferences ?? []), ...sourceReferences];
    const seen = new Set<string>();
    claims.set(key, {
      canonicalName: existing?.canonicalName ?? canonicalName,
      alias: existing?.alias ?? alias,
      sourceReferences: sampleIdentityReferences(references.filter((reference) => {
        const referenceKey = [
          reference.chapterPosition,
          reference.chapterIndex,
          reference.lineStart,
          reference.lineEnd,
        ].join(":");
        if (seen.has(referenceKey)) return false;
        seen.add(referenceKey);
        return true;
      })),
    });
  };

  for (const chapter of book.chapters) {
    for (const observation of chapter.sourceIndex?.characters ?? []) {
      for (const rawAlias of observation.aliases) {
        const alias = cleanIdentityLabel(rawAlias);
        if (
          !alias
          || normalizeCharacterIdentity(alias) === normalizeCharacterIdentity(observation.name)
        ) {
          continue;
        }
        addClaim(observation.name, alias, observation.sourceReferences);
      }
    }
  }
  for (const resolution of book.worldBible?.identityResolutions ?? []) {
    addClaim(
      resolution.canonicalName,
      resolution.alias,
      resolution.sourceReferences,
    );
  }
  return [...claims.values()].map((claim, index) => {
    const canonicalReferences = findIdentityLabelReferences(book, claim.canonicalName);
    const aliasReferences = findIdentityLabelReferences(book, claim.alias);
    return {
      id: `identity_${index + 1}`,
      ...claim,
      sourceReferences: sampleIdentityReferences([
        ...canonicalReferences,
        ...aliasReferences,
      ]),
      eligibleForAi: isPlausibleIdentityLabel(claim.canonicalName)
        && isPlausibleIdentityLabel(claim.alias)
        && canonicalReferences.length > 0
        && aliasReferences.length > 0,
    };
  });
}

export function identityEvidenceText(book: ImportedBook, claim: IdentityClaim): string {
  return [
    `CLAIM_ID: ${claim.id}`,
    `LABEL_A: ${claim.canonicalName}`,
    `LABEL_B: ${claim.alias}`,
    ...claim.sourceReferences.map((reference, index) => {
      const chapter = book.chapters[reference.chapterPosition]!;
      const lines = chapter.text.trim().split(/\r?\n/);
      const contextStart = Math.max(1, reference.lineStart - 1);
      const contextEnd = Math.min(lines.length, reference.lineEnd + 1);
      const excerpt = lines.slice(contextStart - 1, contextEnd)
        .map((line, offset) => `LINE ${contextStart + offset}: ${line}`)
        .join("\n");
      return [
        `EVIDENCE_REFERENCE_INDEX: ${index}`,
        `CHAPTER_POSITION: ${reference.chapterPosition}`,
        `EPUB_SPINE_INDEX: ${reference.chapterIndex}`,
        `SOURCE_LINES: ${reference.lineStart}-${reference.lineEnd}`,
        excerpt,
      ].join("\n");
    }),
  ].join("\n");
}

export function identityResolutionSchema(claims: IdentityClaim[]): Record<string, unknown> {
  const properties = Object.fromEntries(claims.map((claim) => [
    claim.id,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        decision: {
          type: "string",
          enum: ["same_person", "different_people", "uncertain"],
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        evidenceReferenceIndexes: {
          type: "array",
          minItems: 1,
          items: {
            type: "integer",
            minimum: 0,
            maximum: claim.sourceReferences.length - 1,
          },
        },
      },
      required: ["decision", "confidence", "evidenceReferenceIndexes"],
    },
  ]));
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: claims.map((claim) => claim.id),
  };
}

export async function resolveCharacterIdentities(
  book: ImportedBook,
  createResponse: CreateAnalysisResponse,
  model: string,
  log: (message: string) => void,
): Promise<CharacterIdentityResolution[]> {
  const resolutions: CharacterIdentityResolution[] = [];
  const claims = buildIdentityClaims(book).filter((claim) => {
    if (claim.eligibleForAi) return true;
    if (claim.sourceReferences.length > 0) {
      resolutions.push({
        canonicalName: claim.canonicalName,
        alias: claim.alias,
        decision: "uncertain",
        confidence: 1,
        sourceReferences: claim.sourceReferences,
      });
    }
    return false;
  });

  for (let offset = 0; offset < claims.length; offset += MAX_IDENTITY_CLAIMS_PER_BATCH) {
    const batch = claims.slice(offset, offset + MAX_IDENTITY_CLAIMS_PER_BATCH);
    log(
      `Verifying character identities ${offset + 1}-${offset + batch.length}`
      + `/${claims.length} against source context...`,
    );
    const response = await createResponse({
      model,
      reasoning: { effort: "medium" },
      instructions: [
        "Resolve possible character aliases using only the supplied source context.",
        "This must work for any story: do not rely on prior knowledge of a specific book.",
        "Use only this book’s source evidence for identities. Do not import names or merge roles from adaptations, films, sequels, or general familiarity. Similar titles, benevolence, or narrative functions do not establish that two characters are the same person; require explicit source evidence linking their identities.",
        "Treat LABEL_A and LABEL_B neutrally; neither label is presumed canonical or an alias.",
        "For this task, same_person means more than referring to the same person in one passage: the two labels must form a safe identity-alias pair for later character matching.",
        "Choose same_person only when the evidence establishes that both labels are genuine names or stable name-like identifiers for the same character.",
        "A title, honorific, occupation, role, species or kind, relationship term, description, epithet, or form of address is not an alias merely because it is applied to that character. If such a label is not clearly used as a stable name-like identifier, choose uncertain even when the passage makes clear which person it describes.",
        "A shortened form of a longer character name can still be a valid stable alias. Do not reject it solely because the shortened label is also a title, species, kind, epithet, or role word when the supplied source repeatedly or consistently uses that label as a standalone name-like identifier for the same character.",
        "Treat labels caused by another character's mistaken belief, assumption, praise, insult, or temporary characterization as non-alias descriptions; choose uncertain rather than same_person.",
        "For example, calling someone doctor, captain, sorceress, girl, mother, hero, or fool does not by itself make that word an alias.",
        "Choose different_people when the labels identify separate people.",
        "Choose uncertain when the excerpts do not establish a safe alias relationship or do not establish whether the labels identify the same person.",
        "Confidence must reflect the supplied evidence, not plausibility.",
        "Select the evidence reference indexes that support the decision.",
      ].join("\n"),
      input: batch.map((claim) => identityEvidenceText(book, claim)).join("\n\n"),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_identity_resolution",
          strict: true,
          schema: identityResolutionSchema(batch),
        },
      },
      max_output_tokens: MAX_IDENTITY_OUTPUT_TOKENS,
    });
    const parsed: unknown = JSON.parse(requireOutputText(response, "character identity resolution"));
    if (!isRecord(parsed) || Object.keys(parsed).length !== batch.length) {
      throw new Error("OpenAI returned an incomplete character identity resolution");
    }
    for (const claim of batch) {
      const decision = parsed[claim.id];
      if (
        !isRecord(decision)
        || !["same_person", "different_people", "uncertain"].includes(
          String(decision.decision),
        )
        || typeof decision.confidence !== "number"
        || decision.confidence < 0
        || decision.confidence > 1
        || !Array.isArray(decision.evidenceReferenceIndexes)
        || decision.evidenceReferenceIndexes.length === 0
        || !decision.evidenceReferenceIndexes.every(
          (index) =>
            Number.isInteger(index)
            && (index as number) >= 0
            && (index as number) < claim.sourceReferences.length,
        )
      ) {
        throw new Error(`OpenAI returned an invalid identity decision for ${claim.id}`);
      }
      resolutions.push({
        canonicalName: claim.canonicalName,
        alias: claim.alias,
        decision: decision.decision as CharacterIdentityResolution["decision"],
        confidence: decision.confidence,
        sourceReferences: decision.evidenceReferenceIndexes.map(
          (index) => claim.sourceReferences[index as number]!,
        ),
      });
    }
  }

  const acceptedPairs = new Set(
    resolutions
      .filter((resolution) =>
        resolution.decision === "same_person"
        && resolution.confidence >= MIN_VERIFIED_IDENTITY_CONFIDENCE
      )
      .map((resolution) => identityPairKey(
        resolution.canonicalName,
        resolution.alias,
      )),
  );
  for (const chapter of book.chapters) {
    const sourceIndex = chapter.sourceIndex;
    if (!sourceIndex) continue;
    sourceIndex.characters = sourceIndex.characters.map((observation) => ({
      ...observation,
      aliases: [...new Map(observation.aliases.flatMap((rawAlias) => {
        const alias = cleanIdentityLabel(rawAlias);
        if (
          !alias
          || normalizeCharacterIdentity(alias) === normalizeCharacterIdentity(observation.name)
          || !acceptedPairs.has(identityPairKey(observation.name, alias))
        ) {
          return [];
        }
        return [[normalizeCharacterIdentity(alias), alias] as const];
      })).values()],
    }));
  }
  return resolutions;
}
