import {storyEventCategorySchema} from "../../shared/story-event-category.js";
import { narrationFields } from "../../shared/source-beat-semantics.js";
import { isRecord } from "./output.js";

export interface SourceFieldRepair {fields: string[]; reason: string; evidence?: Array<{path: string; findings: unknown[]}>}
const stringSchema = {type: "string", minLength: 1};
const listSchema = {type: "array", items: stringSchema};

/** Resolve a narrow allowlist; never accept generic JSON patches or source topology changes. */
function locate(timeline: Record<string, unknown>, path: string) {
  if (path === "/summary" && typeof timeline.summary === "string") {
    return {parent: timeline, key: "summary", schema: stringSchema, beat: undefined, remove: false};
  }
  const eventPath = /^\/significantEvents\/(0|[1-9]\d*)\/(description|category)$/.exec(path);
  if (eventPath) {
    const event = (timeline.significantEvents as any[])?.[Number(eventPath[1])];
    if (!isRecord(event)) throw new Error(`Unrepairable event field: ${path}`);
    return {parent: event, key: eventPath[2]!, schema: eventPath[2] === "category" ? storyEventCategorySchema : stringSchema, beat: undefined, remove: false};
  }
  const classification = /^\/significantEvents\/(0|[1-9]\d*)\/beats\/(0|[1-9]\d*)\/(agency|stakes|sourceSemantics\/intentionalRole)$/.exec(path);
  if (classification) {
    const beat = (timeline.significantEvents as any[])?.[Number(classification[1])]?.beats?.[Number(classification[2])];
    const field = classification[3]!;
    if (!isRecord(beat) || !isRecord(beat.sourceSemantics) || beat.sourceSemantics.jointAction !== null
      || (field === "agency" && beat.sourceSemantics.mode !== "present")) throw new Error(`Unrepairable classification: ${path}`);
    const values = field === "agency" ? ["intentional", "involuntary", "external"] : field === "stakes" ? ["routine", "significant", "critical"] : ["meaningful", "other"];
    return {parent: field.includes("/") ? beat.sourceSemantics : beat, key: field.split("/").at(-1)!,
      schema: {type: "string", enum: values}, beat, remove: false};
  }
  const beatPath = /^\/significantEvents\/(0|[1-9]\d*)\/beats\/(0|[1-9]\d*)\/(targets|action|resultingState|sourceSemantics\/narratedContent)$/.exec(path);
  const events = timeline.significantEvents as any[];
  if (beatPath) {
    const beat = events?.[Number(beatPath[1])]?.beats?.[Number(beatPath[2])];
    const field = beatPath[3]!;
    if (!isRecord(beat) || !isRecord(beat.sourceSemantics) || beat.sourceSemantics.jointAction !== null) throw new Error(`Unrepairable beat field: ${path}`);
    const narrated = beat.sourceSemantics.mode === "narration";
    if ((field === "sourceSemantics/narratedContent") !== narrated && field !== "targets") throw new Error(`Repair cannot change derived narration fields or present narration mode: ${path}`);
    return {parent: field.includes("/") ? beat.sourceSemantics : beat, key: field.split("/").at(-1)!, schema: field === "targets" ? listSchema : stringSchema, beat, remove: false};
  }
  const characterReference = /^\/characters\/(0|[1-9]\d*)\/references\/(0|[1-9]\d*)$/.exec(path);
  const characters = timeline.characters as any[];
  if (characterReference) {
    const refs = characters?.[Number(characterReference[1])]?.references;
    const index = Number(characterReference[2]);
    if (!Array.isArray(refs) || !isRecord(refs[index])) throw new Error(`Unrepairable character reference: ${path}`);
    return {parent: refs, key: String(index), schema: {type: "null"}, beat: undefined, remove: true};
  }
  const relationPath = /^\/relationships\/(0|[1-9]\d*)(\/description)?$/.exec(path);
  const relationships = timeline.relationships as any[];
  if (relationPath && isRecord(relationships?.[Number(relationPath[1])])) {
    const i = Number(relationPath[1]);
    return relationPath[2] ? {parent: relationships[i], key: "description", schema: stringSchema, beat: undefined, remove: false}
      : {parent: relationships, key: String(i), schema: {type: "null"}, beat: undefined, remove: true};
  }
  throw new Error(`Unrepairable source field: ${path}`);
}
export function sourceFieldRepairSchema(timeline: Record<string, unknown>, repair: SourceFieldRepair) {
  if (!repair.fields.length || repair.fields.length > 32 || new Set(repair.fields).size !== repair.fields.length || !repair.reason.trim()) throw new Error("Invalid source repair scope");
  if (repair.fields.some(a => repair.fields.some(b => a !== b && b.startsWith(a + "/")))) throw new Error("Overlapping source repair fields");
  const referenceRemovals = new Map<number, number>();
  for (const path of repair.fields) {
    const match = /^\/characters\/(0|[1-9]\d*)\/references\/(0|[1-9]\d*)$/.exec(path);
    if (match) referenceRemovals.set(Number(match[1]), (referenceRemovals.get(Number(match[1])) ?? 0) + 1);
  }
  for (const [index, count] of referenceRemovals) {
    const refs = (timeline.characters as any[])?.[index]?.references;
    if (!Array.isArray(refs) || refs.length <= count) throw new Error("Character reference repair must retain at least one source reference");
  }
  const properties = Object.fromEntries(repair.fields.map((path, i) => [`field_${i}`, locate(timeline, path).schema]));
  return {type: "object", additionalProperties: false, properties, required: Object.keys(properties)};
}
export function applySourceFieldRepair(timeline: Record<string, unknown>, repair: SourceFieldRepair, values: unknown) {
  const schema = sourceFieldRepairSchema(timeline, repair);
  if (!isRecord(values) || Object.keys(values).length !== schema.required.length || schema.required.some(k => !(k in values))) throw new Error("Repair must supply exactly the approved fields");
  const result = structuredClone(timeline);
  for (const [i, path] of repair.fields.entries()) {
    const target = locate(result, path), value = values[`field_${i}`];
    if (target.remove ? value !== null : path.endsWith("/targets") ? !Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim()) : typeof value !== "string" || !value.trim()) throw new Error(`Invalid repair value: ${path}`);
    if ("enum" in target.schema && !(target.schema.enum as readonly unknown[]).includes(value)) throw new Error(`Invalid repair enum: ${path}`);
    target.parent[target.key] = structuredClone(value);
    if (target.beat && path.endsWith("/narratedContent")) Object.assign(target.beat, narrationFields(target.beat.actor as string, value as string));
  }
  // Remove explicitly invalid relationship assertions only after all original indexes were applied.
  if (Array.isArray(result.relationships)) result.relationships = result.relationships.filter(r => r !== null);
  if (Array.isArray(result.characters)) for (const character of result.characters) {
    if (isRecord(character) && Array.isArray(character.references)) character.references = character.references.filter(r => r !== null);
  }
  return result;
}


