import type { ImportedBook, BookStoryEvent } from '../../shared/contracts.js';
import { sourcePreludeEvidence, sourcePreludeEndStateForBeat } from './story-events.js';

export function rebuildSourcePreludes(original: ImportedBook, eventId?: string) {
  const book = structuredClone(original);
  const report: Array<{eventId: string; character: string | null; beatIndex: number; preconditions: string[]; references: ReturnType<typeof sourcePreludeEvidence>['references']; issues: string[]; warnings?: string[]; actionStart?: ReturnType<typeof sourcePreludeEvidence>['actionStart']}> = [];
  const identity = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const rebuild = (event: BookStoryEvent, character: string | null, identities: string[]) => {
    if (eventId && event.eventId !== eventId) return;
    for (const [beatIndex, beat] of (event.beats ?? []).entries()) {
      const evidence = sourcePreludeEvidence(book, event.beats!, beatIndex);
      report.push({eventId: event.eventId, character, beatIndex,
        preconditions: [...(beat.playerAction?.preconditions ?? [])], references: evidence.references, issues: evidence.issues, warnings: evidence.warnings, actionStart: evidence.actionStart});
      if (character === null) continue;
      const enriched = beat as typeof beat & {automaticPreludeSourceExcerpt?: string};
      delete enriched.automaticPreludeSourceExcerpt;
      delete enriched.automaticPreludeEndState;
      if (!beat.actor || !identities.includes(identity(beat.actor))) continue;
      if (evidence.excerpt) enriched.automaticPreludeSourceExcerpt = evidence.excerpt;
      const checkpoint = sourcePreludeEndStateForBeat(event.beats!, beatIndex);
      if (checkpoint) enriched.automaticPreludeEndState = checkpoint;
    }
  };
  if (!book.storyEvents?.length && !book.worldBible?.characterProfiles?.some(p => p.significantEvents?.length)) throw new Error('Book has no indexed events to rebuild.');
  for (const event of book.storyEvents ?? []) rebuild(event, null, []);
  for (const profile of book.worldBible?.characterProfiles ?? []) {
    for (const event of profile.significantEvents ?? []) rebuild(event, profile.name, [profile.name, ...profile.aliases].map(identity));
  }
  if (eventId && !report.length) throw new Error(`Unknown or empty event ${eventId}`);
  return {book, report};
}
