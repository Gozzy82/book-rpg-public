import { withFlowTrace, traceGameState, traceEvent } from "../../util/flow-trace.js";
import crypto from "node:crypto";
import {
  findPassageContext,
  SceneGenerationError,
} from "../../ai/engine.js";
import {
  FREE_ACTION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_TEXT,
} from "../../shared/contracts.js";
import type {
  DialogueRequest,
  GameChoice,
  GameState,
  GameUndoSnapshot,
  InitiateEventRequest,
  MakeChoiceRequest,
  SetParameterRequest,
  SetParameterResponse,
  StartGameRequest,
  StartGameResponse,
  TalkResponse,
} from "../../shared/contracts.js";
import {
  getBook,
  saveBook,
} from "../../books/repository.js";
import {
  getGame,
  saveGame,
} from "../repository.js";
import {
  gameEngine,
} from "./engine-access.js";
import {
  PlayerUnavailableError,
  canonicalOpeningGoals,
  canonicalPlayerStartAvailability,
  canonicalGameStartContext,
} from "./game-start.js";
import {
  explicitPlayerChoiceRequiredNotice,
  storyContinuationUnavailableNotice,
  resolveFreeAction,
  isAnchorDirectedChoice,
  resolveEventText,
  eventGenerationFailureScene,
  resolveParameterText,
  appendGameParameter,
} from "./turn-input.js";
import {
  gameResponse,
  applyGeneratedScene,
  applyReviewedGeneratedScene,
  recordCompletedTurn,
} from "./game-state.js";
import {
  sourceIntroducedCharactersAtCursor,
  normalizeSourceProgress,
  missingPresentSourceEventCharacters,
  sourceContextForGame,
  sourceWorldStateForGame,
  buildCanonicalNextEventCandidate,
  buildSourceContinuationCandidates,
  buildSourceRecoveryCandidates,
  generateWithSourceContext,
  hasCanonicalPlayerTimeline,
  attemptSourceContinuation,
} from "./source-candidates.js";

export async function startGame(request: StartGameRequest): Promise<StartGameResponse> {
  return withFlowTrace("startGame", { request }, () => startGameImpl(request));
}

async function startGameImpl(request: StartGameRequest): Promise<StartGameResponse> {
  const book = await getBook(request.book.bookId);
  if (!book) throw new Error(`Unknown bookId ${request.book.bookId}. Import the EPUB first.`);
  const playerName = request.playerName?.trim() || "Player";
  const canonicalStart = canonicalGameStartContext(book, playerName);

  const now = new Date().toISOString();
  const currentEngine = gameEngine();
  if (!book.gameProfile) {
    book.gameProfile = await currentEngine.classifyBook(book);
    await saveBook(book);
  }
  const game: GameState = {
    gameId: `game_${crypto.randomUUID().replaceAll("-", "")}`,
    book: request.book,
    wholeBookSummary: book.worldBible?.summary,
    characterProfiles: book.worldBible?.characterProfiles,
    position: canonicalStart.position,
    playerName,
    gameProfile: book.gameProfile,
    objective: "",
    victoryCondition: "",
    status: "active",
    selectedText: canonicalStart.selectedText,
    sourceCursor: canonicalStart.sourceCursor,
    turnNumber: 1,
    scene: { title: "Starting…", text: "", choices: [] },
    history: [{ kind: "start", text: book.title }],
    turnHistory: [],
    createdAt: now,
    updatedAt: now,
  };
  traceGameState("state.initial", game);
  game.sourceIntroducedCharacters = sourceIntroducedCharactersAtCursor(
    book,
    game.sourceCursor,
  );

  const canonicalAvailability = canonicalPlayerStartAvailability(book, game.playerName);
  if (canonicalAvailability === false) {
    throw new PlayerUnavailableError(
      game.playerName,
      "Only an individual character with a coherent grounded story moment can be played.",
    );
  }
  if (canonicalAvailability === undefined) {
    const availability = await currentEngine.validatePlayer(game, book);
    if (!availability.playable) {
      throw new PlayerUnavailableError(game.playerName, availability.reason);
    }
  }

  const openingGoals = canonicalOpeningGoals(game.playerName, game.gameProfile);
  game.objective = openingGoals.objective;
  game.victoryCondition = openingGoals.victoryCondition;
  await applyReviewedGeneratedScene(
    game,
    await currentEngine.start(game, [canonicalStart.candidate]),
    book,
    false,
    false,
  );
  game.status = game.scene.outcome ?? "active";
  game.history.push({
    kind: "scene",
    text: game.scene.text,
    development: game.scene.development,
    sceneScope: game.scene.sceneScope,
  });
  recordCompletedTurn(game, "start", `Start the story as ${game.playerName}`);
  await saveGame(game);
  traceGameState("state.saved", game);
  return gameResponse(game);
}

