import { sourceIdentityRepair } from "./source-identity-repair.js";
import { ImportRunStopped } from "./import-run.js";
import { sourceReviewDiff, reviewSourceWithEvidence, type SourceReviewIssue, type SourceReviewContext, type SourceReviewRecord } from "./source-review-evidence.js";
import { combineSourceRepairScopes } from "./source-event-repair.js";
import {assertNoNewExactDuplicateBeats, sourceEventRepairJobs, applySourceEventRepair, sourceEventRepairSchema, validateSourceEventRepair, type SourceEventRepair} from './source-event-repair.js';
import {mergedStoryEventCategory, STORY_EVENT_CATEGORY_POLICY} from '../../shared/story-event-category.js';
import { SOURCE_TRANSITION_POLICY } from "../../shared/source-transition-policy.js";
import { applySourceFieldRepair, sourceFieldRepairJobs, sourceFieldRepairSchema, sourceClassificationRepair, sourceRepairFieldContext, type SourceFieldRepair } from "./source-field-repair.js";
import { createHash } from "node:crypto";
import type { ImportedBook, PlayerAction } from "../../shared/contracts.js";
import { configuredAiReasoningEffort, type AiReasoningEffort } from "../../ai/provider.js";
import { compileSourceTimeline } from "./source-timeline-compiler.js";
import { validateSourceBeatSemantics } from "../../shared/source-beat-semantics.js";
import { parsePlayerAction } from "../../shared/player-actions.js";
import type { ChapterPartSourceIndex } from "../source-index.js";
import { chapterSourceIndexSchema, formatAnalysisPart, type ChapterAnalysisPart, type CreateAnalysisResponse } from "./batching.js";
import { CHAPTER_SOURCE_INDEX_INSTRUCTIONS } from "./requests.js";
import { isRecord, parseChapterSourceIndexes, requireOutputText } from "./output.js";
import { ACTION_GOAL_POLICY, GOAL_START_POLICY, GOAL_CONDITION_POLICY, GOAL_LABEL_POLICY } from "./action-goal-policy.js";

type Event = ChapterPartSourceIndex["significantEvents"][number];
export interface GoalPlan { startBeatIndex: number; endBeatIndex: number; goal: string; boundaryReason: string; }
interface EventCheckpoint { rejectedPlan?: unknown; plan?: GoalPlan[]; planReviewed?: boolean; actions?: Record<string, PlayerAction>; reviewed?: boolean; conditionsNeedRepair?: boolean; error?: string; }
interface PartCheckpoint {
  fingerprint: string;
  routeDefect?: string;
  candidate?: Record<string, unknown>;
  timeline?: ChapterPartSourceIndex;
  sourceReviewed?: boolean;
  sourceReviewHistory?: SourceReviewRecord[];
  sourceRepair?: SourceFieldRepair;
  sourceEventRepair?: SourceEventRepair;
  rejectedEventRepair?: RejectedEventRepair;
  events: Record<string, EventCheckpoint>;
  error?: string;
}
class SourceRepairScopeMismatch extends Error {}
const recordSchema = (properties: Record<string, unknown>) => ({type: "object", additionalProperties: false, properties, required: Object.keys(properties)});
const stringSchema = {type: "string", minLength: 1};
const listSchema = {type: "array", items: stringSchema};
const eligible = (b: Event["beats"][number]) => Boolean(b.actor) && b.agency === "intentional" && b.stakes !== "routine";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** All eligible beats must be covered exactly once; no inferred null/omitted goals. */
export function validateGoalPlan(event: Event, value: unknown): GoalPlan[] {
  if (!Array.isArray(value)) throw new Error("Goal plan must be an array");
  const covered = new Set<number>();
  const plans: GoalPlan[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Number.isInteger(item.startBeatIndex) || !Number.isInteger(item.endBeatIndex)
      || typeof item.goal !== "string" || !item.goal.trim() || typeof item.boundaryReason !== "string" || !item.boundaryReason.trim()) throw new Error("Invalid goal plan entry");
    const p = item as unknown as GoalPlan;
    if (p.startBeatIndex < 0 || p.endBeatIndex < p.startBeatIndex || p.endBeatIndex >= event.beats.length
      || !eligible(event.beats[p.startBeatIndex]!)) throw new Error("Goal must start at an eligible beat and end within the event");
    if (plans.some(g => g.startBeatIndex >= p.startBeatIndex)) throw new Error("Goal starts must be unique and increasing");
    const owner = event.beats[p.startBeatIndex]!.actor;
    for (let i = p.startBeatIndex; i <= p.endBeatIndex; i++) {
      if (!eligible(event.beats[i]!) || event.beats[i]!.actor !== owner) continue;
      if (covered.has(i)) throw new Error(`Beat ${i} belongs to more than one goal`);
      covered.add(i);
    }
    plans.push({startBeatIndex: p.startBeatIndex, endBeatIndex: p.endBeatIndex, goal: p.goal.trim(), boundaryReason: p.boundaryReason.trim()});
  }
  const missing = event.beats.flatMap((b, i) => eligible(b) && !covered.has(i) ? [i] : []);
  if (missing.length) throw new Error(`Unassigned intentional beats: ${missing.join(",")}`);
  return plans;
}

function indexedEvent(event: Event) {
  return {...event, beats: event.beats.map((b, beatIndex) => ({...b, beatIndex, eligibleForGoal: eligible(b)}))};
}
/** Explicit before-first-beat context shared verbatim by label writer and reviewer. */
export function goalStartContexts(event: Event, plans: GoalPlan[]) {
  return plans.map(p => {
    // Adjacent participant records describe ONE joint act, not temporal phases.
    // Every participant starts before its first record; none inherits its outcome.
    const jointId = event.beats[p.startBeatIndex]!.sourceSemantics?.jointAction?.id;
    let cutoff = p.startBeatIndex;
    while (jointId && cutoff > 0 && event.beats[cutoff - 1]?.sourceSemantics?.jointAction?.id === jointId) cutoff--;
    return {
      startBeatIndex: p.startBeatIndex,
      preconditionCutoffBeatIndex: cutoff,
      sharedJointActionId: jointId ?? null,
      actor: event.beats[p.startBeatIndex]!.actor,
      lastCompletedBeatIndex: cutoff > 0 ? cutoff - 1 : null,
      precedingResultingState: cutoff > 0 ? event.beats[cutoff - 1]!.resultingState ?? null : null,
      firstBeatNotYetExecuted: event.beats[p.startBeatIndex],
    };
  });
}

/** Observed source evidence, never a prediction that the intended goal succeeds. */
export function goalOutcomeEvidence(event: Event, plans: GoalPlan[]) {
  return plans.map(p => ({startBeatIndex: p.startBeatIndex, endBeatIndex: p.endBeatIndex,
    boundaryReason: p.boundaryReason, endpointBeat: event.beats[p.endBeatIndex],
  }));
}

/** Flatten without reordering or rewriting source evidence; source events are provisional containers. */
export function flattenTimeline(index: ChapterPartSourceIndex): Event {
  return {
    description: index.significantEvents.map(e => e.description).join(" "),
    category: mergedStoryEventCategory(index.significantEvents),
    beats: index.significantEvents.flatMap(e => structuredClone(e.beats)),
    actors: [...new Set(index.significantEvents.flatMap(e => e.actors))],
    targets: [...new Set(index.significantEvents.flatMap(e => e.targets))],
    references: index.significantEvents.flatMap(e => e.references),
  };
}

/** Retain only source-event cuts that do not bisect ANY actor's approved goal window. */
export function compileGoalEvents(index: ChapterPartSourceIndex, timeline: Event, plans: GoalPlan[]): Event[] {
  const events: Event[] = [];
  let start = 0, end = 0, sources: Event[] = [];
  for (const source of index.significantEvents) {
    sources.push(source);
    end += source.beats.length;
    const jointId = timeline.beats[end - 1]?.sourceSemantics?.jointAction?.id;
    if ((jointId && timeline.beats[end]?.sourceSemantics?.jointAction?.id === jointId)
      || plans.some(p => p.startBeatIndex < end && p.endBeatIndex >= end)) continue;
    const beats = structuredClone(timeline.beats.slice(start, end));
    for (const beat of beats) {
      if (beat.playerAction) {
        beat.playerAction.endBeatIndex -= start;
        beat.playerAction.playerBeatIndexes = beat.playerAction.playerBeatIndexes.map(i => i - start);
      }
    }
    for (const [i, beat] of beats.entries()) parsePlayerAction(beat.playerAction, i, beats);
    events.push({description: [...new Set(sources.map(e => e.description))].join(" "), category: mergedStoryEventCategory(sources), beats,
      actors: [...new Set(beats.flatMap(b => b.actor ? [b.actor] : []))],
      targets: [...new Set(beats.flatMap(b => b.targets))], references: sources.flatMap(e => e.references)});
    start = end;
    sources = [];
  }
  if (start !== timeline.beats.length) throw new Error("Goal compilation left an unclosed event window");
  return events;
}

