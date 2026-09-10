import { flowDiagnostic } from "../../util/flow-trace.js";
import type {
  BookStoryEvent,
  SceneScope,
  CharacterProfile,
  GameChoice,
  SourceAnchorRoute,
  SourceEventProgress,
  StoryEventBeat,
} from "../../shared/contracts.js";
import type {
  SourceContinuationCandidate,
} from "./core.js";
import {
  findPlayerCharacterProfile,
} from "./player.js";
import {
  normalizedScopeIdentity,
} from "./scene-text.js";

export function visibleSourceEventNarrative(
  candidates: readonly SourceContinuationCandidate[],
): string {
  return candidates
    .flatMap((candidate) =>
      candidate.currentStoryEvent ? [candidate.currentStoryEvent.description] : []
    )
    .filter(Boolean)
    .join("\n");
}

export interface SourceChoiceNavigationEvent {
  eventId: string | null;
  description: string;
  chapterPosition: number;
  sequence?: number;
  category?: BookStoryEvent["category"];
  actors?: string[];
  targets?: string[];
  beats?: StoryEventBeat[];
}

export interface SourceEventCompletionReference {
  eventId: string | null;
  sequence?: number;
  description: string;
  beats?: Array<{
    actor: string | null;
    action: string;
    agency: StoryEventBeat["agency"];
    stakes: StoryEventBeat["stakes"];
  }>;
  criticalBeats?: Array<{
    actor: string | null;
    action: string;
  }>;
}

function sourceBeatDebugEntry(beat: StoryEventBeat, index: number) {
  return {
    index,
    actor: beat.actor,
    action: beat.action,
    agency: beat.agency,
    stakes: beat.stakes,
  };
}

export function sourceEventCompletionReference(
  event: SourceChoiceNavigationEvent,
): SourceEventCompletionReference {
  const beats = (event.beats ?? []).map((beat) => ({
    actor: beat.actor,
    action: beat.action,
    agency: beat.agency,
    stakes: beat.stakes,
  }));
  const criticalBeats = beats
    .filter((beat) => beat.stakes === "critical")
    .map((beat) => ({
      actor: beat.actor,
      action: beat.action,
    }));
  return {
    eventId: event.eventId,
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    description: event.description,
    ...(beats.length > 0 ? { beats } : {}),
    ...(criticalBeats.length > 0 ? { criticalBeats } : {}),
  };
}

export interface SourceChoiceNavigationContext extends SourceChoiceNavigationEvent {
  requiresExplicitPlayerChoice: boolean;
  currentlyAbsentCharacters: string[];
}

export interface SourceEventBeatProgressContext {
  eventId: string | null;
  completedBeatIndexes: number[];
  completedBeats: StoryEventBeat[];
  nextRequiredBeat: StoryEventBeat | null;
  remainingBeats: StoryEventBeat[];
}

export function normalizeCompletedSourceEventBeatIndexes(
  indexes: readonly number[],
  beatCount: number,
): number[] {
  const validIndexes = indexes.filter((index) =>
    Number.isInteger(index) && index >= 0 && index < beatCount
  );
  const latestCompletedBeatIndex = validIndexes
    .reduce((latest, index) => Math.max(latest, index), -1);
  const normalizedIndexes = Array.from(
    { length: latestCompletedBeatIndex + 1 },
    (_value, index) => index,
  );
  flowDiagnostic(
    "OpenAI source beat index normalization: "
    + JSON.stringify({
      reported_indexes: indexes,
      beat_count: beatCount,
      valid_indexes: validIndexes,
      normalized_contiguous_indexes: normalizedIndexes,
    }),
  );
  return normalizedIndexes;
}

