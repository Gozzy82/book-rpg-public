import { inspect } from "node:util";

export type WebLogLevel = "log" | "info" | "warn" | "error";

export interface WebLogEntry {
  id: number;
  level: WebLogLevel;
  message: string;
  timestamp: string;
}

const MAX_LOG_ENTRIES = 200;
const LOG_LEVELS = ["log", "info", "warn", "error"] as const;
const originalConsole = Object.fromEntries(
  LOG_LEVELS.map((level) => [level, console[level].bind(console)]),
) as Record<WebLogLevel, (...args: unknown[]) => void>;

let installed = false;
let nextLogId = 1;
const entries: WebLogEntry[] = [];

function formatLogArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  return inspect(value, {
    breakLength: 120,
    depth: 4,
    maxArrayLength: 30,
  });
}

function webLevelFor(level: WebLogLevel, args: unknown[]): WebLogLevel {
  if (level !== "error") return level;
  return args.some((value) => value instanceof Error) ? "error" : "log";
}

export function recordWebLog(level: WebLogLevel, args: unknown[]): void {
  entries.push({
    id: nextLogId,
    level: webLevelFor(level, args),
    message: args.map(formatLogArgument).join(" "),
    timestamp: new Date().toISOString(),
  });
  nextLogId += 1;
  if (entries.length > MAX_LOG_ENTRIES) {
    entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  }
}

export function installConsoleLogCapture(): void {
  if (installed) return;
  installed = true;

  for (const level of LOG_LEVELS) {
    console[level] = (...args: unknown[]) => {
      recordWebLog(level, args);
      originalConsole[level](...args);
    };
  }
}

export function recentWebLogs(limit = 80): WebLogEntry[] {
  const boundedLimit = Math.max(1, Math.min(MAX_LOG_ENTRIES, Math.trunc(limit) || 80));
  return entries.slice(-boundedLimit);
}