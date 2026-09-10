import { withFlowTrace, traceGameState, traceEvent } from "../../util/flow-trace.js";
import {
  addSourceContinuationChoiceFallback,
  addSourceContinuationAnchorChoice,
  filterSceneScopeForState,
  firstChoiceWasFiltered,
  removeDuplicateChoices,
  removeChoicesWithPlayerIdentityReferences,
  removeChoicesWithUnintroducedCharacters,
  stripEmbeddedChoiceMenu,
  stripLeakedSceneMetadata,
} from "../../ai/engine.js";
import type {
  GeneratedScene,
} from "../../ai/engine.js";
import type {
  GameNotice,
  GameState,
  GameTurnHistoryEntry,
  GameTurnKind,
  ImportedBook,
  ResumeGameResponse,
  SavedGameSummary,
  StartGameResponse,
  TalkResponse,
} from "../../shared/contracts.js";
import {
  getBook,
} from "../../books/repository.js";
import {
  getGame,
  listGames,
  saveGame,
} from "../repository.js";
import {
  applyStoryMemory,
  compactGameHistory,
} from "../memory.js";
import {
  gameEngine,
} from "./engine-access.js";
import {
  sourceIntroducedCharactersAtCursor,
  normalizeSourceProgress,
  refreshCanonicalFirstChoice,
  sourceContextForGame,
  buildSourceContinuationCandidates,
  buildSourceContextCandidates,
} from "./source-candidates.js";

export function sanitizeStoredScene(game: GameState): boolean {
  let changed = false;
  if (game.turnNumber !== undefined) {
    const turnNumber = currentTurnNumber(game);
    const title = titleForTurn(game.scene.title, turnNumber);
    if (game.turnNumber !== turnNumber || game.scene.title !== title) {
      game.turnNumber = turnNumber;
      game.scene = { ...game.scene, title };
      changed = true;
    }
  }
  const sceneText = stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(game.scene.text));
  if (sceneText !== game.scene.text) {
    game.scene = { ...game.scene, text: sceneText };
    changed = true;
  }

  game.history = game.history.map((item) => {
    if (item.kind !== "scene") return item;
    const text = stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(item.text));
    if (text === item.text) return item;
    changed = true;
    return { ...item, text };
  });

  if (game.turnHistory) {
    game.turnHistory = game.turnHistory.map((turn) => {
      const text = stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(turn.scene.text));
      if (text === turn.scene.text) return turn;
      changed = true;
      return { ...turn, scene: { ...turn.scene, text } };
    });
  }

  if (game.scene.sceneScope) {
    const sceneScope = filterSceneScopeForState(game.scene.sceneScope, game);
    if (JSON.stringify(sceneScope) !== JSON.stringify(game.scene.sceneScope)) {
      game.scene = { ...game.scene, sceneScope };
      changed = true;
    }
  }
  const perspectiveSafeScene = removeChoicesWithPlayerIdentityReferences(
    game.scene,
    game.playerName,
    game.characterProfiles,
  );
  if (perspectiveSafeScene.choices.length !== game.scene.choices.length) {
    const firstChoiceRemoved = firstChoiceWasFiltered(
      game.scene.choices,
      perspectiveSafeScene.choices,
      game.scene.outcome,
    );
    game.scene = firstChoiceRemoved
      ? addSourceContinuationAnchorChoice(perspectiveSafeScene)
      : perspectiveSafeScene;
    changed = true;
  }
  const availableScene = removeChoicesWithUnintroducedCharacters(game.scene, game);
  if (availableScene.choices.length !== game.scene.choices.length) {
    game.scene = availableScene;
    changed = true;
  }
  const distinctScene = removeDuplicateChoices(game.scene);
  if (distinctScene.choices.length !== game.scene.choices.length) {
    game.scene = distinctScene;
    changed = true;
  }
  const sceneWithFallback = addSourceContinuationChoiceFallback(game.scene);
  if (sceneWithFallback !== game.scene) {
    game.scene = sceneWithFallback;
    changed = true;
  }
  return changed;
}

