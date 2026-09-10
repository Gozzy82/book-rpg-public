import {
  createHash,
} from "node:crypto";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
  MIN_VERIFIED_IDENTITY_CONFIDENCE,
  WORLD_BIBLE_SCHEMA_VERSION,
} from "../../shared/contracts.js";
import type {
  CharacterIdentityResolution,
  CharacterAction,
  CharacterProfile,
  CharacterRelationship,
  ImportedBook,
  SourceReference,
  WorldBible,
} from "../../shared/contracts.js";
import {
  isRecord,
  isNonEmptyString,
  normalizeCharacterIdentity,
  buildVerifiedIdentityResolver,
  parseStringList,
  deduplicateAliases,
  sourceReferenceKey,
  deduplicateReferences,
} from "./chapter-index.js";

export function stableCharacterId(bookId: string, name: string): string {
  const digest = createHash("sha256")
    .update(`${bookId}\0${normalizeCharacterIdentity(name)}`)
    .digest("hex")
    .slice(0, 20);
  return `character_${digest}`;
}

export interface RawCharacterProfile {
  name: string;
  aliases: string[];
  role: string;
  description: string;
  traits: string[];
  storyArc: string;
}

export function parseRawCharacterProfiles(value: unknown): RawCharacterProfile[] {
  if (!Array.isArray(value)) {
    throw new Error("OpenAI returned an invalid whole-book character profile list");
  }

  return value.map((profile, index) => {
    if (
      !isRecord(profile)
      || !isNonEmptyString(profile.name)
      || !isNonEmptyString(profile.role)
      || !isNonEmptyString(profile.description)
      || !isNonEmptyString(profile.storyArc)
    ) {
      throw new Error(`OpenAI returned an invalid profile for character ${index + 1}`);
    }

    const name = profile.name.trim();
    return {
      name,
      aliases: deduplicateAliases(
        name,
        parseStringList(profile.aliases, `aliases for character ${profile.name}`),
      ),
      role: profile.role.trim(),
      description: profile.description.trim(),
      traits: [...new Set(parseStringList(
        profile.traits,
        `traits for character ${profile.name}`,
      ))],
      storyArc: profile.storyArc.trim(),
    };
  });
}

