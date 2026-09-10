import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type {
  ChapterSourceIndex,
  GameState,
  ImportedBook,
} from "../src/shared/contracts.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
  SOURCE_ANCHOR_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_TEXT,
} from "../src/shared/contracts.js";

const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-game-resume-"));
process.env.BOOKRPG_DATA_DIR = testDataDir;
process.env.BOOKRPG_FAKE_AI = "1";

const { getGame, saveGame } = await import("../src/games/repository.js");
const { saveBook } = await import("../src/books/repository.js");
const {
  alignRecoveryCandidateToCursor,
  buildSceneRecoveryCandidates,
  buildSourceAnchorCandidates,
  buildSourceContinuationCandidates,
  buildFutureSourceCandidates,
  buildSourceRecoveryCandidates,
  continueFromSource,
  continueScene,
  initiateEvent,
  listSavedGames,
  makeChoice,
  normalizeSourceProgress,
  refreshCanonicalFirstChoice,
  resumeGame,
  say,
  setParameter,
  sourceIntroducedCharactersAtCursor,
  startGame,
  undoLastChoice,
} = await import("../src/games/service.js");

after(async () => {
  await fs.rm(testDataDir, { recursive: true, force: true });
});

function createGame(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: "game_resume_test",
    book: { bookId: "book_test", title: "Test Book", author: "Test Author" },
    playerName: "Alex",
    gameProfile: {
      category: "adventure",
      endingMode: "completion",
      description: "A test adventure.",
    },
    objective: "Finish the test.",
    victoryCondition: "Reach the end.",
    status: "active",
    selectedText: "A selected passage.",
    scene: {
      title: "A test scene",
      text: "Mary is waiting.",
      choices: [{ id: "talk_mary", type: "talk", text: "Talk to Mary", character: "Mary" }],
    },
    history: [{ kind: "start", text: "A selected passage." }],
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

test("game saves omit indexed book metadata and reload it from the book index", async () => {
  const characterProfiles = [{
    name: "Alex",
    aliases: [],
    role: "Protagonist",
    description: "The player character.",
    traits: ["curious"],
    relationships: [],
    storyArc: "Alex follows the story.",
  }];
  const book: ImportedBook = {
    bookId: "book_indexed_metadata",
    sourceSha256: "indexed-metadata-sha",
    title: "Indexed Metadata",
    chapters: [{
      index: 0,
      title: "Opening",
      text: "Alex enters the story.",
    }],
    worldBible: {
      summary: "The authoritative summary from the book index.",
      characters: ["Alex"],
      characterProfiles,
      locations: [],
    },
    importedAt: "2026-09-04T00:00:00.000Z",
  };
  await saveBook(book);
  const game = createGame({
    gameId: "game_without_indexed_metadata",
    book: { bookId: book.bookId, title: book.title },
    wholeBookSummary: book.worldBible?.summary,
    characterProfiles,
  });

  await saveGame(game);

  const stored = JSON.parse(
    await fs.readFile(path.join(testDataDir, "games", `${game.gameId}.json`), "utf8"),
  ) as Record<string, unknown>;
  assert.equal("wholeBookSummary" in stored, false);
  assert.equal("characterProfiles" in stored, false);

  const reloaded = await getGame(game.gameId);
  assert.equal(reloaded?.wholeBookSummary, book.worldBible?.summary);
  assert.deepEqual(reloaded?.characterProfiles, characterProfiles);
});

test("new games number the opening scene as turn 1", async () => {
  const book: ImportedBook = {
    bookId: "book_turn_numbering",
    sourceSha256: "turn-numbering-sha",
    title: "Turn Numbering",
    chapters: [{
      index: 0,
      title: "Opening",
      text: "Alex steps into the story.",
    }],
    importedAt: "2026-09-03T00:00:00.000Z",
  };
  await saveBook(book);

  const started = await startGame({
    book: { bookId: book.bookId, title: book.title },
    playerName: "Alex",
  });

  assert.equal(started.scene.title, "BookRPG test scene (Turn 1)");
  assert.equal(started.turnHistory.length, 1);
  assert.equal(started.turnHistory[0]?.turnNumber, 1);
  assert.equal(started.turnHistory[0]?.kind, "start");
  assert.equal(started.turnHistory[0]?.action, "Start the story as Alex");
  assert.equal(started.turnHistory[0]?.scene.text, started.scene.text);
  assert.equal((await getGame(started.gameId))?.turnNumber, 1);
});

test("talk choices persist the complete pending conversation", async () => {
  const game = createGame();
  await saveGame(game);

  const result = await makeChoice(game.gameId, { choiceId: "talk_mary" });
  if (!("suggestions" in result)) assert.fail("Expected a talk response");

  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.activeConversation, result);
  assert.equal(persisted?.activeConversationAnchorDirected, undefined);
});

test("resume sanitizes legacy scene scope to the player and living non-player characters", async () => {
  const game = createGame({
    gameId: "game_legacy_scene_scope",
    playerName: "Alex",
    characterProfiles: [
      {
        name: "Alexander",
        aliases: ["Alex"],
        role: "Player",
        description: "The player.",
        traits: [],
        relationships: [],
        storyArc: "",
      },
      {
        name: "Person Beta",
        aliases: ["Beta"],
        role: "Archivist",
        description: "The dead archivist.",
        traits: [],
        relationships: [],
        storyArc: "",
      },
      {
        name: "Mary",
        aliases: [],
        role: "Witness",
        description: "A living witness.",
        traits: [],
        relationships: [],
        storyArc: "",
      },
    ],
    establishedEvent: {
      category: "death",
      actor: "Alex",
      action: "killed",
      target: "Person Beta",
      means: "a falling shelf",
      immediateConsequences: ["Person Beta is dead."],
      sourceBacked: true,
      narrative: "A shelf killed Person Beta.",
    },
    scene: {
      title: "The archive",
      text: "Beta's body lies beside Mary in the archive.",
      sceneScope: {
        currentLocation: "The archive",
        peoplePresent: ["Alexander", "Person Beta", "Mary"],
        peopleWithinSpeakingDistance: ["Alexander", "Person Beta", "Mary"],
      },
      choices: [
        { id: "talk_beta", type: "talk", text: "Talk to Beta", character: "Beta" },
        { id: "wait", type: "action", text: "Wait beside Mary" },
      ],
    },
  });
  await saveBook({
    bookId: game.book.bookId,
    sourceSha256: "legacy-scene-scope-sha",
    title: game.book.title,
    chapters: [{
      index: 0,
      title: "The archive",
      text: game.scene.text,
    }],
    worldBible: {
      summary: "Alex encounters Mary and Person Beta in the archive.",
      characters: ["Alexander", "Person Beta", "Mary"],
      characterProfiles: game.characterProfiles,
      locations: ["The archive"],
    },
    importedAt: "2026-09-04T00:00:00.000Z",
  });
  await saveGame(game);

  const resumed = await resumeGame(game.gameId);

  assert.deepEqual(resumed.scene.sceneScope, {
    currentLocation: "The archive",
    peoplePresent: ["Alexander", "Mary"],
    peopleWithinSpeakingDistance: ["Alexander", "Mary"],
  });
  assert.deepEqual(resumed.scene.choices.map((choice) => choice.id), ["wait"]);
  assert.deepEqual((await getGame(game.gameId))?.scene.sceneScope, resumed.scene.sceneScope);
});

test("resume removes duplicate stored talk choices for the same character", async () => {
  const game = createGame({
    gameId: "game_duplicate_talk_choices",
    scene: {
      title: "The choice to leave",
      text: "Mary steps aside, leaving the stairs open.",
      choices: [
        {
          id: "talk_mary",
          type: "talk",
          text: "Talk to Mary Maloney",
          character: "Mary Maloney",
        },
        {
          id: "talk_mary_again",
          type: "talk",
          text: "Talk to Mary Maloney",
          character: "Mary Maloney",
        },
        { id: "leave", type: "action", text: "Walk toward the stairs" },
      ],
    },
  });
  await saveGame(game);

  const resumed = await resumeGame(game.gameId);

  assert.deepEqual(
    resumed.scene.choices.map((choice) => choice.id),
    ["talk_mary", "leave"],
  );
  assert.deepEqual((await getGame(game.gameId))?.scene.choices, resumed.scene.choices);
});

