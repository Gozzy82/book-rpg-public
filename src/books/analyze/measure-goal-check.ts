import type { GoalPlan } from "./staged-index.js";
import type { ChapterPartSourceIndex } from "../source-index.js";

export interface ExpectedPrimaryGoal {actor: string; playerBeatIndexes: number[]; endBeatIndex: number}
/** Held-out benchmark assertion. Never included in the generation/review prompts. */
export function checkPrimaryGoal(index: ChapterPartSourceIndex, expected: ExpectedPrimaryGoal) {
  let offset = 0;
  for (const event of index.significantEvents) {
    for (const beat of event.beats) {
      const action = beat.playerAction;
      if (beat.actor !== expected.actor || !action) continue;
      const members = action.playerBeatIndexes.map(i => i + offset);
      if (JSON.stringify(members) === JSON.stringify(expected.playerBeatIndexes)) {
        // An endpoint may include only the other helper's representation of the same
        // joint action; allow either position after this actor's final contribution.
        const end = action.endBeatIndex + offset;
        return end >= expected.playerBeatIndexes.at(-1)! && end <= expected.endBeatIndex;
      }
    }
    offset += event.beats.length;
  }
  return false;
}

/** Check before semantic review/labels so their rejection cannot hide a wrong partition. */
export function checkPrimaryGoalPlan(timeline: ChapterPartSourceIndex["significantEvents"][number], plans: GoalPlan[], expected: ExpectedPrimaryGoal) {
  return plans.some(plan => {
    if (timeline.beats[plan.startBeatIndex]?.actor !== expected.actor) return false;
    const members = timeline.beats.flatMap((beat, i) => i >= plan.startBeatIndex && i <= plan.endBeatIndex
      && beat.actor === expected.actor && beat.agency === "intentional" && beat.stakes !== "routine" ? [i] : []);
    return JSON.stringify(members) === JSON.stringify(expected.playerBeatIndexes)
      && plan.endBeatIndex >= expected.playerBeatIndexes.at(-1)! && plan.endBeatIndex <= expected.endBeatIndex;
  });
}
