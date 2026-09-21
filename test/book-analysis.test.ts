import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBook as analyzeBookProduction,
  buildAnalysisChunks,
  buildChapterAnalysisBatches,
  CHARACTER_PROFILE_DESCRIPTION_RULES,
  mergeSupplementalCharacterProfiles,
} from "../src/books/analyze.js";
import {
  buildBookStoryEvents,
  parseChapterPartSourceIndex,
  parseWorldBibleOutput,
  selectCoreCharacterProfiles,
} from "../src/books/source-index.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
  WORLD_BIBLE_SCHEMA_VERSION,
} from "../src/shared/contracts.js";
import type {
  ChapterSourceIndex,
  CharacterProfile,
  ImportedBook,
  SourceReference,
} from "../src/shared/contracts.js";

// These legacy cases target chapter/world-index behavior; stage-specific audits
// are exercised through the unwrapped production flow in staged-index.test.ts.
const analyzeBook: typeof analyzeBookProduction = (book, options = {}) => analyzeBookProduction(book, {
  ...options,
  saveStageProgress: options.saveStageProgress ?? (async () => {}),
  ...(options.createResponse ? {createResponse: async request => request.text?.format.name === "bookrpg_source_timeline_review"
    ? {status: "completed" as const, output_text: JSON.stringify({valid: true, issues: []})}
    : options.createResponse!(request)} : {}),
});

test("character descriptions prioritize concrete identity over symbolism", () => {
  const rules = CHARACTER_PROFILE_DESCRIPTION_RULES.join("\n");

  assert.match(rules, /literal, concrete identification/i);
  assert.match(rules, /first sentence MUST explicitly use a species or recognized creature-type noun/i);
  assert.match(rules, /whale, leviathan/i);
  assert.match(rules, /symbolic label alone does not satisfy/i);
  assert.match(rules, /symbolic meaning.*only after/i);
});


test("book story events prefer their own participants over overlapping actions", () => {
  const events = buildBookStoryEvents({
    bookId: "book-event-participants",
    chapters: [{
      index: 0,
      title: "Directions",
      text: "The Witch directs Dorothy to seek Oz.",
      sourceIndex: {
        schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
        summary: "The Witch gives Dorothy directions.",
        significantEvents: [{
          description: "The Witch directs Dorothy to seek Oz.",
          actors: ["Witch of the North"],
          targets: ["Dorothy"],
          beats: [{
            actor: "Witch of the North",
            action: "Directs Dorothy to seek Oz.",
            targets: ["Dorothy"],
            agency: "intentional",
            stakes: "significant",
            sourceReferences: [reference(0, 0)],
          }],
          sourceReferences: [reference(0, 0)],
        }],
        characters: [],
        actions: [{
          actor: "Dorothy",
          description: "Plans to seek Oz.",
          targets: ["Oz"],
          sourceReferences: [reference(0, 0)],
        }],
        relationships: [],
      },
    }],
  });

  assert.deepEqual(events[0]?.actors, ["Witch of the North"]);
  assert.deepEqual(events[0]?.targets, ["Dorothy"]);
  assert.deepEqual(events[0]?.beats, [{
    actor: "Witch of the North",
    action: "Directs Dorothy to seek Oz.",
    targets: ["Dorothy"],
    agency: "intentional",
    stakes: "significant",
    sourceReferences: [reference(0, 0)],
  }]);
});

function reference(
  chapterPosition: number,
  chapterIndex: number,
  lineStart = 1,
  lineEnd = lineStart,
): SourceReference {
  return { chapterPosition, chapterIndex, lineStart, lineEnd };
}

function emptySourceIndex(summary: string): ChapterSourceIndex {
  return {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary,
    significantEvents: [],
    characters: [],
    actions: [],
    relationships: [],
  };
}

function emptyPartIndex(summary: string): Record<string, unknown> {
  return {
    summary,
    significantEvents: [],
    characters: [],
    actions: [],
    relationships: [],
  };
}

function emptyWorldIndex(): Record<string, unknown> {
  return {
    summary: "Whole story summary.",
    characterProfiles: [],
    locations: [],
  };
}

function profile(
  name: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    name,
    aliases: [],
    role: "Story participant",
    description: `${name} participates in the story.`,
    traits: [],
    storyArc: `${name}'s situation changes over the story.`,
    ...overrides,
  };
}

test("supplemental profiles augment a valid whole-book draft without replacing it", () => {
  const merged = JSON.parse(mergeSupplementalCharacterProfiles(
    JSON.stringify({
      summary: "Whole story.",
      characterProfiles: [profile("Person Alpha")],
      locations: ["A house"],
    }),
    JSON.stringify({
      characterProfiles: [
        profile("Person Beta", { aliases: ["Beta"] }),
      ],
    }),
    ["Person Beta"],
  )) as {
    characterProfiles: Array<{ name: string }>;
    locations: string[];
  };

  assert.deepEqual(
    merged.characterProfiles.map((candidate) => candidate.name),
    ["Person Alpha", "Person Beta"],
  );
  assert.deepEqual(merged.locations, ["A house"]);
  assert.throws(
    () => mergeSupplementalCharacterProfiles(
      JSON.stringify(emptyWorldIndex()),
      JSON.stringify({ characterProfiles: [profile("Person Gamma")] }),
      ["Person Beta"],
    ),
    /omitted requested supplemental profiles: Person Beta/,
  );
});

