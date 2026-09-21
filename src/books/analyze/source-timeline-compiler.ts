import { isRecord } from "./output.js";
import { narrationFields } from "../../shared/source-beat-semantics.js";

/** Compile only the new generation format, never silently repair an old candidate.
 * Classification/content remain untrusted until the complete source audit passes.
 */
export function compileSourceTimeline(candidate: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(candidate);
  if (!Array.isArray(result.significantEvents)) throw new Error("Missing source events");
  for (const event of result.significantEvents) {
    if (!isRecord(event) || !Array.isArray(event.beats)) throw new Error("Missing source beats");
    for (const beat of event.beats) {
      if (!isRecord(beat) || !isRecord(beat.sourceSemantics)) throw new Error("Missing sourceSemantics");
      const semantics = beat.sourceSemantics;
      if (semantics.mode !== "narration") continue;
      if (["action", "agency", "resultingState"].some(key => key in beat)) throw new Error("Narration response must not supply independently generated action, agency or resultingState");
      if (typeof beat.actor !== "string" || !beat.actor.trim() || typeof semantics.narratedContent !== "string" || !semantics.narratedContent.trim()) throw new Error("Narration requires narrator and source-backed narratedContent");
      Object.assign(beat, narrationFields(beat.actor, semantics.narratedContent));
    }
  }
  return result;
}
