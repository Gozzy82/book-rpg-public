import { parsePlayerAction } from "../../shared/player-actions.js";
import type { ChapterPartSourceIndex } from "../source-index.js";
import type { ChapterAnalysisPart, CreateAnalysisResponse } from "./batching.js";
import { formatAnalysisPart } from "./batching.js";
import { isRecord, parseChapterSourceIndexes, requireOutputText } from "./output.js";

export type PlayerActionRepairCache = Map<string, {raw: Record<string, unknown>; eventsToRepair?: Set<number>}>;

/** Validate source evidence independently before attempting to repair optional action metadata. */
export function sourceWithoutPlayerActions(raw: Record<string, unknown>, part: ChapterAnalysisPart): {index: ChapterPartSourceIndex; error?: never} | {index?: never; error: string} {
  const stripped = structuredClone(raw);
  if (!Array.isArray(stripped.significantEvents)) return {error: "significantEvents must be an array"};
  for (const event of stripped.significantEvents) {
    if (!isRecord(event) || !Array.isArray(event.beats)) return {error: "Every significant event must contain a beats array"};
    for (const beat of event.beats) {
      if (!isRecord(beat)) return {error: "Every beat must be an object"};
      beat.playerAction = null;
    }
  }
  const result = parseChapterSourceIndexes(JSON.stringify({[part.sourceId]: stripped}), [part], 0);
  const base = result.indexes.get(part.sourceId);
  if (!base) return {error: result.validationErrors.get(part.sourceId) ?? "Invalid source evidence"};
  if (base.significantEvents.some(e => e.beats.some(b => !b.resultingState?.trim()))) {
    return {error: "Every generated beat requires a non-empty source-backed resultingState."};
  }
  return {index: base};
}

