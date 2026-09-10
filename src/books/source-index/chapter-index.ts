import {
  CHAPTER_SOURCE_INDEX_VERSION,
  MIN_VERIFIED_IDENTITY_CONFIDENCE,
} from "../../shared/contracts.js";
import type {
  ChapterActionObservation,
  ChapterCharacterObservation,
  ChapterRelationshipObservation,
  ChapterSourceIndex,
  CharacterIdentityResolution,
  ChoiceStakes,
  SourceReference,
  StoryEventBeatAgency,
} from "../../shared/contracts.js";

export interface SourceLineRange {
  lineStart: number;
  lineEnd: number;
}

export interface ChapterPartSourceIndex {
  summary: string;
  significantEvents: Array<{
    description: string;
    beats: Array<{
      actor: string | null;
      action: string;
      targets: string[];
      agency: StoryEventBeatAgency;
      stakes: ChoiceStakes;
      references: SourceLineRange[];
    }>;
    actors: string[];
    targets: string[];
    references: SourceLineRange[];
  }>;
  characters: Array<{
    name: string;
    aliases: string[];
    references: SourceLineRange[];
  }>;
  actions: Array<{
    actor: string;
    description: string;
    targets: string[];
    references: SourceLineRange[];
  }>;
  relationships: Array<{
    character: string;
    relatedCharacter: string;
    description: string;
    references: SourceLineRange[];
  }>;
}

export interface ChapterPartBounds {
  sourceId: string;
  chapterIndex: number;
  lineStart: number;
  lineEnd: number;
  sourceText?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

export function normalizeCharacterIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function buildVerifiedIdentityResolver(
  identityResolutions: readonly CharacterIdentityResolution[],
): (value: string) => string {
  const parents = new Map<string, string>();
  const find = (key: string): string => {
    const parent = parents.get(key);
    if (parent === undefined) {
      parents.set(key, key);
      return key;
    }
    if (parent === key) return key;
    const root = find(parent);
    parents.set(key, root);
    return root;
  };

  for (const resolution of identityResolutions) {
    if (
      resolution.decision !== "same_person"
      || resolution.confidence < MIN_VERIFIED_IDENTITY_CONFIDENCE
    ) {
      continue;
    }
    const left = normalizeCharacterIdentity(resolution.canonicalName);
    const right = normalizeCharacterIdentity(resolution.alias);
    if (!left || !right) continue;
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  }

  return (value) => {
    const key = normalizeCharacterIdentity(value);
    return parents.has(key) ? find(key) : key;
  };
}

export function cleanIdentityLabel(value: string): string {
  return value.trim()
    .replace(/\s*\([^)]*\)\s*$/u, "")
    .replace(/,\s+[^,]*[’'][^,]*$/u, "")
    .replace(/[’']s\s*$/iu, "")
    .trim();
}

export function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw new Error(`OpenAI returned an invalid ${field} list`);
  }
  return value.map((item) => item.trim());
}

export function parseLineRanges(
  value: unknown,
  bounds: Pick<ChapterPartBounds, "lineStart" | "lineEnd">,
  field: string,
): SourceLineRange[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`OpenAI returned no source references for ${field}`);
  }

  const seen = new Set<string>();
  const references: SourceLineRange[] = [];
  for (const reference of value) {
    if (!isRecord(reference)) {
      throw new Error(`OpenAI returned an invalid source reference for ${field}`);
    }
    const lineStart = reference.lineStart;
    const lineEnd = reference.lineEnd;
    if (
      !Number.isInteger(lineStart)
      || !Number.isInteger(lineEnd)
      || (lineStart as number) < bounds.lineStart
      || (lineEnd as number) > bounds.lineEnd
      || (lineStart as number) > (lineEnd as number)
    ) {
      throw new Error(
        `OpenAI returned an out-of-range source reference for ${field}`
        + ` (expected lines ${bounds.lineStart}-${bounds.lineEnd})`,
      );
    }
    const key = `${lineStart}:${lineEnd}`;
    if (!seen.has(key)) {
      seen.add(key);
      references.push({
        lineStart: lineStart as number,
        lineEnd: lineEnd as number,
      });
    }
  }
  return references;
}

function parseStoryEventBeatAgency(
  value: unknown,
  field: string,
): StoryEventBeatAgency {
  switch (value) {
    case "intentional":
    case "involuntary":
    case "external":
    case "ambiguous":
      return value;
    default:
      throw new Error(`OpenAI returned invalid agency for ${field}`);
  }
}