export function gameResponse(game: GameState, notice?: GameNotice): StartGameResponse {
  return {
    gameId: game.gameId,
    scene: {
      ...game.scene,
      title: numberedSceneTitle(game),
      text: stripEmbeddedChoiceMenu(game.scene.text),
    },
    turnHistory: (game.turnHistory ?? []).map((turn) => ({
      ...turn,
      scene: {
        ...turn.scene,
        text: stripEmbeddedChoiceMenu(turn.scene.text),
      },
    })),
    gameProfile: game.gameProfile,
    objective: game.objective,
    victoryCondition: game.victoryCondition,
    status: game.status,
    ...(notice ? { notice } : {}),
  };
}

export const GENERATED_TURN_MARKER = /\s*\(Turn\s+\d+[a-z]?\)\s*/gi;
const GENERATED_TURN_TITLE_PREFIX =
  /^.*\(Turn\s+\d+[a-z]?\)(?:\s*\(Turn\s+\d+[a-z]?\))*\s*[—–-]\s*/i;

export function currentTurnNumber(game: GameState): number {
  const storedTurnNumber =
    Number.isInteger(game.turnNumber) && (game.turnNumber ?? 0) > 0
      ? game.turnNumber ?? 0
      : 0;
  const historyTurnNumber = game.history.filter((item) => item.kind === "scene").length;
  return Math.max(1, storedTurnNumber, historyTurnNumber);
}

export function titleForTurn(title: string, turnNumber: number): string {
  const latestTitle = title.replace(GENERATED_TURN_TITLE_PREFIX, "");
  const baseTitle = latestTitle
    .replace(GENERATED_TURN_MARKER, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return turnNumber > 0 ? `${baseTitle} (Turn ${turnNumber})` : baseTitle;
}

function numberedSceneTitle(game: GameState): string {
  return game.turnNumber === undefined
    ? game.scene.title
    : titleForTurn(game.scene.title, currentTurnNumber(game));
}

export function recordCompletedTurn(
  game: GameState,
  kind: GameTurnKind,
  action: string,
  completedAt = new Date().toISOString(),
): GameTurnHistoryEntry {
  const turnNumber = currentTurnNumber(game);
  if (turnNumber < 1) {
    throw new Error("Cannot record a completed turn before turn 1");
  }
  const normalizedAction = action.trim();
  if (!normalizedAction) {
    throw new Error(`Cannot record turn ${turnNumber} without an action`);
  }
  const previousTurn = game.turnHistory?.at(-1);
  if (previousTurn && previousTurn.turnNumber >= turnNumber) {
    throw new Error(`Cannot record turn ${turnNumber} after turn ${previousTurn.turnNumber}`);
  }

  const turn: GameTurnHistoryEntry = {
    turnNumber,
    kind,
    action: normalizedAction,
    scene: {
      title: game.scene.title,
      text: stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(game.scene.text)),
      ...(game.scene.outcome ? { outcome: game.scene.outcome } : {}),
      ...(game.scene.outcomeReason ? { outcomeReason: game.scene.outcomeReason } : {}),
    },
    completedAt,
  };
  (game.turnHistory ??= []).push(turn);
  game.updatedAt = completedAt;
  return turn;
}

