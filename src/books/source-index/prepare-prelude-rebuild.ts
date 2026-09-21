import type {ImportedBook} from '../../shared/contracts.js';
import type {ChapterPartSourceIndex} from '../source-index.js';
import type {CreateAnalysisResponse} from '../analyze/batching.js';
import {PlayerActionReviewRejection, reviewPlayerActionGroups} from '../analyze/player-action-review.js';
import {ActionBoundaryReviewError, actionBoundaryKey, resolveActionBoundaries} from './action-boundaries.js';
import {applyEventPatch} from './event-patch.js';
import {rebuildSourcePreludes} from './rebuild-preludes.js';

/** Prepare a scoped rebuild; persistence and backups remain with the caller. */
export async function preparePreludeRebuild(original: ImportedBook, options: {
  eventId?: string; eventPatch?: unknown; model: string; createResponse?: CreateAnalysisResponse;
}) {
  const {eventId, model, createResponse} = options;
  const review = !!createResponse;
  if (options.eventPatch !== undefined && !eventId) throw new Error('An event patch requires an explicit event ID.');
  const eventPatch = options.eventPatch === undefined ? undefined : applyEventPatch(original, options.eventPatch, eventId!);
  const candidate = eventPatch?.book ?? structuredClone(original);
  const events = [...(candidate.storyEvents ?? []), ...(candidate.worldBible?.characterProfiles?.flatMap(p => p.significantEvents ?? []) ?? [])]
    .filter(event => !eventId || event.eventId === eventId);
  if (!events.length) throw new Error('No matching indexed events.');
  const issues: unknown[] = [];
  const boundaryAudited: string[] = [];
  const boundaryPreconditionIssues: unknown[] = [];
  const audited: string[] = [];
  if (review && (options.eventPatch as {kind?: string} | undefined)?.kind === 'replace_event_beats') {
    const patch = options.eventPatch as {source: unknown; expectedBeats: unknown; beats: unknown};
    try {
      const response = await createResponse!({model, reasoning: {effort: 'low'},
        instructions: "Review a targeted source-index correction against the exact supplied book passage. Check the complete replacement beat sequence: source support, chronological order, missing causal setup and crossings, actors, current locations and outcomes, meaningful player agency and action group boundaries. Report false for unsupported additions, skipped transitions or player decisions performed by another actor. Ordinary connective narration may be routine. Do not demand literal quotes in action descriptions. SourceActionStart points to where an action begins, not its completion. Do not rewrite. Return valid and a concise reason.",
        input: JSON.stringify({source: patch.source, oldBeats: patch.expectedBeats, replacementBeats: patch.beats}),
        text: {format: {type: 'json_schema', name: 'bookrpg_structural_event_patch_review', strict: true,
          schema: {type: 'object', additionalProperties: false, properties: {valid: {type: 'boolean'}, reason: {type: 'string'}}, required: ['valid', 'reason']}}},
        max_output_tokens: 2000});
      if (response.status === 'incomplete') throw new Error('Structural patch review incomplete');
      const verdict = JSON.parse(response.output_text);
      if (verdict.valid !== true || typeof verdict.reason !== 'string' || !verdict.reason.trim())
        throw new Error(verdict.reason || 'Structural patch review did not approve');
    } catch (error) { issues.push({eventId, stage: 'structural_patch', reason: String(error)}); }
  }
  if (review && !issues.length) {
    const groups = new Map<string, typeof events>();
    for (const event of events) {
      const key = actionBoundaryKey(event);
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    for (const copies of groups.values()) {
      const event = copies[0]!;
      try {
        const starts = await resolveActionBoundaries(createResponse!, model, candidate, event, (stage, notes) => {
          boundaryPreconditionIssues.push({eventId: event.eventId, stage, issues: notes});
        }, eventPatch ? event.beats!.map(b => b.sourceActionStart!) : undefined);
        for (const copy of copies) copy.beats!.forEach((beat, i) => { beat.sourceActionStart = {...starts[i]!}; });
        boundaryAudited.push(event.eventId);
      } catch (error) { issues.push({eventId: event.eventId, stage: 'action_boundaries', reason: String(error), ...(error instanceof ActionBoundaryReviewError ? {diagnostics: error.diagnostics} : {})}); }
    }
  }
  const rebuilt = rebuildSourcePreludes(candidate, eventId);
  const conditionRepairs: unknown[] = [];
  // Report the same underlying defect once, with the affected copies attached.
  const structural = new Map<string, {eventId: string; beatIndex: number; issues: string[]; characters: Array<string | null>}>();
  for (const row of rebuilt.report.filter(row => row.issues.length)) {
    const key = JSON.stringify([row.eventId, row.beatIndex, row.references, row.issues]);
    const entry = structural.get(key) ?? {eventId: row.eventId, beatIndex: row.beatIndex, issues: row.issues, characters: []};
    entry.characters.push(row.character); structural.set(key, entry);
  }
  issues.push(...structural.values());
  let groupReviewStarted = false;
  if (review && eventPatch && !issues.length) {
    groupReviewStarted = true;
    const effectiveBeats = (event: typeof events[number]) => event.beats!.map(({characterActionGroup, ...b}) => ({...b,
      playerAction: characterActionGroup !== undefined ? characterActionGroup ?? undefined : b.playerAction}));
    const groups = new Map<string, typeof events>();
    for (const event of events) {
      if (!event.beats?.length || !effectiveBeats(event).some(b => b.playerAction)) continue;
      const key = JSON.stringify({eventId: event.eventId, beats: effectiveBeats(event).map(b => {
        const copy = {...b} as Record<string, unknown>;
        delete copy.automaticPreludeSourceExcerpt; delete copy.automaticPreludeEndState;
        return copy;
      })});
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    for (const copies of groups.values()) {
      const event = copies[0]!;
      const positions = new Set(event.beats!.flatMap(b => b.sourceReferences.map(r => r.chapterPosition)));
      if (positions.size !== 1) { issues.push({eventId: event.eventId, reason: 'Cross-chapter event needs a targeted source-boundary review before applying.'}); continue; }
      const position = [...positions][0]!, chapter = rebuilt.book.chapters[position]!;
      const ranges = (refs: typeof event.sourceReferences) => refs.map(({lineStart, lineEnd}) => ({lineStart, lineEnd}));
      const index: ChapterPartSourceIndex = {summary: event.description, characters: [], actions: [], relationships: [], significantEvents: [{description: event.description,
        actors: event.actors, targets: event.targets, references: ranges(event.sourceReferences),
        beats: effectiveBeats(event).map(({sourceReferences, ...beat}) => ({...beat, references: ranges(sourceReferences)}))}]};
      try {
        await reviewPlayerActionGroups(createResponse!, model, {sourceId: event.eventId, chapterPosition: position, chapterIndex: chapter.index,
          chapterTitle: chapter.title, partIndex: 0, partCount: 1, lineStart: 1, lineEnd: chapter.text.trim().split(/\r?\n/).length, text: chapter.text.trim()}, index);
        audited.push(event.eventId);
      } catch (error) { issues.push({eventId: event.eventId, stage: 'player_action_groups', reason: String(error), ...(error instanceof PlayerActionReviewRejection ? {reviewIssues: error.issues} : {})}); }
    }
  }
  const reviewed = review && !issues.length;
  const reviewStatus = !review ? 'not_requested' : reviewed ? 'passed' : 'failed';
  const reviewScope = eventPatch ? 'event_patch' : 'preludes';
  const groupReviewStatus = !eventPatch || !review ? 'not_requested' : groupReviewStarted ? reviewStatus : 'blocked';
  return {book: rebuilt.book, report: {reviewRequested: review, reviewed, reviewStatus, reviewScope, groupReviewStatus,
    eventId: eventId ?? null, boundaryAudited, boundaryPreconditionIssues, audited, conditionRepairs,
    eventPatch: eventPatch ? {affectedCopies: eventPatch.affectedCopies, changes: eventPatch.changes} : null,
    coverage: rebuilt.report, issues}};
}
