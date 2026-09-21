import {ensureDeathLedger} from './engine-access.js';
import { playerControlsBeat } from "../../shared/turn-policy.js";
import { sourceEventEntryEvidence } from './source-event-entry-evidence.js';
import { assertGameSourceVersion } from "../../books/source-index/game-version.js";
import { buildSourceEventChoiceBeatState, nextSignificantEventForCandidate } from "../../ai/engine/source-navigation.js";
import { flowDiagnostic } from "../../util/flow-trace.js";
import {
  addSourceContinuationAnchorChoice,
  findPassageContext,
  SceneGenerationError,
  sourceLineAtNormalizedOffset,
  sourceContinuationChoiceText,
} from "../../ai/engine.js";
import type {
  GeneratedScene,
  SourceContinuationCandidate,
} from "../../ai/engine.js";
import {
  SOURCE_CONTINUATION_CHOICE_ID,
} from "../../shared/contracts.js";
import type {
  BookStoryEvent,
  GameState,
  ImportedBook,
  Scene,
  SourceCursor,
  SourceEventProgress,
  SourceReference,
} from "../../shared/contracts.js";
import {
  sourceReferenceKey,
} from "../../books/source-index/chapter-index.js";
import {
  getBook,
} from "../../books/repository.js";
import {
  gameEngine,
} from "./engine-access.js";
import {
  resolveSourceEventActorTakeover,
} from "./source-event-takeover.js";
import {
  normalizedOffsetThroughSourceLine,
  SOURCE_CONTINUATION_EXCERPT_CHARS,
  SOURCE_EVENT_LOOKAHEAD,
  chapterSummary,
  isKnownNonStoryChapter,
} from "./source-chapter.js";
import {
  canonicalPlayerIdentities,
  canonicalStartCharacters,
  normalizedCharacterIdentity,
} from "./game-start.js";

export interface SourceWorldStateContext {
  irreversiblyUnavailableCharacterIdentities: string[];
  sourceEventProgress?: SourceEventProgress;
}

export function sourceIntroducedCharactersAtCursor(
  book: ImportedBook,
  cursor: SourceCursor | undefined,
): string[] {
  if (!cursor) return [];
  const chapter = book.chapters[cursor.chapterPosition];
  const currentLine = chapter
    ? sourceLineAtNormalizedOffset(chapter.text, cursor.textOffset)
    : 1;
  const cursorEvent = cursor.eventId
    ? book.storyEvents?.find((event) => event.eventId === cursor.eventId)
    : storyEventAtCursor(book, cursor);

  return (book.worldBible?.characterProfiles ?? [])
    .filter((profile) => {
      const identities = new Set(
        [profile.name, ...profile.aliases].map((identity) =>
          identity
            .normalize("NFKD")
            .replace(/[^\p{L}\p{N}]+/gu, "")
            .toLocaleLowerCase("en")
        ),
      );
      const sourceLinkedEvents = (book.storyEvents ?? []).filter((event) =>
        (profile.sourceReferences ?? []).some((profileReference) =>
          event.sourceReferences.some((eventReference) =>
            profileReference.chapterPosition === eventReference.chapterPosition
            && profileReference.lineStart <= eventReference.lineEnd
            && eventReference.lineStart <= profileReference.lineEnd
          )
        )
      );
      const identityLinkedEvents = (book.storyEvents ?? []).filter((event) =>
        [...event.actors, ...event.targets].some((character) =>
          identities.has(
            character
              .normalize("NFKD")
              .replace(/[^\p{L}\p{N}]+/gu, "")
              .toLocaleLowerCase("en"),
          )
        )
      );
      const linkedEvents = sourceLinkedEvents.length > 0
        ? sourceLinkedEvents
        : identityLinkedEvents;
      if (linkedEvents.length > 0) {
        return linkedEvents.some((event) =>
          cursorEvent
            ? event.sequence <= cursorEvent.sequence
            : event.chapterPosition < cursor.chapterPosition
              || (
                event.chapterPosition === cursor.chapterPosition
                && event.sourceReferences.some((reference) => reference.lineStart <= currentLine)
              )
        );
      }

      return (profile.sourceReferences ?? []).some((reference) =>
        reference.chapterPosition < cursor.chapterPosition
        || (
          reference.chapterPosition === cursor.chapterPosition
          && reference.lineStart <= currentLine
        )
      );
    })
    .map((profile) => profile.name);
}

export function normalizeSourceProgress(
  book: ImportedBook,
  sourceProgress: SourceCursor,
): SourceCursor {
  const storyEvent = sourceProgress.eventId
    ? book.storyEvents?.find((event) => event.eventId === sourceProgress.eventId)
    : undefined;
  if (sourceProgress.eventId && book.storyEvents?.length && !storyEvent) {
    const unanchoredProgress = normalizedSourceProgressForEvent(book, {
      chapterPosition: sourceProgress.chapterPosition,
      textOffset: sourceProgress.textOffset,
    });
    const inferredStoryEvent = storyEventAtCursor(book, sourceProgress);
    if (!inferredStoryEvent) return unanchoredProgress;
    const remappedProgress = normalizedSourceProgressForEvent(
      book,
      {
        ...sourceProgress,
        eventId: inferredStoryEvent.eventId,
      },
      inferredStoryEvent,
    );
    return sourceCursorPrecedes(remappedProgress, unanchoredProgress)
      ? unanchoredProgress
      : remappedProgress;
  }
  return normalizedSourceProgressForEvent(book, sourceProgress, storyEvent);
}

