import { loadDotEnv } from "../util/env.js";

export async function configureTelemetry(): Promise<void> {
  loadDotEnv();
  if (!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim()) return;

  const { useAzureMonitor } = await import("@azure/monitor-opentelemetry");
  const configuredSamplingRatio = Number(
    process.env.BOOKRPG_TELEMETRY_SAMPLING_RATIO || "0.25",
  );
  if (
    !Number.isFinite(configuredSamplingRatio)
    || configuredSamplingRatio <= 0
    || configuredSamplingRatio > 1
  ) {
    throw new Error("BOOKRPG_TELEMETRY_SAMPLING_RATIO must be greater than 0 and at most 1");
  }
  useAzureMonitor({ samplingRatio: configuredSamplingRatio });
}