test("supplemental profiles accept a source-verified equivalent name", () => {
  const identityResolution = {
    canonicalName: "Kasigi Omi",
    alias: "Omi",
    decision: "same_person" as const,
    confidence: 0.95,
    sourceReferences: [reference(0, 0)],
  };
  const merged = JSON.parse(mergeSupplementalCharacterProfiles(
    JSON.stringify(emptyWorldIndex()),
    JSON.stringify({ characterProfiles: [profile("Omi")] }),
    ["Kasigi Omi"],
    [identityResolution],
  )) as { characterProfiles: Array<{ name: string }> };

  assert.deepEqual(
    merged.characterProfiles.map((candidate) => candidate.name),
    ["Omi"],
  );
  assert.throws(
    () => mergeSupplementalCharacterProfiles(
      JSON.stringify(emptyWorldIndex()),
      JSON.stringify({ characterProfiles: [profile("Omi")] }),
      ["Kasigi Omi"],
      [{ ...identityResolution, confidence: 0.5 }],
    ),
    /omitted requested supplemental profiles: Kasigi Omi/,
  );
});

function indexedProfile(index: number, chapterPositions: number[]): CharacterProfile {
  return {
    characterId: `character_${index.toString(16).padStart(20, "0")}`,
    name: `Person ${index + 1}`,
    aliases: [],
    role: "Participant",
    description: "A story participant.",
    traits: [],
    relationships: [],
    actions: [],
    sourceReferences: chapterPositions.map((chapterPosition) =>
      reference(chapterPosition, chapterPosition)
    ),
    storyArc: "Participates in events.",
  };
}

test("book analysis chunks preserve all chapter text within the size limit", () => {
  const chapters = [
    { index: 0, title: "One", text: "First chapter." },
    { index: 1, title: "Two", text: "Second chapter has considerably more text." },
    { index: 2, title: "Three", text: "Third chapter." },
  ];

  const chunks = buildAnalysisChunks({ chapters }, 75);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 75));
  assert.match(chunks.join("\n"), /First chapter\./);
  assert.match(chunks.join("\n"), /Second chapter has considerably more text\./);
  assert.match(chunks.join("\n"), /Third chapter\./);
});

test("book analysis splits an oversized chapter without losing its content", () => {
  const text = "A".repeat(250);
  const chunks = buildAnalysisChunks({
    chapters: [{ index: 0, title: "Long", text }],
  }, 100);

  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
  assert.equal(chunks.join("").replaceAll("[Book section 1: Long]\n", ""), text);
});

test("chapter source batches preserve text and add stable one-based line numbers", () => {
  const maxChars = 320;
  const chapters = [
    { index: 4, title: "One", text: `First line.\n${"A".repeat(210)}` },
    { index: 7, title: "Two", text: "B".repeat(210) },
  ];

  const batches = buildChapterAnalysisBatches({ chapters }, maxChars);
  const parts = batches.flatMap((batch) => batch.parts);

  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.input.length <= maxChars));
  assert.equal(
    parts.filter((part) => part.chapterPosition === 0).map((part) => part.text).join(""),
    chapters[0]!.text,
  );
  assert.equal(
    parts.filter((part) => part.chapterPosition === 1).map((part) => part.text).join(""),
    chapters[1]!.text,
  );
  assert.equal(new Set(parts.map((part) => part.sourceId)).size, parts.length);
  assert.match(batches.map((batch) => batch.input).join("\n"), /LINE 1: First line\./);
  assert.ok(parts.some((part) => part.chapterPosition === 0 && part.lineEnd === 2));
});

test("chapter source batches cap the number of strict-schema properties", () => {
  const chapters = Array.from({ length: 205 }, (_, index) => ({
    index,
    title: `Section ${index + 1}`,
    text: `Text ${index + 1}.`,
  }));

  const batches = buildChapterAnalysisBatches({ chapters }, 60_000);

  assert.equal(batches.length, 3);
  assert.ok(batches.every((batch) => batch.parts.length <= 100));
});

test("core character selection targets ten and never exceeds fifteen", () => {
  const incidental = Array.from(
    { length: 20 },
    (_, index) => indexedProfile(index, [0]),
  );
  const recurring = Array.from(
    { length: 20 },
    (_, index) => indexedProfile(index, [0, 1, 2]),
  );

  assert.equal(selectCoreCharacterProfiles(incidental).length, 10);
  assert.equal(selectCoreCharacterProfiles(recurring).length, 15);
});

test("chapter source parsing collapses harmless duplicate aliases and references", () => {
  const parsed = parseChapterPartSourceIndex({
    summary: "Two people meet.",
    significantEvents: [],
    characters: [{
      name: "Person Alpha",
      aliases: ["Person Alpha", "Alpha", "alpha"],
      references: [
        { lineStart: 1, lineEnd: 1 },
        { lineStart: 1, lineEnd: 1 },
      ],
    }],
    actions: [],
    relationships: [],
  }, {
    sourceId: "chapter_1_part_1",
    chapterIndex: 0,
    lineStart: 1,
    lineEnd: 1,
    sourceText: "Person Alpha meets Alpha.",
  });

  assert.deepEqual(parsed.characters[0]?.aliases, ["Alpha"]);
  assert.deepEqual(parsed.characters[0]?.references, [{ lineStart: 1, lineEnd: 1 }]);
});

test("chapter source parsing rejects an invented character name absent from cited lines", () => {
  assert.throws(
    () => parseChapterPartSourceIndex({
      summary: "Four policemen eat supper.",
      significantEvents: [],
      characters: [{
        name: "O’Maloney",
        aliases: [],
        references: [{ lineStart: 121, lineEnd: 124 }],
      }],
      actions: [],
      relationships: [],
    }, {
      sourceId: "chapter_5_part_1",
      chapterIndex: 4,
      lineStart: 121,
      lineEnd: 124,
      sourceText: "Here you all are.\nSergeant Noonan answered.\nPlease eat it.\nThe four policemen went into the kitchen.",
    }),
    /without that name or alias anywhere in the source text/i,
  );
});

test("chapter source parsing tolerates EPUB whitespace inside a cited name", () => {
  const parsed = parseChapterPartSourceIndex({
    summary: "Two policemen arrive.",
    significantEvents: [],
    characters: [{
      name: "O’Malley",
      aliases: [],
      references: [{ lineStart: 88, lineEnd: 88 }],
    }],
    actions: [],
    relationships: [],
  }, {
    sourceId: "chapter_5_part_1",
    chapterIndex: 4,
    lineStart: 88,
    lineEnd: 88,
    sourceText: "The other policeman was called O’M alley.",
  });

  assert.equal(parsed.characters[0]?.name, "O’Malley");
});

