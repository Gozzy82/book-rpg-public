import { flowDiagnostic } from "../../util/flow-trace.js";
import type {
  AiResponse,
  AiResponseRequest,
} from "../provider.js";
import { ProviderGameEngine } from "./provider-game-engine.js";

function renameWorldRuleTerminology(text: string): string {
  return text
    .replaceAll("runtime_parameters", "bookrpg_world_rules")
    .replaceAll("runtime parameters", "BookRPG world rules")
    .replaceAll("runtime parameter", "BookRPG world rule")
    .replaceAll("When parameters conflict", "When BookRPG world rules conflict")
    .replaceAll("according to these parameters", "according to these BookRPG world rules")
    .replaceAll("these parameters", "these BookRPG world rules")
    .replaceAll("When a parameter explicitly describes", "When a BookRPG world rule explicitly describes")
    .replaceAll("A parameter changes the game world's governing facts", "A BookRPG world rule changes the game world's governing facts")
    .replaceAll("ignoring a runtime parameter", "ignoring a BookRPG world rule");
}

export function withBookRpgWorldRuleTerminology(
  request: AiResponseRequest,
): AiResponseRequest {
  return {
    ...request,
    ...(request.instructions
      ? { instructions: renameWorldRuleTerminology(request.instructions) }
      : {}),
    input: renameWorldRuleTerminology(request.input),
  };
}

const CURRENT_BEAT_ONLY_GENERATION_LABELS = new Set([
  "scene",
  "scene choices",
  "dialogue response",
  "dialogue suggestions",
]);

function jsonObjectEnd(text: string, objectStart: number): number | null {
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let index = objectStart; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return null;
}

function withoutEventBeats(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { beats: _beats, ...event } = value as Record<string, unknown>;
  return event;
}

function currentBeatOnlyGameContext(context: Record<string, unknown>): Record<string, unknown> {
  const restricted = { ...context };
  delete restricted.upcoming_source_material;
  delete restricted.story_so_far;
  delete restricted.next_significant_event;
  delete restricted.next_player_future_actions;
  delete restricted.opening_player_future_actions;
  delete restricted.opening_event_sequence;

  if (restricted.current_significant_event) {
    restricted.current_significant_event = withoutEventBeats(
      restricted.current_significant_event,
    );
  }
  if (restricted.opening_reference_event) {
    restricted.opening_reference_event = withoutEventBeats(
      restricted.opening_reference_event,
    );
  }

  const progress = restricted.next_significant_event_progress;
  if (progress && typeof progress === "object" && !Array.isArray(progress)) {
    const progressRecord = { ...(progress as Record<string, unknown>) };
    if (Array.isArray(progressRecord.remaining_beats)) {
      progressRecord.remaining_beats = progressRecord.remaining_beats.map(
        (_beat, index) => ({ order: index, pending: true }),
      );
    }
    restricted.next_significant_event_progress = progressRecord;
  }

  return restricted;
}

function restrictGameContextToCurrentBeat(input: string): string {
  const marker = "GAME CONTEXT:\n";
  const markerIndex = input.lastIndexOf(marker);
  if (markerIndex < 0) return input;
  const objectStart = input.indexOf("{", markerIndex + marker.length);
  if (objectStart < 0) return input;
  const objectEnd = jsonObjectEnd(input, objectStart);
  if (objectEnd === null) return input;

  try {
    const parsed = JSON.parse(input.slice(objectStart, objectEnd));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return input;
    const restricted = currentBeatOnlyGameContext(parsed as Record<string, unknown>);
    return input.slice(0, objectStart)
      + JSON.stringify(restricted, null, 2)
      + input.slice(objectEnd);
  } catch {
    return input;
  }
}

function removeFutureSourceInstructions(instructions: string): string {
  const hiddenFields = [
    "upcoming_source_material",
    "next_player_future_actions",
    "opening_player_future_actions",
    "opening_event_sequence",
    "next_significant_event is",
    "depict next_significant_event",
  ];
  return instructions
    .split("\n")
    .filter((line) => !hiddenFields.some((field) => line.includes(field)))
    .join("\n");
}

export function withCurrentBeatOnlyGenerationContext(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (!CURRENT_BEAT_ONLY_GENERATION_LABELS.has(label)) return request;
  return {
    ...request,
    ...(request.instructions
      ? { instructions: removeFutureSourceInstructions(request.instructions) }
      : {}),
    input: restrictGameContextToCurrentBeat(request.input),
  };
}

function jsonArrayAfterKey(text: string, key: string): string[] {
  const keyIndex = text.indexOf(`"${key}"`);
  if (keyIndex < 0) return [];

  const arrayStart = text.indexOf("[", keyIndex);
  if (arrayStart < 0) return [];

  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let index = arrayStart; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") depth += 1;
    if (char !== "]") continue;

    depth -= 1;
    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(text.slice(arrayStart, index + 1));
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function bookRpgWorldRulesFromRequest(request: AiResponseRequest): string[] {
  return jsonArrayAfterKey(request.input, "bookrpg_world_rules");
}

interface WorldRuleComplianceReview {
  satisfied: boolean;
  failedRules: string[];
  reason: string;
}

const worldRuleComplianceReviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    satisfied: { type: "boolean" },
    failedRules: {
      type: "array",
      items: { type: "string" },
    },
    reason: { type: "string" },
  },
  required: ["satisfied", "failedRules", "reason"],
} as const;

