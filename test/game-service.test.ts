import assert from "node:assert/strict";
import test from "node:test";
import { SceneGenerationError } from "../src/ai/engine.js";
import type { SourceContinuationCandidate } from "../src/ai/engine.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
  FREE_ACTION_CHOICE_ID,
  SOURCE_ANCHOR_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_TEXT,
} from "../src/shared/contracts.js";
import type { GameState, ImportedBook } from "../src/shared/contracts.js";
import {
  attemptSourceContinuation,
  appendGameParameter,
  buildCanonicalNextEventCandidate,
  buildSourceContextCandidates,
  canonicalGameStartContext,
  canonicalPlayerStartAvailability,
  canonicalStartCharacters,
  eventGenerationFailureScene,
  isIndividualStartingCharacter,
  isAnchorDirectedChoice,
  MAX_STARTING_CHARACTER_OPTIONS,
  PlayerUnavailableError,
  resolveEventText,
  resolveFreeAction,
  resolveParameterText,
  selectGroundedSourceCandidates,
  sourceIntroducedCharactersAtCursor,
  sourceCandidateForEvent,
  startingCharacterOptions,
  storyContinuationUnavailableNotice,
  titleForTurn,
} from "../src/games/service.js";

test("player availability failures expose a typed API-safe error", () => {
  const error = new PlayerUnavailableError(
    "Person Alpha",
    "Person Alpha cannot act at this point.",
  );

  assert.equal(error.code, "PLAYER_UNAVAILABLE");
  assert.equal(error.playerName, "Person Alpha");
  assert.equal(error.reason, "Person Alpha cannot act at this point.");
  assert.match(error.message, /^Cannot play as Person Alpha at this point:/);
});

test("the reserved free action request returns trimmed action text", () => {
  assert.equal(
    resolveFreeAction({
      choiceId: FREE_ACTION_CHOICE_ID,
      actionText: "  Search behind the bookcase.  ",
    }),
    "Search behind the bookcase.",
  );
  assert.equal(resolveFreeAction({ choiceId: "normal_choice" }), undefined);
});

test("source continuation and concrete source anchors activate directed routing", () => {
  const scene = {
    choices: [
      {
        id: SOURCE_CONTINUATION_CHOICE_ID,
        type: "action" as const,
        text: SOURCE_CONTINUATION_CHOICE_TEXT,
      },
      { id: "local", type: "action" as const, text: "Remain with the local detail" },
    ],
  };

  assert.equal(isAnchorDirectedChoice(scene, SOURCE_CONTINUATION_CHOICE_ID), true);
  assert.equal(isAnchorDirectedChoice(scene, "local"), false);
  assert.equal(
    isAnchorDirectedChoice({
      choices: [{
        id: SOURCE_ANCHOR_CHOICE_ID,
        type: "action",
        text: "Follow a concrete route toward the next story event",
      }],
    }, SOURCE_ANCHOR_CHOICE_ID),
    true,
  );
  assert.equal(
    isAnchorDirectedChoice({
      choices: [{ id: "anchor", type: "action", text: "Follow a local story lead" }],
    }, "anchor"),
    false,
  );
  assert.equal(isAnchorDirectedChoice({ choices: [] }, "anchor"), false);
});

test("an exact source anchor bypasses a broader later event candidate", () => {
  const candidates: SourceContinuationCandidate[] = [
    {
      chapterPosition: 0,
      chapterTitle: "The evening",
      summary: "Patrick is expected home.",
      excerpt: "Mary waits in the quiet room.",
      nextTextOffset: 120,
      storyEvents: [{
        eventId: "patrick-arrives",
        sequence: 2,
        description: "Patrick arrives home.",
        chapterPosition: 0,
        category: "arrival",
        actors: ["Mary"],
        targets: ["Patrick"],
      }],
    },
    {
      chapterPosition: 0,
      chapterTitle: "The evening",
      summary: "Patrick reveals his decision.",
      excerpt: "Patrick sits with his drink.",
      nextTextOffset: 240,
      storyEvents: [{
        eventId: "patrick-reveals-decision",
        sequence: 3,
        description: "Patrick says he plans to leave.",
        chapterPosition: 0,
        category: "revelation",
        actors: ["Patrick"],
        targets: ["Mary"],
      }],
    },
  ];

  assert.equal(
    sourceCandidateForEvent(candidates, "patrick-arrives"),
    candidates[0],
  );
  assert.equal(
    sourceCandidateForEvent(candidates, "patrick-reveals-decision"),
    candidates[1],
  );
  assert.equal(sourceCandidateForEvent(candidates, "unknown-event"), undefined);
});

