import path from "node:path";
import { CosmosClient } from "@azure/cosmos";
import type { GameState } from "../shared/contracts.js";
import { azureCredential } from "../azure/credential.js";
import { dataDir, loadDotEnv } from "../util/env.js";
import { JsonFileStore } from "../util/json-file-store.js";

loadDotEnv();

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function run(): Promise<void> {
  const ownerId = requiredEnvironment("BOOKRPG_MIGRATION_OWNER_ID");
  if (!/^[a-f0-9]{64}$/.test(ownerId)) {
    throw new Error("BOOKRPG_MIGRATION_OWNER_ID must be the 64-character ID returned by /api/me");
  }
  const endpoint = requiredEnvironment("COSMOS_ENDPOINT");
  const databaseName = process.env.COSMOS_DATABASE?.trim() || "bookrpg";
  const containerName = process.env.COSMOS_GAMES_CONTAINER?.trim() || "games";
  const sourceDirectory = path.resolve(process.argv[2] || path.join(dataDir(), "games"));
  const games = await new JsonFileStore<GameState>(sourceDirectory).list();
  if (games.length === 0) throw new Error(`No local savegames found in ${sourceDirectory}`);

  const cosmos = new CosmosClient({
    endpoint,
    aadCredentials: azureCredential(),
  });
  const container = cosmos.database(databaseName).container(containerName);
  for (const game of games) {
    await container.items.create({
      ...game,
      id: game.gameId,
      ownerId,
    });
    console.log(`Migrated: ${game.book.title} as ${game.playerName} (${game.gameId})`);
  }
}

run().catch((error: unknown) => {
  console.error(`Savegame migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