export async function continueFromSource(gameId: string): Promise<StartGameResponse> {
  return withFlowTrace("continueFromSource", { gameId }, () => continueFromSourceImpl(gameId));
}

async function continueFromSourceImpl(gameId: string): Promise<StartGameResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  traceGameState("state.before", game);
  if (game.status !== "active") {
    throw new Error(`Game has already ended with status ${game.status}`);
  }
  const undoSnapshot = createUndoSnapshot(game);
  const book = await getBook(game.book.bookId);
  if (!book) throw new Error(`Unknown bookId ${game.book.bookId}. Import the EPUB first.`);
  const passage = findPassageContext(book, game.selectedText);
  const cursor = normalizeSourceProgress(book, game.sourceCursor ?? {
    chapterPosition: passage.chapterPosition ?? game.position?.chapterIndex ?? 0,
    textOffset: passage.passageEnd ?? 0,
  });
  if (game.sourceCursor) game.sourceCursor = cursor;
  const cursorBefore = { ...cursor };
  const playerHasCanonicalTimeline = hasCanonicalPlayerTimeline(
    book,
    game.playerName,
  );
  const sourceWorldState = sourceWorldStateForGame(game, book, cursor);
  const canonicalCandidate = buildCanonicalNextEventCandidate(
    book,
    cursor,
    game.playerName,
    sourceWorldState,
  );
  const candidates = canonicalCandidate
    ? [canonicalCandidate]
    : playerHasCanonicalTimeline
      ? []
      : buildSourceContinuationCandidates(book, cursor);
  const missingPrerequisiteCharacters = canonicalCandidate
    ? missingPresentSourceEventCharacters(game, book, canonicalCandidate)
    : [];
  if (canonicalCandidate && missingPrerequisiteCharacters.length > 0) {
    game.activeConversation = undefined;
    game.activeConversationAnchorDirected = undefined;
    const generatedScene = await attemptSourceContinuation(
      async () => await gameEngine().continueScene(game, [canonicalCandidate]),
    );
    if (!generatedScene) {
      return gameResponse(game, storyContinuationUnavailableNotice(game.scene));
    }
    game.undoSnapshot = undoSnapshot;
    await applyReviewedGeneratedScene(
      game,
      generatedScene,
      book,
    );
    game.status = game.scene.outcome ?? "active";
    game.history.push({
      kind: "story",
      text:
        `Continue toward source event after establishing prerequisite participant(s): `
        + missingPrerequisiteCharacters.join(", "),
    });
    game.history.push({
      kind: "scene",
      text: game.scene.text,
      development: game.scene.development,
      sceneScope: game.scene.sceneScope,
    });
    recordCompletedTurn(game, "continuation", SOURCE_CONTINUATION_CHOICE_TEXT);
    await saveGame(game);
    traceGameState("state.saved", game);
    return gameResponse(game);
  }

  let result = await attemptSourceContinuation(
    async () => await gameEngine().continueFromSource(game, candidates),
  );
  if (!result && !playerHasCanonicalTimeline) {
    result = await attemptSourceContinuation(
      async () => await gameEngine().continueFromSource(
        game,
        buildSourceRecoveryCandidates(book),
      ),
    );
  }
  if (!result) {
    return gameResponse(game, storyContinuationUnavailableNotice(game.scene));
  }
  if (result.requiresExplicitPlayerChoice) {
    const choices = result.scene.choices.filter(
      (choice) => choice.id !== SOURCE_CONTINUATION_CHOICE_ID,
    );
    const suggestedChoice = choices[0];
    if (!suggestedChoice) {
      return gameResponse(game, storyContinuationUnavailableNotice(game.scene));
    }
    game.scene = {
      ...game.scene,
      choices,
    };
    game.updatedAt = new Date().toISOString();
    await saveGame(game);
    traceGameState("state.saved", game);
    return gameResponse(
      game,
      explicitPlayerChoiceRequiredNotice(suggestedChoice),
    );
  }

  const chapter = book.chapters[result.chapterPosition];
  if (!chapter) throw new Error("The selected source chapter no longer exists");
  game.undoSnapshot = undoSnapshot;
  game.activeConversation = undefined;
  game.activeConversationAnchorDirected = undefined;
  await applyReviewedGeneratedScene(game, {
    ...result.scene,
    sourceProgress: {
      chapterPosition: result.chapterPosition,
      textOffset: result.nextTextOffset,
      ...(result.eventId ? { eventId: result.eventId } : {}),
    },
  }, book);
  game.status = game.scene.outcome ?? "active";
  game.history.push({
    kind: "story",
    text: `Continue from source chapter ${result.chapterPosition + 1}: ${chapter.title}`,
  });
  game.history.push({
    kind: "scene",
    text: game.scene.text,
    development: game.scene.development,
    sceneScope: game.scene.sceneScope,
  });
  if (!game.sourceCursor) {
    throw new Error("Source continuation completed without advancing the source cursor");
  }
  recordCompletedTurn(game, "continuation", SOURCE_CONTINUATION_CHOICE_TEXT);
  await saveGame(game);
  traceGameState("state.saved", game);
  return {
    ...gameResponse(game),
    sourceAdvance: {
      sourceChapter: {
        chapterPosition: result.chapterPosition,
        chapterTitle: chapter.title,
      },
      anchor: result.scene.development?.trim() || result.scene.title,
      cursorBefore,
      cursorAfter: { ...game.sourceCursor },
    },
  };
}