test("server turn numbering replaces an AI-generated stale turn suffix", () => {
  assert.equal(titleForTurn("Opening", 1), "Opening (Turn 1)");
  assert.equal(titleForTurn("A Calm in the Storm (Turn 1)", 2), "A Calm in the Storm (Turn 2)");
  assert.equal(titleForTurn("A Calm in the Storm", 3), "A Calm in the Storm (Turn 3)");
  assert.equal(titleForTurn("Opening (Turn 9)", 0), "Opening");
  assert.equal(
    titleForTurn(
      "Along the Road to Oz (Turn 4c) (Turn 7) — The Scarecrow Talks with Dorothy",
      8,
    ),
    "The Scarecrow Talks with Dorothy (Turn 8)",
  );
  assert.equal(
    titleForTurn("A Title (Turn 2) with a stale marker", 4),
    "A Title with a stale marker (Turn 4)",
  );
});

test("event-linked characters become source-introduced only when their event is reached", () => {
  const deathReference = {
    chapterPosition: 0,
    chapterIndex: 0,
    lineStart: 1,
    lineEnd: 1,
  };
  const arrivalReference = {
    chapterPosition: 0,
    chapterIndex: 0,
    lineStart: 3,
    lineEnd: 3,
  };
  const book: ImportedBook = {
    bookId: "event-character-book",
    sourceSha256: "sha256",
    title: "Event Characters",
    chapters: [{ index: 0, title: "Story", text: "The events unfold." }],
    storyEvents: [
      {
        eventId: "patrick-dies",
        sequence: 1,
        description: "Mary kills Patrick.",
        category: "death",
        chapterPosition: 0,
        actors: ["Mary Maloney"],
        targets: ["Patrick Maloney"],
        sourceReferences: [deathReference],
      },
      {
        eventId: "police-arrive",
        sequence: 2,
        description: "The detectives arrive at the house.",
        category: "arrival",
        chapterPosition: 0,
        actors: ["Detectives"],
        targets: ["Mary Maloney"],
        sourceReferences: [arrivalReference],
      },
    ],
    worldBible: {
      summary: "A murder is followed by an investigation.",
      characters: ["Mary Maloney", "Patrick Maloney", "Detectives"],
      characterProfiles: [
        {
          name: "Mary Maloney",
          aliases: ["Mary"],
          role: "Protagonist",
          description: "Patrick's wife.",
          traits: [],
          relationships: [],
          sourceReferences: [deathReference],
          storyArc: "She conceals the crime.",
        },
        {
          name: "Patrick Maloney",
          aliases: ["Patrick"],
          role: "Husband",
          description: "Mary's husband.",
          traits: [],
          relationships: [],
          sourceReferences: [deathReference],
          storyArc: "He is killed.",
        },
        {
          name: "Detectives",
          aliases: ["investigators", "police"],
          role: "Police investigators",
          description: "They investigate Patrick's death.",
          traits: [],
          relationships: [],
          sourceReferences: [arrivalReference],
          storyArc: "They arrive after the police are called.",
        },
      ],
      locations: [],
    },
    importedAt: "2026-08-29T12:00:00.000Z",
  };

  assert.deepEqual(
    sourceIntroducedCharactersAtCursor(book, {
      chapterPosition: 0,
      textOffset: 0,
      eventId: "patrick-dies",
    }),
    ["Mary Maloney", "Patrick Maloney"],
  );
  assert.deepEqual(
    sourceIntroducedCharactersAtCursor(book, {
      chapterPosition: 0,
      textOffset: 0,
      eventId: "police-arrive",
    }),
    ["Mary Maloney", "Patrick Maloney", "Detectives"],
  );
  assert.deepEqual(
    canonicalStartCharacters(book),
    ["Mary Maloney", "Patrick Maloney", "Detectives"],
  );
  assert.equal(
    canonicalPlayerStartAvailability(book, "Patrick"),
    true,
  );
  assert.equal(
    canonicalPlayerStartAvailability(book, "Detectives"),
    false,
  );
  assert.equal(isIndividualStartingCharacter(book, "Mary Maloney"), true);
  assert.equal(isIndividualStartingCharacter(book, "Detectives"), false);
  assert.deepEqual(
    startingCharacterOptions(book),
    ["Mary Maloney", "Patrick Maloney"],
  );
  assert.equal(
    canonicalPlayerStartAvailability(book, "A visiting journalist"),
    undefined,
  );
});