test("undo restores the scene before a newly selected talk choice", async () => {
  const game = createGame({ gameId: "game_undo_talk" });
  const originalScene = structuredClone(game.scene);
  const originalHistory = structuredClone(game.history);
  await saveGame(game);

  const talk = await makeChoice(game.gameId, { choiceId: "talk_mary" });
  assert.ok("suggestions" in talk);

  const undone = await undoLastChoice(game.gameId);
  assert.deepEqual(undone.scene, originalScene);
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.history, originalHistory);
  assert.equal(persisted?.activeConversation, undefined);
  assert.equal(persisted?.undoSnapshot, undefined);
});

test("undo restores state after an action generated a new scene", async () => {
  const game = createGame({
    gameId: "game_undo_action",
    turnNumber: 4,
    turnHistory: [{
      turnNumber: 4,
      kind: "choice",
      action: "Wait outside",
      scene: {
        title: "Before (Turn 4)",
        text: "Alex waits outside.",
      },
      completedAt: "2026-08-27T09:59:00.000Z",
    }],
    storyMemory: {
      summary: "Before the choice.",
      openThreads: ["A pending question."],
      canonFacts: ["Alex is still outside."],
    },
    scene: {
      title: "Before (Turn 4)",
      text: "Alex waits outside.",
      choices: [{ id: "enter", type: "action", text: "Enter the room" }],
    },
  });
  const before = structuredClone(game);
  await saveGame(game);

  const result = await makeChoice(game.gameId, { choiceId: "enter" });
  assert.ok(!("suggestions" in result));
  assert.notDeepEqual(result.scene, before.scene);
  assert.equal(result.turnHistory.length, 2);
  assert.deepEqual(result.turnHistory.at(-1), {
    turnNumber: 5,
    kind: "choice",
    action: "Enter the room",
    scene: {
      title: result.scene.title,
      text: result.scene.text,
      ...(result.scene.outcome ? { outcome: result.scene.outcome } : {}),
      ...(result.scene.outcomeReason ? { outcomeReason: result.scene.outcomeReason } : {}),
    },
    completedAt: result.turnHistory.at(-1)?.completedAt,
  });

  await undoLastChoice(game.gameId);
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.scene, before.scene);
  assert.deepEqual(persisted?.history, before.history);
  assert.deepEqual(persisted?.storyMemory, before.storyMemory);
  assert.equal(persisted?.turnNumber, before.turnNumber);
  assert.deepEqual(persisted?.turnHistory, before.turnHistory);
  assert.equal(persisted?.status, before.status);
  assert.equal(persisted?.undoSnapshot, undefined);
});

test("undo supports legacy saved talk choices without a snapshot", async () => {
  const game = createGame({
    gameId: "game_undo_legacy_talk",
    history: [
      { kind: "start", text: "A selected passage." },
      { kind: "choice", text: "Talk to Mary" },
    ],
    activeConversation: {
      character: "Mary",
      prompt: "What do you say?",
      suggestions: ["Hello."],
    },
  });
  await saveGame(game);

  await undoLastChoice(game.gameId);
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.history, [{ kind: "start", text: "A selected passage." }]);
  assert.equal(persisted?.activeConversation, undefined);
});

test("scene progression advances without selecting an option and preserves runtime settings", async () => {
  const game = createGame({
    gameId: "game_scene_continuation",
    book: {
      bookId: "book_without_source_for_scene_continuation",
      title: "Scene Continuation",
    },
    activeConversation: {
      character: "Mary",
      prompt: "What do you say?",
      suggestions: ["Wait.", "Listen.", "Leave."],
    },
    parameters: ["Keep the room dimly lit while the exchange continues."],
    scene: {
      title: "A test scene",
      text: "Mary is waiting.",
      choices: [
        { id: "forward", type: "action", text: "Follow the strongest story lead" },
        { id: "wait", type: "action", text: "Wait by the door" },
      ],
    },
  });
  await saveGame(game);

  const first = await continueScene(game.gameId);
  const second = await continueScene(game.gameId);

  assert.ok(!("suggestions" in first));
  assert.ok(!("suggestions" in second));
  assert.match(first.scene.text, /without a new player action/i);
  assert.match(first.scene.title, /\(Turn 2\)$/);
  assert.match(second.scene.title, /\(Turn 3\)$/);
  assert.deepEqual(
    first.turnHistory.map(({ completedAt: _completedAt, ...turn }) => turn),
    [{
      turnNumber: 2,
      kind: "continuation",
      action: "Continue the story",
      scene: {
        title: first.scene.title,
        text: first.scene.text,
        ...(first.scene.outcome ? { outcome: first.scene.outcome } : {}),
        ...(first.scene.outcomeReason ? { outcomeReason: first.scene.outcomeReason } : {}),
      },
    }],
  );
  assert.equal(second.turnHistory.length, 2);
  assert.deepEqual(
    second.turnHistory.map((turn) => turn.turnNumber),
    [2, 3],
  );
  const persisted = await getGame(game.gameId);
  assert.equal(persisted?.activeConversation, undefined);
  assert.equal(persisted?.activeConversationAnchorDirected, undefined);
  assert.deepEqual(
    persisted?.history.slice(-4).map((item) => item.kind),
    ["continuation", "scene", "continuation", "scene"],
  );
  assert.match(persisted?.history.at(-4)?.text ?? "", /without choosing a player action/i);
  assert.match(persisted?.history.at(-2)?.text ?? "", /without choosing a player action/i);
  assert.equal(persisted?.history.at(-3)?.text, first.scene.text);
  assert.equal(persisted?.scene.text, second.scene.text);
  assert.deepEqual(first.scene.sceneScope, {
    currentLocation: "BookRPG test location",
    peoplePresent: ["the nearby stranger"],
    peopleWithinSpeakingDistance: ["the nearby stranger"],
  });
  assert.deepEqual(
    persisted?.history.at(-3)?.sceneScope,
    first.scene.sceneScope,
  );
  assert.deepEqual(
    persisted?.history.at(-1)?.sceneScope,
    second.scene.sceneScope,
  );
  assert.equal(persisted?.turnNumber, 3);
  assert.deepEqual(persisted?.turnHistory, second.turnHistory);
  assert.deepEqual(persisted?.parameters, game.parameters);
});

test("resume corrects a second scene that was stored as turn 1", async () => {
  const game = createGame({
    gameId: "game_zero_based_turn_number",
    turnNumber: 1,
    scene: {
      title: "The Lion’s Step Toward Mercy (Turn 1)",
      text: "The lion takes another step.",
      choices: [{ id: "continue", type: "action", text: "Continue forward" }],
    },
    history: [
      { kind: "start", text: "A selected passage." },
      { kind: "scene", text: "The lion considers mercy." },
      { kind: "choice", text: "Step forward" },
      { kind: "scene", text: "The lion takes another step." },
    ],
  });
  await saveGame(game);

  const resumed = await resumeGame(game.gameId);

  assert.equal(resumed.scene.title, "The Lion’s Step Toward Mercy (Turn 2)");
  const persisted = await getGame(game.gameId);
  assert.equal(persisted?.turnNumber, 2);
  assert.equal(persisted?.scene.title, resumed.scene.title);
});