function normalizedSourceProgressForEvent(
  book: ImportedBook,
  sourceProgress: SourceCursor,
  storyEvent?: BookStoryEvent,
): SourceCursor {
  const chapterPosition = storyEvent?.chapterPosition ?? sourceProgress.chapterPosition;
  const chapter = book.chapters[chapterPosition];
  if (!chapter) return sourceProgress;
  const eventLineEnd = storyEvent?.sourceReferences
    .filter((reference) => reference.chapterPosition === chapterPosition)
    .reduce((maximum, reference) => Math.max(maximum, reference.lineEnd), 0);
  const textOffset = eventLineEnd
    ? normalizedOffsetThroughSourceLine(chapter.text, eventLineEnd)
    : sourceProgress.textOffset;
  const normalizedLength = chapter.text.replace(/\s+/g, " ").length;
  return textOffset >= normalizedLength
    ? {
        chapterPosition: chapterPosition + 1,
        textOffset: 0,
        ...(sourceProgress.eventId ? { eventId: sourceProgress.eventId } : {}),
      }
    : {
        ...sourceProgress,
        chapterPosition,
        textOffset,
      };
}

function sourceCursorPrecedes(
  left: Pick<SourceCursor, "chapterPosition" | "textOffset">,
  right: Pick<SourceCursor, "chapterPosition" | "textOffset">,
): boolean {
  return left.chapterPosition < right.chapterPosition
    || (
      left.chapterPosition === right.chapterPosition
      && left.textOffset < right.textOffset
    );
}

export function missingPresentSourceEventCharacters(
  game: Pick<GameState, "playerName" | "scene"> & Partial<Pick<GameState, "sourceEventProgress">>,
  book: ImportedBook,
  candidate: SourceContinuationCandidate,
): string[] {
  // Only the immediate remaining beat can require participants now. Whole-event
  // actors include people who already left and people who have yet to arrive.
  const event = nextSignificantEventForCandidate(candidate);
  const nextBeat = buildSourceEventChoiceBeatState(event, game.sourceEventProgress).remainingEvent?.beats?.[0];
  const actors = nextBeat ? (nextBeat.actor ? [nextBeat.actor] : []) : candidate.requiredEventActors
    ?? candidate.storyEvents?.[0]?.actors
    ?? [];
  const playerIdentities = canonicalPlayerIdentities(book, game.playerName);
  if (!actors.some((actor) => playerIdentities.has(normalizedCharacterIdentity(actor)))) {
    return [];
  }

  // Automatic discovery/arrival establishes presence; it is not a player-choice prerequisite.
  if (nextBeat && !playerControlsBeat(nextBeat, [...playerIdentities])) return [];

  const knownCharacters = new Map(
    canonicalStartCharacters(book).map((character) => [
      normalizedCharacterIdentity(character),
      character,
    ]),
  );
  const presentCharacters = new Set(
    (game.scene.sceneScope?.peoplePresent ?? []).map(normalizedCharacterIdentity),
  );
  const coActors = actors.filter(
    (actor) => !playerIdentities.has(normalizedCharacterIdentity(actor)),
  );
  const directTargets = nextBeat ? nextBeat.targets : candidate.requiredEventCategory === "arrival"
      || candidate.requiredEventCategory === "departure"
    ? []
    : candidate.requiredEventTargets
      ?? candidate.storyEvents?.[0]?.targets
      ?? [];

  return [...new Set([...coActors, ...directTargets].map(normalizedCharacterIdentity))]
    .filter((identity) =>
      !playerIdentities.has(identity)
      && knownCharacters.has(identity)
      && !presentCharacters.has(identity)
    )
    .map((identity) => knownCharacters.get(identity)!)
    .filter(Boolean);
}

function addProfileIdentityKeys(
  target: Set<string>,
  book: ImportedBook,
  identity: string,
): void {
  const normalizedIdentity = normalizedCharacterIdentity(identity);
  const profile = book.worldBible?.characterProfiles?.find((candidate) =>
    [candidate.name, ...candidate.aliases].some(
      (candidateIdentity) =>
        normalizedCharacterIdentity(candidateIdentity) === normalizedIdentity,
    )
  );
  for (const candidateIdentity of profile
    ? [profile.name, ...profile.aliases]
    : [identity]) {
    target.add(normalizedCharacterIdentity(candidateIdentity));
  }
}

export function sourceWorldStateForGame(
  game: GameState,
  book: ImportedBook,
  cursor: SourceCursor,
): SourceWorldStateContext {
  const unavailable = new Set<string>();
  for (const name of game.confirmedDeadCharacters ?? []) addProfileIdentityKeys(unavailable, book, name);
  if (game.establishedEvent?.category === "death" && game.establishedEvent.target.trim()) {
    addProfileIdentityKeys(unavailable, book, game.establishedEvent.target);
  }


  return {
    irreversiblyUnavailableCharacterIdentities: [...unavailable],
    ...(game.sourceEventProgress
      ? { sourceEventProgress: game.sourceEventProgress }
      : {}),
  };
}

