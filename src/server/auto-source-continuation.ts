import { flowDiagnostic } from "../util/flow-trace.js";
import { playerControlsBeat } from "../shared/turn-policy.js";
import { playerActionAt } from "../shared/player-actions.js";
import { runWithTurnBudget, currentTurnBudget, type TurnBudget } from "../ai/engine/turn-contract.js";
import {
  SOURCE_ANCHOR_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_TEXT,
} from "../shared/contracts.js";
import type {
  BookStoryEvent,
  GameChoice,
  GameState,
  ImportedBook,
  StartGameResponse,
  StoryEventBeat,
} from "../shared/contracts.js";
import {
  getBook,
} from "../books/repository.js";
import {
  getGame,
} from "../games/repository.js";
import {
  continueFromSource,
} from "../games/service.js";

import { gameResponse } from "../games/service/game-state.js";

const MAX_AUTOMATIC_SOURCE_HOPS = 32;

function isGameResponse(value: unknown): value is StartGameResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const scene = candidate.scene;
  return typeof candidate.gameId === "string"
    && Boolean(scene)
    && typeof scene === "object"
    && !Array.isArray(scene);
}

function hasOnlySourceContinuationChoice(response: StartGameResponse): boolean {
  return response.status === "active"
    && response.scene.choices.length === 1
    && response.scene.choices[0]?.id === SOURCE_CONTINUATION_CHOICE_ID;
}

export function isStaleSourceContinuationRequest(
  choiceId: string,
  currentChoices: readonly Pick<GameChoice, "id">[],
): boolean {
  return choiceId === SOURCE_CONTINUATION_CHOICE_ID
    && !currentChoices.some((choice) => choice.id === SOURCE_CONTINUATION_CHOICE_ID);
}

function normalizedIdentity(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase()
    : "";
}

function normalizedAction(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    : "";
}

function playerIdentityKeys(game: GameState, book: ImportedBook): Set<string> {
  const player = normalizedIdentity(game.playerName);
  const profile = book.worldBible?.characterProfiles?.find((candidate) =>
    [candidate.name, ...candidate.aliases]
      .some((identity) => normalizedIdentity(identity) === player)
  );
  return new Set(
    (profile ? [profile.name, ...profile.aliases] : [game.playerName])
      .map(normalizedIdentity)
      .filter(Boolean),
  );
}

function isPlayerDecisionBeat(
  beat: StoryEventBeat,
  identities: ReadonlySet<string>,
): boolean {
  return playerControlsBeat(beat, [...identities]);
}

function nextIncompleteSourceBeatContext(
  game: GameState,
  book: ImportedBook,
) {
  if (!game.sourceEventProgress) return undefined;
  const event = book.storyEvents?.find(
    (candidate) => candidate.eventId === game.sourceEventProgress?.eventId,
  );
  if (!event?.beats?.length) return undefined;
  const completed = new Set(game.sourceEventProgress.completedBeatIndexes);
  const beatIndex = event.beats.findIndex((_beat, index) =>
    index >= (game.sourceEventProgress?.startBeatIndex ?? 0) && !completed.has(index));
  return beatIndex >= 0 ? { event, beatIndex, beat: event.beats[beatIndex]! } : undefined;
}

function currentSourceEvent(
  game: GameState,
  book: ImportedBook,
) {
  const eventId = game.sourceEventProgress?.eventId ?? game.sourceCursor?.eventId;
  return eventId
    ? book.storyEvents?.find((event) => event.eventId === eventId)
    : undefined;
}

function nextSourceEvent(
  game: GameState,
  book: ImportedBook,
) {
  const currentEvent = currentSourceEvent(game, book);
  if (!currentEvent) return undefined;
  return book.storyEvents
    ?.filter((event) => event.sequence > currentEvent.sequence)
    .sort((left, right) => left.sequence - right.sequence)[0];
}

/**
 * Return the next canonical beat even when the current event has just finished.
 *
 * sourceEventProgress is event-scoped, so looking only inside that progress
 * returns undefined at the exact moment an event completes. At that boundary we
 * must continue into the next event before exposing choices whenever its prefix
 * is automatic (for example: farmhouse lands -> Dorothy wakes -> player opens
 * the door).
 */
function nextPendingSourceBeatContext(
  game: GameState,
  book: ImportedBook,
) {
  const nextIncomplete = nextIncompleteSourceBeatContext(game, book);
  if (nextIncomplete) return nextIncomplete;
  const event = nextSourceEvent(game, book);
  const beat = event?.beats?.[0];
  return event && beat ? { event, beatIndex: 0, beat } : undefined;
}