test("chapter source parsing ignores an alias shared by different canonical characters", () => {
  const parsed = parseChapterPartSourceIndex({
    summary: "Two people act.",
    significantEvents: [],
    characters: [
      { name: "Person Alpha", aliases: ["Shared"], references: [{ lineStart: 1, lineEnd: 1 }] },
      { name: "Person Beta", aliases: ["Shared"], references: [{ lineStart: 1, lineEnd: 1 }] },
    ],
    actions: [{
      actor: "Person Alpha",
      description: "Greets the other person.",
      targets: ["Person Beta", "Person Beta", "Person Gamma"],
      references: [{ lineStart: 1, lineEnd: 1 }],
    }],
    relationships: [],
  }, {
    sourceId: "chapter_1_part_1",
    chapterIndex: 0,
    lineStart: 1,
    lineEnd: 1,
    sourceText: "Person Alpha greets Person Beta and Person Gamma.",
  });

  assert.equal(parsed.actions[0]?.actor, "Person Alpha");
  assert.deepEqual(parsed.actions[0]?.targets, ["Person Beta", "Person Gamma"]);
  assert.equal(parsed.characters[2]?.name, "Person Gamma");
  assert.deepEqual(parsed.characters[2]?.references, [{ lineStart: 1, lineEnd: 1 }]);
});

test("chapter source parsing derives event participants from agency-classified beats", () => {
  const parsed = parseChapterPartSourceIndex({
    summary: "The Scarecrow repeatedly falls and Dorothy helps him.",
    significantEvents: [{
      description: "The Scarecrow repeatedly falls, and Dorothy lifts him back up.",
      beats: [{
        actor: "Scarecrow",
        action: "Stumbles and falls repeatedly.",
        targets: [],
        agency: "involuntary",
        stakes: "significant",
        references: [{ lineStart: 1, lineEnd: 1 }],
      }, {
        actor: "Dorothy",
        action: "Lifts the Scarecrow upright after each fall.",
        targets: ["Scarecrow"],
        agency: "intentional",
        stakes: "routine",
        references: [{ lineStart: 1, lineEnd: 1 }],
      }],
      references: [{ lineStart: 1, lineEnd: 1 }],
    }],
    characters: [
      { name: "Scarecrow", aliases: [], references: [{ lineStart: 1, lineEnd: 1 }] },
      { name: "Dorothy", aliases: [], references: [{ lineStart: 1, lineEnd: 1 }] },
    ],
    actions: [],
    relationships: [],
  }, {
    sourceId: "chapter_1_part_1",
    chapterIndex: 0,
    lineStart: 1,
    lineEnd: 1,
    sourceText: "The Scarecrow falls again and Dorothy lifts the Scarecrow upright.",
  });

  assert.deepEqual(parsed.significantEvents[0]?.actors, ["Scarecrow", "Dorothy"]);
  assert.deepEqual(parsed.significantEvents[0]?.targets, ["Scarecrow"]);
  assert.deepEqual(
    parsed.significantEvents[0]?.beats.map(({ agency, stakes }) => ({ agency, stakes })),
    [
      { agency: "involuntary", stakes: "significant" },
      { agency: "intentional", stakes: "routine" },
    ],
  );
});

test("chapter source parsing rejects external event beats with a character actor", () => {
  assert.throws(
    () => parseChapterPartSourceIndex({
      summary: "A person acts.",
      significantEvents: [{
        description: "Person Alpha opens the door.",
        beats: [{
          actor: "Person Alpha",
          action: "Opens the door.",
          targets: [],
          agency: "external",
          stakes: "routine",
          references: [{ lineStart: 1, lineEnd: 1 }],
        }],
        references: [{ lineStart: 1, lineEnd: 1 }],
      }],
      characters: [{
        name: "Person Alpha",
        aliases: [],
        references: [{ lineStart: 1, lineEnd: 1 }],
      }],
      actions: [],
      relationships: [],
    }, {
      sourceId: "chapter_1_part_1",
      chapterIndex: 0,
      lineStart: 1,
      lineEnd: 1,
      sourceText: "Person Alpha opens the door.",
    }),
    /external beat 1 of significant event 1 with a character actor/i,
  );
});

test("chapter source parsing includes finer beat evidence in event references", () => {
  const parsed = parseChapterPartSourceIndex({
    summary: "A storm breaks a window and Person Alpha reacts.",
    significantEvents: [{
      description: "A storm breaks a window and Person Alpha shields their face.",
      beats: [{
        actor: null,
        action: "Breaks a window.",
        targets: [],
        agency: "external",
        stakes: "significant",
        references: [{ lineStart: 1, lineEnd: 1 }],
      }, {
        actor: "Person Alpha",
        action: "Shields their face.",
        targets: [],
        agency: "involuntary",
        stakes: "routine",
        references: [{ lineStart: 2, lineEnd: 2 }],
      }],
      references: [{ lineStart: 1, lineEnd: 1 }],
    }],
    characters: [{
      name: "Person Alpha",
      aliases: [],
      references: [{ lineStart: 2, lineEnd: 2 }],
    }],
    actions: [],
    relationships: [],
  }, {
    sourceId: "chapter_1_part_1",
    chapterIndex: 0,
    lineStart: 1,
    lineEnd: 2,
    sourceText: "A storm breaks the window.\nPerson Alpha shields their face.",
  });

  assert.deepEqual(
    parsed.significantEvents[0]?.references,
    [{ lineStart: 1, lineEnd: 1 }, { lineStart: 2, lineEnd: 2 }],
  );
});

