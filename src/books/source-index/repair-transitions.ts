import type { ImportedBook, BookStoryEvent, StoryEventBeat } from '../../shared/contracts.js';
import { parsePlayerAction } from '../../shared/player-actions.js';
import { attachCharacterSignificantEvents } from './character-events.js';

export interface TransitionRepair {
  version: 1;
  sourceSha256: string;
  evidence: Array<{chapterPosition: number; lineStart: number; lineEnd: number; text: string}>;
  events: Array<{eventId: string; expectedActions: string[]; replacementBeats?: StoryEventBeat[];
    resultingStates?: Array<{beatIndex: number; resultingState: string}>}>;
}
const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();
const clean = (event: BookStoryEvent): BookStoryEvent => ({...event, beats: event.beats?.map(b => {
  const {automaticPreludeEndState: _state, automaticPreludeSourceExcerpt: _excerpt, ...beat} = b as StoryEventBeat & {automaticPreludeSourceExcerpt?: string};
  return beat;
})});

/** Explicit source-reviewed migration only; no runtime heuristics or model calls. */
export function repairSourceTransitions(original: ImportedBook, patch: TransitionRepair): ImportedBook {
  if (patch.version !== 1 || patch.sourceSha256 !== original.sourceSha256 || !patch.events?.length || !patch.evidence?.length)
    throw new Error('Repair requires the exact source fingerprint, evidence and event changes');
  const book = structuredClone(original);
  const checkReference = (r: {chapterPosition:number;lineStart:number;lineEnd:number}) => {
    const lines = book.chapters[r.chapterPosition]?.text.split(/\r?\n/);
    if (![r.chapterPosition,r.lineStart,r.lineEnd].every(Number.isInteger) || !lines || r.lineStart < 1 || r.lineEnd < r.lineStart || r.lineEnd > lines.length)
      throw new Error('Repair reference is outside the source');
    return lines.slice(r.lineStart-1,r.lineEnd).join('\n');
  };
  for (const evidence of patch.evidence) {
    if (!evidence.text?.trim() || !normalized(checkReference(evidence)).includes(normalized(evidence.text)))
      throw new Error('Repair evidence does not match the source');
  }
  const events = new Map<string,BookStoryEvent>();
  for (const event of [...(book.storyEvents ?? []), ...(book.worldBible?.characterProfiles ?? []).flatMap(p=>p.significantEvents ?? [])]) {
    const value = clean(event), previous = events.get(event.eventId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error(`Conflicting event copies: ${event.eventId}`);
    events.set(event.eventId,value);
  }
  const changed = new Set<string>();
  for (const change of patch.events) {
    const event = events.get(change.eventId);
    if (!event?.beats || changed.has(change.eventId) || JSON.stringify(event.beats.map(b=>b.action)) !== JSON.stringify(change.expectedActions))
      throw new Error(`Repair target changed or is missing: ${change.eventId}`);
    changed.add(change.eventId);
    if (Boolean(change.replacementBeats) === Boolean(change.resultingStates)) throw new Error('Choose replacement beats or state corrections');
    if (change.replacementBeats) event.beats = structuredClone(change.replacementBeats);
    for (const update of change.resultingStates ?? []) {
      if (!Number.isInteger(update.beatIndex) || !event.beats[update.beatIndex] || !update.resultingState?.trim()) throw new Error('Invalid state correction');
      event.beats[update.beatIndex]!.resultingState = update.resultingState;
    }
    if (!event.beats.length) throw new Error('Cannot remove every event beat');
    for (const [i,beat] of event.beats.entries()) {
      if (!(beat.actor === null || typeof beat.actor === 'string') || !beat.action?.trim() || !beat.resultingState?.trim()
        || !['intentional','involuntary','external','ambiguous'].includes(beat.agency)
        || !['routine','significant','critical'].includes(beat.stakes) || !Array.isArray(beat.targets)
        || !beat.targets.every(t=>typeof t==='string') || !beat.sourceReferences?.length) throw new Error('Invalid replacement beat');
      beat.sourceReferences.forEach(r=>{checkReference(r);if(r.chapterPosition!==event.chapterPosition)throw new Error('Repair must remain in the event chapter');});
      parsePlayerAction(beat.playerAction,i,event.beats);
      parsePlayerAction(beat.characterActionGroup,i,event.beats);
    }
    event.sourceReferences = event.beats.flatMap(b=>b.sourceReferences);
    event.actors = [...new Set(event.beats.flatMap(b=>b.actor ? [b.actor] : []))];
    event.targets = [...new Set(event.beats.flatMap(b=>b.targets))];
  }
  book.storyEvents = [...events.values()].sort((a,b)=>a.sequence-b.sequence);
  attachCharacterSignificantEvents(book);
  return book;
}