export function sourceEventInvalidatingActors(
  event: Pick<BookStoryEvent, "eventId" | "actors"> & Partial<Pick<BookStoryEvent, "beats">>,
  worldState: SourceWorldStateContext | undefined,
): string[] {
  const unavailable = new Set(
    worldState?.irreversiblyUnavailableCharacterIdentities
      .map(normalizedCharacterIdentity) ?? [],
  );
  if (unavailable.size === 0) return [];

  const progress = worldState?.sourceEventProgress?.eventId === event.eventId
    ? worldState.sourceEventProgress
    : undefined;
  const completedThroughIndex = progress?.completedBeatIndexes.length
    ? Math.max(...progress.completedBeatIndexes.filter((index) => Number.isInteger(index)))
    : (progress?.startBeatIndex ?? 0) - 1;
  const remainingBeatActors = event.beats?.length
    ? event.beats
      .slice(Math.max(0, completedThroughIndex + 1))
      .flatMap((beat) => beat.actor?.trim() ? [beat.actor] : [])
    : [];
  const requiredActors = event.beats?.length
    ? remainingBeatActors
    : event.actors;

  return [...new Set(requiredActors.filter((actor) =>
    unavailable.has(normalizedCharacterIdentity(actor))
  ))];
}

export function sourceEventInvalidatedByWorldState(
  event: Pick<BookStoryEvent, "eventId" | "actors"> & Partial<Pick<BookStoryEvent, "beats">>,
  worldState: SourceWorldStateContext | undefined,
): boolean {
  return sourceEventInvalidatingActors(event, worldState).length > 0;
}

export function refreshCanonicalFirstChoice(
  scene: Scene,
  book: ImportedBook,
  cursor: SourceCursor,
  playerName?: string,
  confirmedDeadCharacters: readonly string[] = [],
): Scene {
  if ((scene.outcome ?? "active") !== "active") return scene;
  const deadCharacters = new Set<string>();
  for (const name of [...confirmedDeadCharacters, ...(scene.peopleKilledInScene ?? [])]) addProfileIdentityKeys(deadCharacters, book, name);
  const availableScene = {
    ...scene,
    choices: scene.choices.filter((choice) =>
      choice.type !== "talk"
      || !choice.character
      || !deadCharacters.has(normalizedCharacterIdentity(choice.character))
    ),
  };
  const candidate = buildSourceContextCandidates(
    book,
    cursor,
    playerName,
  )[0];
  if (
    availableScene.choices.length >= 2
    && availableScene.choices[0]?.id !== SOURCE_CONTINUATION_CHOICE_ID
  ) {
    return availableScene;
  }
  const continuationText = sourceContinuationChoiceText(candidate);
  if (
    availableScene.choices.length === 1
    && availableScene.choices[0]?.id !== SOURCE_CONTINUATION_CHOICE_ID
  ) {
    return {
      ...availableScene,
      choices: [
        ...availableScene.choices,
        {
          id: SOURCE_CONTINUATION_CHOICE_ID,
          type: "action",
          text: continuationText,
          stakes: "significant",
        },
      ],
    };
  }
  return addSourceContinuationAnchorChoice(
    availableScene,
    continuationText,
  );
}

export async function sourceContextForGame(
  game: GameState,
  sourceEventId?: string,
): Promise<{ book?: ImportedBook; candidates: SourceContinuationCandidate[] }> {
  const book = await getBook(game.book.bookId);
  if (!book) return { candidates: [] };
  assertGameSourceVersion(game, book);
  const passage = findPassageContext(book, game.selectedText);
  const cursor = normalizeSourceProgress(book, game.sourceCursor ?? {
    chapterPosition: passage.chapterPosition ?? game.position?.chapterIndex ?? 0,
    textOffset: passage.passageEnd ?? 0,
  });
  if (game.sourceCursor) game.sourceCursor = cursor;
  await ensureDeathLedger(game);
  const candidate = buildCanonicalNextEventCandidate(book, cursor, game.playerName,
    sourceWorldStateForGame(game, book, cursor));
  if (sourceEventId) {
    const exact = candidate?.requiredEventId === sourceEventId ? candidate : sourceCandidateForKnownEvent(book, game, sourceEventId);
    // Never reinterpret a selected canonical choice as a different source event.
    return {book, candidates: exact ? [exact] : []};
  }
  return {book, candidates: candidate ? [candidate] : []};
}

export function candidateStoryEvents(
  book: ImportedBook,
  chapterPosition: number,
  cursor?: SourceCursor,
): NonNullable<SourceContinuationCandidate["storyEvents"]> {
  const cursorEvent = cursor?.eventId
    ? book.storyEvents?.find((event) => event.eventId === cursor.eventId)
    : undefined;
  const cursorLine = cursor && cursor.chapterPosition === chapterPosition
    ? sourceLineAtNormalizedOffset(
        book.chapters[chapterPosition]?.text ?? "",
        cursor.textOffset,
      )
    : 0;
  const events = (book.storyEvents ?? [])
    .filter((event) =>
      event.chapterPosition === chapterPosition
      && (
        cursorEvent
          ? event.sequence > cursorEvent.sequence
          : event.sourceReferences.some((reference) => reference.lineEnd >= cursorLine)
      )
    );
  return events.slice(0, SOURCE_EVENT_LOOKAHEAD).map(sourceCandidateStoryEvent);
}

