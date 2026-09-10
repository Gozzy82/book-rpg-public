import type {
  SourceContinuationCandidate,
} from "../../ai/engine.js";
import {
  MIN_VERIFIED_IDENTITY_CONFIDENCE,
} from "../../shared/contracts.js";
import type {
  BookStoryEvent,
  GameState,
  ImportedBook,
  SourceReference,
  SourceCursor,
} from "../../shared/contracts.js";
import {
  normalizedOffsetThroughSourceLine,
  SOURCE_EVENT_LOOKAHEAD,
  OPENING_STORY_SO_FAR_CHAPTERS,
  chapterSummary,
  isKnownNonStoryChapter,
} from "./source-chapter.js";

export const MAX_STARTING_CHARACTER_OPTIONS = 5;

const COLLECTIVE_CHARACTER_NOUNS = [
  "authorities",
  "boys",
  "brothers",
  "children",
  "committee",
  "couple",
  "crew",
  "crowd",
  "detectives",
  "family",
  "girls",
  "guards",
  "household",
  "investigators",
  "jury",
  "men",
  "officers",
  "parents",
  "people",
  "police",
  "servants",
  "siblings",
  "sisters",
  "soldiers",
  "staff",
  "students",
  "team",
  "teachers",
  "townspeople",
  "twins",
  "villagers",
  "women",
  "workers",
] as const;

const COLLECTIVE_CHARACTER_LABEL = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])(?:${
    COLLECTIVE_CHARACTER_NOUNS.join("|")
  })\s*$`,
  "iu",
);

const EXPLICIT_COLLECTIVE_DESCRIPTION =
  /^(?:a|an|the|several|multiple)\s+(?:group|team|crew|crowd|family|couple|pair|committee|jury|staff)\b/iu;

export class PlayerUnavailableError extends Error {
  readonly code = "PLAYER_UNAVAILABLE";

  constructor(
    readonly playerName: string,
    readonly reason: string,
  ) {
    super(`Cannot play as ${playerName} at this point: ${reason}`);
    this.name = "PlayerUnavailableError";
  }
}

export function canonicalOpeningGoals(
  playerName: string,
  gameProfile: GameState["gameProfile"],
): Pick<GameState, "objective" | "victoryCondition"> {
  return {
    objective:
      `Begin at ${playerName}'s earliest grounded story moment, pursue goals consistent with `
      + "what is established there, and shape an alternate timeline through your choices.",
    victoryCondition: gameProfile.endingMode === "open_ended"
      ? "There is no fixed ending; reach meaningful character and story milestones through your choices."
      : gameProfile.endingMode === "completion"
        ? "Reach a coherent conclusion to your character's role in the story."
        : "Achieve a clear, story-consistent success through your character's choices.",
  };
}

export function firstNarrativeStoryEvent(book: ImportedBook): BookStoryEvent | undefined {
  return [...(book.storyEvents ?? [])]
    .sort((left, right) => left.sequence - right.sequence)
    .find((event) => {
      const chapter = book.chapters[event.chapterPosition];
      return Boolean(chapter && !isKnownNonStoryChapter(chapter));
    });
}

export function canonicalCharacterProfile(
  book: ImportedBook,
  playerName: string,
) {
  const normalizedPlayer = normalizedCharacterIdentity(playerName);
  return book.worldBible?.characterProfiles?.find((candidate) =>
    [candidate.name, ...candidate.aliases].some(
      (identity) => normalizedCharacterIdentity(identity) === normalizedPlayer,
    )
  );
}

export function canonicalAnalyzedCharacterName(
  book: ImportedBook,
  identity: string,
): string {
  const normalizedIdentity = normalizedCharacterIdentity(identity);
  const profile = book.worldBible?.characterProfiles?.find((candidate) =>
    [candidate.name, ...candidate.aliases].some(
      (label) => normalizedCharacterIdentity(label) === normalizedIdentity,
    )
  );
  if (profile) return profile.name;

  const resolution = book.worldBible?.identityResolutions?.find((candidate) =>
    candidate.decision === "same_person"
    && candidate.confidence >= MIN_VERIFIED_IDENTITY_CONFIDENCE
    && [candidate.canonicalName, candidate.alias].some(
      (label) => normalizedCharacterIdentity(label) === normalizedIdentity,
    )
  );
  if (resolution) return resolution.canonicalName;

  const observation = book.chapters
    .flatMap((chapter) => chapter.sourceIndex?.characters ?? [])
    .find((candidate) =>
      [candidate.name, ...candidate.aliases].some(
        (label) => normalizedCharacterIdentity(label) === normalizedIdentity,
      )
    );
  return observation?.name ?? identity.trim();
}