function parseStoryEventBeatStakes(
  value: unknown,
  field: string,
): ChoiceStakes {
  switch (value) {
    case "routine":
    case "significant":
    case "critical":
      return value;
    default:
      throw new Error(`OpenAI returned invalid stakes for ${field}`);
  }
}

export function deduplicateAliases(name: string, aliases: string[]): string[] {
  const seen = new Set([normalizeCharacterIdentity(name)]);
  return aliases.filter((alias) => {
    const key = normalizeCharacterIdentity(alias);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function compactIdentityText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function isGenericCharacterLabel(value: string): boolean {
  return /^(?:unknown|unnamed|other|additional|several|various)\b/iu.test(value.trim());
}

export function validateCharacterNameEvidence(
  character: ChapterPartSourceIndex["characters"][number],
  bounds: ChapterPartBounds,
): void {
  if (!bounds.sourceText || isGenericCharacterLabel(character.name)) return;
  const evidence = compactIdentityText(bounds.sourceText);
  const labels = [character.name, ...character.aliases]
    .map(compactIdentityText)
    .filter(Boolean);
  if (labels.some((label) => evidence.includes(label))) return;
  throw new Error(
    `OpenAI returned character ${JSON.stringify(character.name)} without that name or alias`
    + ` anywhere in the source text for ${bounds.sourceId}`,
  );
}

export function buildIdentityResolver(
  characters: ChapterPartSourceIndex["characters"],
  subject: string,
): Map<string, string> {
  const identities = new Map<string, string>();

  for (const character of characters) {
    const canonicalKey = normalizeCharacterIdentity(character.name);
    if (!canonicalKey) {
      throw new Error(`OpenAI returned an empty normalized character name for ${subject}`);
    }
    const owner = identities.get(canonicalKey);
    if (owner && owner !== character.name) {
      throw new Error(
        `OpenAI returned duplicate canonical characters ${owner} and ${character.name}`,
      );
    }
    identities.set(canonicalKey, character.name);
  }

  const aliasOwners = new Map<string, Set<string>>();
  for (const character of characters) {
    for (const alias of character.aliases) {
      const key = normalizeCharacterIdentity(alias);
      if (!key) {
        throw new Error(`OpenAI returned an empty normalized character identity for ${subject}`);
      }
      const owners = aliasOwners.get(key) ?? new Set<string>();
      owners.add(character.name);
      aliasOwners.set(key, owners);
    }
  }
  for (const [key, owners] of aliasOwners) {
    const canonicalOwner = identities.get(key);
    if (owners.size !== 1 || (canonicalOwner && !owners.has(canonicalOwner))) {
      continue;
    }
    identities.set(key, [...owners][0]!);
  }
  return identities;
}

export function resolveLocalCharacter(
  value: unknown,
  identities: Map<string, string>,
  field: string,
): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`OpenAI returned an invalid character reference for ${field}`);
  }
  const resolved = identities.get(normalizeCharacterIdentity(value));
  if (!resolved) {
    throw new Error(
      `OpenAI returned character reference ${JSON.stringify(value.trim())}`
      + ` for ${field} without a matching character observation`,
    );
  }
  return resolved;
}

export function resolveOrAddLocalCharacter(
  value: unknown,
  identities: Map<string, string>,
  characters: ChapterPartSourceIndex["characters"],
  references: SourceLineRange[],
  field: string,
): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`OpenAI returned an invalid character reference for ${field}`);
  }
  const name = value.trim();
  const key = normalizeCharacterIdentity(name);
  const resolved = identities.get(key);
  if (resolved) return resolved;

  characters.push({
    name,
    aliases: [],
    references: [...references],
  });
  identities.set(key, name);
  return name;
}

