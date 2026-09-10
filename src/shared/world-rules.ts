import type { GameState } from "./contracts.js";

declare module "./contracts.js" {
  interface GameState {
    /** Persistent BookRPG world rules. Replaces the legacy `parameters` save field. */
    worldRules?: string[];
  }
}

export const BOOKRPG_WORLD_RULE_PREFIX = "[BOOKRPG WORLD RULE] ";

export function worldRulesForGame(
  game: Pick<GameState, "worldRules" | "parameters">,
): string[] {
  return game.worldRules ?? game.parameters ?? [];
}

function sameRules(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Keep legacy prompt builders and CLI writes working in memory while persisting
 * only `worldRules`. Old saves are upgraded on load. If legacy code reassigns
 * `parameters`, that newer in-memory value is promoted before the next save.
 */
export function migrateLegacyWorldRules(game: GameState): boolean {
  const legacy = game.parameters;
  const current = game.worldRules;
  let changed = false;

  if (current === undefined && legacy?.length) {
    game.worldRules = [...legacy];
    changed = true;
  } else if (
    current !== undefined
    && legacy !== undefined
    && legacy !== current
    && !sameRules(legacy, current)
  ) {
    game.worldRules = [...legacy];
    changed = true;
  }

  const rules = game.worldRules ?? [];
  // Temporary in-memory compatibility mirror for prompt builders that still read
  // state.parameters. repository.ts strips this legacy field before persistence.
  game.parameters = rules;
  return changed;
}

export function setWorldRulesOnGame(game: GameState, worldRules: string[]): void {
  game.worldRules = worldRules;
  game.parameters = worldRules;
}

export function displayWorldRule(value: string): string {
  return value.startsWith(BOOKRPG_WORLD_RULE_PREFIX)
    ? value.slice(BOOKRPG_WORLD_RULE_PREFIX.length)
    : value;
}

export function storedWorldRule(value: string): string {
  const text = displayWorldRule(value).trim();
  return `${BOOKRPG_WORLD_RULE_PREFIX}${text}`;
}
