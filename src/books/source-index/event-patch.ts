import {applyStructuralEventPatch} from './structural-event-patch.js';
import type {ImportedBook, PlayerAction} from '../../shared/contracts.js';
import {isRecord} from '../analyze/output.js';
import {validateSourceActionStart} from './story-events.js';

const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string' && !!s.trim());
const textFields = ['choiceText', 'completion', 'boundaryReason'] as const;
const listFields = ['preconditions', 'interruptWhen'] as const;

/** Explicit, source-locked maintenance patch; never modifies source actions or group membership. */
export function applyEventPatch(original: ImportedBook, value: unknown, eventId: string) {
  if (isRecord(value) && value.kind === "replace_event_beats") return applyStructuralEventPatch(original, value, eventId);
  if (!isRecord(value) || value.eventId !== eventId || !Array.isArray(value.beats) || !value.beats.length
    || !isRecord(value.source) || !Number.isInteger(value.source.chapterIndex)
    || !Number.isInteger(value.source.lineStart) || (value.source.lineStart as number) < 1
    || typeof value.source.text !== 'string' || !value.source.text.trim()
    || Object.keys(value).some(k => !['eventId', 'source', 'beats'].includes(k))) throw new Error('Invalid targeted event patch');
  const book = structuredClone(original);
  const copies = [...(book.storyEvents ?? []), ...(book.worldBible?.characterProfiles?.flatMap(p => p.significantEvents ?? []) ?? [])]
    .filter(e => e.eventId === eventId);
  if (!copies.length) throw new Error('Patch event not found');
  const changes: unknown[] = [];
  for (const [copyIndex, event] of copies.entries()) {
    if (event.beats?.length !== value.beats.length) throw new Error('Patch beat count differs from stored event');
    const chapter = book.chapters[event.chapterPosition];
    const lines = chapter?.text.trim().split(/\r?\n/);
    const evidenceStart = value.source.lineStart as number;
    const evidenceLines = value.source.text.split(/\r?\n/);
    if (!chapter || chapter.index !== value.source.chapterIndex
      || lines!.slice(evidenceStart - 1, evidenceStart - 1 + evidenceLines.length).join('\n') !== evidenceLines.join('\n'))
      throw new Error('Patch source does not match this book');
    for (const [i, raw] of value.beats.entries()) {
      if (!isRecord(raw) || !isRecord(raw.expected) || !isRecord(raw.start) || !isRecord(raw.playerAction)
        || typeof raw.resultingState !== 'string' || !raw.resultingState.trim()
        || typeof raw.decisionBoundaryBefore !== 'string' || !raw.decisionBoundaryBefore.trim()
        || Object.keys(raw).some(k => !['expected', 'start', 'resultingState', 'decisionBoundaryBefore', 'playerAction'].includes(k)))
        throw new Error('Invalid patch beat');
      const beat = event.beats![i]!;
      const references = beat.sourceReferences.map(({chapterIndex, lineStart, lineEnd}) => ({chapterIndex, lineStart, lineEnd}));
      if (raw.expected.actor !== beat.actor || raw.expected.action !== beat.action
        || JSON.stringify(raw.expected.references) !== JSON.stringify(references)
        || beat.sourceReferences.some(r => r.chapterPosition !== event.chapterPosition
          || r.lineStart < evidenceStart || r.lineEnd >= evidenceStart + evidenceLines.length))
        throw new Error(`Patch identity or evidence mismatch at beat ${i}`);
      const start = {chapterPosition: event.chapterPosition, chapterIndex: chapter.index,
        line: raw.start.line as number, column: raw.start.column as number, quote: raw.start.quote as string};
      validateSourceActionStart(book, beat, start);
      if (start.line < evidenceStart || start.line >= evidenceStart + evidenceLines.length) throw new Error('Patch start outside supplied evidence');
      const update = raw.playerAction;
      if (Object.keys(update).some(k => ![...textFields, ...listFields].includes(k as any))
        || textFields.some(k => typeof update[k] !== 'string' || !update[k].trim())
        || listFields.some(k => !stringArray(update[k]))) throw new Error('Patch may only replace action descriptions and conditions');
      const patchAction = (action: PlayerAction) => {
        if (action.endBeatIndex !== i || action.playerBeatIndexes.length !== 1 || action.playerBeatIndexes[0] !== i)
          throw new Error(`Patch does not match singleton group at beat ${i}`);
        for (const k of textFields) action[k] = update[k] as string;
        for (const k of listFields) action[k] = [...update[k] as string[]];
      };
      if (!beat.playerAction) throw new Error(`Patch requires existing action at beat ${i}`);
      const before = structuredClone(beat);
      patchAction(beat.playerAction);
      // Preserve disabled character actions; update compatible explicit overrides too.
      if (beat.characterActionGroup) patchAction(beat.characterActionGroup);
      beat.sourceActionStart = start;
      beat.resultingState = raw.resultingState;
      beat.decisionBoundaryBefore = raw.decisionBoundaryBefore;
      if (JSON.stringify(before) !== JSON.stringify(beat)) changes.push({copyIndex, beatIndex: i, before, after: structuredClone(beat)});
    }
  }
  return {book, changes, affectedCopies: copies.length};
}
