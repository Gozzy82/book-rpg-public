import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  exportKindleAnalysisCheckpoint,
  exportKindlePackage,
} from "../src/books/kindle-package.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
  WORLD_BIBLE_SCHEMA_VERSION,
} from "../src/shared/contracts.js";
import type { ImportedBook, SourceReference } from "../src/shared/contracts.js";

const alphaId = "character_aaaaaaaaaaaaaaaaaaaa";
const betaId = "character_bbbbbbbbbbbbbbbbbbbb";
const alphaReference: SourceReference = {
  chapterPosition: 0,
  chapterIndex: 3,
  lineStart: 2,
  lineEnd: 2,
};
const betaReference: SourceReference = {
  chapterPosition: 0,
  chapterIndex: 3,
  lineStart: 3,
  lineEnd: 3,
};

function indexedBook(): ImportedBook {
  return {
    bookId: "book-id",
    sourceSha256: "source-sha256",
    title: "Synthetic Story",
    author: "Example Author",
    chapters: [{
      index: 3,
      title: "Opening",
      text: [
        "Opening",
        "Person Alpha greets Person Beta.",
        "Person Beta replies.",
      ].join("\n"),
      summary: "Two people meet.",
      sourceIndex: {
        schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
        summary: "Two people meet.",
        characters: [
          {
            name: "Person Alpha",
            aliases: ["Álpha"],
            sourceReferences: [alphaReference],
          },
          {
            name: "Person Beta",
            aliases: [],
            sourceReferences: [betaReference],
          },
        ],
        actions: [{
          actor: "Person Alpha",
          description: "Greets Person Beta.",
          targets: ["Person Beta"],
          sourceReferences: [alphaReference],
        }],
        relationships: [{
          character: "Person Alpha",
          relatedCharacter: "Person Beta",
          description: "Person Alpha acknowledges Person Beta.",
          sourceReferences: [alphaReference],
        }],
      },
    }],
    worldBible: {
      schemaVersion: WORLD_BIBLE_SCHEMA_VERSION,
      summary: "A synthetic story about two people.",
      characters: ["Person Alpha", "Person Beta"],
      characterProfiles: [
        {
          characterId: alphaId,
          name: "Person Alpha",
          aliases: ["Álpha"],
          role: "Participant",
          description: "The first participant.",
          traits: ["observant"],
          relationships: [{
            characterId: betaId,
            character: "Person Beta",
            description: "Person Alpha acknowledges Person Beta.",
            sourceReferences: [alphaReference],
          }],
          actions: [{
            description: "Greets Person Beta.",
            targets: [{ characterId: betaId, character: "Person Beta" }],
            sourceReferences: [alphaReference],
          }],
          sourceReferences: [alphaReference],
          storyArc: "Person Alpha initiates contact.",
        },
        {
          characterId: betaId,
          name: "Person Beta",
          aliases: [],
          role: "Participant",
          description: "The second participant.",
          traits: ["responsive"],
          relationships: [],
          actions: [],
          sourceReferences: [betaReference],
          storyArc: "Person Beta responds.",
        },
      ],
      identityResolutions: [{
        canonicalName: "Person Alpha",
        alias: "Álpha",
        decision: "same_person",
        confidence: 0.97,
        sourceReferences: [alphaReference],
      }],
      locations: ["Shared setting"],
    },
    importedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function readJson(filename: string): Promise<any> {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

test("Kindle package supports lazy character, relationship, search, and source lookup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-kindle-"));
  try {
    const book = indexedBook();
    const unchanged = JSON.stringify(book);
    const result = await exportKindlePackage(book, root);

    const current = await readJson(path.join(root, book.bookId, "current.json"));
    const manifest = await readJson(result.manifestFile);
    const characterIndex = await readJson(path.join(result.directory, "characters", "index.json"));
    const characters = await readJson(
      path.join(result.directory, characterIndex.pages[0].file),
    );
    const searchIndex = await readJson(path.join(result.directory, "search", "index.json"));
    const search = await readJson(
      path.join(
        result.directory,
        searchIndex.shards.find((shard: { key: string }) => shard.key === "a").file,
      ),
    );
    const relationshipIndex = await readJson(
      path.join(result.directory, "relationships", "index.json"),
    );
    const relationshipChapter = await readJson(
      path.join(result.directory, relationshipIndex.chapters[0].file),
    );
    const relations = await readJson(
      path.join(result.directory, relationshipChapter.pages[0].file),
    );
    const actionIndex = await readJson(path.join(result.directory, "actions", "index.json"));
    const actionChapter = await readJson(
      path.join(result.directory, actionIndex.chapters[0].file),
    );
    const actions = await readJson(
      path.join(result.directory, actionChapter.pages[0].file),
    );
    const alpha = await readJson(
      path.join(result.directory, "characters", alphaId, "profile.json"),
    );
    const beta = await readJson(
      path.join(result.directory, "characters", betaId, "profile.json"),
    );
    const alphaTimeline = await readJson(
      path.join(result.directory, ...alpha.timeline[0].file.split("/")),
    );
    const betaTimeline = await readJson(
      path.join(result.directory, ...beta.timeline[0].file.split("/")),
    );
    const alphaOutgoing = await readJson(
      path.join(result.directory, alphaTimeline.shards.relationshipsOutgoing.file),
    );
    const betaIncoming = await readJson(
      path.join(result.directory, betaTimeline.shards.relationshipsIncoming.file),
    );
    const alphaPerformed = await readJson(
      path.join(result.directory, alphaTimeline.shards.actionsPerformed.file),
    );
    const betaReceived = await readJson(
      path.join(result.directory, betaTimeline.shards.actionsReceived.file),
    );
    const alphaOverview = await readJson(
      path.join(result.directory, "characters", alphaId, "overview.json"),
    );
    const chapter = await readJson(
      path.join(result.directory, "chapters", "0000", "index.json"),
    );
    const chapterLines = (await Promise.all(
      chapter.textFiles.map((textFile: { file: string }) =>
        readJson(path.join(result.directory, textFile.file))
      ),
    )).flatMap((textFile) => textFile.lines);
    const availability = await readJson(
      path.join(result.directory, chapter.availableCharactersFile),
    );
    const availableAtLineTwo = availability.characters.filter(
      (character: { firstSeen: SourceReference }) =>
        character.firstSeen.chapterPosition < 0
        || character.firstSeen.lineStart <= 2,
    );

    assert.equal(current.packageId, result.packageId);
    assert.equal(current.manifest, `packages/${result.packageId}/manifest.json`);
    assert.deepEqual(manifest.counts, {
      chapters: 1,
      characters: 2,
      actions: 1,
      relationships: 1,
    });
    assert.equal(
      characters.characters[0].detailFile,
      `characters/${alphaId}/profile.json`,
    );
    assert.equal(characters.characters[0].relatedCharacterIds, undefined);
    assert.equal(
      characters.characters[0].overviewFile,
      `characters/${alphaId}/overview.json`,
    );
    assert.deepEqual(search.lookup.alpha, [alphaId]);
    assert.equal(
      search.entries.find((entry: { characterId: string }) =>
        entry.characterId === alphaId
      ).overviewFile,
      `characters/${alphaId}/overview.json`,
    );
    assert.equal(relations.relationships[0].targetCharacterId, betaId);
    assert.equal(alphaOutgoing.items[0].characterId, betaId);
    assert.equal(betaIncoming.items[0].characterId, alphaId);
    assert.equal(alphaPerformed.items[0].targets[0].characterId, betaId);
    assert.equal(betaReceived.items[0].actor.characterId, alphaId);
    assert.equal(actions.actions[0].actorCharacterId, alphaId);
    assert.equal(alpha.firstSeen.chapterFile, "chapters/0000/index.json");
    assert.deepEqual(alpha.firstSeen.textFiles, ["chapters/0000/text/0000.json"]);
    assert.equal(alpha.timelineIndexScope, "whole_book");
    assert.equal(alpha.overviewFile, `characters/${alphaId}/overview.json`);
    assert.equal(alphaOverview.spoilerScope, "whole_book");
    assert.equal(alphaOverview.storyArc, "Person Alpha initiates contact.");
    assert.equal(alphaOverview.identityResolutions[0].decision, "same_person");
    assert.equal(alphaOverview.identityResolutions[0].confidence, 0.97);
    assert.deepEqual(alphaOverview.relatedCharacterIds, [betaId]);
    assert.deepEqual(chapterLines, [
      "Opening",
      "Person Alpha greets Person Beta.",
      "Person Beta replies.",
    ]);
    assert.deepEqual(chapter.characterIds, [alphaId, betaId]);
    assert.deepEqual(
      availableAtLineTwo.map((character: { characterId: string }) => character.characterId),
      [alphaId],
    );
    assert.equal(chapter.lineCount, 3);
    assert.equal(JSON.stringify(book), unchanged);

    const sentinel = path.join(result.directory, "keep-me.txt");
    await fs.writeFile(sentinel, "preserve", "utf8");
    const repeated = await exportKindlePackage(book, root);
    assert.equal(repeated.packageId, result.packageId);
    assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("chapter checkpoints write provisional information per observed character", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-checkpoint-"));
  try {
    const book = indexedBook();
    book.worldBible = undefined;

    const result = await exportKindleAnalysisCheckpoint(book, root);
    const checkpoint = await readJson(result.checkpointFile);
    const alphaCandidate = checkpoint.characterCandidates.find(
      (candidate: { name: string }) => candidate.name === "Person Alpha",
    );
    assert.ok(alphaCandidate);
    const candidate = await readJson(path.join(result.directory, alphaCandidate.file));
    const betaCandidate = checkpoint.characterCandidates.find(
      (item: { name: string }) => item.name === "Person Beta",
    );
    assert.ok(betaCandidate);
    const beta = await readJson(path.join(result.directory, betaCandidate.file));
    const chapter = await readJson(
      path.join(result.directory, checkpoint.completedChapters[0].file),
    );
    const sourceIndex = await readJson(path.join(result.directory, chapter.sourceIndexFile));
    const textChunk = await readJson(
      path.join(result.directory, chapter.textFiles[0].file),
    );

    assert.equal(result.completedChapterCount, 1);
    assert.equal(result.characterCandidateCount, 2);
    assert.equal(checkpoint.provisional, true);
    assert.equal(candidate.provisional, true);
    assert.equal(candidate.name, "Person Alpha");
    assert.equal(candidate.actions.performed[0].description, "Greets Person Beta.");
    assert.equal(
      candidate.relationships.outgoing[0].relatedCharacter,
      "Person Beta",
    );
    assert.equal(beta.actions.received[0].actor, "Person Alpha");
    assert.equal(beta.relationships.incoming[0].character, "Person Alpha");
    assert.equal(candidate.sourceReferences[0].chapterFile, "chapters/0000/index.json");
    assert.equal(sourceIndex.schemaVersion, CHAPTER_SOURCE_INDEX_VERSION);
    assert.deepEqual(textChunk.lines, [
      "Opening",
      "Person Alpha greets Person Beta.",
      "Person Beta replies.",
    ]);
    assert.equal(chapter.characterCandidateIds.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("large chapter text is split into bounded lazy-load chunks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-chunks-"));
  try {
    const book = indexedBook();
    book.chapters[0]!.text = Array.from(
      { length: 350 },
      (_, index) => `Line ${index + 1}: ${"x".repeat(180)}`,
    ).join("\n");

    const result = await exportKindlePackage(book, root);
    const chapter = await readJson(
      path.join(result.directory, "chapters", "0000", "index.json"),
    );

    assert.ok(chapter.textFiles.length > 1);
    assert.equal(chapter.textFiles[0].lineStart, 1);
    assert.equal(chapter.textFiles.at(-1).lineEnd, 350);
    for (const textFile of chapter.textFiles) {
      const filename = path.join(result.directory, textFile.file);
      assert.ok((await fs.stat(filename)).size < 30_000);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kindle export rejects legacy books without source-backed indexes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-legacy-"));
  try {
    const book = indexedBook();
    if (book.worldBible) delete book.worldBible.schemaVersion;

    await assert.rejects(
      exportKindlePackage(book, root),
      /current source-backed world bible/,
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
