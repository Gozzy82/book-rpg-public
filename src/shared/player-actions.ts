import type { PlayerAction, StoryEventBeat } from "./contracts.js";
import { playerControlsBeat } from "./turn-policy.js";

type Beat = Pick<StoryEventBeat, "actor" | "agency" | "stakes" | "targets" | "decisionBoundaryBefore">;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
/** Structural checks only. Source-grounded goal/boundary accuracy requires semantic evaluation. */
export function parsePlayerAction(value: unknown, start: number, beats: readonly Beat[], characterAliases?: readonly string[]): PlayerAction | undefined {
  if (value === null || value === undefined) return undefined;
  const a = value as PlayerAction;
  const first = beats[start];
  const invalid = (reason: string): never => {
    throw new Error(`Invalid event-local player action at beat index ${start}: ${reason}`);
  };
  if (!a || a.kind !== "player_action") invalid("kind must be player_action");
  for (const field of ["choiceText", "completion", "boundaryReason"] as const) {
    if (!text(a[field])) invalid(`${field} must be a non-empty string`);
  }
  for (const field of ["preconditions", "interruptWhen"] as const) {
    if (!Array.isArray(a[field]) || !a[field].every(text)) {
      invalid(`${field} must be an array of non-empty strings`);
    }
  }
  if (!first?.actor || first.agency !== "intentional" || first.stakes === "routine") {
    return invalid(`group must start on an intentional significant/critical actor beat; got actor=${first?.actor}, agency=${first?.agency}, stakes=${first?.stakes}. Use playerAction=null on automatic/routine beats`);
  }
  if (!Number.isInteger(a.endBeatIndex) || a.endBeatIndex < start || a.endBeatIndex >= beats.length) {
    invalid(`endBeatIndex=${a.endBeatIndex} must be an event-local zero-based index from ${start} to ${beats.length - 1}`);
  }
  if (!Array.isArray(a.playerBeatIndexes) || !a.playerBeatIndexes.length) invalid("playerBeatIndexes must be a non-empty array");
  if (a.playerBeatIndexes[0] !== start) invalid(`playerBeatIndexes must start with ${start}; got ${JSON.stringify(a.playerBeatIndexes)}`);
  if (a.playerBeatIndexes.some((i, n) => !Number.isInteger(i) || i < start || i > a.endBeatIndex
    || (n > 0 && i <= a.playerBeatIndexes[n - 1]!))) {
    invalid(`playerBeatIndexes=${JSON.stringify(a.playerBeatIndexes)} must be unique increasing event-local indexes between ${start} and ${a.endBeatIndex}`);
  }
  const end = a.endBeatIndex;
  for (let i = start; i <= end; i++) {
    const beat = beats[i]!;
    const listed = a.playerBeatIndexes.includes(i);
    const sameActor = characterAliases ? playerControlsBeat({...beat, agency: "intentional", stakes: "significant"}, characterAliases) : beat.actor === first.actor;
    if (!characterAliases && i > start && sameActor && beat.decisionBoundaryBefore?.trim()) {
      invalid(`Player action crosses a new decision boundary at beat index ${i}: ${beat.decisionBoundaryBefore}`);
    }
    if (listed && (!sameActor || beat.agency !== "intentional" || beat.stakes === "routine")
      || !listed && playerControlsBeat(beat, characterAliases ?? [first.actor])) {
      invalid(`Player action crosses an unlisted player action or actor boundary at beat index ${i}: actor=${beat.actor}, agency=${beat.agency}, stakes=${beat.stakes}, listed=${listed}`);
    }
  }
  return {...(text(a.id) ? {id: a.id} : {}), kind: "player_action", endBeatIndex: a.endBeatIndex, boundaryReason: a.boundaryReason.trim(), choiceText: a.choiceText.trim(), completion: a.completion.trim(),
    playerBeatIndexes: [...a.playerBeatIndexes], preconditions: a.preconditions.map(s => s.trim()), interruptWhen: a.interruptWhen.map(s => s.trim())};
}

export function playerActionAt(beats: readonly StoryEventBeat[], start: number | null, aliases: readonly string[]): PlayerAction | undefined {
  if (start === null || !beats[start] || !playerControlsBeat(beats[start]!, aliases)) return undefined;
  const beat = beats[start]!;
  try {
    return beat.characterActionGroup !== undefined
      ? parsePlayerAction(beat.characterActionGroup, start, beats, aliases)
      : parsePlayerAction(beat.playerAction, start, beats);
  } catch { return undefined; }
}
