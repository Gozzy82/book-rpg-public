import path from "node:path";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
  WORLD_BIBLE_SCHEMA_VERSION,
} from "../../shared/contracts.js";
import type {
  CharacterProfile,
  ImportedBook,
} from "../../shared/contracts.js";
import {
  dataDir,
} from "../../util/env.js";
import {
  normalizeCharacterIdentity,
  selectCoreCharacterProfiles,
} from "../source-index.js";
import {
  KINDLE_PACKAGE_SCHEMA_VERSION,
  packagePath,
  chapterFilename,
  chapterTextChunks,
  compareText,
  kindleReferences,
  writeJsonAtomic,
  analysisId,
  candidateId,
  validateBookId,
} from "./layout.js";
import type {
  KindleAnalysisCheckpointResult,
} from "./layout.js";

export async function exportKindleAnalysisCheckpoint(
  book: ImportedBook,
  rootDirectory = path.join(dataDir(), "kindle"),
): Promise<KindleAnalysisCheckpointResult> {
  validateBookId(book.bookId);
  const currentAnalysisId = analysisId(book);
  const analysisDirectory = path.join(
    rootDirectory,
    book.bookId,
    "analysis",
    currentAnalysisId,
  );
  const completedChapters: Array<{
    chapterPosition: number;
    chapterIndex: number;
    title: string;
    file: string;
    characterCandidateIds: string[];
  }> = [];
  const candidates: Array<{
    candidateId: string;
    name: string;
    aliases: string[];
    chapterPosition: number;
    file: string;
  }> = [];

  for (const [chapterPosition, chapter] of book.chapters.entries()) {
    const sourceIndex = chapter.sourceIndex;
    if (sourceIndex?.schemaVersion !== CHAPTER_SOURCE_INDEX_VERSION) continue;
    const chapterFile = chapterFilename(chapterPosition);
    const chapterCandidates: string[] = [];

    for (const observation of sourceIndex.characters) {
      const currentCandidateId = candidateId(book, chapterPosition, observation.name);
      const file = packagePath("characters", `${currentCandidateId}.json`);
      const identities = new Set(
        [observation.name, ...observation.aliases].map(normalizeCharacterIdentity),
      );
      const observedActions = sourceIndex.actions
        .filter((action) => identities.has(normalizeCharacterIdentity(action.actor)))
        .map((action) => ({
          actor: action.actor,
          description: action.description,
          targets: action.targets,
          sourceReferences: kindleReferences(
            book,
            action.sourceReferences,
            `checkpoint action of ${observation.name}`,
          ),
        }));
      const receivedActions = sourceIndex.actions
        .filter((action) =>
          action.targets.some((target) =>
            identities.has(normalizeCharacterIdentity(target))
          )
        )
        .map((action) => ({
          actor: action.actor,
          description: action.description,
          targets: action.targets,
          sourceReferences: kindleReferences(
            book,
            action.sourceReferences,
            `checkpoint received action of ${observation.name}`,
          ),
        }));
      const outgoingRelationships = sourceIndex.relationships
        .filter((relationship) =>
          identities.has(normalizeCharacterIdentity(relationship.character))
        )
        .map((relationship) => ({
          character: relationship.character,
          relatedCharacter: relationship.relatedCharacter,
          description: relationship.description,
          sourceReferences: kindleReferences(
            book,
            relationship.sourceReferences,
            `checkpoint relationship of ${observation.name}`,
          ),
        }));
      const incomingRelationships = sourceIndex.relationships
        .filter((relationship) =>
          identities.has(normalizeCharacterIdentity(relationship.relatedCharacter))
        )
        .map((relationship) => ({
          character: relationship.character,
          relatedCharacter: relationship.relatedCharacter,
          description: relationship.description,
          sourceReferences: kindleReferences(
            book,
            relationship.sourceReferences,
            `checkpoint incoming relationship of ${observation.name}`,
          ),
        }));

      await writeJsonAtomic(path.join(analysisDirectory, ...file.split("/")), {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        provisional: true,
        candidateId: currentCandidateId,
        name: observation.name,
        aliases: observation.aliases,
        chapterPosition,
        chapterIndex: chapter.index,
        sourceReferences: kindleReferences(
          book,
          observation.sourceReferences,
          `checkpoint character ${observation.name}`,
        ),
        actions: {
          performed: observedActions,
          received: receivedActions,
        },
        relationships: {
          outgoing: outgoingRelationships,
          incoming: incomingRelationships,
        },
      });
      chapterCandidates.push(currentCandidateId);
      candidates.push({
        candidateId: currentCandidateId,
        name: observation.name,
        aliases: observation.aliases,
        chapterPosition,
        file,
      });
    }
    const textChunks = chapterTextChunks(chapterPosition, chapter.text);
    await Promise.all(textChunks.map((chunk) =>
      writeJsonAtomic(path.join(analysisDirectory, ...chunk.file.split("/")), {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        chapterPosition,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        lines: chunk.lines,
      })
    ));
    const sourceIndexFile = packagePath(
      "chapters",
      String(chapterPosition).padStart(4, "0"),
      "source-index.json",
    );
    await writeJsonAtomic(
      path.join(analysisDirectory, ...sourceIndexFile.split("/")),
      sourceIndex,
    );
    await writeJsonAtomic(
      path.join(analysisDirectory, ...chapterFile.split("/")),
      {
        schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
        chapterPosition,
        chapterIndex: chapter.index,
        title: chapter.title,
        lineCount: chapter.text.trim().split(/\r?\n/).length,
        textFiles: textChunks.map(({ lineStart, lineEnd, file }) => ({
          lineStart,
          lineEnd,
          file,
        })),
        sourceIndexFile,
        characterCandidateIds: chapterCandidates,
      },
    );
    completedChapters.push({
      chapterPosition,
      chapterIndex: chapter.index,
      title: chapter.title,
      file: chapterFile,
      characterCandidateIds: chapterCandidates,
    });
  }

  candidates.sort((left, right) =>
    left.chapterPosition - right.chapterPosition
    || compareText(left.candidateId, right.candidateId)
  );
  const checkpointFile = path.join(analysisDirectory, "checkpoint.json");
  await writeJsonAtomic(checkpointFile, {
    schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
    provisional: true,
    analysisId: currentAnalysisId,
    book: {
      bookId: book.bookId,
      sourceSha256: book.sourceSha256,
      title: book.title,
      author: book.author,
    },
    completedChapters,
    characterCandidates: candidates,
  });
  await writeJsonAtomic(path.join(rootDirectory, book.bookId, "analysis", "current.json"), {
    schemaVersion: KINDLE_PACKAGE_SCHEMA_VERSION,
    analysisId: currentAnalysisId,
    checkpoint: packagePath(currentAnalysisId, "checkpoint.json"),
  });

  return {
    analysisId: currentAnalysisId,
    directory: analysisDirectory,
    checkpointFile,
    completedChapterCount: completedChapters.length,
    characterCandidateCount: candidates.length,
  };
}

export function requireIndexedProfiles(book: ImportedBook): CharacterProfile[] {
  if (book.worldBible?.schemaVersion !== WORLD_BIBLE_SCHEMA_VERSION) {
    throw new Error(
      "The book needs a current source-backed world bible before it can be exported",
    );
  }
  if (
    book.chapters.some(
      (chapter) => chapter.sourceIndex?.schemaVersion !== CHAPTER_SOURCE_INDEX_VERSION,
    )
  ) {
    throw new Error(
      "Every chapter needs a current source index before the book can be exported",
    );
  }

  const profiles = book.worldBible.characterProfiles ?? [];
  const characterIds = new Set<string>();
  for (const profile of profiles) {
    const characterId = profile.characterId;
    if (!characterId || !/^character_[a-f0-9]{20}$/.test(characterId)) {
      throw new Error(`Character ${JSON.stringify(profile.name)} has no valid character ID`);
    }
    if (characterIds.has(characterId)) {
      throw new Error(`Duplicate character ID in world bible: ${characterId}`);
    }
    characterIds.add(characterId);
  }
  return selectCoreCharacterProfiles(profiles);
}
