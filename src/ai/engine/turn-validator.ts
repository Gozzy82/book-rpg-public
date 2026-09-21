import type { AiResponse } from "../provider.js";
import type { TurnContract } from "./turn-contract.js";
import { TurnExecutionError, playerControlsBeat } from "./turn-contract.js";
export type TurnDecisionStatus = "accepted" | "repair_scene" | "repair_choices" | "needs_automatic_continuation" | "review_unavailable" | "rejected";
export interface TurnFinding {
  readonly code: "unselected_player_action" | "missing_required_progress" | "out_of_order_progress" | "missing_setup";
  readonly beatIndexes: readonly number[];
  readonly message: string;
}
export interface TurnDecision {
  readonly status: TurnDecisionStatus;
  readonly actionOutcome?: "interrupted" | "failed";
  readonly observedPartialBeatIndexes: readonly number[];
  readonly observedCompletedBeatIndexes: readonly number[];
  readonly authorizedCompletedBeatIndexes: readonly number[];
  readonly findings: readonly TurnFinding[];
}
/** A pure reduction of immutable model evidence and one immutable authorization contract. */
export function validateTurnEvidence(contract: TurnContract, observed: {
  completedSourceEventBeatIndexes?: unknown;
  partiallyPerformedSourceEventBeatIndexes?: unknown;
  futureActionSetupRequired?: boolean;
  futureActionSetupSupported?: boolean;
  futureActionSetupReason?: string;
  checkpointFindings?: Array<{beatIndexes: number[]; message: string}>;
  player_action_resolution?: {status: string; beforeBeatIndex: number | null; reason: string; quote?: string; causeEstablished: boolean};
}): TurnDecision {
  const indexes = [...new Set(Array.isArray(observed.completedSourceEventBeatIndexes)
      ? observed.completedSourceEventBeatIndexes.filter((i): i is number => Number.isInteger(i) && i >= (contract.startBeatIndex ?? 0) && i < contract.beats.length) : [])].sort((a, b) => a - b);
  const partial = [...new Set(Array.isArray(observed.partiallyPerformedSourceEventBeatIndexes)
    ? observed.partiallyPerformedSourceEventBeatIndexes.filter((i): i is number => Number.isInteger(i) && i >= (contract.startBeatIndex ?? 0) && i < contract.beats.length) : [])].sort((a,b) => a-b);
  const previous = new Set(contract.completedBeatIndexes);
  const authorized = new Set(contract.allowedPlayerBeatIndexes);
  const forbidden = [...new Set([...indexes, ...partial])].filter(i => !previous.has(i) && playerControlsBeat(contract.beats[i]!, contract.playerAliases) && !authorized.has(i));
  const outsidePlayerAction = contract.selectedPlayerAction ? [...new Set([...indexes, ...partial])].filter(i => !previous.has(i)
    && !authorized.has(i) && !contract.requiredAutomaticBeatIndexes.includes(i)) : [];
  const combined = new Set([...previous, ...indexes.filter(i => !forbidden.includes(i) && !outsidePlayerAction.includes(i))]);
  const committed: number[] = [];
  for (let i = contract.startBeatIndex ?? 0; i < contract.beats.length && combined.has(i); i++)
    committed.push(i);
  const gaps = indexes.filter(i => !forbidden.includes(i) && !committed.includes(i));
  const resolution = observed.player_action_resolution;
  const stop = resolution?.beforeBeatIndex;
  const stopped = contract.selectedPlayerAction && resolution && (resolution.status === "interrupted" || resolution.status === "failed")
    && resolution.causeEstablished === true && Boolean(resolution.reason?.trim()) && Boolean(resolution.quote?.trim())
    && typeof stop === "number" && [...contract.allowedPlayerBeatIndexes, ...contract.requiredAutomaticBeatIndexes].includes(stop)
    && !indexes.some(i => i >= stop) && !partial.some(i => i > stop)
    && [...contract.allowedPlayerBeatIndexes, ...contract.requiredAutomaticBeatIndexes].filter(i => i < stop).every(i => committed.includes(i))
    && contract.allowedPlayerBeatIndexes.some(i => !previous.has(i) && (committed.includes(i) || partial.includes(i)));
  const actionOutcome = stopped ? resolution.status as "interrupted" | "failed" : undefined;
  const missingAutomatic = contract.requiredAutomaticBeatIndexes.filter(i => !committed.includes(i) && !(stopped && i >= stop!));
  const missingSelected = contract.allowedPlayerBeatIndexes.filter(i => !committed.includes(i) && !(stopped && i >= stop!));
  const findings: TurnFinding[] = (observed.checkpointFindings ?? []).map(f => ({code: "out_of_order_progress", beatIndexes: [...f.beatIndexes], message: f.message}));
  if (contract.selectedPlayerAction && (!resolution || !["completed", "failed", "interrupted"].includes(resolution.status)))
    findings.push({code: "missing_required_progress", beatIndexes: [], message: "Player action has no established resolution."});
  if (contract.selectedPlayerAction && resolution && ["failed", "interrupted"].includes(resolution.status) && !stopped)
    findings.push({code: "missing_required_progress", beatIndexes: [], message: "Player-action stop is unsupported or crosses its reported stop boundary."});
  if (forbidden.length)
    findings.push({ code: "unselected_player_action", beatIndexes: forbidden, message: `The scene performed unselected player beats: ${forbidden.join(", ")}. Repair the prose; removing cursor evidence is not a repair.` });
  if (outsidePlayerAction.length)
    findings.push({code: "out_of_order_progress", beatIndexes: outsidePlayerAction, message: "The scene crosses the bounded player action endpoint."});
  if (gaps.length)
    findings.push({ code: "out_of_order_progress", beatIndexes: gaps, message: `Observed beats skip unconfirmed prerequisites: ${gaps.join(", ")}.` });
  if (missingSelected.length)
    findings.push({ code: "missing_required_progress", beatIndexes: missingSelected, message: `The selected source action was not visibly completed: ${missingSelected.join(", ")}.` });
  let status: TurnDecisionStatus = findings.length ? "repair_scene" : "accepted";
  if (missingAutomatic.length) {
    const missingActions = missingAutomatic.map(i => `${i} (${contract.beats[i]!.actor ?? "world"}: ${contract.beats[i]!.action})`);
    findings.push({ code: "missing_required_progress", beatIndexes: missingAutomatic, message: `Automatic source beats remain pending: ${missingActions.join("; ")}.` });
    if (status === "accepted") {
      status = contract.mode !== "opening" && committed.some(i => !previous.has(i))
        ? "needs_automatic_continuation" : "repair_scene";
    }
  }
  if (status === "accepted" && !stopped && contract.sourceProgression === "required" && (observed.futureActionSetupRequired || contract.nextPlayerDecision !== null) && observed.futureActionSetupSupported === false) {
    status = "repair_scene";
    findings.push({ code: "missing_setup", beatIndexes: [], message: `The next player decision is missing its visible prerequisites. ${observed.futureActionSetupReason?.trim() ?? ""}`.trim() });
  }
  findings.forEach(f => { Object.freeze(f.beatIndexes); Object.freeze(f); });
  return Object.freeze({ status, actionOutcome, observedPartialBeatIndexes: Object.freeze(partial), observedCompletedBeatIndexes: Object.freeze(indexes), authorizedCompletedBeatIndexes: Object.freeze(committed), findings: Object.freeze(findings) });
}
export function reducePresenceReview(contract: TurnContract, response: AiResponse): AiResponse {
  if (response.status === "incomplete" || !response.output_text.trim())
    return response;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(response.output_text);
  }
  catch {
    return response;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || !Array.isArray(raw.completedSourceEventBeatIndexes)
    || !raw.completedSourceEventBeatIndexes.every(i => Number.isInteger(i) && Number(i) >= 0)
    || typeof raw.futureActionSetupRequired !== "boolean"
    || typeof raw.futureActionSetupSupported !== "boolean") {
    throw new TurnExecutionError("review_unavailable", "Presence review did not return valid progress evidence.");
  }
  const decision = validateTurnEvidence(contract, raw as Parameters<typeof validateTurnEvidence>[1]);
  const complete = contract.beats.length > 0 && decision.authorizedCompletedBeatIndexes.length + (contract.startBeatIndex ?? 0) === contract.beats.length;
  return { ...response, output_text: JSON.stringify({ ...raw,
      turnValidation: decision,
      completedSourceEventBeatIndexes: decision.authorizedCompletedBeatIndexes,
      latestVisibleSourceEventId: contract.beats.length === 0 ? raw.latestVisibleSourceEventId : complete ? contract.eventId : null,
      ...(contract.sourceProgression === "optional" ? {futureActionSetupRequired: false, futureActionSetupSupported: true,
        futureActionSetupReason: "The source route is optional for this input; a later anchor need not be forced executable."} : {}),
      ...(decision.actionOutcome && decision.status === "accepted" ? {futureActionSetupRequired: false, futureActionSetupSupported: true,
        futureActionSetupReason: "The selected action stopped on established evidence; build a fresh local decision from that state."} : {}),
      // Compatibility projections are never used to erase a finding.
      ...(decision.status === "repair_scene" ? { futureActionSetupRequired: true, futureActionSetupSupported: false, futureActionSetupReason: decision.findings.map(f => f.message).join(" ") } : {}),
      ...(decision.status === "needs_automatic_continuation" ? { futureActionSetupRequired: false, futureActionSetupSupported: false, futureActionSetupReason: "Automatic continuation is pending; no new player menu is authorized yet." } : {}),
    }) };
}
export function worldRuleVerdict(response: AiResponse): "satisfied" | "violated" | "review_unavailable" {
  if (response.status === "incomplete")
    return "review_unavailable";
  try {
    const value = JSON.parse(response.output_text);
    if (!value || typeof value.satisfied !== "boolean" || !Array.isArray(value.failedRules) || !value.failedRules.every((rule: unknown) => typeof rule === "string") || typeof value.reason !== "string")
      return "review_unavailable";
    return value.satisfied && value.failedRules.length === 0 ? "satisfied" : "violated";
  }
  catch {
    return "review_unavailable";
  }
}