export function parseChapterPartSourceIndex(
  value: unknown,
  bounds: ChapterPartBounds,
): ChapterPartSourceIndex {
  if (!isRecord(value) || !isNonEmptyString(value.summary)) {
    throw new Error(`OpenAI returned an invalid source index for ${bounds.sourceId}`);
  }
  if (!Array.isArray(value.characters)) {
    throw new Error(`OpenAI returned an invalid character list for ${bounds.sourceId}`);
  }

  const characters = value.characters.map((character, index) => {
    if (!isRecord(character) || !isNonEmptyString(character.name)) {
      throw new Error(
        `OpenAI returned an invalid character observation ${index + 1} for ${bounds.sourceId}`,
      );
    }
    return {
      name: character.name.trim(),
      aliases: deduplicateAliases(
        character.name.trim(),
        parseStringList(
          character.aliases,
          `aliases for character ${character.name.trim()}`,
        ),
      ),
      references: parseLineRanges(
        character.references,
        bounds,
        `character ${character.name.trim()}`,
      ),
    };
  });
  for (const character of characters) {
    validateCharacterNameEvidence(character, bounds);
  }
  const identities = buildIdentityResolver(characters, bounds.sourceId);

  if (!Array.isArray(value.significantEvents)) {
    throw new Error(`OpenAI returned an invalid significant event list for ${bounds.sourceId}`);
  }
  const significantEvents = value.significantEvents.map((event, index) => {
    if (!isRecord(event) || !isNonEmptyString(event.description)) {
      throw new Error(
        `OpenAI returned an invalid significant event ${index + 1} for ${bounds.sourceId}`,
      );
    }
    const eventReferences = parseLineRanges(
      event.references,
      bounds,
      `significant event ${index + 1}`,
    );
    if (!Array.isArray(event.beats) || event.beats.length === 0) {
      throw new Error(`OpenAI returned no beats for significant event ${index + 1}`);
    }
    const beats = event.beats.map((beat, beatIndex) => {
      const field = `beat ${beatIndex + 1} of significant event ${index + 1}`;
      if (!isRecord(beat) || !isNonEmptyString(beat.action)) {
        throw new Error(`OpenAI returned an invalid ${field}`);
      }
      const beatReferences = parseLineRanges(beat.references, bounds, field);
      const agency = parseStoryEventBeatAgency(beat.agency, field);
      const stakes = parseStoryEventBeatStakes(beat.stakes, field);
      const actor = beat.actor === null
        ? null
        : resolveOrAddLocalCharacter(
            beat.actor,
            identities,
            characters,
            beatReferences,
            field,
          );
      if (agency === "external" && actor !== null) {
        throw new Error(`OpenAI returned an external ${field} with a character actor`);
      }
      if ((agency === "intentional" || agency === "involuntary") && actor === null) {
        throw new Error(`OpenAI returned ${agency} agency without an actor for ${field}`);
      }
      const targets = [...new Set(
        parseStringList(beat.targets, `targets for ${field}`)
          .map((target) => resolveOrAddLocalCharacter(
            target,
            identities,
            characters,
            beatReferences,
            field,
          )),
      )];
      return {
        actor,
        action: beat.action.trim(),
        targets,
        agency,
        stakes,
        references: beatReferences,
      };
    });
    const actors = [...new Set(
      beats.flatMap((beat) => beat.actor ? [beat.actor] : []),
    )];
    const targets = [...new Set(beats.flatMap((beat) => beat.targets))];
    const referenceKeys = new Set<string>();
    const references = [...eventReferences, ...beats.flatMap((beat) => beat.references)]
      .filter((reference) => {
        const key = `${reference.lineStart}:${reference.lineEnd}`;
        if (referenceKeys.has(key)) return false;
        referenceKeys.add(key);
        return true;
      })
      .sort((left, right) =>
        left.lineStart - right.lineStart
        || left.lineEnd - right.lineEnd
      );
    return {
      description: event.description.trim(),
      beats,
      actors,
      targets,
      references,
    };
  });

  if (!Array.isArray(value.actions)) {
    throw new Error(`OpenAI returned an invalid action list for ${bounds.sourceId}`);
  }
  const actions = value.actions.map((action, index) => {
    if (!isRecord(action) || !isNonEmptyString(action.description)) {
      throw new Error(`OpenAI returned an invalid action ${index + 1} for ${bounds.sourceId}`);
    }
    const references = parseLineRanges(action.references, bounds, `action ${index + 1}`);
    const actor = resolveOrAddLocalCharacter(
      action.actor,
      identities,
      characters,
      references,
      `action ${index + 1}`,
    );
    const targets = [...new Set(
      parseStringList(action.targets, `targets for action ${index + 1}`)
        .map((target) => resolveOrAddLocalCharacter(
          target,
          identities,
          characters,
          references,
          `action ${index + 1}`,
        )),
    )];
    return {
      actor,
      description: action.description.trim(),
      targets,
      references,
    };
  });

  if (!Array.isArray(value.relationships)) {
    throw new Error(`OpenAI returned an invalid relationship list for ${bounds.sourceId}`);
  }
  const relationships = value.relationships.flatMap((relationship, index) => {
    if (!isRecord(relationship) || !isNonEmptyString(relationship.description)) {
      throw new Error(
        `OpenAI returned an invalid relationship ${index + 1} for ${bounds.sourceId}`,
      );
    }
    const references = parseLineRanges(
      relationship.references,
      bounds,
      `relationship ${index + 1}`,
    );
    const character = resolveOrAddLocalCharacter(
      relationship.character,
      identities,
      characters,
      references,
      `relationship ${index + 1}`,
    );
    const relatedCharacter = resolveOrAddLocalCharacter(
      relationship.relatedCharacter,
      identities,
      characters,
      references,
      `relationship ${index + 1}`,
    );
    if (character === relatedCharacter) {
      return [];
    }
    return [{
      character,
      relatedCharacter,
      description: relationship.description.trim(),
      references,
    }];
  });

  return {
    summary: value.summary.trim(),
    significantEvents,
    characters,
    actions,
    relationships,
  };
}