test("the playable list includes analyzed chapter characters outside the core cast", () => {
  const reference = {
    chapterPosition: 0,
    chapterIndex: 0,
    lineStart: 1,
    lineEnd: 1,
  };
  const book: ImportedBook = {
    bookId: "all-analyzed-characters",
    sourceSha256: "sha256",
    title: "A Crowded Story",
    chapters: [{
      index: 0,
      title: "Chapter One",
      text: "The courier enters.\nThe observer watches.",
      summary: "A minor courier enters while an observer watches.",
      sourceIndex: {
        schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
        summary: "A minor courier enters while an observer watches.",
        significantEvents: [],
        characters: [
          {
            name: "Minor Courier",
            aliases: ["the courier"],
            sourceReferences: [reference],
          },
          {
            name: "Quiet Observer",
            aliases: ["the observer"],
            sourceReferences: [{
              chapterPosition: 0,
              chapterIndex: 0,
              lineStart: 2,
              lineEnd: 2,
            }],
          },
        ],
        actions: [],
        relationships: [],
      },
    }],
    storyEvents: [{
      eventId: "courier-enters",
      sequence: 1,
      description: "The minor courier enters.",
      category: "arrival",
      chapterPosition: 0,
      actors: ["Minor Courier"],
      targets: [],
      sourceReferences: [reference],
    }],
    worldBible: {
      summary: "A crowded story.",
      characters: ["Hero"],
      characterProfiles: [],
      locations: [],
    },
    importedAt: "2026-08-30T00:00:00.000Z",
  };

  assert.deepEqual(
    canonicalStartCharacters(book),
    ["Hero", "Minor Courier", "Quiet Observer"],
  );
  assert.equal(canonicalPlayerStartAvailability(book, "the courier"), true);
  assert.equal(
    canonicalGameStartContext(book, "Minor Courier").selectedText,
    "The minor courier enters.",
  );
  assert.equal(
    canonicalGameStartContext(book, "Quiet Observer").selectedText,
    "The observer watches.",
  );
});

test("new-game character options are limited without truncating the canonical cast", () => {
  assert.equal(MAX_STARTING_CHARACTER_OPTIONS, 5);
  const individuals = Array.from(
    { length: MAX_STARTING_CHARACTER_OPTIONS + 5 },
    (_, index) => `Character ${index + 1}`,
  );
  const characters = [
    ...individuals.slice(0, 2),
    "Detectives",
    ...individuals.slice(2),
  ];
  const book: ImportedBook = {
    bookId: "large-cast",
    sourceSha256: "sha256",
    title: "A Large Cast",
    chapters: [],
    worldBible: {
      summary: "Many characters take part.",
      characters,
      characterProfiles: [],
      locations: [],
    },
    importedAt: "2026-09-02T00:00:00.000Z",
  };

  assert.deepEqual(canonicalStartCharacters(book), characters);
  assert.deepEqual(
    startingCharacterOptions(book),
    individuals.slice(0, MAX_STARTING_CHARACTER_OPTIONS),
  );
});

test("individual authority figures are not mistaken for groups", () => {
  const book: ImportedBook = {
    bookId: "individual-authority",
    sourceSha256: "sha256",
    title: "The Inspector",
    chapters: [],
    worldBible: {
      summary: "An inspector investigates.",
      characters: ["Police Chief", "Inspector Smith"],
      characterProfiles: [{
        name: "Police Chief",
        aliases: [],
        role: "Leader of the detectives",
        description: "A police chief who leads the investigation.",
        traits: [],
        relationships: [],
        storyArc: "The chief solves the case.",
      }],
      locations: [],
    },
    importedAt: "2026-09-02T00:00:00.000Z",
  };

  assert.deepEqual(
    startingCharacterOptions(book),
    ["Police Chief", "Inspector Smith"],
  );
});

