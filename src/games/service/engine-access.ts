import type {GameState} from '../../shared/contracts.js';
import {
  createGameEngine,
} from "../../ai/engine.js";

type GameEngine = ReturnType<typeof createGameEngine>;

export let engine: GameEngine | undefined;

function createConfiguredGameEngine(): GameEngine {
  return createGameEngine();
}

export function gameEngine(): GameEngine {
  engine ??= createConfiguredGameEngine();
  return engine;
}


/** Never fall back to prose heuristics for legacy saves. Failed assessment leaves the save untouched. */
export async function ensureDeathLedger(game: GameState): Promise<boolean> {
  if (game.confirmedDeadCharacters !== undefined) return false;
  game.confirmedDeadCharacters = await gameEngine().assessEstablishedDeaths(game);
  return true;
}
