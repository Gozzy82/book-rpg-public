import {withFileLock} from '../util/file-lock.js';
import {updateReturnPlanning} from './return-bridges.js';
import { bindSourceAnchorSelection } from "./source-anchor-selection.js";
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
  put(game: GameState, stripIndexedMetadata: boolean): Promise<void>;
  get(gameId: string): Promise<GameState | undefined>;
  list(): Promise<GameState[]>;
  pending(): Promise<GameState[]>;
  change(gameId: string, update: (current: GameState | undefined) => GameState | undefined): Promise<GameState | undefined>;
}

function withoutLegacyParameters(game: GameState): GameState {
  const {
    parameters: _legacyWorldRuleParameters,
    ...storedGame
  } = game;
  return storedGame;
}

function withoutIndexedBookMetadata(
  game: GameState,
  stripIndexedMetadata: boolean,
): GameState {
  const withoutLegacy = withoutLegacyParameters(game);
  if (!stripIndexedMetadata) return withoutLegacy;
  const {
    wholeBookSummary: _wholeBookSummary,
    characterProfiles: _characterProfiles,
    ...storedGame
  } = withoutLegacy;
  return storedGame;
}

class FileGameStore implements GameStore {
  private readonly store = new JsonFileStore<GameState>(path.join(dataDir(), "games"));

  async put(game: GameState, stripIndexedMetadata: boolean): Promise<void> {
    const saved = await this.change(game.gameId, current => prepareGameplaySave(current, game, stripIndexedMetadata));
    if (saved) {
      game.gameRevision = saved.gameRevision;
      if (saved.returnPlanning) game.returnPlanning = saved.returnPlanning;
      else delete game.returnPlanning;
    }
  }

  async change(gameId: string, update: (current: GameState | undefined) => GameState | undefined): Promise<GameState | undefined> {
    if (!/^[a-zA-Z0-9_-]+$/.test(gameId)) throw new Error('Invalid game ID');
    return withFileLock(path.join(dataDir(), 'games', `${gameId}.lock`), async () => {
      const next = update(await this.store.get(gameId));
      if (next) await this.store.put(gameId, next);
      return next;
    });
  }
  async pending(): Promise<GameState[]> { return (await this.store.list()).filter(g => g.returnPlanning?.job); }

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

  async put(game: GameState, stripIndexedMetadata: boolean): Promise<void> {
    const ownerId = currentUser().userId;
    if (game.ownerId && game.ownerId !== ownerId) {
      throw new Error("Cannot save a game owned by another user");
    }
    game.ownerId = ownerId;
    const saved = await this.change(game.gameId, current => prepareGameplaySave(current, game, stripIndexedMetadata));
    if (saved) {
      game.gameRevision = saved.gameRevision;
      if (saved.returnPlanning) game.returnPlanning = saved.returnPlanning;
      else delete game.returnPlanning;
    }
  }