const SOURCE_TRANSITION_COVERAGE_POLICY = "Check causal and spatial continuity through ALL characters across consecutive beats and across event containers, not only the selected protagonist. Every material change in location, possession, physical condition or visible threat needs its source-supported transition represented before a later resultingState assumes it. If a source sentence says A crosses, B follows and C comes next, preserve each participant's crossing; never teleport B/C in a later checkpoint. If a threat appears before an action, include its appearance before that action. Preserve overlapping/in-progress movement: started crossing is not still waiting to start and not already across. Ordinary implied continuity is allowed; do not invent journeys, require every footstep, split a genuinely joint action, turn historical narration into present action or add routine player choices. Explicit collective source wording can establish a collective transition. When the source does not supply a transition, report unsupported certainty rather than invent a bridging event. Inspect source passages between indexed evidence ranges for omitted causal transitions.";
const CHARACTER_FLOW_POLICY = "Trace a separate continuity view for EACH observed character within the shared timeline, including characters who are targets, carried companions or temporarily offscreen. Track source-supported location, carried items/companions, physical condition and material information received. CHARACTER FLOW CHECKLIST gives explicit actor/target references only, not exhaustive proof: also inspect the full source for omitted participation and collective transitions. Carried travel can be represented by the carrier's action with the passenger as target; never invent an intentional passenger action or speech. A character's plan to travel is not arrival, and information known by another character is not automatically shared. Keep all views consistent with the same event order; never generate independent contradictory storylines. Report only concrete source-supported gaps, not missing routine detail.";
const SOURCE_EVIDENCE_POLICY = [
  "BOOK NARRATOR IS NOT A CHARACTER: mode=narration is reserved for an actual source-attested character telling something within the story. An external narrator reporting facts is not an actor named narrator. Record an objective occurrence with actor=null, agency=external, mode=present, narratedContent=null, intentionalRole=other and jointAction=null, or retain the fact in the appropriate existing description/resultingState. When the narrator reports that characters perceive, infer or understand something, retain those actual experiencers and involuntary agency; do not invent a spoken explanation or intentional telling. A source-attested first-person storyteller may still be a real character. Preserve uncertainty, timing and who actually knows the fact.",
  "MEANING-PRESERVING PARAPHRASES: assess semantic equivalence in the full supplied passage, not literal wording or whether every implication is separately stated. Accept ordinary contextual paraphrases that preserve actor, time, uncertainty, knowledge and consequences. In a retrospective account of caring for a mother throughout her life, \"as long as she lived\" may be summarized as \"until she died\"; no separate narrated death sentence is required. Keep this within the historical account: it does not authorize a new death beat, a present death category, a cause or date of death, or knowledge for anyone who has not received the account. The same words in a future promise or conditional statement do not establish that anyone has died. Reject only a material added or changed claim, and name that difference with its source context; absence of identical wording alone is not a defect. Preserve already faithful wording during repair instead of repeatedly rewriting equivalent expressions. This applies to summaries, descriptions, actions, resulting states and narrated content.",
  "NARRATOR VERSUS CHARACTER KNOWLEDGE: distinguish an objective explanation supplied by the book narrator from what a character perceives, is told, understands or concludes. Preserve a source-supported physical cause as an objective world fact, but do not attribute its explanation to a character without source evidence of that understanding. For example, air pressure holding Toto up can be recorded as a physical fact, while Dorothy sees his ear at the trapdoor and can try to reach him; this does not establish that Dorothy understands the air pressure. Perceiving a reachable target does not require knowing the mechanism that keeps it there. Do not invent a realization beat or a knows/realizes resulting state merely to connect an observation to an action. Ordinary practical inferences from visible circumstances are allowed; no literal quotation of an inner thought is required. Explicit or clearly conveyed comprehension, including understanding an explanation in context, remains valid. Apply this distinction to descriptions, actions, resulting states and narrated content. When repairing a knowledge attribution, remove only the unsupported attribution and preserve supported observations, physical causes and actions; do not delete the underlying event or invent explanatory dialogue.",
  "PASSIVE PERCEPTION IS AUTOMATIC: seeing, hearing, noticing, feeling, realizing or understanding something that becomes perceptible without a deliberate search, inspection, listening action or chosen focus is an involuntary experience, not a player decision. Classify that beat agency=involuntary and intentionalRole=other even when the information is important or immediately motivates a later action. A deliberate act such as looking toward something on purpose, searching, examining, keeping watch, listening at a door, or otherwise intentionally directing attention may remain intentional/meaningful when the source actually establishes that choice. Do not promote passive perception merely because it precedes rescue, attack, dialogue or another consequential response. Split the observation from the response when needed: the player-action boundary begins at the first deliberate act after the automatically acquired information.",
  CHARACTER_FLOW_POLICY,
  SOURCE_TRANSITION_COVERAGE_POLICY,
  STORY_EVENT_CATEGORY_POLICY,
  "Verify each supplied event category against the actual source-backed event; reject a category that mistakes narrated, planned, conditional or earlier events for current outcomes.",
  ...SOURCE_TRANSITION_POLICY,
  "mode=narration means the CURRENT actor is intentionally telling, not reliving the historical event. narratedContent holds source-backed content; historical injury or emotion does not happen again in the present. Present listener emotions and understanding remain separate present experiences when established by the source. Do not invent historical realizations, belief or understanding.",
  "intentionalRole=meaningful identifies intentional consequential actions, including their first deliberate steps and their continuations. Both are significant/critical even before completion. Use other for routine movements and automatic experiences. Do not decide whether a meaningful action starts a new goal or continues an existing one in source extraction or source review; that distinction belongs exclusively to goal planning. Never reject a source beat solely over start-versus-continuation classification.",
  "Joint actions: when the source establishes they jointly perform one action without a temporal division, give each participant one adjacent representation with the same jointAction.id, exact participant list, and EXACT shared jointAction.resultingState. Each beat.resultingState equals that shared outcome. This is one joint act, not first Dorothy starts then Scarecrow finishes. Action text must explicitly describe joint participation. Do not assert simultaneous timing beyond what the source supports. Never infer joint participation from ambiguous you alone.",
  "Use source-attested names or descriptive noun phrases for unnamed identities (for example \"old woman\"). Do not invent possessive names such as Woodman’s father when the source only says my father. Keep family relationships in narrated content unless a distinct identity is needed; never use bare pronouns as global aliases to bypass name validation.",
  "English you does not establish a singular or plural addressee. Preserve an unspecified addressee when context does not resolve it. Collective they oiled describes joint participation, not a fabricated sequence where one actor finishes before another begins.",
  "Could turn his head establishes restored ability, not an intentional head-turn. Keep ability, emotion and understanding as resulting states or automatic experiences unless a purposeful act is explicit. Include source-backed requests that initiate an interaction and material intermediate positions, such as halfway across the room when the house shakes.",
].join("\n");

const SOURCE_OVERLAP_POLICY = "OVERLAPPING ACTIONS: source-backed simultaneous or ongoing activities may overlap across separate beat representations. Waiting while another character runs is not a sequence merely because the records have different indexes. Do not reject an ongoing concurrent state solely because its action has a later record. Keep distinct actions and agency; concurrency is not automatically a joint action. Preserve real causal prerequisites and completed outcomes: an action not yet begun cannot be marked completed, a later crossing cannot establish an earlier far-bank position, and earlier physical transitions cannot be moved after their consequences. Do not describe retrospective references to earlier motion as additional new motion.";

const SOURCE_GENERATION_POLICY = [
  SOURCE_EVIDENCE_POLICY,
  SOURCE_OVERLAP_POLICY,
  "Fill sourceSemantics on every beat. For mode=narration, supply the source-backed narratedContent only: the compiler derives the current telling action, intentional agency and current conveyed-information state. Do not supply independent action, agency or resultingState on a narration response.",
].join("\n");