test("new games start at the selected character's earliest active story event", () => {
  const firstReference = {
    chapterPosition: 1,
    chapterIndex: 1,
    lineStart: 2,
    lineEnd: 3,
  };
  const secondReference = {
    chapterPosition: 1,
    chapterIndex: 1,
    lineStart: 3,
    lineEnd: 3,
  };
  const book: ImportedBook = {
    bookId: "canonical-start-book",
    sourceSha256: "sha256",
    title: "Canonical Start",
    chapters: [
      {
        index: 0,
        title: "Title Page",
        text: "Copyright and publication details.",
        summary: "Front matter and publication details.",
      },
      {
        index: 1,
        title: "Chapter One",
        text:
          "Chapter One\nMary waits beside the window.\nPatrick arrives home.\nA later crime occurs.",
        summary: "Mary waits before Patrick arrives.",
        sourceIndex: {
          schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
          summary: "Mary waits before Patrick arrives.",
          characters: [
            { name: "Mary", aliases: [], sourceReferences: [firstReference] },
            { name: "Patrick", aliases: [], sourceReferences: [secondReference] },
          ],
          actions: [],
          relationships: [],
        },
      },
    ],
    storyEvents: [
      {
        eventId: "mary-waits",
        sequence: 1,
        description: "Mary waits beside the window.",
        category: "other",
        chapterPosition: 1,
        actors: ["Mary", "Patrick"],
        targets: ["Patrick"],
        sourceReferences: [firstReference],
      },
      {
        eventId: "patrick-arrives",
        sequence: 2,
        description: "Patrick arrives home.",
        category: "arrival",
        chapterPosition: 1,
        actors: ["Patrick"],
        targets: ["Mary"],
        sourceReferences: [secondReference],
      },
      {
        eventId: "later-crime",
        sequence: 3,
        description: "A later crime occurs.",
        category: "violence",
        chapterPosition: 1,
        actors: ["Mary"],
        targets: ["Patrick"],
        sourceReferences: [{
          chapterPosition: 1,
          chapterIndex: 1,
          lineStart: 4,
          lineEnd: 4,
        }],
      },
    ],
    importedAt: "2026-08-29T12:00:00.000Z",
  };

  const maryStart = canonicalGameStartContext(book, "Mary");

  assert.deepEqual(maryStart.position, {
    chapterIndex: 1,
    chapterTitle: "Chapter One",
    progress: 0,
  });
  assert.deepEqual(maryStart.sourceCursor, {
    chapterPosition: 1,
    textOffset: "Chapter One".length,
  });
  assert.equal(maryStart.selectedText, "Mary waits beside the window.");
  assert.equal(maryStart.candidate.requiredEventId, undefined);
  assert.equal(maryStart.candidate.requiredEvent, undefined);
  assert.deepEqual(
    maryStart.candidate.storyEvents?.map((event) => event.eventId),
    ["mary-waits", "patrick-arrives"],
  );
  assert.equal(maryStart.candidate.currentStoryEvent?.eventId, "mary-waits");
  assert.deepEqual(maryStart.candidate.unavailableCharacters, ["Patrick"]);
  assert.doesNotMatch(maryStart.candidate.excerpt, /Copyright/);
  assert.doesNotMatch(maryStart.candidate.excerpt, /Patrick arrives/i);
  assert.doesNotMatch(maryStart.candidate.excerpt, /later crime/i);

  const patrickStart = canonicalGameStartContext(book, "Patrick");
  assert.deepEqual(patrickStart.position, maryStart.position);
  assert.deepEqual(patrickStart.sourceCursor, {
    chapterPosition: 1,
    textOffset: "Chapter One Mary waits beside the window.".length,
  });
  assert.equal(patrickStart.selectedText, "Patrick arrives home.");
  assert.equal(patrickStart.candidate.requiredEvent, undefined);
  assert.equal(patrickStart.candidate.summary, "Patrick arrives home.");
  assert.equal(
    patrickStart.candidate.chapterSummary,
    "Mary waits before Patrick arrives.",
  );
  assert.deepEqual(
    patrickStart.candidate.storyEvents?.map((event) => event.eventId),
    ["patrick-arrives", "later-crime"],
  );
  assert.equal(patrickStart.candidate.currentStoryEvent?.eventId, "patrick-arrives");
  assert.deepEqual(patrickStart.candidate.storySoFar, [{
    chapterPosition: 1,
    chapterTitle: "Chapter One",
    summary: "Earlier in this chapter: Mary waits beside the window.",
  }]);
  assert.doesNotMatch(patrickStart.candidate.excerpt, /Mary waits/i);
  assert.doesNotMatch(patrickStart.candidate.excerpt, /later crime/i);
  assert.doesNotMatch(patrickStart.candidate.summary, /later crime/i);
  assert.doesNotMatch(patrickStart.candidate.chapterSummary ?? "", /later crime/i);
});