export function nextPendingSourceBeat(
  game: GameState,
  book: ImportedBook,
): StoryEventBeat | undefined {
  return nextPendingSourceBeatContext(game, book)?.beat;
}

export function nextSourceBeatIsPlayerDecision(
  game: GameState,
  book: ImportedBook,
): boolean {
  const identities = playerIdentityKeys(game, book);
  if (identities.size === 0) return false;
  const beat = nextPendingSourceBeat(game, book);
  return Boolean(beat && isPlayerDecisionBeat(beat, identities));
}

function baseFormOfActionVerb(word: string): string {
  const normalized = word.toLocaleLowerCase();
  if (normalized === "does") return "do";
  if (normalized === "goes") return "go";
  if (normalized === "has") return "have";
  if (normalized === "is") return "be";
  if (normalized.endsWith("ies") && normalized.length > 4) return `${normalized.slice(0, -3)}y`;
  if (/(?:ches|shes|sses|xes|zes)$/u.test(normalized)) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && !normalized.endsWith("ss") && normalized.length > 3) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function playerBeatChoiceText(
  beat: StoryEventBeat,
  game: GameState,
  book: ImportedBook,
  event?: BookStoryEvent,
  beatIndex?: number,
): string {
  const identities = [...playerIdentityKeys(game, book)].sort((a, b) => b.length - a.length);
  const grouped = event?.beats && Number.isInteger(beatIndex)
    ? playerActionAt(event.beats, beatIndex!, identities)
    : undefined;
  if (grouped?.choiceText?.trim()) return grouped.choiceText.trim();

  const trimmed = beat.action.trim().replace(/[.!?]+$/u, "");
  const leadingVerb = /^(\p{L}+)(.*)$/u.exec(trimmed);
  if (!leadingVerb) return trimmed;
  const baseVerb = baseFormOfActionVerb(leadingVerb[1]!);
  let action = `${baseVerb.charAt(0).toLocaleUpperCase()}${baseVerb.slice(1)}${leadingVerb[2]}`;
  for (const identity of identities) {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    action = action
      .replace(new RegExp(`${escaped}(?:'s|’s)`, "giu"), "my")
      .replace(new RegExp(String.raw`\b${escaped}\b`, "giu"), "me");
  }
  return action;
}

function continuationChoice(): GameChoice {
  return {
    id: SOURCE_CONTINUATION_CHOICE_ID,
    type: "action",
    text: SOURCE_CONTINUATION_CHOICE_TEXT,
    requiredPresentCharacters: [],
    requiredAbsentCharacters: [],
    stakes: "significant",
  };
}

export function normalizeSourceBoundaryChoices(
  response: StartGameResponse,
  game: GameState,
  book: ImportedBook,
): StartGameResponse {
  const pending = nextPendingSourceBeatContext(game, book);
  const nextBeat = pending?.beat;
  const identities = playerIdentityKeys(game, book);

  // Check the canonical pending beat before trusting generated choices. At an
  // event boundary the scene generator may already have produced generic or
  // next-event choices even though automatic beats still precede the next
  // meaningful player decision. On an explicitly source-directed menu, replace
  // those premature choices with the hidden
  // source continuation route so autoAdvanceSourceContinuations can consume the
  // automatic prefix first. Local menus retain their optional source route.
  const followsSource = response.scene.choices.some(choice => [SOURCE_ANCHOR_CHOICE_ID, SOURCE_CONTINUATION_CHOICE_ID].includes(choice.id));
  if (followsSource && nextBeat && !isPlayerDecisionBeat(nextBeat, identities)) {
    return {
      ...response,
      scene: { ...response.scene, choices: [continuationChoice()] },
    };
  }

  const anchorIndex = response.scene.choices.findIndex(
    (choice) => choice.id === SOURCE_ANCHOR_CHOICE_ID,
  );
  if (anchorIndex < 0 || !nextBeat || !isPlayerDecisionBeat(nextBeat, identities)) {
    return response;
  }

  const anchor = response.scene.choices[anchorIndex]!;
  const correctedText = playerBeatChoiceText(nextBeat, game, book, pending?.event, pending?.beatIndex);
  const previousActions = new Set(
    (game.turnHistory ?? [])
      .slice(-4)
      .map((turn) => normalizedAction(turn.action)),
  );
  if (previousActions.has(normalizedAction(correctedText))) {
    return {
      ...response,
      scene: { ...response.scene, choices: [continuationChoice()] },
    };
  }

  const choices = [...response.scene.choices];
  choices[anchorIndex] = { ...anchor, text: correctedText };
  return { ...response, scene: { ...response.scene, choices } };
}

