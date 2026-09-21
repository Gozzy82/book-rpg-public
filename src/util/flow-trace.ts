import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./env.js";
import type { GameState } from "../shared/contracts.js";

interface FlowTrace {
  id: string;
  startedAt: number;
  gameId?: string;
  logDirectory: string;
  events: unknown[];
}
const context = new AsyncLocalStorage<FlowTrace>();
const sensitiveField = /^(?:api[-_]?key|authorization|cookie|password|token|(?:access|id|refresh)[-_]?token)$/iu;

// Serialize appends per file so concurrent operations cannot interleave blocks.
const writes = new Map<string, Promise<void>>();

function flowLoggingDisabled(): boolean {
  return /^(0|false|off|none)$/i.test(
    process.env.BOOKRPG_FLOW_LOG?.trim() ?? "",
  );
}

function gameIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("gameId" in value)) return undefined;
  return typeof value.gameId === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value.gameId)
    ? value.gameId : undefined;
}

async function persistTrace(trace: FlowTrace, block: string): Promise<void> {
  // Starts which fail before a game ID exists still leave recoverable diagnostics.
  const logFile = trace.gameId
    ? path.join(trace.logDirectory, `${trace.gameId}.log`)
    : path.join(trace.logDirectory, "unassigned", `${trace.id}.log`);
  const write = (writes.get(logFile) ?? Promise.resolve()).then(async () => {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.appendFile(logFile, `${block}\n\n`, "utf8");
  });
  const settled = write.catch(() => undefined);
  writes.set(logFile, settled);
  try {
    await write;
  } catch (error) {
    // Diagnostics must never turn a successful save into an apparent failed turn,
    // or replace the actual generation error.
    console.error(`BOOKRPG FLOW could not save ${logFile}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (writes.get(logFile) === settled) writes.delete(logFile);
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (sensitiveField.test(key)) return "[REDACTED]";
    if (item instanceof Error) return { name: item.name, message: item.message };
    return typeof item === "bigint" ? String(item) : item;
  }, 2);
}

export function traceEvent(event: string, data: unknown): void {
  const trace = context.getStore();
  if (!trace) return;
  // Snapshot now: later state mutations must not rewrite earlier evidence.
  trace.events.push(JSON.parse(serialize({
    sequence: trace.events.length + 1,
    elapsedMs: Math.round(performance.now() - trace.startedAt),
    event,
    data,
  })));
}

export function flowDiagnostic(...args: unknown[]): void {
  traceEvent("decision", args);
  if (flowLoggingDisabled()) return;
  console.error(...args);
}

export function traceGameState(event: string, game: GameState): void {
  const trace = context.getStore();
  if (trace && !trace.gameId) trace.gameId = gameIdFrom(game);
  traceEvent(event, {
    gameId: game.gameId, bookId: game.book.bookId, playerName: game.playerName,
    turnNumber: game.turnNumber, status: game.status, position: game.position,
    sourceCursor: game.sourceCursor, sourceEventProgress: game.sourceEventProgress,
    establishedEvent: game.establishedEvent, scene: game.scene,
    confirmedDeadCharacters: game.confirmedDeadCharacters,
    activeConversation: game.activeConversation,
    activeConversationAnchorDirected: game.activeConversationAnchorDirected,
    parameters: game.parameters,
  });
}

export async function withFlowTrace<T>(
  operation: string, input: unknown, run: () => Promise<T>,
): Promise<T> {
  if (context.getStore()) {
    traceEvent("operation.nested", { operation, input });
    return await run();
  }
  if (flowLoggingDisabled()) {
    return await run();
  }
  const trace: FlowTrace = {
    id: randomUUID(), startedAt: performance.now(), events: [],
    gameId: gameIdFrom(input), logDirectory: path.join(dataDir(), "logs", "games"),
  };
  return await context.run(trace, async () => {
    traceEvent("operation.begin", { operation, input, timestamp: new Date().toISOString() });
    try {
      const result = await run();
      traceEvent("operation.result", result);
      return result;
    } catch (error) {
      traceEvent("operation.error", error);
      throw error;
    } finally {
      // A single console entry keeps concurrent turns separate and is copyable in web logs.
      const block = `BOOKRPG FLOW BEGIN ${trace.id}\n${serialize({
        version: 1, traceId: trace.id, gameId: trace.gameId, operation, events: trace.events,
      })}\nBOOKRPG FLOW END ${trace.id}`;
      console.error(block);
      await persistTrace(trace, block);
    }
  });
}


