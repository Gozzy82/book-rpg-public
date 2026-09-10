import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AiRefusalError,
  buildOpenAiResponseRequest,
  buildXaiResponseRequest,
  configuredAiLogFile,
  configuredAiModel,
  configuredIndexModel,
  configuredAiProvider,
  configuredAiReasoningEffort,
  extractOpenAiRefusal,
  logAiRefusal,
  normalizeXaiReasoningEffort,
  withAiProviderCallLogging,
  withOpenAiRateLimitRetries,
} from "../src/ai/provider.js";

interface ProviderCallLogEntry {
  event: string;
  callId: string;
  attempt: number;
  operation: string;
  durationMs?: number;
  request?: {
    input?: string;
    apiKey?: string;
  };
  response?: {
    output_text?: string;
    token?: string;
  };
  error?: {
    status?: number;
    code?: string;
  };
}

test("AI provider configuration supports OpenAI and xAI", () => {
  assert.equal(configuredAiProvider("openai"), "openai");
  assert.equal(configuredAiProvider("XAI"), "xai");
  assert.throws(() => configuredAiProvider("unknown"), /Unsupported BOOKRPG_AI_PROVIDER/);
  assert.equal(configuredAiModel("xai"), process.env.BOOKRPG_AI_MODEL || process.env.XAI_MODEL || "grok-4.6");
  assert.equal(
    configuredIndexModel("xai"),
    process.env.BOOKRPG_INDEX_MODEL
      || process.env.BOOKRPG_AI_MODEL
      || process.env.XAI_MODEL
      || "grok-4.6",
  );
  assert.equal(configuredAiReasoningEffort("medium"), "medium");
});

test("AI provider defaults to OpenAI", () => {
  const configuredProvider = process.env.BOOKRPG_AI_PROVIDER;
  delete process.env.BOOKRPG_AI_PROVIDER;
  try {
    assert.equal(configuredAiProvider(), "openai");
  } finally {
    if (configuredProvider === undefined) {
      delete process.env.BOOKRPG_AI_PROVIDER;
    } else {
      process.env.BOOKRPG_AI_PROVIDER = configuredProvider;
    }
  }
});

test("OpenAI adapter forwards prompt cache keys to the Responses API", () => {
  assert.deepEqual(
    buildOpenAiResponseRequest({
      model: "gpt-test",
      input: "Continue the story.",
      prompt_cache_key: "bookrpg:book-id",
    }),
    {
      model: "gpt-test",
      input: "Continue the story.",
      prompt_cache_key: "bookrpg:book-id",
    },
  );
});

test("xAI adapter maps requests to the Responses API with supported reasoning effort", () => {
  assert.deepEqual(
    buildXaiResponseRequest({
      model: "grok-4.6",
      reasoning: { effort: "minimal" },
      instructions: "Return a scene.",
      input: "Continue the story.",
      text: {
        format: {
          type: "json_schema",
          name: "scene",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
      max_output_tokens: 1_600,
      prompt_cache_key: "bookrpg:book-id",
    }),
    {
      model: "grok-4.6",
      input: "Continue the story.",
      instructions: "Return a scene.",
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "scene",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
      max_output_tokens: 1_600,
      prompt_cache_key: "bookrpg:book-id",
      store: false,
    },
  );
  assert.equal(normalizeXaiReasoningEffort("none"), "low");
  assert.equal(normalizeXaiReasoningEffort("minimal"), "low");
  assert.equal(normalizeXaiReasoningEffort("medium"), "medium");
  assert.equal(normalizeXaiReasoningEffort("max"), "xhigh");
});

test("OpenAI refusal content is extracted without logging the request input", () => {
  assert.equal(
    extractOpenAiRefusal({
      output: [
        {
          type: "message",
          content: [
            {
              type: "refusal",
              refusal: "I cannot generate that content.",
            },
          ],
        },
      ],
    }),
    "I cannot generate that content.",
  );
  assert.equal(
    extractOpenAiRefusal({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "{}" }],
        },
      ],
    }),
    undefined,
  );
});

test("AI refusals log and expose the provider, model, and refusal reason", () => {
  const logs: string[] = [];
  const error = logAiRefusal(
    "openai",
    "gpt-test",
    "The request was blocked by a safety policy.",
    (message) => logs.push(message),
  );

  assert.ok(error instanceof AiRefusalError);
  assert.equal(error.provider, "openai");
  assert.equal(error.model, "gpt-test");
  assert.equal(error.reason, "The request was blocked by a safety policy.");
  assert.match(
    error.message,
    /openai model gpt-test refused the AI request: The request was blocked by a safety policy\./,
  );
  assert.deepEqual(logs, [error.message]);
});

