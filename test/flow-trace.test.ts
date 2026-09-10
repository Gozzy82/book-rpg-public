import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GameState } from "../src/shared/contracts.js";
import { traceEvent, traceGameState, withFlowTrace } from "../src/util/flow-trace.js";

test("flow traces isolate concurrent operations, snapshot data, redact credentials and include nested failures", async () => {
  const previous = process.env.BOOKRPG_FLOW_LOG;
  process.env.BOOKRPG_FLOW_LOG = "true";
  const messages: string[] = [];
  const original = console.error;
  console.error = (message: string) => { messages.push(message); };
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const a = withFlowTrace("a", { authorization: "secret" }, async () => {
      const state = { beat: 0 };
      traceEvent("state", state);
      state.beat = 1;
      await gate;
      return withFlowTrace("nested", {}, async () => "done");
    });
    const failure = new Error("review rejected");
    await assert.rejects(withFlowTrace("b", {}, async () => {
      traceEvent("only-b", {});
      throw failure;
    }), (error) => error === failure);
    release();
    assert.equal(await a, "done");
    assert.equal(messages.length, 2);
    const blocks = messages.map((message) => JSON.parse(message.slice(message.indexOf("\n") + 1, message.lastIndexOf("\n"))));
    const first = blocks.find((block) => block.operation === "a")!;
    const second = blocks.find((block) => block.operation === "b")!;
    assert.notEqual(first.traceId, second.traceId);
    assert.equal(first.events.find((event: any) => event.event === "state").data.beat, 0);
    assert.equal(first.events[0].data.input.authorization, "[REDACTED]");
    assert.ok(first.events.some((event: any) => event.event === "operation.nested"));
    assert.ok(!first.events.some((event: any) => event.event === "only-b"));
    assert.equal(second.events.at(-1).data.message, "review rejected");
    assert.deepEqual(first.events.map((event: any) => event.sequence), [1, 2, 3, 4]);
    process.env.BOOKRPG_FLOW_LOG = "off";
    assert.equal(await withFlowTrace("disabled", {}, async () => 42), 42);
    assert.equal(messages.length, 2);
  } finally {
    console.error = original;
    if (previous === undefined) delete process.env.BOOKRPG_FLOW_LOG;
    else process.env.BOOKRPG_FLOW_LOG = previous;
  }
});

test("engine traces preserve exact scene and choice requests and raw outputs", async () => {
  const { ProviderEngineBase } = await import("../src/ai/engine/provider-engine-base.js");
  class Engine extends ProviderEngineBase {
    async selectSourceCandidate() { return undefined; }
    async selectSourceEvent() { return undefined; }
    call(label: string, input: string) {
      return this.createResponse(label, "book-test", {
        model: "test-model", instructions: "Keep actor roles", input,
      });
    }
  }
  const previous = process.env.BOOKRPG_FLOW_LOG;
  process.env.BOOKRPG_FLOW_LOG = "true";
  const original = console.error;
  const messages: string[] = [];
  console.error = (message: string) => { messages.push(message); };
  const requests: unknown[] = [];
  const engine = new Engine({
    provider: "openai", model: "test-model",
    async createResponse(request) {
      requests.push(request);
      return { output_text: JSON.stringify({ text: request.input }) };
    },
  });
  try {
    await withFlowTrace("turn", {}, async () => {
      await engine.call("scene", "Wink at Dorothy");
      await engine.call("scene choices", "The wink is complete; ask for help next");
    });
    const message = messages.find((item) => item.startsWith("BOOKRPG FLOW BEGIN"))!;
    const block = JSON.parse(message.slice(message.indexOf("\n") + 1, message.lastIndexOf("\n")));
    const inputs = block.events.filter((event: any) => event.event === "ai.request");
    const outputs = block.events.filter((event: any) => event.event === "ai.response");
    assert.deepEqual(inputs.map((event: any) => event.data.request), requests);
    assert.equal(inputs[0].data.request.prompt_cache_key, "bookrpg:book-test");
    assert.notEqual(inputs[0].data.callId, inputs[1].data.callId);
    assert.equal(outputs[0].data.callId, inputs[0].data.callId);
    assert.equal(JSON.parse(outputs[1].data.response.output_text).text, "The wink is complete; ask for help next");
  } finally {
    console.error = original;
    if (previous === undefined) delete process.env.BOOKRPG_FLOW_LOG;
    else process.env.BOOKRPG_FLOW_LOG = previous;
  }
});


