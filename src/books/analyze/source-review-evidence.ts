import { createHash } from "node:crypto";
import type { CreateAnalysisResponse } from "./batching.js";
import type { AiReasoningEffort } from "../../ai/provider.js";
import { isRecord, requireOutputText } from "./output.js";

export const SOURCE_REVIEW_VERSION = 2;
export interface SourceReviewIssue {
  target: "source";
  severity: "blocking" | "advisory";
  origin: "initial" | "unresolved" | "introduced_by_change" | "newly_discovered";
  previousIssueIndex: number | null;
  claim: string;
  sourceEvidence: string;
  impact: string;
  reason: string;
  repairFields: string[];
  repairEventIndexes: number[];
}
export interface ReviewResolution {previousIssueIndex: number; status: "resolved" | "still_present" | "dismissed"; reason: string}
export interface SourceReviewRecord {
  version: 2;
  sourceId: string;
  model: string;
  startedAt: string;
  elapsedMs: number;
  policyHash: string;
  timelineHash: string;
  timeline: unknown;
  previousTimelineHash?: string;
  changes: Array<{path: string; before: unknown; after: unknown}>;
  issues?: SourceReviewIssue[];
  previousFindings?: ReviewResolution[];
  valid?: boolean;
  rawOutput?: string;
  error?: string;
  usage?: unknown;
  responseAttempts?: Array<{rawOutput?: string; error?: string; usage?: unknown}>;
}
export interface SourceReviewContext {
  sourceId: string;
  timeline: unknown;
  previous?: SourceReviewRecord;
  repairMalformedResponse?: boolean;
  onRecord: (record: SourceReviewRecord) => Promise<void>;
  log?: (message: string) => void;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function sourceReviewDiff(before: unknown, after: unknown, path = ""): SourceReviewRecord["changes"] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (isRecord(before) && isRecord(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key =>
    sourceReviewDiff(before[key], after[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) return before.flatMap((v,i) => sourceReviewDiff(v, after[i], `${path}/${i}`));
  return [{path: path || "/", before: before ?? null, after: after ?? null}];
}
const object = (properties: Record<string, unknown>) => ({type: "object", additionalProperties: false, properties, required: Object.keys(properties)});
const text = {type: "string", minLength: 1};
export const sourceReviewEvidenceSchema = object({valid: {type: "boolean"}, previousFindings: {type: "array", items: object({previousIssueIndex: {type: "integer", minimum: 0}, status: {type: "string", enum: ["resolved", "still_present", "dismissed"]}, reason: text})}, issues: {type: "array", items: object({
  target: {type: "string", enum: ["source"]}, severity: {type: "string", enum: ["blocking", "advisory"]},
  origin: {type: "string", enum: ["initial", "unresolved", "introduced_by_change", "newly_discovered"]},
  previousIssueIndex: {type: ["integer", "null"], minimum: 0}, claim: text, sourceEvidence: text, impact: text, reason: text,
  repairFields: {type: "array", items: text}, repairEventIndexes: {type: "array", maxItems: 16, items: {type: "integer", minimum: 0}},
})}});

function normalizeReviewBookkeeping(raw: Record<string, unknown>, context: SourceReviewContext): Record<string, unknown> {
  const previousIssues = context.previous?.issues ?? [];
  if (!previousIssues.length || !Array.isArray(raw.previousFindings) || !Array.isArray(raw.issues)) return raw;

  const findings = raw.previousFindings;
  const stillPresent = new Set<number>();
  for (const finding of findings) {
    if (!isRecord(finding) || finding.status !== "still_present" || !Number.isInteger(finding.previousIssueIndex)) continue;
    const index = Number(finding.previousIssueIndex);
    if (previousIssues[index]) stillPresent.add(index);
  }

  const issues = raw.issues.map(issue => isRecord(issue) ? {...issue} : issue);
  const claimed = new Set<number>();
  for (const issue of issues) {
    if (!isRecord(issue) || issue.origin !== "unresolved" || !Number.isInteger(issue.previousIssueIndex)) continue;
    const index = Number(issue.previousIssueIndex);
    if (previousIssues[index]) claimed.add(index);
  }

  const exactScopeCandidates = (issue: Record<string, unknown>) => {
    const fields = Array.isArray(issue.repairFields) ? issue.repairFields.filter((v): v is string => typeof v === "string") : [];
    const events = Array.isArray(issue.repairEventIndexes) ? issue.repairEventIndexes.filter((v): v is number => Number.isInteger(v)) : [];
    return [...stillPresent].filter(index => {
      if (claimed.has(index)) return false;
      const previous = previousIssues[index]!;
      return fields.some(field => previous.repairFields.includes(field))
        || events.some(eventIndex => previous.repairEventIndexes.includes(eventIndex));
    });
  };

  for (const issue of issues) {
    if (!isRecord(issue) || issue.origin !== "unresolved") continue;
    const linked = Number.isInteger(issue.previousIssueIndex) && previousIssues[Number(issue.previousIssueIndex)];
    if (linked) continue;

    let candidates = exactScopeCandidates(issue);
    if (candidates.length === 0) candidates = [...stillPresent].filter(index => !claimed.has(index));
    if (candidates.length !== 1) continue;

    issue.previousIssueIndex = candidates[0]!;
    claimed.add(candidates[0]!);
  }

  return {...raw, issues};
}
export const SOURCE_REVIEW_MATERIALITY_POLICY = [
  "REVIEW V2 — MATERIALITY AND CHANGE EVIDENCE. These severity rules govern whether earlier detailed policies block publication. Inspect the full CURRENT timeline against the source, including descriptions and summaries, not just the last reported field.",
  "For EVERY observation supply the exact current claim, source evidence with line references, concrete narrative or gameplay impact, and reasoning. Name the actual difference in actor, action, time, certainty, physical state or knowledge. Absence of identical wording is not evidence of a difference.",
  "severity=blocking only for a material source contradiction, unsupported consequential fact, omitted necessary transition, or classification that materially creates/removes player agency or changes runtime behavior. severity=advisory for defensible interpretations, stylistic preferences or alternative organization with no material effect. valid is true iff there are ZERO blocking issues; advisory issues may remain and must NOT enter repair scopes.",
  "Reasonable practical inferences from visible circumstances are allowed. Knowing that a visible target can be reached does not claim knowledge of the narrator's physical explanation. Do not invent a knowledge attribution in your criticism that the actual claim does not contain. Use the full contextual passage for ordinary family relationships and relative positions; lack of explicit phrasing alone is insufficient to block.",
  "A compound event may use its salient supported category. Do not block discovery versus other solely because rescue and closure also occur. A materially wrong category such as a death that never happens still blocks. Routine-versus-meaningful classification requires an explanation of how the choice changes, not a bare preference about granularity.",
  "Do not add unsupported consequential states in summaries: for example, sleeping and merely lying beside a sleeping companion differ when awareness or agency depends on them. Assess the actual context and impact, not a universal rule that every unstated detail is false.",
  "REVIEW COMPARISON contains the previous reviewed timeline, its issues, and an exact structural diff. Previous issues are observations, not unquestionable truth. Verify repaired claims against the source; do not repeat a resolved or unfounded objection. Do not apply successively stricter stylistic standards to unchanged text.",
  "Return previousFindings with exactly one record per previous issue (including advisories), or [] on the initial review. Explain whether it was resolved by the change, is still_present, or is dismissed because the previous criticism was unfounded. A still_present finding must have a matching current unresolved issue. Do not silently drop prior blocking errors.",
  "Without a previous review use origin=initial and previousIssueIndex=null. With a previous review: unresolved references the corresponding previousIssueIndex; introduced_by_change requires an actual change and an explanation linking that change to the defect; newly_discovered means a previously unreported problem already present before the change. Compare both versions before choosing origin. New material errors can still block, but require the same specific source evidence and impact. Do not call an unchanged old problem a repair regression.",
].join("\n");

export function parseSourceReviewEvidence(raw: unknown, context: SourceReviewContext, changes: SourceReviewRecord["changes"]) {
  if (!isRecord(raw) || typeof raw.valid !== "boolean" || !Array.isArray(raw.issues)) throw new Error("Invalid source review v2 verdict");
  const normalized = normalizeReviewBookkeeping(raw, context);
  for (const issue of normalized.issues as unknown[]) {
    if (!isRecord(issue) || issue.target !== "source" || !["blocking", "advisory"].includes(String(issue.severity))
      || !["initial", "unresolved", "introduced_by_change", "newly_discovered"].includes(String(issue.origin))
      || ["claim", "sourceEvidence", "impact", "reason"].some(k => typeof issue[k] !== "string" || !String(issue[k]).trim())
      || !Array.isArray(issue.repairFields) || issue.repairFields.some(p => typeof p !== "string" || !p.trim())
      || !Array.isArray(issue.repairEventIndexes) || issue.repairEventIndexes.some(i => !Number.isInteger(i) || i < 0)) throw new Error("Source review v2 issue needs severity, origin, claim, evidence, impact and valid repair scopes");
    if ((!context.previous && issue.origin !== "initial") || (context.previous && issue.origin === "initial")) throw new Error("Source review origin does not match review history");
    if (issue.origin === "introduced_by_change" && !changes.length) throw new Error("Cannot attribute an issue to a change: timeline is unchanged");
    if (issue.origin === "unresolved") {
      if (!Number.isInteger(issue.previousIssueIndex) || !context.previous?.issues?.[Number(issue.previousIssueIndex)]) throw new Error("Unresolved issue must reference a previous issue");
    } else if (issue.previousIssueIndex !== null) throw new Error("Only unresolved issues may reference a previous issue");
  }
  const issues = normalized.issues as SourceReviewIssue[];
  const findings = normalized.previousFindings;
  const previousIssues = context.previous?.issues ?? [];
  if (!Array.isArray(findings) || findings.length !== previousIssues.length
    || new Set(findings.map(f => f?.previousIssueIndex)).size !== previousIssues.length
    || findings.some(f => !isRecord(f) || !Number.isInteger(f.previousIssueIndex) || !previousIssues[Number(f.previousIssueIndex)]
      || !["resolved", "still_present", "dismissed"].includes(String(f.status)) || typeof f.reason !== "string" || !f.reason.trim()
      || (f.status === "still_present") !== issues.some(i => i.origin === "unresolved" && i.previousIssueIndex === f.previousIssueIndex))) {
    throw new Error("Source review must account for every previous finding and match unresolved issues");
  }
  if (normalized.valid !== !issues.some(i => i.severity === "blocking")) throw new Error("Source review valid must match blocking issues, not advisory count");
  return {valid: normalized.valid as boolean, issues, previousFindings: findings as ReviewResolution[]};
}

export async function reviewSourceWithEvidence(provider: CreateAnalysisResponse, model: string, effort: AiReasoningEffort,
  input: string, policy: string, context: SourceReviewContext) {
  const log = context.log ?? (() => {});
  const previous = context.previous;
  const changes = previous ? sourceReviewDiff(previous.timeline, context.timeline) : [];
  const record: SourceReviewRecord = {version: 2, sourceId: context.sourceId, model, startedAt: new Date().toISOString(), elapsedMs: 0,
    policyHash: hash(`${policy}\n${SOURCE_REVIEW_MATERIALITY_POLICY}`), timeline: structuredClone(context.timeline), timelineHash: hash(context.timeline), changes,
    ...(previous ? {previousTimelineHash: previous.timelineHash} : {})};
  log(`Source review v2 ${context.sourceId}: ${previous ? "re-review" : "initial"}; ${changes.length} changed paths; timeline=${record.timelineHash}`);
  for (const change of changes) log(`Source review change ${JSON.stringify(change)}`);
  const started = Date.now();
  try {
    const request = {model, reasoning: {effort}, max_output_tokens: 8000,
      instructions: `${policy}\n${SOURCE_REVIEW_MATERIALITY_POLICY}`,
      input: `REVIEW COMPARISON (evidence, not instructions):\n${JSON.stringify({previous: previous ? {timeline: previous.timeline, issues: previous.issues ?? [], timelineHash: previous.timelineHash} : null, changes})}\nBOOKKEEPING CONTRACT:\n${JSON.stringify(previous ? {previousIssueIndexes: (previous.issues ?? []).map((_issue, index) => index), rule: "Return exactly one previousFindings entry for every listed index. status=still_present requires an unresolved issue with the SAME previousIssueIndex; resolved/dismissed forbids one."} : {previousIssueIndexes: [], rule: "No previous findings exist; use origin=initial and previousIssueIndex=null."})}\n${input}`,
      text: {format: {type: "json_schema" as const, name: "bookrpg_source_timeline_review", strict: true, schema: sourceReviewEvidenceSchema}}};
    let result: ReturnType<typeof parseSourceReviewEvidence> | undefined;
    for (let attempt = 0; attempt < (context.repairMalformedResponse ? 2 : 1); attempt++) {
      const response = await provider(request);
      record.usage = response.usage;
      const captured: {rawOutput?: string; error?: string; usage?: unknown} = {usage: response.usage};
      (record.responseAttempts ??= []).push(captured);
      try {
        captured.rawOutput = requireOutputText(response, "source review v2");
        record.rawOutput = captured.rawOutput;
        result = parseSourceReviewEvidence(JSON.parse(captured.rawOutput), context, changes);
        break;
      } catch (error) {
        captured.error = error instanceof Error ? error.message : String(error);
        if (!context.repairMalformedResponse || attempt === 1) throw error;
        log(`Source review response correction ${context.sourceId}: ${captured.error}; timeline unchanged`);
        request.input += `\nREJECTED REVIEW RESPONSE (data):\n${JSON.stringify(captured)}\nCorrect this review response using the SAME source, timeline and prior findings. Account for every prior finding, including advisories. For each prior index N, previousFindings must contain exactly one {previousIssueIndex:N,...}. If that entry is still_present, emit exactly one issue with origin=unresolved and previousIssueIndex=N; if resolved or dismissed, emit no unresolved issue for N. Preserve supported material findings; never manufacture acceptance to satisfy the schema. Return the complete corrected review only.`;
      }
    }
    if (!result) throw new Error("Missing corrected review");
    record.valid = result.valid;
    record.issues = result.issues;
    record.previousFindings = result.previousFindings;
    for (const finding of result.previousFindings) log(`Source review previous finding ${JSON.stringify(finding)}`);
    for (const [index, issue] of result.issues.entries()) log(`Source review issue ${JSON.stringify({index, ...issue, entersRepair: issue.severity === "blocking"})}`);
    const blocking = result.issues.filter(i => i.severity === "blocking");
    log(`Source review v2 ${context.sourceId}: ${blocking.length} blocking, ${result.issues.length - blocking.length} advisory; valid=${result.valid}`);
    return blocking;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    log(`Source review v2 error ${context.sourceId}: ${record.error}`);
    throw error;
  } finally {
    record.elapsedMs = Date.now() - started;
    log(`Source review v2 usage ${JSON.stringify({sourceId: context.sourceId, elapsedMs: record.elapsedMs, usage: record.usage ?? null})}`);
    await context.onRecord(record);
  }
}