function isWorldRuleEnforcedGeneration(label: string): boolean {
  return label === "scene" || label === "dialogue response";
}

function worldRuleRepairInstruction(review: WorldRuleComplianceReview): string {
  const failures = review.failedRules.length > 0
    ? review.failedRules.map((rule) => `- ${rule}`).join("\n")
    : `- ${review.reason}`;
  return [
    "REGENERATION REQUIRED: the previous draft violated applicable BookRPG world rules.",
    "Repair every failure below while preserving the selected player action, player agency, source ordering, scene scope, and all other generation constraints.",
    "A governing world fact must not be contradicted. A rule that explicitly requires continuous, constant, always-on, frequent, repeated, recurring, or per-scene observable behavior must have at least one brief concrete observable manifestation whenever its affected subject is present and the behavior is physically possible.",
    "Do not merely quote, explain, or mention the rule as metadata; show its consequence naturally in the generated scene or dialogue.",
    failures,
  ].join("\n");
}

/**
 * Final provider used by BookRPG gameplay. The older prompt builders still contain
 * a few legacy transport labels, but they are normalized here before any request
 * reaches the AI provider. The model therefore only sees `bookrpg_world_rules`.
 *
 * Generated scenes and dialogue are additionally reviewed when world rules are
 * active. A failed compliance review regenerates the draft before it reaches the
 * normal scene/presence/repetition reviewers, turning persistent rules into an
 * enforced gameplay contract instead of prompt-only flavor.
 */
export class BookRpgProviderGameEngine extends ProviderGameEngine {
  private async reviewWorldRuleCompliance(
    bookId: string,
    worldRules: readonly string[],
    candidateOutput: string,
    dialogueTurn: boolean,
  ): Promise<WorldRuleComplianceReview> {
    const response = await super.createResponse("world rule compliance review", bookId, {
      model: this.model,
      reasoning: { effort: "low" },
      instructions: [
        "You are a strict BookRPG world-rule compliance reviewer.",
        "Assess only the supplied active BookRPG world rules against the candidate output.",
        "A world rule is authoritative. Fail the candidate when it directly contradicts a rule.",
        "For a rule that explicitly describes continuous, constant, always-on, frequent, repeated, recurring, or per-scene observable behavior, require at least one concrete observable manifestation in this candidate whenever the affected subject is present and the behavior is physically possible.",
        "Do not require an ordinary persistent fact to be restated in every scene when the candidate neither contradicts it nor makes it currently observable.",
        "For dialogue output, inspect both characterResponse and narration. For scene output, inspect all player-facing prose in the JSON output.",
        "Do not treat the rule text appearing only in hidden metadata, context, or an explanation as satisfying an observable behavior rule.",
        "Return failedRules using the exact rule strings supplied in activeWorldRules.",
      ].join("\n"),
      input: JSON.stringify({
        activeWorldRules: worldRules,
        candidateType: dialogueTurn ? "dialogue" : "scene",
        candidateOutput,
      }),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_world_rule_compliance_review",
          strict: true,
          schema: worldRuleComplianceReviewSchema,
        },
      },
      max_output_tokens: 500,
    });

    try {
      const parsed = JSON.parse(response.output_text) as Partial<WorldRuleComplianceReview>;
      return {
        satisfied: parsed.satisfied === true,
        failedRules: Array.isArray(parsed.failedRules)
          ? parsed.failedRules.filter((value): value is string => typeof value === "string")
          : [],
        reason: typeof parsed.reason === "string" ? parsed.reason : "World-rule compliance failed.",
      };
    } catch {
      // Do not reject an otherwise valid gameplay response merely because the
      // independent reviewer itself returned malformed JSON.
      flowDiagnostic("BookRPG world-rule compliance review returned invalid JSON; accepting draft.");
      return { satisfied: true, failedRules: [], reason: "Reviewer JSON was invalid." };
    }
  }

  protected override async createResponse(
    label: string,
    bookId: string,
    request: AiResponseRequest,
  ): Promise<AiResponse> {
    let normalizedRequest = withBookRpgWorldRuleTerminology(request);
    normalizedRequest = withCurrentBeatOnlyGenerationContext(label, normalizedRequest);
    let response = await super.createResponse(label, bookId, normalizedRequest);

    if (!isWorldRuleEnforcedGeneration(label)) return response;

    const worldRules = bookRpgWorldRulesFromRequest(normalizedRequest);
    if (worldRules.length === 0) return response;

    const maxComplianceRepairs = 2;
    for (let repair = 0; repair <= maxComplianceRepairs; repair += 1) {
      const review = await this.reviewWorldRuleCompliance(
        bookId,
        worldRules,
        response.output_text,
        label === "dialogue response",
      );
      if (review.satisfied) return response;

      flowDiagnostic(
        `BookRPG world-rule compliance rejected ${label} draft ${repair + 1}/${maxComplianceRepairs + 1}: `
        + `${review.failedRules.join(" | ") || review.reason}`,
      );
      if (repair === maxComplianceRepairs) return response;

      normalizedRequest = {
        ...normalizedRequest,
        instructions: [
          normalizedRequest.instructions ?? "",
          worldRuleRepairInstruction(review),
        ].filter(Boolean).join("\n\n"),
      };
      response = await super.createResponse(label, bookId, normalizedRequest);
    }

    return response;
  }
}