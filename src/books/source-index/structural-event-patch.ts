import type {ImportedBook, StoryEventBeat} from '../../shared/contracts.js';
import {parsePlayerAction} from '../../shared/player-actions.js';
import {isRecord} from '../analyze/output.js';
import {validateSourceActionStart} from './story-events.js';

const core = (beats: readonly StoryEventBeat[]) => beats.map(({sourceActionStart, automaticPreludeEndState, ...beat}) => {
  const copy = {...beat} as Record<string, unknown>;
  delete copy.automaticPreludeSourceExcerpt;
  return copy;
});
const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isRecord(a) && isRecord(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => equal(a[k], b[k]));
  return a === b;
};
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim();

/** Explicit replacement only: exact old beats and source must match every copy.
 * No saved-game cursor migration; callers must require a new game afterwards.
 */
export function applyStructuralEventPatch(original: ImportedBook, raw: Record<string, unknown>, eventId: string) {
  if (raw.kind !== 'replace_event_beats' || raw.eventId !== eventId || !isRecord(raw.source)
    || !Array.isArray(raw.expectedBeats) || !raw.expectedBeats.length || !Array.isArray(raw.beats) || !raw.beats.length
    || Object.keys(raw).some(k => !['kind', 'eventId', 'source', 'expectedBeats', 'beats'].includes(k)))
    throw new Error('Invalid structural event patch');
  const book = structuredClone(original);
  const copies = [...(book.storyEvents ?? []), ...(book.worldBible?.characterProfiles?.flatMap(p => p.significantEvents ?? []) ?? [])]
    .filter(e => e.eventId === eventId);
  if (!copies.length) throw new Error('Patch event not found');
  if (copies.some(e => e.chapterPosition !== copies[0]!.chapterPosition || e.description !== copies[0]!.description))
    throw new Error('Inconsistent structural event copies');
  const first = copies[0]!, chapter = book.chapters[first.chapterPosition];
  const start = raw.source.lineStart as number, source = raw.source.text;
  if (!chapter || chapter.index !== raw.source.chapterIndex || !Number.isInteger(start) || start < 1 || !nonempty(source))
    throw new Error('Invalid structural patch source');
  const lines = source.split(/\r?\n/);
  if (chapter.text.trim().split(/\r?\n/).slice(start - 1, start - 1 + lines.length).join('\n') !== lines.join('\n'))
    throw new Error('Patch source does not match this book');
  const names = new Set([...(book.worldBible?.characterProfiles?.flatMap(p => [p.name, ...p.aliases]) ?? []),
    ...first.actors, ...first.targets]);
  const beats = structuredClone(raw.beats) as StoryEventBeat[];
  let lastLine = 0, lastColumn = 0;
  for (const [i, beat] of beats.entries()) {
    if (!isRecord(beat) || !nonempty(beat.action) || !nonempty(beat.resultingState)
      || !(beat.actor === null || names.has(beat.actor)) || !Array.isArray(beat.targets) || beat.targets.some(t => !names.has(t))
      || !['intentional', 'involuntary', 'external', 'ambiguous'].includes(beat.agency)
      || !['routine', 'significant', 'critical'].includes(beat.stakes)
      || Object.keys(beat).some(k => !['actor','action','targets','agency','stakes','resultingState','sourceReferences','sourceActionStart','playerAction','decisionBoundaryBefore'].includes(k))
      || !Array.isArray(beat.sourceReferences) || !beat.sourceReferences.length
      || beat.sourceReferences.some(r => r.chapterPosition !== first.chapterPosition || r.chapterIndex !== chapter.index
        || !Number.isInteger(r.lineStart) || !Number.isInteger(r.lineEnd) || r.lineStart < start || r.lineEnd < r.lineStart || r.lineEnd >= start + lines.length))
      throw new Error(`Invalid structural replacement beat ${i}`);
    if (!beat.sourceActionStart) throw new Error(`Missing action boundary at beat ${i}`);
    validateSourceActionStart(book, beat, beat.sourceActionStart);
    const boundary = beat.sourceActionStart;
    if (boundary.line < lastLine || (boundary.line === lastLine && boundary.column < lastColumn)) throw new Error('Replacement action starts are out of order');
    lastLine = boundary.line; lastColumn = boundary.column;
    if (beat.playerAction) beat.playerAction = parsePlayerAction(beat.playerAction, i, beats);
  }
  const expected = core(raw.expectedBeats as StoryEventBeat[]);
  const replacement = core(beats);
  const chapterCopies = (chapter.sourceIndex?.significantEvents ?? []).filter(e => e.description === first.description);
  const allCopies = [...copies, ...chapterCopies];
  const changes: unknown[] = [];
  for (const [copyIndex, event] of allCopies.entries()) {
    const current = core(event.beats ?? []);
    const alreadyApplied = equal(current, replacement);
    if (!alreadyApplied && !equal(current, expected)) throw new Error(`Structural patch stale or incompatible at copy ${copyIndex}`);
    if (!alreadyApplied) changes.push({copyIndex, before: structuredClone(event.beats), after: structuredClone(beats)});
    event.beats = structuredClone(beats);
    event.actors = [...new Set(beats.flatMap(b => b.actor ? [b.actor] : []))];
    event.targets = [...new Set(beats.flatMap(b => b.targets))];
    event.sourceReferences = [{chapterPosition: first.chapterPosition, chapterIndex: chapter.index, lineStart: start, lineEnd: start + lines.length - 1}];
  }
  return {book, changes, affectedCopies: allCopies.length};
}