export function canonicalPlayerIdentities(
  book: ImportedBook,
  playerName: string,
): Set<string> {
  const profile = canonicalCharacterProfile(book, playerName);
  const canonicalCharacter = canonicalAnalyzedCharacterName(
    book,
    profile?.name ?? playerName,
  );
  const canonicalIdentity = normalizedCharacterIdentity(canonicalCharacter);
  const observedIdentities = book.chapters
    .flatMap((chapter) => chapter.sourceIndex?.characters ?? [])
    .filter((observation) =>
      normalizedCharacterIdentity(canonicalAnalyzedCharacterName(book, observation.name))
        === canonicalIdentity
    )
    .flatMap((observation) => [observation.name, ...observation.aliases]);
  const resolvedAliases = book.worldBible?.identityResolutions
    ?.filter((resolution) =>
      resolution.decision === "same_person"
      && resolution.confidence >= MIN_VERIFIED_IDENTITY_CONFIDENCE
      && normalizedCharacterIdentity(resolution.canonicalName) === canonicalIdentity
    )
    .flatMap((resolution) => [resolution.canonicalName, resolution.alias]) ?? [];
  return new Set(
    [
      playerName,
      canonicalCharacter,
      profile?.name,
      ...(profile?.aliases ?? []),
      ...observedIdentities,
      ...resolvedAliases,
    ]
      .filter((identity): identity is string => Boolean(identity?.trim()))
      .map(normalizedCharacterIdentity),
  );
}

export function firstNarrativeStoryEventForPlayer(
  book: ImportedBook,
  playerName?: string,
): BookStoryEvent | undefined {
  if (!playerName?.trim()) return firstNarrativeStoryEvent(book);
  const events = [...(book.storyEvents ?? [])]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((event) => {
      const chapter = book.chapters[event.chapterPosition];
      return Boolean(chapter && !isKnownNonStoryChapter(chapter));
    });
  const identities = canonicalPlayerIdentities(book, playerName);
  const mentionsPlayer = (identitiesToCheck: readonly string[]) =>
    identitiesToCheck.some((identity) =>
      identities.has(normalizedCharacterIdentity(identity))
    );
  const playerReferences = playerSourceReferences(book, playerName);
  const playerReference = playerReferences[0];
  // A target may be someone discussed, remembered, or sought rather than a
  // participant. Do not align an early name mention with an unrelated later
  // target-only event. Require a source reference in that event for target-only
  // starts; actor roles remain eligible even when character references are sparse.
  const isReferencedParticipant = (event: BookStoryEvent): boolean =>
    mentionsPlayer(event.actors)
    || (
      mentionsPlayer(event.targets)
      && event.sourceReferences.some((eventReference) =>
        playerReferences.some((reference) =>
          reference.chapterPosition === eventReference.chapterPosition
          && reference.lineStart <= eventReference.lineEnd
          && reference.lineEnd >= eventReference.lineStart
        )
      )
    );
  const referenceAlignedEvent = playerReference
    ? events
        .filter(isReferencedParticipant)
        .flatMap((event) => {
          const distances = event.sourceReferences.flatMap((reference) => {
            if (
              reference.chapterPosition < playerReference.chapterPosition
              || (
                reference.chapterPosition === playerReference.chapterPosition
                && reference.lineEnd < playerReference.lineStart
              )
            ) {
              return [];
            }
            const chapterDistance =
              reference.chapterPosition - playerReference.chapterPosition;
            const lineDistance = reference.chapterPosition === playerReference.chapterPosition
              ? Math.abs(reference.lineStart - playerReference.lineStart)
              : reference.lineStart;
            return [chapterDistance * 1_000_000 + lineDistance];
          });
          return distances.length > 0
            ? [{ event, distance: Math.min(...distances) }]
            : [];
        })
        .sort((left, right) =>
          left.distance - right.distance
          || left.event.sequence - right.event.sequence
        )[0]?.event
    : undefined;
  return referenceAlignedEvent
    ?? events.find((event) => mentionsPlayer(event.actors))
    ?? events.find((event) => mentionsPlayer([...event.actors, ...event.targets]))
    ?? (
      canonicalStartCharacters(book).some((character) =>
        normalizedCharacterIdentity(character)
          === normalizedCharacterIdentity(
            canonicalAnalyzedCharacterName(book, playerName),
          )
      )
        ? undefined
        : events[0]
    );
}