export function sourceReferenceKey(reference: SourceReference): string {
  return [
    reference.chapterPosition,
    reference.chapterIndex,
    reference.lineStart,
    reference.lineEnd,
  ].join(":");
}

export function deduplicateReferences(references: SourceReference[]): SourceReference[] {
  const seen = new Set<string>();
  return references
    .filter((reference) => {
      const key = sourceReferenceKey(reference);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      left.chapterIndex - right.chapterIndex
      || left.lineStart - right.lineStart
      || left.lineEnd - right.lineEnd
    );
}

export function mergeChapterPartSourceIndexes(
  chapterPosition: number,
  chapterIndex: number,
  summary: string,
  parts: ChapterPartSourceIndex[],
): ChapterSourceIndex {
  const charactersByName = new Map<string, ChapterCharacterObservation>();
  for (const part of parts) {
    for (const character of part.characters) {
      const key = normalizeCharacterIdentity(character.name);
      const references = character.references.map((reference) => ({
        chapterPosition,
        chapterIndex,
        ...reference,
      }));
      const existing = charactersByName.get(key);
      if (!existing) {
        charactersByName.set(key, {
          name: character.name,
          aliases: [...character.aliases],
          sourceReferences: references,
        });
        continue;
      }

      const aliasKeys = new Set(existing.aliases.map(normalizeCharacterIdentity));
      for (const alias of character.aliases) {
        const aliasKey = normalizeCharacterIdentity(alias);
        if (!aliasKeys.has(aliasKey)) {
          existing.aliases.push(alias);
          aliasKeys.add(aliasKey);
        }
      }
      existing.sourceReferences = deduplicateReferences([
        ...existing.sourceReferences,
        ...references,
      ]);
    }
  }

  const actions: ChapterActionObservation[] = parts.flatMap((part) =>
    part.actions.map((action) => ({
      actor: action.actor,
      description: action.description,
      targets: action.targets,
      sourceReferences: action.references.map((reference) => ({
        chapterPosition,
        chapterIndex,
        ...reference,
      })),
    }))
  );
  const significantEvents = parts.flatMap((part) =>
    part.significantEvents.map((event) => ({
      description: event.description,
      actors: event.actors,
      targets: event.targets,
      beats: event.beats.map((beat) => ({
        actor: beat.actor,
        action: beat.action,
        targets: beat.targets,
        agency: beat.agency,
        stakes: beat.stakes,
        sourceReferences: beat.references.map((reference) => ({
          chapterPosition,
          chapterIndex,
          ...reference,
        })),
      })),
      sourceReferences: event.references.map((reference) => ({
        chapterPosition,
        chapterIndex,
        ...reference,
      })),
    }))
  ).sort((left, right) =>
    left.sourceReferences[0]!.lineStart - right.sourceReferences[0]!.lineStart
    || left.sourceReferences[0]!.lineEnd - right.sourceReferences[0]!.lineEnd
  );
  const relationships: ChapterRelationshipObservation[] = parts.flatMap((part) =>
    part.relationships.map((relationship) => ({
      character: relationship.character,
      relatedCharacter: relationship.relatedCharacter,
      description: relationship.description,
      sourceReferences: relationship.references.map((reference) => ({
        chapterPosition,
        chapterIndex,
        ...reference,
      })),
    }))
  );

  return {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary,
    significantEvents,
    characters: [...charactersByName.values()],
    actions,
    relationships,
  };
}