test("book analysis builds a source-backed character, action, and relationship index", async () => {
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    author: "Example Author",
    chapters: [
      {
        index: 4,
        title: "One",
        text: "Person Alpha greets Person Beta.",
      },
      {
        index: 9,
        title: "Two",
        text: "Person Beta helps Person Alpha.",
      },
    ],
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  let callCount = 0;

  const analysis = await analyzeBook(book, {
    log: () => undefined,
    createResponse: async (request) => {
      callCount += 1;
      if (callCount <= 2) {
        assert.match(
          request.instructions ?? "",
          /Treat the narrative present .* as the event chronology/i,
        );
        assert.match(
          request.instructions ?? "",
          /use Scarecrow: Recounts attempting to follow the farmer, not Scarecrow: Attempts to follow the farmer/i,
        );
        assert.match(
          request.instructions ?? "",
          /Do not switch from a framing beat .* into unframed beats/i,
        );
        return {
          output_text: JSON.stringify({
            chapter_1_part_1: {
              summary: "Two people meet.",
              significantEvents: [{
                description: "Person Alpha greets Person Beta.",
                beats: [{
                  actor: "Person Alpha",
                  action: "Greets Person Beta.",
                  sourceSemantics: {mode: "present", narratedContent: null, intentionalRole: "other", jointAction: null},
                  resultingState: "Person Beta has heard the greeting.",
                  targets: ["Person Beta"],
                  agency: "intentional",
                  stakes: "routine",
                  references: [{ lineStart: 1, lineEnd: 1 }],
                }],
                references: [{ lineStart: 1, lineEnd: 1 }],
              }],
              characters: [
                { name: "Person Alpha", aliases: [], references: [{ lineStart: 1, lineEnd: 1 }] },
                { name: "Person Beta", aliases: [], references: [{ lineStart: 1, lineEnd: 1 }] },
              ],
              actions: [{
                actor: "Person Alpha",
                description: "Greets Person Beta.",
                targets: ["Person Beta"],
                references: [{ lineStart: 1, lineEnd: 1 }],
              }],
              relationships: [{
                character: "Person Alpha",
                relatedCharacter: "Person Beta",
                description: "They become acquainted.",
                references: [{ lineStart: 1, lineEnd: 1 }],
              }],
            },
            chapter_2_part_1: {
              summary: "One person helps the other.",
              significantEvents: [{
                description: "Person Beta helps Person Alpha.",
                beats: [{
                  actor: "Person Beta",
                  action: "Helps Person Alpha.",
                  sourceSemantics: {mode: "present", narratedContent: null, intentionalRole: "other", jointAction: null},
                  resultingState: "Person Alpha has received help.",
                  targets: ["Person Alpha"],
                  agency: "intentional",
                  stakes: "routine",
                  references: [{ lineStart: 1, lineEnd: 1 }],
                }],
                references: [{ lineStart: 1, lineEnd: 1 }],
              }],
              characters: [
                { name: "Person Alpha", aliases: [], references: [{ lineStart: 1, lineEnd: 1 }] },
                { name: "Person Beta", aliases: [], references: [{ lineStart: 1, lineEnd: 1 }] },
              ],
              actions: [{
                actor: "Person Beta",
                description: "Helps Person Alpha.",
                targets: ["Person Alpha"],
                references: [{ lineStart: 1, lineEnd: 1 }],
              }],
              relationships: [{
                character: "Person Beta",
                relatedCharacter: "Person Alpha",
                description: "Offers practical support.",
                references: [{ lineStart: 1, lineEnd: 1 }],
              }],
            },
          }),
          status: "completed",
          incomplete_details: null,
        };
      }
      if (callCount === 3) {
        if (typeof request.input !== "string") {
          throw new Error("Expected whole-book input to be a string");
        }
        assert.match(request.input, /CHAPTER SOURCE INDEX 1/);
        assert.match(request.input, /Greets Person Beta/);
        return {
          output_text: JSON.stringify({
            summary: "A concise whole-story summary.",
            characterProfiles: [
              profile("Person Alpha", {
                role: "Participant",
              }),
              profile("Person Beta", {
                role: "Participant",
              }),
            ],
            locations: ["Shared setting"],
          }),
          status: "completed",
          incomplete_details: null,
        };
      }
      throw new Error("Unexpected extra OpenAI request");
    },
  });

  assert.deepEqual(analysis.chapterSummaries, [
    "Two people meet.",
    "One person helps the other.",
  ]);
  assert.equal(book.chapters[0]?.sourceIndex?.schemaVersion, CHAPTER_SOURCE_INDEX_VERSION);
  assert.deepEqual(book.chapters[0]?.sourceIndex?.significantEvents, [{
    category: "other",
    description: "Person Alpha greets Person Beta.",
    actors: ["Person Alpha"],
    targets: ["Person Beta"],
    beats: [{
      actor: "Person Alpha",
      action: "Greets Person Beta.",
      sourceSemantics: {mode: "present", narratedContent: null, intentionalRole: "other", jointAction: null},
      resultingState: "Person Beta has heard the greeting.",
      targets: ["Person Beta"],
      agency: "intentional",
      stakes: "routine",
      sourceReferences: [reference(0, 4)],
    }],
    sourceReferences: [reference(0, 4)],
  }]);
  assert.deepEqual(
    book.storyEvents?.map((event) => ({
      sequence: event.sequence,
      description: event.description,
      actors: event.actors,
      targets: event.targets,
    })),
    [
      {
        sequence: 1,
        description: "Person Alpha greets Person Beta.",
        actors: ["Person Alpha"],
        targets: ["Person Beta"],
      },
      {
        sequence: 2,
        description: "Person Beta helps Person Alpha.",
        actors: ["Person Beta"],
        targets: ["Person Alpha"],
      },
    ],
  );
  assert.equal(book.storyEvents?.[0]?.beats?.[0]?.agency, "intentional");
  assert.equal(book.storyEvents?.[0]?.beats?.[0]?.stakes, "routine");
  assert.match(book.storyEvents?.[0]?.eventId ?? "", /^event_[a-f0-9]{20}$/);
  assert.equal(book.chapters[0]?.sourceIndex?.actions[0]?.actor, "Person Alpha");
  assert.equal(analysis.worldBible.schemaVersion, WORLD_BIBLE_SCHEMA_VERSION);
  assert.deepEqual(analysis.worldBible.characters, ["Person Alpha", "Person Beta"]);
  const alpha = analysis.worldBible.characterProfiles?.[0];
  const beta = analysis.worldBible.characterProfiles?.[1];
  assert.match(alpha?.characterId ?? "", /^character_[a-f0-9]{20}$/);
  assert.match(beta?.characterId ?? "", /^character_[a-f0-9]{20}$/);
  assert.equal(alpha?.relationships[0]?.character, "Person Beta");
  assert.equal(alpha?.relationships[0]?.characterId, beta?.characterId);
  assert.equal(alpha?.actions?.[0]?.targets[0]?.characterId, beta?.characterId);
  assert.deepEqual(alpha?.actions?.[0]?.sourceReferences, [reference(0, 4)]);
  assert.deepEqual(alpha?.sourceReferences, [reference(0, 4), reference(1, 9)]);
  assert.equal(callCount, 3);
});

