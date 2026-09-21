import type { TurnContract } from "./engine/turn-contract.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

export type AiProviderName = "openai" | "xai";
export type AiReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface AiJsonSchemaFormat {
  type: "json_schema";
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

export interface AiResponseRequest {
  /** Internal control data; removed before sending to a provider. */
  turnContract?: TurnContract;
  model: string;
  reasoning?: { effort: AiReasoningEffort };
  instructions?: string;
  input: string;
  text?: { format: AiJsonSchemaFormat };
  max_output_tokens?: number;
  prompt_cache_key?: string;
}

export interface AiResponse {
  output_text: string;
  status?: string;
  incomplete_details?: unknown;
  usage?: {input_tokens: number; output_tokens: number; total_tokens: number; output_tokens_details?: {reasoning_tokens: number}};
}

export class AiRefusalError extends Error {
  constructor(
    readonly provider: AiProviderName,
    readonly model: string,
    readonly reason: string,
  ) {
    super(`${provider} model ${model} refused the AI request: ${reason}`);
    this.name = "AiRefusalError";
  }
}

export interface AiClient {
  readonly provider: AiProviderName;
  readonly model: string;
  createResponse(request: AiResponseRequest): Promise<AiResponse>;
}

export function configuredAiProvider(
  value = process.env.BOOKRPG_AI_PROVIDER || "openai",
): AiProviderName {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "xai") return normalized;
  throw new Error(`Unsupported BOOKRPG_AI_PROVIDER: ${value}`);
}

export function configuredAiModel(provider = configuredAiProvider()): string {
  const configured = process.env.BOOKRPG_AI_MODEL?.trim();
  if (configured) return configured;
  if (provider === "xai") return process.env.XAI_MODEL?.trim() || "grok-4.6";
  return process.env.OPENAI_MODEL?.trim() || "gpt-5-nano";
}

export function configuredIndexModel(provider = configuredAiProvider()): string {
  return process.env.BOOKRPG_INDEX_MODEL?.trim() || configuredAiModel(provider);
}

export function configuredAiReasoningEffort(
  value = process.env.BOOKRPG_AI_REASONING_EFFORT
    || process.env.OPENAI_REASONING_EFFORT
    || "minimal",
): AiReasoningEffort {
  const supported: AiReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (!supported.includes(value as AiReasoningEffort)) {
    throw new Error(`Unsupported BOOKRPG_AI_REASONING_EFFORT: ${value}`);
  }
  return value as AiReasoningEffort;
}

function requiredApiKey(provider: AiProviderName): string {
  const variable = provider === "xai" ? "XAI_API_KEY" : "OPENAI_API_KEY";
  const apiKey = process.env[variable]?.trim();
  if (!apiKey) {
    throw new Error(`${variable} is required when BOOKRPG_AI_PROVIDER=${provider}`);
  }
  return apiKey;
}

const DEFAULT_OPENAI_RATE_LIMIT_RETRIES = 4;
const MAX_OPENAI_RATE_LIMIT_DELAY_MS = 60_000;
const OPENAI_RATE_LIMIT_DELAY_BUFFER_MS = 250;

