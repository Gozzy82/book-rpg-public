import {isRecord} from './output.js';

export interface SourceEventRepair {eventIndexes: number[]; reason: string; findings?: Array<{repairEventIndexes: number[]; reason: string}>}

/** The reviewer chooses event containers, not arbitrary JSON paths. All other
 * source evidence remains frozen. Grouping has not yet been compiled.
 */
export function validateSourceEventRepair(timeline: Record<string, unknown>, repair: SourceEventRepair) {
  const events = timeline.significantEvents;
  if (!Array.isArray(events) || !repair.reason.trim() || !repair.eventIndexes.length
    || repair.eventIndexes.length > 16 || new Set(repair.eventIndexes).size !== repair.eventIndexes.length
    || repair.eventIndexes.some(i => !Number.isInteger(i) || i < 0 || !isRecord(events[i])))
    throw new Error('Invalid source event repair scope');
}
export function sourceEventRepairSchema(timeline: Record<string, unknown>, repair: SourceEventRepair, eventSchema: unknown) {
  validateSourceEventRepair(timeline, repair);
  const properties = Object.fromEntries(repair.eventIndexes.map(i => [`event_${i}`, eventSchema]));
  return {type: 'object', additionalProperties: false, properties, required: Object.keys(properties)};
}
export function applySourceEventRepair(timeline: Record<string, unknown>, repair: SourceEventRepair, replacement: unknown) {
  validateSourceEventRepair(timeline, repair);
  const keys = repair.eventIndexes.map(i => `event_${i}`);
  if (!isRecord(replacement) || Object.keys(replacement).length !== keys.length
    || keys.some(k => !isRecord(replacement[k]))) throw new Error('Replacement must contain exactly the approved event containers');
  const result = structuredClone(timeline);
  const events = result.significantEvents as unknown[];
  for (const i of repair.eventIndexes) events[i] = structuredClone(replacement[`event_${i}`]);
  return result;
}

/** Combine reviewer scopes without broadening them. An event replacement subsumes
 * field repairs inside that same event; fields elsewhere keep their own scope. */
export function combineSourceRepairScopes(issues: readonly {repairFields?: unknown; repairEventIndexes?: unknown}[]): {fields?: string[]; eventIndexes?: number[]} {
  const fields: string[] = [];
  const events: number[] = [];
  for (const issue of issues) {
    const f = issue.repairFields === undefined ? [] : issue.repairFields;
    const e = issue.repairEventIndexes === undefined ? [] : issue.repairEventIndexes;
    if (!Array.isArray(f) || !Array.isArray(e) || (!f.length && !e.length)
      || f.some(p => typeof p !== "string" || !p.trim())
      || e.some(i => !Number.isInteger(i) || i < 0)) return {};
    fields.push(...f);
    events.push(...e);
  }
  const eventIndexes = [...new Set(events)];
  const remaining = [...new Set(fields)].filter(path => {
    const match = /^\/significantEvents\/(0|[1-9]\d*)(?:\/|$)/.exec(path);
    return !match || !eventIndexes.includes(Number(match[1]));
  });
  return {...(remaining.length ? {fields: remaining} : {}), ...(eventIndexes.length ? {eventIndexes} : {})};
}

/** Coupled event repairs stay together; unrelated event defects are separate units. */
export function sourceEventRepairJobs(repair: SourceEventRepair): SourceEventRepair[] {
  if (!repair.findings?.length) return [repair];
  const pending = new Set(repair.eventIndexes);
  const jobs: SourceEventRepair[] = [];
  while (pending.size) {
    const indexes = new Set([pending.values().next().value!]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const finding of repair.findings) if (finding.repairEventIndexes.some(i => indexes.has(i))) {
        for (const i of finding.repairEventIndexes) if (pending.has(i) && !indexes.has(i)) { indexes.add(i); expanded = true; }
      }
    }
    for (const i of indexes) pending.delete(i);
    const findings = repair.findings.filter(f => f.repairEventIndexes.some(i => indexes.has(i)));
    jobs.push({eventIndexes: [...indexes], reason: JSON.stringify(findings), findings});
  }
  return jobs;
}

/** Exact duplicate evidence is a structural regression; semantic equivalence remains an AI decision. */
export function assertNoNewExactDuplicateBeats(before: Record<string, unknown>, after: Record<string, unknown>) {
  const counts = (timeline: Record<string, unknown>) => {
    const result = new Map<string, number>();
    for (const event of timeline.significantEvents as Array<{beats: Array<Record<string, unknown>>}>) {
      for (const beat of event.beats) {
        const key = JSON.stringify([beat.actor, beat.action, beat.references]);
        result.set(key, (result.get(key) ?? 0) + 1);
      }
    }
    return result;
  };
  const old = counts(before);
  for (const [key, count] of counts(after)) if (count > 1 && count > (old.get(key) ?? 0)) {
    throw new Error("Event repair introduced duplicated actor/action/source references; retain each source act once: " + key);
  }
}