const SOURCE_AUDIT_POLICY = [
  SOURCE_EVIDENCE_POLICY,
  SOURCE_OVERLAP_POLICY,
  "You review a COMPILED TIMELINE, not the generator response. In narration mode action, agency and resultingState are REQUIRED derived fields added by code: action=Recounts: <content>, agency=intentional, resultingState=<actor> has recounted: <content>. Their presence is correct and MUST NOT be rejected as prohibited independent generation. Structural consistency was checked before this review. Judge whether the source supports the narration classification, content, actor, references and actual present reactions. Code-derived fields do not prove the content true.",
  "Review the complete source timeline, not goals or player choices. Source event containers are provisional; an action may continue in another container. Check all containers before declaring an action missing. Do not require event restructuring for goal continuity at this stage.",
  "Persistent source-backed state remains valid until changed or contradicted. A later line need not repeat who holds an object or animal. Do not reject persistence merely because the source does not repeat it. Do not invent new independent actions.",
  "Historical actions are content of the present narrator's intentional telling, never actions performed now by the historical actors. Require material causal content, not a separate present decision for every historical verb or inferred motive. Do not create a realization or decision not established by the source.",
  "Interpret explicit comprehension in its discourse context. If a speaker explains a motive and the source explicitly says listeners understand why, a faithful summary of that stated reason is supported; the source need not repeat the explanation in the listener sentence. Understanding a speaker's belief is not adopting that belief, endorsing it as fact, or gaining unrelated knowledge. Do not infer listener understanding from mere presence or interest when the source does not establish it.",
  "Each character reference must identify that character in the cited span, by name, alias, or unambiguous contextual mention. A reference to an object previously associated with a character does not by itself establish a character occurrence. An extraneous occurrence reference can be removed while preserving the other valid references; never invent or broaden a reference to avoid rejection.",
  "Only concrete source, actor, agency, state, reference, chronology or meaningful omission defects belong here. Harmless paraphrase and representational granularity alone are not defects; partway versus halfway need only be distinguished when it changes the supported outcome or subsequent action.",
].join("\n");

function sourceSchema(part: ChapterAnalysisPart) {
  const schema = chapterSourceIndexSchema([part]) as any;
  const beat = schema.properties[part.sourceId].properties.significantEvents.items.properties.beats.items;
  delete beat.properties.playerAction;
  delete beat.properties.decisionBoundaryBefore;
  beat.required = beat.required.filter((k: string) => k !== "playerAction" && k !== "decisionBoundaryBefore");
  beat.properties.resultingState.description = "Current narrative state after this act. For narration, record conveyed information, never the historical physical state. Adjacent representations of one jointAction share its outcome; they are not separate temporal phases.";
  beat.properties.agency.description = "Agency of the CURRENT act. Intentionally recounting an accident is intentional, regardless of the agency of the narrated historical event.";
  beat.properties.stakes.description = "Consequence in context: the deliberate beginning or continuation of a meaningful action is not routine merely because completion comes later.";
  beat.properties.sourceSemantics = recordSchema({
    mode: {type: "string", enum: ["present", "narration"]},
    narratedContent: {type: ["string", "null"]},
    intentionalRole: {type: "string", enum: ["meaningful", "other"]},
    jointAction: {anyOf: [{type: "null"}, recordSchema({id: stringSchema, participants: {type: "array", minItems: 2, items: stringSchema}, resultingState: stringSchema})]},
  });
  beat.required.push("sourceSemantics");
  const present = structuredClone(beat);
  present.properties.sourceSemantics.properties.mode.enum = ["present"];
  present.properties.sourceSemantics.properties.narratedContent = {type: "null"};
  const narration = structuredClone(beat);
  for (const key of ["action", "agency", "resultingState"]) delete narration.properties[key];
  narration.required = narration.required.filter((key: string) => !["action", "agency", "resultingState"].includes(key));
  narration.properties.actor = stringSchema;
  narration.properties.sourceSemantics.properties.mode.enum = ["narration"];
  narration.properties.sourceSemantics.properties.narratedContent = stringSchema;
  narration.properties.sourceSemantics.properties.jointAction = {type: "null"};
  schema.properties[part.sourceId].properties.significantEvents.items.properties.beats.items = {anyOf: [present, narration]};
  return schema;
}
function stripGroups(candidate: Record<string, unknown>) {
  const raw = structuredClone(candidate);
  if (Array.isArray(raw.significantEvents)) for (const event of raw.significantEvents) {
    if (isRecord(event) && Array.isArray(event.beats)) for (const beat of event.beats) {
      if (isRecord(beat)) { delete beat.playerAction; delete beat.decisionBoundaryBefore; }
    }
  }
  return raw;
}
function parseTimeline(candidate: Record<string, unknown>, part: ChapterAnalysisPart) {
  const result = parseChapterSourceIndexes(JSON.stringify({[part.sourceId]: stripGroups(candidate)}), [part], 1);
  const index = result.indexes.get(part.sourceId);
  if (!index) throw new Error(result.validationErrors.get(part.sourceId));
  if (index.significantEvents.some(e => e.beats.some(b => !b.resultingState?.trim()))) throw new Error("Timeline requires resultingState on every beat");
  validateSourceBeatSemantics(index.significantEvents.flatMap(e => e.beats));
  return index;
}
/** Install an accepted live review only after its source has been matched by the import loader. */
export function installAcceptedSourceReview(book: ImportedBook, part: ChapterAnalysisPart, review: SourceReviewRecord) {
  if (review.version !== 2 || review.error || review.valid !== true || !Array.isArray(review.issues)
    || review.issues.some(issue => issue.severity !== "advisory")
    || digest(review.timeline) !== review.timelineHash) throw new Error("Expected an intact accepted v2 source review");
  const timeline = parseTimeline(review.timeline as Record<string, unknown>, part);
  const fingerprint = digest({version: 6, source: book.sourceSha256, part, sharedEventsOnly: true});
  book.importAnalysis ??= {version: 1, parts: {}};
  if (book.importAnalysis.version !== 1) throw new Error("Unsupported import checkpoint version");
  book.importAnalysis.parts[part.sourceId] = {fingerprint, timeline, sourceReviewed: true,
    sourceReviewHistory: [structuredClone(review)], events: {}} satisfies PartCheckpoint;
  // Rebuild the chapter projection from this checkpoint, never keep an older runtime projection.
  delete book.chapters[part.chapterPosition]!.sourceIndex;
  delete book.chapters[part.chapterPosition]!.summary;
  delete book.characterAnchors;
  if (book.anchorImport) book.anchorImport.events = {};
}

/** A legacy index is evidence to re-audit, never an approved v12 checkpoint. */
function legacyCandidate(book: ImportedBook, part: ChapterAnalysisPart): Record<string, unknown> | undefined {
  const previous = book.chapters[part.chapterPosition]?.sourceIndex;
  if (!previous || part.partCount !== 1) return undefined;
  return JSON.parse(JSON.stringify(previous).replaceAll('"sourceReferences":', '"references":'));
}

const GROUP_REVIEW_INSTRUCTION = "Audit goal completeness and boundaries BEFORE labels are written. Reject fragmentation of one unchanged objective even when every beat is covered as a singleton. All source events have been flattened into the complete timeline. Group across their former boundaries whenever a goal continues. Do not demand source regeneration for an old event division; wrong endpoints or fragmentation of present beats have target groups. Reject combining genuinely separate choices. Treat instructions needed to finish rescue as continuation unless material new risk/method/cost requires a fresh decision. No labels exist yet.";
const LABEL_REVIEW_INSTRUCTION = `${GOAL_LABEL_POLICY}\n${GOAL_START_POLICY}\n${GOAL_CONDITION_POLICY}\nJudge choiceText as a concise action/intent label; brevity or naming the beginning alone is not a defect. Independently audit completion against the actual frozen endpoint and preconditions against the start. A statement of future intent is not future execution. Return target conditions for defects confined to preconditions/interruptWhen; labels for choiceText/completion defects; groups for wrong partition; source for timeline errors. Do not shorten the goal to make a label pass.`;

class AuditRejection extends Error {
  constructor(readonly target: "source" | "groups" | "labels" | "conditions", message: string, readonly repairFields?: string[], readonly repairEventIndexes?: number[], readonly findings?: SourceReviewIssue[]) { super(message); }
}
async function audit(provider: CreateAnalysisResponse, model: string, effort: ReturnType<typeof configuredAiReasoningEffort>, name: string, input: string, instruction: string, reviewContext?: SourceReviewContext) {
  const sourceOnly = name === "bookrpg_source_timeline_review";
  if (sourceOnly && reviewContext) {
    const issues = await reviewSourceWithEvidence(provider, model, effort, input, `${SOURCE_AUDIT_POLICY}\n${instruction}`, reviewContext);
    if (issues.length) {
      const scope = combineSourceRepairScopes(issues);
      throw new AuditRejection("source", issues.map(i => i.reason).join("; "), scope.fields, scope.eventIndexes, issues);
    }
    return;
  }
  const targets = sourceOnly ? ["source"] : name === "bookrpg_action_goal_review" ? ["source", "groups"] : ["source", "groups", "labels", "conditions"];
  const response = await provider({model, reasoning: {effort}, max_output_tokens: 8000,
    instructions: `${sourceOnly ? SOURCE_AUDIT_POLICY : ACTION_GOAL_POLICY}\n${instruction}\nReturn concrete source-grounded defects only. valid is true iff issues is empty. Allowed defect targets for this stage: ${targets.join(", ")}. Only genuine errors in the complete source timeline are source defects; provisional event divisions are not missing evidence.`, input,
    text: {format: {type: "json_schema", name, strict: true, schema: recordSchema({valid: {type: "boolean"}, issues: {type: "array", items: recordSchema({target: {type: "string", enum: targets}, reason: stringSchema, ...(sourceOnly ? {repairFields: {type: "array", items: stringSchema}, repairEventIndexes: {type: "array", maxItems: 16, items: {type: "integer", minimum: 0}}} : {})})}})}}});
  const verdict: unknown = JSON.parse(requireOutputText(response, name));
  if (!isRecord(verdict) || typeof verdict.valid !== "boolean" || !Array.isArray(verdict.issues) || verdict.valid !== (verdict.issues.length === 0)) throw new Error("Invalid audit verdict");
  const issues = verdict.issues;
  if (issues.some(i => !isRecord(i) || !targets.includes(String(i.target)) || typeof i.reason !== "string" || !i.reason.trim())) throw new Error("Invalid audit issue");
  if (issues.length) {
    const scope = sourceOnly ? combineSourceRepairScopes(issues) : {};
    throw new AuditRejection(issues.some(i => i.target === "source") ? "source" : issues.some(i => i.target === "groups") ? "groups" : issues.some(i => i.target === "labels") ? "labels" : "conditions",
      issues.map(i => i.reason).join("; "), scope.fields, scope.eventIndexes, issues);
  }
}

