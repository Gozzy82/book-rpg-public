import {readFileSync} from 'node:fs';
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

test('replacement memory removes superseded state and an explicit empty list clears facts', () => {
  const game = gameState({storyMemory:{summary:'Before rescue',openThreads:[],canonFacts:['The trapdoor is open.','Dorothy is not holding Toto.']}});
  const scene = {...game.scene,text:'Dorothy rescues Toto and closes the trapdoor.'};
  applyStoryMemory(game,scene,{summary:'After rescue',openThreads:[],canonFacts:['The trapdoor is closed.','Dorothy is holding Toto.']});
  assert.deepEqual(game.storyMemory!.canonFacts,['The trapdoor is closed.','Dorothy is holding Toto.']);
  applyStoryMemory(game,scene);
  assert.deepEqual(game.storyMemory!.canonFacts,['The trapdoor is closed.','Dorothy is holding Toto.']);
  applyStoryMemory(game,scene,{summary:'No retained facts',openThreads:[],canonFacts:[]});
  assert.deepEqual(game.storyMemory!.canonFacts,[]);
});

// Actual before/after memory from Dorothy's rejected continuation, not a model stub.
test('recorded Dorothy replacement removes contradictory open-trapdoor and unheld-Toto facts',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/dorothy-memory-replacement.json',import.meta.url),'utf8'));
 const game=gameState({storyMemory:fixture.prior});
 applyStoryMemory(game,{...game.scene,text:fixture.scene},fixture.replacement);
 assert.deepEqual(game.storyMemory,fixture.replacement);
 assert.ok(!game.storyMemory!.canonFacts.includes('Dorothy is not holding Toto.'));
 assert.ok(game.storyMemory!.canonFacts.includes('The trapdoor is closed.'));
});
