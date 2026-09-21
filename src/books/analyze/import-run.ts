import type { CreateAnalysisResponse } from "./batching.js";

export class ImportRunStopped extends Error {}
export interface ImportRunOptions {
  maxCalls?: number;
  maxTokens?: number;
  log?: (message: string) => void;
  record?: (event: unknown) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
}

/** Shared by all import stages; transient retries also consume the run budget. */
export function createImportRun(provider: CreateAnalysisResponse, options: ImportRunOptions = {}) {
  const maxCalls = options.maxCalls ?? 500;
  const maxTokens = options.maxTokens ?? 5_000_000;
  if (![maxCalls, maxTokens].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("Import budgets must be positive integers");
  const stats = {calls: 0, tokens: 0};
  const log = options.log ?? console.error;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const measured: CreateAnalysisResponse = async request => {
    for (let retry = 0; ; retry++) {
      if (stats.calls >= maxCalls || stats.tokens >= maxTokens) throw new ImportRunStopped(
        `Import budget reached (${stats.calls}/${maxCalls} calls, ${stats.tokens}/${maxTokens} observed tokens). Saved checkpoints can resume without --reanalyze.`);
      stats.calls++;
      const started = Date.now();
      let response;
      try {
        response = await provider(request);
      } catch (error) {
        const e = error as {status?: number; code?: string; error?: {code?: string}};
        const message = error instanceof Error ? error.message : String(error);
        await options.record?.({call: stats.calls, stage: request.text?.format.name, elapsedMs: Date.now() - started, error: message});
        if (e?.status === 401 || e?.status === 403 || e?.code === "insufficient_quota" || e?.error?.code === "insufficient_quota") {
          throw new ImportRunStopped("Import provider unavailable: " + message);
        }
        const temporary = e?.status === 429 || [408, 500, 502, 503, 504].includes(e?.status ?? 0)
          || ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(e?.code ?? "");
        if (!temporary || retry >= 2) throw error;
        log(`Temporary import API failure; retry ${retry + 1}/2, same request: ${message}`);
        await wait(1000 * 2 ** retry);
        continue;
      }
      stats.tokens += response.usage?.total_tokens ?? 0;
      await options.record?.({call: stats.calls, stage: request.text?.format.name, elapsedMs: Date.now() - started,
        usage: response.usage, totals: {...stats}});
      return response;
    }
  };
  return {provider: measured, stats, limits: {maxCalls, maxTokens}};
}