/** Durable stages. Only an audited complete part is returned to chapter checkpointing. */
interface StageSettings {sharedEventsOnly?: boolean; sourceEffort?: AiReasoningEffort; goalEffort?: AiReasoningEffort; goalModel?: string}
export interface LabelRepairFixture {sourceSha256: string; plans: GoalPlan[]; rejectedLabels: Record<string, unknown>; defect: string}
export interface SourceRepairFixture {sourceSha256: string; candidate: Record<string, unknown>; defect: string; provenance: string}
type MeasurementStage = {stage: "source"} | {stage: "source-repair"; sourceSha256: string; repair: SourceRepairFixture} | {stage: "groups"; timeline: Record<string, unknown>; sourceSha256: string}
  | {stage: "repair"; timeline: Record<string, unknown>; sourceSha256: string; repair: LabelRepairFixture};

/** Production imports always run all stages; measurement checkpoints are isolated. */
export async function requestStagedChapterIndexes(
  provider: CreateAnalysisResponse, model: string, book: ImportedBook, parts: ChapterAnalysisPart[],
  attempt: number, log: (s: string) => void, save: () => Promise<void>, settings: StageSettings = {},
) {
  return runStages(provider, model, book, parts, attempt, log, save, settings);
}

/** Benchmark-only entry. Artifacts are NOT approved production chapter indexes. */
export async function measureIndexStage(
  provider: CreateAnalysisResponse, model: string, book: ImportedBook, part: ChapterAnalysisPart,
  attempt: number, log: (s: string) => void, save: () => Promise<void>,
  measurement: MeasurementStage, settings: StageSettings = {},
  observePlan?: (timeline: Event, plans: GoalPlan[]) => Promise<void>,
) {
  if (measurement.stage !== "source" && measurement.sourceSha256 !== createHash("sha256").update(part.text).digest("hex")) {
    throw new Error("Controlled timeline does not match fixture source hash");
  }
  if (measurement.stage === "repair" && measurement.repair.sourceSha256 !== measurement.sourceSha256) throw new Error("Repair fixture does not match controlled source hash");
  if (measurement.stage === "source-repair" && (attempt !== 1 || measurement.repair.sourceSha256 !== measurement.sourceSha256)) throw new Error("Source repair requires one attempt and matching source hash");
  const result = await runStages(provider, model, book, [part], attempt, log, save, settings, measurement, observePlan);
  return {artifacts: result.indexes, validationErrors: result.validationErrors};
}