function sourceCandidateStoryEvent(
  event: BookStoryEvent,
): NonNullable<SourceContinuationCandidate["storyEvents"]>[number] {
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    description: event.description,
    category: event.category,
    chapterPosition: event.chapterPosition,
    actors: event.actors,
    targets: event.targets,
    ...(event.beats ? { beats: event.beats } : {}),
  };
}

function sourceReferenceExcerpt(
  book: Pick<ImportedBook, "chapters">,
  reference: SourceReference,
): string {
  const chapter = book.chapters[reference.chapterPosition];
  const lines = chapter?.text.trim().split(/\r?\n/);
  if (
    !chapter
    || chapter.index !== reference.chapterIndex
    || !Number.isInteger(reference.lineStart)
    || !Number.isInteger(reference.lineEnd)
    || reference.lineStart < 1
    || reference.lineStart > reference.lineEnd
    || !lines
    || reference.lineEnd > lines.length
  ) {
    throw new Error(`Cannot extract invalid beat source reference: ${JSON.stringify(reference)}`);
  }
  return lines.slice(reference.lineStart - 1, reference.lineEnd).join("\n");
}

function sourceReferenceExcerptsForEvents(
  book: Pick<ImportedBook, "chapters">,
  events: readonly (
    Pick<BookStoryEvent, "beats">
    | undefined
  )[],
): Readonly<Record<string, string>> | undefined {
  const excerpts: Record<string, string> = {};
  for (const event of events) {
    for (const beat of event?.beats ?? []) {
      for (const reference of beat.sourceReferences) {
        const key = sourceReferenceKey(reference);
        excerpts[key] ??= sourceReferenceExcerpt(book, reference);
      }
    }
  }
  return Object.keys(excerpts).length > 0 ? excerpts : undefined;
}

export function chapterTimelineSummary(
  book: ImportedBook,
  chapterPosition: number,
  cursor?: SourceCursor,
): string {
  const events = candidateStoryEvents(book, chapterPosition, cursor);
  return events.length > 0
    ? events.map((event) => event.description).join(" ")
    : chapterSummary(book.chapters[chapterPosition]!);
}

export function storyEventCandidateContext(
  book: ImportedBook,
  chapterPosition: number,
  cursor?: SourceCursor,
): Pick<
  SourceContinuationCandidate,
  "storyEvents" | "currentStoryEvent" | "sourceReferenceExcerpts" | "sourceEventEntries"
> {
  const storyEvents = candidateStoryEvents(book, chapterPosition, cursor);
  const currentStoryEvent = cursor
    ? (
        cursor.eventId
          ? book.storyEvents?.find((event) => event.eventId === cursor.eventId)
          : storyEventAtCursor(book, cursor)
      )
    : undefined;
  const sourceReferenceExcerpts = sourceReferenceExcerptsForEvents(
    book,
    [...storyEvents, currentStoryEvent],
  );
  const sourceEventEntries = sourceEventEntryEvidence(book, storyEvents.map(event => event.eventId));
  return {
    ...(storyEvents.length > 0 ? { storyEvents } : {}),
    ...(Object.keys(sourceEventEntries).length ? {sourceEventEntries} : {}),
    ...(currentStoryEvent
      ? {
          currentStoryEvent: sourceCandidateStoryEvent(currentStoryEvent),
        }
      : {}),
    ...(sourceReferenceExcerpts ? { sourceReferenceExcerpts } : {}),
  };
}

export function storyEventAtCursor(
  book: ImportedBook,
  cursor: SourceCursor,
): BookStoryEvent | undefined {
  const line = sourceLineAtNormalizedOffset(
    book.chapters[cursor.chapterPosition]?.text ?? "",
    cursor.textOffset,
  );
  return book.storyEvents
    ?.filter((event) =>
      event.chapterPosition < cursor.chapterPosition
      || (
        event.chapterPosition === cursor.chapterPosition
        && event.sourceReferences.some((reference) => reference.lineEnd <= line)
      )
    )
    .at(-1);
}

export function buildSourceContinuationCandidates(
  book: ImportedBook,
  cursor: SourceCursor,
): SourceContinuationCandidate[] {
  const candidates: SourceContinuationCandidate[] = [];
  const lastChapterPosition = Math.min(
    book.chapters.length - 1,
    cursor.chapterPosition + 10,
  );
  for (
    let chapterPosition = cursor.chapterPosition;
    chapterPosition <= lastChapterPosition;
    chapterPosition += 1
  ) {
    const chapter = book.chapters[chapterPosition]!;
    if (isKnownNonStoryChapter(chapter)) continue;
    const normalizedText = chapter.text.replace(/\s+/g, " ");
    const textOffset = chapterPosition === cursor.chapterPosition
      ? Math.min(cursor.textOffset, normalizedText.length)
      : 0;
    if (textOffset >= normalizedText.length) continue;
    const nextTextOffset = Math.min(
      normalizedText.length,
      textOffset + SOURCE_CONTINUATION_EXCERPT_CHARS,
    );
    candidates.push({
      chapterPosition,
      chapterTitle: chapter.title,
      summary: chapterTimelineSummary(book, chapterPosition, cursor),
      chapterSummary: chapterSummary(chapter),
      ...storyEventCandidateContext(book, chapterPosition, cursor),
      excerpt: normalizedText.slice(textOffset, nextTextOffset),
      nextTextOffset,
    });
  }
  return candidates;
}

