import { configureTelemetry } from "./telemetry.js";

await configureTelemetry();
await import("./index.js");
