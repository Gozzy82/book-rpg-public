import {parseStoryEventCategory} from '../../shared/story-event-category.js';
import {
  createHash,
} from "node:crypto";
import type {
  BookStoryEvent,
  ImportedBook,
  SourceReference,
  StoryEventBeat,
  SourceActionStart,
} from "../../shared/contracts.js";
import {
  sourceReferenceKey,
  deduplicateReferences,
} from "./chapter-index.js";

export function referencesOverlap(left: SourceReference, right: SourceReference): boolean {
  return left.chapterPosition === right.chapterPosition
    && left.lineStart <= right.lineEnd
    && right.lineStart <= left.lineEnd;
}

function mergePreludeReferences(references: readonly SourceReference[]): SourceReference[] {
  const ordered = deduplicateReferences([...references]).toSorted((left, right) =>
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
      || !Number.isInteger(reference.lineStart) || !Number.isInteger(reference.lineEnd)
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

/** A physical evidence range may begin halfway through a wrapped sentence.
 * Admit only its directly adjacent, non-terminated prefix, not an arbitrary
 * earlier passage. This checks source geometry; the independent boundary audit
 * must still establish that the prefix is the FIRST performance of this action.
 */
function supportsActionStart(lines: string[], reference: SourceReference, start: SourceActionStart): boolean {
  if (reference.chapterPosition !== start.chapterPosition || reference.chapterIndex !== start.chapterIndex) return false;
  if (reference.lineStart <= start.line && reference.lineEnd >= start.line) return true;
  if (start.line !== reference.lineStart - 1) return false;
  const prefix = lines[start.line - 1]?.slice(start.column);
  const continuation = lines[reference.lineStart - 1];
  return !!prefix?.trim() && !!continuation?.trim() && !/[.!?…]/u.test(prefix);
}

/** Reject stale, unrelated and imprecise action coordinates before slicing. */
export function validateSourceActionStart(book: Pick<ImportedBook, "chapters">,
  beat: StoryEventBeat, start: SourceActionStart): void {
  const chapter = book.chapters[start.chapterPosition];
  const lines = chapter?.text.trim().split(/\r?\n/);
  const line = lines?.[start.line - 1];
  if (!Number.isInteger(start.chapterPosition) || !Number.isInteger(start.line)
    || !Number.isInteger(start.column) || start.column < 0 || start.line < 1
    || !chapter || chapter.index !== start.chapterIndex || line === undefined
    || typeof start.quote !== 'string' || !start.quote.trim() || /[\r\n]/u.test(start.quote)
    || !line.slice(start.column).startsWith(start.quote)
    || !beat.sourceReferences.some(r => supportsActionStart(lines!, r, start))) {
    throw new Error(`Invalid source action start for ${beat.action}`);
  }
}

function compareActionStarts(a: SourceActionStart, b: SourceActionStart): number {
  return a.chapterPosition - b.chapterPosition || a.line - b.line || a.column - b.column;
}

export interface SourcePreludeEvidence {
  references: SourceReference[];
  excerpt?: string;
  issues: string[];
  warnings?: string[];
  actionStart?: SourceActionStart;
}

/** Cover setup continuously, stopping before the exact action onset when available. */
export function sourcePreludeEvidence(
  book: Pick<ImportedBook, "chapters">, beats: readonly StoryEventBeat[], beatIndex: number,
): SourcePreludeEvidence {
  const beat = beats[beatIndex];
  if (!beat || beatIndex < 0) return {references: [], issues: ['Missing target beat.']};
  const previous = mergePreludeReferences(beats.slice(0, beatIndex).flatMap(b => b.sourceReferences));
  const target = mergePreludeReferences(beat.sourceReferences);
  // Validate all coordinates before using them as extraction boundaries.
  sourceExcerptForReferences(book, [...previous, ...target]);
  if (!target.length) return {references: previous, excerpt: previous.length ? sourceExcerptForReferences(book, previous) : undefined,
    issues: ['Target beat has no source boundary; preceding references alone cannot prove complete setup.']};
  const explicit = beat.sourceActionStart;
  if (explicit) validateSourceActionStart(book, beat, explicit);
  if (!previous.length && !explicit) return {references: [], issues: []};
  const boundary = explicit ?? {chapterPosition: target[0]!.chapterPosition,
    chapterIndex: target[0]!.chapterIndex, line: target[0]!.lineStart, column: 0, quote: ''};
  const first = mergePreludeReferences([...previous, ...target])[0]!;
  const overlapping = previous.some(r => r.chapterPosition > boundary.chapterPosition
    || (r.chapterPosition === boundary.chapterPosition && r.lineEnd >= boundary.line));
  const issues: string[] = [];
  for (const prior of beats.slice(0, beatIndex)) {
    if (!prior.sourceActionStart) continue;
    validateSourceActionStart(book, prior, prior.sourceActionStart);
    if (explicit && compareActionStarts(prior.sourceActionStart, explicit) > 0)
      issues.push('Action starts are out of order; a preceding beat begins after the pending action.');
  }
  if (overlapping && !explicit) issues.push('Evidence references overlap; an explicit reviewed action start is required to distinguish setup from the pending action.');
  const references: SourceReference[] = [];
  const passages: string[] = [];
  for (let position = first.chapterPosition; position <= boundary.chapterPosition; position++) {
    const chapter = book.chapters[position];
    if (!chapter) throw new Error(`Missing chapter ${position} in prelude`);
    const lines = chapter.text.trim().split(/\r?\n/);
    const lineStart = position === first.chapterPosition ? first.lineStart : 1;
    const lineEnd = position === boundary.chapterPosition ? boundary.line - (boundary.column ? 0 : 1) : lines.length;
    if (lineEnd < lineStart) continue;
    references.push({chapterPosition: position, chapterIndex: chapter.index, lineStart, lineEnd});
    const selected = lines.slice(lineStart - 1, lineEnd);
    if (position === boundary.chapterPosition && boundary.column)
      selected[selected.length - 1] = lines[boundary.line - 1]!.slice(0, boundary.column);
    passages.push(selected.join('\n'));
  }
  return {references, excerpt: passages.join('\n\n') || undefined, issues,
    ...(explicit ? {actionStart: explicit} : {}),
    ...(overlapping && explicit ? {warnings: ['Supporting evidence overlaps; extraction uses the exact action start instead of evidence range ends.']} : {})};
}

export function sourcePreludeForBeat(
  book: Pick<ImportedBook, "chapters">, beats: readonly StoryEventBeat[], beatIndex: number,
): string | undefined {
  if (!beats[beatIndex] || beatIndex < 0) return undefined;
  return sourcePreludeEvidence(book, beats, beatIndex).excerpt;
}

export function sourcePreludeEndStateForBeat(
  beats: readonly StoryEventBeat[],
  beatIndex: number,
): string | undefined {
  if (!beats[beatIndex] || beatIndex <= 0) return undefined;

  // A missing immediate checkpoint is unknown; an older state may be stale.
  return beats[beatIndex - 1]?.resultingState?.trim() || undefined;
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
        category: parseStoryEventCategory(event.category),
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
      category: event.category,
      chapterPosition: event.chapterPosition,
      actors: event.actors,
      targets: event.targets,
      ...(event.beats ? { beats: event.beats } : {}),
      sourceReferences: event.sourceReferences,
    };
  });
}