export function nextRequiredSourceEventBeatReviewContext(
  event: SourceChoiceNavigationEvent | null | undefined,
  completedBeatIndexes: readonly number[],
): (ReturnType<typeof sourceBeatDebugEntry>) | null {
  const beats = event?.beats ?? [];
  const completed = new Set(
    completedBeatIndexes.filter((index) =>
      Number.isInteger(index) && index >= 0 && index < beats.length
    ),
  );
  const index = beats.findIndex((_beat, beatIndex) => !completed.has(beatIndex));
  return index >= 0 ? sourceBeatDebugEntry(beats[index]!, index) : null;
}

export function reviewedSourceEventIdForBeatProgress(
  targetEventId: string | undefined,
  reportedEventId: string | null,
  completedBeatIndexes: readonly number[],
  beatCount: number,
): string | null {
  if (
    targetEventId
    && reportedEventId === targetEventId
    && beatCount > 0
    && completedBeatIndexes.length < beatCount
  ) {
    return null;
  }
  return reportedEventId;
}

export function buildSourceEventBeatProgressContext(
  event: SourceChoiceNavigationEvent | null | undefined,
  progress: SourceEventProgress | undefined,
): SourceEventBeatProgressContext | null {
  if (!event) {
    flowDiagnostic("OpenAI source beat progress: no navigation event supplied.");
    return null;
  }
  const beats = event.beats ?? [];
  const progressMatchesEvent = progress?.eventId === event.eventId;
  const completedBeatIndexes = progressMatchesEvent
    ? normalizeCompletedSourceEventBeatIndexes(
        progress.completedBeatIndexes,
        beats.length,
      )
    : [];
  const nextIndex = completedBeatIndexes.length;
  const context = {
    eventId: event.eventId,
    completedBeatIndexes,
    completedBeats: completedBeatIndexes.map((index) => beats[index]!),
    nextRequiredBeat: beats[nextIndex] ?? null,
    remainingBeats: beats.slice(nextIndex),
  };
  flowDiagnostic(
    "OpenAI source beat progress: "
    + JSON.stringify({
      event_id: event.eventId,
      event_description: event.description,
      stored_progress_event_id: progress?.eventId ?? null,
      stored_completed_beat_indexes: progress?.completedBeatIndexes ?? [],
      stored_progress_matches_event: progressMatchesEvent,
      completed_beats: context.completedBeats.map((beat, index) =>
        sourceBeatDebugEntry(beat, completedBeatIndexes[index] ?? index)
      ),
      next_required_beat: context.nextRequiredBeat
        ? sourceBeatDebugEntry(context.nextRequiredBeat, nextIndex)
        : null,
      remaining_beats: context.remainingBeats.map((beat, index) =>
        sourceBeatDebugEntry(beat, nextIndex + index)
      ),
    }),
  );
  return context;
}

export function buildSourceEventChoiceBeatState(
  event: SourceChoiceNavigationEvent | null | undefined,
  progress: SourceEventProgress | undefined,
): {
  progress: SourceEventBeatProgressContext | null;
  completedEvent: SourceChoiceNavigationEvent | null;
  remainingEvent: SourceChoiceNavigationEvent | null;
  hasOrderedBeats: boolean;
} {
  const beatProgress = buildSourceEventBeatProgressContext(event, progress);
  const hasOrderedBeats = Boolean(event?.beats?.length);
  if (!event || !hasOrderedBeats || !beatProgress) {
    return {
      progress: beatProgress,
      completedEvent: null,
      remainingEvent: event ?? null,
      hasOrderedBeats,
    };
  }
  return {
    progress: beatProgress,
    completedEvent: beatProgress.completedBeats.length > 0
      ? { ...event, beats: beatProgress.completedBeats }
      : null,
    remainingEvent: beatProgress.remainingBeats.length > 0
      ? { ...event, beats: beatProgress.remainingBeats }
      : null,
    hasOrderedBeats,
  };
}

function playerIdentityKeys(
  playerName: string,
  profiles: readonly CharacterProfile[],
): Set<string> {
  const playerProfile = findPlayerCharacterProfile(playerName, profiles);
  return new Set(
    [
      playerName,
      playerProfile?.name,
      ...(playerProfile?.aliases ?? []),
    ]
      .filter((identity): identity is string => Boolean(identity?.trim()))
      .map(normalizedScopeIdentity),
  );
}