test("dialogue and world-event turns persist their exact player-facing step", async () => {
  const dialogueGame = createGame({ gameId: "game_dialogue_turn_history" });
  const originalDialogueScene = structuredClone(dialogueGame.scene);
  await saveGame(dialogueGame);

  const talk = await makeChoice(dialogueGame.gameId, { choiceId: "talk_mary" });
  assert.ok("suggestions" in talk);
  const dialogue = await say(dialogueGame.gameId, { text: "  Tell me what happened.  " });

  assert.equal(dialogue.turnHistory.length, 1);
  assert.equal(dialogue.turnHistory[0]?.turnNumber, 2);
  assert.equal(dialogue.turnHistory[0]?.kind, "dialogue");
  assert.equal(dialogue.turnHistory[0]?.action, "Alex to Mary: Tell me what happened.");
  assert.equal(dialogue.turnHistory[0]?.scene.text, dialogue.scene.text);

  await undoLastChoice(dialogueGame.gameId);
  const dialogueAfterUndo = await getGame(dialogueGame.gameId);
  assert.deepEqual(dialogueAfterUndo?.scene, originalDialogueScene);
  assert.deepEqual(dialogueAfterUndo?.turnHistory, []);

  const eventGame = createGame({ gameId: "game_event_turn_history" });
  await saveGame(eventGame);
  const event = await initiateEvent(eventGame.gameId, {
    text: "  A storm cuts the power.  ",
  });

  assert.equal(event.turnHistory.length, 1);
  assert.equal(event.turnHistory[0]?.turnNumber, 2);
  assert.equal(event.turnHistory[0]?.kind, "event");
  assert.equal(event.turnHistory[0]?.action, "A storm cuts the power.");
  assert.equal(event.turnHistory[0]?.scene.text, event.scene.text);

  await undoLastChoice(eventGame.gameId);
  assert.deepEqual((await getGame(eventGame.gameId))?.turnHistory, []);
});

test("scene progression closes an active conversation without selecting its talk option", async () => {
  const game = createGame({ gameId: "game_automatic_talk" });
  await saveGame(game);

  const result = await continueScene(game.gameId);

  assert.ok(!("suggestions" in result));
  const persisted = await getGame(game.gameId);
  assert.equal(persisted?.activeConversation, undefined);
  assert.equal(persisted?.history.at(-2)?.kind, "continuation");
});

test("runtime parameters persist in order without advancing the scene", async () => {
  const game = createGame({ gameId: "game_parameters" });
  await saveGame(game);

  const first = await setParameter(game.gameId, {
    text: "Person Alpha avoids public attention.",
  });
  const second = await setParameter(game.gameId, {
    text: "Person Alpha now prioritizes protecting the archive.",
  });

  assert.deepEqual(first.parameters, ["Person Alpha avoids public attention."]);
  assert.deepEqual(second.parameters, [
    "Person Alpha avoids public attention.",
    "Person Alpha now prioritizes protecting the archive.",
  ]);
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.parameters, second.parameters);
  assert.deepEqual(persisted?.scene, game.scene);
  assert.deepEqual(persisted?.history, game.history);
});

test("resuming upgrades legacy pending conversations", async () => {
  const game = createGame({
    gameId: "game_legacy_conversation",
    activeConversation: { character: "Mary" },
  });
  await saveGame(game);

  const resumed = await resumeGame(game.gameId);

  assert.equal(resumed.activeConversation?.character, "Mary");
  assert.equal(resumed.activeConversation?.suggestions.length, 3);
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.activeConversation, resumed.activeConversation);
});

test("resuming removes embedded choice menus from legacy scene text", async () => {
  const dirtySceneText = [
    "The crew settles and watches the horizon.",
    "",
    "Choices:",
    "1) Repeat the order.",
    "2) Hold the current course.",
  ].join("\n");
  const game = createGame({
    gameId: "game_legacy_choice_menu",
    scene: {
      title: "A steadier deck",
      text: dirtySceneText,
      choices: [
        { id: "repeat", type: "action", text: "Repeat the order" },
        { id: "course", type: "action", text: "Hold the current course" },
      ],
    },
    history: [{ kind: "scene", text: dirtySceneText }],
  });
  await saveGame(game);

  const resumed = await resumeGame(game.gameId);

  assert.equal(resumed.scene.text, "The crew settles and watches the horizon.");
  const persisted = await getGame(game.gameId);
  assert.equal(persisted?.scene.text, resumed.scene.text);
  assert.equal(persisted?.history[0]?.text, resumed.scene.text);
});

test("resuming compacts a legacy transcript into persistent story memory", async () => {
  const game = createGame({
    gameId: "game_legacy_memory",
    turnNumber: 24,
    history: Array.from({ length: 24 }, (_, index) => (
      index % 2 === 0
        ? { kind: "choice" as const, text: `Choose route ${index}` }
        : {
            kind: "scene" as const,
            text: `The scene advances at step ${index}.`,
            development: `Concrete development ${index}.`,
          }
    )),
    turnHistory: Array.from({ length: 24 }, (_, index) => ({
      turnNumber: index + 1,
      kind: "choice" as const,
      action: `Durable choice ${index + 1}`,
      scene: {
        title: `Durable scene (Turn ${index + 1})`,
        text: `Durable scene result ${index + 1}.`,
      },
      completedAt: `2026-08-27T10:${String(index).padStart(2, "0")}:00.000Z`,
    })),
  });
  const gamesDirectory = path.join(testDataDir, "games");
  await fs.mkdir(gamesDirectory, { recursive: true });
  await fs.writeFile(
    path.join(gamesDirectory, `${game.gameId}.json`),
    JSON.stringify(game, null, 2),
    "utf8",
  );

  const resumed = await resumeGame(game.gameId);

  const persisted = await getGame(game.gameId);
  assert.equal(persisted?.history.length, 16);
  assert.equal(persisted?.turnHistory?.length, 24);
  assert.equal(persisted?.turnHistory?.[0]?.turnNumber, 1);
  assert.equal(persisted?.turnHistory?.[0]?.action, "Durable choice 1");
  assert.deepEqual(resumed.turnHistory, persisted?.turnHistory);
  assert.match(persisted?.storyMemory?.summary ?? "", /Choose route 0/);
  assert.match(persisted?.storyMemory?.summary ?? "", /Concrete development 23/);
  assert.deepEqual(persisted?.storyMemory?.openThreads, []);
});

test("a direct legacy choice receives full rolling memory before generation", async () => {
  const game = createGame({
    gameId: "game_direct_legacy_memory",
    scene: {
      title: "A late decision",
      text: "The final corridor waits.",
      choices: [
        { id: "forward", type: "action", text: "Continue down the corridor" },
        { id: "wait", type: "action", text: "Wait beside the door" },
      ],
    },
    history: Array.from({ length: 24 }, (_, index) => (
      index % 2 === 0
        ? { kind: "choice" as const, text: `Earlier choice ${index}` }
        : {
            kind: "scene" as const,
            text: `Earlier scene ${index}.`,
            development: `Earlier development ${index}.`,
          }
    )),
  });
  const gamesDirectory = path.join(testDataDir, "games");
  await fs.mkdir(gamesDirectory, { recursive: true });
  await fs.writeFile(
    path.join(gamesDirectory, `${game.gameId}.json`),
    JSON.stringify(game, null, 2),
    "utf8",
  );

  await makeChoice(game.gameId, { choiceId: "forward" });

  const persisted = await getGame(game.gameId);
  assert.equal(persisted?.history.length, 16);
  assert.match(persisted?.storyMemory?.summary ?? "", /Earlier choice 0/);
  assert.match(persisted?.storyMemory?.summary ?? "", /Earlier development 23/);
});

test("resuming removes talk choices for characters not introduced in the narrative", async () => {
  const game = createGame({
    gameId: "game_unintroduced_talk_choice",
    scene: {
      title: "A Quiet Kitchen",
      text: "Mary waits for Patrick to return.",
      choices: [
        { id: "wait", type: "action", text: "Wait by the table" },
        { id: "note", type: "action", text: "Write Patrick a note" },
        { id: "sam", type: "talk", text: "Talk to Sam", character: "Sam" },
      ],
    },
    characterProfiles: [{
      name: "Sam",
      aliases: [],
      role: "Grocer",
      description: "The neighborhood grocer.",
      traits: [],
      relationships: [],
      storyArc: "Mary visits him later.",
    }],
  });
  await saveGame(game);

  const resumed = await resumeGame(game.gameId);

  assert.deepEqual(resumed.scene.choices.map((choice) => choice.id), ["wait", "note"]);
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.scene.choices.map((choice) => choice.id), ["wait", "note"]);
});