export function buildSourceRecoveryCandidates(
  book: ImportedBook,
): SourceContinuationCandidate[] {
  const storyChapterPositions = book.chapters.flatMap((chapter, chapterPosition) =>
    isKnownNonStoryChapter(chapter) ? [] : [chapterPosition]
  );
  return storyChapterPositions.flatMap((chapterPosition, storyIndex) => {
    const chapter = book.chapters[chapterPosition]!;
    const summary = chapterTimelineSummary(book, chapterPosition);
    if (!summary) return [];

    const normalizedText = chapter.text.replace(/\s+/g, " ");
    if (!normalizedText.trim()) return [];
    const nextTextOffset = Math.min(
      normalizedText.length,
      SOURCE_CONTINUATION_EXCERPT_CHARS,
    );
    let contextStart = Math.max(0, storyIndex - 2);
    const contextEnd = Math.min(storyChapterPositions.length, contextStart + 5);
    contextStart = Math.max(0, contextEnd - 5);
    const surroundingContext = storyChapterPositions
      .slice(contextStart, contextEnd)
      .filter((surroundingPosition) => surroundingPosition !== chapterPosition)
      .map((surroundingPosition) => {
        const surroundingChapter = book.chapters[surroundingPosition]!;
        return (
        `Chapter ${surroundingPosition + 1}, ${surroundingChapter.title}: `
        + `${chapterTimelineSummary(book, surroundingPosition)}\n`
        + surroundingChapter.text.replace(/\s+/g, " ").slice(0, 1_500)
        );
      })
      .join("\n\n");
    return [{
      chapterPosition,
      chapterTitle: chapter.title,
      summary,
      chapterSummary: chapterSummary(chapter),
      ...storyEventCandidateContext(book, chapterPosition),
      excerpt: normalizedText.slice(0, nextTextOffset),
      ...(surroundingContext ? { surroundingContext } : {}),
      nextTextOffset,
      recovery: true,
    }];
  });
}

export function buildFutureSourceCandidates(
  book: ImportedBook,
  cursor: SourceCursor,
): SourceContinuationCandidate[] {
  const firstChapterPosition = cursor.textOffset > 0
    ? cursor.chapterPosition + 1
    : cursor.chapterPosition;
  return book.chapters.flatMap((chapter, chapterPosition) => {
    if (chapterPosition < firstChapterPosition || isKnownNonStoryChapter(chapter)) {
      return [];
    }

    const normalizedText = chapter.text.replace(/\s+/g, " ");
    if (!normalizedText.trim()) return [];
    const nextTextOffset = Math.min(
      normalizedText.length,
      SOURCE_CONTINUATION_EXCERPT_CHARS,
    );
    return [{
      chapterPosition,
      chapterTitle: chapter.title,
      summary: chapterTimelineSummary(book, chapterPosition, cursor),
      chapterSummary: chapterSummary(chapter),
      ...storyEventCandidateContext(book, chapterPosition, cursor),
      excerpt: normalizedText.slice(0, nextTextOffset),
      nextTextOffset,
    }];
  });
}

export function buildSourceAnchorCandidates(
  book: ImportedBook,
  cursor: SourceCursor,
): SourceContinuationCandidate[] {
  const candidatesByChapter = new Map<number, SourceContinuationCandidate>();
  for (const candidate of [
    ...buildSourceContinuationCandidates(book, cursor),
    ...buildFutureSourceCandidates(book, cursor),
  ]) {
    if (!candidatesByChapter.has(candidate.chapterPosition)) {
      candidatesByChapter.set(candidate.chapterPosition, candidate);
    }
  }
  return [...candidatesByChapter.values()];
}

export function buildSourceContextCandidates(
  book: ImportedBook,
  cursor: SourceCursor,
  playerName?: string,
  worldState?: SourceWorldStateContext,
): SourceContinuationCandidate[] {
  const canonicalCandidate = buildCanonicalNextEventCandidate(
    book,
    cursor,
    playerName,
    worldState,
  );
  if (canonicalCandidate) {
    return [canonicalCandidate];
  }
  if (playerName && hasCanonicalPlayerTimeline(book, playerName)) {
    return [];
  }
  return buildSourceAnchorCandidates(book, cursor);
}