export function applyGeneratedScene(
  game: GameState,
  generatedScene: GeneratedScene,
  book?: ImportedBook,
  advanceTurn = true,
): void {
  const {
    sourceProgress,
    sourceEventProgress,
    storyMemory,
    ...scene
  } = generatedScene;
  const previousSceneScope = game.scene.sceneScope;
  const turnNumber = currentTurnNumber(game) + (advanceTurn ? 1 : 0);
  applyStoryMemory(game, scene, storyMemory);
  game.turnNumber = turnNumber;
  if (sourceEventProgress !== undefined) {
    if (sourceEventProgress === null) {
      delete game.sourceEventProgress;
    } else {
      game.sourceEventProgress = {
        eventId: sourceEventProgress.eventId,
        completedBeatIndexes: [...sourceEventProgress.completedBeatIndexes],
      };
    }
  }
  game.scene = {
    ...scene,
    ...(scene.sceneScope
      ? { sceneScope: scene.sceneScope }
      : previousSceneScope
        ? { sceneScope: previousSceneScope }
        : {
            sceneScope: {
              currentLocation: "Unspecified location",
              peoplePresent: [],
              peopleWithinSpeakingDistance: [],
            },
          }),
    title: titleForTurn(scene.title, turnNumber),
  };
  if (!book) return;

  // A partial event and a cursor advance can be reported in the same generated
  // scene. Keep the cursor before that event until its ordered beat contract is
  // complete; otherwise candidate selection skips the still-unfinished beats.
  if (sourceProgress && sourceEventProgress == null) {
    delete game.sourceEventProgress;
    const chapter = book.chapters[sourceProgress.chapterPosition];
    if (chapter) {
      const normalizedProgress = normalizeSourceProgress(book, sourceProgress);
      game.sourceCursor = game.sourceCursor
        && game.sourceCursor.chapterPosition === normalizedProgress.chapterPosition
        ? {
            ...normalizedProgress,
            textOffset: Math.max(
              game.sourceCursor.textOffset,
              normalizedProgress.textOffset,
            ),
          }
        : normalizedProgress;
      game.position = {
        ...game.position,
        chapterIndex: sourceProgress.chapterPosition,
        chapterTitle: chapter.title,
      };
      game.sourceIntroducedCharacters = sourceIntroducedCharactersAtCursor(
        book,
        game.sourceCursor,
      );
    }
  }
  if (game.sourceCursor) {
    game.scene = refreshCanonicalFirstChoice(
      game.scene,
      book,
      game.sourceCursor,
      game.playerName,
    );
  }
}

export async function applyReviewedGeneratedScene(
  game: GameState,
  generatedScene: GeneratedScene,
  book?: ImportedBook,
  advanceTurn = true,
  alignSourceEvents = true,
): Promise<void> {
  traceEvent("scene.generated", generatedScene);
  const reviewedScene = generatedScene.outcome === "lost"
    ? await gameEngine().reviewLoss(game, generatedScene)
    : generatedScene;
  const hasReviewedPartialSourceEvent =
    reviewedScene.sourceEventProgress !== undefined
    && reviewedScene.sourceEventProgress !== null;
  applyGeneratedScene(game, reviewedScene, book, advanceTurn);
  traceGameState("state.applied", game);
  if (
    hasReviewedPartialSourceEvent
    || !alignSourceEvents
    || !book
    || !game.sourceCursor
    || (game.scene.outcome ?? "active") !== "active"
  ) {
    return;
  }
  const alignmentCandidate = buildSourceContinuationCandidates(
    book,
    game.sourceCursor,
  )[0];
  if (!alignmentCandidate) return;
  const alignedEventId = await gameEngine().identifyLatestVisibleStoryEvent(
    game,
    alignmentCandidate,
  );
  if (!alignedEventId) return;
  const alignedEvent = book.storyEvents?.find((event) => event.eventId === alignedEventId);
  const currentEvent = game.sourceCursor.eventId
    ? book.storyEvents?.find((event) => event.eventId === game.sourceCursor?.eventId)
    : undefined;
  if (!alignedEvent || (currentEvent && alignedEvent.sequence < currentEvent.sequence)) {
    return;
  }
  const advancedToLaterEvent = !currentEvent
    || alignedEvent.sequence > currentEvent.sequence;
  const alignedProgress = normalizeSourceProgress(book, {
    chapterPosition: alignedEvent.chapterPosition,
    textOffset: game.sourceCursor.textOffset,
    eventId: alignedEvent.eventId,
  });
  delete game.sourceEventProgress;
  game.sourceCursor = alignedProgress.chapterPosition === game.sourceCursor.chapterPosition
    ? {
        ...alignedProgress,
        textOffset: Math.max(game.sourceCursor.textOffset, alignedProgress.textOffset),
      }
    : alignedProgress;
  game.sourceIntroducedCharacters = sourceIntroducedCharactersAtCursor(
    book,
    game.sourceCursor,
  );
  if (advancedToLaterEvent) {
    const refreshedCandidates = buildSourceContextCandidates(
      book,
      game.sourceCursor,
      game.playerName,
    );
    if (refreshedCandidates.length > 0) {
      game.scene = await gameEngine().refreshSceneChoices(game, refreshedCandidates);
      return;
    }
  }
  game.scene = refreshCanonicalFirstChoice(
    game.scene,
    book,
    game.sourceCursor,
    game.playerName,
  );
}

