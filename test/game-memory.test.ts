import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStoryMemory,
  compactGameHistory,
  MAX_STORED_HISTORY_ITEMS,
} from "../src/games/memory.js";
import type { GameState } from "../src/shared/contracts.js";

function gameState(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: "game_memory",
    book: { bookId: "book_memory", title: "Memory Story" },
    playerName: "Person Alpha",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A tense drama.",
    },
    objective: "Protect the archive.",
    victoryCondition: "Keep the archive intact.",
    status: "active",
    selectedText: "Person Alpha enters the archive.",
    scene: {
      title: "The archive",
      text: "The archive door stands open.",
      choices: [
        { id: "seal", type: "action", text: "Seal the archive" },
        { id: "search", type: "action", text: "Search the shelves" },
      ],
      development: "The archive door remains unsecured.",
      outcome: "active",
    },
    history: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

test("legacy history is summarized and bounded without treating choices as open threads", () => {
  const game = gameState({
    history: Array.from({ length: 24 }, (_, index) => (
      index % 2 === 0
        ? {
            kind: "choice" as const,
            text: `Investigate route ${index}`,
          }
        : {
            kind: "scene" as const,
            text: `Scene ${index}`,
            development: `Development ${index}`,
          }
    )),
  });

  assert.equal(compactGameHistory(game), true);
  assert.equal(game.history.length, MAX_STORED_HISTORY_ITEMS);
  assert.match(game.storyMemory?.summary ?? "", /Player chose: Investigate route 0/);
  assert.match(game.storyMemory?.summary ?? "", /Development 23/);
  assert.deepEqual(game.storyMemory?.openThreads, [
    "The archive door remains unsecured.",
  ]);
  assert.equal(compactGameHistory(game), false);
});

test("model memory replaces resolved threads and retains durable canon facts", () => {
  const game = gameState({
    storyMemory: {
      summary: "Person Alpha entered the archive.",
      openThreads: ["The outer door remains open."],
      canonFacts: ["Person Alpha carries the silver key."],
    },
  });
  const nextScene = {
    title: "The sealed door",
    text: "The outer door closes and locks.",
    choices: [
      { id: "stairs", type: "action" as const, text: "Descend the stairs" },
      { id: "desk", type: "action" as const, text: "Inspect the desk" },
    ],
    development: "A bell rings below the archive.",
    outcome: "active" as const,
  };

  applyStoryMemory(game, nextScene, {
    summary: "Person Alpha entered the archive and sealed the outer door.",
    openThreads: ["A bell is ringing below the archive."],
    canonFacts: [
      "Person Alpha carries the silver key.",
      "The outer archive door is locked.",
    ],
  });

  assert.equal(
    game.storyMemory?.summary,
    "Person Alpha entered the archive and sealed the outer door.",
  );
  assert.deepEqual(game.storyMemory?.openThreads, [
    "A bell is ringing below the archive.",
  ]);
  assert.deepEqual(game.storyMemory?.canonFacts, [
    "Person Alpha carries the silver key.",
    "The outer archive door is locked.",
  ]);
});