export interface OpenAiRateLimitRetryOptions {
  maxRetries?: number;
  sleep?: (delayMs: number) => Promise<void>;
  log?: (message: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

const DEFAULT_AI_CALL_LOG_FILENAME = "ai-provider-calls.jsonl";
const DISABLED_AI_LOG_VALUES = new Set(["0", "false", "none", "off"]);
const SENSITIVE_LOG_FIELD =
  /^(?:api[-_]?key|authorization|cookie|password|proxy[-_]?authorization|set[-_]?cookie|token|(?:access|id|refresh)[-_]?token)$/iu;

export function configuredAiLogFile(
  value = process.env.BOOKRPG_AI_LOG_FILE,
): string | undefined {
  const configured = value?.trim();
  if (configured && DISABLED_AI_LOG_VALUES.has(configured.toLowerCase())) {
    return undefined;
  }
  return path.resolve(
    configured
      || path.join(
        process.env.BOOKRPG_DATA_DIR?.trim() || "./data",
        DEFAULT_AI_CALL_LOG_FILENAME,
      ),
  );
}

export interface AiProviderCallLogOptions {
  provider: AiProviderName;
  model: string;
  request: unknown;
  callId?: string;
  attempt?: number;
  logFile?: string;
}

let aiCallLogWriteQueue: Promise<void> = Promise.resolve();

function serializeAiCallLogEntry(entry: unknown): string {
  return JSON.stringify(entry, (key, value: unknown) => {
    if (key && SENSITIVE_LOG_FIELD.test(key)) return "[REDACTED]";
    return typeof value === "bigint" ? value.toString() : value;
  });
}

async function appendAiCallLogEntry(logFile: string, entry: unknown): Promise<void> {
  const line = `${serializeAiCallLogEntry(entry)}\n`;
  const write = aiCallLogWriteQueue.then(async () => {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.appendFile(logFile, line, "utf8");
  });
  aiCallLogWriteQueue = write.catch(() => undefined);
  await write;
}

function aiProviderOperation(request: unknown): string {
  const format = asRecord(asRecord(asRecord(request)?.text)?.format);
  const name = format?.name;
  return typeof name === "string" && name.trim()
    ? name.trim()
    : "responses.create";
}

function aiProviderErrorDetails(error: unknown): Record<string, unknown> {
  const details = asRecord(error);
  const result: Record<string, unknown> = {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
  for (const key of ["status", "code", "type", "param", "request_id"] as const) {
    const value = details?.[key];
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
      || value === null
    ) {
      result[key] = value;
    }
  }
  return result;
}

export async function withAiProviderCallLogging<T>(
  options: AiProviderCallLogOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const logFile = options.logFile === undefined
    ? configuredAiLogFile()
    : path.resolve(options.logFile);
  if (!logFile) return await operation();

  const callId = options.callId ?? crypto.randomUUID();
  const attempt = options.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("AI provider call log attempt must be a positive integer");
  }
  const base = {
    callId,
    attempt,
    provider: options.provider,
    model: options.model,
    operation: aiProviderOperation(options.request),
  };
  await appendAiCallLogEntry(logFile, {
    timestamp: new Date().toISOString(),
    event: "request",
    ...base,
    request: options.request,
  });

  const startedAt = performance.now();
  try {
    const response = await operation();
    await appendAiCallLogEntry(logFile, {
      timestamp: new Date().toISOString(),
      event: "response",
      ...base,
      durationMs: Math.round(performance.now() - startedAt),
      response,
    });
    return response;
  } catch (error) {
    try {
      await appendAiCallLogEntry(logFile, {
        timestamp: new Date().toISOString(),
        event: "error",
        ...base,
        durationMs: Math.round(performance.now() - startedAt),
        error: aiProviderErrorDetails(error),
      });
    } catch (logError) {
      throw new AggregateError(
        [error, logError],
        "AI provider call failed and its error could not be written to the call log",
        { cause: error },
      );
    }
    throw error;
  }
}

export function extractOpenAiRefusal(response: unknown): string | undefined {
  const output = asRecord(response)?.output;
  if (!Array.isArray(output)) return undefined;

  for (const item of output) {
    const content = asRecord(item)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const refusal = asRecord(part)?.refusal;
      if (typeof refusal === "string" && refusal.trim()) return refusal.trim();
    }
  }
  return undefined;
}

export function logAiRefusal(
  provider: AiProviderName,
  model: string,
  reason: string,
  log: (message: string) => void = console.error,
): AiRefusalError {
  const error = new AiRefusalError(provider, model, reason);
  log(error.message);
  return error;
}

