import { CONVERSATIONAL_REACH_POLICY } from "../../shared/conversational-reach-policy.js";
import { SOURCE_TRANSITION_POLICY } from "../../shared/source-transition-policy.js";
import { PLAYER_ACTION_ACTOR_POLICY, PLAYER_ACTION_GROUP_POLICY } from "./player-action-actor-policy.js";
import type { ChapterPartSourceIndex } from "../source-index.js";
import type { ChapterAnalysisPart, CreateAnalysisResponse } from "./batching.js";
import { formatAnalysisPart } from "./batching.js";
import { isRecord, requireOutputText } from "./output.js";

export interface PlayerActionReviewIssue {
  eventIndex: number;
  beatIndexes: number[];
  repairTarget: "player_action" | "source";
  reason: string;
}

export class PlayerActionReviewRejection extends Error {
  constructor(readonly issues: PlayerActionReviewIssue[]) {
    super(`Player action group review rejected: ${issues.map(issue =>
      `event ${issue.eventIndex}, beats ${issue.beatIndexes.join(",")}: ${issue.reason}`).join("; ")}`);
  }
}

/** Source before the exact entry is evidence; action results are kept outside it. */
export function preconditionSourceContexts(part: ChapterAnalysisPart, index: ChapterPartSourceIndex) {
  const lines = part.text.split(/\r?\n/);
  return index.significantEvents.flatMap((event, eventIndex) => event.beats.flatMap((beat, beatIndex) => {
    if (!beat.playerAction) return [];
    const start = (beat as typeof beat & {sourceActionStart?: {line: number; column: number}}).sourceActionStart;
    const line = start?.line ?? Math.min(...beat.references.map(r => r.lineStart));
    const offset = line - part.lineStart;
    const available = Number.isInteger(offset) && offset >= 0 && offset < lines.length;
    const priorLines = available ? lines.slice(0, offset).map((text, i) => ({line: part.lineStart + i, text})) : [];
    if (available && start?.column) priorLines.push({line, text: lines[offset]!.slice(0, start.column)});
    const endIndex = beat.playerAction.endBeatIndex ?? beatIndex;
    const endLine = Math.max(line, ...event.beats.slice(beatIndex, endIndex + 1).flatMap(b => b.references.map(r => r.lineEnd)));
    const executionSource = available ? lines.slice(offset, Math.min(lines.length, endLine - part.lineStart + 1))
      .map((text, i) => ({line: line + i, text: i === 0 ? text.slice(start?.column ?? 0) : text})) : [];
    return [{eventIndex, beatIndex, preconditions: beat.playerAction.preconditions,
      boundary: available ? {line, column: start?.column ?? 0} : null,
      priorSource: priorLines, executionSource, earlierContextMayBeOutsidePart: part.lineStart > 1}];
  }));
}

