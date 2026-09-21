import type { PlayerAction, SourceEventProgress, StoryEventBeat } from "../../shared/contracts.js";
import { playerControlsBeat } from "../../shared/turn-policy.js";

export interface TurnWindowEvent {
  eventId?: string | null;
  sequence?: number;
  chapterPosition?: number;
  beats?: readonly StoryEventBeat[];
}

export interface TurnBeatOrigin {
  eventId: string | null;
  beatIndex: number;
  chapterPosition?: number;
}

export interface SourceEventEntryMap {
  readonly [eventId: string]: {
    fromEventId: string;
    excerpt: string;
    entryExcerpt: string;
  };
}

function rebaseAction(action: PlayerAction, offset: number): PlayerAction {
  return {
    ...action,
    endBeatIndex: action.endBeatIndex + offset,
    playerBeatIndexes: action.playerBeatIndexes.map((index) => index + offset),
  };
}

function rebaseBeat(beat: StoryEventBeat, offset: number): StoryEventBeat {
  const cloned = structuredClone(beat);
  if (!offset) return cloned;
  return {
    ...cloned,
    ...(cloned.playerAction
      ? { playerAction: rebaseAction(cloned.playerAction, offset) }
      : {}),
    ...(cloned.characterActionGroup
      ? { characterActionGroup: rebaseAction(cloned.characterActionGroup, offset) }
      : {}),
  };
}

function eventOrigin(
  event: TurnWindowEvent | null | undefined,
  beatIndex: number,
): TurnBeatOrigin {
  return {
    eventId: event?.eventId ?? null,
    beatIndex,
    ...(event?.chapterPosition === undefined
      ? {}
      : { chapterPosition: event.chapterPosition }),
  };
}

/**
 * Flatten the current event plus directly-adjacent automatic source events into
 * one turn-local beat window. Event-local indexes are preserved separately in
 * beatOrigins so review can use one ordered script while save/progress remains
 * event-scoped.
 *
 * A sourceEventEntries record represents source-backed transition material that
 * still needs its own bounded entry staging. Never jump across such a boundary.
 */
export function expandCrossEventWindow(input: {
  event?: TurnWindowEvent | null;
  followingEvents?: readonly TurnWindowEvent[];
  sourceEventEntries?: SourceEventEntryMap;
  playerAliases: readonly string[];
  allowCrossEvent: boolean;
}): { beats: StoryEventBeat[]; beatOrigins: TurnBeatOrigin[] } {
  const primary = input.event ?? null;
  const beats = (primary?.beats ?? []).map((beat) => rebaseBeat(beat, 0));
  const beatOrigins = (primary?.beats ?? []).map((_beat, index) =>
    eventOrigin(primary, index)
  );

  if (!input.allowCrossEvent || !primary?.eventId || !primary.beats?.length) {
    return { beats, beatOrigins };
  }

  const ordered = [...(input.followingEvents ?? [])]
    .filter((event) => event.eventId && event.beats?.length)
    .sort((left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER)
      - (right.sequence ?? Number.MAX_SAFE_INTEGER));

  const currentPosition = ordered.findIndex(
    (event) => event.eventId === primary.eventId,
  );
  const candidates = currentPosition >= 0
    ? ordered.slice(currentPosition + 1)
    : ordered.filter((event) =>
        primary.sequence === undefined
        || event.sequence === undefined
        || event.sequence > primary.sequence
      );

  for (const event of candidates) {
    if (!event.eventId || !event.beats?.length) continue;
    if (
      primary.chapterPosition !== undefined
      && event.chapterPosition !== undefined
      && event.chapterPosition !== primary.chapterPosition
    ) {
      break;
    }

    const entry = input.sourceEventEntries?.[event.eventId];
    if (entry) break;
    // Cross-event execution is a staged canonical optimization. Never let a
    // less-complete following event force the whole turn back to legacy scene generation.
    if (event.beats.some((beat) => !beat.resultingState?.trim())) break;
    // Keep the existing staged generator limit; if another whole event would
    // exceed it, leave that event to the normal continuation fallback.
    if (beats.length + event.beats.length > 32) break;

    const offset = beats.length;
    event.beats.forEach((beat, index) => {
      beats.push(rebaseBeat(beat, offset));
      beatOrigins.push(eventOrigin(event, index));
    });

    // Include the whole event so a player-action group can still be resolved,
    // but never plan beyond the first event that contains the next player beat.
    if (event.beats.some((beat) => playerControlsBeat(beat, input.playerAliases))) {
      break;
    }
  }

  return { beats, beatOrigins };
}

export function summarizeAcceptedSourceWindow(input: {
  primaryEventId: string | null;
  primaryStartBeatIndex?: number;
  primaryCompletedBeatIndexes: readonly number[];
  beatOrigins: readonly TurnBeatOrigin[];
  completedFlatBeatIndexes: readonly number[];
  events: readonly TurnWindowEvent[];
}): {
  completedEventIds: string[];
  lastCompletedEventId?: string;
  sourceEventProgress?: SourceEventProgress;
} {
  const eventById = new Map(
    input.events.flatMap((event) =>
      event.eventId ? [[event.eventId, event] as const] : []
    ),
  );
  const completedFlat = new Set(input.completedFlatBeatIndexes);
  const completedByEvent = new Map<string, Set<number>>();

  input.beatOrigins.forEach((origin, flatIndex) => {
    if (!origin.eventId || !completedFlat.has(flatIndex)) return;
    const indexes = completedByEvent.get(origin.eventId) ?? new Set<number>();
    indexes.add(origin.beatIndex);
    completedByEvent.set(origin.eventId, indexes);
  });
  if (input.primaryEventId) {
    const primary = completedByEvent.get(input.primaryEventId) ?? new Set<number>();
    input.primaryCompletedBeatIndexes.forEach((index) => primary.add(index));
    completedByEvent.set(input.primaryEventId, primary);
  }

  const orderedEventIds = [...new Set(
    input.beatOrigins.flatMap((origin) => origin.eventId ? [origin.eventId] : []),
  )];
  const completedEventIds: string[] = [];

  for (const eventId of orderedEventIds) {
    const event = eventById.get(eventId);
    if (!event?.beats?.length) break;
    const start = eventId === input.primaryEventId
      ? input.primaryStartBeatIndex ?? 0
      : 0;
    const completed = [...(completedByEvent.get(eventId) ?? new Set<number>())]
      .filter((index) => index >= start && index < event.beats!.length)
      .sort((left, right) => left - right);
    const required = Array.from(
      { length: Math.max(0, event.beats.length - start) },
      (_value, offset) => start + offset,
    );
    if (required.length > 0 && required.every((index) => completed.includes(index))) {
      completedEventIds.push(eventId);
      continue;
    }
    if (completed.length > 0) {
      return {
        completedEventIds,
        ...(completedEventIds.length > 0
          ? { lastCompletedEventId: completedEventIds.at(-1)! }
          : {}),
        sourceEventProgress: {
          eventId,
          ...(eventId === input.primaryEventId && start > 0
            ? { startBeatIndex: start }
            : {}),
          completedBeatIndexes: completed,
        },
      };
    }
    break;
  }

  return {
    completedEventIds,
    ...(completedEventIds.length > 0
      ? { lastCompletedEventId: completedEventIds.at(-1)! }
      : {}),
  };
}
