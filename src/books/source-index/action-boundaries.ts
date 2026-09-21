import {ACTION_ENTRY_PHASE_POLICY} from "../../shared/source-transition-policy.js";
import type {BookStoryEvent, ImportedBook, SourceActionStart} from '../../shared/contracts.js';
import type {CreateAnalysisResponse} from '../analyze/batching.js';
import {isRecord, requireOutputText} from '../analyze/output.js';
import {sourcePreludeEvidence, validateSourceActionStart} from './story-events.js';

export class ActionBoundaryReviewError extends Error {
  constructor(message: string, readonly diagnostics: unknown) { super(message); }
}

// Metadata defects belong to the later full group review/condition repair, not
// to the decision whether the source action has a reliable starting boundary.
const BOUNDARY_STAGE_POLICY = 'This stage resolves source action boundaries, not prerequisite metadata. Report incorrect indexed preconditions separately in preconditionIssues, while still returning all reliably supported starts. In particular, boarding that occurs after the player commits to carrying is execution setup, not a reason to reject that commitment as the boundary. Never move the start past a player commitment to satisfy a stale condition. Reserve issues for actual ambiguous/wrong boundaries, performed actions in preludes, or missing source setup required BEFORE beginning the bounded goal. A missing requirement only for a later execution step is not missing entry setup. Precondition findings are separate index-metadata findings, not boundary failures. A prelude-only rebuild reports them without changing conditions or certifying the whole index. Explicit event patches receive their own full group review. These notes never authorize changes or excuse a genuinely invalid boundary.';
const validPreconditionIssues = (value: unknown): value is string[] | undefined => value === undefined
  || (Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim().length > 0));

/** Copies with different player groups still share the same underlying actions. */
export const actionBoundaryKey = (event: BookStoryEvent) => JSON.stringify({eventId: event.eventId,
  beats: event.beats?.map(b => ({actor: b.actor, action: b.action, sourceReferences: b.sourceReferences}))});