async function runStages(
  provider: CreateAnalysisResponse, model: string, book: ImportedBook, parts: ChapterAnalysisPart[],
  attempt: number, log: (s: string) => void, save: () => Promise<void>,
  settings: StageSettings = {}, measurement?: MeasurementStage,
  observePlan?: (timeline: Event, plans: GoalPlan[]) => Promise<void>,
) {
  const goalModel = settings.goalModel || process.env.BOOKRPG_GOAL_MODEL?.trim() || model;
  const effort = settings.sourceEffort || configuredAiReasoningEffort(process.env.BOOKRPG_INDEX_REASONING_EFFORT?.trim() || "medium");
  const goalEffort = settings.goalEffort || configuredAiReasoningEffort(process.env.BOOKRPG_GOAL_REASONING_EFFORT?.trim() || "medium");
  const indexes = new Map<string, ChapterPartSourceIndex>();
  const validationErrors = new Map<string, string>();
  const invalidParts: ChapterAnalysisPart[] = [];
  book.importAnalysis ??= {version: 1, parts: {}};
  if (book.importAnalysis.version !== 1) book.importAnalysis = {version: 1, parts: {}};
  for (const part of parts) {
    const fingerprint = digest({version: 6, source: book.sourceSha256, part, ...(settings.sharedEventsOnly ? {sharedEventsOnly: true} : {}), ...(measurement ? {measurement} : {})});
    let cp = book.importAnalysis.parts[part.sourceId] as PartCheckpoint | undefined;
    if (!cp || cp.fingerprint !== fingerprint) {
      const previousFingerprints = [1, 2, 3, 4, 5].map(version => digest({version, source: book.sourceSha256, part}));
      const candidate = cp && previousFingerprints.includes(cp.fingerprint)
        ? cp.timeline as unknown as Record<string, unknown> | undefined ?? cp.candidate
        : undefined;
      cp = {fingerprint, candidate: measurement ? undefined : candidate ?? legacyCandidate(book, part), events: {}};
      book.importAnalysis.parts[part.sourceId] = cp;
    }
    const checkpoint = cp;
    try {
      if (measurement?.stage === "source-repair") {
        cp.candidate = structuredClone(measurement.repair.candidate);
        cp.error = measurement.repair.defect;
        delete cp.timeline; delete cp.sourceReviewed; cp.events = {};
      }
      if (measurement && measurement.stage !== "source" && measurement.stage !== "source-repair" && !cp.timeline) {
        cp.timeline = parseTimeline(measurement.timeline, part);
        cp.sourceReviewed = true; // Controlled fixture, NOT a model-reviewed production timeline.
        if (measurement.stage === "repair") {
          cp.events[0] = {plan: validateGoalPlan(flattenTimeline(cp.timeline), measurement.repair.plans), planReviewed: true,
            error: `${measurement.repair.defect}\nPREVIOUS REJECTED LABELS (untrusted wording; frozen plan is authoritative):\n${JSON.stringify(measurement.repair.rejectedLabels)}`};
        }
        await save();
      }
      if (!cp.timeline) {
        if ((!cp.candidate || cp.error) && !(cp.candidate && sourceClassificationRepair(cp.candidate))) {
          log(`Timeline ${part.sourceId}: ${measurement?.stage === "source-repair" ? "repairing captured source beats" : "generating source beats"} (${model}, ${effort})...`);
          const instructions = CHAPTER_SOURCE_INDEX_INSTRUCTIONS.filter(s => !/playerAction|playerBeatIndexes|choiceText|endBeatIndex|group|goal|decisionBoundaryBefore|DECISION BOUNDAR/i.test(s));
          const response = await provider({model, reasoning: {effort}, max_output_tokens: Math.min(64000, Math.max(16000, Math.ceil(part.text.length / 2)) * attempt),
            instructions: [...instructions, SOURCE_GENERATION_POLICY, "SOURCE TIMELINE ONLY: do not generate action groups, labels or player decision boundaries. Keep each present narration beat owned by its narrator with intentional agency, even when recounting historical accidents. Historical characters are discussed identities, not actors executing in the present. Source event divisions are provisional containers, not goal boundaries; preserve complete chronology across all containers.", cp.error ? `Correct the previous source defect: ${cp.error}. Preserve unrelated valid evidence.` : ""].join("\n"),
            input: `${formatAnalysisPart(part)}\nPREVIOUS CANDIDATE:\n${JSON.stringify(cp.candidate ?? null)}`,
            text: {format: {type: "json_schema", name: measurement?.stage === "source-repair" ? "bookrpg_source_timeline_repair" : "bookrpg_source_timeline", strict: true, schema: sourceSchema(part)}}});
          const raw: unknown = JSON.parse(requireOutputText(response, "source timeline"));
          if (!isRecord(raw) || !isRecord(raw[part.sourceId])) throw new Error("Missing timeline section");
          cp.candidate = stripGroups(raw[part.sourceId] as Record<string, unknown>);
          await save(); // Preserve even a malformed model response for diagnosis/recovery.
          cp.candidate = compileSourceTimeline(cp.candidate);
        }
        const classificationRepair = cp.candidate && sourceClassificationRepair(cp.candidate);
        if (classificationRepair) {
          log(`Timeline ${part.sourceId}: repairing ${classificationRepair.fields.length} conflicting classification fields...`);
          cp.candidate = await requestSourceFieldRepair(provider, model, effort, part, cp.candidate!, classificationRepair);
          await save(); // Persist the bounded repair even if validation still rejects it.
        }
        cp.timeline = parseTimeline(cp.candidate!, part);
        cp.error = undefined;
        await save();
      }
      if (cp.sourceEventRepair && cp.timeline) {
        const identityRepair = sourceIdentityRepair(cp.timeline, part);
        if (identityRepair) {
          // All invalid identity uses are repaired together, before unrelated queued work.
          log(`Repairing existing identity references ${part.sourceId}: ${identityRepair.reason}`);
          const repaired = await repairSourceEvents(provider, model, effort, part, cp.timeline,
            identityRepair, cp.rejectedEventRepair, async rejected => {
              cp.rejectedEventRepair = rejected; await save();
            });
          cp.timeline = repaired;
          cp.candidate = structuredClone(repaired) as unknown as Record<string, unknown>;
          delete cp.rejectedEventRepair; delete cp.sourceReviewed; delete cp.error; cp.events = {};
          // Field indexes inside replaced containers may have shifted: obtain a fresh review.
          if (cp.sourceRepair) {
            cp.sourceRepair.fields = cp.sourceRepair.fields.filter(path => !identityRepair.eventIndexes.some(i => path.startsWith(`/significantEvents/${i}/`)));
            if (cp.sourceRepair.evidence) cp.sourceRepair.evidence = cp.sourceRepair.evidence.filter(e => cp.sourceRepair!.fields.includes(e.path));
            if (!cp.sourceRepair.fields.length) delete cp.sourceRepair;
          }
          log(`Saved identity repair ${part.sourceId}: events ${JSON.stringify(identityRepair.eventIndexes)}; pending full source review`);
          await save();
        }
      }
      if (cp.sourceEventRepair && cp.timeline) {
        log(`Timeline ${part.sourceId}: repairing source transition coverage in ${cp.sourceEventRepair.eventIndexes.length} event containers...`);
        for (const job of sourceEventRepairJobs(cp.sourceEventRepair)) {
          const repaired = await repairSourceEvents(provider, model, effort, part, cp.timeline,
            {...job, reason: job.reason + (cp.error ? "\nPrevious failed attempt: " + cp.error : "")},
            cp.rejectedEventRepair, async rejected => {
              cp.rejectedEventRepair = rejected;
              log(`Saved rejected event repair ${part.sourceId}: ${rejected.error}; retained for targeted correction`);
              await save();
            });
          delete cp.rejectedEventRepair;
          cp.timeline = repaired;
          cp.candidate = structuredClone(repaired) as unknown as Record<string, unknown>;
          cp.sourceEventRepair!.eventIndexes = cp.sourceEventRepair!.eventIndexes.filter(i => !job.eventIndexes.includes(i));
          if (!cp.sourceEventRepair!.eventIndexes.length) delete cp.sourceEventRepair;
          delete cp.sourceReviewed; cp.events = {};
          log(`Saved source repair unit ${part.sourceId}: events ${JSON.stringify(job.eventIndexes)}; pending final source review`);
          await save();
        }
      }
      if (cp.sourceRepair && cp.timeline) {
        log(`Timeline ${part.sourceId}: repairing ${cp.sourceRepair.fields.length} approved source fields...`);
        const repaired = await repairSourceFields(provider, model, effort, part, cp.timeline, cp.sourceRepair, async (timeline, job) => {
          cp.timeline = timeline;
          cp.candidate = structuredClone(timeline) as unknown as Record<string, unknown>;
          cp.sourceRepair!.fields = cp.sourceRepair!.fields.filter(field => !job.fields.includes(field));
          if (cp.sourceRepair!.evidence) cp.sourceRepair!.evidence = cp.sourceRepair!.evidence.filter(e => !job.fields.includes(e.path));
          if (!cp.sourceRepair!.fields.length) delete cp.sourceRepair;
          delete cp.sourceReviewed;
          log(`Saved source repair unit ${part.sourceId}: ${JSON.stringify(job.fields)}; pending final source review`);
          await save();
        });
        cp.timeline = repaired;
        cp.candidate = structuredClone(repaired) as unknown as Record<string, unknown>;
        delete cp.sourceRepair; delete cp.sourceReviewed; cp.events = {};
        await save();
      }
      if (!cp.sourceReviewed) {
        log(`Timeline ${part.sourceId}: reviewing source chronology and narration...`);
        await auditSourceTimeline(provider, goalModel, goalEffort, part, cp.timeline, cp.routeDefect, settings.sharedEventsOnly ? {
          sourceId: part.sourceId, timeline: cp.timeline,
          previous: cp.sourceReviewHistory?.findLast(r => r.issues !== undefined), log, repairMalformedResponse: true,
          onRecord: async record => { (cp.sourceReviewHistory ??= []).push(record); await save(); },
        } : undefined);
        cp.sourceReviewed = true;
        await save();
        log(`Saved reviewed timeline ${part.sourceId}.`);
      }
      if (settings.sharedEventsOnly || measurement?.stage === "source" || measurement?.stage === "source-repair") {
        indexes.set(part.sourceId, structuredClone(cp.timeline));
        cp.error = undefined;
        await save();
        continue;
      }
      const result = structuredClone(cp.timeline);
      const completeTimeline = flattenTimeline(result);
      for (const [eventIndex, event] of [completeTimeline].entries()) {
        const state = cp.events[eventIndex] ??= {};
        const input = `${formatAnalysisPart(part)}\nCOMPLETE IMMUTABLE TIMELINE (absolute source-part beat indexes):\n${JSON.stringify(indexedEvent(event))}`;
        try {
          if (!state.plan) {
            if (measurement?.stage === "repair") throw new Error("Fixed repair plan cannot be regenerated");
            log(`Goals ${part.sourceId}: assigning every intentional beat across the complete timeline...`);
            if (!event.beats.some(eligible)) state.plan = [];
            else {
              const response = await provider({model: goalModel, reasoning: {effort: goalEffort}, max_output_tokens: 12000,
                instructions: `${ACTION_GOAL_POLICY}\nReturn the complete goal partition for the ENTIRE source-part timeline, sorted by absolute startBeatIndex. Provisional source event containers impose no grouping boundaries. Each group has a concrete goal and source-grounded reason why it ends. When PREVIOUS REJECTED GOAL PLAN is supplied, repair its stated defects and preserve unrelated valid groups; it is untrusted, not an approved partition. Include singleton goals. No display labels yet. Membership is computed from the owner and window. Never change source beats. The only hard scope limit is the end of this source part, not an earlier source event container.\nPrevious defect: ${state.error ?? "none"}`,
                input: `${state.rejectedPlan !== undefined ? `PREVIOUS REJECTED GOAL PLAN (untrusted):\n${JSON.stringify(state.rejectedPlan)}\n` : ""}${input}`, text: {format: {type: "json_schema", name: "bookrpg_action_goal_plan", strict: true, schema: recordSchema({groups: {type: "array", items: recordSchema({startBeatIndex: {type: "integer", minimum: 0}, endBeatIndex: {type: "integer", minimum: 0}, goal: stringSchema, boundaryReason: stringSchema})}})}}});
              const raw: unknown = JSON.parse(requireOutputText(response, "goal plan"));
              state.rejectedPlan = isRecord(raw) ? raw.groups : raw;
              await save(); // Preserve even a structurally invalid plan before validation throws.
              state.plan = validateGoalPlan(event, state.rejectedPlan);
            }
            await save();
          }
          state.plan = validateGoalPlan(event, state.plan);
          if (observePlan) await observePlan(structuredClone(event), structuredClone(state.plan));
          if (!state.planReviewed) {
            if (state.plan.length) await audit(provider, goalModel, goalEffort, "bookrpg_action_goal_review", `${input}\nGOALS:\n${JSON.stringify(state.plan)}`,
              GROUP_REVIEW_INSTRUCTION);
            state.planReviewed = true;
            delete state.rejectedPlan;
            await save();
          }
          const startContext = `\nGOAL OUTCOME EVIDENCE (observed endpoint, not desired success):\n${JSON.stringify(goalOutcomeEvidence(event, state.plan))}\nGOAL START CONTEXTS (immediately before each first beat):\n${JSON.stringify(goalStartContexts(event, state.plan))}`;
          if (!state.actions) {
            const props: Record<string, unknown> = {};
            for (const p of state.plan) props[`beat_${p.startBeatIndex}`] = recordSchema({choiceText: stringSchema, completion: stringSchema, preconditions: listSchema, interruptWhen: listSchema});
            const labels = state.plan.length ? await provider({model, reasoning: {effort: "low"}, max_output_tokens: Math.min(24000, Math.max(4000, state.plan.length * 650)),
              instructions: `${ACTION_GOAL_POLICY}\n${GOAL_START_POLICY}\n${GOAL_CONDITION_POLICY}\nWrite labels and completion for the FROZEN GOALS. No membership, actor, endpoint or boundary changes are allowed. Use a concise action/intent label; naming the beginning is allowed without listing later steps or outcomes. Completion must describe the actual frozen endpoint. Do not promise another goal or guaranteed success.\nPrevious label defect: ${state.error ?? "none"}`, input: `${input}\nFROZEN GOALS:\n${JSON.stringify(state.plan)}${startContext}`,
              text: {format: {type: "json_schema", name: "bookrpg_action_goal_labels", strict: true, schema: recordSchema(props)}}}) : undefined;
            const raw: unknown = labels ? JSON.parse(requireOutputText(labels, "goal labels")) : {};
            if (!isRecord(raw) || Object.keys(raw).length !== state.plan.length || Object.keys(raw).some(k => !(k in props))) throw new Error("Labels must match exactly the frozen goal starts");
            const actions: Record<string, PlayerAction> = {};
            for (const p of state.plan) {
              const owner = event.beats[p.startBeatIndex]!.actor;
              const label = raw[`beat_${p.startBeatIndex}`];
              if (!isRecord(label)) throw new Error("Missing goal label");
              const playerBeatIndexes = event.beats.flatMap((b, i) => i >= p.startBeatIndex && i <= p.endBeatIndex && b.actor === owner && eligible(b) ? [i] : []);
              actions[p.startBeatIndex] = parsePlayerAction({...label, kind: "player_action", endBeatIndex: p.endBeatIndex, boundaryReason: p.boundaryReason, playerBeatIndexes}, p.startBeatIndex, event.beats)!;
            }
            state.actions = actions;
            await save();
          }
          if (state.conditionsNeedRepair) {
            log(`Conditions ${part.sourceId}: repairing only preconditions and interruptWhen...`);
            const props = Object.fromEntries(state.plan.map(p => [`beat_${p.startBeatIndex}`, recordSchema({preconditions: listSchema, interruptWhen: listSchema})]));
            const response = await provider({model, reasoning: {effort: "low"}, max_output_tokens: Math.min(16000, Math.max(2000, state.plan.length * 350)),
              instructions: `${ACTION_GOAL_POLICY}\n${GOAL_START_POLICY}\n${GOAL_CONDITION_POLICY}\nRepair ONLY preconditions and interruptWhen. All labels, completion, source evidence, goal membership and endpoints are immutable. Preserve already valid conditions; remove unnecessary ones. Previous defect: ${state.error ?? "none"}`,
              input: `${input}\nFROZEN GOALS:\n${JSON.stringify(state.plan)}${startContext}\nFROZEN ACTIONS:\n${JSON.stringify(state.actions)}`,
              text: {format: {type: "json_schema", name: "bookrpg_action_goal_conditions", strict: true, schema: recordSchema(props)}}});
            const raw: unknown = JSON.parse(requireOutputText(response, "goal conditions"));
            if (!isRecord(raw) || Object.keys(raw).length !== state.plan.length || Object.keys(raw).some(k => !(k in props))) throw new Error("Conditions must match exactly the frozen goal starts");
            const repaired = structuredClone(state.actions);
            for (const p of state.plan) {
              const patch = raw[`beat_${p.startBeatIndex}`];
              if (!isRecord(patch) || Object.keys(patch).length !== 2 || !Object.hasOwn(patch, "preconditions") || !Object.hasOwn(patch, "interruptWhen")) throw new Error("Condition repair may only change preconditions and interruptWhen");
              repaired[p.startBeatIndex] = parsePlayerAction({...state.actions[p.startBeatIndex], preconditions: patch.preconditions, interruptWhen: patch.interruptWhen}, p.startBeatIndex, event.beats)!;
            }
            state.actions = repaired;
            delete state.conditionsNeedRepair;
            await save();
          }
          for (const p of state.plan) {
            const action = state.actions[p.startBeatIndex];
            if (!action) throw new Error("Missing persisted goal metadata");
            const expected = event.beats.flatMap((b, i) => i >= p.startBeatIndex && i <= p.endBeatIndex && b.actor === event.beats[p.startBeatIndex]!.actor && eligible(b) ? [i] : []);
            if (action.endBeatIndex !== p.endBeatIndex || JSON.stringify(action.playerBeatIndexes) !== JSON.stringify(expected)) throw new Error("Persisted label changed the frozen goal membership");
            event.beats[p.startBeatIndex]!.playerAction = parsePlayerAction(action, p.startBeatIndex, event.beats);
            event.beats[p.startBeatIndex]!.decisionBoundaryBefore = p.goal;
          }
          if (!state.reviewed) {
            if (state.plan.length) await audit(provider, goalModel, goalEffort, "bookrpg_action_goal_label_review", `${input}\nFROZEN GOALS:\n${JSON.stringify(state.plan)}${startContext}\nLABELED EVENT:\n${JSON.stringify(indexedEvent(event))}`,
              LABEL_REVIEW_INSTRUCTION);
            state.reviewed = true;
            state.error = undefined;
            await save();
          }
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
          if (error instanceof AuditRejection && error.target === "source") throw error;
          if (!state.planReviewed || (error instanceof AuditRejection && error.target === "groups")) {
            if (state.plan) state.rejectedPlan = structuredClone(state.plan);
            delete state.plan; delete state.planReviewed;
          }
          if (error instanceof AuditRejection && error.target === "conditions" && state.actions) {
            state.conditionsNeedRepair = true;
          } else if (error instanceof AuditRejection || !state.conditionsNeedRepair) {
            delete state.actions;
            delete state.conditionsNeedRepair;
          }
          delete state.reviewed;
          throw error;
        }
      }
      result.significantEvents = compileGoalEvents(result, completeTimeline, cp.events[0]?.plan ?? []);
      indexes.set(part.sourceId, result);
      checkpoint.error = undefined;
      await save();
    } catch (error) {
      if (error instanceof ImportRunStopped) { await save(); throw error; }
      checkpoint.error = error instanceof Error ? error.message : String(error);
      if (error instanceof SourceRepairScopeMismatch) {
        // Re-audit unchanged evidence on the next bounded attempt. Never replay a
        // field map whose target does not match the defect, or regenerate the source.
        delete checkpoint.sourceRepair;
        delete checkpoint.sourceReviewed;
      }
      if (error instanceof AuditRejection && error.target === "source") {
        checkpoint.candidate = checkpoint.timeline as unknown as Record<string, unknown>;
        delete checkpoint.sourceReviewed; checkpoint.events = {};
        delete checkpoint.sourceRepair;
        delete checkpoint.sourceEventRepair;
        if (checkpoint.timeline && error.repairFields) {
          const repair: SourceFieldRepair = {fields: error.repairFields, reason: error.message,
            ...(error.findings ? {evidence: error.repairFields.map(path => ({path,
              findings: error.findings!.filter(issue => issue.repairFields.includes(path))}))} : {})};
          try {
            sourceFieldRepairSchema(checkpoint.timeline as unknown as Record<string, unknown>, repair);
            checkpoint.sourceRepair = repair;
          } catch { /* Invalid or structural scope must reopen source generation. */ }
        }
        if (checkpoint.timeline && error.repairEventIndexes) {
          const repair: SourceEventRepair = {eventIndexes: error.repairEventIndexes, reason: error.message, findings: error.findings};
          try {
            validateSourceEventRepair(checkpoint.timeline as unknown as Record<string, unknown>, repair);
            checkpoint.sourceEventRepair = repair;
          } catch { /* An unbounded source defect must reopen extraction. */ }
        }
        if (!checkpoint.sourceRepair && !checkpoint.sourceEventRepair) delete checkpoint.timeline;
      }
      log(`Rejected ${part.sourceId}: ${checkpoint.error}`);
      invalidParts.push(part);
      validationErrors.set(part.sourceId, checkpoint.error);
      await save();
    }
  }
  return {indexes, validationErrors, invalidParts};
}