test("resuming removes talk choices for characters explicitly awaiting arrival", async () => {
  const game = createGame({
    gameId: "game_absent_talk_choice",
    scene: {
      title: "A rehearsed evening",
      text: "You listen for Patrick’s return while the kettle boils.",
      choices: [
        { id: "wait", type: "action", text: "Keep waiting by the stove" },
        {
          id: "patrick",
          type: "talk",
          text: "Talk to Patrick Maloney",
          character: "Patrick Maloney",
        },
      ],
    },
    characterProfiles: [{
      name: "Patrick Maloney",
      aliases: ["Patrick"],
      role: "Husband",
      description: "Mary's husband.",
      traits: [],
      relationships: [],
      storyArc: "His announcement changes the evening.",
    }],
    sourceIntroducedCharacters: ["Patrick Maloney"],
  });
  await saveGame(game);

  const resumed = await resumeGame(game.gameId);

  assert.deepEqual(resumed.scene.choices.map((choice) => choice.id), ["wait"]);
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.scene.choices.map((choice) => choice.id), ["wait"]);
});

test("resuming an active scene without choices adds a continue story option", async () => {
  const game = createGame({
    gameId: "game_empty_active_scene",
    scene: {
      title: "A closed decision point",
      text: "The room falls silent.",
      choices: [],
      outcome: "active",
    },
  });
  await saveGame(game);

  const resumed = await resumeGame(game.gameId);

  assert.deepEqual(resumed.scene.choices, [{
    id: SOURCE_CONTINUATION_CHOICE_ID,
    type: "action",
    text: SOURCE_CONTINUATION_CHOICE_TEXT,
    stakes: "significant",
  }]);
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.scene.choices, resumed.scene.choices);
});

test("resume removes choices that treat the player as a separate character", async () => {
  const game = createGame({
    gameId: "game_player_perspective_choice",
    playerName: "Scarecrow",
    characterProfiles: [
      {
        name: "Scarecrow",
        aliases: ["the Scarecrow"],
        role: "Dorothy's traveling companion",
        description: "A living figure made of straw.",
        traits: [],
        relationships: [],
        storyArc: "He seeks brains.",
      },
      {
        name: "Dorothy",
        aliases: [],
        role: "Traveler",
        description: "A girl traveling toward the Emerald City.",
        traits: [],
        relationships: [],
        storyArc: "She seeks a way home.",
      },
    ],
    scene: {
      title: "Open Field, New Partnership",
      text: "I walk beside Dorothy toward the Emerald City.",
      sceneScope: {
        currentLocation: "Beside the cornfield",
        peoplePresent: ["Dorothy"],
        peopleWithinSpeakingDistance: ["Dorothy"],
      },
      choices: [
        {
          id: SOURCE_ANCHOR_CHOICE_ID,
          type: "action",
          text: "Help Dorothy steady the Scarecrow when he stumbles",
          character: "Scarecrow",
        },
        {
          id: "scout",
          type: "action",
          text: "Offer to scout the road ahead",
        },
        {
          id: "ask",
          type: "action",
          text: "Ask Dorothy what she hopes to find",
          character: "Dorothy",
        },
      ],
      outcome: "active",
    },
  });
  await saveGame(game);

  const resumed = await resumeGame(game.gameId);

  assert.deepEqual(
    resumed.scene.choices.map((choice) => choice.id),
    [SOURCE_CONTINUATION_CHOICE_ID, "scout", "ask"],
  );
  assert.equal(
    resumed.scene.choices.some((choice) => /scarecrow/i.test(choice.text)),
    false,
  );
  assert.deepEqual((await getGame(game.gameId))?.scene.choices, resumed.scene.choices);
});

test("saved game summaries are lightweight and sorted newest first", async () => {
  await saveGame(createGame({
    gameId: "game_newer",
    updatedAt: "2099-08-28T10:00:00.000Z",
  }));
  await saveGame(createGame({
    gameId: "game_older",
    status: "completed",
    updatedAt: "2026-08-26T10:00:00.000Z",
  }));

  const summaries = await listSavedGames();

  assert.equal(summaries[0]?.gameId, "game_newer");
  assert.ok(summaries.find((summary) => summary.gameId === "game_older"));
  assert.equal("history" in summaries[0]!, false);
});

test("local source grounding examines at most ten following chapters", () => {
  const chapters = Array.from({ length: 15 }, (_, index) => ({
    index,
    title: `Chapter ${index + 1}`,
    text: index === 2
      ? "Opening. Selected passage. The next source event follows."
      : `Source events for chapter ${index + 1}.`,
    summary: `Summary ${index + 1}.`,
  }));
  const book: ImportedBook = {
    bookId: "book_source_continuation",
    sourceSha256: "source-sha",
    title: "Source Continuation",
    chapters,
    importedAt: "2026-08-28T10:00:00.000Z",
  };
  const passageEnd = "Opening. Selected passage.".length;
  const candidates = buildSourceContinuationCandidates(book, {
    chapterPosition: 2,
    textOffset: passageEnd,
  });

  test("source recovery candidates expose chapter summaries and concrete excerpts", () => {
    const book: ImportedBook = {
      bookId: "book_source_recovery",
      sourceSha256: "source-recovery-sha",
      title: "Source Recovery",
      chapters: [
        {
          index: 0,
          title: "Front matter",
          text: "Publication information.",
          summary: "Not story content; front matter.",
        },
        {
          index: 1,
          title: "Central conflict",
          text: "A difficult announcement changes the evening.",
          summary: "A difficult announcement creates the central conflict.",
        },
      ],
      importedAt: "2026-08-28T10:00:00.000Z",
    };

    assert.deepEqual(buildSourceRecoveryCandidates(book), [{
      chapterPosition: 1,
      chapterTitle: "Central conflict",
      summary: "A difficult announcement creates the central conflict.",
      chapterSummary: "A difficult announcement creates the central conflict.",
      excerpt: "A difficult announcement changes the evening.",
      nextTextOffset: "A difficult announcement changes the evening.".length,
      recovery: true,
    }]);
  });
  assert.equal(candidates.length, 11);
  assert.equal(candidates[0]?.chapterPosition, 2);
  assert.equal(candidates.at(-1)?.chapterPosition, 12);
  assert.match(candidates[0]?.excerpt ?? "", /next source event follows/);
});

test("automatic source anchors include later chapters beyond the local window", () => {
  const book: ImportedBook = {
    bookId: "book_source_anchor",
    sourceSha256: "source-anchor-sha",
    title: "Source Anchor",
    chapters: Array.from({ length: 15 }, (_, index) => ({
      index,
      title: `Chapter ${index + 1}`,
      text: `Source events for chapter ${index + 1}.`,
      summary: `Summary ${index + 1}.`,
    })),
    importedAt: "2026-08-29T10:00:00.000Z",
  };

  const candidates = buildSourceAnchorCandidates(book, {
    chapterPosition: 2,
    textOffset: 8,
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.chapterPosition),
    Array.from({ length: 13 }, (_, index) => index + 2),
  );
  assert.equal(candidates.at(-1)?.chapterPosition, 14);
});

test("automatic source grounding skips analyzed front matter", () => {
  const book: ImportedBook = {
    bookId: "book_front_matter_source",
    sourceSha256: "front-matter-source-sha",
    title: "Front Matter Source",
    chapters: [{
      index: 0,
      title: "Title page",
      text: "Front Matter Source",
      summary: "Not story content; front matter.",
      sourceIndex: {
        schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
        summary: "Not story content; front matter.",
        significantEvents: [],
        characters: [],
        actions: [],
        relationships: [],
      },
    }, {
      index: 1,
      title: "The story",
      text: "The room is quiet. A visitor approaches.",
      summary: "A visitor changes the quiet evening.",
    }],
    importedAt: "2026-08-28T10:00:00.000Z",
  };

  const candidates = buildSourceContinuationCandidates(book, {
    chapterPosition: 0,
    textOffset: book.chapters[0]!.text.length,
  });

  assert.deepEqual(candidates.map((candidate) => candidate.chapterPosition), [1]);
  assert.match(candidates[0]?.excerpt ?? "", /^The room is quiet/);
});

