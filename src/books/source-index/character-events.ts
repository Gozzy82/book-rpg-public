import type {
  BookStoryEvent,
  ImportedBook,
  StoryEventBeat,
} from "../../shared/contracts.js";
import {
  sourcePreludeEndStateForBeat,
  sourcePreludeForBeat,
} from "./story-events.js";

type PreludeStoryEventBeat = StoryEventBeat & {
  automaticPreludeSourceExcerpt?: string;
  automaticPreludeEndState?: string;
};

function normalizeCharacterIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function eventForCharacter(
  book: Pick<ImportedBook, "chapters">,
  event: BookStoryEvent,
  identities: ReadonlySet<string>,
): BookStoryEvent {
  if (!event.beats) return event;

  const beats = event.beats.map((beat, beatIndex) => {
    const cleanBeat = { ...beat } as PreludeStoryEventBeat;
    delete cleanBeat.automaticPreludeSourceExcerpt;
    delete cleanBeat.automaticPreludeEndState;

    if (
      !beat.actor
      || !identities.has(normalizeCharacterIdentity(beat.actor))
    ) {
      return cleanBeat;
    }

    const automaticPreludeSourceExcerpt = sourcePreludeForBeat(
      book,
      event.beats!,
      beatIndex,
    );
    const automaticPreludeEndState = sourcePreludeEndStateForBeat(
      event.beats!,
      beatIndex,
    );
    return automaticPreludeSourceExcerpt || automaticPreludeEndState
      ? {
          ...cleanBeat,
          ...(automaticPreludeSourceExcerpt ? { automaticPreludeSourceExcerpt } : {}),
          ...(automaticPreludeEndState ? { automaticPreludeEndState } : {}),
        }
      : cleanBeat;
  });

  return {
    ...event,
    beats,
  };
}

export function attachCharacterSignificantEvents(
  book: Pick<ImportedBook, "chapters" | "storyEvents" | "worldBible">,
): void {
  const profiles = book.worldBible?.characterProfiles;
  if (!profiles || !book.storyEvents) return;

  const profileByIdentity = new Map<string, (typeof profiles)[number]>();
  const identitiesByProfile = new Map<
    (typeof profiles)[number],
    Set<string>
  >();

  for (const profile of profiles) {
    const identities = new Set(
      [profile.name, ...profile.aliases].map(normalizeCharacterIdentity),
    );
    identitiesByProfile.set(profile, identities);
    for (const identity of identities) {
      profileByIdentity.set(identity, profile);
    }
    profile.significantEvents = [];
  }

  for (const event of book.storyEvents) {
    const participants = new Set([...event.actors, ...event.targets]);
    const attachedProfiles = new Set<(typeof profiles)[number]>();
    for (const participant of participants) {
      const profile = profileByIdentity.get(normalizeCharacterIdentity(participant));
      if (!profile || attachedProfiles.has(profile)) continue;

      profile.significantEvents!.push(
        eventForCharacter(
          book,
          event,
          identitiesByProfile.get(profile) ?? new Set<string>(),
        ),
      );
      attachedProfiles.add(profile);
    }
  }
}