/** Fixed review probes use the same parsing, prompts and audit routing as production. */
export async function measureGoalReview(
  provider: CreateAnalysisResponse, model: string, part: ChapterAnalysisPart,
  candidate: Record<string, unknown>, plan: GoalPlan[], labels: Record<string, unknown> | undefined,
  effort: AiReasoningEffort,
) {
  try {
    const event = flattenTimeline(parseTimeline(candidate, part));
    const plans = validateGoalPlan(event, plan);
    const input = `${formatAnalysisPart(part)}\nCOMPLETE IMMUTABLE TIMELINE (absolute source-part beat indexes):\n${JSON.stringify(indexedEvent(event))}`;
    if (labels) {
      for (const p of plans) {
        const label = labels[`beat_${p.startBeatIndex}`];
        if (!isRecord(label)) throw new Error("Missing probe label");
        const owner = event.beats[p.startBeatIndex]!.actor;
        const playerBeatIndexes = event.beats.flatMap((b, i) => i >= p.startBeatIndex && i <= p.endBeatIndex && b.actor === owner && eligible(b) ? [i] : []);
        event.beats[p.startBeatIndex]!.playerAction = parsePlayerAction({...label, kind: "player_action", boundaryReason: p.boundaryReason, endBeatIndex: p.endBeatIndex, playerBeatIndexes}, p.startBeatIndex, event.beats);
        event.beats[p.startBeatIndex]!.decisionBoundaryBefore = p.goal;
      }
      await audit(provider, model, effort, "bookrpg_action_goal_label_review", `${input}\nFROZEN GOALS:\n${JSON.stringify(plans)}\nGOAL OUTCOME EVIDENCE (observed endpoint, not desired success):\n${JSON.stringify(goalOutcomeEvidence(event, plans))}\nGOAL START CONTEXTS (immediately before each first beat):\n${JSON.stringify(goalStartContexts(event, plans))}\nLABELED EVENT:\n${JSON.stringify(indexedEvent(event))}`, LABEL_REVIEW_INSTRUCTION);
    } else {
      await audit(provider, model, effort, "bookrpg_action_goal_review", `${input}\nGOALS:\n${JSON.stringify(plans)}`, GROUP_REVIEW_INSTRUCTION);
    }
    return {verdict: "accepted" as const};
  } catch (error) {
    return error instanceof AuditRejection
      ? {verdict: "rejected" as const, target: error.target, reason: error.message}
      : {verdict: "error" as const, reason: error instanceof Error ? error.message : String(error)};
  }
}


