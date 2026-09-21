import {startFreeWorldTalk} from '../../ai/free-world.js';
import {applyFreeWorldTurn, retirePreviousBridgeMenu} from './free-world.js';
import {restoreSideTurnSourceAnchor} from './resume-source-anchor.js';
import {newSceneCode, bridgeStillPossible, bridgeBeatSelection, applyBridgeEntry, type ReturnBridge} from '../return-bridges.js';
import {ensureDeathLedger} from './engine-access.js';
import { sourceIndexFingerprint } from "../../books/source-index/game-version.js";
import { withFlowTrace, traceGameState, traceEvent } from "../../util/flow-trace.js";
import crypto from "node:crypto";
import {
  addSourceContinuationAnchorChoice,
  findPassageContext,
  SceneGenerationError,
} from "../../ai/engine.js";
import {
  FREE_ACTION_CHOICE_ID,
  SOURCE_ANCHOR_CHOICE_ID,
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
  changeReturnPlanning,
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
  sourceCandidateForKnownEvent,
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
    narrativeMode: "canonical",
    confirmedDeadCharacters: [],
    gameId: `game_${crypto.randomUUID().replaceAll("-", "")}`,
    book: request.book,
    sourceIndexFingerprint: sourceIndexFingerprint(book),
    ...(book.chapters.some(c => (c.sourceIndex?.schemaVersion ?? 0) >= 10)
      || book.storyEvents?.some(e => e.beats?.some(b => b.characterActionGroup)) ? {playerActionVersion: 2 as const} : {}),
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
    ...(canonicalStart.sourceEventProgress ? {sourceEventProgress: canonicalStart.sourceEventProgress} : {}),
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
  game.narrativeMode = "canonical";
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
  await ensureDeathLedger(game);
  const sourceWorldState = sourceWorldStateForGame(game, book, cursor);
  const canonicalCandidate = buildCanonicalNextEventCandidate(
    book,
    cursor,
    game.playerName,
    sourceWorldState,
  );
  const candidates = canonicalCandidate ? [canonicalCandidate] : playerHasCanonicalTimeline ? [] : buildSourceContinuationCandidates(book, cursor);
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

  let continuationRejection: SceneGenerationError | undefined;
  const rememberRejection = (error: SceneGenerationError) => { continuationRejection = error; };
  let result = await attemptSourceContinuation(
    async () => await gameEngine().continueFromSource(game, candidates),
    rememberRejection,
  );
  // Explicit legacy /story requests may still recover unindexed books. Free turns never enter this path.
  if (!result && !playerHasCanonicalTimeline) {
    result = await attemptSourceContinuation(
      () => gameEngine().continueFromSource(game, buildSourceRecoveryCandidates(book)), rememberRejection);
  }
  if (!result) {
    return gameResponse(game, storyContinuationUnavailableNotice(game.scene, continuationRejection));
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
    ...(game.narrativeMode ? {narrativeMode: game.narrativeMode} : {}),
    ...(game.confirmedDeadCharacters ? {confirmedDeadCharacters: [...game.confirmedDeadCharacters]} : {}),
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
    restoreOptional(game, "narrativeMode", snapshot.narrativeMode);
    game.returnPlanning = {bridges: [], generation: (game.returnPlanning?.generation ?? 0) + 1};
    game.sceneTrace = {storyCode: newSceneCode(game)};
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
    restoreOptional(game, "confirmedDeadCharacters", snapshot.confirmedDeadCharacters);
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

async function enterCanonicalBridgePrelude(game: GameState, bridge: ReturnBridge, book: NonNullable<Awaited<ReturnType<typeof getBook>>>): Promise<boolean> {
  const prelude = bridge.canonicalPrelude;
  if (!prelude?.beats.length) return false;
  const draft = structuredClone(game);
  draft.narrativeMode = 'canonical';
  applyBridgeEntry(draft, bridge);
  const candidate = sourceCandidateForKnownEvent(book, draft, prelude.eventId);
  if (!candidate) return false;
  traceEvent('free_world.bridge_canonical_prelude', {
    bridgeId:bridge.id, entryEventId:prelude.eventId, startBeatIndex:prelude.startBeatIndex,
    targetEventId:prelude.targetEventId, targetBeatIndex:prelude.targetBeatIndex, beats:prelude.beats,
  });
  const freeText = draft.scene.text;
  const result = await gameEngine().continueFromSource(draft, [candidate]);
  if (!result) return false;
  if (result.requiresExplicitPlayerChoice) {
    draft.scene = {...draft.scene, choices:result.scene.choices};
  } else {
    await applyReviewedGeneratedScene(draft, {
      ...result.scene,
      sourceProgress: {
        chapterPosition: result.chapterPosition,
        textOffset: result.nextTextOffset,
        ...(result.eventId ? {eventId:result.eventId} : {}),
      },
    }, book, false);
    if (draft.scene.text.trim() && freeText.trim() && draft.scene.text.trim() !== freeText.trim())
      draft.scene.text = `${freeText.trim()}\n\n${draft.scene.text.trim()}`;
  }
  const stored = draft.returnPlanning?.bridges.find(b => b.id === bridge.id);
  if (stored) stored.status = 'used';
  if (draft.returnPlanning?.activeBridgeId === bridge.id) delete draft.returnPlanning.activeBridgeId;
  Object.assign(game, draft);
  return true;
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
  let anchorDirected = !freeAction
    && isAnchorDirectedChoice(game.scene, choice.id);

  // Once the player explicitly selects an anchor, returning to canon is already
  // decided. Do not spend background calls preparing alternative return routes
  // while the canonical turn is being generated. Removing a claimed job also
  // invalidates its lease token, so an in-flight worker cannot publish afterward.
  if (anchorDirected && game.returnPlanning?.job) {
    const cancelledJob = {...game.returnPlanning.job};
    delete game.returnPlanning.job;
    await changeReturnPlanning(gameId, current => {
      if (!current.returnPlanning?.job) return false;
      delete current.returnPlanning.job;
      return true;
    });
    traceEvent('free_world.bridge_planning_cancelled', {
      reason: 'anchor selected',
      revision: game.gameRevision,
      jobRevision: cancelledJob.revision,
      hadLease: Boolean(cancelledJob.token),
    });
  }

  const narrativeModeBeforeChoice = game.narrativeMode ?? 'canonical';
  const previousCanonicalAnchor = !anchorDirected && narrativeModeBeforeChoice === 'canonical'
    ? game.scene.choices.find(candidate =>
        candidate.id === SOURCE_ANCHOR_CHOICE_ID
        && candidate.sourceAnchorRoute === 'event'
        && Boolean(candidate.sourceBeatSelection)
      )
    : undefined;
  const preserveCanonicalSideTurn = Boolean(previousCanonicalAnchor);
  game.undoSnapshot = createUndoSnapshot(game);
  game.history.push({ kind: "choice", text: choice.text });
  const planning = game.returnPlanning;
  let selectedBridgeStep: ReturnBridge | undefined;
  if (planning) {
    const step = planning.bridges.find(b => b.id === choice.bridgeStepId && bridgeStillPossible(b, game));
    if (step) {
      selectedBridgeStep = step;
      planning.activeBridgeId = step.id;
      traceEvent('free_world.bridge_started', {bridgeId:step.id, action:choice.text, target:step.target,
        canonicalPrelude:step.canonicalPrelude ?? null});
    } else if (!choice.bridgeId && planning.activeBridgeId) {
      traceEvent('free_world.bridge_abandoned', {bridgeId:planning.activeBridgeId, action:choice.text});
      const old = planning.bridges.find(b => b.id === planning.activeBridgeId);
      if (old) old.status = 'ready';
      delete planning.activeBridgeId;
    }
  }
  retirePreviousBridgeMenu(game, choice.bridgeId);
  const bridge = choice.bridgeId ? game.returnPlanning?.bridges.find(b => b.id === choice.bridgeId && b.status === 'offered') : undefined;
  let bridgeCandidate;
  // Undo/expiration can leave a menu whose prepared opportunity no longer exists.
  // Never turn that stale metadata into a fresh source search.
  if (choice.bridgeId && !bridge) anchorDirected = false;
  if (bridge) {
    const bridgeBook = await getBook(game.book.bookId);
    if (bridgeBook && bridgeStillPossible({...bridge, status: 'ready'}, game))
      bridgeCandidate = sourceCandidateForKnownEvent(bridgeBook, game, bridge.eventId);
    bridge.status = bridgeCandidate ? 'used' : 'retired';
    anchorDirected = Boolean(bridgeCandidate);
  }
  // Any non-anchor side interaction from a canonical menu keeps the pending
  // server-owned player beat. Talking, custom actions, waiting, looking around,
  // etc. do not become a permanent divergence by themselves.
  game.narrativeMode = anchorDirected || preserveCanonicalSideTurn ? 'canonical' : 'free';
  game.sceneTrace = {storyCode: newSceneCode(game), ...(bridgeCandidate ? {bridgeId: bridge!.id, sourceEventId: bridge!.eventId} : anchorDirected && choice.sourceEventId ? {sourceEventId: choice.sourceEventId} : {})};

  if (choice.type === "talk") {
    const character = choice.character || choice.text.replace(/^talk to\s+/i, "");
    const { candidates } = anchorDirected
      ? await sourceContextForGame(game, choice.sourceEventId) : {candidates: []};
    const conversation = !anchorDirected ? await startFreeWorldTalk(game, character) : await gameEngine().startTalk(
      anchorDirected ? game : {...game, selectedText: ""},
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
  if (!anchorDirected) {
    const freeResult = await applyFreeWorldTurn(
      game,
      choice.text,
      'action',
      book,
      preserveCanonicalSideTurn
        ? {preserveNarrativeMode:true, suppressBridgeRouting:true}
        : undefined,
    );
    if (preserveCanonicalSideTurn) {
      const restored = restoreSideTurnSourceAnchor(game, book, previousCanonicalAnchor);
      traceEvent('side_turn.anchor_restore', {
        ...restored,
        selectedInput: choice.text,
        previousAnchorText: previousCanonicalAnchor?.text ?? null,
        restoredAnchorText: restored.restored ? game.scene.choices[0]?.text ?? null : null,
        sourceBeatSelection: previousCanonicalAnchor?.sourceBeatSelection ?? null,
      });
      if (!restored.restored) {
        game.scene = addSourceContinuationAnchorChoice(game.scene);
      }
    }
    if (selectedBridgeStep?.canonicalPrelude && book && freeResult.bridgePreludeReady) {
      const reentered = await enterCanonicalBridgePrelude(game, selectedBridgeStep, book);
      traceEvent('free_world.bridge_reentry_result', {bridgeId:selectedBridgeStep.id,reentered});
    }
  } else if (bridgeCandidate) {
    if (bridge!.canonicalPrelude?.beats.length && book) {
      // Legacy/offered menus may already contain a direct target anchor. Do not
      // skip the newly reserved automatic source prelude; play it first and stop
      // at the real target decision boundary.
      const reentered = await enterCanonicalBridgePrelude(game, bridge!, book);
      if (!reentered) throw new Error('Bridge canonical prelude could not be entered');
    } else {
      const draft = structuredClone(game);
      applyBridgeEntry(draft, bridge!);
      traceEvent('free_world.bridge_reentry', {bridgeId:bridge!.id, selection:bridgeBeatSelection(bridge!),
        reason:bridge!.selectionReason, previousProgress:game.sourceEventProgress, entryProgress:draft.sourceEventProgress});
      await applyReviewedGeneratedScene(draft, await gameEngine().continue(draft, choice.text, [bridgeCandidate],
        {anchorDirected: true, sourceEventId: bridgeCandidate.requiredEventId, sourceAnchorRoute: 'event',
          sourceBeatSelection: bridgeBeatSelection(bridge!)}), book);
      Object.assign(game, draft);
    }
  } else {
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
          sourceBeatSelection: anchorDirected ? choice.sourceBeatSelection : undefined,
        },
      ),
      anchorDirected ? choice.sourceEventId : undefined,
    ),
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

  const pendingCanonicalAnchor = game.narrativeMode !== 'free'
    ? game.scene.choices.find(choice => choice.id === SOURCE_ANCHOR_CHOICE_ID)
    : undefined;
  if (pendingCanonicalAnchor) {
    traceEvent('canonical.continuation_stopped_at_player_decision', {
      anchorText: pendingCanonicalAnchor.text,
      sourceEventId: pendingCanonicalAnchor.sourceEventId ?? null,
      sourceBeatSelection: pendingCanonicalAnchor.sourceBeatSelection ?? null,
    });
    return gameResponse(game);
  }

  game.undoSnapshot = createUndoSnapshot(game);
  game.activeConversation = undefined;
  game.activeConversationAnchorDirected = undefined;
  game.history.push({
    kind: "continuation",
    text: "Narrate the next moment as the scene progresses without choosing a player action.",
  });
  if (game.narrativeMode === 'free') {
    await applyFreeWorldTurn(game, 'Let the situation develop without choosing a player action.', 'observe', await getBook(game.book.bookId));
  } else {
    game.narrativeMode = 'canonical';
    const { book, candidates } = await sourceContextForGame(game);
    await applyReviewedGeneratedScene(game, await gameEngine().continueScene(game, candidates), book);
  }
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
  retirePreviousBridgeMenu(game);
  await applyFreeWorldTurn(game, eventText, 'event', book);
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
  const preserveCanonicalAnchor = !anchorDirected && game.narrativeMode === 'canonical';
  const previousAnchor = preserveCanonicalAnchor
    ? game.undoSnapshot?.scene.choices.find(choice => choice.id === SOURCE_ANCHOR_CHOICE_ID)
    : undefined;
  if (!request.text?.trim()) throw new Error("Dialogue text is required");

  game.history.push({ kind: "dialogue", text: `${game.playerName} to ${character}: ${request.text.trim()}` });
  const book = await getBook(game.book.bookId);
  if (!anchorDirected) {
    await applyFreeWorldTurn(
      game,
      `${game.playerName} says to ${character}: ${request.text.trim()}`,
      'dialogue',
      book,
      preserveCanonicalAnchor ? {preserveNarrativeMode:true, suppressBridgeRouting:true} : undefined,
    );
    if (preserveCanonicalAnchor) {
      // A side conversation is not a new canonical decision. Freeze source
      // progress and restore the same server-owned player beat deterministically.
      // The visible label is regenerated from the same source beat and current scope.
      game.activeConversation = undefined;
      game.activeConversationAnchorDirected = undefined;
      const restored = restoreSideTurnSourceAnchor(game, book, previousAnchor);
      traceEvent('dialogue.anchor_restore', {
        ...restored,
        previousAnchorId: previousAnchor?.id ?? null,
        previousAnchorText: previousAnchor?.text ?? null,
        restoredAnchorText: restored.restored ? game.scene.choices[0]?.text ?? null : null,
        sourceBeatSelection: previousAnchor?.sourceBeatSelection ?? null,
      });
      if (!restored.restored) {
        // Keep an explicit canonical route visible even when the exact target was
        // consumed or irreversibly invalidated. The next continuation will use
        // the updated source/invalidated-target state and find the next viable beat.
        game.scene = addSourceContinuationAnchorChoice(game.scene);
      }
    }
  } else {
    game.narrativeMode = 'canonical';
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
  }
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