/** One repair attempt per invalid event. Completed repairs survive subsequent batch attempts. */
export async function repairPlayerActions(
  createResponse: CreateAnalysisResponse,
  model: string,
  part: ChapterAnalysisPart,
  raw: Record<string, unknown>,
  base: ChapterPartSourceIndex,
  instructions: readonly string[],
  previousError: string,
  eventsToRepair: Set<number> = new Set(),
): Promise<void> {
  const events = raw.significantEvents as Array<{beats: Array<Record<string, unknown>>}>;
  for (const [eventIndex, event] of base.significantEvents.entries()) {
    const original = events[eventIndex]!;
    try {
      original.beats.forEach((b, i) => parsePlayerAction(b.playerAction, i, event.beats));
      if (!eventsToRepair.has(eventIndex)) continue;
    } catch { /* Source evidence is valid; only this event's grouping needs repair. */ }
    const starts = event.beats.flatMap((b, i) => b.actor && b.agency === "intentional" && b.stakes !== "routine" ? [i] : []);
    const properties: Record<string, unknown> = {};
    const allowedEnds = new Map<number, number[]>();
    for (const start of starts) {
      const actor = event.beats[start]!.actor;
      const boundary = event.beats.findIndex((b, i) => i > start && b.actor === actor && Boolean(b.decisionBoundaryBefore?.trim()));
      const last = boundary < 0 ? event.beats.length - 1 : boundary - 1;
      const ends = Array.from({length: last - start + 1}, (_, i) => start + i);
      allowedEnds.set(start, ends);
      properties[`beat_${start}`] = {description: `Event ${eventIndex}, beat ${start}, owner ${actor}: ${event.beats[start]!.action}`, anyOf: [{type: "null"}, {type: "object", additionalProperties: false,
        properties: {
          endBeatIndex: {type: "integer", enum: ends},
          choiceText: {type: "string"}, completion: {type: "string"}, boundaryReason: {type: "string"},
          preconditions: {type: "array", items: {type: "string", minLength: 1}},
          interruptWhen: {type: "array", items: {type: "string", minLength: 1}},
        }, required: ["endBeatIndex", "choiceText", "completion", "boundaryReason", "preconditions", "interruptWhen"]}]};
    }
    // No meaningful intentional start exists: metadata cannot authorize any player act here.
    if (!starts.length) {
      original.beats.forEach(b => { b.playerAction = null; });
      continue;
    }
    const response = await createResponse({model, reasoning: {effort: "low"},
      instructions: [...instructions,
        "REPAIR ONLY: the source timeline below is already validated and immutable. Return only action annotations for the provided beat_N slots. N is the explicit event-local beat index. Choose endBeatIndex from the slot's enum. The server derives playerBeatIndexes from the selected actor and window; do not return indexes yourself. Never change names, actions, stakes, references, states or decision boundaries. Use null for continuation of another group or uncertain grouping. Do not overlap groups belonging to the same actor. An endpoint includes every intervening meaningful intentional beat by the selected actor; stop before a new goal, meaningful new information or commitment.",
        `Previous validation error: ${previousError}`].join("\n"),
      input: `${formatAnalysisPart(part)}\n\nIMMUTABLE EVENT ${eventIndex} (zero-based):\n${JSON.stringify({...event, beats: event.beats.map((b, beatIndex) => ({...b, beatIndex}))})}\nPREVIOUS ANNOTATIONS:\n${JSON.stringify(Object.fromEntries(original.beats.map((b, i) => [`beat_${i}`, {actor: event.beats[i]!.actor, action: event.beats[i]!.action, playerAction: b.playerAction ?? null}])))}`,
      text: {format: {type: "json_schema", name: "bookrpg_player_action_repair", strict: true,
        schema: {type: "object", additionalProperties: false, properties, required: Object.keys(properties)}}},
      max_output_tokens: Math.min(16000, Math.max(2500, starts.length * 600)),
    });
    const value: unknown = JSON.parse(requireOutputText(response, "player action repair"));
    if (!isRecord(value) || Object.keys(value).length !== starts.length || Object.keys(value).some(k => !(k in properties))) {
      throw new Error(`Player action repair event ${eventIndex + 1}: return exactly the requested beat_N slots`);
    }
    const repaired = new Map<number, NonNullable<ReturnType<typeof parsePlayerAction>>>();
    for (const start of starts) {
      const item = value[`beat_${start}`];
      if (item === null) continue;
      if (!isRecord(item) || !allowedEnds.get(start)!.includes(item.endBeatIndex as number)) {
        throw new Error(`Player action repair event ${eventIndex + 1}, beat ${start}: endBeatIndex must be one of ${allowedEnds.get(start)}`);
      }
      const playerBeatIndexes = starts.filter(i => i >= start && i <= (item.endBeatIndex as number) && event.beats[i]!.actor === event.beats[start]!.actor);
      const action = parsePlayerAction({...item, kind: "player_action", playerBeatIndexes}, start, event.beats)!;
      if ([...repaired].some(([i, a]) => event.beats[i]!.actor === event.beats[start]!.actor && a.endBeatIndex >= start)) {
        throw new Error(`Player action repair event ${eventIndex + 1}: overlapping goals at beat ${start}; use null on continuations`);
      }
      repaired.set(start, action);
    }
    // A metadata-only repair may merge groups, but cannot evade semantic review
    // by dropping the rejected goal and returning an all-null event.
    if (eventsToRepair.has(eventIndex)) {
      for (const start of starts) {
        if (original.beats[start]!.playerAction && ![...repaired.values()].some(a => a.playerBeatIndexes.includes(start))) {
          throw new Error(`Player action repair event ${eventIndex}, beat ${start}: preserve the reviewed goal in a corrected or merged group`);
        }
      }
    }
    // Commit only a completely validated event repair, preserving every atomic source field.
    original.beats.forEach((b, i) => { b.playerAction = repaired.get(i) ?? null; });
    eventsToRepair.delete(eventIndex);
  }
}
