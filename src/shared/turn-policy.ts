import type { StoryEventBeat } from "./contracts.js";
const identity = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
export function playerControlsBeat(beat: Pick<StoryEventBeat, "actor" | "agency" | "stakes">, aliases: readonly string[]): boolean {
  return Boolean(beat.actor && aliases.some((alias) => identity(alias) === identity(beat.actor!))
    && (beat.agency === "intentional" || beat.agency === "ambiguous") && beat.stakes !== "routine");
}
