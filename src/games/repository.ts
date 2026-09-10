import path from "node:path";
import { CosmosClient } from "@azure/cosmos";
import type { GameState } from "../shared/contracts.js";
import { migrateLegacyWorldRules } from "../shared/world-rules.js";
import { getBook } from "../books/repository.js";
import { azureCredential } from "../azure/credential.js";
import { currentUser } from "../auth/user-context.js";
import { dataDir } from "../util/env.js";
import { JsonFileStore } from "../util/json-file-store.js";
import { compactGameHistory } from "./memory.js";

interface GameStore {
  put(game: GameState): Promise<void>;
  get(gameId: string): Promise<GameState | undefined>;
  list(): Promise<GameState[]>;
}

function withoutIndexedBookMetadata(game: GameState): GameState {
  const {
    wholeBookSummary: _wholeBookSummary,
    characterProfiles: _characterProfiles,
    parameters: _legacyWorldRuleParameters,
    ...storedGame
  } = game;
  return storedGame;
}

class FileGameStore implements GameStore {
  private readonly store = new JsonFileStore<GameState>(path.join(dataDir(), "games"));

  async put(game: GameState): Promise<void> {
    await this.store.put(game.gameId, withoutIndexedBookMetadata(game));
  }

  async get(gameId: string): Promise<GameState | undefined> {
    return await this.store.get(gameId);
  }

  async list(): Promise<GameState[]> {
    return await this.store.list();
  }
}

interface StoredGame extends GameState {
  id: string;
  ownerId: string;
  _etag?: string;
}

function isCosmosNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === 404,
  );
}

class CosmosGameStore implements GameStore {
  private readonly container;
  private readonly versions = new WeakMap<GameState, string>();

  constructor() {
    const endpoint = process.env.COSMOS_ENDPOINT?.trim();
    if (!endpoint) throw new Error("COSMOS_ENDPOINT is required for Azure game storage");
    const databaseName = process.env.COSMOS_DATABASE?.trim() || "bookrpg";
    const containerName = process.env.COSMOS_GAMES_CONTAINER?.trim() || "games";
    const client = new CosmosClient({
      endpoint,
      aadCredentials: azureCredential(),
    });
    this.container = client.database(databaseName).container(containerName);
  }

  async put(game: GameState): Promise<void> {
    const ownerId = currentUser().userId;
    if (game.ownerId && game.ownerId !== ownerId) {
      throw new Error("Cannot save a game owned by another user");
    }
    game.ownerId = ownerId;
    const document: StoredGame = {
      ...withoutIndexedBookMetadata(game),
      id: game.gameId,
      ownerId,
    };
    const version = this.versions.get(game);
    const response = version
      ? await this.container.item(game.gameId, ownerId).replace(document, {
          accessCondition: { type: "IfMatch", condition: version },
        })
      : await this.container.items.upsert(document);
    if (response.etag) this.versions.set(game, response.etag);
  }

  async get(gameId: string): Promise<GameState | undefined> {
    const ownerId = currentUser().userId;
    try {
      const response = await this.container.item(gameId, ownerId).read<StoredGame>();
      if (!response.resource) return undefined;
      const { id: _id, _etag, ...game } = response.resource;
      if (_etag) this.versions.set(game, _etag);
      return game;
    } catch (error) {
      if (isCosmosNotFound(error)) return undefined;
      throw error;
    }
  }

  async list(): Promise<GameState[]> {
    const ownerId = currentUser().userId;
    const response = await this.container.items.query<StoredGame>(
      {
        query: "SELECT * FROM games g WHERE g.ownerId = @ownerId",
        parameters: [{ name: "@ownerId", value: ownerId }],
      },
      { partitionKey: ownerId },
    ).fetchAll();
    return response.resources.map(({ id: _id, _etag, ...game }) => {
      if (_etag) this.versions.set(game, _etag);
      return game;
    });
  }
}

function createGameStore(): GameStore {
  const mode = process.env.BOOKRPG_STORAGE_MODE?.trim().toLowerCase() || "local";
  if (mode === "local") return new FileGameStore();
  if (mode === "azure") return new CosmosGameStore();
  throw new Error(`Unsupported BOOKRPG_STORAGE_MODE: ${mode}`);
}

const store = createGameStore();

export async function saveGame(game: GameState): Promise<void> {
  migrateLegacyWorldRules(game);
  compactGameHistory(game);
  await store.put(game);
}

export async function getGame(gameId: string): Promise<GameState | undefined> {
  const game = await store.get(gameId);
  if (!game) return undefined;

  migrateLegacyWorldRules(game);
  compactGameHistory(game);
  const book = await getBook(game.book.bookId);
  game.wholeBookSummary = book?.worldBible?.summary ?? game.wholeBookSummary;
  game.characterProfiles = book?.worldBible?.characterProfiles ?? game.characterProfiles;
  return game;
}

export async function listGames(): Promise<GameState[]> {
  const games = await store.list();
  games.forEach(migrateLegacyWorldRules);
  return games;
}