test("character openings include at most three prior narrative chapter summaries", () => {
  const chapters = [
    { index: 0, title: "Title Page", text: "Copyright.", summary: "Front matter." },
    { index: 1, title: "One", text: "An earlier event.", summary: "The journey begins." },
    { index: 2, title: "Two", text: "Another event.", summary: "The road narrows." },
    { index: 3, title: "Three", text: "A third event.", summary: "The group reaches a city." },
    { index: 4, title: "Four", text: "A fourth event.", summary: "The city closes its gates." },
    { index: 5, title: "Five", text: "Iris enters.", summary: "Iris enters the story." },
  ];
  const storyEvents = chapters.slice(1).map((chapter, index) => ({
    eventId: `event-${index + 1}`,
    sequence: index + 1,
    description: chapter.text,
    category: "other" as const,
    chapterPosition: chapter.index,
    actors: chapter.index === 5 ? ["Iris"] : ["Other travellers"],
    targets: [],
    sourceReferences: [{
      chapterPosition: chapter.index,
      chapterIndex: chapter.index,
      lineStart: 1,
      lineEnd: 1,
    }],
  }));
  const book: ImportedBook = {
    bookId: "bounded-opening-context",
    sourceSha256: "sha256",
    title: "A Long Journey",
    chapters,
    storyEvents,
    worldBible: {
      summary: "The complete journey.",
      characters: ["Iris", "Other travellers"],
      characterProfiles: [],
      locations: [],
    },
    importedAt: "2026-08-30T00:00:00.000Z",
  };

  const start = canonicalGameStartContext(book, "Iris");

  assert.equal(start.position.chapterIndex, 5);
  assert.deepEqual(
    start.candidate.storySoFar?.map((chapter) => chapter.chapterTitle),
    ["Two", "Three", "Four"],
  );
  assert.doesNotMatch(
    JSON.stringify(start.candidate.storySoFar),
    /Front matter|The journey begins|Iris enters/i,
  );
});

