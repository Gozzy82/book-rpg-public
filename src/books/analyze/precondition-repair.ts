import {ACTION_ENTRY_PHASE_POLICY} from "../../shared/source-transition-policy.js";
import type {ChapterPartSourceIndex} from '../source-index.js';
import type {ChapterAnalysisPart, CreateAnalysisResponse} from './batching.js';
import {isRecord, requireOutputText} from './output.js';
import {PlayerActionReviewRejection, preconditionSourceContexts, reviewPlayerActionGroups} from './player-action-review.js';

export interface PreconditionChange {
  eventIndex: number;
  beatIndex: number;
  before: string[];
  after: string[];
  reason: string;
  evidence: Array<{line: number; quote: string}>;
}

export class PreconditionRepairError extends Error {
  constructor(message: string, readonly diagnostics: unknown) { super(message); }
}

/** One narrow repair; source beats, goals, labels and group membership are immutable. */
export async function reviewAndRepairPreconditions(createResponse: CreateAnalysisResponse, model: string,
  part: ChapterAnalysisPart, original: ChapterPartSourceIndex): Promise<{index: ChapterPartSourceIndex; changes: PreconditionChange[]}> {
  let rejection: PlayerActionReviewRejection;
  try {
    await reviewPlayerActionGroups(createResponse, model, part, original);
    return {index: original, changes: []};
  } catch (error) {
    if (!(error instanceof PlayerActionReviewRejection) || error.issues.some(i => i.repairTarget === 'source')) throw error;
    rejection = error;
  }
  const contexts = preconditionSourceContexts(part, original);
  const allowed = new Set(rejection.issues.flatMap(issue => issue.beatIndexes.map(i => `${issue.eventIndex}:${i}`)));
  const response = await createResponse({model, reasoning: {effort: 'low'}, max_output_tokens: 4000,
    instructions: ACTION_ENTRY_PHASE_POLICY + '\n' + 'Repair only demonstrably incorrect preconditions in the rejected groups. Source actions, exact entry boundaries, labels, membership, endpoints and all other fields are immutable. Return changes only for conditions needing correction, not unchanged groups. Preserve necessary source-supported conditions. Consult earlier speech and concrete source implications; an independent sentence declaring a capacity is unnecessary. Remove future outcomes and optional assumptions, or replace them with actual source-supported starting requirements. A request need not presume acceptance. Each change needs a specific reason explaining removals/replacements and at least one exact supporting source quote with its line number strictly BEFORE that group’s entry (only the included prefix of a shared line is allowed). executionSource is supplied to distinguish in-action preparation from entry requirements. It can explain why an old condition is premature, but cannot prove that a new entry condition already holds. Cite only priorSource for replacement entry conditions. Do not use future results as evidence. Never remove all prerequisites just to evade review. If correction requires changing actions, groups, labels or boundaries, return an unresolved reason and no speculative workaround. Proposed corrections receive a full independent group review against the original conditions.',
    input: JSON.stringify({issues: rejection.issues, candidate: original, preconditionSourceContexts: contexts}),
    text: {format: {type: 'json_schema', name: 'source_precondition_repair', strict: true, schema: {
      type: 'object', additionalProperties: false, properties: {
        changes: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {
          eventIndex: {type: 'integer'}, beatIndex: {type: 'integer'}, preconditions: {type: 'array', items: {type: 'string'}}, reason: {type: 'string'},
          evidence: {type: 'array', minItems: 1, items: {type: 'object', additionalProperties: false, properties: {line: {type: 'integer'}, quote: {type: 'string'}}, required: ['line', 'quote']}},
        }, required: ['eventIndex', 'beatIndex', 'preconditions', 'reason', 'evidence']}},
        unresolved: {type: 'array', items: {type: 'string'}},
      }, required: ['changes', 'unresolved'],
    }}},
  });
  const value: unknown = JSON.parse(requireOutputText(response, 'precondition repair'));
  if (!isRecord(value) || !Array.isArray(value.changes) || !Array.isArray(value.unresolved)
    || value.unresolved.some(x => typeof x !== 'string') || Object.keys(value).some(k => !['changes', 'unresolved'].includes(k))) throw new Error('Invalid precondition repair');
  if (value.unresolved.length) throw new Error(`Precondition repair unresolved: ${value.unresolved.join('; ')}`);
  if (!value.changes.length) throw rejection;
  const candidate = structuredClone(original), changes: PreconditionChange[] = [], seen = new Set<string>();
  for (const item of value.changes) {
    if (!isRecord(item) || Object.keys(item).some(k => !['eventIndex', 'beatIndex', 'preconditions', 'reason', 'evidence'].includes(k))
      || !Number.isInteger(item.eventIndex) || !Number.isInteger(item.beatIndex)
      || !Array.isArray(item.preconditions) || item.preconditions.some(x => typeof x !== 'string' || !x.trim())
      || typeof item.reason !== 'string' || !item.reason.trim() || !Array.isArray(item.evidence) || !item.evidence.length) throw new Error('Invalid precondition change');
    const eventIndex = item.eventIndex as number, beatIndex = item.beatIndex as number, key = `${eventIndex}:${beatIndex}`;
    const action = candidate.significantEvents[eventIndex]?.beats[beatIndex]?.playerAction;
    const context = contexts.find(c => c.eventIndex === eventIndex && c.beatIndex === beatIndex);
    if (!allowed.has(key) || seen.has(key) || !action || !context?.boundary) throw new Error('Precondition repair changed an unreviewed or duplicate group');
    seen.add(key);
    const evidence = item.evidence.map(e => {
      if (!isRecord(e) || !Number.isInteger(e.line) || typeof e.quote !== 'string' || !e.quote.trim()
        || !context.priorSource.some(l => l.line === e.line && l.text.includes(e.quote as string))) {
        const line = isRecord(e) && Number.isInteger(e.line) ? e.line as number : null;
        throw new PreconditionRepairError('Precondition evidence is not present before the action', {
          reviewIssues: rejection.issues, proposedRepair: value, eventIndex, beatIndex,
          boundary: context.boundary, evidence: e,
          suppliedSourceLine: line === null ? null : part.text.split(/\r?\n/)[line - part.lineStart] ?? null,
          allowedPriorLine: context.priorSource.find(l => l.line === line)?.text ?? null,
        });
      }
      return {line: e.line as number, quote: e.quote};
    });
    const after = item.preconditions as string[];
    if (JSON.stringify(action.preconditions) === JSON.stringify(after)) throw new Error('Precondition repair returned an unchanged group');
    changes.push({eventIndex, beatIndex, before: [...action.preconditions], after: [...after], reason: item.reason, evidence});
    action.preconditions = [...after];
  }
  // No mutations escape until the full reviewer accepts the repaired groups.
  await reviewPlayerActionGroups(createResponse, model, part, candidate, original);
  return {index: candidate, changes};
}

/** A concrete supplied patch is reviewed as-is, never silently regenerated. */
export async function reviewRebuildCandidate(createResponse: CreateAnalysisResponse, model: string,
  part: ChapterAnalysisPart, index: ChapterPartSourceIndex, explicitPatch: boolean) {
  if (!explicitPatch) return reviewAndRepairPreconditions(createResponse, model, part, index);
  await reviewPlayerActionGroups(createResponse, model, part, index);
  return {index, changes: [] as PreconditionChange[]};
}
