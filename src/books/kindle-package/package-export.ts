import path from "node:path";
import type {
  ImportedBook,
} from "../../shared/contracts.js";
import {
  dataDir,
} from "../../util/env.js";
import {
  normalizeCharacterIdentity,
} from "../source-index.js";
import {
  KINDLE_PACKAGE_SCHEMA_VERSION,
  INDEX_PAGE_SIZE,
  packagePath,
  chapterFilename,
  chapterTextChunks,
  contentPages,
  characterFilename,
  characterTimelineFilename,
  characterTimelineShardFilename,
  characterOverviewFilename,
  characterAvailabilityFilename,
  compareText,
  compareByKindleReference,
  kindleReferences,
  kindleAction,
  kindleRelationship,
  foldedSearchKey,
  searchShardKey,
  addLookup,
  writeJsonAtomic,
  packageFingerprint,
  validateBookId,
} from "./layout.js";
import type {
  KindleSourceReference,
  KindleRelationship,
  KindleIncomingAction,
  KindleAction,
  KindleCharacterDetail,
  KindleCharacterCatalogEntry,
  KindlePackageResult,
} from "./layout.js";
import {
  exportKindleAnalysisCheckpoint,
  requireIndexedProfiles,
} from "./analysis-checkpoint.js";

export async function exportKindlePackage(
  book: ImportedBook,
  rootDirectory = path.join(dataDir(), "kindle"),
): Promise<KindlePackageResult> {
  validateBookId(book.bookId);
  const profiles = requireIndexedProfiles(book);
  await exportKindleAnalysisCheckpoint(book, rootDirectory);
  const profilesById = new Map(profiles.map((profile) => [profile.characterId!, profile]));
  const incoming = new Map<string, KindleRelationship[]>(
    profiles.map((profile) => [profile.characterId!, []]),
  );
  const incomingActions = new Map<string, KindleIncomingAction[]>(
    profiles.map((profile) => [profile.characterId!, []]),
  );
  const outgoing = new Map<string, KindleRelationship[]>();
  const actions = new Map<string, KindleAction[]>();

  for (const profile of profiles) {
    const sourceId = profile.characterId!;
    const profileRelationships = profile.relationships.map((relationship, index) => {
      const converted = kindleRelationship(
        book,
        relationship,
        profilesById,
        `relationship ${index + 1} of ${profile.name}`,
      );
      incoming.get(converted.characterId)!.push({
        characterId: sourceId,
        character: profile.name,
        description: converted.description,
        sourceReferences: converted.sourceReferences,
      });
      return converted;
    });
    outgoing.set(sourceId, profileRelationships);
    actions.set(
      sourceId,
      (profile.actions ?? []).map((action, index) =>
        kindleAction(book, action, profilesById, `action ${index + 1} of ${profile.name}`)
      ),
    );
    for (const action of actions.get(sourceId)!) {
      for (const targetId of new Set(action.targets.map((target) => target.characterId))) {
        incomingActions.get(targetId)!.push({
          actor: {
            characterId: sourceId,
            character: profile.name,
          },
          ...action,
        });
      }
    }
  }

  const packageId = `package_${packageFingerprint(book)}`;
  const packageDirectory = path.join(rootDirectory, book.bookId, "packages", packageId);
  const catalog: KindleCharacterCatalogEntry[] = [];
  const relationshipEdges: Array<{
    sourceCharacterId: string;
    sourceCharacter: string;
    targetCharacterId: string;
    targetCharacter: string;
    description: string;
    sourceReferences: KindleSourceReference[];
  }> = [];
  const actionEvents: Array<{
    actorCharacterId: string;
    actorCharacter: string;
    description: string;
    targets: KindleAction["targets"];
    sourceReferences: KindleSourceReference[];
  }> = [];
  const timelinePositionsByCharacter = new Map<string, Set<number>>();

  for (const profile of profiles) {
    const characterId = profile.characterId!;
    const profileOutgoing = outgoing.get(characterId) ?? [];
    const profileIncoming = (incoming.get(characterId) ?? [])
      .sort((left, right) => compareText(left.characterId, right.characterId));
    const profileActions = actions.get(characterId) ?? [];
    const profileIncomingActions = (incomingActions.get(characterId) ?? [])
      .sort(compareByKindleReference);
    const sourceReferences = kindleReferences(
      book,
      profile.sourceReferences,
      `character ${profile.name}`,
    );
    const timelinePositions = [...new Set([
      ...sourceReferences.map((reference) => reference.chapterPosition),
      ...profileActions.flatMap((action) =>
        action.sourceReferences.map((reference) => reference.chapterPosition)
      ),
      ...profileIncomingActions.flatMap((action) =>
        action.sourceReferences.map((reference) => reference.chapterPosition)
      ),
      ...profileOutgoing.flatMap((relationship) =>
        relationship.sourceReferences.map((reference) => reference.chapterPosition)
      ),
      ...profileIncoming.flatMap((relationship) =>
        relationship.sourceReferences.map((reference) => reference.chapterPosition)
      ),
    ])].sort((left, right) => left - right);
    timelinePositionsByCharacter.set(characterId, new Set(timelinePositions));
    const timeline: KindleCharacterDetail["timeline"] = [];
    for (const chapterPosition of timelinePositions) {
      const chapter = book.chapters[chapterPosition];
      if (!chapter) {
        throw new Error(`Character ${profile.name} references an unknown chapter`);
      }
      const inChapter = (reference: KindleSourceReference): boolean =>
        reference.chapterPosition === chapterPosition;
      const presenceReferences = sourceReferences.filter(inChapter);
      const performed = profileActions
        .map((action) => ({
          ...action,
          sourceReferences: action.sourceReferences.filter(inChapter),
        }))
        .filter((action) => action.sourceReferences.length > 0);
      const received = profileIncomingActions
        .map((action) => ({
          ...action,
          sourceReferences: action.sourceReferences.filter(inChapter),
        }))
        .filter((action) => action.sourceReferences.length > 0);
      const outgoingRelationships = profileOutgoing
        .map((relationship) => ({
          ...relationship,
          sourceReferences: relationship.sourceReferences.filter(inChapter),
        }))
        .filter((relationship) => relationship.sourceReferences.length > 0);
      const incomingRelationships = profileIncoming
        .map((relationship) => ({
          ...relationship,
          sourceReferences: relationship.sourceReferences.filter(inChapter),
        }))
        .filter((relationship) => relationship.sourceReferences.length > 0);
      const timelineFile = characterTimelineFilename(characterId, chapterPosition);
      const timelineShards = [
        {
          key: "presence",
          file: characterTimelineShardFilename(characterId, chapterPosition, "presence"),
          items: presenceReferences,
        },
        {
          key: "actionsPerformed",
          file: characterTimelineShardFilename(characterId, chapterPosition, "actions-performed"),
          items: performed,
        },
        {
          key: "actionsReceived",
          file: characterTimelineShardFilename(characterId, chapterPosition, "actions-received"),
          items: received,
        },
        {
          key: "relationshipsOutgoing",
          file: characterTimelineShardFilename(
            characterId,
            chapterPosition,
            "relationships-outgoing",
          ),
          items: outgoingRelationships,
        },
        {
          key: "relationshipsIncoming",
          file: characterTimelineShardFilename(
            characterId,
            chapterPosition,
            "relationships-incoming",
          ),
          items: incomingRelationships,
        },
      ].filter((shard) => shard.items.length > 0);
      await Promise.all(timelineShards.map((shard) =>
        writeJsonAtomic(path.join(packageDirectory, ...shard.file.split("/")), {
          schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
          characterId,
          chapterPosition,
          items: shard.items,
        })
      ));
      await writeJsonAtomic(
        path.join(packageDirectory, ...timelineFile.split("/")),
        {
          schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
          characterId,
          name: profile.name,
          chapterPosition,
          chapterIndex: chapter.index,
          shards: Object.fromEntries(timelineShards.map((shard) => [
            shard.key,
            { file: shard.file, count: shard.items.length },
          ])),
        },
      );
      timeline.push({
        chapterPosition,
        chapterIndex: chapter.index,
        file: timelineFile,
      });
    }
    const relatedCharacterIds = [...new Set([
      ...profileOutgoing.map((relationship) => relationship.characterId),
      ...profileIncoming.map((relationship) => relationship.characterId),
      ...profileActions.flatMap((action) =>
        action.targets.map((target) => target.characterId)
      ),
      ...profileIncomingActions.map((action) => action.actor.characterId),
    ])].sort();
    const detailFile = characterFilename(characterId);
    const overviewFile = characterOverviewFilename(characterId);

    const detail: KindleCharacterDetail = {
      schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
      characterId,
      name: profile.name,
      aliases: profile.aliases,
      firstSeen: sourceReferences[0]!,
      overviewFile,
      timelineIndexScope: "whole_book",
      timeline,
    };
    const profileIdentityKeys = new Set(
      [profile.name, ...profile.aliases].map(normalizeCharacterIdentity),
    );
    const identityResolutions = (book.worldBible?.identityResolutions ?? [])
      .filter((resolution) =>
        profileIdentityKeys.has(normalizeCharacterIdentity(resolution.canonicalName))
      )
      .map((resolution) => ({
        canonicalName: resolution.canonicalName,
        alias: resolution.alias,
        decision: resolution.decision,
        confidence: resolution.confidence,
        sourceReferences: kindleReferences(
          book,
          resolution.sourceReferences,
          `identity resolution ${resolution.canonicalName}/${resolution.alias}`,
        ),
      }));
    await writeJsonAtomic(path.join(packageDirectory, ...overviewFile.split("/")), {
      schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
      spoilerScope: "whole_book",
      characterId,
      name: profile.name,
      role: profile.role,
      description: profile.description,
      traits: profile.traits,
      storyArc: profile.storyArc,
      identityResolutions,
      counts: {
        actions: profileActions.length,
        targetedByActions: profileIncomingActions.length,
        outgoingRelationships: profileOutgoing.length,
        incomingRelationships: profileIncoming.length,
      },
      relatedCharacterIds,
    });
    await writeJsonAtomic(path.join(packageDirectory, ...detailFile.split("/")), detail);

    catalog.push({
      characterId,
      name: profile.name,
      aliases: profile.aliases,
      detailFile,
      overviewFile,
      firstSeen: sourceReferences[0]!,
    });
    for (const relationship of profileOutgoing) {
      relationshipEdges.push({
        sourceCharacterId: characterId,
        sourceCharacter: profile.name,
        targetCharacterId: relationship.characterId,
        targetCharacter: relationship.character,
        description: relationship.description,
        sourceReferences: relationship.sourceReferences,
      });
    }
    for (const action of profileActions) {
      actionEvents.push({
        actorCharacterId: characterId,
        actorCharacter: profile.name,
        description: action.description,
        targets: action.targets,
        sourceReferences: action.sourceReferences,
      });
    }
  }
  catalog.sort((left, right) =>
    compareText(normalizeCharacterIdentity(left.name), normalizeCharacterIdentity(right.name))
    || compareText(left.characterId, right.characterId)
  );

  const searchEntries: Array<{
    characterId: string;
    label: string;
    normalized: string;
    folded: string;
    detailFile: string;
    overviewFile: string;
    firstSeen: KindleSourceReference;
  }> = [];
  for (const character of catalog) {
    for (const label of [character.name, ...character.aliases]) {
      const normalized = normalizeCharacterIdentity(label);
      const folded = foldedSearchKey(label);
      searchEntries.push({
        characterId: character.characterId,
        label,
        normalized,
        folded,
        detailFile: character.detailFile,
        overviewFile: character.overviewFile,
        firstSeen: character.firstSeen,
      });
    }
  }
  searchEntries.sort((left, right) =>
    compareText(left.normalized, right.normalized)
    || compareText(left.label, right.label)
    || compareText(left.characterId, right.characterId)
  );

  const chapterCatalog = book.chapters.map((chapter, chapterPosition) => {
    const file = chapterFilename(chapterPosition);
    const chapterCharacterIds = profiles
      .filter((profile) =>
        timelinePositionsByCharacter.get(profile.characterId!)?.has(chapterPosition)
      )
      .map((profile) => profile.characterId!)
      .sort();
    return {
      chapterPosition,
      chapterIndex: chapter.index,
      title: chapter.title,
      lineCount: chapter.text.trim().split(/\r?\n/).length,
      file,
      availableCharactersFile: characterAvailabilityFilename(chapterPosition),
      characterIds: chapterCharacterIds,
    };
  });

  await Promise.all(book.chapters.map(async (chapter, chapterPosition) => {
    const chapterEntry = chapterCatalog[chapterPosition]!;
    const textChunks = chapterTextChunks(chapterPosition, chapter.text);
    await Promise.all(textChunks.map((chunk) =>
      writeJsonAtomic(path.join(packageDirectory, ...chunk.file.split("/")), {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        chapterPosition,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        lines: chunk.lines,
      })
    ));
    await writeJsonAtomic(
      path.join(packageDirectory, ...chapterEntry.file.split("/")),
      {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        chapterPosition,
        chapterIndex: chapter.index,
        title: chapter.title,
        lineCount: chapterEntry.lineCount,
        textFiles: textChunks.map(({ lineStart, lineEnd, file }) => ({
          lineStart,
          lineEnd,
          file,
        })),
        availableCharactersFile: chapterEntry.availableCharactersFile,
        characterIds: chapterEntry.characterIds,
      },
    );
  }));
  const availabilityFiles = chapterCatalog.map((chapter) => ({
    chapterPosition: chapter.chapterPosition,
    file: chapter.availableCharactersFile,
    characters: catalog.filter(
      (character) => character.firstSeen.chapterPosition <= chapter.chapterPosition,
    ),
  }));

  const characterPages = Array.from(
    { length: Math.ceil(catalog.length / INDEX_PAGE_SIZE) },
    (_, pageIndex) => {
      const characters = catalog.slice(
        pageIndex * INDEX_PAGE_SIZE,
        (pageIndex + 1) * INDEX_PAGE_SIZE,
      );
      return {
        file: packagePath("characters", "pages", `${String(pageIndex).padStart(4, "0")}.json`),
        count: characters.length,
        firstCharacter: characters[0]?.name,
        lastCharacter: characters.at(-1)?.name,
        characters,
      };
    },
  );
  const searchShards = new Map<string, typeof searchEntries>();
  for (const entry of searchEntries) {
    const key = searchShardKey(entry.folded || entry.normalized);
    searchShards.set(key, [...(searchShards.get(key) ?? []), entry]);
  }
  const searchShardIndex = [...searchShards.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, entries]) => ({
      key,
      file: packagePath("search", "shards", `${key}.json`),
      count: entries.length,
      entries,
    }));
  const actionsByChapter = new Map<number, typeof actionEvents>();
  for (const action of actionEvents) {
    const chapterPosition = action.sourceReferences[0]!.chapterPosition;
    actionsByChapter.set(
      chapterPosition,
      [...(actionsByChapter.get(chapterPosition) ?? []), action],
    );
  }
  const relationshipsByChapter = new Map<number, typeof relationshipEdges>();
  for (const relationship of relationshipEdges) {
    const chapterPosition = relationship.sourceReferences[0]!.chapterPosition;
    relationshipsByChapter.set(
      chapterPosition,
      [...(relationshipsByChapter.get(chapterPosition) ?? []), relationship],
    );
  }
  const actionShards = [...actionsByChapter.entries()]
    .sort(([left], [right]) => left - right)
    .map(([chapterPosition, chapterActions]) => {
      const chapterDirectory = packagePath(
        "actions",
        String(chapterPosition).padStart(4, "0"),
      );
      return {
        chapterPosition,
        file: packagePath(chapterDirectory, "index.json"),
        count: chapterActions.length,
        pages: contentPages(chapterActions).map((actions, pageIndex) => ({
          file: packagePath(
            chapterDirectory,
            "pages",
            `${String(pageIndex).padStart(4, "0")}.json`,
          ),
          count: actions.length,
          actions,
        })),
      };
    });
  const relationshipShards = [...relationshipsByChapter.entries()]
    .sort(([left], [right]) => left - right)
    .map(([chapterPosition, chapterRelationships]) => {
      const chapterDirectory = packagePath(
        "relationships",
        String(chapterPosition).padStart(4, "0"),
      );
      return {
        chapterPosition,
        file: packagePath(chapterDirectory, "index.json"),
        count: chapterRelationships.length,
        pages: contentPages(chapterRelationships).map((relationships, pageIndex) => ({
          file: packagePath(
            chapterDirectory,
            "pages",
            `${String(pageIndex).padStart(4, "0")}.json`,
          ),
          count: relationships.length,
          relationships,
        })),
      };
    });
  const chapterPages = Array.from(
    { length: Math.ceil(chapterCatalog.length / INDEX_PAGE_SIZE) },
    (_, pageIndex) => {
      const chapters = chapterCatalog.slice(
        pageIndex * INDEX_PAGE_SIZE,
        (pageIndex + 1) * INDEX_PAGE_SIZE,
      );
      return {
        file: packagePath("chapters", "pages", `${String(pageIndex).padStart(4, "0")}.json`),
        count: chapters.length,
        firstChapterPosition: chapters[0]?.chapterPosition,
        lastChapterPosition: chapters.at(-1)?.chapterPosition,
        chapters,
      };
    },
  );

  const indexFiles = {
    characters: "characters/index.json",
    search: "search/index.json",
    relationships: "relationships/index.json",
    actions: "actions/index.json",
    chapters: "chapters/index.json",
  };
  await Promise.all([
    ...characterPages.map(({ file, characters }) =>
      writeJsonAtomic(path.join(packageDirectory, ...file.split("/")), {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        characters,
      })
    ),
    ...searchShardIndex.map(({ file, entries }) => {
      const lookup = Object.create(null) as Record<string, string[]>;
      for (const entry of entries) {
        addLookup(lookup, entry.normalized, entry.characterId);
        addLookup(lookup, entry.folded, entry.characterId);
      }
      return writeJsonAtomic(path.join(packageDirectory, ...file.split("/")), {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        lookup,
        entries,
      });
    }),
    ...actionShards.flatMap(({ file, pages }) => [
      writeJsonAtomic(path.join(packageDirectory, ...file.split("/")), {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        pages: pages.map(({ actions: _, ...page }) => page),
      }),
      ...pages.map(({ file: pageFile, actions: pageActions }) =>
        writeJsonAtomic(path.join(packageDirectory, ...pageFile.split("/")), {
          schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
          actions: pageActions,
        })
      ),
    ]),
    ...relationshipShards.flatMap(({ file, pages }) => [
      writeJsonAtomic(path.join(packageDirectory, ...file.split("/")), {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        pages: pages.map(({ relationships: _, ...page }) => page),
      }),
      ...pages.map(({ file: pageFile, relationships: pageRelationships }) =>
        writeJsonAtomic(path.join(packageDirectory, ...pageFile.split("/")), {
          schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
          relationships: pageRelationships,
        })
      ),
    ]),
    ...chapterPages.map(({ file, chapters }) =>
      writeJsonAtomic(path.join(packageDirectory, ...file.split("/")), {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        chapters,
      })
    ),
    ...availabilityFiles.map(({ chapterPosition, file, characters }) =>
      writeJsonAtomic(path.join(packageDirectory, ...file.split("/")), {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        chapterPosition,
        rule: "firstSeen.chapterPosition < chapterPosition or firstSeen.lineStart <= selectedLine",
        characters,
      })
    ),
    writeJsonAtomic(path.join(packageDirectory, indexFiles.characters), {
      schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
      count: catalog.length,
      pages: characterPages.map(({ characters: _, ...page }) => page),
      availability: {
        strategy: "cumulative_by_chapter_then_first_seen_line",
        chapters: availabilityFiles.map(({ characters: _, ...entry }) => ({
          ...entry,
          count: catalog.filter(
            (character) => character.firstSeen.chapterPosition <= entry.chapterPosition,
          ).length,
        })),
      },
    }),
    writeJsonAtomic(path.join(packageDirectory, indexFiles.search), {
      schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
      shards: searchShardIndex.map(({ entries: _, ...shard }) => shard),
    }),
    writeJsonAtomic(path.join(packageDirectory, indexFiles.relationships), {
      schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
      count: relationshipEdges.length,
      chapters: relationshipShards.map(({ pages: _, ...shard }) => shard),
    }),
    writeJsonAtomic(path.join(packageDirectory, indexFiles.actions), {
      schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
      count: actionEvents.length,
      chapters: actionShards.map(({ pages: _, ...shard }) => shard),
    }),
    writeJsonAtomic(path.join(packageDirectory, indexFiles.chapters), {
      schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
      count: chapterCatalog.length,
      pages: chapterPages.map(({ chapters: _, ...page }) => page),
    }),
  ]);

  const manifestFile = path.join(packageDirectory, "manifest.json");
  await writeJsonAtomic(manifestFile, {
    schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
    packageId,
    book: {
      bookId: book.bookId,
      sourceSha256: book.sourceSha256,
      title: book.title,
      author: book.author,
      importedAt: book.importedAt,
    },
    counts: {
      chapters: book.chapters.length,
      characters: profiles.length,
      actions: [...actions.values()].reduce((total, items) => total + items.length, 0),
      relationships: relationshipEdges.length,
    },
    files: indexFiles,
  });

  await writeJsonAtomic(path.join(rootDirectory, book.bookId, "current.json"), {
    schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
    packageId,
    manifest: packagePath("packages", packageId, "manifest.json"),
  });

  return {
    packageId,
    directory: packageDirectory,
    manifestFile,
    characterCount: profiles.length,
    chapterCount: book.chapters.length,
  };
}