function parseDurationMs(value: string): number | undefined {
  const compact = value.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (!compact) return undefined;

  let totalMs = 0;
  let matched = "";
  for (const part of compact.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    const amount = Number(part[1]);
    const unit = part[2];
    if (!Number.isFinite(amount) || amount < 0 || !unit) return undefined;
    matched += part[0];
    totalMs += amount * (
      unit === "h"
        ? 3_600_000
        : unit === "m"
          ? 60_000
          : unit === "s"
            ? 1_000
            : 1
    );
  }
  return matched === compact ? totalMs : undefined;
}

function parseRetryAfterMs(value: string): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now());
}

function rateLimitRetryDelayMs(error: unknown, retryNumber: number): number | undefined {
  const errorRecord = asRecord(error);
  if (!errorRecord || errorRecord.status !== 429) return undefined;

  const body = asRecord(errorRecord.error);
  const code = body?.code ?? errorRecord.code;
  if (code === "insufficient_quota") return undefined;

  const headers = errorRecord.headers instanceof Headers
    ? errorRecord.headers
    : undefined;
  const retryAfterMs = headers?.get("retry-after-ms");
  const retryAfter = headers?.get("retry-after");
  const resetTokens = headers?.get("x-ratelimit-reset-tokens");
  const resetRequests = headers?.get("x-ratelimit-reset-requests");
  const explicitDelayHints = [
    retryAfterMs ? Number(retryAfterMs) : undefined,
    retryAfter ? parseRetryAfterMs(retryAfter) : undefined,
  ].filter((delay): delay is number =>
    delay !== undefined && Number.isFinite(delay) && delay >= 0
  );
  const resetDelayHints = [
    resetTokens ? parseDurationMs(resetTokens) : undefined,
    resetRequests ? parseDurationMs(resetRequests) : undefined,
  ].filter((delay): delay is number =>
    delay !== undefined && Number.isFinite(delay) && delay >= 0
  );

  const messages = [body?.message, errorRecord.message]
    .filter((message): message is string => typeof message === "string");
  for (const message of messages) {
    const match = message.match(
      /try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)/i,
    );
    if (!match) continue;
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    if (Number.isFinite(amount) && amount >= 0 && unit) {
      explicitDelayHints.push(unit.startsWith("m") ? amount : amount * 1_000);
    }
  }

  const hintedDelay = explicitDelayHints.length > 0
    ? Math.max(...explicitDelayHints)
    : resetDelayHints.length > 0
      ? Math.max(...resetDelayHints)
      : 1_000 * (2 ** (retryNumber - 1));
  return Math.min(
    MAX_OPENAI_RATE_LIMIT_DELAY_MS,
    Math.ceil(hintedDelay + OPENAI_RATE_LIMIT_DELAY_BUFFER_MS),
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function withOpenAiRateLimitRetries<T>(
  operation: () => Promise<T>,
  options: OpenAiRateLimitRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_OPENAI_RATE_LIMIT_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("OpenAI rate-limit maxRetries must be a non-negative integer");
  }
  const wait = options.sleep ?? sleep;
  const log = options.log ?? console.error;

  for (let retryCount = 0; ; retryCount += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryNumber = retryCount + 1;
      const delayMs = rateLimitRetryDelayMs(error, retryNumber);
      if (delayMs === undefined || retryCount >= maxRetries) throw error;

      const delaySeconds = (delayMs / 1_000)
        .toFixed(3)
        .replace(/\.?0+$/, "");
      log(
        `OpenAI rate limit reached; retrying in ${delaySeconds}s`
        + ` (${retryNumber}/${maxRetries})...`,
      );
      await wait(delayMs);
    }
  }
}

export function buildOpenAiResponseRequest(
  request: AiResponseRequest,
): ResponseCreateParamsNonStreaming {
  return {
    model: request.model,
    input: request.input,
    ...(request.instructions ? { instructions: request.instructions } : {}),
    ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    ...(request.text ? { text: request.text } : {}),
    ...(request.max_output_tokens === undefined
      ? {}
      : { max_output_tokens: request.max_output_tokens }),
    ...(request.prompt_cache_key === undefined
      ? {}
      : { prompt_cache_key: request.prompt_cache_key }),
  };
}

