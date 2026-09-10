import type {
  BookStoryEvent,
  ImportedBook,
  SourceEventProgress,
  StoryEventBeat,
} from "../../shared/contracts.js";
import {
  canonicalPlayerIdentities,
  normalizedCharacterIdentity,
} from "./game-start.js";

export interface SourceActorAvailabilityState {
  irreversiblyUnavailableCharacterIdentities: readonly string[];
  sourceEventProgress?: SourceEventProgress;
}

export interface SourceActorTakeover {
  beatIndex: number | null;
  fromActor: string;
  toActor: string;
  action?: string;
}

export interface SourceEventActorResolution {
  event: BookStoryEvent;
  takeovers: SourceActorTakeover[];
  invalidatingActors: string[];
}

function uniqueCharacters(characters: readonly string[]): string[] {
  const seen = new Set<string>();
  return characters.filter((character) => {
    const key = normalizedCharacterIdentity(character);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function completedThroughBeatIndex(
  event: BookStoryEvent,
  progress: SourceEventProgress | undefined,
): number {
  if (progress?.eventId !== event.eventId) return -1;
  return progress.completedBeatIndexes
    .filter((index) => Number.isInteger(index) && index >= 0)
    .reduce((latest, index) => Math.max(latest, index), -1);
}

function canonicalPlayerActor(
  book: ImportedBook,
  playerName: string | undefined,
): { actor?: string; identities: Set<string> } {
  if (!playerName?.trim()) return { identities: new Set() };
  const identities = canonicalPlayerIdentities(book, playerName);
  const profile = book.worldBible?.characterProfiles?.find((candidate) =>
    [candidate.name, ...candidate.aliases].some((identity) =>
      identities.has(normalizedCharacterIdentity(identity))
    )
  );
  return {
    actor: profile?.name ?? playerName.trim(),
    identities,
  };
}

function playerScopedStoryEvent(
  event: BookStoryEvent,
  book: ImportedBook,
  playerName: string | undefined,
): BookStoryEvent {
  if (!playerName?.trim()) return event;
  const identities = canonicalPlayerIdentities(book, playerName);
  const profile = book.worldBible?.characterProfiles?.find((candidate) =>
    [candidate.name, ...candidate.aliases].some((identity) =>
      identities.has(normalizedCharacterIdentity(identity))
    )
  );
  return profile?.significantEvents?.find(
    (candidate) => candidate.eventId === event.eventId,
  ) ?? event;
}

function targetPreventsPlayerTakeover(
  target: string,
  unavailableActor: string,
  playerIdentities: ReadonlySet<string>,
): boolean {
  const targetIdentity = normalizedCharacterIdentity(target);
  return playerIdentities.has(targetIdentity)
    || targetIdentity === normalizedCharacterIdentity(unavailableActor);
}

function beatCanBeTakenOverByPlayer(
  beat: StoryEventBeat,
  unavailableActor: string,
  playerIdentities: ReadonlySet<string>,
): boolean {
  // Do not turn an actor->player interaction into a self-targeted action, and
  // do not reinterpret an actor's explicitly self-directed beat as the
  // protagonist doing something to the unavailable actor instead.
  return !beat.targets.some((target) =>
    targetPreventsPlayerTakeover(target, unavailableActor, playerIdentities)
  );
}

/**
 * Resolve the player-specific version of a story event, then adapt still-future
 * source actions when their original actor is permanently unavailable. The
 * protagonist inherits an actor role only when the beat can retain its
 * actor/target direction after reassignment. If that would create a self-targeted
 * or otherwise structurally contradictory beat, the actor remains invalidating
 * and the caller should skip the event.
 *
 * Completed beats are never rewritten: takeover applies only to the remaining
 * future contract of the source event.
 */
export function resolveSourceEventActorTakeover(
  event: BookStoryEvent,
  book: ImportedBook,
  playerName: string | undefined,
  worldState: SourceActorAvailabilityState | undefined,
): SourceEventActorResolution {
  const scopedEvent = playerScopedStoryEvent(event, book, playerName);
  const unavailable = new Set(
    worldState?.irreversiblyUnavailableCharacterIdentities
      .map(normalizedCharacterIdentity) ?? [],
  );
  if (unavailable.size === 0) {
    return { event: scopedEvent, takeovers: [], invalidatingActors: [] };
  }

  const player = canonicalPlayerActor(book, playerName);
  const playerUnavailable = player.actor
    ? unavailable.has(normalizedCharacterIdentity(player.actor))
    : true;
  const completedThrough = completedThroughBeatIndex(
    scopedEvent,
    worldState?.sourceEventProgress,
  );
  const takeovers: SourceActorTakeover[] = [];
  const invalidatingActors = new Set<string>();

  if (scopedEvent.beats?.length) {
    const adaptedBeats = scopedEvent.beats.map((beat, beatIndex) => {
      if (beatIndex <= completedThrough || !beat.actor?.trim()) return beat;
      const actorIdentity = normalizedCharacterIdentity(beat.actor);
      if (!unavailable.has(actorIdentity)) return beat;
      if (
        !player.actor
        || playerUnavailable
        || !beatCanBeTakenOverByPlayer(beat, beat.actor, player.identities)
      ) {
        invalidatingActors.add(beat.actor);
        return beat;
      }
      takeovers.push({
        beatIndex,
        fromActor: beat.actor,
        toActor: player.actor,
        action: beat.action,
      });
      return { ...beat, actor: player.actor };
    });

    if (invalidatingActors.size > 0) {
      return {
        event: scopedEvent,
        takeovers,
        invalidatingActors: [...invalidatingActors],
      };
    }

    const remainingUnavailableActors = new Set(
      scopedEvent.beats
        .slice(Math.max(0, completedThrough + 1))
        .flatMap((beat) => beat.actor ? [normalizedCharacterIdentity(beat.actor)] : [])
        .filter((identity) => unavailable.has(identity)),
    );
    const adaptedActors = uniqueCharacters([
      ...scopedEvent.actors.filter((actor) => {
        const actorIdentity = normalizedCharacterIdentity(actor);
        return !unavailable.has(actorIdentity)
          || !remainingUnavailableActors.has(actorIdentity);
      }),
      ...(takeovers.length > 0 && player.actor ? [player.actor] : []),
    ]);
    return {
      event: {
        ...scopedEvent,
        actors: adaptedActors,
        beats: adaptedBeats,
      },
      takeovers,
      invalidatingActors: [],
    };
  }

  const unavailableActors = scopedEvent.actors.filter((actor) =>
    unavailable.has(normalizedCharacterIdentity(actor))
  );
  if (unavailableActors.length === 0) {
    return { event: scopedEvent, takeovers: [], invalidatingActors: [] };
  }

  for (const actor of unavailableActors) {
    const canTakeOver = Boolean(
      player.actor
      && !playerUnavailable
      && !scopedEvent.targets.some((target) =>
        targetPreventsPlayerTakeover(target, actor, player.identities)
      ),
    );
    if (!canTakeOver || !player.actor) {
      invalidatingActors.add(actor);
      continue;
    }
    takeovers.push({
      beatIndex: null,
      fromActor: actor,
      toActor: player.actor,
    });
  }

  if (invalidatingActors.size > 0) {
    return {
      event: scopedEvent,
      takeovers,
      invalidatingActors: [...invalidatingActors],
    };
  }

  return {
    event: {
      ...scopedEvent,
      actors: uniqueCharacters([
        ...scopedEvent.actors.filter((actor) =>
          !unavailable.has(normalizedCharacterIdentity(actor))
        ),
        ...(takeovers.length > 0 && player.actor ? [player.actor] : []),
      ]),
    },
    takeovers,
    invalidatingActors: [],
  };
}