/** Leave a saved continuation button before spending part of an unaffordable next window. */
export function automaticSourceWindowFitsBudget(game: GameState, book: ImportedBook, budget: TurnBudget): boolean {
  const pending = game.sourceEventProgress ? currentSourceEvent(game, book) : nextSourceEvent(game, book);
  const completed = new Set(game.sourceEventProgress?.completedBeatIndexes ?? []);
  const identities = playerIdentityKeys(game, book);
  let count = 0;
  for (const [index, beat] of (pending?.beats ?? []).entries()) {
    if (game.sourceEventProgress && (index < (game.sourceEventProgress.startBeatIndex ?? 0) || completed.has(index))) continue;
    if (isPlayerDecisionBeat(beat, identities)) break;
    count++;
  }
  // Bare calls, rewrite, optional content review, and bounded choice construction/repair headroom.
  const review = process.env.BOOKRPG_SCENE_CONTENT_REVIEW?.trim().toLowerCase() === 'true';
  return budget.canReserve(count + 1 + (review ? 1 : 0) + 8,
    count * 1600 + 4800 + (review ? Math.max(4800, count * 500 + 1600) : 0) + 8 * 4800);
}

function sourceStateFingerprint(game: GameState): string {
  return JSON.stringify({
    cursor: game.sourceCursor ?? null,
    progress: game.sourceEventProgress ?? null,
  });
}

function sceneFingerprint(response: StartGameResponse): string {
  return JSON.stringify({
    text: response.scene.text,
    development: response.scene.development,
    choices: response.scene.choices.map((choice) => choice.id),
  });
}

async function normalizedResponse(
  response: StartGameResponse,
): Promise<{ response: StartGameResponse; game: GameState; book: ImportedBook } | null> {
  const game = await getGame(response.gameId);
  if (!game) return null;
  const book = await getBook(game.book.bookId);
  if (!book) return null;
  return {
    response: normalizeSourceBoundaryChoices(response, game, book),
    game,
    book,
  };
}

export async function refreshAutomaticTurnResponse(
  response: StartGameResponse,
): Promise<StartGameResponse> {
  const game = await getGame(response.gameId);
  if (!game) return response;
  // Each continuation is an already committed scene, not temporary accounting.
  // Keep its number/history and retain response-only notices and source metadata.
  return { ...response, ...gameResponse(game) };
}

export async function autoAdvanceSourceContinuations<T>(
  initial: T,
): Promise<T | StartGameResponse> {
  return runWithTurnBudget(() => advanceSourceContinuations(initial));
}

async function advanceSourceContinuations<T>(initial: T): Promise<T | StartGameResponse> {
  if (!isGameResponse(initial)) return initial;

  let automaticHops = 0;
  let current: StartGameResponse = initial;
  let previousSceneFingerprint = "";

  try {
    for (let hop = 0; hop < MAX_AUTOMATIC_SOURCE_HOPS; hop += 1) {
      const normalized = await normalizedResponse(current);
      if (!normalized) break;
      current = normalized.response;

      if (!hasOnlySourceContinuationChoice(current)) break;
      if (nextSourceBeatIsPlayerDecision(normalized.game, normalized.book)) break;

      const budget = currentTurnBudget();
      if (budget && !automaticSourceWindowFitsBudget(normalized.game, normalized.book, budget)) {
        flowDiagnostic('Automatic source continuation paused before the next window to preserve the shared call/token budget; saved progress can resume with the continuation choice.');
        break;
      }

      const beforeSourceState = sourceStateFingerprint(normalized.game);
      const fingerprint = sceneFingerprint(current);
      if (fingerprint === previousSceneFingerprint) break;
      previousSceneFingerprint = fingerprint;

      current = await continueFromSource(current.gameId);
      automaticHops += 1;
      const afterGame = await getGame(current.gameId);
      if (!afterGame) break;
      if (sourceStateFingerprint(afterGame) === beforeSourceState) break;
    }

  } finally {
    if (automaticHops > 0) {
      current = await refreshAutomaticTurnResponse(current);
    }
  }
  if (automaticHops > 0) {
    const normalized = await normalizedResponse(current);
    if (normalized) current = normalized.response;
  }
  return current;
}