test("future source recovery starts at the next chapter and skips non-story content", () => {
  const book: ImportedBook = {
    bookId: "book_future_recovery",
    sourceSha256: "future-recovery-sha",
    title: "Future Recovery",
    chapters: [{
      index: 0,
      title: "Current scene",
      text: "The current scene keeps repeating.",
      summary: "The current scene.",
    }, {
      index: 1,
      title: "Interlude",
      text: "Publication information.",
      summary: "Not story content; front matter.",
      sourceIndex: {
        schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
        summary: "Not story content; front matter.",
        significantEvents: [],
        characters: [],
        actions: [],
        relationships: [],
      },
    }, {
      index: 2,
      title: "A new event",
      text: "A visitor knocks and changes the situation.",
      summary: "A visitor creates a new conflict.",
    }],
    importedAt: "2026-08-28T10:00:00.000Z",
  };

  assert.deepEqual(
    buildFutureSourceCandidates(book, {
      chapterPosition: 0,
      textOffset: 12,
    }),
    [{
      chapterPosition: 2,
      chapterTitle: "A new event",
      summary: "A visitor creates a new conflict.",
      chapterSummary: "A visitor creates a new conflict.",
      excerpt: "A visitor knocks and changes the situation.",
      nextTextOffset: "A visitor knocks and changes the situation.".length,
    }],
  );
});

test("source candidates continue after the cursor's global story event", () => {
  const book: ImportedBook = {
    bookId: "book_global_events",
    sourceSha256: "global-events-sha",
    title: "Global Events",
    chapters: [{
      index: 0,
      title: "The chapter",
      text: "First event.\nSecond event.\nThird event.\nFourth event.",
      summary: "Four events occur.",
    }],
    storyEvents: [
      {
        eventId: "event_first",
        sequence: 1,
        description: "The first event occurs.",
        category: "other",
        chapterPosition: 0,
        actors: [],
        targets: [],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 1,
          lineEnd: 1,
        }],
      },
      {
        eventId: "event_second",
        sequence: 2,
        description: "The second event occurs.",
        category: "other",
        chapterPosition: 0,
        actors: [],
        targets: [],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 2,
          lineEnd: 2,
        }],
      },
      {
        eventId: "event_third",
        sequence: 3,
        description: "The third event occurs.",
        category: "other",
        chapterPosition: 0,
        actors: [],
        targets: [],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 3,
          lineEnd: 3,
        }],
      },
      {
        eventId: "event_fourth",
        sequence: 4,
        description: "The fourth event occurs.",
        category: "other",
        chapterPosition: 0,
        actors: [],
        targets: [],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 4,
          lineEnd: 4,
        }],
      },
    ],
    importedAt: "2026-08-29T00:00:00.000Z",
  };

  const candidates = buildSourceContinuationCandidates(book, {
    chapterPosition: 0,
    textOffset: 0,
    eventId: "event_first",
  });

  assert.deepEqual(candidates[0]?.storyEvents, [
    {
      eventId: "event_second",
      sequence: 2,
      description: "The second event occurs.",
      category: "other",
      chapterPosition: 0,
      actors: [],
      targets: [],
    },
    {
      eventId: "event_third",
      sequence: 3,
      description: "The third event occurs.",
      category: "other",
      chapterPosition: 0,
      actors: [],
      targets: [],
    },
  ]);
  assert.equal(
    candidates[0]?.summary,
    "The second event occurs. The third event occurs.",
  );
});

test("unanchored source recovery bounds the event timeline used for scene alignment", () => {
  const book: ImportedBook = {
    bookId: "unanchored-events-book",
    sourceSha256: "unanchored-events-sha",
    title: "Unanchored Events",
    chapters: [{
      index: 0,
      title: "The chapter",
      text: "First event.\nSecond event.\nThird event.",
    }],
    storyEvents: [1, 2, 3].map((sequence) => ({
      eventId: `event_${sequence}`,
      sequence,
      description: `Event ${sequence} occurs.`,
      category: "other" as const,
      chapterPosition: 0,
      actors: [],
      targets: [],
      sourceReferences: [{
        chapterPosition: 0,
        chapterIndex: 0,
        lineStart: sequence,
        lineEnd: sequence,
      }],
    })),
    importedAt: "2026-08-29T00:00:00.000Z",
  };

  assert.deepEqual(
    buildSourceContinuationCandidates(book, {
      chapterPosition: 0,
      textOffset: 0,
    })[0]?.storyEvents?.map((event) => event.sequence),
    [1, 2],
  );
});

test("source progress stops at the selected event instead of the end of its source block", () => {
  const book: ImportedBook = {
    bookId: "event-progress-book",
    sourceSha256: "event-progress-sha",
    title: "Event Progress",
    chapters: [{
      index: 0,
      title: "The chapter",
      text: "The first event.\nThe second event.\nThe third event follows.",
    }],
    storyEvents: [{
      eventId: "event_second",
      sequence: 2,
      description: "The second event occurs.",
      category: "other",
      chapterPosition: 0,
      actors: [],
      targets: [],
      sourceReferences: [{
        chapterPosition: 0,
        chapterIndex: 0,
        lineStart: 2,
        lineEnd: 2,
      }],
    }],
    importedAt: "2026-08-29T00:00:00.000Z",
  };

  assert.deepEqual(
    normalizeSourceProgress(book, {
      chapterPosition: 1,
      textOffset: 0,
      eventId: "event_second",
    }),
    {
      chapterPosition: 0,
      textOffset: "The first event. The second event.".length,
      eventId: "event_second",
    },
  );
});

test("source progress remaps stale event IDs without moving the saved cursor backward", () => {
  const chapterText = "The first event.\nThe second event.\nLater interactive text.";
  const eventBoundaryTextOffset = "The first event. The second event.".length;
  const divergedTextOffset = "The first event. The second event. Later".length;
  const book: ImportedBook = {
    bookId: "reindexed-event-progress-book",
    sourceSha256: "reindexed-event-progress-sha",
    title: "Reindexed Event Progress",
    chapters: [{
      index: 0,
      title: "The chapter",
      text: chapterText,
    }],
    storyEvents: [
      {
        eventId: "new_first_event",
        sequence: 1,
        description: "The first event occurs.",
        category: "other",
        chapterPosition: 0,
        actors: [],
        targets: [],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 1,
          lineEnd: 1,
        }],
      },
      {
        eventId: "new_second_event",
        sequence: 2,
        description: "The second event occurs.",
        category: "other",
        chapterPosition: 0,
        actors: [],
        targets: [],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 2,
          lineEnd: 2,
        }],
      },
    ],
    importedAt: "2026-09-03T00:00:00.000Z",
  };

  assert.deepEqual(
    normalizeSourceProgress(book, {
      chapterPosition: 0,
      textOffset: eventBoundaryTextOffset,
      eventId: "old_second_event",
    }),
    {
      chapterPosition: 0,
      textOffset: eventBoundaryTextOffset,
      eventId: "new_second_event",
    },
  );
  const divergedProgress = normalizeSourceProgress(book, {
    chapterPosition: 0,
    textOffset: divergedTextOffset,
    eventId: "old_second_event",
  });
  assert.deepEqual(divergedProgress, {
    chapterPosition: 0,
    textOffset: divergedTextOffset,
  });
  assert.deepEqual(
    normalizeSourceProgress(book, divergedProgress),
    divergedProgress,
  );
  const laterChapterProgress = normalizeSourceProgress(
    {
      ...book,
      chapters: [
        ...book.chapters,
        {
          index: 1,
          title: "A later chapter",
          text: "The interactive timeline has moved ahead.",
        },
      ],
    },
    {
      chapterPosition: 1,
      textOffset: 12,
      eventId: "old_second_event",
    },
  );
  assert.deepEqual(laterChapterProgress, {
    chapterPosition: 1,
    textOffset: 12,
  });
  assert.deepEqual(
    normalizeSourceProgress(
      {
        ...book,
        storyEvents: [{
          ...book.storyEvents![1]!,
          sourceReferences: [{
            chapterPosition: 0,
            chapterIndex: 0,
            lineStart: 2,
            lineEnd: 2,
          }],
        }],
      },
      {
        chapterPosition: 0,
        textOffset: 0,
        eventId: "old_event_before_any_new_event",
      },
    ),
    {
      chapterPosition: 0,
      textOffset: 0,
    },
  );
});