function playerRelevantEventIds(
  book: ImportedBook,
  playerName: string,
): Set<string> {
  const playerIdentities = canonicalPlayerIdentities(book, playerName);
  const playerProfile = book.worldBible?.characterProfiles?.find((profile) =>
    [profile.name, ...profile.aliases].some((identity) =>
      playerIdentities.has(normalizedCharacterIdentity(identity))
    )
  );
  return new Set([
    ...(playerProfile?.significantEvents ?? []).map((event) => event.eventId),
    ...(book.storyEvents ?? [])
      .filter((event) =>
        [...event.actors, ...event.targets].some((identity) =>
          playerIdentities.has(normalizedCharacterIdentity(identity))
        )
      )
      .map((event) => event.eventId),
  ]);
}

export function hasCanonicalPlayerTimeline(
  book: ImportedBook,
  playerName: string,
): boolean {
  return playerRelevantEventIds(book, playerName).size > 0;
}

const CANONICAL_DECISION_LOOKAHEAD_MAX = 8;

/**
 * Keep ordinary source context compact, but for a player-specific canonical
 * route look through automatic/NPC events until the first later event that
 * contains a meaningful player-controlled beat. This gives the turn planner
 * enough indexed material to build one cross-event execution window.
 *
 * Explicit source-entry gaps, legacy events without beats, chapter changes and
 * the hard cap remain batching boundaries. The boundary event itself stays in
 * context so the existing entry/menu flow can take over safely.
 */
function canonicalDecisionLookahead(
  book: ImportedBook,
  events: readonly BookStoryEvent[],
  playerName?: string,
): BookStoryEvent[] {
  if (!playerName || events.length <= SOURCE_EVENT_LOOKAHEAD || !events[0]?.beats?.length) {
    return events.slice(0, SOURCE_EVENT_LOOKAHEAD);
  }
  const aliases = [...canonicalPlayerIdentities(book, playerName)];
  const bounded = events.slice(0, CANONICAL_DECISION_LOOKAHEAD_MAX);
  const entries = sourceEventEntryEvidence(book, bounded.map((event) => event.eventId));
  const firstChapter = bounded[0]?.chapterPosition;
  const selected: BookStoryEvent[] = [];

  for (const [index, event] of bounded.entries()) {
    selected.push(event);
    if (index === 0) continue;
    if (event.chapterPosition !== firstChapter) break;
    if (entries[event.eventId]) break;
    if (!event.beats?.length) break;
    if (event.beats.some((beat) => playerControlsBeat(beat, aliases))) break;
  }
  return selected;
}

export function buildCanonicalNextEventCandidate(
  book: ImportedBook,
  cursor: SourceCursor,
  playerName?: string,
  worldState?: SourceWorldStateContext,
): SourceContinuationCandidate | undefined {
  const orderedEvents = [...(book.storyEvents ?? [])]
    .sort((left, right) => left.sequence - right.sequence);
  const progress = worldState?.sourceEventProgress;
  const pendingEvent = progress ? orderedEvents.find(event => event.eventId === progress.eventId
    && event.beats?.some((_beat, index) => index >= (progress.startBeatIndex ?? 0) && !progress.completedBeatIndexes.includes(index))) : undefined;
  // A text offset inside an event locates the passage; it does not prove the event was played.
  // Stored beat progress is authoritative until its remaining suffix is complete.
  const currentEvent = (
    cursor.eventId
      ? orderedEvents.find((event) => event.eventId === cursor.eventId)
      : undefined
  ) ?? storyEventAtCursor(book, cursor);
  const relevantEventIds = playerName
    ? playerRelevantEventIds(book, playerName)
    : undefined;
  const relevantEvents = relevantEventIds?.size
    ? orderedEvents.filter((event) =>
        event.eventId === pendingEvent?.eventId
        || relevantEventIds.has(event.eventId)
        || sourceEventInvalidatingActors(event, worldState).length > 0
      )
    : orderedEvents;
  const cursorLine = sourceLineAtNormalizedOffset(
    book.chapters[cursor.chapterPosition]?.text ?? "",
    cursor.textOffset,
  );
  const futureEvents = relevantEvents.filter((event) =>
    pendingEvent
      ? event.sequence >= pendingEvent.sequence
      : currentEvent
      ? event.sequence > currentEvent.sequence
      : event.chapterPosition > cursor.chapterPosition
        || (
          event.chapterPosition === cursor.chapterPosition
          && (
            event.sourceReferences.length === 0
            || event.sourceReferences.some((reference) => reference.lineEnd >= cursorLine)
          )
        )
  );
  const compatibleFutureEvents = futureEvents.flatMap((event) => {
    const resolution = resolveSourceEventActorTakeover(
      event,
      book,
      playerName,
      worldState,
    );
    if (resolution.invalidatingActors.length > 0) {
      flowDiagnostic(
        "BookRPG source event invalidated by interactive world state: "
        + JSON.stringify({
          status: "invalidated",
          event_id: event.eventId,
          event_description: event.description,
          unavailable_required_actors: resolution.invalidatingActors,
          takeover_attempted: resolution.takeovers.length > 0,
        }),
      );
      return [];
    }
    if (resolution.takeovers.length > 0) {
      flowDiagnostic(
        "BookRPG source event adapted to player takeover: "
        + JSON.stringify({
          status: "adapted",
          event_id: event.eventId,
          event_description: event.description,
          actor_takeovers: resolution.takeovers,
        }),
      );
    }
    return [resolution.event];
  });
  const nextEvent = compatibleFutureEvents[0];
  if (!nextEvent) return undefined;

  const chapter = book.chapters[nextEvent.chapterPosition];
  if (!chapter || isKnownNonStoryChapter(chapter)) return undefined;
  const normalizedText = chapter.text.replace(/\s+/g, " ");
  const references = nextEvent.sourceReferences.filter(
    (reference) => reference.chapterPosition === nextEvent.chapterPosition,
  );
  const lineStart = references.length > 0
    ? Math.min(...references.map((reference) => reference.lineStart))
    : 1;
  const lineEnd = references.length > 0
    ? Math.max(...references.map((reference) => reference.lineEnd))
    : lineStart;
  const excerptStart = references.length > 0
    ? normalizedOffsetThroughSourceLine(chapter.text, lineStart - 1)
    : nextEvent.chapterPosition === cursor.chapterPosition
      ? Math.min(cursor.textOffset, normalizedText.length)
      : 0;
  const nextTextOffset = references.length > 0
    ? normalizedOffsetThroughSourceLine(chapter.text, lineEnd)
    : Math.min(normalizedText.length, excerptStart + SOURCE_CONTINUATION_EXCERPT_CHARS);
  const lookaheadSourceEvents = canonicalDecisionLookahead(
    book,
    compatibleFutureEvents,
    playerName,
  );
  const lookaheadEvents = lookaheadSourceEvents.map(sourceCandidateStoryEvent);
  const summary = lookaheadEvents.map((event) => event.description).join(" ");
  const sourceReferenceExcerpts = sourceReferenceExcerptsForEvents(
    book,
    [...lookaheadSourceEvents, currentEvent],
  );

  return {
    chapterPosition: nextEvent.chapterPosition,
    chapterTitle: chapter.title,
    summary,
    chapterSummary: summary,
    excerpt: normalizedText.slice(excerptStart, nextTextOffset).trim(),
    requiredEvent: nextEvent.description,
    requiredEventId: nextEvent.eventId,
    requiredEventCategory: nextEvent.category,
    requiredEventActors: nextEvent.actors,
    requiredEventTargets: nextEvent.targets,
    ...(nextEvent.beats ? { requiredEventBeats: nextEvent.beats } : {}),
    ...(currentEvent
      ? { currentStoryEvent: sourceCandidateStoryEvent(currentEvent) }
      : {}),
    storyEvents: lookaheadEvents,
    sourceEventEntries: sourceEventEntryEvidence(book, lookaheadEvents.map(event => event.eventId)),
    ...(sourceReferenceExcerpts ? { sourceReferenceExcerpts } : {}),
    nextTextOffset,
  };
}