export function createUndoSnapshot(game: GameState): GameUndoSnapshot {
  return structuredClone({
    scene: game.scene,
    history: game.history,
    status: game.status,
    selectedText: game.selectedText,
    ...(game.position ? { position: game.position } : {}),
    ...(game.sourceCursor ? { sourceCursor: game.sourceCursor } : {}),
    ...(game.sourceEventProgress
      ? { sourceEventProgress: game.sourceEventProgress }
      : {}),
    ...(game.sourceIntroducedCharacters
      ? { sourceIntroducedCharacters: game.sourceIntroducedCharacters }
      : {}),
    ...(game.storyMemory ? { storyMemory: game.storyMemory } : {}),
    ...(game.establishedEvent ? { establishedEvent: game.establishedEvent } : {}),
    ...(game.turnNumber !== undefined ? { turnNumber: game.turnNumber } : {}),
    turnHistoryLength: game.turnHistory?.length ?? 0,
    ...(game.activeConversation ? { activeConversation: game.activeConversation } : {}),
    ...(game.activeConversationAnchorDirected !== undefined
      ? { activeConversationAnchorDirected: game.activeConversationAnchorDirected }
      : {}),
  });
}

export function restoreOptional<K extends keyof GameState>(
  game: GameState,
  key: K,
  value: GameState[K] | undefined,
): void {
  if (value === undefined) {
    delete game[key];
    return;
  }
  game[key] = structuredClone(value);
}

export async function undoLastChoice(gameId: string): Promise<StartGameResponse> {
  return withFlowTrace("undoLastChoice", { gameId }, () => undoLastChoiceImpl(gameId));
}

async function undoLastChoiceImpl(gameId: string): Promise<StartGameResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  traceGameState("state.before", game);

  const snapshot = game.undoSnapshot;
  if (snapshot) {
    game.scene = structuredClone(snapshot.scene);
    game.history = structuredClone(snapshot.history);
    game.status = snapshot.status;
    game.selectedText = snapshot.selectedText;
    restoreOptional(game, "position", snapshot.position);
    restoreOptional(game, "sourceCursor", snapshot.sourceCursor);
    restoreOptional(game, "sourceEventProgress", snapshot.sourceEventProgress);
    restoreOptional(game, "sourceIntroducedCharacters", snapshot.sourceIntroducedCharacters);
    restoreOptional(game, "storyMemory", snapshot.storyMemory);
    restoreOptional(game, "establishedEvent", snapshot.establishedEvent);
    restoreOptional(game, "turnNumber", snapshot.turnNumber);
    game.turnHistory = (game.turnHistory ?? []).slice(0, snapshot.turnHistoryLength ?? 0);
    restoreOptional(game, "activeConversation", snapshot.activeConversation);
    restoreOptional(
      game,
      "activeConversationAnchorDirected",
      snapshot.activeConversationAnchorDirected,
    );
    game.undoSnapshot = undefined;
  } else {
    const lastHistoryItem = game.history.at(-1);
    if (!game.activeConversation || lastHistoryItem?.kind !== "choice") {
      throw new Error("No choice is available to undo");
    }
    game.history.pop();
    game.activeConversation = undefined;
    game.activeConversationAnchorDirected = undefined;
  }

  game.updatedAt = new Date().toISOString();
  await saveGame(game);
  traceGameState("state.saved", game);
  return gameResponse(game);
}