class OpenAiClient implements AiClient {
  readonly provider = "openai";
  readonly model: string;
  private readonly client: OpenAI;

  constructor(model: string, apiKey: string, private readonly options: {timeoutMs?: number; maxRetries?: number} = {}) {
    this.model = model;
    this.client = new OpenAI({ apiKey, ...(options.timeoutMs ? {timeout: options.timeoutMs} : {}), ...(options.maxRetries !== undefined ? {maxRetries: options.maxRetries} : {}) });
  }

  async createResponse(request: AiResponseRequest): Promise<AiResponse> {
    const openAiRequest = buildOpenAiResponseRequest(request);
    const callId = crypto.randomUUID();
    let attempt = 0;
    const response = await withOpenAiRateLimitRetries(
      async () => {
        attempt += 1;
        return await withAiProviderCallLogging(
          {
            provider: this.provider,
            model: this.model,
            request: openAiRequest,
            callId,
            attempt,
          },
          async () => await this.client.responses.create(openAiRequest),
        );
      },
      this.options.maxRetries !== undefined ? {maxRetries: this.options.maxRetries} : {},
    );
    const refusal = extractOpenAiRefusal(response);
    if (refusal) throw logAiRefusal(this.provider, this.model, refusal);
    return {
      output_text: response.output_text,
      status: response.status,
      incomplete_details: response.incomplete_details,
      ...(response.usage ? {usage: response.usage} : {}),
    };
  }
}

type XaiReasoningEffort = "low" | "medium" | "high" | "xhigh";

export function normalizeXaiReasoningEffort(
  effort: AiReasoningEffort,
): XaiReasoningEffort {
  if (effort === "none" || effort === "minimal") return "low";
  if (effort === "max") return "xhigh";
  return effort;
}

export function buildXaiResponseRequest(
  request: AiResponseRequest,
): ResponseCreateParamsNonStreaming {
  return {
    model: request.model,
    input: request.input,
    ...(request.instructions ? { instructions: request.instructions } : {}),
    ...(request.reasoning
      ? {
          reasoning: {
            effort: normalizeXaiReasoningEffort(request.reasoning.effort),
          },
        }
      : {}),
    ...(request.text ? { text: request.text } : {}),
    ...(request.max_output_tokens === undefined
      ? {}
      : { max_output_tokens: request.max_output_tokens }),
    ...(request.prompt_cache_key === undefined
      ? {}
      : { prompt_cache_key: request.prompt_cache_key }),
    store: false,
  };
}

class XaiClient implements AiClient {
  readonly provider = "xai";
  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    apiKey: string,
    options: {timeoutMs?: number; maxRetries?: number} = {},
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
      ...(options.timeoutMs ? {timeout: options.timeoutMs} : {}),
      maxRetries: 0,
    });
  }

  async createResponse(request: AiResponseRequest): Promise<AiResponse> {
    const xaiRequest = buildXaiResponseRequest(request);
    const response = await withAiProviderCallLogging(
      {
        provider: this.provider,
        model: this.model,
        request: xaiRequest,
      },
      async () => await this.client.responses.create(xaiRequest),
    );
    const outputText = response.output_text.trim();
    if (!outputText) {
      const refusal = extractOpenAiRefusal(response);
      if (refusal) throw logAiRefusal(this.provider, this.model, refusal);
      throw new Error(`xAI returned no text response (status: ${response.status})`);
    }
    return {
      output_text: outputText,
      status: response.status,
      incomplete_details: response.incomplete_details,
      ...(response.usage ? {usage: response.usage} : {}),
    };
  }
}

export function createAiClient(provider = configuredAiProvider(), options: {timeoutMs?: number; maxRetries?: number} = {}): AiClient {
  const model = configuredAiModel(provider);
  const apiKey = requiredApiKey(provider);
  return provider === "xai"
    ? new XaiClient(model, apiKey, options)
    : new OpenAiClient(model, apiKey, options);
}