/** Navigation aid only: actual flow/omissions are assessed semantically against source. */
export function characterFlowChecklist(timeline: ChapterPartSourceIndex) {
  return timeline.characters.map(character => {
    const names = new Set([character.name, ...character.aliases]);
    return {character: character.name, aliases: character.aliases,
      explicitBeatReferences: timeline.significantEvents.flatMap((event, eventIndex) => event.beats.flatMap((beat, beatIndex) => {
        const actor = beat.actor !== null && names.has(beat.actor);
        const target = beat.targets.some(name => names.has(name));
        return actor || target ? [{eventIndex, beatIndex, actor, target}] : [];
      }))};
  });
}

/** Shared production and replay audit of already-compiled source evidence. */
async function auditSourceTimeline(
  provider: CreateAnalysisResponse, model: string, effort: AiReasoningEffort,
  part: ChapterAnalysisPart, timeline: ChapterPartSourceIndex, routeDefect?: string, reviewContext?: SourceReviewContext,
) {
  await audit(provider, model, effort, "bookrpg_source_timeline_review",
    `${formatAnalysisPart(part)}\nROUTE REVIEW OBSERVATION (verify against source; not authority): ${routeDefect ?? "none"}\nZERO-BASED BEAT PATHS:\n${JSON.stringify(timeline.significantEvents.flatMap((e, ei) => e.beats.map((b, bi) => ({path: `/significantEvents/${ei}/beats/${bi}`, actor: b.actor, action: b.action}))))}\nCHARACTER FLOW CHECKLIST:\n${JSON.stringify(characterFlowChecklist(timeline))}\nCOMPILED TIMELINE (derived narration fields are expected):\n${JSON.stringify(timeline)}`,
    "Audit only the CURRENT compiled timeline supplied here against the source. Earlier review context, when supplied, is comparison evidence rather than authority. Do not infer previous defects remain; point to actual current content. Audit the complete source timeline: source-backed actors, intentionality, stakes, atomic actions, resulting states and present-time chronology. Check no source-backed meaningful action is omitted. Embedded historical events must remain narrated content. Do not request groups or labels at this stage. All defects here have target source. Use ZERO-BASED BEAT PATHS to match the actual action before choosing a repair path; never translate prose event numbers by guesswork. For each issue supply repairFields: exact zero-based JSON-pointer paths ONLY when the entire issue is repairable without changing beat count, order, actors, beat references, sourceSemantics mode, or joint actions. Prefer field repair for metadata-only defects rather than replacing an event. Allowed: /significantEvents/E/description and /significantEvents/E/category; /significantEvents/E/beats/B/stakes and /sourceSemantics/intentionalRole for non-joint beats, /agency for present non-joint beats (AI must judge the source-backed classification, never change agency solely to satisfy a constraint); /summary for a factual correction to the existing summary; /significantEvents/E/beats/B/targets, /action or /resultingState for present non-joint beats, /sourceSemantics/narratedContent for narration; /relationships/R/description, or /relationships/R to remove an unsupported relationship assertion; /characters/C/references/R to remove one unsupported character occurrence reference while retaining at least one valid reference. This permits deletion only, never changing reference ranges, names or aliases. Narration action/state are derived by code; never request those paths. Include ALL duplicated unsupported assertions in the repair scope. For missing beats or unsupported jumps repairable within existing event containers, set repairFields=[] and list the exact zero-based repairEventIndexes of ALL event containers needing correction. Include adjacent containers when a crossing or other transition spans their boundary. Event replacement may insert, split or reorder source-supported beats within those containers; grouping and numbering will be rebuilt afterward. Use repairEventIndexes=[] for field-only repairs, missing character inventory, required new event containers, or uncertain scope. Never prescribe book-specific data patches. Do not propose corrected values.", reviewContext);
}

export interface SourceReviewFixture {
  sourceSha256: string;
  timeline: Record<string, unknown>;
  previousCandidate?: Record<string, unknown>;
  provenance: string;
}

/** Review-only measurement: no generation, repair, grouping, retries or production approvals. */
export async function measureSourceReview(
  provider: CreateAnalysisResponse, model: string, part: ChapterAnalysisPart,
  fixture: SourceReviewFixture, effort: AiReasoningEffort,
) {
  try {
    if (fixture.sourceSha256 !== createHash("sha256").update(part.text).digest("hex")) throw new Error("Captured timeline does not match source hash");
    const timeline = parseTimeline(fixture.timeline, part);
    await auditSourceTimeline(provider, model, effort, part, timeline);
    return {verdict: "accepted" as const};
  } catch (error) {
    return error instanceof AuditRejection
      ? {verdict: "rejected" as const, target: error.target, reason: error.message, repairFields: error.repairFields ?? []}
      : {verdict: "error" as const, reason: error instanceof Error ? error.message : String(error)};
  }
}


/** Fixed-timeline V2 replay; no generation, repairs or production approval writes. */
export async function replaySourceReviewV2(provider: CreateAnalysisResponse, model: string, effort: AiReasoningEffort,
  part: ChapterAnalysisPart, timeline: Record<string, unknown>, context: Omit<SourceReviewContext, "timeline" | "sourceId">) {
  const compiled = parseTimeline(timeline, part);
  try {
    await auditSourceTimeline(provider, model, effort, part, compiled, undefined, {...context, timeline: compiled, sourceId: part.sourceId});
  } catch (error) {
    if (!(error instanceof AuditRejection)) throw error;
  }
}

/** Exactly one approved field repair; no classification repair or timeline regeneration. */
export async function repairReviewedSourceFields(provider: CreateAnalysisResponse, model: string, effort: AiReasoningEffort,
  part: ChapterAnalysisPart, previous: SourceReviewRecord) {
  if (previous.version !== 2 || previous.error || previous.valid !== false || previous.sourceId !== part.sourceId
    || createHash("sha256").update(JSON.stringify(previous.timeline)).digest("hex") !== previous.timelineHash) {
    throw new Error("Saved review is incomplete, mismatched, or has no rejected timeline");
  }
  const blocking = previous.issues?.filter(issue => issue.severity === "blocking") ?? [];
  if (!blocking.length || blocking.some(issue => !issue.repairFields.length || issue.repairEventIndexes.length)) {
    throw new Error("Repair requires bounded field-only blocking findings");
  }
  const repair: SourceFieldRepair = {fields: [...new Set(blocking.flatMap(issue => issue.repairFields))],
    reason: JSON.stringify(blocking)};
  const source = previous.timeline as Record<string, unknown>;
  parseTimeline(source, part);
  const repaired = await requestSourceFieldRepair(provider, model, effort, part, source, repair);
  // This diagnostic mode deliberately refuses derived or array-wide changes outside exact approved paths.
  const changes = sourceReviewDiff(source, repaired);
  if (changes.some(change => !repair.fields.includes(change.path))) throw new Error("Repair changed fields outside the approved scope");
  parseTimeline(repaired, part);
  return {timeline: repaired, repair, changes};
}

async function repairSourceFields(provider: CreateAnalysisResponse, model: string, effort: AiReasoningEffort,
  part: ChapterAnalysisPart, timeline: ChapterPartSourceIndex, repair: SourceFieldRepair,
  onProgress?: (timeline: ChapterPartSourceIndex, job: SourceFieldRepair) => Promise<void>) {
  let repaired = timeline as unknown as Record<string, unknown>;
  for (const job of sourceFieldRepairJobs(repair)) {
    repaired = await requestSourceFieldRepair(provider, model, effort, part, repaired, job);
    const classificationRepair = sourceClassificationRepair(repaired);
    if (classificationRepair) repaired = await requestSourceFieldRepair(provider, model, effort, part, repaired, classificationRepair);
    const parsed = parseTimeline(repaired, part);
    await onProgress?.(parsed, job);
    repaired = parsed as unknown as Record<string, unknown>;
  }
  return parseTimeline(repaired, part);
}

