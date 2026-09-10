import {
  createHash,
} from "node:crypto";
import type {
  BookStoryEvent,
  ImportedBook,
  SourceReference,
  StoryEventBeat,
} from "../../shared/contracts.js";
import {
  sourceReferenceKey,
  deduplicateReferences,
} from "./chapter-index.js";

export function classifyStoryEventCategory(
  description: string,
): BookStoryEvent["category"] {
  if (/\b(?:discover|finds?|found|discovers|ontdekt|vindt)\b/iu.test(description)) {
    return "discovery";
  }
  if (/\b(?:reveals?|announces?|confesses?|tells?|onthult|kondigt|bekent|vertelt)\b/iu.test(description)) {
    return "revelation";
  }
  if (/\b(?:departs?|leaves?|flees?|vertrekt|verlaat|vlucht)\b/iu.test(description)) {
    return "departure";
  }
  if (/\b(?:arrives?|enters?|appears?|arriveert|komt aan|verschijnt)\b/iu.test(description)) {
    return "arrival";
  }
  if (/\b(?:investigat|questions?|searches?|onderzoek|ondervraagt|doorzoekt)\w*/iu.test(description)) {
    return "investigation";
  }
  if (/\b(?:dies?|dead|death|kill(?:s|ed|ing)?|murder(?:s|ed|ing)?|sterft|dood|gedood|vermoord)\b/iu.test(description)) {
    return "death";
  }
  if (/\b(?:attack|attacks|strikes?|shoots?|stabs?|assault|aanval|aanvalt|slaat|schiet|steekt)\b/iu.test(description)) {
    return "violence";
  }
  if (/\b(?:decides?|chooses?|agrees?|refuses?|besluit|kiest|stemt|weigert)\b/iu.test(description)) {
    return "decision";
  }
  return "other";
}

export function referencesOverlap(left: SourceReference, right: SourceReference): boolean {
  return left.chapterPosition === right.chapterPosition
    && left.lineStart <= right.lineEnd
    && right.lineStart <= left.lineEnd;
}

function mergePreludeReferences(references: readonly SourceReference[]): SourceReference[] {
  const ordered = deduplicateReferences(references).toSorted((left, right) =>
    left.chapterPosition - right.chapterPosition
    || left.chapterIndex - right.chapterIndex
    || left.lineStart - right.lineStart
    || left.lineEnd - right.lineEnd
  );
  const merged: SourceReference[] = [];
  for (const reference of ordered) {
    const previous = merged.at(-1);
    if (
      previous
      && previous.chapterPosition === reference.chapterPosition
      && previous.chapterIndex === reference.chapterIndex
      && reference.lineStart <= previous.lineEnd + 1
    ) {
      previous.lineStart = Math.min(previous.lineStart, reference.lineStart);
      previous.lineEnd = Math.max(previous.lineEnd, reference.lineEnd);
      continue;
    }
    merged.push({ ...reference });
  }
  return merged;
}

function sourceExcerptForReferences(
  book: Pick<ImportedBook, "chapters">,
  references: readonly SourceReference[],
): string {
  return references.map((reference) => {
    const chapter = book.chapters[reference.chapterPosition];
    const lines = chapter?.text.trim().split(/\r?\n/);
    if (
      !chapter
      || chapter.index !== reference.chapterIndex
      || !lines
      || reference.lineStart < 1
      || reference.lineStart > reference.lineEnd
      || reference.lineEnd > lines.length
    ) {
      throw new Error(
        `Cannot extract beat prelude from ${JSON.stringify(reference)}`,
      );
    }
    return lines.slice(reference.lineStart - 1, reference.lineEnd).join("\n");
  }).join("\n\n");
}

export function sourcePreludeForBeat(
  book: Pick<ImportedBook, "chapters">,
  beats: readonly StoryEventBeat[],
  beatIndex: number,
): string | undefined {
  if (!beats[beatIndex] || beatIndex <= 0) return undefined;

  const sourceReferences = mergePreludeReferences(
    beats
      .slice(0, beatIndex)
      .flatMap((precedingBeat) => precedingBeat.sourceReferences),
  );
  if (sourceReferences.length === 0) return undefined;

  return sourceExcerptForReferences(book, sourceReferences);
}

export function buildBookStoryEvents(
  book: Pick<ImportedBook, "bookId" | "chapters">,
): BookStoryEvent[] {
  const events = book.chapters.flatMap((chapter, chapterPosition) =>
    (chapter.sourceIndex?.significantEvents ?? []).map((event, eventIndex) => {
      const matchingActions = chapter.sourceIndex?.actions.filter((action) =>
        action.sourceReferences.some((actionReference) =>
          event.sourceReferences.some((eventReference) =>
            referencesOverlap(actionReference, eventReference)
          )
        )
      ) ?? [];
      const beatActors = event.beats?.flatMap((beat) =>
        beat.actor ? [beat.actor] : []
      );
      const beatTargets = event.beats?.flatMap((beat) => beat.targets);
      return {
        chapterPosition,
        eventIndex,
        description: event.description.trim(),
        sourceReferences: deduplicateReferences(event.sourceReferences),
        ...(event.beats
          ? {
              beats: event.beats.map((beat) => ({
                ...beat,
                targets: [...new Set(beat.targets)],
                sourceReferences: deduplicateReferences(beat.sourceReferences),
              })),
            }
          : {}),
        actors: beatActors
          ? [...new Set(beatActors)]
          : event.actors
            ? [...new Set(event.actors)]
            : [...new Set(matchingActions.map((action) => action.actor))],
        targets: beatTargets
          ? [...new Set(beatTargets)]
          : event.targets
            ? [...new Set(event.targets)]
            : [...new Set(matchingActions.flatMap((action) => action.targets))],
      };
    })
  ).sort((left, right) =>
    left.chapterPosition - right.chapterPosition
    || (left.sourceReferences[0]?.lineStart ?? 0) - (right.sourceReferences[0]?.lineStart ?? 0)
    || left.eventIndex - right.eventIndex
  );

  return events.map((event, index) => {
    const referenceKey = event.sourceReferences.map(sourceReferenceKey).join(",");
    const digest = createHash("sha256")
      .update(`${book.bookId}\0${referenceKey}\0${event.description}`)
      .digest("hex")
      .slice(0, 20);
    return {
      eventId: `event_${digest}`,
      sequence: index + 1,
      description: event.description,
      category: classifyStoryEventCategory(event.description),
      chapterPosition: event.chapterPosition,
      actors: event.actors,
      targets: event.targets,
      ...(event.beats ? { beats: event.beats } : {}),
      sourceReferences: event.sourceReferences,
    };
  });
}