/** Semantic audit before a chapter checkpoint: valid indexes alone do not establish a coherent goal. */
export async function reviewPlayerActionGroups(createResponse: CreateAnalysisResponse, model: string,
  part: ChapterAnalysisPart, index: ChapterPartSourceIndex, originalIndex?: ChapterPartSourceIndex): Promise<void> {
  if (!index.significantEvents.some(e => e.beats.some(b => b.playerAction))) return;
  const groupActorContexts = index.significantEvents.flatMap((event, eventIndex) =>
    event.beats.flatMap((beat, beatIndex) => beat.playerAction ? [{eventIndex, beatIndex,
      hypotheticalPlayer: beat.actor, playerBeatIndexes: beat.playerAction.playerBeatIndexes,
      endBeatIndex: beat.playerAction.endBeatIndex}] : []));
  const response = await createResponse({model, reasoning: {effort: "low"}, max_output_tokens: 4000,
    instructions: [
      ...SOURCE_TRANSITION_POLICY,
      CONVERSATIONAL_REACH_POLICY,
      PLAYER_ACTION_ACTOR_POLICY,
      PLAYER_ACTION_GROUP_POLICY,
      "COORDINATE REVIEW: compare sourceActionStart.chapterPosition with the zero-based CHAPTER_POSITION, and chapterIndex with EPUB_SPINE_INDEX. CHAPTER_NUMBER and SOURCE_ID use one-based chapter display numbering and must not replace stored chapterPosition. Do not change an action start merely to match a display number. Actual chapter, line or column mismatches remain defects.",
      "Audit player-action groups against the supplied source. The candidate is untrusted. Return valid=true only when every group and its underlying atomic boundaries meet all checks. Do not rewrite source evidence or accept a label as proof.",
      "The group's choiceText, completion, playerBeatIndexes and endBeatIndex must describe the SAME bounded goal. A label promising retrieval/rescue/arrival cannot cover only starting it when the source continues the same goal without a new decision. Include all its intentional player steps and allow intervening automatic/NPC actions.",
      "NPC interleaving alone is not an interruption. Reject boundaryReason/interruptWhen that mistakes another actor speaking, opening a door or moving for prevention of the player's unchanged goal. A real new goal, meaningful new information, commitment, method/cost/risk change or source-established obstacle can end a group.",
      "Atomic beats must split different player goals even within one sentence. For example, starts retrieving an animal, another actor descends, catches the animal, then follows that actor: retrieval covers the start and catch with the descent between; following is the next choice. If a beat combines catching and following, require splitting it before grouping. Do not create an extra click merely to finish the already selected retrieval.",
      "These rules apply to all source-backed player goals: practical tasks, rescue, travel, investigation and dialogue. An NPC answer may finish a question, but a new information-dependent commitment requires a new choice. Legitimately interrupted attempts and singleton goals are allowed; labels must state their actual scope.",
      "PROPOSAL VERSUS EXECUTION: a goal to propose a plan ends when the proposal is voiced; it does not promise another actor’s commitment or execution. Do not expand a proposing actor’s group to include the executor’s later choice, boarding, transport or return. Audit choiceText and completion against the actual proposing actor. For a carrying goal, preparation inside that already selected goal remains part of execution. These are distinct cases, not conflicting grouping rules.",
      "CHECKPOINT REVIEW: require a resultingState correction for a concrete contradiction, lost material separation or genuinely ambiguous location, not merely missing repetition of unchanged facts. Intermediate steps such as boarding belong in source-backed execution; their omission from a final-state summary alone is not a source defect. State which source lines establish the actual position at the checkpoint. Classify necessary resultingState changes as source, never as a precondition repair.",
      "SOURCE-GROUNDED DECISIONS: multiple verbs, aid recipients, or intervening dialogue do not alone prove different goals. Helping fallen companions may be one bounded recovery goal. Require a source-backed new decision, commitment, material change or incompatible goal before demanding a split; name that evidence. Preserve real decision boundaries.",
      "PRIOR EVIDENCE: inspect PRECONDITION SOURCE CONTEXTS and the full earlier source before claiming a condition lacks support. Earlier speech by the same actor supports ability to communicate; earlier replies can support participation in an ongoing conversation. Conditions may be entailed by concrete prior events without a separate declarative sentence. Distinguish source-backed inference from unsupported assumptions, and cite the earlier lines and inference. Do not use the pending action or its later acceptance to establish entry conditions. A request does not require prior willingness to accept it. When knowledge is first acquired during the action, it cannot be a prerequisite of that action.",
      "CONDITION REPAIR REVIEW: if ORIGINAL INDEX BEFORE CONDITION REPAIR is supplied, compare every removed or replaced precondition with the earlier source. Reject deletion of a necessary valid starting condition, loss of essential setup, or replacing it with a vacuous condition merely to pass review. An empty list is valid only when no source-required prerequisite is lost. Review all groups again; do not approve merely because the previously flagged words disappeared.",
      "PRECONDITION EVIDENCE: verify every playerAction.preconditions item against exact source lines BEFORE its entry action. Distinguish a necessary starting condition from a future result, optional conversational framing or knowledge available only later. Preconditions are claims to audit, never their own evidence. In each issue identify the precondition, supporting or missing source lines, and who establishes it before selection.",
      "PRELUDE COVERAGE: when sourceActionStart is present, runtime setup uses the continuous passage from the earliest evidence reference through the exact line/column BEFORE sourceActionStart; this includes setup inside the pending beat reference, even on the same line. Columns are zero-based JavaScript string offsets. Supporting reference overlap alone is not an error; check actual action starts and extracted evidence. Without sourceActionStart, legacy runtime setup stops before the first source line of the pending beat. Check that required questions, arrivals, objects and threats fall in that passage or an explicitly established prior state. A first beat with an explicit sourceActionStart may include earlier setup from its evidence range; otherwise check event entry support explicitly. If an essential setup shares a line with the pending action, or a beat reference starts before setup, require an exact sourceActionStart separating them or a separate setup beat. A supplied correct action start already resolves this; do not demand non-overlapping references. Never fix missing setup by widening evidence past the player's unselected action or deleting a valid precondition. Already completed player dialogue in an overlapping prefix must not be replayed.",
      "Classify each issue by repairTarget. Use player_action when only choiceText, completion, membership, endpoint, boundaryReason, preconditions or interruptWhen needs correction on the existing beats. Use source only when a source-backed action, actor, agency, stakes, resultingState, decisionBoundaryBefore, reference, event boundary or atomic beat sequence actually needs correction. For a routine beat, missing metadata is not an issue; only an independently evidenced material misclassification can justify a source issue. State that evidence explicitly. Do not demand exhaustive groups for every intentional utterance.",
      "For each problem return the zero-based eventIndex, relevant beatIndexes and a concrete source-grounded reason instructing the indexer what to correct. Return an empty issues array iff valid=true. Do not approve merely because numeric indexes are structurally legal.",
    ].join("\n"),
    input: `${formatAnalysisPart(part)}\nPRECONDITION SOURCE CONTEXTS:\n${JSON.stringify(preconditionSourceContexts(part, index))}\nORIGINAL INDEX BEFORE CONDITION REPAIR:\n${JSON.stringify(originalIndex ?? null)}\nGROUP ACTOR CONTEXTS (no global player):\n${JSON.stringify(groupActorContexts)}\nCANDIDATE INDEX:\n${JSON.stringify({...index, significantEvents: index.significantEvents.map((event, eventIndex) => ({...event, eventIndex, beats: event.beats.map((beat, beatIndex) => ({...beat, beatIndex}))}))})}`,
    text: {format: {type: "json_schema", name: "bookrpg_player_action_group_review", strict: true,
      schema: {type: "object", additionalProperties: false, properties: {
        valid: {type: "boolean"}, issues: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {repairTarget: {type: "string", enum: ["player_action", "source"]}, eventIndex: {type: "integer", minimum: 0}, beatIndexes: {type: "array", minItems: 1, items: {type: "integer", minimum: 0}}, reason: {type: "string"}},
          required: ["eventIndex", "beatIndexes", "repairTarget", "reason"]}},
      }, required: ["valid", "issues"]}}},
  });
  const verdict: unknown = JSON.parse(requireOutputText(response, "player action group review"));
  if (!isRecord(verdict) || typeof verdict.valid !== "boolean" || !Array.isArray(verdict.issues)
    || verdict.valid !== (verdict.issues.length === 0)) throw new Error("Invalid player action group review verdict");
  const issues: PlayerActionReviewIssue[] = verdict.issues.map(issue => {
    if (!isRecord(issue) || !Number.isInteger(issue.eventIndex) || !index.significantEvents[issue.eventIndex as number]
      || !Array.isArray(issue.beatIndexes) || !issue.beatIndexes.length || issue.beatIndexes.some(i => !Number.isInteger(i) || i < 0 || i >= index.significantEvents[issue.eventIndex as number]!.beats.length)
      || (issue.repairTarget !== "source" && issue.repairTarget !== "player_action")
      || typeof issue.reason !== "string" || !issue.reason.trim()) throw new Error("Invalid player action group review issue");
    return {eventIndex: issue.eventIndex as number, beatIndexes: issue.beatIndexes as number[], repairTarget: issue.repairTarget, reason: issue.reason.trim()};
  });
  if (issues.length) throw new PlayerActionReviewRejection(issues);
}