function isMeaningfulPlayerChoiceBeat(
  beat: StoryEventBeat,
  playerIdentities: ReadonlySet<string>,
): boolean {
  return beat.actor !== null
    && playerIdentities.has(normalizedScopeIdentity(beat.actor))
    && (beat.agency === "intentional" || beat.agency === "ambiguous")
    && beat.stakes !== "routine";
}

function isAutomaticBridgeBeat(beat: StoryEventBeat): boolean {
  return beat.actor === null
    || beat.agency === "involuntary"
    || beat.agency === "external";
}

/**
 * Locate the first meaningful decision owned by the player without declaring it
 * immediately selectable. Opening generation uses this only as a stop boundary:
 * every ordered beat before the returned index must happen in prose first.
 */
export function sourceEventFirstPlayerChoiceBeatIndex(
  event: SourceChoiceNavigationEvent | null | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
): number {
  const playerIdentities = playerIdentityKeys(playerName, profiles);
  return (event?.beats ?? []).findIndex((beat) =>
    isMeaningfulPlayerChoiceBeat(beat, playerIdentities)
  );
}

export function sourceEventPlayerChoiceBeats(
  event: SourceChoiceNavigationEvent | null | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
): StoryEventBeat[] {
  const playerIdentities = playerIdentityKeys(playerName, profiles);
  return (event?.beats ?? []).filter((beat) =>
    isMeaningfulPlayerChoiceBeat(beat, playerIdentities)
  );
}

/**
 * Return exactly the meaningful player-controlled decision that is immediately next,
 * allowing only purely automatic world/involuntary beats to precede it.
 *
 * Automatic bridge beats may be realized in generated prose before the menu, but one
 * menu selection resolves only one player decision. Consecutive player source beats
 * therefore get separate decision points instead of being bundled into one anchor.
 */
export function sourceEventNextPlayerChoiceBeats(
  event: SourceChoiceNavigationEvent | null | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
): StoryEventBeat[] {
  const playerIdentities = playerIdentityKeys(playerName, profiles);
  const remainingBeats = event?.beats ?? [];
  if (remainingBeats.length === 0) return [];

  let index = 0;
  while (index < remainingBeats.length && isAutomaticBridgeBeat(remainingBeats[index]!)) {
    index += 1;
  }
  const nextBeat = remainingBeats[index];
  return nextBeat && isMeaningfulPlayerChoiceBeat(nextBeat, playerIdentities)
    ? [nextBeat]
    : [];
}