export async function resolveActionBoundaries(createResponse: CreateAnalysisResponse, model: string,
  book: ImportedBook, event: BookStoryEvent, reportPreconditionIssues?: (stage: 'proposal' | 'review', issues: string[]) => void, suppliedStarts?: SourceActionStart[]): Promise<SourceActionStart[]> {
  const beats = event.beats ?? [];
  if (!beats.length) throw new Error('Cannot resolve an event without beats.');
  const positions = [...new Set(beats.flatMap(b => b.sourceReferences.map(r => r.chapterPosition)))].sort((a, b) => a - b);
  const source = positions.map(position => {
    const chapter = book.chapters[position];
    if (!chapter) throw new Error(`Missing chapter ${position}`);
    return {chapterPosition: position, chapterIndex: chapter.index, title: chapter.title,
      lines: chapter.text.trim().split(/\r?\n/).map((text, i) => ({line: i + 1, text}))};
  });
  const context = JSON.stringify({source, event: {eventId: event.eventId, description: event.description,
    beats: beats.map((b, beatIndex) => ({...b, beatIndex}))}});
  const proposals: unknown[] = [];
  const starts: SourceActionStart[] = [];
  let coordinateFeedback = '';
  const proposalFail = (message: string, details: unknown = null): never => {
    throw new ActionBoundaryReviewError(message, {proposals, details});
  };
  // One correction of literal coordinates, never a retry of a semantic rejection.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = suppliedStarts ? {output_text: JSON.stringify({starts: suppliedStarts.map((start, beatIndex) => ({
      beatIndex, chapterPosition: start.chapterPosition, line: start.line, quote: start.quote,
    })), issues: [], preconditionIssues: []})} : await createResponse({model, reasoning: {effort: 'low'}, max_output_tokens: 8000,
      instructions: ACTION_ENTRY_PHASE_POLICY + '\n' + BOUNDARY_STAGE_POLICY + '\n' + 'Locate the exact START of each indexed action in the source. Source references are supporting evidence, not execution boundaries. When a reference begins mid-sentence, its action may start on the immediately preceding source line if the suffix from that start continues without a sentence terminator into the reference. Select the true onset there; do not force it onto the first referenced line. Keep the original references unchanged. Return one entry per beat. Choose a unique exact quote within one numbered source line, beginning at the FIRST character of the action (include its opening quotation mark for speech). Do not choose a later sentence after the action has already begun. Setup such as another actor asking a question belongs BEFORE the answer action, even inside the same reference or line. Later corroborating references do not establish onset. Preserve every action, actor, group and source reference. If an action cannot be separated reliably (including compound or retrospective actions), return an issue instead of inventing a boundary. Do not infer actions from preconditions alone. Copy a short, unique prefix of the action verbatim from ONE supplied source line, preserving punctuation and Unicode quotation marks. Never join adjacent lines into a quote. chapterPosition is the supplied array position, not chapterIndex. If LITERAL COORDINATE ERRORS are supplied, correct only those entries and keep all locked starts unchanged.',
      input: context + coordinateFeedback,
      text: {format: {type: 'json_schema', name: 'source_action_boundaries', strict: true, schema: {
        type: 'object', additionalProperties: false, properties: {
          starts: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {
            beatIndex: {type: 'integer'}, chapterPosition: {type: 'integer'}, line: {type: 'integer'}, quote: {type: 'string'},
          }, required: ['beatIndex', 'chapterPosition', 'line', 'quote']}},
          issues: {type: 'array', items: {type: 'string'}},
          preconditionIssues: {type: 'array', items: {type: 'string'}},
        }, required: ['starts', 'issues', 'preconditionIssues']}}},
    });
    let candidate: unknown;
    try { candidate = JSON.parse(requireOutputText(response, 'source action boundaries')); }
    catch (error) { return proposalFail(`Invalid action boundary response: ${String(error)}`); }
    proposals.push(candidate);
    if (!isRecord(candidate) || !Array.isArray(candidate.starts) || !Array.isArray(candidate.issues)
      || candidate.issues.some(x => typeof x !== 'string') || !validPreconditionIssues(candidate.preconditionIssues)) return proposalFail('Invalid action boundary response');
    if (candidate.preconditionIssues?.length) reportPreconditionIssues?.('proposal', candidate.preconditionIssues);
    if (candidate.issues.length) return proposalFail(`Unresolved action boundaries: ${candidate.issues.join('; ')}`);
    if (candidate.starts.length !== beats.length) return proposalFail('Missing or duplicate action boundaries');
    const seen = new Set<number>();
    const coordinateErrors: unknown[] = [];
    for (const item of candidate.starts) {
      if (!isRecord(item) || !Number.isInteger(item.beatIndex) || !Number.isInteger(item.chapterPosition)
        || !Number.isInteger(item.line) || typeof item.quote !== 'string' || !item.quote.trim()) return proposalFail('Invalid action boundary coordinates', item);
      const i = item.beatIndex as number, position = item.chapterPosition as number, lineNumber = item.line as number;
      if (!beats[i] || seen.has(i)) return proposalFail('Invalid or duplicate boundary beat', item);
      seen.add(i);
      const locked = starts[i];
      if (locked && (position !== locked.chapterPosition || lineNumber !== locked.line || item.quote !== locked.quote))
        return proposalFail('Coordinate correction changed a locked boundary', {item, locked});
      const chapter = book.chapters[position], line = chapter?.text.trim().split(/\r?\n/)[lineNumber - 1];
      const column = line?.indexOf(item.quote) ?? -1;
      const reason = !chapter ? 'missing_chapter' : line === undefined ? 'missing_line'
        : column < 0 ? 'quote_not_in_line' : line.indexOf(item.quote, column + 1) !== -1 ? 'ambiguous_quote' : null;
      if (reason) {
        coordinateErrors.push({beatIndex: i, chapterPosition: position, line: lineNumber, quote: item.quote,
          reason, sourceLine: line ?? null, sourceReferences: beats[i]!.sourceReferences});
        continue;
      }
      const start = {chapterPosition: position, chapterIndex: chapter!.index, line: lineNumber, column, quote: item.quote};
      try { validateSourceActionStart(book, beats[i]!, start); }
      catch (error) { return proposalFail(String(error), {item, sourceLine: line}); }
      starts[i] = start;
    }
    if (!coordinateErrors.length) break;
    if (suppliedStarts || attempt === 1) return proposalFail('Boundary quote is missing or ambiguous after coordinate correction', coordinateErrors);
    coordinateFeedback = `\nLITERAL COORDINATE ERRORS:\n${JSON.stringify({previousProposal: candidate, errors: coordinateErrors,
      lockedStarts: starts.flatMap((start, beatIndex) => start ? [{beatIndex, ...start}] : [])})}\nReturn the complete proposal with only failed coordinates corrected from the supplied numbered source. Preserve every locked start and all semantic issues. This correction does not approve a boundary; the independent full audit follows.`;
  }
  const resolved = beats.map((b, i) => ({...b, sourceActionStart: starts[i]!}));
  const preludes = resolved.map((_, i) => ({beatIndex: i, ...sourcePreludeEvidence(book, resolved, i)}));
  const errors = preludes.flatMap(p => p.issues);
  if (errors.length) throw new Error(errors.join('; '));
  // Give the reviewer the actual string split, not just coordinates it might
  // mistakenly interpret as inclusive line ranges.
  const exactPreludes = preludes.map((prelude, i) => {
    const start = starts[i]!;
    const line = book.chapters[start.chapterPosition]!.text.trim().split(/\r?\n/)[start.line - 1]!;
    return {...prelude,
      pendingBeat: {beatIndex: i, actor: beats[i]!.actor, action: beats[i]!.action},
      precedingBeats: beats.slice(0, i).map((beat, beatIndex) => ({beatIndex, actor: beat.actor, action: beat.action})),
      excerptRole: 'Cumulative source evidence before pendingBeat, not a new scene or a replay instruction.',
      boundaryLine: {
      includedPrefix: line.slice(0, start.column),
      excludedActionAndRemainder: line.slice(start.column),
    }};
  });
  const reviews: unknown[] = [];
  let correction = '';
  const fail = (message: string): never => {
    throw new ActionBoundaryReviewError(message, {proposals, starts, preludes: exactPreludes, reviews});
  };
  // Retry only unsupported literal evidence or a preceding-beat attribution. A genuine semantic
  // rejection is never discarded or converted into approval.
  for (let attempt = 0; attempt < 2; attempt++) {
    let verdict: unknown;
    try {
      const review = await createResponse({model, reasoning: {effort: 'low'}, max_output_tokens: 4000,
        instructions: ACTION_ENTRY_PHASE_POLICY + '\n' + BOUNDARY_STAGE_POLICY + '\n' + 'Independently audit every proposed action start and its extracted prelude against the source. Candidate boundaries are untrusted. Each start must be the FIRST performance of that beat, not a later repetition or consequence. Any necessary question, arrival, threat or other setup must be visible in the extracted prelude or already established before the event. The pending action must remain entirely unperformed in its prelude. Evaluate this RELATIVE TO each row’s pendingBeat. Excerpts are cumulative source evidence from the event start: precedingBeats may legitimately appear in a later beat’s excerpt. Their presence is NOT prelude_contains_action and does not authorize replaying them or marking anything completed at runtime. For example, Dorothy restoring the Scarecrow may be prior context for the Lion’s explanation; that explanation may be prior context for the Scarecrow’s later request. Only performance of the pending beat or a later beat is premature at that row. For prelude_contains_action, identify the actual performedBeatIndex as well as the beatIndex whose prelude is being evaluated. For all other issue kinds use performedBeatIndex=null. A literal quote alone does not prove that it performs the pending action. An evidence range can begin mid-sentence: a start on its immediately preceding line is structurally allowed only for a non-terminated continuation into that range. Independently verify that this prefix genuinely starts this action, not a different action; the range offset itself is not a rejection reason. Shared supporting ranges and later corroboration are not errors by themselves; compare actual action order and exact excerpts. Check all beats, including the first, same-line transitions and cross-chapter transitions. Flag compound beats that cannot have one valid entry. Do not approve based merely on a matching quote. The excerpt field is the EXACT prelude supplied to runtime. References describe supporting lines, not their full inclusion. boundaryLine.includedPrefix is included; excludedActionAndRemainder is NOT in the prelude. Do not reconstruct the excerpt by including the full boundary line. For a prelude_contains_action issue, preludeQuote must be a nonempty literal substring of that beat’s excerpt which itself demonstrates the performed action; never quote excluded source text as if included. For missing_setup, wrong_start or other issues, use preludeQuote=null and explain the source evidence in reason. Return valid=true only with an empty issues array.',
        input: `${context}\nPROPOSED STARTS AND EXACT PRELUDES:\n${JSON.stringify(exactPreludes)}${correction}`,
        text: {format: {type: 'json_schema', name: 'source_action_boundary_review', strict: true, schema: {
          type: 'object', additionalProperties: false, properties: {
            preconditionIssues: {type: 'array', items: {type: 'string'}},
            valid: {type: 'boolean'}, issues: {type: 'array', items: {
              type: 'object', additionalProperties: false, properties: {
                beatIndex: {type: 'integer'}, kind: {type: 'string', enum: ['prelude_contains_action', 'missing_setup', 'wrong_start', 'other']},
                performedBeatIndex: {type: ['integer', 'null'], description: 'The indexed action performed by the quoted text; not the prelude row index. Required for prelude_contains_action, otherwise null.'},
                reason: {type: 'string'}, preludeQuote: {type: ['string', 'null']},
              }, required: ['beatIndex', 'kind', 'reason', 'preludeQuote', 'performedBeatIndex'],
            }},
          }, required: ['valid', 'issues', 'preconditionIssues'],
        }}},
      });
      verdict = JSON.parse(requireOutputText(review, 'source action boundary review'));
    } catch (error) { fail(`Action boundary review failed: ${String(error)}`); }
    reviews.push(verdict);
    if (!isRecord(verdict) || typeof verdict.valid !== 'boolean' || !Array.isArray(verdict.issues)
      || verdict.valid !== (verdict.issues.length === 0) || !validPreconditionIssues(verdict.preconditionIssues)) return fail('Invalid action boundary review');
    if (verdict.preconditionIssues?.length) reportPreconditionIssues?.('review', verdict.preconditionIssues);
    const unsupported: string[] = [];
    const supportedReasons: string[] = [];
    for (const issue of verdict.issues) {
      if (!isRecord(issue) || !Number.isInteger(issue.beatIndex) || !beats[issue.beatIndex as number]
        || !['prelude_contains_action', 'missing_setup', 'wrong_start', 'other'].includes(String(issue.kind))
        || typeof issue.reason !== 'string' || !issue.reason.trim()
        || (issue.kind !== 'prelude_contains_action' && issue.preludeQuote !== null)) return fail('Invalid action boundary review issue');
      if (issue.performedBeatIndex !== undefined && (issue.kind === 'prelude_contains_action'
        ? !Number.isInteger(issue.performedBeatIndex) || !beats[issue.performedBeatIndex as number]
        : issue.performedBeatIndex !== null)) return fail('Invalid performed beat attribution');
      if (issue.kind === 'prelude_contains_action' && Number.isInteger(issue.performedBeatIndex)
        && (issue.performedBeatIndex as number) < (issue.beatIndex as number)) {
        unsupported.push(`Beat ${issue.beatIndex}: the cited action is preceding beat ${issue.performedBeatIndex}, which is allowed in cumulative source context. Recheck the pending beat and all other boundaries; history is not premature performance.`);
      } else if (issue.kind === 'prelude_contains_action' && (typeof issue.preludeQuote !== 'string'
        || !issue.preludeQuote.trim() || !exactPreludes[issue.beatIndex as number]!.excerpt?.includes(issue.preludeQuote))) {
        unsupported.push(`Beat ${issue.beatIndex}: alleged prelude quote ${JSON.stringify(issue.preludeQuote)} is not present in its exact excerpt.`);
      } else { supportedReasons.push(issue.reason); }
    }
    if (supportedReasons.length) return fail(`Action boundary review rejected: ${supportedReasons.join('; ')}`);
    if (unsupported.length) {
      if (attempt === 1) return fail(`Action boundary review has unsupported evidence: ${unsupported.join('; ')}`);
      correction = `\nLITERAL EVIDENCE CHECK FAILED:\n${JSON.stringify({previousVerdict: verdict, errors: unsupported})}\nPerform the full independent review again against the unchanged exact excerpts. Correct only unsupported claims; retain every genuine semantic issue. Do not approve merely because a quote was absent or belonged to an earlier beat. Reassess all starts for genuine early/late boundaries and missing necessary setup.`;
      continue;
    }
    if (!verdict.valid) return fail(`Action boundary review rejected: ${verdict.issues.map(issue => (issue as {reason: string}).reason).join('; ')}`);
    return starts;
  }
  return fail('Action boundary review did not complete');
}