let testDirectory: string;
let previousDataDir: string | undefined;
let previousFlowLog: string | undefined;
beforeEach(async () => {
  previousDataDir = process.env.BOOKRPG_DATA_DIR;
  previousFlowLog = process.env.BOOKRPG_FLOW_LOG;
  testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-flow-"));
  process.env.BOOKRPG_DATA_DIR = testDirectory;
  process.env.BOOKRPG_FLOW_LOG = "true";
});
afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.BOOKRPG_DATA_DIR;
  else process.env.BOOKRPG_DATA_DIR = previousDataDir;
  if (previousFlowLog === undefined) delete process.env.BOOKRPG_FLOW_LOG;
  else process.env.BOOKRPG_FLOW_LOG = previousFlowLog;
  await fs.rm(testDirectory, { recursive: true, force: true });
});

function readBlocks(text: string) {
  return [...text.matchAll(/BOOKRPG FLOW BEGIN [^\n]+\n([\s\S]*?)\nBOOKRPG FLOW END [^\n]+/g)]
    .map((match) => JSON.parse(match[1]!));
}

test("local logs append whole concurrent blocks per game and retain failed turns", async () => {
  await withFlowTrace("choice", { gameId: "game_a" }, async () => "first");
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    withFlowTrace("choice", { gameId: "game_a" }, async () => index),
  ));
  const failure = new Error("rejected scene");
  await assert.rejects(withFlowTrace("say", { gameId: "game_b" }, async () => {
    traceEvent("request", { authorization: "secret", input: "Hello Dorothy" });
    throw failure;
  }), (error) => error === failure);
  const a = readBlocks(await fs.readFile(path.join(testDirectory, "logs/games/game_a.log"), "utf8"));
  const bText = await fs.readFile(path.join(testDirectory, "logs/games/game_b.log"), "utf8");
  const b = readBlocks(bText);
  assert.equal(a.length, 9);
  assert.ok(a.every((block) => block.gameId === "game_a"));
  assert.equal(new Set(a.map((block) => block.traceId)).size, 9);
  assert.equal(b.length, 1);
  assert.equal(b[0].events.at(-1).data.message, "rejected scene");
  assert.ok(!bText.includes("secret"));
  assert.ok(bText.includes("Hello Dorothy"));
});

test("local logs associate new games and keep unassigned or invalid IDs inside the log directory", async () => {
  await withFlowTrace("start", {}, async () => {
    traceGameState("state.initial", {
      gameId: "game_new", book: { bookId: "oz" }, playerName: "Scarecrow", turnNumber: 1,
    } as GameState);
    return "started";
  });
  assert.equal(readBlocks(await fs.readFile(path.join(testDirectory, "logs/games/game_new.log"), "utf8"))[0].gameId, "game_new");
  await assert.rejects(withFlowTrace("start", {}, async () => { throw new Error("no book"); }));
  await withFlowTrace("bad-id", { gameId: "../../escaped" }, async () => "done");
  const unassigned = path.join(testDirectory, "logs/games/unassigned");
  const files = await fs.readdir(unassigned);
  assert.equal(files.length, 2);
  for (const file of files) assert.equal(readBlocks(await fs.readFile(path.join(unassigned, file), "utf8")).length, 1);
  assert.deepEqual((await fs.readdir(testDirectory)), ["logs"]);
});

test("local logs can be disabled and disk failures preserve results and original errors", async () => {
  process.env.BOOKRPG_FLOW_LOG = "off";
  assert.equal(await withFlowTrace("choice", { gameId: "game_a" }, async () => 42), 42);
  assert.deepEqual(await fs.readdir(testDirectory), []);
  process.env.BOOKRPG_FLOW_LOG = "true";
  await fs.writeFile(path.join(testDirectory, "logs"), "blocks mkdir");
  const original = console.error;
  const messages: string[] = [];
  console.error = (message: string) => { messages.push(message); };
  try {
    assert.equal(await withFlowTrace("choice", { gameId: "game_a" }, async () => 42), 42);
    const failure = new Error("original");
    await assert.rejects(withFlowTrace("choice", { gameId: "game_a" }, async () => { throw failure; }), (error) => error === failure);
    assert.equal(messages.filter((message) => message.includes("could not save")).length, 2);
    // The failed queue must not poison a later append.
    await fs.rm(path.join(testDirectory, "logs"));
    await withFlowTrace("choice", { gameId: "game_a" }, async () => "recovered");
    assert.equal(readBlocks(await fs.readFile(path.join(testDirectory, "logs/games/game_a.log"), "utf8")).length, 1);
  } finally {
    console.error = original;
  }
});