export function buildSceneRecoveryCandidates(
  book: ImportedBook,
  cursor: SourceCursor,
  rejectedAnchorPosition?: number,
): SourceContinuationCandidate[] {
  const laterCandidates = rejectedAnchorPosition === undefined
    ? []
    : buildFutureSourceCandidates(book, cursor)
        .filter((candidate) => candidate.chapterPosition > rejectedAnchorPosition)
        .map((candidate) => ({ ...candidate, recovery: true as const }));
  if (laterCandidates.length > 0) return laterCandidates;

  return buildSourceRecoveryCandidates(book).filter(
    (candidate) =>
      rejectedAnchorPosition === undefined
      || candidate.chapterPosition >= rejectedAnchorPosition,
  );
}

export function alignRecoveryCandidateToCursor(
  book: ImportedBook,
  candidate: SourceContinuationCandidate,
  cursor: SourceCursor,
): SourceContinuationCandidate {
  if (candidate.chapterPosition !== cursor.chapterPosition) return candidate;
  const chapter = book.chapters[candidate.chapterPosition];
  if (!chapter) return candidate;
  const normalizedText = chapter.text.replace(/\s+/g, " ");
  const textOffset = Math.min(cursor.textOffset, normalizedText.length);
  const nextTextOffset = Math.min(
    normalizedText.length,
    textOffset + SOURCE_CONTINUATION_EXCERPT_CHARS,
  );
  return {
    ...candidate,
    excerpt: normalizedText.slice(textOffset, nextTextOffset),
    nextTextOffset,
  };
}

export async function selectGroundedSourceCandidates(
  game: GameState,
  book: ImportedBook,
  cursor: SourceCursor,
  candidates: readonly SourceContinuationCandidate[],
  sourceEventId?: string,
): Promise<SourceContinuationCandidate[]> {
  if (candidates.length === 0) return [];
  const resolvedSourceEventId = sourceEventId && book.storyEvents?.length
    ? book.storyEvents.some((event) => event.eventId === sourceEventId)
      ? sourceEventId
      : undefined
    : sourceEventId;
  const selectedCandidate = resolvedSourceEventId
    ? sourceCandidateForEvent(candidates, resolvedSourceEventId)
    : candidates.length === 1
      ? candidates[0]
      : await gameEngine().selectSourceCandidate(game, candidates);
  if (!selectedCandidate) return [];

  const alignedCandidate = selectedCandidate.recovery
    ? alignRecoveryCandidateToCursor(book, selectedCandidate, cursor)
    : selectedCandidate;
  if (
    alignedCandidate.requiredEventId
    && alignedCandidate.requiredEvent?.trim()
    && (
      !resolvedSourceEventId
      || alignedCandidate.requiredEventId === resolvedSourceEventId
    )
  ) {
    return [alignedCandidate];
  }
  const targetEvent = resolvedSourceEventId
    ? alignedCandidate.storyEvents?.find(
        (event) => event.eventId === resolvedSourceEventId,
      )
    : undefined;
  const eventCandidate = await gameEngine().selectSourceEvent(
    game,
    targetEvent
      ? { ...alignedCandidate, storyEvents: [targetEvent] }
      : alignedCandidate,
  );
  if (!eventCandidate) return [];
  if (eventCandidate.recovery) return [eventCandidate];

  return [eventCandidate];
}

