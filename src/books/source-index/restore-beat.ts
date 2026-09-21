import type {ImportedBook, BookStoryEvent, StoryEventBeat} from "../../shared/contracts.js";
import {attachCharacterSignificantEvents} from "./character-events.js";

const core = (event: BookStoryEvent) => JSON.stringify({...event, beats: event.beats?.map(beat => {
  const {automaticPreludeEndState: _state, automaticPreludeSourceExcerpt: _excerpt, ...rest} = beat as StoryEventBeat & {automaticPreludeSourceExcerpt?: string};
  return rest;
})});

/** Restore an explicitly selected, uncovered source beat at an existing event's
 * tail. Never regenerate models, renumber events, or shift existing group indexes. */
export function restoreSourceBeat(original: ImportedBook, sequence: number, source: [number, number, number]): ImportedBook {
  const book = structuredClone(original);
  const [chapter, eventIndex, beatIndex] = source;
  const sourceBeat = book.chapters[chapter]?.sourceIndex?.significantEvents?.[eventIndex]?.beats?.[beatIndex];
  if (!sourceBeat?.resultingState?.trim() || !sourceBeat.sourceReferences?.length) throw new Error("Source beat requires references and resultingState");
  const events = new Map<string, BookStoryEvent>((book.storyEvents ?? []).map(e => [e.eventId, e]));
  for (const profile of book.worldBible?.characterProfiles ?? []) for (const e of profile.significantEvents ?? []) {
    const previous = events.get(e.eventId);
    if (previous && core(previous) !== core(e)) throw new Error(`Conflicting event copies: ${e.eventId}`);
    if (!previous) events.set(e.eventId, e);
  }
  book.storyEvents = [...events.values()].sort((a,b) => a.sequence - b.sequence);
  const matches = book.storyEvents.filter(e => e.sequence === sequence);
  if (matches.length !== 1) throw new Error("Target event sequence is missing or ambiguous");
  const target = matches[0]!;
  const refs = sourceBeat.sourceReferences;
  if (target.chapterPosition !== chapter || refs.some(r => r.chapterPosition !== chapter)) throw new Error("Restoration must remain in one chapter");
  const start = Math.min(...refs.map(r => r.lineStart)), end = Math.max(...refs.map(r => r.lineEnd));
  const chapterEvents = book.storyEvents.filter(e => e.chapterPosition === chapter);
  if (chapterEvents.some(e => e.beats?.some(b => b.sourceReferences.some(r => r.chapterPosition === chapter && r.lineStart <= end && r.lineEnd >= start))))
    throw new Error("Source range already covered or overlaps existing beats; no automatic restoration");
  const tail = Math.max(...(target.beats ?? []).flatMap(b => b.sourceReferences.map(r => r.lineEnd)));
  const nextStart = Math.min(...chapterEvents.filter(e => e.sequence > sequence).flatMap(e => e.sourceReferences.map(r => r.lineStart)));
  if (!Number.isFinite(tail) || start <= tail || end >= nextStart) throw new Error("Source beat is not in the gap after the target event");
  const {playerAction: _action, ...plain} = sourceBeat;
  const restored = structuredClone(plain) as StoryEventBeat;
  delete restored.characterActionGroup;
  target.beats = [...target.beats!, restored];
  target.sourceReferences = [...target.sourceReferences, ...refs];
  target.actors = [...new Set([...target.actors, ...(restored.actor ? [restored.actor] : [])])];
  target.targets = [...new Set([...target.targets, ...restored.targets])];
  attachCharacterSignificantEvents(book);
  return book;
}
