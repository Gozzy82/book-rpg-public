import assert from "node:assert/strict";
import test from "node:test";
import { runAsUser } from "../src/auth/user-context.js";
import {
  clearWebLogsForTests,
  recentWebLogs,
  recordAiRetry,
  recordAiStepFinish,
  recordAiStepStart,
  recordTurnFailure,
  recordTurnStart,
  runWithLiveTurnLog,
} from "../src/server/logs.js";

const userA = {
  userId: "safe-log-user-a",
  displayName: "Reader A",
  provider: "local",
};

const userB = {
  userId: "safe-log-user-b",
  displayName: "Reader B",
  provider: "local",
};

test.beforeEach(() => clearWebLogsForTests());

test("browser live logs are isolated per authenticated user", async () => {
  await runAsUser(userA, async () => {
    recordTurnStart("choice");
    recordAiStepStart("scene");
  });
  await runAsUser(userB, async () => {
    recordTurnStart("dialogue");
  });

  await runAsUser(userA, async () => {
    assert.deepEqual(
      recentWebLogs().map((entry) => entry.message),
      [
        "Processing your choice...",
        "Generating the next scene...",
      ],
    );
  });
  await runAsUser(userB, async () => {
    assert.deepEqual(
      recentWebLogs().map((entry) => entry.message),
      ["Preparing the conversation response..."],
    );
  });
});

test("unknown AI labels never echo dynamic or private content", async () => {
  await runAsUser(userA, async () => {
    recordAiStepStart("secret reader@example.test custom action");
    recordAiRetry("secret reader@example.test custom action");
    recordAiStepFinish("secret reader@example.test custom action", 1234);
  });

  await runAsUser(userA, async () => {
    const text = recentWebLogs().map((entry) => entry.message).join("\n");
    assert.doesNotMatch(text, /reader@example\.test/);
    assert.doesNotMatch(text, /custom action/);
    assert.match(text, /Processing a story-generation step/);
    assert.match(text, /1\.2s/);
  });
});

test("known AI stages expose only fixed operational messages", async () => {
  await runAsUser(userA, async () => {
    recordAiStepStart("scene presence review");
    recordAiStepFinish("scene presence review", 2500);
  });

  await runAsUser(userA, async () => {
    assert.deepEqual(
      recentWebLogs().map((entry) => entry.message),
      [
        "Reviewing continuity and world state...",
        "Continuity review finished in 2.5s.",
      ],
    );
  });
});

test("turn failures never expose exception details", async () => {
  await runAsUser(userA, async () => {
    recordTurnFailure("choice");
    await assert.rejects(
      () => runWithLiveTurnLog("continue", async () => {
        throw new Error("private player dialogue reader@example.test");
      }),
      /private player dialogue/,
    );
  });

  await runAsUser(userA, async () => {
    const text = recentWebLogs().map((entry) => entry.message).join("\n");
    assert.doesNotMatch(text, /reader@example\.test|private player dialogue/);
    assert.match(text, /turn could not be completed/i);
  });
});

test("logging outside authenticated request context is ignored", () => {
  recordTurnStart("choice");
  assert.deepEqual(recentWebLogs(), []);
});