/** Detect field contradictions, never interpret action prose or choose corrected values. */
export function sourceClassificationRepair(candidate: Record<string, unknown>): SourceFieldRepair | undefined {
  const fields: string[] = [];
  if (!Array.isArray(candidate.significantEvents)) return;
  candidate.significantEvents.forEach((event, e) => {
    if (!isRecord(event) || !Array.isArray(event.beats)) return;
    event.beats.forEach((beat, b) => {
      if (!isRecord(beat) || !isRecord(beat.sourceSemantics)) return;
      const s = beat.sourceSemantics;
      if (s.jointAction !== null || !["present", "narration"].includes(String(s.mode))
        || s.intentionalRole !== "meaningful" || (beat.actor && beat.agency === "intentional" && beat.stakes !== "routine")) return;
      const base = `/significantEvents/${e}/beats/${b}/`;
      fields.push(base + "sourceSemantics/intentionalRole", base + "stakes");
      if (s.mode === "present") fields.push(base + "agency");
    });
  });
  if (!fields.length || fields.length > 32) return;
  return {fields, reason: "These beats mark intentionalRole=meaningful while actor/agency/stakes do not support an intentional non-routine act. Use the source to decide which mapped classifications are wrong. Keep already correct mapped values unchanged. External events and involuntary experiences may have critical stakes without meaningful intentionalRole. Do not change an external event into a deliberate action just to satisfy validation. All prose, actors, order and evidence remain frozen."};
}

/** Exact targets let the model compare a defect with the actual pointed-to beat,
 * instead of trusting a prose beat number or assuming zero/one-based numbering. */
export function sourceRepairFieldContext(source: Record<string, unknown>, repair: SourceFieldRepair) {
  return repair.fields.map((path, i) => {
    const target = locate(source, path);
    return {field: `field_${i}`, path, currentValue: structuredClone(target.parent[target.key]),
      context: structuredClone(target.beat ?? target.parent)};
  });
}

/** Keep fields from one finding or one beat together; unrelated defects get separate calls. */
export function sourceFieldRepairJobs(repair: SourceFieldRepair): SourceFieldRepair[] {
  if (!repair.evidence?.length) return [repair];
  const unit = (path: string) => {
    const parts = path.split("/");
    return parts[1] === "significantEvents" && parts[3] === "beats" ? parts.slice(0, 5).join("/") : path;
  };
  const pending = new Set(repair.fields);
  const jobs: SourceFieldRepair[] = [];
  while (pending.size) {
    const fields = new Set([pending.values().next().value!]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      const findings = new Set(repair.evidence.filter(e => fields.has(e.path)).flatMap(e => e.findings.map(f => JSON.stringify(f))));
      for (const field of pending) if (!fields.has(field)
        && ([...fields].some(other => unit(other) === unit(field))
          || repair.evidence.some(e => e.path === field && e.findings.some(f => findings.has(JSON.stringify(f)))))) {
        fields.add(field); expanded = true;
      }
    }
    for (const field of fields) pending.delete(field);
    jobs.push({fields: [...fields], reason: "Repair this single coherent defect; all other fields are frozen.",
      evidence: repair.evidence.filter(e => fields.has(e.path))});
  }
  return jobs;
}