test("canonical profile names populate the derived character list", async () => {
  const sourceIndex: ChapterSourceIndex = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "Saved summary.",
    characters: [{
      name: "Person Alpha",
      aliases: ["Alpha (alias used in some lines)"],
      sourceReferences: [reference(0, 0)],
    }],
    actions: [],
    relationships: [],
  };
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{
      index: 0,
      title: "One",
      text: "Person Alpha arrives.",
      summary: sourceIndex.summary,
      sourceIndex,
    }],
    importedAt: "2026-01-01T00:00:00.000Z",
  };

  const analysis = await analyzeBook(book, {
    log: () => undefined,
    createResponse: async (request) => {
      const format = request.text?.format;
      return {
        output_text: JSON.stringify(
          format && "name" in format && format.name === "bookrpg_identity_resolution"
            ? {
                identity_1: {
                  decision: "same_person",
                  confidence: 0.96,
                  evidenceReferenceIndexes: [0],
                },
              }
            : {
                summary: "Whole story.",
                characterProfiles: [
                  profile("Person Alpha", { aliases: ["Alpha"] }),
                ],
                locations: [],
              },
        ),
        status: "completed",
      };
    },
  });

  assert.deepEqual(analysis.worldBible.characters, ["Person Alpha"]);
  assert.deepEqual(analysis.worldBible.characterProfiles?.[0]?.aliases, ["Alpha"]);
  assert.equal(analysis.worldBible.identityResolutions?.[0]?.confidence, 0.96);
});

test("uncertain identity claims are evidenced but not published as aliases", async () => {
  const sourceIndex: ChapterSourceIndex = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "A person arrives.",
    characters: [{
      name: "Person Alpha",
      aliases: ["Possible Name"],
      sourceReferences: [reference(0, 0)],
    }],
    actions: [],
    relationships: [],
  };
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{
      index: 0,
      title: "One",
      text: "Person Alpha arrives.\nPossible Name leaves.",
      summary: sourceIndex.summary,
      sourceIndex,
    }],
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  let identityInput = "";

  const analysis = await analyzeBook(book, {
    log: () => undefined,
    createResponse: async (request) => {
      const format = request.text?.format;
      if (format && "name" in format && format.name === "bookrpg_identity_resolution") {
        identityInput = String(request.input);
        return {
          output_text: JSON.stringify({
            identity_1: {
              decision: "uncertain",
              confidence: 0.45,
              evidenceReferenceIndexes: [0],
            },
          }),
          status: "completed",
        };
      }
      return {
        output_text: JSON.stringify({
          summary: "Whole story.",
          characterProfiles: [
            profile("Person Alpha", { aliases: ["Possible Name"] }),
          ],
          locations: [],
        }),
        status: "completed",
      };
    },
  });

  assert.match(identityInput, /LINE 1: Person Alpha arrives\./);
  assert.deepEqual(analysis.worldBible.characterProfiles?.[0]?.aliases, []);
  assert.equal(analysis.worldBible.identityResolutions?.[0]?.decision, "uncertain");
});

test("independent source evidence lets AI reject an incorrect alias claim", async () => {
  const sharedReference = reference(0, 0);
  const sourceIndex: ChapterSourceIndex = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "Two people interact.",
    characters: [
      {
        name: "Person Alpha",
        aliases: ["Person Beta"],
        sourceReferences: [sharedReference],
      },
      {
        name: "Person Beta",
        aliases: [],
        sourceReferences: [sharedReference],
      },
    ],
    actions: [],
    relationships: [{
      character: "Person Alpha",
      relatedCharacter: "Person Beta",
      description: "Person Alpha asks Person Beta for help.",
      sourceReferences: [sharedReference],
    }],
  };
  let callCount = 0;
  const analysis = await analyzeBook({
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{
      index: 0,
      title: "One",
      text: "Person Alpha asks Person Beta for help.",
      summary: sourceIndex.summary,
      sourceIndex,
    }],
    importedAt: "2026-01-01T00:00:00.000Z",
  }, {
    log: () => undefined,
    createResponse: async (request) => {
      callCount += 1;
      const format = request.text?.format;
      if (format && "name" in format && format.name === "bookrpg_identity_resolution") {
        return {
          output_text: JSON.stringify({
            identity_1: {
              decision: "different_people",
              confidence: 0.96,
              evidenceReferenceIndexes: [0],
            },
          }),
          status: "completed",
        };
      }
      return {
        output_text: JSON.stringify({
          summary: "Whole story.",
          characterProfiles: [
            profile("Person Alpha", { aliases: ["Person Beta"] }),
            profile("Person Beta"),
          ],
          locations: [],
        }),
        status: "completed",
      };
    },
  });

  assert.equal(callCount, 2);
  assert.equal(analysis.worldBible.characterProfiles?.length, 2);
  assert.deepEqual(analysis.worldBible.characterProfiles?.[0]?.aliases, []);
  assert.deepEqual(analysis.worldBible.identityResolutions?.[0], {
    canonicalName: "Person Alpha",
    alias: "Person Beta",
    decision: "different_people",
    confidence: 0.96,
    sourceReferences: [sharedReference],
  });
});