test("a canonical player action remains option one and dead characters cannot be addressed", () => {
  const book: ImportedBook = {
    bookId: "canonical-choice-book",
    sourceSha256: "canonical-choice-sha",
    title: "Canonical Choice",
    chapters: [{
      index: 0,
      title: "The chapter",
      text: "Mary kills Patrick.\nMary prepares an alibi.",
      sourceIndex: {
        schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
        summary: "Mary kills Patrick and prepares an alibi.",
        significantEvents: [],
        characters: [],
        actions: [],
        relationships: [],
      },
    }],
    storyEvents: [
      {
        eventId: "patrick-dies",
        sequence: 1,
        description: "Mary kills Patrick.",
        category: "death",
        chapterPosition: 0,
        actors: ["Mary"],
        targets: ["Patrick"],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 1,
          lineEnd: 1,
        }],
      },
      {
        eventId: "mary-alibi",
        sequence: 2,
        description: "Mary prepares an alibi.",
        category: "other",
        chapterPosition: 0,
        actors: ["Mary"],
        targets: [],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 2,
          lineEnd: 2,
        }],
      },
    ],
    importedAt: "2026-08-29T00:00:00.000Z",
  };

  const refreshed = refreshCanonicalFirstChoice({
    title: "After the blow",
    text: "Patrick lies dead while Mary steadies herself.",
    choices: [
      {
        id: "prepare_alibi",
        type: "action",
        text: "Prepare an alibi before calling the police",
        stakes: "critical",
      },
      { id: "cook", type: "action", text: "Put the lamb in the oven" },
      { id: "talk", type: "talk", text: "Talk to Patrick", character: "Patrick" },
    ],
  }, book, {
    chapterPosition: 0,
    textOffset: "Mary kills Patrick.".length,
    eventId: "patrick-dies",
  });

  assert.deepEqual(refreshed.choices, [
    {
      id: "prepare_alibi",
      type: "action",
      text: "Prepare an alibi before calling the police",
      stakes: "critical",
    },
    { id: "cook", type: "action", text: "Put the lamb in the oven" },
  ]);

  const sparseRefreshed = refreshCanonicalFirstChoice({
    title: "After the blow",
    text: "Patrick lies dead while Mary steadies herself.",
    choices: [
      { id: "cook", type: "action", text: "Put the lamb in the oven" },
      { id: "talk", type: "talk", text: "Talk to Patrick", character: "Patrick" },
    ],
  }, book, {
    chapterPosition: 0,
    textOffset: "Mary kills Patrick.".length,
    eventId: "patrick-dies",
  });
  assert.deepEqual(sparseRefreshed.choices, [
    { id: "cook", type: "action", text: "Put the lamb in the oven" },
    {
      id: SOURCE_CONTINUATION_CHOICE_ID,
      type: "action",
      text: SOURCE_CONTINUATION_CHOICE_TEXT,
      stakes: "significant",
    },
  ]);
});

test("canonical death filtering removes only the explicitly deceased participant", () => {
  const book: ImportedBook = {
    bookId: "multi-target-death-book",
    sourceSha256: "multi-target-death-sha",
    title: "Multi-target Death",
    chapters: [{
      index: 0,
      title: "Arrival",
      text: "Dorothy learns that the house killed the Wicked Witch.",
    }],
    worldBible: {
      summary: "Dorothy arrives in a strange land.",
      characters: ["Dorothy", "Wicked Witch of the East"],
      characterProfiles: [{
        name: "Dorothy",
        aliases: [],
        role: "Traveler",
        description: "A traveler.",
        traits: [],
        relationships: [],
        storyArc: "",
      }, {
        name: "Wicked Witch of the East",
        aliases: ["Wicked Witch"],
        role: "Witch",
        description: "The witch crushed by the house.",
        traits: [],
        relationships: [],
        storyArc: "",
      }],
      locations: [],
    },
    storyEvents: [{
      eventId: "witch-dies",
      sequence: 1,
      description:
        "Dorothy learns that the house has killed the Wicked Witch of the East.",
      category: "death",
      chapterPosition: 0,
      actors: ["Dorothy"],
      targets: ["Dorothy", "Wicked Witch of the East"],
      sourceReferences: [{
        chapterPosition: 0,
        chapterIndex: 0,
        lineStart: 1,
        lineEnd: 1,
      }],
    }],
    importedAt: "2026-09-04T00:00:00.000Z",
  };

  const refreshed = refreshCanonicalFirstChoice({
    title: "After the landing",
    text: "Dorothy stands beside the remains of the Wicked Witch.",
    choices: [
      {
        id: "talk-dorothy",
        type: "talk",
        text: "Talk to Dorothy",
        character: "Dorothy",
      },
      {
        id: "talk-witch",
        type: "talk",
        text: "Talk to the Wicked Witch",
        character: "Wicked Witch of the East",
      },
      { id: "look", type: "action", text: "Look toward the road" },
    ],
  }, book, {
    chapterPosition: 0,
    textOffset: book.chapters[0]!.text.length,
    eventId: "witch-dies",
  });

  assert.deepEqual(
    refreshed.choices.map((choice) => choice.id),
    ["talk-dorothy", "look"],
  );
});

test("source candidates skip indexed front matter after the story", () => {
  const emptyIndex: Omit<ChapterSourceIndex, "summary"> = {
    schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
    significantEvents: [],
    characters: [],
    actions: [],
    relationships: [],
  };
  const book: ImportedBook = {
    bookId: "front-matter-book",
    sourceSha256: "front-matter-sha",
    title: "Front Matter",
    chapters: [
      {
        index: 0,
        title: "Story",
        text: "The story continues.",
        sourceIndex: { ...emptyIndex, summary: "A story event occurs." },
      },
      {
        index: 1,
        title: "Credits",
        text: "Copyright and publication data.",
        sourceIndex: {
          ...emptyIndex,
          summary: "This section contains front matter and publication details.",
        },
      },
    ],
    importedAt: "2026-08-29T00:00:00.000Z",
  };

  assert.deepEqual(
    buildSourceContinuationCandidates(book, {
      chapterPosition: 1,
      textOffset: 0,
    }),
    [],
  );
});

test("chapter recovery includes a five-story-chapter sliding context window", () => {
  const book: ImportedBook = {
    bookId: "book_recovery_context",
    sourceSha256: "recovery-context-sha",
    title: "Recovery Context",
    chapters: Array.from({ length: 7 }, (_, index) => ({
      index,
      title: `Chapter ${index + 1}`,
      text: `Text ${index + 1}.`,
      summary: `Summary ${index + 1}.`,
    })),
    importedAt: "2026-08-28T10:00:00.000Z",
  };

  const candidates = buildSourceRecoveryCandidates(book);

  assert.match(candidates[0]?.surroundingContext ?? "", /Chapter 2/);
  assert.match(candidates[0]?.surroundingContext ?? "", /Chapter 5/);
  assert.doesNotMatch(candidates[0]?.surroundingContext ?? "", /Chapter 6/);
  assert.match(candidates[3]?.surroundingContext ?? "", /Chapter 2/);
  assert.match(candidates[3]?.surroundingContext ?? "", /Chapter 6/);
  assert.doesNotMatch(candidates[3]?.surroundingContext ?? "", /Chapter 1/);
  assert.doesNotMatch(candidates[3]?.surroundingContext ?? "", /Chapter 7/);
});

test("selected recovery chapter starts at the saved source cursor", () => {
  const book: ImportedBook = {
    bookId: "book_cursor_recovery",
    sourceSha256: "cursor-recovery-sha",
    title: "Cursor Recovery",
    chapters: [{
      index: 0,
      title: "The story",
      text: "Already shown. The next event happens here.",
      summary: "An opening is followed by the next event.",
    }],
    importedAt: "2026-08-28T10:00:00.000Z",
  };
  const candidate = buildSourceRecoveryCandidates(book)[0]!;

  const aligned = alignRecoveryCandidateToCursor(book, candidate, {
    chapterPosition: 0,
    textOffset: "Already shown. ".length,
  });

  assert.equal(aligned.excerpt, "The next event happens here.");
  assert.equal(aligned.nextTextOffset, book.chapters[0]!.text.length);
});