async function requestSourceFieldRepair(provider: CreateAnalysisResponse, model: string, effort: AiReasoningEffort,
  part: ChapterAnalysisPart, source: Record<string, unknown>, repair: SourceFieldRepair) {
  const fieldsSchema = sourceFieldRepairSchema(source, repair);
  const schema = recordSchema({...fieldsSchema.properties, scopeCheck: recordSchema({matchesDefect: {type: "boolean"}, reason: stringSchema})});
  const response = await provider({model, reasoning: {effort}, max_output_tokens: 5000,
    instructions: `${SOURCE_AUDIT_POLICY}\nTreat each mapped field and its own findings independently; do not associate it with a defect belonging to another field or already-repaired event. First validate the proposed repair scope against EXACT FIELD TARGETS and the full source/timeline. A syntactically valid path is not proof it points to the described act. In scopeCheck, confirm that EVERY target actually matches the defect and explain the actor/action correspondence. If even one target is unrelated, ambiguously mapped, or off by one, set matchesDefect=false; return unchanged field values (null for removal fields), and do not repair a different beat or force the mapped beat to fit the complaint. For example, a complaint about seeing an ear cannot change the agency of a separate decision to wait calmly. Only when scope matches, repair the explicitly mapped fields against the source. Return scopeCheck and each field_N value, not a full timeline. Other fields and all beats/order/actors/beat references/joint actions are frozen. A whole relationship path or character occurrence reference path accepts only null to remove that unsupported assertion. All other references stay frozen. Narrated content changes are compiled into current telling fields by code. Fix the stated defects without claiming new actions or recipients.`,
    input: `${formatAnalysisPart(part)}\nCOMPILED TIMELINE:\n${JSON.stringify(source)}\nDEFECT: ${repair.evidence ? "Use only the field-specific findings below for each target." : repair.reason}\nFIELD-SPECIFIC FINDINGS:\n${JSON.stringify(repair.evidence ?? [])}\nEXACT FIELD TARGETS:\n${JSON.stringify(sourceRepairFieldContext(source, repair))}\nAPPROVED FIELD MAP:\n${JSON.stringify(Object.fromEntries(repair.fields.map((path, i) => [`field_${i}`, path])))}`,
    text: {format: {type: "json_schema", name: "bookrpg_source_field_repair", strict: true, schema}}});
  const result: unknown = JSON.parse(requireOutputText(response, "source field repair"));
  if (!isRecord(result) || !isRecord(result.scopeCheck) || typeof result.scopeCheck.matchesDefect !== "boolean"
    || typeof result.scopeCheck.reason !== "string" || !result.scopeCheck.reason.trim()) throw new Error("Missing source repair scope verification");
  if (!result.scopeCheck.matchesDefect) throw new SourceRepairScopeMismatch(`Source repair scope mismatch: ${result.scopeCheck.reason}`);
  const {scopeCheck: _scopeCheck, ...values} = result;
  return applySourceFieldRepair(source, repair, values);
}

export interface RejectedEventRepair { baselineHash: string; eventIndexes: number[]; raw: unknown; error: string; }

export async function repairSourceEvents(provider: CreateAnalysisResponse, model: string, effort: AiReasoningEffort,
  part: ChapterAnalysisPart, timeline: ChapterPartSourceIndex, repair: SourceEventRepair,
  rejected?: RejectedEventRepair, onRejected?: (value: RejectedEventRepair) => Promise<void>) {
  const original = timeline as unknown as Record<string, unknown>;
  const previous = rejected?.baselineHash === digest(timeline) && JSON.stringify(rejected.eventIndexes) === JSON.stringify(repair.eventIndexes) ? rejected : undefined;
  const eventSchema = sourceSchema(part).properties[part.sourceId].properties.significantEvents.items;
  const schema = sourceEventRepairSchema(original, repair, eventSchema);
  Object.assign(schema.properties, {removeCharacterNames: {type: "array", items: {type: "string", enum: timeline.characters.map(c => c.name)}}});
  schema.required.push("removeCharacterNames");
  const response = await provider({model, reasoning: {effort}, max_output_tokens: Math.min(64000, Math.max(16000, Math.ceil(part.text.length / 2))),
    instructions: `${SOURCE_GENERATION_POLICY}\nIf a REJECTED EVENT CANDIDATE is supplied, correct its specific validation defect using the source; do not restart the event reconstruction. Preserve all unaffected candidate content. Never invent an identity to satisfy an actor field. Repair only the approved source event containers. Preserve every unaffected beat verbatim; add, remove or split only beats needed for the stated defect. Do not copy preceding or following events into the repaired container. Check against neighboring containers for duplicated actions before returning. Reconstruct the complete ordered beats from the supplied source, retaining valid actions and adding missing material transitions. Preserve chronology across container boundaries, all participating characters and in-progress actions. Do not manufacture movement or dialogue merely to join checkpoints. The surrounding timeline, relationships and source text are frozen. Return removeCharacterNames as an empty list unless an existing inventory entry is a synthetic non-character introduced by a previous invalid attempt (for example an external book narrator). You may request removal only after correcting its event uses; no beat, target, joint participant or relationship may still refer to it. Never remove an actual source-attested identity. Return exactly the requested event_N containers, no groups, labels or player decision boundaries. The whole resulting timeline will be independently re-audited before any goals are generated.`,
    input: `${formatAnalysisPart(part)}\nCURRENT COMPILED TIMELINE:\n${JSON.stringify(timeline)}\nDEFECT: ${repair.reason}\nAPPROVED EVENT INDEXES:\n${JSON.stringify(repair.eventIndexes)}\nREJECTED EVENT CANDIDATE (untrusted; not established story state):\n${JSON.stringify(previous ?? null)}`,
    text: {format: {type: 'json_schema', name: 'bookrpg_source_event_repair', strict: true,
      schema}}});
  const raw = JSON.parse(requireOutputText(response, 'source event repair'));
  const uncompiled = structuredClone(raw);
  try {
    // Validate exact keys before compiling independently generated narration fields.
    const {removeCharacterNames = [], ...containers} = raw;
    applySourceEventRepair(original, repair, containers);
    for (const i of repair.eventIndexes) {
      const compiled = compileSourceTimeline({significantEvents: [containers[`event_${i}`]]});
      containers[`event_${i}`] = (compiled.significantEvents as unknown[])[0];
    }
    const repaired = applySourceEventRepair(original, repair, containers);
    if (!Array.isArray(removeCharacterNames) || removeCharacterNames.some(name => typeof name !== "string" || !timeline.characters.some(c => c.name === name))) throw new Error("Invalid character removal request");
    for (const name of removeCharacterNames) {
      const identity = timeline.characters.find(c => c.name === name)!;
      const names = new Set([identity.name, ...identity.aliases]);
      const contains = (value: unknown): boolean => typeof value === "string" ? names.has(value) : Array.isArray(value) ? value.some(contains) : isRecord(value) ? Object.values(value).some(contains) : false;
      if (contains(repaired.significantEvents) || contains(repaired.relationships)) throw new Error(`Cannot remove still-referenced character ${name}`);
    }
    repaired.characters = timeline.characters.filter(c => !removeCharacterNames.includes(c.name));
    assertNoNewExactDuplicateBeats(original, repaired);
    const parsed = parseTimeline(repaired, part);
    // Reparse to validate identities discovered from actor/target references as well.
    return parseTimeline(parsed as unknown as Record<string, unknown>, part);
  } catch (error) {
    await onRejected?.({baselineHash: digest(timeline), eventIndexes: [...repair.eventIndexes], raw: uncompiled, error: error instanceof Error ? error.message : String(error)});
    throw error;
  }
}

export interface SourceFieldRepairFixture extends SourceReviewFixture {repair: SourceFieldRepair}
/** One field repair plus the production review, with no hidden retries or production writes. */
export async function measureSourceFieldRepair(provider: CreateAnalysisResponse, model: string, part: ChapterAnalysisPart,
  fixture: SourceFieldRepairFixture, effort: AiReasoningEffort) {
  let timeline: ChapterPartSourceIndex | undefined;
  try {
    if (fixture.sourceSha256 !== createHash("sha256").update(part.text).digest("hex")) throw new Error("Captured timeline does not match source hash");
    const original = parseTimeline(fixture.timeline, part);
    timeline = await repairSourceFields(provider, model, effort, part, original, fixture.repair);
    await auditSourceTimeline(provider, model, effort, part, timeline);
    return {verdict: "accepted" as const, timeline};
  } catch (error) {
    return error instanceof AuditRejection
      ? {verdict: "rejected" as const, target: error.target, reason: error.message, timeline}
      : {verdict: "error" as const, reason: error instanceof Error ? error.message : String(error), timeline};
  }
}

