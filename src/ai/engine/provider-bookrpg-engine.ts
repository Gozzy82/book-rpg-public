import { currentTurnExecution, TurnExecutionError } from "./turn-contract.js";
import { worldRuleVerdict } from "./turn-validator.js";
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

function withoutSourceReferencesExcerpt(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    sourceReferencesExcerpt: _sourceReferencesExcerpt,
    ...beat
  } = value as Record<string, unknown>;
  return beat;
}

function openingPlayerBoundaryIndex(context: Record<string, unknown>): number | null {
  const actions = Array.isArray(context.opening_player_future_actions)
    ? context.opening_player_future_actions
    : [];
  const indexes = actions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const beatIndex = (value as Record<string, unknown>).beat_index;
    return Number.isInteger(beatIndex) ? [beatIndex as number] : [];
  });
  return indexes.length > 0 ? Math.min(...indexes) : null;
}

function currentBeatOnlyGameContext(
  context: Record<string, unknown>,
  stripCurrentBeatSourceExcerpt: boolean,
  plannedWindow = false,
): Record<string, unknown> {
  const restricted = { ...context };
  const openingContext = restricted.source_guidance_mode === "optional_opening_reference";
  const openingBoundaryIndex = openingContext
    ? openingPlayerBoundaryIndex(restricted)
    : null;

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

  if (plannedWindow) {
    // The immutable script supplies the complete authorized window. Keeping a
    // second, first-beat-only projection here gives the writer a competing plan.
    delete restricted.next_significant_event_progress;
    delete restricted.opening_reference_event;
    return restricted;
  }

  const progress = restricted.next_significant_event_progress;
  if (progress && typeof progress === "object" && !Array.isArray(progress)) {
    const progressRecord = { ...(progress as Record<string, unknown>) };
    if (stripCurrentBeatSourceExcerpt && progressRecord.next_required_beat) {
      progressRecord.next_required_beat = withoutSourceReferencesExcerpt(
        progressRecord.next_required_beat,
      );
    }
    if (Array.isArray(progressRecord.remaining_beats)) {
      const completedCount = Array.isArray(progressRecord.completed_beat_indexes)
        ? progressRecord.completed_beat_indexes.filter(Number.isInteger).length
        : 0;
      progressRecord.remaining_beats = progressRecord.remaining_beats.map(
        (beat, index) => {
          const absoluteIndex = completedCount + index;
          const beatRecord = beat && typeof beat === "object" && !Array.isArray(beat)
            ? beat as Record<string, unknown>
            : null;
          const sourceReferencesExcerpt = beatRecord?.sourceReferencesExcerpt;
          const isPreludeBeat = openingContext
            && openingBoundaryIndex !== null
            && absoluteIndex < openingBoundaryIndex;
          return {
            order: absoluteIndex,
            pending: true,
            ...(isPreludeBeat
              && typeof sourceReferencesExcerpt === "string"
              && sourceReferencesExcerpt.trim()
              ? { sourceReferencesExcerpt }
              : {}),
          };
        },
      );
    }
    restricted.next_significant_event_progress = progressRecord;
  }

  return restricted;
}

function restrictGameContextToCurrentBeat(
  input: string,
  stripCurrentBeatSourceExcerpt: boolean,
  plannedWindow = false,
): string {
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
    const restricted = currentBeatOnlyGameContext(
      parsed as Record<string, unknown>,
      stripCurrentBeatSourceExcerpt,
      plannedWindow,
    );
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
  plannedWindow = false,
): AiResponseRequest {
  if (!CURRENT_BEAT_ONLY_GENERATION_LABELS.has(label)) return request;
  return {
    ...request,
    ...(request.instructions
      ? { instructions: removeFutureSourceInstructions(request.instructions) }
      : {}),
    input: restrictGameContextToCurrentBeat(
      request.input,
      label === "scene",
      plannedWindow,
    ),
  };
}