test("a reliable event cursor resolves the direct next event without AI selection", () => {
  const book: ImportedBook = {
    bookId: "deterministic-next-event",
    sourceSha256: "sha256",
    title: "Deterministic Timeline",
    chapters: [{
      index: 0,
      title: "Chapter One",
      text: "Mary waits.\nPatrick arrives.\nPatrick speaks.",
      summary: "Three events occur in order.",
    }],
    storyEvents: [
      {
        eventId: "wait",
        sequence: 1,
        description: "Mary waits.",
        category: "other",
        chapterPosition: 0,
        actors: ["Mary"],
        targets: [],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 1,
          lineEnd: 1,
        }],
      },
      {
        eventId: "arrival",
        sequence: 2,
        description: "Patrick arrives.",
        category: "arrival",
        chapterPosition: 0,
        actors: ["Patrick"],
        targets: ["Mary"],
        beats: [{
          actor: "Patrick",
          action: "Arrives.",
          targets: ["Mary"],
          agency: "intentional",
          stakes: "significant",
          sourceReferences: [{
            chapterPosition: 0,
            chapterIndex: 0,
            lineStart: 2,
            lineEnd: 2,
          }],
        }],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 2,
          lineEnd: 2,
        }],
      },
      {
        eventId: "speech",
        sequence: 3,
        description: "Patrick speaks.",
        category: "revelation",
        chapterPosition: 0,
        actors: ["Patrick"],
        targets: ["Mary"],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 3,
          lineEnd: 3,
        }],
      },
    ],
    importedAt: "2026-08-29T12:00:00.000Z",
  };

  const candidate = buildCanonicalNextEventCandidate(book, {
    chapterPosition: 0,
    textOffset: "Mary waits.".length,
    eventId: "wait",
  });

  assert.equal(candidate?.requiredEventId, "arrival");
  assert.equal(candidate?.requiredEvent, "Patrick arrives.");
  assert.equal(candidate?.excerpt, "Patrick arrives.");
  assert.equal(candidate?.requiredEventBeats?.[0]?.agency, "intentional");
  assert.equal(candidate?.storyEvents?.[0]?.beats?.[0]?.action, "Arrives.");
  assert.equal(
    candidate?.sourceReferenceExcerpts?.["0:0:2:2"],
    "Patrick arrives.",
  );
  assert.deepEqual(
    candidate?.storyEvents?.map((event) => event.eventId),
    ["arrival", "speech"],
  );
  assert.equal(candidate?.currentStoryEvent?.eventId, "wait");
  const reindexedCandidate = buildCanonicalNextEventCandidate(book, {
    chapterPosition: 0,
    textOffset: "Mary waits.".length,
    eventId: "stale_wait_event_id",
  });
  assert.equal(reindexedCandidate?.currentStoryEvent?.eventId, "wait");
  assert.equal(reindexedCandidate?.requiredEventId, "arrival");

  const anchoredCandidates = buildSourceContextCandidates(
    book,
    {
      chapterPosition: 0,
      textOffset: book.chapters[0]!.text.replace(/\s+/g, " ").length,
      eventId: "wait",
    },
  );

  assert.equal(anchoredCandidates.length, 1);
  assert.equal(anchoredCandidates[0]?.requiredEventId, "arrival");
  assert.equal(anchoredCandidates[0]?.excerpt, "Patrick arrives.");
  assert.equal(
    anchoredCandidates[0]?.nextTextOffset,
    "Mary waits. Patrick arrives.".length,
  );
});