export async function makeChoice(gameId: string, request: MakeChoiceRequest): Promise<StartGameResponse | TalkResponse> {
  return withFlowTrace("makeChoice", { gameId, request }, () => makeChoiceImpl(gameId, request));
}

async function makeChoiceImpl(gameId: string, request: MakeChoiceRequest): Promise<StartGameResponse | TalkResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  traceGameState("state.before", game);
  if (game.status !== "active") throw new Error(`Game has already ended with status ${game.status}`);
  const freeAction = resolveFreeAction(request);
  const choice: GameChoice | undefined = freeAction
    ? { id: FREE_ACTION_CHOICE_ID, type: "action" as const, text: freeAction }
    : game.scene.choices.find((item) => item.id === request.choiceId);
  if (!choice) throw new Error("Choice not found in current scene");
  traceEvent("choice.resolved", { choice, freeAction });
  if (choice.id === SOURCE_CONTINUATION_CHOICE_ID) {
    return continueFromSource(gameId);
  }
  const anchorDirected = !freeAction
    && isAnchorDirectedChoice(game.scene, choice.id);

  game.undoSnapshot = createUndoSnapshot(game);
  game.history.push({ kind: "choice", text: choice.text });

  if (choice.type === "talk") {
    const character = choice.character || choice.text.replace(/^talk to\s+/i, "");
    const { candidates } = await sourceContextForGame(
      game,
      anchorDirected ? choice.sourceEventId : undefined,
    );
    const conversation = await gameEngine().startTalk(
      game,
      character,
      candidates,
      {
        anchorDirected,
        choiceStakes: choice.stakes,
        sourceEventId: choice.sourceEventId,
        sourceAnchorRoute: choice.sourceAnchorRoute,
      },
    );
    game.activeConversation = {
      ...conversation,
      ...(choice.sourceEventId ? { sourceEventId: choice.sourceEventId } : {}),
    };
    game.activeConversationAnchorDirected = anchorDirected || undefined;
    game.updatedAt = new Date().toISOString();
    await saveGame(game);
    traceGameState("state.saved", game);
    return conversation;
  }

  game.activeConversation = undefined;
  game.activeConversationAnchorDirected = undefined;
  const book = await getBook(game.book.bookId);
  await applyReviewedGeneratedScene(
    game,
    await generateWithSourceContext(
      game,
      async (candidates) => await gameEngine().continue(
        game,
        choice.text,
        candidates,
        {
          anchorDirected,
          choiceStakes: choice.stakes,
          sourceEventId: choice.sourceEventId,
          sourceAnchorRoute: choice.sourceAnchorRoute,
        },
      ),
      anchorDirected ? choice.sourceEventId : undefined,
    ),
    book,
  );
  game.status = game.scene.outcome ?? "active";
  game.history.push({
    kind: "scene",
    text: game.scene.text,
    development: game.scene.development,
    sceneScope: game.scene.sceneScope,
  });
  recordCompletedTurn(game, "choice", choice.text);
  await saveGame(game);
  traceGameState("state.saved", game);
  return gameResponse(game);
}

export async function continueScene(
  gameId: string,
): Promise<StartGameResponse> {
  return withFlowTrace("continueScene", { gameId }, () => continueSceneImpl(gameId));
}

async function continueSceneImpl(
  gameId: string,
): Promise<StartGameResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  traceGameState("state.before", game);
  if (game.status !== "active") {
    throw new Error(`Game has already ended with status ${game.status}`);
  }

  game.undoSnapshot = createUndoSnapshot(game);
  game.activeConversation = undefined;
  game.activeConversationAnchorDirected = undefined;
  game.history.push({
    kind: "continuation",
    text: "Narrate the next moment as the scene progresses without choosing a player action.",
  });
  const { book, candidates } = await sourceContextForGame(game);
  await applyReviewedGeneratedScene(
    game,
    await gameEngine().continueScene(game, candidates),
    book,
  );
  game.status = game.scene.outcome ?? "active";
  game.history.push({
    kind: "scene",
    text: game.scene.text,
    development: game.scene.development,
    sceneScope: game.scene.sceneScope,
  });
  recordCompletedTurn(game, "continuation", "Continue the story");
  await saveGame(game);
  traceGameState("state.saved", game);
  return gameResponse(game);
}