test("character IDs are deterministic within a book and scoped between books", () => {
  const sourceReference = reference(0, 0);
  const sourceIndex: ChapterSourceIndex = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "Saved summary.",
    characters: [{
      name: "Person Alpha",
      aliases: [],
      sourceReferences: [sourceReference],
    }],
    actions: [],
    relationships: [],
  };
  const output = JSON.stringify({
    summary: "Whole story.",
    characterProfiles: [profile("Person Alpha")],
    locations: [],
  });
  const firstBook = {
    bookId: "book-one",
    chapters: [{
      index: 0,
      title: "One",
      text: "Person Alpha arrives.",
      sourceIndex,
    }],
  };
  const secondBook = { ...firstBook, bookId: "book-two" };

  const firstId = parseWorldBibleOutput(output, firstBook).characterProfiles?.[0]?.characterId;
  const repeatedId = parseWorldBibleOutput(output, firstBook).characterProfiles?.[0]?.characterId;
  const secondId = parseWorldBibleOutput(output, secondBook).characterProfiles?.[0]?.characterId;

  assert.equal(firstId, repeatedId);
  assert.notEqual(firstId, secondId);
});

test("whole-book indexing merges profiles that overlap by an exact identity", () => {
  const sourceIndex: ChapterSourceIndex = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "A person arrives.",
    characters: [{
      name: "Person Alpha",
      aliases: ["Alpha"],
      sourceReferences: [reference(0, 0)],
    }],
    actions: [],
    relationships: [],
  };
  const worldBible = parseWorldBibleOutput(JSON.stringify({
    summary: "Whole story.",
    characterProfiles: [
      profile("Person Alpha", { aliases: ["Alpha"], traits: ["Bold"] }),
      profile("Alpha", { traits: ["Watchful"] }),
    ],
    locations: [],
  }), {
    bookId: "book-id",
    chapters: [{
      index: 0,
      title: "One",
      text: "Person Alpha arrives.",
      sourceIndex,
    }],
  }, [{
    canonicalName: "Person Alpha",
    alias: "Alpha",
    decision: "same_person",
    confidence: 0.95,
    sourceReferences: [reference(0, 0)],
  }]);

  assert.equal(worldBible.characterProfiles?.length, 1);
  assert.deepEqual(worldBible.characterProfiles?.[0]?.aliases, ["Alpha"]);
  assert.deepEqual(worldBible.characterProfiles?.[0]?.traits, ["Bold", "Watchful"]);
});

test("whole-book indexing merges transitive source-verified identities", () => {
  const sourceIndex: ChapterSourceIndex = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "One person appears under several names.",
    characters: [
      {
        name: "Person Alpha",
        aliases: ["Alpha"],
        sourceReferences: [reference(0, 0)],
      },
      {
        name: "Alias Alpha",
        aliases: [],
        sourceReferences: [reference(0, 0)],
      },
    ],
    actions: [],
    relationships: [],
  };
  const identityResolutions = [
    {
      canonicalName: "Person Alpha",
      alias: "Alpha",
      decision: "same_person" as const,
      confidence: 0.95,
      sourceReferences: [reference(0, 0)],
    },
    {
      canonicalName: "Alpha",
      alias: "Alias Alpha",
      decision: "same_person" as const,
      confidence: 0.95,
      sourceReferences: [reference(0, 0)],
    },
  ];
  const worldBible = parseWorldBibleOutput(JSON.stringify({
    summary: "Whole story.",
    characterProfiles: [
      profile("Person Alpha"),
    ],
    locations: [],
  }), {
    bookId: "book-id",
    chapters: [{
      index: 0,
      title: "One",
      text: "Person Alpha appears as Alpha and Alias Alpha.",
      sourceIndex,
    }],
  }, identityResolutions);

  assert.equal(worldBible.characterProfiles?.length, 1);
  assert.deepEqual(
    new Set(worldBible.characterProfiles?.[0]?.aliases),
    new Set(["Alpha", "Alias Alpha"]),
  );
});

test("whole-book indexing rejects source references that do not match stored chapters", () => {
  const sourceIndex: ChapterSourceIndex = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "Saved summary.",
    characters: [{
      name: "Person Alpha",
      aliases: [],
      sourceReferences: [reference(1, 0)],
    }],
    actions: [],
    relationships: [],
  };
  const output = JSON.stringify({
    summary: "Whole story.",
    characterProfiles: [profile("Person Alpha")],
    locations: [],
  });

  assert.throws(
    () => parseWorldBibleOutput(output, {
      bookId: "book-id",
      chapters: [{
        index: 0,
        title: "One",
        text: "Person Alpha arrives.",
        sourceIndex,
      }],
    }),
    /invalid reference/,
  );
});