test("canonical anchors skip global events unrelated to the player", async () => {
  const currentEvent = {
    eventId: "snape_class",
    sequence: 1,
    description: "Snape finishes the Potions lesson.",
    category: "other" as const,
    chapterPosition: 0,
    actors: ["Severus Snape"],
    targets: ["Harry Potter"],
    sourceReferences: [{
      chapterPosition: 0,
      chapterIndex: 0,
      lineStart: 1,
      lineEnd: 1,
    }],
  };
  const unrelatedEvent = {
    eventId: "hagrid_tea",
    sequence: 2,
    description: "Harry reads about Gringotts while visiting Hagrid.",
    category: "discovery" as const,
    chapterPosition: 0,
    actors: ["Harry Potter"],
    targets: ["Rubeus Hagrid"],
    sourceReferences: [{
      chapterPosition: 0,
      chapterIndex: 0,
      lineStart: 2,
      lineEnd: 2,
    }],
  };
  const nextPlayerEvent = {
    eventId: "snape_corridor",
    sequence: 3,
    description: "Snape confronts Quirrell in a corridor.",
    category: "other" as const,
    chapterPosition: 0,
    actors: ["Severus Snape"],
    targets: ["Quirinus Quirrell"],
    sourceReferences: [{
      chapterPosition: 0,
      chapterIndex: 0,
      lineStart: 3,
      lineEnd: 3,
    }],
  };
  const book: ImportedBook = {
    bookId: "player-specific-timeline",
    sourceSha256: "sha256",
    title: "Player-Specific Timeline",
    chapters: [{
      index: 0,
      title: "Chapter One",
      text: [
        currentEvent.description,
        unrelatedEvent.description,
        nextPlayerEvent.description,
      ].join("\n"),
      summary: "Events involving different characters occur.",
    }],
    storyEvents: [currentEvent, unrelatedEvent, nextPlayerEvent],
    worldBible: {
      summary: "A school mystery.",
      characters: ["Severus Snape", "Harry Potter", "Rubeus Hagrid", "Quirinus Quirrell"],
      characterProfiles: [{
        name: "Severus Snape",
        aliases: ["Snape"],
        role: "Potions master",
        description: "A Hogwarts professor.",
        traits: ["secretive"],
        relationships: [],
        storyArc: "Protects the school.",
        significantEvents: [currentEvent, nextPlayerEvent],
      }],
      locations: [],
    },
    importedAt: "2026-09-02T00:00:00.000Z",
  };
  const cursor = {
    chapterPosition: 0,
    textOffset: currentEvent.description.length,
    eventId: currentEvent.eventId,
  };

  assert.equal(
    buildCanonicalNextEventCandidate(book, cursor)?.requiredEventId,
    unrelatedEvent.eventId,
  );
  const playerCandidate = buildCanonicalNextEventCandidate(
    book,
    cursor,
    "Snape",
  );
  assert.equal(playerCandidate?.requiredEventId, nextPlayerEvent.eventId);
  assert.deepEqual(
    playerCandidate?.storyEvents?.map((event) => event.eventId),
    [nextPlayerEvent.eventId],
  );
  const game: GameState = {
    gameId: "player-specific-source-selection",
    book: {
      bookId: book.bookId,
      title: book.title,
    },
    playerName: "Severus Snape",
    characterProfiles: book.worldBible?.characterProfiles,
    gameProfile: {
      category: "mystery",
      endingMode: "open_ended",
      description: "A school mystery.",
    },
    objective: "Shape Snape's path.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: currentEvent.description,
    sourceCursor: cursor,
    scene: {
      title: "The classroom",
      text: "I watch the students leave.",
      choices: [],
    },
    history: [],
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  assert.deepEqual(
    await selectGroundedSourceCandidates(
      game,
      book,
      cursor,
      [playerCandidate!],
    ),
    [playerCandidate],
  );
  assert.deepEqual(
    await selectGroundedSourceCandidates(
      game,
      book,
      cursor,
      [playerCandidate!],
      "stale_next_player_event_id",
    ),
    [playerCandidate],
  );
  assert.equal(
    buildSourceContextCandidates(
      book,
      cursor,
      "Severus Snape",
    )[0]?.requiredEventId,
    nextPlayerEvent.eventId,
  );
  assert.deepEqual(
    buildSourceContextCandidates(book, {
      chapterPosition: 0,
      textOffset: book.chapters[0]!.text.replace(/\s+/g, " ").length,
      eventId: nextPlayerEvent.eventId,
    }, "Snape"),
    [],
  );
});

test("free action requests require bounded text", () => {
  assert.throws(
    () => resolveFreeAction({ choiceId: FREE_ACTION_CHOICE_ID, actionText: " " }),
    /required/,
  );
  assert.throws(
    () => resolveFreeAction({
      choiceId: FREE_ACTION_CHOICE_ID,
      actionText: "A".repeat(1_001),
    }),
    /at most 1000/,
  );
});

test("event requests require bounded text and return trimmed input", () => {
  assert.equal(
    resolveEventText({ text: "  A storm knocks out the power.  " }),
    "A storm knocks out the power.",
  );
  assert.throws(
    () => resolveEventText({ text: " " }),
    /required/,
  );
  assert.throws(
    () => resolveEventText({ text: "E".repeat(1_001) }),
    /at most 1000/,
  );
});

test("exhausted custom event generation becomes a clear terminal loss", () => {
  const scene = eventGenerationFailureScene(
    "The detectives start shooting their guns in the air.",
    new SceneGenerationError([
      "A turn without PLAYER ACTION must use empty playerAction/actionResult and actionOutcome 'none'.",
    ], 4),
  );

  assert.equal(scene.outcome, "lost");
  assert.deepEqual(scene.choices, []);
  assert.match(scene.title, /game over/i);
  assert.match(scene.text, /detectives start shooting/i);
  assert.match(scene.text, /why you lost/i);
  assert.match(scene.text, /character is dead/i);
  assert.match(scene.text, /after 4 generation attempts/i);
  assert.match(
    scene.outcomeReason ?? "",
    /final draft was rejected because: A turn without PLAYER ACTION/i,
  );
  assert.match(scene.outcomeReason ?? "", /Exhausting all custom-event retries triggers a loss/i);
});

test("parameter requests are trimmed, bounded, and appended in precedence order", () => {
  assert.equal(
    resolveParameterText({
      text: "  Person Alpha now prioritizes protecting the archive.  ",
    }),
    "Person Alpha now prioritizes protecting the archive.",
  );
  assert.throws(
    () => resolveParameterText({ text: " " }),
    /required/,
  );
  assert.throws(
    () => resolveParameterText({ text: "P".repeat(1_001) }),
    /at most 1000/,
  );

  assert.deepEqual(
    appendGameParameter(
      ["Person Alpha avoids public attention.", "Person Beta guards the archive."],
      "Person Alpha seeks public support.",
    ),
    [
      "Person Alpha avoids public attention.",
      "Person Beta guards the archive.",
      "Person Alpha seeks public support.",
    ],
  );
  assert.deepEqual(
    appendGameParameter(
      ["Person Alpha seeks public support.", "Person Beta guards the archive."],
      "Person Alpha seeks public support.",
    ),
    ["Person Beta guards the archive.", "Person Alpha seeks public support."],
  );
  assert.deepEqual(
    appendGameParameter(
      Array.from({ length: 20 }, (_, index) => `Parameter ${index + 1}`),
      "Parameter 21",
    ),
    Array.from({ length: 20 }, (_, index) => `Parameter ${index + 2}`),
  );
});

test("failed source continuation recommends the anchor-directed current choice", () => {
  const scene = {
    title: "A stalled scene",
    text: "The room remains quiet.",
    choices: [
      { id: "door", type: "action" as const, text: "Check the unexplained knock" },
      { id: "wait", type: "action" as const, text: "Keep waiting" },
    ],
  };

  assert.deepEqual(storyContinuationUnavailableNotice(scene).suggestedChoice, {
    id: "door",
    type: "action",
    text: "Check the unexplained knock",
  });
  assert.match(
    storyContinuationUnavailableNotice(scene).message,
    /option 1 is the strongest available route back/i,
  );
});

test("failed source continuation without choices recommends a concrete free action", () => {
  const notice = storyContinuationUnavailableNotice({
    title: "A stalled scene",
    text: "The room remains quiet.",
    choices: [],
  });

  assert.equal(notice.suggestedChoice, undefined);
  assert.match(notice.message, /Use 101 to take a concrete action/i);
});

test("failed source continuation does not recommend the same continuation fallback again", () => {
  const notice = storyContinuationUnavailableNotice({
    title: "A stalled scene",
    text: "The room remains quiet.",
    choices: [{
      id: SOURCE_CONTINUATION_CHOICE_ID,
      type: "action",
      text: SOURCE_CONTINUATION_CHOICE_TEXT,
    }],
  });

  assert.equal(notice.suggestedChoice, undefined);
  assert.match(notice.message, /Use 101 to take a concrete action/i);
});

test("exhausted source generation uses the unchanged-scene availability path", async () => {
  const result = await attemptSourceContinuation(async () => {
    throw new SceneGenerationError(
      ["The semantic continuity review found that the latest input remained stalled."],
      4,
    );
  });

  assert.equal(result, undefined);
});


test('rejected source continuation reports its actual reason instead of claiming no anchor exists', async () => {
  const rejection = new SceneGenerationError(['Source event entry scopeAndMemory: Rescue history was omitted.'], 1);
  let captured: SceneGenerationError | undefined;
  const result = await attemptSourceContinuation(async () => { throw rejection; }, error => { captured = error; });
  assert.equal(result, undefined);
  assert.equal(captured, rejection);
  const notice = storyContinuationUnavailableNotice({title: 'Farmhouse', text: 'We wait.', choices: []}, captured);
  assert.equal(notice.code, 'STORY_CONTINUATION_UNAVAILABLE');
  assert.match(notice.message, /Rescue history was omitted/);
  assert.match(notice.message, /scene is unchanged/);
  assert.doesNotMatch(notice.message, /lost the story thread|Use 101/);
});