export function withImmediateBeatOnlyChoiceContext(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene choices") return request;
  try {
    const parsed = JSON.parse(request.input) as Record<string, unknown>;
    delete parsed.upcoming_source_excerpt;
    const requiredBeats = Array.isArray(parsed.required_player_choice_beats)
      ? parsed.required_player_choice_beats
      : [];
    const immediatePlayerBeatSourceExcerpts = requiredBeats.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const excerpt = (value as Record<string, unknown>).sourceReferencesExcerpt;
      return typeof excerpt === "string" && excerpt.trim() ? [excerpt] : [];
    });
    if (immediatePlayerBeatSourceExcerpts.length > 0) {
      parsed.immediate_player_beat_source_excerpts = immediatePlayerBeatSourceExcerpts;
    }
    return {
      ...request,
      instructions: [
        request.instructions ?? "",
        "CHOICE SOURCE BOUNDARY: do not use a broad future source excerpt to invent menu options. required_player_choice_beats and immediate_player_beat_source_excerpts are the only source text that may shape the current player decision; later source material must remain unknown to choices[1+].",
      ].filter(Boolean).join("\n"),
      input: JSON.stringify(parsed, null, 2),
    };
  } catch {
    return request;
  }
}

function normalizeActionToken(token: string): string {
  const normalized = token.toLocaleLowerCase();
  if (["me", "him", "them"].includes(normalized)) return "<object>";
  if (["my", "his", "her", "their"].includes(normalized)) return "<possessive>";
  if (["myself", "himself", "herself", "themself", "themselves"].includes(normalized)) {
    return "<reflexive>";
  }
  if (normalized === "does") return "do";
  if (normalized === "goes") return "go";
  if (normalized === "has") return "have";
  if (normalized === "is") return "be";
  if (normalized.endsWith("ies") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (/(?:ches|shes|sses|xes|zes)$/u.test(normalized)) {
    return normalized.slice(0, -2);
  }
  if (
    normalized.endsWith("s")
    && !normalized.endsWith("ss")
    && normalized.length > 3
  ) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function normalizedActionText(value: unknown): string {
  if (typeof value !== "string") return "";
  return (value.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(normalizeActionToken)
    .join(" ");
}

function normalizedIdentity(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase()
    : "";
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function playerActionAuthorizesNextRequiredBeat(input: Record<string, unknown>): number | null {
  const candidateScene = input.candidate_scene;
  const nextRequiredBeat = input.next_required_source_event_beat;
  const playerIdentity = normalizedIdentity(input.player_identity);
  if (
    !candidateScene
    || typeof candidateScene !== "object"
    || Array.isArray(candidateScene)
    || !nextRequiredBeat
    || typeof nextRequiredBeat !== "object"
    || Array.isArray(nextRequiredBeat)
  ) {
    return null;
  }
  const candidateRecord = candidateScene as Record<string, unknown>;
  const beatRecord = nextRequiredBeat as Record<string, unknown>;
  const playerAction = normalizedActionText(candidateRecord.player_action);
  const beatAction = normalizedActionText(beatRecord.action);
  const beatActor = normalizedIdentity(beatRecord.actor);
  const beatIndex = beatRecord.index;
  return playerAction
    && beatAction
    && playerAction === beatAction
    && beatActor === playerIdentity
    && Number.isInteger(beatIndex)
      ? beatIndex as number
      : null;
}

function futureActionNamedParticipants(
  input: Record<string, unknown>,
  futureAction: Record<string, unknown>,
): string[] {
  const explicitTargets = stringValues(futureAction.targets);
  if (explicitTargets.length > 0) return explicitTargets;
  const action = normalizedActionText(futureAction.action);
  if (!action) return [];
  const playerIdentity = normalizedIdentity(input.player_identity);
  const profiles = Array.isArray(input.character_profiles) ? input.character_profiles : [];
  return profiles.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const name = (value as Record<string, unknown>).name;
    if (typeof name !== "string" || normalizedIdentity(name) === playerIdentity) return [];
    const normalizedName = normalizedActionText(name);
    return normalizedName && action.includes(normalizedName) ? [name] : [];
  });
}

function correctFutureActionSetupSelfRequirement(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  futureAction: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (
    !futureAction
    || output.futureActionSetupRequired !== true
    || output.futureActionSetupSupported !== false
  ) {
    return output;
  }
  const action = typeof futureAction.action === "string" ? futureAction.action : "";
  const visualGesture = /\b(?:wink|nod|wave|gesture|signal|smile|point)(?:s|ed|ing)?\b/iu.test(action);
  const speechAction = /\b(?:ask|tell|say|speak|shout|call|answer|reply|request|command|explain|warn)(?:s|ed|ing)?\b/iu.test(action);
  if (!visualGesture && !speechAction) return output;

  const candidateScene = input.candidate_scene;
  if (!candidateScene || typeof candidateScene !== "object" || Array.isArray(candidateScene)) {
    return output;
  }
  const proposedScope = (candidateScene as Record<string, unknown>).proposed_scene_scope;
  if (!proposedScope || typeof proposedScope !== "object" || Array.isArray(proposedScope)) {
    return output;
  }
  const scope = proposedScope as Record<string, unknown>;
  const requiredParticipants = futureActionNamedParticipants(input, futureAction)
    .map(normalizedIdentity)
    .filter(Boolean);
  if (requiredParticipants.length === 0) return output;

  const reachable = new Set(
    (visualGesture
      ? stringValues(scope.peoplePresent)
      : stringValues(scope.peopleWithinSpeakingDistance)
    ).map(normalizedIdentity),
  );
  if (!requiredParticipants.every((identity) => reachable.has(identity))) return output;

  const reason = typeof output.futureActionSetupReason === "string"
    ? output.futureActionSetupReason
    : "";
  const reasonSuggestsActionLeak = visualGesture
    ? /\b(?:wink|nod|wave|gesture|gaze|signal|smile|point)\b/iu.test(reason)
    : /\b(?:speech|utterance|ask|question|request|tell|say|reply|answer)\b/iu.test(reason)
      && /\b(?:not (?:shown|demonstrated|performed|spoken)|must (?:show|demonstrate|perform|speak))\b/iu.test(reason);
  if (!reasonSuggestsActionLeak) return output;

  flowDiagnostic(
    "BookRPG presence review future-action setup corrected: reviewer required the future action itself after all required participants were already reachable.",
  );
  return {
    ...output,
    futureActionSetupSupported: true,
    futureActionSetupReason:
      "The required participant(s) are already reachable at the decision point; the future player action itself must remain unperformed.",
  };
}

export function guardScenePresenceReviewPlayerBoundary(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (
    response.status === "incomplete"
    || request.text?.format.name !== "bookrpg_scene_presence_review"
    || !response.output_text.trim()
  ) {
    return response;
  }
  try {
    const input = JSON.parse(request.input) as Record<string, unknown>;
    const parsedOutput = JSON.parse(response.output_text) as Record<string, unknown>;
    const futureActions = Array.isArray(input.future_player_actions)
      ? input.future_player_actions
      : [];
    const authorizedBeatIndex = playerActionAuthorizesNextRequiredBeat(input);
    if (futureActions.length === 0 && authorizedBeatIndex === null) return response;

    const protectedBeatIndex = futureActions
      .flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const beatIndex = (value as Record<string, unknown>).beatIndex;
        return Number.isInteger(beatIndex)
          && (authorizedBeatIndex === null || (beatIndex as number) > authorizedBeatIndex)
            ? [beatIndex as number]
            : [];
      })
      .sort((left, right) => left - right)[0];

    const protectedFutureAction = protectedBeatIndex === undefined
      ? undefined
      : futureActions.find((value) =>
          value
          && typeof value === "object"
          && !Array.isArray(value)
          && (value as Record<string, unknown>).beatIndex === protectedBeatIndex
        ) as Record<string, unknown> | undefined;
    const output = correctFutureActionSetupSelfRequirement(
      input,
      parsedOutput,
      protectedFutureAction,
    );
    const reportedIndexes = new Set(
      Array.isArray(output.completedSourceEventBeatIndexes)
        ? output.completedSourceEventBeatIndexes.filter(
            (value): value is number => Number.isInteger(value),
          )
        : [],
    );
    const authorizedBeatAdded = authorizedBeatIndex !== null
      && !reportedIndexes.has(authorizedBeatIndex);
    if (authorizedBeatIndex !== null) reportedIndexes.add(authorizedBeatIndex);
    const reportedIndexList = [...reportedIndexes].sort((left, right) => left - right);
    const guardedIndexes = protectedBeatIndex === undefined
      ? reportedIndexList
      : reportedIndexList.filter((index) => index < protectedBeatIndex);
    const eventReviewTarget = input.event_review_target;
    const targetEventId = eventReviewTarget
      && typeof eventReviewTarget === "object"
      && !Array.isArray(eventReviewTarget)
      && typeof (eventReviewTarget as Record<string, unknown>).eventId === "string"
        ? (eventReviewTarget as Record<string, unknown>).eventId as string
        : null;
    const claimedTargetComplete = Boolean(
      targetEventId
      && output.latestVisibleSourceEventId === targetEventId,
    );
    const outputChanged = output !== parsedOutput;
    const progressChanged = guardedIndexes.length !== reportedIndexList.length
      || guardedIndexes.some((index, position) => index !== reportedIndexList[position]);
    if (
      !progressChanged
      && !claimedTargetComplete
      && !outputChanged
      && !authorizedBeatAdded
    ) {
      return response;
    }

    flowDiagnostic(
      "BookRPG presence review player-boundary guard: "
      + JSON.stringify({
        protected_beat_index: protectedBeatIndex ?? null,
        authorized_beat_index: authorizedBeatIndex,
        reported_completed_beat_indexes: reportedIndexList,
        accepted_completed_beat_indexes: guardedIndexes,
        cleared_completed_event_id: claimedTargetComplete ? targetEventId : null,
        corrected_future_action_setup: outputChanged,
        added_selected_player_beat: authorizedBeatAdded,
      }),
    );
    return {
      ...response,
      output_text: JSON.stringify({
        ...output,
        completedSourceEventBeatIndexes: guardedIndexes,
        ...(claimedTargetComplete ? { latestVisibleSourceEventId: null } : {}),
      }),
    };
  } catch {
    return response;
  }
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

const OPENING_SPLIT_PRELUDE_WORD_LIMIT = 360;
const OPENING_SPLIT_BOUNDARY_WORD_LIMIT = 120;
const OPENING_SPLIT_PRELUDE_OUTPUT_TOKENS = 2_400;
const OPENING_SPLIT_BOUNDARY_OUTPUT_TOKENS = 1_200;

function shouldSplitOpeningScene(label: string, request: AiResponseRequest): boolean {
  return label === "scene"
    && request.input.includes("OPENING PRELUDE:")
    && request.input.includes('"kind":"first_unselected_player_beat"');
}

export function openingSplitSceneTextWordCount(response: AiResponse): number | null {
  if (response.status === "incomplete" || !response.output_text.trim()) return null;
  try {
    const output = JSON.parse(response.output_text) as Record<string, unknown>;
    if (typeof output.text !== "string") return null;
    const text = output.text.trim();
    return text ? text.split(/\s+/u).length : 0;
  } catch {
    return null;
  }
}

export function clampOpeningSplitSceneText(
  response: AiResponse,
  wordLimit: number,
): AiResponse {
  const wordCount = openingSplitSceneTextWordCount(response);
  if (wordCount === null || wordCount <= wordLimit) return response;
  try {
    const output = JSON.parse(response.output_text) as Record<string, unknown>;
    const text = typeof output.text === "string" ? output.text.trim() : "";
    const words = text.split(/\s+/u);
    return {
      ...response,
      output_text: JSON.stringify({
        ...output,
        text: words.slice(0, wordLimit).join(" "),
      }),
    };
  } catch {
    return response;
  }
}

function openingPreludeRequest(request: AiResponseRequest): AiResponseRequest {
  return {
    ...request,
    instructions: [
      request.instructions ?? "",
      "OPENING SPLIT PHASE 1: generate only the automatic prelude that occurs before the first unselected meaningful player beat.",
      "Advance every PRELUDE BEAT listed in the input, in order, and stop immediately after the final prelude beat.",
      "When a required prelude beat occurs before player_identity can physically perceive it, do not relocate the player or invent player knowledge. Render that beat as one brief objective cutaway sentence or clause containing only the source-backed action, then return to first-person player perspective as soon as the chronology reaches the player's perceivable location.",
      "For prelude beats the player can perceive, narrate them from player_identity's first-person perspective. Never make an objective cutaway imply that the player witnessed, knew, remembered, or caused an off-screen beat.",
      "Do not begin, imply, decide, gesture toward, or perform the structured first_unselected_player_beat. Do not add a decision-point sentence that starts the player's action.",
      `TARGET LENGTH: keep the player-facing text for this phase at or below ${OPENING_SPLIT_PRELUDE_WORD_LIMIT} words when possible. Required PRELUDE BEATS take priority over this phase target; never omit or cut off a required pre-player beat merely to hit the target. The combined opening is validated separately against its hard overall budget.`,
      "This phase is prose setup only. Return playerAction exactly '', actionResult exactly '', actionOutcome exactly 'none', and no embedded choices.",
      "The returned sceneScope must describe the physical state immediately after the final prelude beat.",
    ].filter(Boolean).join("\n"),
    max_output_tokens: OPENING_SPLIT_PRELUDE_OUTPUT_TOKENS,
  };
}

export function withoutOpeningPreludeInstructions(input: string): string {
  const preludeStart = input.indexOf("OPENING PRELUDE:");
  if (preludeStart < 0) return input;
  const boundaryStart = input.indexOf(
    "The opening has a structured player-decision boundary.",
    preludeStart,
  );
  if (boundaryStart < 0) return input;
  return input.slice(0, preludeStart) + input.slice(boundaryStart);
}

function openingBoundaryRequest(
  request: AiResponseRequest,
  preludeOutput: Record<string, unknown>,
): AiResponseRequest {
  const preludeText = typeof preludeOutput.text === "string" ? preludeOutput.text : "";
  const preludeScope = preludeOutput.sceneScope ?? null;
  return {
    ...request,
    instructions: [
      request.instructions ?? "",
      "OPENING SPLIT PHASE 2: the automatic prelude has already been written and will be prepended to your text by the application.",
      "Do not repeat, summarize, paraphrase, or re-enact any PRELUDE BEAT. Treat OPENING PRELUDE ALREADY WRITTEN as authoritative established state.",
      `Write only the shortest natural continuation needed to expose the immediate decision boundary, with at most ${OPENING_SPLIT_BOUNDARY_WORD_LIMIT} player-facing words. Usually one to three sentences are enough.`,
      "The first_unselected_player_beat must remain wholly unperformed. Do not move, speak, decide, reach, crouch, turn, or otherwise begin that player action for the player.",
      "Return playerAction exactly '', actionResult exactly '', actionOutcome exactly 'none'. sceneScope and storyMemory must reflect the end of the combined opening, including the established prelude.",
    ].filter(Boolean).join("\n"),
    input: withoutOpeningPreludeInstructions(request.input)
      + `\n\nOPENING PRELUDE ALREADY WRITTEN (AUTHORITATIVE; DO NOT REPEAT):\n${JSON.stringify({ text: preludeText, sceneScope: preludeScope }, null, 2)}`,
    max_output_tokens: OPENING_SPLIT_BOUNDARY_OUTPUT_TOKENS,
  };
}

function mergeOpeningSplitResponses(
  preludeResponse: AiResponse,
  boundaryResponse: AiResponse,
): AiResponse {
  if (preludeResponse.status === "incomplete") return preludeResponse;
  if (boundaryResponse.status === "incomplete") return boundaryResponse;
  try {
    const prelude = JSON.parse(preludeResponse.output_text) as Record<string, unknown>;
    const boundary = JSON.parse(boundaryResponse.output_text) as Record<string, unknown>;
    const preludeText = typeof prelude.text === "string" ? prelude.text.trim() : "";
    const boundaryText = typeof boundary.text === "string" ? boundary.text.trim() : "";
    const preludeDevelopment = typeof prelude.externalDevelopment === "string"
      ? prelude.externalDevelopment.trim()
      : "";
    const boundaryDevelopment = typeof boundary.externalDevelopment === "string"
      ? boundary.externalDevelopment.trim()
      : "";
    return {
      ...boundaryResponse,
      output_text: JSON.stringify({
        ...boundary,
        title: typeof boundary.title === "string" && boundary.title.trim()
          ? boundary.title
          : prelude.title,
        text: [preludeText, boundaryText].filter(Boolean).join("\n\n"),
        playerAction: "",
        actionOutcome: "none",
        actionResult: "",
        externalDevelopment: boundaryDevelopment || preludeDevelopment,
      }),
    };
  } catch {
    return boundaryResponse;
  }
}

export class BookRpgResponsePipeline {
  constructor(
    private readonly model: string,
    private readonly send: (label: string, bookId: string, request: AiResponseRequest) => Promise<AiResponse>,
    private readonly centralValidation = false,
  ) {}
  private async reviewWorldRuleCompliance(
    bookId: string,
    worldRules: readonly string[],
    candidateOutput: string,
    dialogueTurn: boolean,
  ): Promise<WorldRuleComplianceReview> {
    const response = await this.send("world rule compliance review", bookId, {
      model: this.model,
      reasoning: { effort: "low" },
      instructions: [
        "You are a strict BookRPG world-rule compliance reviewer.",
        "Assess only the supplied active BookRPG world rules against the candidate output.",
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

    const verdict = worldRuleVerdict(response);
    if (verdict === "review_unavailable") {
      throw new TurnExecutionError("review_unavailable", "World-rule compliance could not be verified. The candidate was not accepted.");
    }
    try {
      const parsed = JSON.parse(response.output_text) as Partial<WorldRuleComplianceReview>;
      return {
        satisfied: verdict === "satisfied",
        failedRules: Array.isArray(parsed.failedRules)
          ? parsed.failedRules.filter((value): value is string => typeof value === "string")
          : [],
        reason: typeof parsed.reason === "string" ? parsed.reason : "World-rule compliance failed.",
      };
    } catch {
      throw new TurnExecutionError("review_unavailable", "World-rule compliance returned invalid evidence. The candidate was not accepted.");
    }
  }

  private async createBoundedOpeningPhase(
    label: "opening prelude" | "opening boundary",
    bookId: string,
    request: AiResponseRequest,
    wordLimit: number,
  ): Promise<AiResponse> {
    const response = await this.send(label, bookId, request);
    const wordCount = openingSplitSceneTextWordCount(response);
    if (
      response.status === "incomplete"
      || wordCount === null
      || wordCount <= wordLimit
    ) {
      return response;
    }
    if (label === "opening prelude") {
      flowDiagnostic(
        `BookRPG ${label} exceeded its ${wordLimit}-word phase target (${wordCount}); `
        + "preserving the complete pre-player beat sequence and leaving the hard 600-word opening budget to the outer scene validator.",
      );
      return response;
    }
    flowDiagnostic(
      `BookRPG ${label} exceeded ${wordLimit} words (${wordCount}); `
      + "applying deterministic phase clamp before the normal scene validators run.",
    );
    return clampOpeningSplitSceneText(response, wordLimit);
  }

  async execute(
    label: string,
    bookId: string,
    request: AiResponseRequest,
  ): Promise<AiResponse> {
    let normalizedRequest = withBookRpgWorldRuleTerminology(request);
    normalizedRequest = withCurrentBeatOnlyGenerationContext(label, normalizedRequest,
      this.centralValidation && Boolean(normalizedRequest.turnContract ?? currentTurnExecution()?.contract));
    normalizedRequest = withImmediateBeatOnlyChoiceContext(label, normalizedRequest);

    let response: AiResponse;
    if (shouldSplitOpeningScene(label, normalizedRequest)) {
      flowDiagnostic("BookRPG opening split: generating automatic prelude before player boundary.");
      const preludeResponse = await this.createBoundedOpeningPhase(
        "opening prelude",
        bookId,
        openingPreludeRequest(normalizedRequest),
        OPENING_SPLIT_PRELUDE_WORD_LIMIT,
      );
      if (preludeResponse.status === "incomplete") {
        response = preludeResponse;
      } else {
        try {
          const preludeOutput = JSON.parse(preludeResponse.output_text) as Record<string, unknown>;
          flowDiagnostic("BookRPG opening split: generating player-decision boundary after prelude.");
          const boundaryResponse = await this.createBoundedOpeningPhase(
            "opening boundary",
            bookId,
            openingBoundaryRequest(normalizedRequest, preludeOutput),
            OPENING_SPLIT_BOUNDARY_WORD_LIMIT,
          );
          response = mergeOpeningSplitResponses(preludeResponse, boundaryResponse);
        } catch (error) {
          if (error instanceof TurnExecutionError) throw error;
          response = preludeResponse;
        }
      }
    } else {
      response = await this.send(label, bookId, normalizedRequest);
    }

    if (!this.centralValidation && label === "scene presence review") {
      response = guardScenePresenceReviewPlayerBoundary(normalizedRequest, response);
    }

    if (!isWorldRuleEnforcedGeneration(label)) return response;

    const worldRules = this.centralValidation
      ? normalizedRequest.turnContract?.worldRules ?? currentTurnExecution()?.contract.worldRules ?? bookRpgWorldRulesFromRequest(normalizedRequest)
      : bookRpgWorldRulesFromRequest(normalizedRequest);
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
      if (repair === maxComplianceRepairs) {
        throw new TurnExecutionError("world_rule_violation", `World-rule compliance failed after ${repair + 1} reviews: ${review.failedRules.join(" | ") || review.reason}`);
      }

      normalizedRequest = {
        ...normalizedRequest,
        instructions: [
          normalizedRequest.instructions ?? "",
          worldRuleRepairInstruction(review),
        ].filter(Boolean).join("\n\n"),
      };
      response = await this.send(label, bookId, normalizedRequest);
    }

    return response;
  }
}

/** Compatibility facade; production uses the composed TurnPipelineGameEngine. */
export class BookRpgProviderGameEngine extends ProviderGameEngine {
  private readonly responsePipeline = new BookRpgResponsePipeline(this.model,
    (label, bookId, request) => super.createResponse(label, bookId, request));
  protected override createResponse(label: string, bookId: string, request: AiResponseRequest): Promise<AiResponse> {
    return this.responsePipeline.execute(label, bookId, request);
  }
}