test("book analysis retries only invalid source indexes and checkpoints completed chapters", async () => {
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [
      { index: 0, title: "One", text: "First chapter text." },
      { index: 1, title: "Two", text: "Second chapter text." },
    ],
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  const inputs: string[] = [];
  const checkpointSummaries: Array<Array<string | undefined>> = [];

  const analysis = await analyzeBook(book, {
    log: () => undefined,
    saveProgress: async () => {
      checkpointSummaries.push(
        book.chapters.map((chapter) => chapter.sourceIndex?.summary),
      );
    },
    createResponse: async (request) => {
      if (typeof request.input !== "string") {
        throw new Error("Expected request input to be a string");
      }
      inputs.push(request.input);
      if (inputs.length <= 2) {
        return {
          output_text: JSON.stringify({
            chapter_1_part_1: emptyPartIndex("Summary one."),
            chapter_2_part_1: {
              summary: "Summary two.",
              characters: [{
                name: "Person Gamma",
                aliases: [],
                references: [{ lineStart: 2, lineEnd: 2 }],
              }],
              actions: [],
              relationships: [],
            },
          }),
          status: "completed",
        };
      }
      if (inputs.length === 3) {
        return {
          output_text: JSON.stringify({
            chapter_2_part_1: emptyPartIndex("Summary two."),
          }),
          status: "completed",
        };
      }
      return {
        output_text: JSON.stringify(emptyWorldIndex()),
        status: "completed",
      };
    },
  });

  assert.match(inputs[0]!, /SOURCE_ID: chapter_1_part_1/);
  assert.doesNotMatch(inputs[0]!, /SOURCE_ID: chapter_2_part_1/);
  assert.doesNotMatch(inputs[1]!, /SOURCE_ID: chapter_1_part_1/);
  assert.match(inputs[1]!, /SOURCE_ID: chapter_2_part_1/);
  assert.deepEqual(analysis.chapterSummaries, ["Summary one.", "Summary two."]);
  assert.deepEqual(checkpointSummaries, [
    ["Summary one.", undefined],
    ["Summary one.", "Summary two."],
  ]);
});

test("book analysis retries incomplete chapter source index batches", async () => {
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{ index: 0, title: "One", text: "Source text." }],
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  let callCount = 0;
  const outputTokenLimits: number[] = [];

  const analysis = await analyzeBook(book, {
    log: () => undefined,
    createResponse: async (request) => {
      callCount += 1;
      outputTokenLimits.push(request.max_output_tokens ?? 0);
      if (callCount === 1) {
        return {
          output_text: "{",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        };
      }
      if (callCount === 2) {
        return {
          output_text: JSON.stringify({
            chapter_1_part_1: emptyPartIndex("Complete summary."),
          }),
          status: "completed",
        };
      }
      return {
        output_text: JSON.stringify(emptyWorldIndex()),
        status: "completed",
      };
    },
  });

  assert.equal(callCount, 3);
  assert.ok(outputTokenLimits[1]! > outputTokenLimits[0]!);
  assert.deepEqual(analysis.chapterSummaries, ["Complete summary."]);
});

test("book analysis scales chapter output tokens for long single-part sources", async () => {
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{ index: 0, title: "One", text: "A".repeat(40_000) }],
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  let callCount = 0;
  let chapterOutputTokenLimit = 0;

  await analyzeBook(book, {
    log: () => undefined,
    createResponse: async (request) => {
      callCount += 1;
      if (callCount === 1) {
        chapterOutputTokenLimit = request.max_output_tokens ?? 0;
        return {
          output_text: JSON.stringify({
            chapter_1_part_1: emptyPartIndex("Complete summary."),
          }),
          status: "completed",
        };
      }
      return {
        output_text: JSON.stringify(emptyWorldIndex()),
        status: "completed",
      };
    },
  });

  assert.equal(callCount, 2);
  assert.ok(chapterOutputTokenLimit >= book.chapters[0]!.text.length / 2);
  assert.ok(chapterOutputTokenLimit <= 64_000);
});

test("book analysis reuses saved source indexes", async () => {
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [
      {
        index: 0,
        title: "One",
        text: "First chapter text.",
        summary: "Saved one.",
        sourceIndex: emptySourceIndex("Saved one."),
      },
      {
        index: 1,
        title: "Two",
        text: "Second chapter text.",
        summary: "Saved two.",
        sourceIndex: emptySourceIndex("Saved two."),
      },
    ],
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  let callCount = 0;

  const analysis = await analyzeBook(book, {
    log: () => undefined,
    createResponse: async (request) => {
      callCount += 1;
      if (typeof request.input !== "string") {
        throw new Error("Expected request input to be a string");
      }
      assert.match(request.input, /Saved one\./);
      assert.match(request.input, /Saved two\./);
      return {
        output_text: JSON.stringify(emptyWorldIndex()),
        status: "completed",
      };
    },
  });

  assert.deepEqual(analysis.chapterSummaries, ["Saved one.", "Saved two."]);
  assert.equal(callCount, 1);
});

test("book analysis reuses a complete current world index without another API call", async () => {
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{
      index: 0,
      title: "One",
      text: "Non-narrative material.",
      summary: "Saved summary.",
      sourceIndex: emptySourceIndex("Saved summary."),
    }],
    worldBible: {
      schemaVersion: WORLD_BIBLE_SCHEMA_VERSION,
      summary: "Saved whole-book summary.",
      characters: [],
      characterProfiles: [],
      locations: [],
    },
    importedAt: "2026-01-01T00:00:00.000Z",
  };

  const analysis = await analyzeBook(book, {
    log: () => undefined,
    createResponse: async () => {
      throw new Error("No API call expected");
    },
  });

  assert.equal(analysis.worldBible, book.worldBible);
  assert.deepEqual(analysis.chapterSummaries, ["Saved summary."]);
});