test("scene recovery can re-anchor inside the rejected final story chapter", () => {
  const book: ImportedBook = {
    bookId: "book_same_chapter_recovery",
    sourceSha256: "same-chapter-recovery-sha",
    title: "Same Chapter Recovery",
    chapters: [{
      index: 0,
      title: "Title page",
      text: "Same Chapter Recovery",
      summary: "Not story content; front matter.",
    }, {
      index: 1,
      title: "The whole story",
      text: "The waiting ends when a key turns. A difficult announcement follows.",
      summary: "An arrival ends the wait and begins the central conflict.",
    }],
    importedAt: "2026-08-29T10:00:00.000Z",
  };

  const candidates = buildSceneRecoveryCandidates(
    book,
    { chapterPosition: 0, textOffset: book.chapters[0]!.text.length },
    1,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.chapterPosition, 1);
  assert.equal(candidates[0]?.recovery, true);
  assert.match(candidates[0]?.excerpt ?? "", /waiting ends when a key turns/i);
});

test("source introductions include earlier characters but exclude later same-chapter characters", () => {
  const book: ImportedBook = {
    bookId: "book_character_timing",
    sourceSha256: "character-timing-sha",
    title: "Character Timing",
    chapters: [{
      index: 0,
      title: "Opening",
      text: [
        "Mary enters the kitchen.",
        "Patrick arrives.",
        "The evening changes.",
        "Sam appears much later.",
      ].join("\n"),
    }],
    worldBible: {
      summary: "A timed introduction test.",
      characters: ["Mary", "Patrick", "Sam"],
      locations: ["Kitchen"],
      characterProfiles: [
        {
          name: "Patrick",
          aliases: [],
          role: "Husband",
          description: "Mary's husband.",
          traits: [],
          relationships: [],
          sourceReferences: [{
            chapterPosition: 0,
            chapterIndex: 0,
            lineStart: 2,
            lineEnd: 2,
          }],
          storyArc: "He arrives early.",
        },
        {
          name: "Sam",
          aliases: [],
          role: "Grocer",
          description: "The grocer.",
          traits: [],
          relationships: [],
          sourceReferences: [{
            chapterPosition: 0,
            chapterIndex: 0,
            lineStart: 4,
            lineEnd: 4,
          }],
          storyArc: "He appears later.",
        },
      ],
    },
    importedAt: "2026-08-28T10:00:00.000Z",
  };
  const cursorText = "Mary enters the kitchen. Patrick arrives.";

  assert.deepEqual(
    sourceIntroducedCharactersAtCursor(book, {
      chapterPosition: 0,
      textOffset: cursorText.length,
    }),
    ["Patrick"],
  );
});

test("explicit source continuation persists the selected source position", async () => {
  const book: ImportedBook = {
    bookId: "book_explicit_source",
    sourceSha256: "explicit-source-sha",
    title: "Explicit Source",
    chapters: [{
      index: 0,
      title: "Opening",
      text: "Start. The next canonical event happens.",
      summary: "The next event happens.",
    }],
    importedAt: "2026-08-28T10:00:00.000Z",
  };
  await saveBook(book);
  const game = createGame({
    gameId: "game_explicit_source",
    book: { bookId: book.bookId, title: book.title },
    selectedText: "Start.",
    sourceCursor: { chapterPosition: 0, textOffset: "Start.".length },
  });
  await saveGame(game);

  const result = await continueFromSource(game.gameId);

  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.sourceCursor, { chapterPosition: 1, textOffset: 0 });
  assert.equal(persisted?.history.at(-2)?.kind, "story");
  assert.equal(result.turnHistory.length, 1);
  assert.equal(result.turnHistory[0]?.turnNumber, 2);
  assert.equal(result.turnHistory[0]?.kind, "continuation");
  assert.equal(result.turnHistory[0]?.action, SOURCE_CONTINUATION_CHOICE_TEXT);
  assert.equal(result.turnHistory[0]?.scene.text, result.scene.text);
  assert.deepEqual(result.sourceAdvance, {
    sourceChapter: {
      chapterPosition: 0,
      chapterTitle: "Opening",
    },
    anchor: "BookRPG test scene",
    cursorBefore: {
      chapterPosition: 0,
      textOffset: "Start.".length,
    },
    cursorAfter: {
      chapterPosition: 1,
      textOffset: 0,
    },
  });

  await undoLastChoice(game.gameId);
  const undone = await getGame(game.gameId);
  assert.deepEqual(undone?.sourceCursor, {
    chapterPosition: 0,
    textOffset: "Start.".length,
  });
  assert.deepEqual(undone?.turnHistory, []);
});

test("the continue story fallback can be submitted through the choices endpoint", async () => {
  const book: ImportedBook = {
    bookId: "book_choice_source_continuation",
    sourceSha256: "choice-source-sha",
    title: "Choice Source Continuation",
    chapters: [{
      index: 0,
      title: "Opening",
      text: "Start. The next canonical event happens.",
      summary: "The next event happens.",
    }],
    importedAt: "2026-08-29T00:00:00.000Z",
  };
  await saveBook(book);
  const game = createGame({
    gameId: "game_choice_source_continuation",
    book: { bookId: book.bookId, title: book.title },
    selectedText: "Start.",
    sourceCursor: { chapterPosition: 0, textOffset: "Start.".length },
    scene: {
      title: "No local options",
      text: "The current moment has no usable local action.",
      choices: [{
        id: SOURCE_CONTINUATION_CHOICE_ID,
        type: "action",
        text: SOURCE_CONTINUATION_CHOICE_TEXT,
      }],
      outcome: "active",
    },
  });
  await saveGame(game);

  const result = await makeChoice(game.gameId, {
    choiceId: SOURCE_CONTINUATION_CHOICE_ID,
  });

  assert.ok(!("suggestions" in result));
  assert.equal(result.sourceAdvance?.sourceChapter.chapterPosition, 0);
  const persisted = await getGame(game.gameId);
  assert.equal(persisted?.history.at(-2)?.kind, "story");
  assert.equal(
    persisted?.history.some((item) =>
      item.kind === "choice" && item.text === SOURCE_CONTINUATION_CHOICE_TEXT
    ),
    false,
  );
});

test("a legacy continuation fallback refreshes a player-authored killing as an explicit choice", async () => {
  const book: ImportedBook = {
    bookId: "book_explicit_player_event",
    sourceSha256: "explicit-player-event-sha",
    title: "Explicit Player Event",
    chapters: [{
      index: 0,
      title: "Living room",
      text: [
        "Mary takes the frozen leg of lamb from the freezer.",
        "Mary kills Patrick with the frozen leg of lamb.",
      ].join("\n"),
      summary: "Mary takes the lamb and kills Patrick.",
    }],
    storyEvents: [
      {
        eventId: "event_lamb",
        sequence: 5,
        description: "Mary takes the frozen leg of lamb from the freezer.",
        category: "other",
        chapterPosition: 0,
        actors: ["Mary Maloney"],
        targets: [],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 1,
          lineEnd: 1,
        }],
      },
      {
        eventId: "event_killing",
        sequence: 6,
        description: "Mary kills Patrick with the frozen leg of lamb.",
        category: "death",
        chapterPosition: 0,
        actors: ["Mary Maloney"],
        targets: ["Patrick Maloney"],
        sourceReferences: [{
          chapterPosition: 0,
          chapterIndex: 0,
          lineStart: 2,
          lineEnd: 2,
        }],
      },
    ],
    importedAt: "2026-08-31T00:00:00.000Z",
  };
  await saveBook(book);
  const game = createGame({
    gameId: "game_explicit_player_event",
    book: { bookId: book.bookId, title: book.title },
    playerName: "Mary Maloney",
    selectedText: "Mary takes the frozen leg of lamb from the freezer.",
    sourceCursor: {
      chapterPosition: 0,
      textOffset: "Mary takes the frozen leg of lamb from the freezer.".length,
      eventId: "event_lamb",
    },
    scene: {
      title: "The frozen lamb",
      text: "You hold the frozen leg of lamb. Patrick stands with his back to you.",
      choices: [{
        id: SOURCE_CONTINUATION_CHOICE_ID,
        type: "action",
        text: SOURCE_CONTINUATION_CHOICE_TEXT,
        stakes: "significant",
      }],
      outcome: "active",
    },
  });
  await saveGame(game);

  const result = await makeChoice(game.gameId, {
    choiceId: SOURCE_CONTINUATION_CHOICE_ID,
  });
  if ("suggestions" in result) assert.fail("Expected a refreshed game scene");

  assert.equal(result.notice?.code, "EXPLICIT_PLAYER_CHOICE_REQUIRED");
  assert.equal(result.sourceAdvance, undefined);
  assert.equal(
    result.notice?.suggestedChoice?.text,
    "Mary kills Patrick with the frozen leg of lamb.",
  );
  assert.notEqual(
    result.scene.choices[0]?.id,
    SOURCE_CONTINUATION_CHOICE_ID,
  );
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.sourceCursor, game.sourceCursor);
  assert.equal(persisted?.scene.text, game.scene.text);
  assert.equal(
    persisted?.history.some((item) => item.kind === "story"),
    false,
  );
});