export function earliestPlayerSourceReference(
  book: ImportedBook,
  playerName?: string,
): SourceReference | undefined {
  return playerSourceReferences(book, playerName)[0];
}

function playerSourceReferences(
  book: ImportedBook,
  playerName?: string,
): SourceReference[] {
  if (!playerName?.trim()) return [];
  const identities = canonicalPlayerIdentities(book, playerName);
  const indexedReferences = book.chapters
    .flatMap((chapter) => chapter.sourceIndex?.characters ?? [])
    .filter((observation) =>
      [observation.name, ...observation.aliases].some((identity) =>
        identities.has(normalizedCharacterIdentity(identity))
      )
    )
    .flatMap((observation) => observation.sourceReferences);
  const profileReferences = canonicalCharacterProfile(book, playerName)
    ?.sourceReferences ?? [];
  return [...indexedReferences, ...profileReferences]
    .sort((left, right) =>
      left.chapterPosition - right.chapterPosition
      || left.lineStart - right.lineStart
      || left.lineEnd - right.lineEnd
    );
}

export function canonicalStartCharacters(book: ImportedBook): string[] {
  const seen = new Set<string>();
  return [
    ...(book.worldBible?.characters ?? []),
    ...(book.worldBible?.characterProfiles?.map((profile) => profile.name) ?? []),
    ...book.chapters.flatMap((chapter) =>
      chapter.sourceIndex?.characters.map((character) => character.name) ?? []
    ),
  ]
    .map((character) => canonicalAnalyzedCharacterName(book, character))
    .filter((character) => {
      const identity = normalizedCharacterIdentity(character);
      if (!identity || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

export function isIndividualStartingCharacter(
  book: ImportedBook,
  character: string,
): boolean {
  const profile = canonicalCharacterProfile(book, character);
  const canonicalName = profile?.name ?? canonicalAnalyzedCharacterName(book, character);
  if (COLLECTIVE_CHARACTER_LABEL.test(canonicalName.trim())) {
    return false;
  }
  return !profile
    || !EXPLICIT_COLLECTIVE_DESCRIPTION.test(profile.description.trim());
}

export function startingCharacterOptions(book: ImportedBook): string[] {
  return canonicalStartCharacters(book)
    .filter((character) => isIndividualStartingCharacter(book, character))
    .slice(0, MAX_STARTING_CHARACTER_OPTIONS);
}

export function canonicalPlayerStartAvailability(
  book: ImportedBook,
  playerName: string,
): boolean | undefined {
  const canonicalCharacter = canonicalAnalyzedCharacterName(book, playerName);
  const isAnalyzedCharacter = canonicalStartCharacters(book).some(
    (character) => normalizedCharacterIdentity(character)
      === normalizedCharacterIdentity(canonicalCharacter),
  );
  if (
    isAnalyzedCharacter
    && !isIndividualStartingCharacter(book, canonicalCharacter)
  ) {
    return false;
  }
  return isAnalyzedCharacter ? true : undefined;
}

export function normalizedCharacterIdentity(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase("en");
}

export function openingStorySoFar(
  book: ImportedBook,
  startChapterPosition: number,
  startEvent?: BookStoryEvent,
): NonNullable<SourceContinuationCandidate["storySoFar"]> {
  const priorChapters = book.chapters
    .flatMap((chapter, chapterPosition) => {
      if (chapterPosition >= startChapterPosition || isKnownNonStoryChapter(chapter)) {
        return [];
      }
      const summary = chapterSummary(chapter);
      return summary
        ? [{ chapterPosition, chapterTitle: chapter.title, summary }]
        : [];
    });
  const earlierCurrentChapterEvents = startEvent
    ? [...(book.storyEvents ?? [])]
        .filter((event) =>
          event.chapterPosition === startChapterPosition
          && event.sequence < startEvent.sequence
        )
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-SOURCE_EVENT_LOOKAHEAD)
    : [];
  const currentChapterContext = earlierCurrentChapterEvents.length > 0
    ? [{
        chapterPosition: startChapterPosition,
        chapterTitle: book.chapters[startChapterPosition]?.title ?? "",
        summary: `Earlier in this chapter: ${earlierCurrentChapterEvents
          .map((event) => event.description)
          .join(" ")}`,
      }]
    : [];
  return [...priorChapters, ...currentChapterContext]
    .slice(-OPENING_STORY_SO_FAR_CHAPTERS);
}

export function canonicalGameStartContext(book: ImportedBook, playerName?: string): {
  selectedText: string;
  position: NonNullable<GameState["position"]>;
  sourceCursor: SourceCursor;
  candidate: SourceContinuationCandidate;
} {
  const firstEvent = firstNarrativeStoryEventForPlayer(book, playerName);
  const playerReference = firstEvent
    ? undefined
    : earliestPlayerSourceReference(book, playerName);
  const chapterPosition = firstEvent?.chapterPosition
    ?? playerReference?.chapterPosition
    ?? book.chapters.findIndex((chapter) =>
      !isKnownNonStoryChapter(chapter) && Boolean(chapter.text.trim())
    );
  if (chapterPosition < 0) {
    throw new Error(`Book "${book.title}" has no narrative content to start from.`);
  }

  const chapter = book.chapters[chapterPosition]!;
  const references = firstEvent?.sourceReferences
    .filter((reference) => reference.chapterPosition === chapterPosition)
    ?? (playerReference ? [playerReference] : []);
  const lineStart = references.length > 0
    ? Math.min(...references.map((reference) => reference.lineStart))
    : 1;
  const textOffset = normalizedOffsetThroughSourceLine(chapter.text, lineStart - 1);
  const normalizedText = chapter.text.replace(/\s+/g, " ");
  const openingEvents = [...(book.storyEvents ?? [])]
    .filter((event) =>
      firstEvent
        ? event.sequence >= firstEvent.sequence
        : !playerReference
          || event.chapterPosition > playerReference.chapterPosition
          || (
            event.chapterPosition === playerReference.chapterPosition
            && event.sourceReferences.some(
              (reference) => reference.lineEnd >= playerReference.lineStart,
            )
          )
    )
    .sort((left, right) => left.sequence - right.sequence)
    .slice(0, SOURCE_EVENT_LOOKAHEAD);
  const firstEventLineEnd = references.reduce(
    (maximum, reference) => Math.max(maximum, reference.lineEnd),
    0,
  );
  const nextEventLineStart = openingEvents
    .slice(1)
    .flatMap((event) =>
      event.sourceReferences.filter(
        (reference) => reference.chapterPosition === chapterPosition,
      )
    )
    .reduce(
      (minimum, reference) => Math.min(minimum, reference.lineStart),
      Number.POSITIVE_INFINITY,
    );
  const openingLineEnd =
    Number.isFinite(nextEventLineStart) && nextEventLineStart > lineStart
      ? nextEventLineStart - 1
      : firstEventLineEnd;
  const nextTextOffset = Math.min(
    normalizedText.length,
    openingLineEnd > 0
      ? normalizedOffsetThroughSourceLine(chapter.text, openingLineEnd)
      : textOffset + 1_500,
  );
  const sourceCursor: SourceCursor = { chapterPosition, textOffset };
  const storySoFar = openingStorySoFar(book, chapterPosition, firstEvent);
  const orderedEvents: NonNullable<SourceContinuationCandidate["storyEvents"]> =
    openingEvents.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      description: event.description,
      category: event.category,
      chapterPosition: event.chapterPosition,
      actors: event.actors,
      targets: event.targets,
      ...(event.beats ? { beats: event.beats } : {}),
    }));
  const openingSummary = orderedEvents.length > 0
    ? orderedEvents[0]!.description
    : normalizedText.slice(textOffset, nextTextOffset);
  const unavailableCharacters = openingEvents
    .slice(1)
    .filter((event) => event.category === "arrival")
    .flatMap((event) => event.actors)
    .filter((identity) =>
      !playerName
      || !canonicalPlayerIdentities(book, playerName)
        .has(normalizedCharacterIdentity(identity))
    )
    .filter((identity, index, all) => identity.trim() && all.indexOf(identity) === index);
  const openingExcerpt = normalizedText.slice(textOffset, nextTextOffset).trim();

  return {
    selectedText:
      firstEvent?.description
      || openingExcerpt
      || book.title,
    position: {
      chapterIndex: chapterPosition,
      chapterTitle: chapter.title,
      progress: 0,
    },
    sourceCursor,
    candidate: {
      chapterPosition,
      chapterTitle: chapter.title,
      summary: openingSummary,
      chapterSummary: chapterSummary(chapter),
      ...(storySoFar.length > 0 ? { storySoFar } : {}),
      excerpt: openingExcerpt,
      nextTextOffset,
      ...(orderedEvents.length > 0 ? { storyEvents: orderedEvents } : {}),
      ...(orderedEvents[0] ? { currentStoryEvent: orderedEvents[0] } : {}),
      ...(unavailableCharacters.length > 0 ? { unavailableCharacters } : {}),
    },
  };
}
