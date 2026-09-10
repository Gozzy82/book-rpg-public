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
