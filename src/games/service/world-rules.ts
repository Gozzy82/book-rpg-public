import type { GameState } from "../../shared/contracts.js";
import {
  displayWorldRule,
  setWorldRulesOnGame,
  storedWorldRule,
  worldRulesForGame,
} from "../../shared/world-rules.js";
import { getGame, saveGame } from "../repository.js";
import { MAX_TURN_TEXT_LENGTH } from "./turn-input.js";

export const MAX_BOOKRPG_WORLD_RULES = 20;

export interface AddWorldRuleRequest {
  text: string;
}

export interface WorldRulesResponse {
  gameId: string;
  worldRules: string[];
}

function normalizeWorldRuleText(value: string | undefined): string {
  const text = value?.trim();
  if (!text) throw new Error("World rule text is required");
  if (text.length > MAX_TURN_TEXT_LENGTH) {
    throw new Error(`World rule text must be at most ${MAX_TURN_TEXT_LENGTH} characters`);
  }
  return text;
}

export function appendWorldRule(
  worldRules: readonly string[] | undefined,
  worldRule: string,
): string[] {
  const stored = storedWorldRule(worldRule);
  return [
    ...(worldRules ?? []).filter((existing) => storedWorldRule(existing) !== stored),
    stored,
  ].slice(-MAX_BOOKRPG_WORLD_RULES);
}

export function visibleWorldRules(game: Pick<GameState, "worldRules" | "parameters">): string[] {
  return worldRulesForGame(game).map(displayWorldRule);
}

export async function listWorldRules(gameId: string): Promise<WorldRulesResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  return {
    gameId: game.gameId,
    worldRules: visibleWorldRules(game),
  };
}

export async function addWorldRule(
  gameId: string,
  request: AddWorldRuleRequest,
): Promise<WorldRulesResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");
  if (game.status !== "active") {
    throw new Error(`Game has already ended with status ${game.status}`);
  }

  const text = normalizeWorldRuleText(request.text);
  const worldRules = appendWorldRule(worldRulesForGame(game), text);
  setWorldRulesOnGame(game, worldRules);
  game.updatedAt = new Date().toISOString();
  await saveGame(game);
  return {
    gameId: game.gameId,
    worldRules: visibleWorldRules(game),
  };
}

export async function removeWorldRule(
  gameId: string,
  index: number,
): Promise<WorldRulesResponse> {
  const game = await getGame(gameId);
  if (!game) throw new Error("Game not found");

  const worldRules = [...worldRulesForGame(game)];
  if (!Number.isInteger(index) || index < 0 || index >= worldRules.length) {
    throw new Error("World rule not found");
  }
  worldRules.splice(index, 1);
  setWorldRulesOnGame(game, worldRules);
  game.updatedAt = new Date().toISOString();
  await saveGame(game);
  return {
    gameId: game.gameId,
    worldRules: visibleWorldRules(game),
  };
}