export async function initiateEvent(
  gameId: string,
  request: InitiateEventRequest,
): Promise<StartGameResponse> {
  return withFlowTrace("initiateEvent", { gameId, request }, () => initiateEventImpl(gameId, request));
}

async function initiateEventImpl(
  gameId: string,
  request: InitiateEventRequest,
): Promise<StartGameResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  traceGameState("state.before", game);
  if (game.status !== "active") throw new Error(`Game has already ended with status ${game.status}`);
  const eventText = resolveEventText(request);

  game.undoSnapshot = createUndoSnapshot(game);
  game.history.push({ kind: "event", text: eventText });
  game.activeConversation = undefined;
  game.activeConversationAnchorDirected = undefined;
  const book = await getBook(game.book.bookId);
  try {
    await applyReviewedGeneratedScene(
      game,
      await generateWithSourceContext(
        game,
        async (candidates) => await gameEngine().continueEvent(game, eventText, candidates),
      ),
      book,
    );
  } catch (error) {
    if (!(error instanceof SceneGenerationError)) throw error;
    applyGeneratedScene(
      game,
      eventGenerationFailureScene(eventText, error),
      book,
    );
  }
  game.status = game.scene.outcome ?? "active";
  game.history.push({
    kind: "scene",
    text: game.scene.text,
    development: game.scene.development,
    sceneScope: game.scene.sceneScope,
  });
  recordCompletedTurn(game, "event", eventText);
  await saveGame(game);
  traceGameState("state.saved", game);
  return gameResponse(game);
}

export async function setParameter(
  gameId: string,
  request: SetParameterRequest,
): Promise<SetParameterResponse> {
  return withFlowTrace("setParameter", { gameId, request }, () => setParameterImpl(gameId, request));
}

async function setParameterImpl(
  gameId: string,
  request: SetParameterRequest,
): Promise<SetParameterResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  traceGameState("state.before", game);
  if (game.status !== "active") {
    throw new Error(`Game has already ended with status ${game.status}`);
  }

  const parameter = resolveParameterText(request);
  game.parameters = appendGameParameter(game.parameters, parameter);
  game.updatedAt = new Date().toISOString();
  await saveGame(game);
  traceGameState("state.saved", game);
  return {
    gameId: game.gameId,
    parameters: [...game.parameters],
  };
}

export async function say(gameId: string, request: DialogueRequest): Promise<StartGameResponse> {
  return withFlowTrace("say", { gameId, request }, () => sayImpl(gameId, request));
}

async function sayImpl(gameId: string, request: DialogueRequest): Promise<StartGameResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  traceGameState("state.before", game);
  if (game.status !== "active") throw new Error(`Game has already ended with status ${game.status}`);
  const character = game.activeConversation?.character;
  if (!character) throw new Error("No active conversation");
  const anchorDirected = game.activeConversationAnchorDirected ?? false;
  const sourceEventId = game.activeConversation?.sourceEventId;
  if (!request.text?.trim()) throw new Error("Dialogue text is required");

  game.history.push({ kind: "dialogue", text: `${game.playerName} to ${character}: ${request.text.trim()}` });
  const book = await getBook(game.book.bookId);
  await applyReviewedGeneratedScene(
    game,
    await generateWithSourceContext(
      game,
      async (candidates) => await gameEngine().continueDialogue(
        game,
        character,
        request.text.trim(),
        candidates,
        { anchorDirected, sourceEventId },
      ),
      anchorDirected ? sourceEventId : undefined,
    ),
    book,
  );
  game.status = game.scene.outcome ?? "active";
  game.history.push({
    kind: "scene",
    text: game.scene.text,
    development: game.scene.development,
    sceneScope: game.scene.sceneScope,
  });
  game.activeConversation = undefined;
  game.activeConversationAnchorDirected = undefined;
  recordCompletedTurn(
    game,
    "dialogue",
    `${game.playerName} to ${character}: ${request.text.trim()}`,
  );
  await saveGame(game);
  traceGameState("state.saved", game);
  return gameResponse(game);
}
