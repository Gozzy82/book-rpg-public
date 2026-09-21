import type { ChoiceStakes, SourceBeatSemantics, StoryEventBeatAgency } from "./contracts.js";

type Beat = {actor: string | null; agency: StoryEventBeatAgency; stakes: ChoiceStakes; action?: string; resultingState?: string; sourceSemantics?: SourceBeatSemantics};
/** Only records that information was conveyed, not believed or physically reenacted. */
export function narrationFields(actor: string, content: string) {
  return {action: `Recounts: ${content.trim()}`, agency: "intentional" as const,
    resultingState: `${actor} has recounted: ${content.trim()}`};
}
/** Structural contradictions only; source interpretation still needs semantic review. */
export function validateSourceBeatSemantics(beats: readonly Beat[], required = true) {
  const joint = new Map<string, Array<{beat: Beat; index: number}>>();
  for (const [index, beat] of beats.entries()) {
    const s = beat.sourceSemantics;
    if (!s) { if (required) throw new Error(`Beat ${index}: missing sourceSemantics`); else continue; }
    if (!["present", "narration"].includes(s.mode) || !["meaningful", "other"].includes(s.intentionalRole)) throw new Error(`Beat ${index}: invalid source semantics`);
    if (s.mode === "narration") {
      if (!beat.actor || beat.agency !== "intentional" || typeof s.narratedContent !== "string" || !s.narratedContent.trim()) throw new Error(`Beat ${index}: narration must be intentional telling with separate narratedContent`);
      if (required) {
        const expected = narrationFields(beat.actor, s.narratedContent);
        if (beat.action !== expected.action || beat.resultingState !== expected.resultingState) throw new Error(`Beat ${index}: narration requires compiled current telling and conveyed-information state`);
      }
    } else if (s.narratedContent !== null) throw new Error(`Beat ${index}: present beat cannot carry narratedContent`);
    if (s.intentionalRole !== "other" && (!beat.actor || beat.agency !== "intentional" || beat.stakes === "routine")) throw new Error(`Beat ${index}: meaningful action must be intentional and non-routine`);
    if (s.jointAction !== null) {
      const j = s.jointAction;
      if (!j || typeof j.id !== "string" || !j.id.trim() || !Array.isArray(j.participants) || j.participants.length < 2
        || j.participants.some(p => typeof p !== "string" || !p.trim()) || new Set(j.participants).size !== j.participants.length
        || !beat.actor || !j.participants.includes(beat.actor) || beat.agency !== "intentional" || s.mode !== "present"
        || typeof j.resultingState !== "string" || !j.resultingState.trim() || beat.resultingState !== j.resultingState) throw new Error(`Beat ${index}: joint participants must share one actual resulting state without invented intermediate progress`);
      const list = joint.get(j.id) ?? [];
      list.push({beat, index}); joint.set(j.id, list);
    }
  }
  for (const [id, members] of joint) {
    const first = members[0]!.beat.sourceSemantics!.jointAction!;
    const actors = members.map(m => m.beat.actor!);
    if (new Set(actors).size !== actors.length || actors.length !== first.participants.length || !first.participants.every(a => actors.includes(a))) throw new Error(`Joint action ${id}: every participant must have exactly one representation`);
    for (const [i, m] of members.entries()) {
      const j = m.beat.sourceSemantics!.jointAction!;
      if (m.index !== members[0]!.index + i || j.resultingState !== first.resultingState || JSON.stringify([...j.participants].sort()) !== JSON.stringify([...first.participants].sort())) throw new Error(`Joint action ${id}: representations must be contiguous and share participants and outcome`);
    }
  }
}