test("unavailable source continuation returns a notice and preserves the current scene", async () => {
  const book: ImportedBook = {
    bookId: "book_unavailable_source",
    sourceSha256: "unavailable-source-sha",
    title: "Unavailable Source",
    chapters: [{
      index: 0,
      title: "Only chapter",
      text: "The end.",
      summary: "The story has ended.",
    }],
    importedAt: "2026-08-28T10:00:00.000Z",
  };
  await saveBook(book);
  const game = createGame({
    gameId: "game_unavailable_source",
    book: { bookId: book.bookId, title: book.title },
    selectedText: "The end.",
    sourceCursor: { chapterPosition: 0, textOffset: "The end.".length },
  });

  await saveGame(game);

  const result = await continueFromSource(game.gameId);

  assert.equal(result.notice?.code, "STORY_CONTINUATION_UNAVAILABLE");
  assert.deepEqual(result.turnHistory, []);
  assert.equal(result.sourceAdvance, undefined);
  assert.match(result.notice?.message ?? "", /lost the story thread/i);
  assert.match(result.notice?.message ?? "", /direct anchor/i);
  assert.deepEqual(result.notice?.suggestedChoice, game.scene.choices[0]);
  assert.deepEqual(result.scene, game.scene);
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted, game);
});

test("explicit source continuation recovers from an exhausted cursor using chapter summaries", async () => {
  const book: ImportedBook = {
    bookId: "book_recovered_source",
    sourceSha256: "recovered-source-sha",
    title: "Recovered Source",
    chapters: [
      {
        index: 0,
        title: "Front matter",
        text: "Recovered Source",
        summary: "Not story content; front matter.",
      },
      {
        index: 1,
        title: "The conflict",
        text: "A difficult announcement changes the evening.",
        summary: "A difficult announcement creates the central conflict.",
      },
    ],
    importedAt: "2026-08-28T10:00:00.000Z",
  };
  await saveBook(book);
  const game = createGame({
    gameId: "game_recovered_source",
    book: { bookId: book.bookId, title: book.title },
    sourceCursor: { chapterPosition: book.chapters.length, textOffset: 0 },
  });
  await saveGame(game);

  const result = await continueFromSource(game.gameId);

  assert.equal(result.notice, undefined);
  assert.deepEqual(result.sourceAdvance, {
    sourceChapter: {
      chapterPosition: 1,
      chapterTitle: "The conflict",
    },
    anchor: "BookRPG test scene",
    cursorBefore: {
      chapterPosition: book.chapters.length,
      textOffset: 0,
    },
    cursorAfter: {
      chapterPosition: 2,
      textOffset: 0,
    },
  });
  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.sourceCursor, { chapterPosition: 2, textOffset: 0 });
  assert.match(persisted?.scene.text ?? "", /The conflict/);
  assert.equal(persisted?.history.at(-2)?.kind, "story");
});

test("ordinary turns advance the source cursor when canonical material is adapted", async () => {
  const book: ImportedBook = {
    bookId: "book_automatic_source",
    sourceSha256: "automatic-source-sha",
    title: "Automatic Source",
    chapters: [{
      index: 0,
      title: "Opening",
      text: "Start. A canonical visitor arrives at the house.",
      summary: "A visitor arrives.",
    }],
    importedAt: "2026-08-28T10:00:00.000Z",
  };
  await saveBook(book);
  const game = createGame({
    gameId: "game_automatic_source",
    book: { bookId: book.bookId, title: book.title },
    selectedText: "Start.",
    sourceCursor: { chapterPosition: 0, textOffset: "Start.".length },
    scene: {
      title: "At the house",
      text: "The house is quiet.",
      choices: [{ id: "wait", type: "action", text: "Wait by the door" }],
    },
  });
  await saveGame(game);

  await makeChoice(game.gameId, { choiceId: "wait" });

  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.sourceCursor, { chapterPosition: 1, textOffset: 0 });
  assert.equal(persisted?.position?.chapterTitle, "Opening");
  assert.equal("sourceProgress" in (persisted?.scene ?? {}), false);
});

test("ordinary turns preselect a viable later chapter before scene generation", async () => {
  const book: ImportedBook = {
    bookId: "book_proactive_later_anchor",
    sourceSha256: "proactive-later-anchor-sha",
    title: "Proactive Later Anchor",
    chapters: [{
      index: 0,
      title: "Stalled opening",
      text: "The current scene. The same waiting setup continues.",
      summary: "The story has ended.",
    }, {
      index: 1,
      title: "Concrete arrival",
      text: "A visitor arrives and changes the situation.",
      summary: "A visitor creates a concrete new conflict.",
    }],
    importedAt: "2026-08-29T10:00:00.000Z",
  };
  await saveBook(book);
  const game = createGame({
    gameId: "game_proactive_later_anchor",
    book: { bookId: book.bookId, title: book.title },
    selectedText: "The current scene.",
    sourceCursor: {
      chapterPosition: 0,
      textOffset: "The current scene.".length,
    },
    scene: {
      title: "Waiting again",
      text: "The same waiting setup remains unchanged.",
      choices: [{ id: "wait", type: "action", text: "Wait for a concrete change" }],
    },
  });
  await saveGame(game);

  await makeChoice(game.gameId, { choiceId: "wait" });

  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.sourceCursor, { chapterPosition: 2, textOffset: 0 });
  assert.equal(persisted?.position?.chapterIndex, 1);
  assert.equal(persisted?.position?.chapterTitle, "Concrete arrival");
});

test("ordinary choices recover through a chapter summary when the cursor is exhausted", async () => {
  const book: ImportedBook = {
    bookId: "book_automatic_recovery",
    sourceSha256: "automatic-recovery-sha",
    title: "Automatic Recovery",
    chapters: [{
      index: 0,
      title: "Central conflict",
      text: "A difficult announcement changes the evening.",
      summary: "A difficult announcement creates the central conflict.",
    }],
    importedAt: "2026-08-28T10:00:00.000Z",
  };
  await saveBook(book);
  const game = createGame({
    gameId: "game_automatic_recovery",
    book: { bookId: book.bookId, title: book.title },
    sourceCursor: { chapterPosition: book.chapters.length, textOffset: 0 },
    scene: {
      title: "A stalled evening",
      text: "The same quiet routine continues.",
      choices: [{ id: "wait", type: "action", text: "Wait for something to change" }],
    },
  });
  await saveGame(game);

  await makeChoice(game.gameId, { choiceId: "wait" });

  const persisted = await getGame(game.gameId);
  assert.deepEqual(persisted?.sourceCursor, { chapterPosition: 1, textOffset: 0 });
  assert.match(persisted?.scene.text ?? "", /Wait for something to change/);
});