export function sourceCandidateForEvent(
  candidates: readonly SourceContinuationCandidate[],
  sourceEventId: string,
): SourceContinuationCandidate | undefined {
  return candidates.find((candidate) =>
    candidate.requiredEventId === sourceEventId
    || candidate.storyEvents?.some((event) => event.eventId === sourceEventId)
  );
}

export async function generateWithSourceContext(
  game: GameState,
  generate: (
    candidates: readonly SourceContinuationCandidate[],
  ) => Promise<GeneratedScene>,
  sourceEventId?: string,
): Promise<GeneratedScene> {
  const { candidates } = await sourceContextForGame(game, sourceEventId);
  return generate(candidates);
}

export async function attemptSourceContinuation<T>(
  generate: () => Promise<T>,
  onRejected?: (error: SceneGenerationError) => void,
): Promise<T | undefined> {
  try {
    return await generate();
  } catch (error) {
    if (!(error instanceof SceneGenerationError)) throw error;
    flowDiagnostic(error.message);
    onRejected?.(error);
    return undefined;
  }
}


/** Exact ID lookup for a previously planned bridge. Never invokes AI discovery.
 *
 * The selected event stays pinned as requiredEvent, but the staged canonical
 * engine still needs the same bounded lookahead as ordinary canonical play.
 * Otherwise a bridge that completes its target event reaches an artificial
 * end-of-window and cannot expose the next intentional player decision.
 */
export function sourceCandidateForKnownEvent(book: ImportedBook, game: GameState, eventId: string): SourceContinuationCandidate | undefined {
  const orderedEvents = [...(book.storyEvents ?? [])].sort((left, right) => left.sequence - right.sequence);
  const event = orderedEvents.find(e => e.eventId === eventId);
  if (!event) return undefined;
  assertGameSourceVersion(game, book);
  const cursor = game.sourceCursor ?? {chapterPosition: 0, textOffset: 0};
  const previous = orderedEvents.find(e => e.eventId === cursor.eventId);
  if (previous && event.sequence <= previous.sequence && game.sourceEventProgress?.eventId !== eventId) return undefined;
  const worldState = sourceWorldStateForGame(game, book, cursor);
  if (sourceEventInvalidatingActors(event, worldState).length) return undefined;
  const chapter = book.chapters[event.chapterPosition];
  if (!chapter) return undefined;
  const refs = event.sourceReferences.filter(r => r.chapterPosition === event.chapterPosition);
  if (!refs.length) return undefined;
  const start = Math.min(...refs.map(r => r.lineStart));
  const end = Math.max(...refs.map(r => r.lineEnd));

  const relevantEventIds = playerRelevantEventIds(book, game.playerName);
  const laterCompatibleEvents = orderedEvents
    .filter(candidate => candidate.sequence > event.sequence)
    .filter(candidate =>
      relevantEventIds.has(candidate.eventId)
      || sourceEventInvalidatingActors(candidate, worldState).length > 0
    )
    .flatMap(candidate => {
      const resolution = resolveSourceEventActorTakeover(candidate, book, game.playerName, worldState);
      return resolution.invalidatingActors.length > 0 ? [] : [resolution.event];
    });
  const lookaheadSourceEvents = canonicalDecisionLookahead(
    book,
    [event, ...laterCompatibleEvents],
    game.playerName,
  );
  const lookaheadEvents = lookaheadSourceEvents.map(sourceCandidateStoryEvent);
  const sourceReferenceExcerpts = sourceReferenceExcerptsForEvents(book, lookaheadSourceEvents);

  return {chapterPosition: event.chapterPosition, chapterTitle: chapter.title,
    summary: lookaheadEvents.map(candidate => candidate.description).join(' '),
    excerpt: chapter.text.trim().split(/\r?\n/).slice(start - 1, end).join('\n'),
    nextTextOffset: normalizedOffsetThroughSourceLine(chapter.text, end),
    requiredEvent: event.description, requiredEventId: event.eventId,
    requiredEventCategory: event.category, requiredEventActors: event.actors, requiredEventTargets: event.targets,
    requiredEventBeats: event.beats, storyEvents: lookaheadEvents,
    sourceEventEntries: sourceEventEntryEvidence(book, lookaheadEvents.map(candidate => candidate.eventId)),
    ...(sourceReferenceExcerpts ? {sourceReferenceExcerpts} : {})};
}
