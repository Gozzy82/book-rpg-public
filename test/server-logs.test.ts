import assert from "node:assert/strict";
import test from "node:test";
import { recentWebLogs, recordWebLog } from "../src/server/logs.js";

test("plain stderr messages are displayed as log entries in the web UI", () => {
  recordWebLog("error", ["openai scene..."]);

  const [entry] = recentWebLogs(1);
  assert.equal(entry?.level, "log");
  assert.equal(entry?.message, "openai scene...");
});

test("Error objects remain error entries in the web UI", () => {
  recordWebLog("error", [new Error("The provider failed")]);

  const [entry] = recentWebLogs(1);
  assert.equal(entry?.level, "error");
  assert.match(entry?.message || "", /The provider failed/);
});