function baseFormOfActionVerb(word: string): string {
  const normalized = word.toLocaleLowerCase();
  if (normalized === "does") return "do";
  if (normalized === "goes") return "go";
  if (normalized === "has") return "have";
  if (normalized === "is") return "be";
  if (normalized.endsWith("ies") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (/(?:ches|shes|sses|xes|zes)$/u.test(normalized)) {
    return normalized.slice(0, -2);
  }
  if (
    normalized.endsWith("s")
    && !normalized.endsWith("ss")
    && normalized.length > 3
  ) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function playerBeatAsSelectableAction(
  beat: StoryEventBeat,
  playerIdentities: readonly string[],
  presentListeners: readonly string[],
): string | undefined {
  const trimmed = beat.action.trim().replace(/[.!?]+$/u, "");
  const leadingVerb = /^(\p{L}+)(.*)$/u.exec(trimmed);
  if (!leadingVerb) return undefined;
  const baseVerb = baseFormOfActionVerb(leadingVerb[1]!);
  let action = `${baseVerb.charAt(0).toLocaleUpperCase()}${baseVerb.slice(1)}${leadingVerb[2]}`;
  action = action.replace(
    /\b(and|then)\s+(\p{L}+s)\b/giu,
    (_match, conjunction: string, verb: string) =>
      `${conjunction} ${baseFormOfActionVerb(verb)}`,
  );
  for (const identity of [...playerIdentities].sort((left, right) => right.length - left.length)) {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    action = action
      .replace(new RegExp(`${escaped}(?:'s|’s)`, "giu"), "my")
      .replace(new RegExp(`\\b${escaped}\\b`, "giu"), "me");
  }
  action = action
    .replace(/\bhimself\b/giu, "myself")
    .replace(/\bhim\b/giu, "me")
    .replace(/\bhis\b/giu, "my");
  const indirectQuestion = /^Ask\s+(whether|if|how|why|what|when|where)\b/iu.exec(
    action,
  );
  if (indirectQuestion && presentListeners.length > 0) {
    const listeners = presentListeners.length === 1
      ? presentListeners[0]
      : `${presentListeners.slice(0, -1).join(", ")} and ${presentListeners.at(-1)}`;
    action = action.replace(/^Ask\b/iu, `Ask ${listeners}`);
  }
  return action;
}

export function buildRequiredPlayerChoiceFallback(
  event: SourceChoiceNavigationEvent | null | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
  sceneScope?: SceneScope,
): GameChoice | undefined {
  const beat = sourceEventNextPlayerChoiceBeats(event, playerName, profiles)[0];
  if (!event || !beat) return undefined;
  const playerProfile = findPlayerCharacterProfile(playerName, profiles);
  const playerIdentities = [
    playerName,
    playerProfile?.name,
    ...(playerProfile?.aliases ?? []),
  ].filter((identity): identity is string => Boolean(identity?.trim()));
  const playerKeys = new Set(playerIdentities.map(normalizedScopeIdentity));
  const speakingKeys = new Set(
    (sceneScope?.peopleWithinSpeakingDistance ?? []).map(normalizedScopeIdentity),
  );
  const presentListeners = (event.actors ?? []).filter((actor, index, actors) =>
    !playerKeys.has(normalizedScopeIdentity(actor))
    && speakingKeys.has(normalizedScopeIdentity(actor))
    && actors.findIndex(
      (candidate) =>
        normalizedScopeIdentity(candidate) === normalizedScopeIdentity(actor),
    ) === index
  );
  const text = playerBeatAsSelectableAction(beat, playerIdentities, presentListeners);
  if (!text) return undefined;
  return {
    id: "__bookrpg_required_player_choice_fallback__",
    type: "action",
    text,
    requiredPresentCharacters: presentListeners,
    requiredAbsentCharacters: [],
    ...(event.eventId
      ? {
          sourceEventId: event.eventId,
          sourceAnchorRoute: "event" as SourceAnchorRoute,
        }
      : {}),
    stakes: beat.stakes === "critical" ? "critical" : "significant",
  };
}

export function nextSignificantEventForCandidate(
  candidate: SourceContinuationCandidate | undefined,
  completedEventId?: string,
): SourceChoiceNavigationEvent | null {
  const storyEvents = candidate?.storyEvents ?? [];
  const completedEventIndex = completedEventId
    ? storyEvents.findIndex((event) => event.eventId === completedEventId)
    : -1;
  const selectedEventIndex = candidate?.requiredEventId
    ? storyEvents.findIndex((event) => event.eventId === candidate.requiredEventId)
    : -1;
  const event = completedEventIndex >= 0
    ? storyEvents[completedEventIndex + 1]
    : selectedEventIndex >= 0
      ? storyEvents[selectedEventIndex]
      : storyEvents[0];
  if (event) return event;
  if (completedEventId && completedEventId === candidate?.requiredEventId) {
    return null;
  }
  return candidate?.requiredEvent
    ? {
        eventId: candidate.requiredEventId ?? null,
        description: candidate.requiredEvent,
        chapterPosition: candidate.chapterPosition,
        category: candidate.requiredEventCategory,
        actors: candidate.requiredEventActors,
        targets: candidate.requiredEventTargets,
        beats: candidate.requiredEventBeats,
      }
    : null;
}

export function sourceSceneBeatReviewTargetId(
  navigationEvent: SourceChoiceNavigationEvent | null | undefined,
  claimedRequiredEventId?: string,
): string | undefined {
  // Review the same event whose ordered beats guided scene generation, even
  // on a transition that does not require completion of the whole event.
  // Stored progress is evidence for that event, never a competing target.
  return navigationEvent?.eventId ?? claimedRequiredEventId;
}

export function sourceEventRequiresExplicitPlayerChoice(
  event: SourceChoiceNavigationEvent | null | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
  sceneScope?: SceneScope,
): boolean {
  if (!event) return false;
  const playerIdentities = playerIdentityKeys(playerName, profiles);
  const hasPlayerChoiceBeat = event.beats?.length
    ? sourceEventNextPlayerChoiceBeats(event, playerName, profiles).length > 0
    : event.actors?.some(
        (actor) => playerIdentities.has(normalizedScopeIdentity(actor)),
      ) ?? false;
  if (!hasPlayerChoiceBeat) return false;
  if (event.category !== "arrival" || !sceneScope) return true;

  return !sourceEventHasAbsentNonPlayerParticipant(
    event,
    playerName,
    profiles,
    sceneScope,
  );
}

export function sourceEventHasAbsentNonPlayerParticipant(
  event: SourceChoiceNavigationEvent | null | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[],
  sceneScope: SceneScope | undefined,
): boolean {
  if (!event || !sceneScope) return false;
  const playerIdentities = playerIdentityKeys(playerName, profiles);
  const participants = [...(event.actors ?? []), ...(event.targets ?? [])]
    .map(normalizedScopeIdentity);
  return profiles.some((profile) => {
    const identities = [profile.name, ...profile.aliases]
      .map(normalizedScopeIdentity);
    return identities.some((identity) => participants.includes(identity))
      && !identities.some((identity) => playerIdentities.has(identity))
      && !identities.some((identity) =>
        sceneScope.peoplePresent.some(
          (presentCharacter) =>
            normalizedScopeIdentity(presentCharacter) === identity,
        )
      );
  });
}

export function sourceEventHasReliableNonPlayerActors(
  event: SourceChoiceNavigationEvent | null | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
): boolean {
  if (event?.beats?.length) {
    if (sourceEventPlayerChoiceBeats(event, playerName, profiles).length > 0) {
      return false;
    }
    const playerIdentities = playerIdentityKeys(playerName, profiles);
    return event.beats.some((beat) =>
      beat.actor === null
      || !playerIdentities.has(normalizedScopeIdentity(beat.actor))
    );
  }
  return Boolean(
    event?.actors?.length
    && !sourceEventRequiresExplicitPlayerChoice(event, playerName, profiles),
  );
}

export function sourceEventCanOccurWithoutPlayerChoice(
  event: SourceChoiceNavigationEvent | null | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
  sceneScope?: SceneScope,
): boolean {
  if (event?.beats?.length) {
    return sourceEventNextPlayerChoiceBeats(event, playerName, profiles).length === 0;
  }
  return sourceEventHasReliableNonPlayerActors(event, playerName, profiles)
    || (
      event?.category === "arrival"
      && sourceEventHasAbsentNonPlayerParticipant(
        event,
        playerName,
        profiles,
        sceneScope,
      )
    );
}

export function selectedAnchorRequiresSourceEvent(
  route: SourceAnchorRoute | undefined,
  event: SourceChoiceNavigationEvent | null | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
  sceneScope?: SceneScope,
): boolean {
  const canAdvanceWithoutPlayerChoice = sourceEventCanOccurWithoutPlayerChoice(
    event,
    playerName,
    profiles,
    sceneScope,
  );
  if (route === "event") {
    if (!event) return false;
    if (!event.beats?.length) return true;
    return canAdvanceWithoutPlayerChoice
      || sourceEventRequiresExplicitPlayerChoice(
        event,
        playerName,
        profiles,
        sceneScope,
      );
  }
  if (route === "transition") {
    return canAdvanceWithoutPlayerChoice;
  }
  return canAdvanceWithoutPlayerChoice;
}

export function buildSourceChoiceNavigationContext(
  candidate: SourceContinuationCandidate | undefined,
  playerName: string,
  profiles: readonly CharacterProfile[] = [],
  completedEventId?: string,
  sceneScope?: SceneScope,
): SourceChoiceNavigationContext | null {
  const event = nextSignificantEventForCandidate(candidate, completedEventId);
  const presentIdentities = new Set(
    (sceneScope?.peoplePresent ?? []).map(normalizedScopeIdentity),
  );
  const playerIdentities = playerIdentityKeys(playerName, profiles);
  const currentlyAbsentCharacters = event
    ? profiles
      .filter((profile) => {
        const identities = [profile.name, ...profile.aliases]
          .map(normalizedScopeIdentity);
        return [...(event.actors ?? []), ...(event.targets ?? [])].some(
          (participant) => identities.includes(normalizedScopeIdentity(participant)),
        )
          && !identities.some((identity) => presentIdentities.has(identity))
          && !identities.some((identity) => playerIdentities.has(identity));
      })
      .map((profile) => profile.name)
    : [];
  return event
    ? {
        ...event,
        requiresExplicitPlayerChoice: sourceEventRequiresExplicitPlayerChoice(
          event,
          playerName,
          profiles,
          sceneScope,
        ),
        currentlyAbsentCharacters,
      }
    : null;
}

export function reviewedVisibleSourceEvent(
  candidate: SourceContinuationCandidate | undefined,
  eventId: string | null | undefined,
): SourceChoiceNavigationEvent | null {
  if (!candidate) {
    flowDiagnostic(
      "OpenAI source event position decision: "
      + JSON.stringify({ requested_event_id: eventId ?? null, accepted: false, reason: "no source candidate" }),
    );
    return null;
  }
  if (!eventId) {
    flowDiagnostic(
      "OpenAI source event position decision: "
      + JSON.stringify({
        requested_event_id: null,
        current_event_id: candidate.currentStoryEvent?.eventId ?? null,
        accepted: false,
        reason: "reviewer did not report a visible source event id",
      }),
    );
    return null;
  }
  const event = candidate.currentStoryEvent?.eventId === eventId
    ? candidate.currentStoryEvent
    : candidate.storyEvents?.find(
        (storyEvent) => storyEvent.eventId === eventId,
      );
  const currentSequence = candidate.currentStoryEvent?.sequence;
  if (!event) {
    flowDiagnostic(
      "OpenAI source event position decision: "
      + JSON.stringify({
        requested_event_id: eventId,
        current_event_id: candidate.currentStoryEvent?.eventId ?? null,
        known_event_ids: [
          candidate.currentStoryEvent?.eventId,
          ...(candidate.storyEvents ?? []).map((storyEvent) => storyEvent.eventId),
        ].filter(Boolean),
        accepted: false,
        reason: "reported event id is not present in the source candidate",
      }),
    );
    return null;
  }
  if (currentSequence !== undefined && event.sequence < currentSequence) {
    flowDiagnostic(
      "OpenAI source event position decision: "
      + JSON.stringify({
        requested_event_id: eventId,
        reported_event_sequence: event.sequence,
        current_event_id: candidate.currentStoryEvent?.eventId ?? null,
        current_event_sequence: currentSequence,
        accepted: false,
        reason: "reported event is before the current source position",
      }),
    );
    return null;
  }
  flowDiagnostic(
    "OpenAI source event position decision: "
    + JSON.stringify({
      requested_event_id: eventId,
      event_description: event.description,
      event_sequence: event.sequence,
      current_event_id: candidate.currentStoryEvent?.eventId ?? null,
      current_event_sequence: currentSequence ?? null,
      accepted: true,
      reason: "reported event is known and is not before the current source position",
    }),
  );
  return event;
}