export function mergeOverlappingProfiles(profiles: RawCharacterProfile[]): RawCharacterProfile[] {
  const parents = profiles.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const ownerByIdentity = new Map<string, number>();

  for (const [index, profile] of profiles.entries()) {
    for (const label of [profile.name, ...profile.aliases]) {
      const key = normalizeCharacterIdentity(label);
      const owner = ownerByIdentity.get(key);
      if (owner === undefined) {
        ownerByIdentity.set(key, index);
      } else {
        union(owner, index);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (const index of profiles.keys()) {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  }

  return [...groups.values()].map((indexes) => {
    const primary = profiles[indexes[0]!]!;
    const aliases = indexes.flatMap((index) => {
      const profile = profiles[index]!;
      return index === indexes[0] ? profile.aliases : [profile.name, ...profile.aliases];
    });
    return {
      ...primary,
      aliases: deduplicateAliases(primary.name, aliases),
      traits: [...new Set(indexes.flatMap((index) => profiles[index]!.traits))],
    };
  });
}

export function completeObservedProfiles(
  book: Pick<ImportedBook, "chapters">,
  profiles: RawCharacterProfile[],
  resolveIdentity: (value: string) => string = normalizeCharacterIdentity,
): RawCharacterProfile[] {
  const completed = profiles.map((profile) => ({
    ...profile,
    aliases: [...profile.aliases],
    traits: [...profile.traits],
  }));
  const owners = new Map<string, number>();

  const register = (label: string, owner: number): void => {
    const key = resolveIdentity(label);
    const existing = owners.get(key);
    if (existing !== undefined && existing !== owner) {
      throw new Error(
        `OpenAI returned the ambiguous identity ${JSON.stringify(label)}`
        + ` for both ${completed[existing]!.name} and ${completed[owner]!.name}`,
      );
    }
    owners.set(key, owner);
  };

  for (const [index, profile] of completed.entries()) {
    for (const label of [profile.name, ...profile.aliases]) {
      register(label, index);
    }
  }

  for (const chapter of book.chapters) {
    for (const observation of chapter.sourceIndex?.characters ?? []) {
      const labels = [observation.name, ...observation.aliases];
      const canonicalKey = resolveIdentity(observation.name);
      let owner = owners.get(canonicalKey);
      if (owner === undefined) {
        const aliasOwners = new Set(
          observation.aliases.flatMap((alias) => {
            const aliasOwner = owners.get(resolveIdentity(alias));
            return aliasOwner === undefined ? [] : [aliasOwner];
          }),
        );
        if (aliasOwners.size === 1) {
          owner = [...aliasOwners][0]!;
        } else {
          owner = completed.length;
          completed.push({
            name: observation.name.trim(),
            aliases: [],
            role: "Observed character",
            description: "A character evidenced by the chapter source index.",
            traits: [],
            storyArc: "See the source-backed character timeline.",
          });
        }
      }

      const profile = completed[owner]!;
      const known = new Set(
        [profile.name, ...profile.aliases].map(normalizeCharacterIdentity),
      );
      for (const label of labels) {
        const key = normalizeCharacterIdentity(label);
        const existingOwner = owners.get(resolveIdentity(label));
        if (existingOwner !== undefined && existingOwner !== owner) continue;
        if (!known.has(key)) {
          profile.aliases.push(label.trim());
          known.add(key);
        }
        register(label, owner);
      }
    }
  }

  return completed;
}

export function buildGlobalIdentityResolver(
  bookId: string,
  profiles: RawCharacterProfile[],
): { identities: Map<string, number>; characterIds: string[] } {
  const identities = new Map<string, number>();
  const characterIds: string[] = [];
  const ids = new Set<string>();

  for (const [index, profile] of profiles.entries()) {
    const canonicalKey = normalizeCharacterIdentity(profile.name);
    const characterId = stableCharacterId(bookId, profile.name);
    if (!canonicalKey || ids.has(characterId)) {
      throw new Error(`OpenAI returned a duplicate canonical character: ${profile.name}`);
    }
    ids.add(characterId);
    characterIds.push(characterId);

    const localIdentities = new Set<string>();
    for (const label of [profile.name, ...profile.aliases]) {
      const key = normalizeCharacterIdentity(label);
      if (!key || localIdentities.has(key)) {
        throw new Error(`OpenAI returned a duplicate identity for character ${profile.name}`);
      }
      localIdentities.add(key);

      const owner = identities.get(key);
      if (owner !== undefined && owner !== index) {
        throw new Error(
          `OpenAI returned the ambiguous identity ${JSON.stringify(label)}`
          + ` for both ${profiles[owner]!.name} and ${profile.name}`,
        );
      }
      identities.set(key, index);
    }
  }
  return { identities, characterIds };
}

export interface CharacterEvidence {
  sourceReferences: SourceReference[];
  actions: CharacterAction[];
  relationships: CharacterRelationship[];
  actionKeys: Set<string>;
  relationshipKeys: Set<string>;
}

export function validateStoredReferences(
  value: unknown,
  chapterPosition: number,
  chapter: ImportedBook["chapters"][number],
  field: string,
): SourceReference[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Stored source index has no references for ${field}`);
  }
  const lineCount = chapter.text.trim().split(/\r?\n/).length;
  return deduplicateReferences(value.map((reference) => {
    if (
      !isRecord(reference)
      || !Number.isInteger(reference.chapterPosition)
      || !Number.isInteger(reference.chapterIndex)
      || !Number.isInteger(reference.lineStart)
      || !Number.isInteger(reference.lineEnd)
      || reference.chapterPosition !== chapterPosition
      || reference.chapterIndex !== chapter.index
      || (reference.lineStart as number) < 1
      || (reference.lineStart as number) > (reference.lineEnd as number)
      || (reference.lineEnd as number) > lineCount
    ) {
      throw new Error(`Stored source index has an invalid reference for ${field}`);
    }
    return {
      chapterPosition: reference.chapterPosition as number,
      chapterIndex: reference.chapterIndex as number,
      lineStart: reference.lineStart as number,
      lineEnd: reference.lineEnd as number,
    };
  }));
}

export function resolveObservedCharacter(
  value: string,
  localIdentities: Map<string, number>,
  field: string,
): number {
  const profileIndex = localIdentities.get(normalizeCharacterIdentity(value));
  if (profileIndex === undefined) {
    throw new Error(
      `Stored source index references unknown character ${JSON.stringify(value)} for ${field}`,
    );
  }
  return profileIndex;
}

export function buildCharacterEvidence(
  book: Pick<ImportedBook, "chapters">,
  profiles: RawCharacterProfile[],
  identities: Map<string, number>,
  characterIds: string[],
): CharacterEvidence[] {
  const evidence = profiles.map((): CharacterEvidence => ({
    sourceReferences: [],
    actions: [],
    relationships: [],
    actionKeys: new Set<string>(),
    relationshipKeys: new Set<string>(),
  }));

  for (const [chapterPosition, chapter] of book.chapters.entries()) {
    const sourceIndex = chapter.sourceIndex;
    if (sourceIndex?.schemaVersion !== CHAPTER_SOURCE_INDEX_VERSION) {
      throw new Error(`Chapter ${chapterPosition + 1} has no current source index`);
    }
    if (
      !Array.isArray(sourceIndex.characters)
      || !Array.isArray(sourceIndex.actions)
      || !Array.isArray(sourceIndex.relationships)
    ) {
      throw new Error(`Chapter ${chapterPosition + 1} has an invalid stored source index`);
    }

    const localIdentities = new Map<string, number>();
    for (const observation of sourceIndex.characters) {
      if (isRecord(observation) && isNonEmptyString(observation.name)) {
        const profileIndex = identities.get(normalizeCharacterIdentity(observation.name));
        if (profileIndex !== undefined) {
          localIdentities.set(normalizeCharacterIdentity(observation.name), profileIndex);
        }
      }
    }
    for (const observation of sourceIndex.characters) {
      if (
        !isRecord(observation)
        || !isNonEmptyString(observation.name)
        || !Array.isArray(observation.aliases)
        || !observation.aliases.every(isNonEmptyString)
      ) {
        throw new Error(`Chapter ${chapterPosition + 1} has an invalid character observation`);
      }
      const labels = [observation.name, ...observation.aliases];
      const profileIndex = identities.get(normalizeCharacterIdentity(observation.name));
      if (profileIndex === undefined) {
        throw new Error(
          `Character profile completion omitted ${JSON.stringify(observation.name)}`,
        );
      }
      for (const label of labels) {
        const key = normalizeCharacterIdentity(label);
        const existing = localIdentities.get(key);
        if (existing !== undefined && existing !== profileIndex) {
          continue;
        }
        localIdentities.set(key, profileIndex);
      }
      evidence[profileIndex]!.sourceReferences.push(
        ...validateStoredReferences(
          observation.sourceReferences,
          chapterPosition,
          chapter,
          `character ${observation.name}`,
        ),
      );
    }

    for (const [actionIndex, action] of sourceIndex.actions.entries()) {
      if (
        !isRecord(action)
        || !isNonEmptyString(action.actor)
        || !isNonEmptyString(action.description)
        || !Array.isArray(action.targets)
        || !action.targets.every(isNonEmptyString)
      ) {
        throw new Error(
          `Chapter ${chapterPosition + 1} has an invalid action ${actionIndex + 1}`,
        );
      }
      const actorIndex = resolveObservedCharacter(
        action.actor,
        localIdentities,
        `action ${actionIndex + 1}`,
      );
      const targetIndexes = [...new Set(action.targets.map((target) =>
        resolveObservedCharacter(target, localIdentities, `action ${actionIndex + 1}`)
      ))];
      const sourceReferences = validateStoredReferences(
        action.sourceReferences,
        chapterPosition,
        chapter,
        `action ${actionIndex + 1}`,
      );
      const actionKey = [
        normalizeCharacterIdentity(action.description),
        targetIndexes.join(","),
        sourceReferences.map(sourceReferenceKey).join(","),
      ].join("|");
      const actorEvidence = evidence[actorIndex]!;
      if (actorEvidence.actionKeys.has(actionKey)) continue;
      actorEvidence.actionKeys.add(actionKey);
      actorEvidence.actions.push({
        description: action.description.trim(),
        targets: targetIndexes.map((targetIndex) => ({
          characterId: characterIds[targetIndex],
          character: profiles[targetIndex]!.name,
        })),
        sourceReferences,
      });
    }

    for (const [relationshipIndex, relationship] of sourceIndex.relationships.entries()) {
      if (
        !isRecord(relationship)
        || !isNonEmptyString(relationship.character)
        || !isNonEmptyString(relationship.relatedCharacter)
        || !isNonEmptyString(relationship.description)
      ) {
        throw new Error(
          `Chapter ${chapterPosition + 1} has an invalid relationship`
          + ` ${relationshipIndex + 1}`,
        );
      }
      const characterIndex = resolveObservedCharacter(
        relationship.character,
        localIdentities,
        `relationship ${relationshipIndex + 1}`,
      );
      const relatedCharacterIndex = resolveObservedCharacter(
        relationship.relatedCharacter,
        localIdentities,
        `relationship ${relationshipIndex + 1}`,
      );
      if (characterIndex === relatedCharacterIndex) {
        continue;
      }
      const sourceReferences = validateStoredReferences(
        relationship.sourceReferences,
        chapterPosition,
        chapter,
        `relationship ${relationshipIndex + 1}`,
      );
      const relationshipKey = [
        relatedCharacterIndex,
        normalizeCharacterIdentity(relationship.description),
        sourceReferences.map(sourceReferenceKey).join(","),
      ].join("|");
      const characterEvidence = evidence[characterIndex]!;
      if (characterEvidence.relationshipKeys.has(relationshipKey)) continue;
      characterEvidence.relationshipKeys.add(relationshipKey);
      characterEvidence.relationships.push({
        characterId: characterIds[relatedCharacterIndex],
        character: profiles[relatedCharacterIndex]!.name,
        description: relationship.description.trim(),
        sourceReferences,
      });
    }
  }

  for (const [profileIndex, profileEvidence] of evidence.entries()) {
    profileEvidence.sourceReferences = deduplicateReferences(
      profileEvidence.sourceReferences,
    );
    profileEvidence.actions.sort(compareByFirstReference);
    profileEvidence.relationships.sort(compareByFirstReference);
  }
  return evidence;
}

export function compareByFirstReference(
  left: { sourceReferences?: SourceReference[] },
  right: { sourceReferences?: SourceReference[] },
): number {
  const leftReference = left.sourceReferences?.[0];
  const rightReference = right.sourceReferences?.[0];
  if (!leftReference || !rightReference) return 0;
  return leftReference.chapterPosition - rightReference.chapterPosition
    || leftReference.lineStart - rightReference.lineStart
    || leftReference.lineEnd - rightReference.lineEnd;
}

export function selectCoreCharacterProfiles(
  profiles: CharacterProfile[],
): CharacterProfile[] {
  if (profiles.length <= 10) {
    return profiles.map((profile) => ({
      ...profile,
      aliases: [...profile.aliases],
      traits: [...profile.traits],
      relationships: [...profile.relationships],
      actions: profile.actions?.map((action) => ({
        ...action,
        targets: [...action.targets],
      })),
      sourceReferences: profile.sourceReferences
        ? [...profile.sourceReferences]
        : undefined,
    }));
  }

  const ranked = profiles.map((profile, index) => {
    const references = profile.sourceReferences ?? [];
    const chapterCount = new Set(
      references.map((reference) => reference.chapterPosition),
    ).size;
    const eventCount = (profile.actions?.length ?? 0) + profile.relationships.length;
    const score = chapterCount * 20
      + eventCount * 4
      + references.length
      + Math.max(0, 15 - index) * 2;
    return { profile, index, chapterCount, eventCount, score };
  }).sort((left, right) =>
    right.score - left.score
    || left.index - right.index
  );

  const selected = ranked.slice(0, 10);
  const threshold = selected.at(-1)?.score ?? 0;
  selected.push(
    ...ranked.slice(10)
      .filter((candidate) =>
        (candidate.chapterCount >= 3 || candidate.eventCount >= 5)
        && candidate.score >= threshold * 0.5
      )
      .slice(0, 5),
  );

  const selectedIds = new Set(
    selected.flatMap(({ profile }) => profile.characterId ? [profile.characterId] : []),
  );
  return selected.map(({ profile }) => ({
    ...profile,
    aliases: [...profile.aliases],
    traits: [...profile.traits],
    relationships: profile.relationships.filter(
      (relationship) =>
        !relationship.characterId || selectedIds.has(relationship.characterId),
    ),
    actions: profile.actions?.map((action) => ({
      ...action,
      targets: action.targets.filter(
        (target) => !target.characterId || selectedIds.has(target.characterId),
      ),
    })),
    sourceReferences: profile.sourceReferences
      ? [...profile.sourceReferences]
      : undefined,
  }));
}

export function parseWorldBibleOutput(
  output: string,
  book: Pick<ImportedBook, "bookId" | "chapters">,
  identityResolutions: CharacterIdentityResolution[] = [],
): WorldBible {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !isNonEmptyString(parsed.summary)) {
    throw new Error("OpenAI returned an invalid whole-book summary");
  }
  const resolveVerifiedIdentity = buildVerifiedIdentityResolver(identityResolutions);
  const verifiedLabels = new Map<string, string[]>();
  for (const resolution of identityResolutions) {
    if (
      resolution.decision !== "same_person"
      || resolution.confidence < MIN_VERIFIED_IDENTITY_CONFIDENCE
    ) {
      continue;
    }
    const identity = resolveVerifiedIdentity(resolution.canonicalName);
    verifiedLabels.set(identity, [
      ...(verifiedLabels.get(identity) ?? []),
      resolution.canonicalName,
      resolution.alias,
    ]);
  }
  const parsedProfiles = parseRawCharacterProfiles(parsed.characterProfiles)
    .map((profile) => {
      const identity = resolveVerifiedIdentity(profile.name);
      return {
        ...profile,
        aliases: deduplicateAliases(profile.name, [
          ...profile.aliases.filter((alias) =>
            resolveVerifiedIdentity(alias) === identity
          ),
          ...(verifiedLabels.get(identity) ?? []),
        ]),
      };
    });
  const rawProfiles = completeObservedProfiles(
    book,
    mergeOverlappingProfiles(parsedProfiles),
    resolveVerifiedIdentity,
  );
  const { identities, characterIds } = buildGlobalIdentityResolver(book.bookId, rawProfiles);
  const evidence = buildCharacterEvidence(book, rawProfiles, identities, characterIds);

  const allProfiles: CharacterProfile[] = rawProfiles.flatMap((profile, profileIndex) => {
    const profileEvidence = evidence[profileIndex]!;
    return profileEvidence.sourceReferences.length === 0
      ? []
      : [{
          characterId: characterIds[profileIndex],
          name: profile.name,
          aliases: profile.aliases,
          role: profile.role,
          description: profile.description,
          traits: profile.traits,
          relationships: profileEvidence.relationships,
          actions: profileEvidence.actions,
          sourceReferences: profileEvidence.sourceReferences,
          storyArc: profile.storyArc,
        }];
  });

  const profiles = selectCoreCharacterProfiles(allProfiles);
  return {
    schemaVersion: WORLD_BIBLE_SCHEMA_VERSION,
    summary: parsed.summary.trim(),
    characters: profiles.map((profile) => profile.name),
    characterProfiles: profiles,
    identityResolutions,
    locations: parseStringList(parsed.locations, "locations"),
  };
}