test("provider call logging records full requests, responses, errors, and redacts credentials", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-ai-log-"));
  const logFile = path.join(directory, "provider-calls.jsonl");
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const response = await withAiProviderCallLogging(
    {
      provider: "openai",
      model: "gpt-test",
      callId: "call-success",
      attempt: 1,
      logFile,
      request: {
        model: "gpt-test",
        input: "Continue the exact scene.",
        apiKey: "must-not-be-written",
        text: {
          format: {
            type: "json_schema",
            name: "bookrpg_scene",
          },
        },
      },
    },
    async () => ({
      id: "response-1",
      output_text: "{\"title\":\"Next\"}",
      token: "must-also-be-redacted",
    }),
  );
  assert.equal(response.id, "response-1");

  const providerError = Object.assign(new Error("rate limit reached"), {
    status: 429,
    code: "rate_limit_exceeded",
    apiKey: "must-not-be-written",
  });
  await assert.rejects(
    withAiProviderCallLogging(
      {
        provider: "openai",
        model: "gpt-test",
        callId: "call-error",
        attempt: 2,
        logFile,
        request: {
          model: "gpt-test",
          input: "Retry the scene.",
        },
      },
      async () => {
        throw providerError;
      },
    ),
    (error) => error === providerError,
  );

  const text = await fs.readFile(logFile, "utf8");
  const entries = text.trim().split(/\r?\n/).map(
    (line) => JSON.parse(line) as ProviderCallLogEntry,
  );
  assert.deepEqual(
    entries.map((entry) => [entry.event, entry.callId, entry.attempt]),
    [
      ["request", "call-success", 1],
      ["response", "call-success", 1],
      ["request", "call-error", 2],
      ["error", "call-error", 2],
    ],
  );
  assert.equal(entries[0]?.operation, "bookrpg_scene");
  assert.equal(entries[0]?.request?.input, "Continue the exact scene.");
  assert.equal(entries[0]?.request?.apiKey, "[REDACTED]");
  assert.equal(entries[1]?.response?.output_text, "{\"title\":\"Next\"}");
  assert.equal(entries[1]?.response?.token, "[REDACTED]");
  assert.equal(entries[3]?.error?.status, 429);
  assert.equal(entries[3]?.error?.code, "rate_limit_exceeded");
  assert.doesNotMatch(text, /must-not-be-written|must-also-be-redacted/);
  assert.ok(Number.isInteger(entries[1]?.durationMs));
});

test("provider call logging can be disabled explicitly", () => {
  assert.equal(configuredAiLogFile("off"), undefined);
  assert.equal(configuredAiLogFile("FALSE"), undefined);
  assert.equal(
    configuredAiLogFile("./custom-ai-calls.jsonl"),
    path.resolve("./custom-ai-calls.jsonl"),
  );
});

test("OpenAI rate limits wait for the requested reset and retry", async () => {
  let calls = 0;
  const delays: number[] = [];
  const logs: string[] = [];

  const result = await withOpenAiRateLimitRetries(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("429 rate limit reached"), {
        status: 429,
        headers: new Headers({ "x-ratelimit-reset-tokens": "45s" }),
        code: "rate_limit_exceeded",
        error: {
          code: "rate_limit_exceeded",
          message: "Please try again in 2.826s.",
        },
      });
    }
    return "completed";
  }, {
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
    log: (message) => {
      logs.push(message);
    },
  });

  assert.equal(result, "completed");
  assert.equal(calls, 2);
  assert.equal(delays.length, 1);
  assert.ok(delays[0]! >= 3_076 && delays[0]! <= 3_077);
  assert.match(logs[0]!, /retrying in 3\.07[67]s \(1\/4\)/);
});

test("OpenAI rate-limit retries are bounded and do not retry exhausted quota", async () => {
  let rateLimitCalls = 0;
  const rateLimitError = Object.assign(new Error("429 rate limit reached"), {
    status: 429,
    headers: new Headers({ "retry-after-ms": "0" }),
    code: "rate_limit_exceeded",
  });

  await assert.rejects(
    withOpenAiRateLimitRetries(async () => {
      rateLimitCalls += 1;
      throw rateLimitError;
    }, {
      maxRetries: 2,
      sleep: async () => {},
      log: () => {},
    }),
    (error) => error === rateLimitError,
  );
  assert.equal(rateLimitCalls, 3);

  let quotaCalls = 0;
  const quotaError = Object.assign(new Error("429 insufficient quota"), {
    status: 429,
    headers: new Headers(),
    code: "insufficient_quota",
  });
  await assert.rejects(
    withOpenAiRateLimitRetries(async () => {
      quotaCalls += 1;
      throw quotaError;
    }, {
      sleep: async () => {
        assert.fail("Exhausted quota must not be retried");
      },
      log: () => {},
    }),
    (error) => error === quotaError,
  );
  assert.equal(quotaCalls, 1);
});