  async change(gameId: string, update: (current: GameState | undefined) => GameState | undefined): Promise<GameState | undefined> {
    const ownerId = currentUser().userId;
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.get(gameId);
      const next = update(current);
      if (!next) return undefined;
      try {
        const document = {...next, id: gameId, ownerId};
        const etag = current && this.versions.get(current);
        if (etag) await this.container.item(gameId, ownerId).replace(document, {accessCondition: {type: 'IfMatch', condition: etag}});
        else await this.container.items.create(document);
        return next;
      } catch (error) {
        if (![409, 412].includes(Number((error as {code?: number}).code))) throw error;
      }
    }
    throw new Error('Concurrent game update; please retry');
  }
  async pending(): Promise<GameState[]> {
    const result = await this.container.items.query<StoredGame>(
      'SELECT * FROM c WHERE IS_DEFINED(c.returnPlanning.job) AND c.status = "active"').fetchAll();
    return result.resources.map(({id: _id, _etag, ...game}) => game);
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

/** A worker changes planning metadata only. Foreground saves preserve worker publications
 * while rejecting a genuinely stale gameplay revision (including undo and two tabs). */
export function prepareGameplaySave(current: GameState | undefined, incoming: GameState, strip: boolean): GameState {
  if (current && (current.gameRevision ?? 0) !== (incoming.gameRevision ?? 0)) {
    throw new Error('The game changed while this turn was generated. Reload and try again.');
  }
  const next = withoutIndexedBookMetadata({...incoming}, strip);
  next.gameRevision = (current?.gameRevision ?? 0) + 1;
  const latest = current?.returnPlanning;
  const changed = incoming.returnPlanning;
  if (latest && (!changed || latest.generation >= changed.generation)) {
    next.returnPlanning = structuredClone(latest);
    if (changed) {
      for (const bridge of next.returnPlanning.bridges) {
        const edit = changed.bridges.find(b => b.id === bridge.id);
        if (edit && (edit.status !== 'ready' || bridge.status === 'offered')) bridge.status = edit.status;
        if (edit?.obsoleteEvidence) bridge.obsoleteEvidence = [...edit.obsoleteEvidence];
        if (edit?.steps) bridge.steps = structuredClone(edit.steps);
        const obsolete = changed.bridges.find(b => b.obsoleteEvidence?.length && b.eventId === bridge.eventId
          && b.targetBeatIndex === bridge.targetBeatIndex && b.indexVersion === bridge.indexVersion
          && b.originCursor === bridge.originCursor);
        if (obsolete) { bridge.status = 'retired'; bridge.obsoleteEvidence = [...obsolete.obsoleteEvidence!]; }
      }
      if (changed.invalidatedTargets?.length) {
        const merged = [...(next.returnPlanning.invalidatedTargets ?? [])];
        for (const invalidation of changed.invalidatedTargets) {
          const existing = merged.find(item =>
            item.eventId === invalidation.eventId
            && item.beatIndex === invalidation.beatIndex
            && item.endBeatIndex === invalidation.endBeatIndex
            && item.indexVersion === invalidation.indexVersion
            && item.originCursor === invalidation.originCursor
          );
          if (existing) {
            existing.evidence = [...new Set([...existing.evidence, ...invalidation.evidence])];
            existing.invalidatedAt = Math.max(existing.invalidatedAt, invalidation.invalidatedAt);
          } else {
            merged.push(structuredClone(invalidation));
          }
        }
        next.returnPlanning.invalidatedTargets = merged.slice(-24);
        for (const bridge of next.returnPlanning.bridges) {
          const invalidation = next.returnPlanning.invalidatedTargets.find(item =>
            bridge.eventId === item.eventId
            && bridge.targetBeatIndex !== undefined
            && bridge.targetBeatIndex >= item.beatIndex
            && bridge.targetBeatIndex <= item.endBeatIndex
            && bridge.indexVersion === item.indexVersion
            && bridge.originCursor === item.originCursor
          );
          if (invalidation) {
            bridge.status = 'retired';
            bridge.obsoleteEvidence = [...invalidation.evidence];
          }
        }
      }
      next.returnPlanning.activeBridgeId = changed.activeBridgeId;
      if (latest.generation === changed.generation) next.returnPlanning.lastMatched = changed.lastMatched;
    }
  } else if (changed) next.returnPlanning = structuredClone(changed);
  if (next.narrativeMode === 'free' || next.returnPlanning) updateReturnPlanning(next);
  return next;
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
  const book = await getBook(game.book.bookId);
  bindSourceAnchorSelection(game, book);
  const stripIndexedMetadata = Boolean(
    book?.worldBible?.summary !== undefined
    || book?.worldBible?.characterProfiles !== undefined,
  );
  await store.put(game, stripIndexedMetadata);
}

export async function getGame(gameId: string): Promise<GameState | undefined> {
  const game = await store.get(gameId);
  if (!game) return undefined;

  migrateLegacyWorldRules(game);
  compactGameHistory(game);
  const book = await getBook(game.book.bookId);
  const wholeBookSummary = book?.worldBible?.summary;
  if (wholeBookSummary !== undefined) {
    game.wholeBookSummary = wholeBookSummary;
  }
  const characterProfiles = book?.worldBible?.characterProfiles;
  if (characterProfiles !== undefined) {
    game.characterProfiles = characterProfiles;
  }
  return game;
}

export async function listGames(): Promise<GameState[]> {
  const games = await store.list();
  games.forEach(migrateLegacyWorldRules);
  return games;
}


/** Internal worker API; transformations must be synchronous and mutate planning only. */
export async function changeReturnPlanning(gameId: string, update: (game: GameState) => boolean): Promise<GameState | undefined> {
  return store.change(gameId, current => {
    if (!current) return undefined;
    const snapshot = structuredClone(current);
    if (!update(snapshot)) return undefined;
    return {...current, returnPlanning: snapshot.returnPlanning};
  });
}
export async function pendingReturnPlanningGames(): Promise<GameState[]> { return store.pending(); }