test("whole-book indexing retries omitted core identities and canonicalizes relationships", async () => {
  const sharedReference = reference(0, 2);
  const sourceIndex: ChapterSourceIndex = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    summary: "Two people interact.",
    characters: [
      {
        name: "Person Alpha",
        aliases: ["Alpha"],
        sourceReferences: [sharedReference],
      },
      {
        name: "Person Beta",
        aliases: ["Beta"],
        sourceReferences: [sharedReference],
      },
    ],
    actions: [],
    relationships: [{
      character: "Person Alpha",
      relatedCharacter: "Person Beta",
      description: "They know each other.",
      sourceReferences: [sharedReference],
    }],
  };
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters: [{
      index: 2,
      title: "One",
      text: "Person Alpha knows Person Beta.",
      summary: sourceIndex.summary,
      sourceIndex,
    }],
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  let callCount = 0;

  const analysis = await analyzeBook(book, {
    log: () => undefined,
    createResponse: async (request) => {
      callCount += 1;
      const format = request.text?.format;
      return {
        output_text: JSON.stringify(
          format && "name" in format && format.name === "bookrpg_identity_resolution"
            ? {
                identity_1: {
                  decision: "same_person",
                  confidence: 0.95,
                  evidenceReferenceIndexes: [0],
                },
                identity_2: {
                  decision: "same_person",
                  confidence: 0.95,
                  evidenceReferenceIndexes: [0],
                },
              }
            : callCount === 2
            ? {
                summary: "Whole story.",
                characterProfiles: [
                  profile("Person Alpha", {
                    aliases: ["Alpha"],
                  }),
                ],
                locations: [],
              }
            : {
                summary: "Whole story.",
                characterProfiles: [
                  profile("Person Alpha", {
                    aliases: ["Alpha"],
                  }),
                  profile("Person Beta", {
                    aliases: ["Beta"],
                    role: "Acquaintance",
                    description: "A person who knows Person Alpha.",
                  }),
                ],
                locations: [],
              },
        ),
        status: "completed",
      };
    },
  });

  assert.equal(callCount, 3);
  const profiles = analysis.worldBible.characterProfiles ?? [];
  assert.deepEqual(profiles[1]?.aliases, ["Beta"]);
  assert.equal(profiles[1]?.role, "Acquaintance");
  assert.equal(profiles[0]?.relationships[0]?.character, "Person Beta");
  assert.equal(
    profiles[0]?.relationships[0]?.characterId,
    profiles[1]?.characterId,
  );
});

test("whole-book indexing retries partial supplemental omissions without regenerating", async () => {
  const suppliedNames = [
    "Person A",
    ...Array.from({ length: 9 }, (_, index) => `Core Person ${index + 1}`),
  ];
  const additionalObservedNames = [
    "Person C",
    ...Array.from({ length: 4 }, (_, index) => `Missing Person ${index + 1}`),
  ];
  const hiddenName = "Hidden Person";
  const observedNames = [...suppliedNames, ...additionalObservedNames, hiddenName];
  const chapterIndexes = [2, 4, 6];
  const chapters = chapterIndexes.map((chapterIndex, chapterPosition) => {
    const sourceReference = reference(chapterPosition, chapterIndex);
    const sourceIndex: ChapterSourceIndex = {
      schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
      summary: `Saved summary ${chapterPosition + 1}.`,
      characters: observedNames.map((name) => ({
        name,
        aliases: [],
        sourceReferences: [sourceReference],
      })),
      actions: [],
      relationships: [],
    };
    return {
      index: chapterIndex,
      title: `Chapter ${chapterPosition + 1}`,
      text: [...observedNames, "Person B"].join(" "),
      summary: sourceIndex.summary,
      sourceIndex,
    };
  });
  const priorIdentityResolutions = [
    {
      canonicalName: "Person A",
      alias: "Person B",
      decision: "same_person" as const,
      confidence: 0.95,
      sourceReferences: [reference(0, chapterIndexes[0]!)],
    },
    {
      canonicalName: "Person B",
      alias: "Person C",
      decision: "same_person" as const,
      confidence: 0.95,
      sourceReferences: [reference(0, chapterIndexes[0]!)],
    },
  ];
  const book: ImportedBook = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Synthetic Story",
    chapters,
    worldBible: {
      summary: "Outdated index.",
      characters: [],
      characterProfiles: [],
      identityResolutions: priorIdentityResolutions,
      locations: [],
    },
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  let wholeBookRequests = 0;
  const supplementalRequests: string[][] = [];

  const analysis = await analyzeBook(book, {
    log: () => undefined,
    createResponse: async (request) => {
      const format = request.text?.format;
      const formatName = format && "name" in format ? format.name : "";
      if (formatName === "bookrpg_identity_resolution") {
        return {
          output_text: JSON.stringify({
            identity_1: {
              decision: "same_person",
              confidence: 0.95,
              evidenceReferenceIndexes: [0],
            },
            identity_2: {
              decision: "same_person",
              confidence: 0.95,
              evidenceReferenceIndexes: [0],
            },
          }),
          status: "completed",
        };
      }
      if (formatName === "bookrpg_world_bible") {
        wholeBookRequests += 1;
        return {
          output_text: JSON.stringify({
            summary: "Whole story.",
            characterProfiles: suppliedNames.map((name) => profile(name)),
            locations: [],
          }),
          status: "completed",
        };
      }
      if (formatName === "bookrpg_supplemental_character_profiles") {
        if (typeof request.input !== "string") {
          throw new Error("Expected supplemental input to be a string");
        }
        const requiredLine = request.input.match(/^REQUIRED PROFILES: (.+)$/m)?.[1];
        if (!requiredLine) throw new Error("Missing required supplemental profiles");
        const requiredNames = JSON.parse(requiredLine) as string[];
        supplementalRequests.push(requiredNames);
        const responseNames = supplementalRequests.length === 1
          ? requiredNames.slice(0, -1)
          : requiredNames;
        return {
          output_text: JSON.stringify({
            characterProfiles: responseNames.map((name) => profile(name)),
          }),
          status: "completed",
        };
      }
      throw new Error(`Unexpected response format: ${formatName}`);
    },
  });

  assert.equal(wholeBookRequests, 1);
  assert.deepEqual(supplementalRequests, [
    [...additionalObservedNames.slice(1), hiddenName],
    [hiddenName],
  ]);
  assert.equal(
    analysis.worldBible.characterProfiles?.some(
      (candidate) =>
        candidate.role === "Observed character"
        && candidate.description === "A character evidenced by the chapter source index.",
    ),
    false,
  );
  assert.ok(
    analysis.worldBible.characterProfiles?.some(
      (candidate) =>
        candidate.name === "Person A"
        && candidate.aliases.includes("Person C"),
    ),
  );
});


