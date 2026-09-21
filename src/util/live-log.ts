import { currentUser } from "../auth/user-context.js";

export type WebLogLevel = "log" | "info" | "warn" | "error";

export interface WebLogEntry {
  id: number;
  level: WebLogLevel;
  message: string;
  timestamp: string;
}

export type LiveTurnOperation =
  | "start"
  | "choice"
  | "continue"
  | "story"
  | "dialogue"
  | "event";

interface UserLogBuffer {
  entries: WebLogEntry[];
  nextId: number;
  touchedAt: number;
}

const MAX_LOG_ENTRIES = 200;
const MAX_USER_BUFFERS = 250;
const buffers = new Map<string, UserLogBuffer>();

const TURN_START_MESSAGES: Record<LiveTurnOperation, string> = {
  start: "Starting your adventure...",
  choice: "Processing your choice...",
  continue: "Continuing the story...",
  story: "Following the book...",
  dialogue: "Preparing the conversation response...",
  event: "Applying the world event...",
};

const TURN_COMPLETE_MESSAGES: Record<LiveTurnOperation, string> = {
  start: "Adventure started and saved.",
  choice: "Turn completed and saved.",
  continue: "Story continuation completed and saved.",
  story: "Canonical story step completed and saved.",
  dialogue: "Dialogue turn completed and saved.",
  event: "World event completed and saved.",
};

const AI_ACTIVITY = new Map<string, { start: string; finish: string }>([
  ["scene", { start: "Generating the next scene...", finish: "Scene generation finished" }],
  ["scene choices", { start: "Generating choices...", finish: "Choice generation finished" }],
  ["scene choice review", { start: "Reviewing choices...", finish: "Choice review finished" }],
  ["scene presence review", { start: "Reviewing continuity and world state...", finish: "Continuity review finished" }],
  ["scene repetition review", { start: "Checking for repetition...", finish: "Repetition check finished" }],
  ["dialogue response", { start: "Generating dialogue response...", finish: "Dialogue response finished" }],
  ["dialogue suggestions", { start: "Preparing dialogue choices...", finish: "Dialogue choice generation finished" }],
  ["turn intent review", { start: "Reviewing the selected action...", finish: "Action review finished" }],
]);

function activeUserId(): string | undefined {
  try {
    return currentUser().userId;
  } catch {
    return undefined;
  }
}

function pruneUserBuffers(): void {
  if (buffers.size <= MAX_USER_BUFFERS) return;
  const oldest = [...buffers.entries()]
    .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
    .slice(0, buffers.size - MAX_USER_BUFFERS);
  for (const [userId] of oldest) buffers.delete(userId);
}

function bufferFor(userId: string): UserLogBuffer {
  let buffer = buffers.get(userId);
  if (!buffer) {
    buffer = { entries: [], nextId: 1, touchedAt: Date.now() };
    buffers.set(userId, buffer);
    pruneUserBuffers();
  }
  buffer.touchedAt = Date.now();
  return buffer;
}

function appendSafeLog(level: WebLogLevel, message: string): void {
  const userId = activeUserId();
  if (!userId) return;
  const buffer = bufferFor(userId);
  buffer.entries.push({
    id: buffer.nextId++,
    level,
    message,
    timestamp: new Date().toISOString(),
  });
  if (buffer.entries.length > MAX_LOG_ENTRIES) {
    buffer.entries.splice(0, buffer.entries.length - MAX_LOG_ENTRIES);
  }
}

function durationSuffix(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  return ` in ${(durationMs / 1_000).toFixed(1)}s`;
}

export function recordTurnStart(operation: LiveTurnOperation): void {
  appendSafeLog("log", TURN_START_MESSAGES[operation]);
}

export function recordTurnComplete(operation: LiveTurnOperation): void {
  appendSafeLog("info", TURN_COMPLETE_MESSAGES[operation]);
}

export function recordTurnFailure(_operation: LiveTurnOperation): void {
  appendSafeLog(
    "error",
    "The turn could not be completed. No private story content was added to this log.",
  );
}

export function recordAiStepStart(label: string): void {
  const activity = AI_ACTIVITY.get(label);
  appendSafeLog("log", activity?.start ?? "Processing a story-generation step...");
}

export function recordAiStepFinish(label: string, durationMs: number): void {
  const activity = AI_ACTIVITY.get(label);
  const prefix = activity?.finish ?? "Story-generation step finished";
  appendSafeLog("log", `${prefix}${durationSuffix(durationMs)}.`);
}

export function recordAiRetry(label: string): void {
  appendSafeLog(
    "warn",
    AI_ACTIVITY.has(label) ? "Retrying AI review..." : "Retrying a story-generation step...",
  );
}

export function recordAiStepFailure(_label: string): void {
  appendSafeLog("error", "A story-generation step failed.");
}

export function recentWebLogs(limit = 80): WebLogEntry[] {
  const userId = activeUserId();
  if (!userId) return [];
  const boundedLimit = Math.max(
    1,
    Math.min(MAX_LOG_ENTRIES, Math.trunc(limit) || 80),
  );
  const buffer = buffers.get(userId);
  if (!buffer) return [];
  buffer.touchedAt = Date.now();
  return buffer.entries.slice(-boundedLimit);
}

export async function runWithLiveTurnLog<T>(
  operation: LiveTurnOperation,
  work: () => Promise<T>,
): Promise<T> {
  recordTurnStart(operation);
  try {
    const result = await work();
    recordTurnComplete(operation);
    return result;
  } catch (error) {
    recordTurnFailure(operation);
    throw error;
  }
}

/** Tests only: clears all ephemeral browser-facing live-log buffers. */
export function clearWebLogsForTests(): void {
  buffers.clear();
}