export function isCompleteConversation(
  conversation: GameState["activeConversation"],
): conversation is TalkResponse {
  return Boolean(
    conversation
    && typeof conversation.prompt === "string"
    && conversation.prompt.trim()
    && Array.isArray(conversation.suggestions)
    && conversation.suggestions.length > 0
    && conversation.suggestions.every((suggestion) => typeof suggestion === "string" && suggestion.trim()),
  );
}

export function summarizeGames(games: readonly GameState[]): SavedGameSummary[] {
  return [...games]
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
      || right.createdAt.localeCompare(left.createdAt)
      || left.gameId.localeCompare(right.gameId),
    )
    .map((game) => ({
      gameId: game.gameId,
      book: game.book,
      playerName: game.playerName,
      status: game.status,
      sceneTitle: numberedSceneTitle(game),
      objective: game.objective,
      position: game.position,
      conversationCharacter: game.activeConversation?.character,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
    }));
}

export async function listSavedGames(): Promise<SavedGameSummary[]> {
  return summarizeGames(await listGames());
}

export async function resumeGame(gameId: string): Promise<ResumeGameResponse> {
  return withFlowTrace("resumeGame", { gameId }, () => resumeGameImpl(gameId));
}

async function resumeGameImpl(gameId: string): Promise<ResumeGameResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  traceGameState("state.before", game);
  if (game.status !== "active") throw new Error(`Game has already ended with status ${game.status}`);

  const book = await getBook(game.book.bookId);
  const sourceIntroducedCharacters = book
    ? sourceIntroducedCharactersAtCursor(book, game.sourceCursor)
    : game.sourceIntroducedCharacters ?? [];
  let gameChanged = false;
  gameChanged = compactGameHistory(game) || gameChanged;
  if (
    JSON.stringify(game.sourceIntroducedCharacters ?? [])
    !== JSON.stringify(sourceIntroducedCharacters)
  ) {
    game.sourceIntroducedCharacters = sourceIntroducedCharacters;
    gameChanged = true;
  }
  gameChanged = sanitizeStoredScene(game) || gameChanged;
  let activeConversation: TalkResponse | undefined;
  if (game.activeConversation) {
    if (isCompleteConversation(game.activeConversation)) {
      activeConversation = game.activeConversation;
    } else {
      const { candidates } = await sourceContextForGame(game);
      activeConversation = await gameEngine().startTalk(
        game,
        game.activeConversation.character,
        candidates,
        {
          anchorDirected: game.activeConversationAnchorDirected,
          sourceEventId: game.activeConversation.sourceEventId,
        },
      );
      game.activeConversation = activeConversation;
      game.updatedAt = new Date().toISOString();
      gameChanged = true;
    }
  }
  if (gameChanged) {
    await saveGame(game);
    traceGameState("state.saved", game);
  }

  return {
    ...gameResponse(game),
    book: game.book,
    playerName: game.playerName,
    activeConversation,
  };
}

