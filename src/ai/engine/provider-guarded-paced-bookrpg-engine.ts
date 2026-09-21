import type {
  GameState,
  Scene,
} from "../../shared/contracts.js";
import type {
  AiResponse,
  AiResponseRequest,
} from "../provider.js";
import type {
  SourceContinuationCandidate,
} from "./core.js";
import type {
  CompletedSceneAction,
} from "./scene-context.js";
import {
  addSourceContinuationChoiceFallback,
  sourceContinuationChoiceText,
} from "./scene-validation.js";
import {
  buildSourceChoiceNavigationContext,
  buildSourceEventChoiceBeatState,
  sourceEventHasPendingAutomaticPrefix,
} from "./source-navigation.js";
import { PacedBookRpgProviderGameEngine } from "./provider-paced-bookrpg-engine.js";

function normalizedIdentity(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase()
    : "";
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integerValues(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isInteger(item))
    : [];
}

function isPlayerDecisionBeat(
  beat: Record<string, unknown>,
  playerIdentity: string,
): boolean {
  return normalizedIdentity(beat.actor) === playerIdentity
    && (beat.agency === "intentional" || beat.agency === "ambiguous");
}

function isSplitOpeningRequest(label: string, request: AiResponseRequest): boolean {
  return label === "scene"
    && request.input.includes("OPENING PRELUDE:")
    && request.input.includes("PRELUDE BEAT ");
}

function stripSourceReferencesValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSourceReferencesValue);
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => key !== "sourceReferences")
      .map(([key, child]) => [key, stripSourceReferencesValue(child)]),
  );
}

export function withoutAiSourceReferences(
  request: AiResponseRequest,
): AiResponseRequest {
  let input = request.input;
  try {
    input = JSON.stringify(stripSourceReferencesValue(JSON.parse(input)), null, 2);
  } catch {
    input = input
      .replace(
        /,\n[ \t]*"sourceReferences": \[\n(?:[ \t]+.*\n)*?[ \t]*\]/gu,
        "",
      )
      .replace(/,?\n[ \t]*"sourceReferences": \[\]/gu, "");
  }
  return input === request.input ? request : { ...request, input };
}

export function openingPreludeNarrativeTarget(beatCount: number): {
  minimum: number;
  target: number;
} {
  const target = Math.min(260, 120 + Math.max(0, beatCount) * 25);
  return {
    minimum: Math.max(90, target - 25),
    target,
  };
}

function openingPreludeBeatCount(input: string): number {
  return input.split("\n").filter((line) => /^PRELUDE BEAT \d+\s+—\s+/u.test(line.trim())).length;
}

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

function gameContextFromInput(input: string): Record<string, unknown> | null {
  const marker = "GAME CONTEXT:\n";
  const markerIndex = input.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const objectStart = input.indexOf("{", markerIndex + marker.length);
  if (objectStart < 0) return null;
  const objectEnd = jsonObjectEnd(input, objectStart);
  if (objectEnd === null) return null;
  try {
    return record(JSON.parse(input.slice(objectStart, objectEnd)));
  } catch {
    return null;
  }
}

function openingPreludeSourceExcerptRecords(
  input: string,
  beatCount: number,
): Array<{ beatIndex: number; sourceReferencesExcerpt: string }> {
  const context = gameContextFromInput(input);
  const progress = record(context?.next_significant_event_progress);
  const remainingBeats = Array.isArray(progress?.remaining_beats)
    ? progress.remaining_beats
    : [];
  return remainingBeats.slice(0, beatCount).flatMap((value, beatIndex) => {
    const beat = record(value);
    const excerpt = beat?.sourceReferencesExcerpt;
    return typeof excerpt === "string" && excerpt.trim()
      ? [{ beatIndex, sourceReferencesExcerpt: excerpt }]
      : [];
  });
}

export function withOpeningPreludeSourceExcerpts(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (!isSplitOpeningRequest(label, request)) return request;
  const excerpts = openingPreludeSourceExcerptRecords(
    request.input,
    openingPreludeBeatCount(request.input),
  );
  if (excerpts.length === 0) return request;
  return {
    ...request,
    input: request.input
      + "\n\nOPENING PRELUDE SOURCE EXCERPTS (SOURCE EVIDENCE FOR THE LISTED PRELUDE BEATS ONLY; DO NOT CONTINUE PAST THE FINAL PRELUDE BEAT):\n"
      + JSON.stringify(excerpts, null, 2),
  };
}

function currentBeatSourceExcerptRecord(
  input: string,
): { action: string | null; sourceReferencesExcerpt: string } | null {
  const context = gameContextFromInput(input);
  const progress = record(context?.next_significant_event_progress);
  const beat = record(progress?.next_required_beat);
  const excerpt = beat?.sourceReferencesExcerpt;
  if (typeof excerpt !== "string" || !excerpt.trim()) return null;
  return {
    action: typeof beat?.action === "string" ? beat.action : null,
    sourceReferencesExcerpt: excerpt,
  };
}

export function withCurrentBeatSourceExcerpt(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene" || isSplitOpeningRequest(label, request)) return request;
  const currentBeat = currentBeatSourceExcerptRecord(request.input);
  if (!currentBeat) return request;
  return {
    ...request,
    input: request.input
      + "\n\nCURRENT SOURCE BEAT EXCERPT (SOURCE EVIDENCE FOR next_required_beat ONLY; DO NOT USE IT TO ADVANCE TO A LATER BEAT):\n"
      + JSON.stringify(currentBeat, null, 2),
  };
}

function withoutGenericOpeningWordGuidance(instructions: string): string {
  return instructions
    .split("\n")
    .filter((line) =>
      !line.includes("Keep scene text between 65 and 150 words")
      && !line.includes("Opening scene text may use up to 600 words")
    )
    .join("\n");
}

export function withHiddenOpeningControlData(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (!isSplitOpeningRequest(label, request)) return request;
  return {
    ...request,
    instructions: [
      request.instructions ?? "",
      "OPENING CONTROL-DATA VISIBILITY: PRELUDE BEAT labels and their Actor/action wording are hidden control data. Perform each listed beat naturally in prose, but never print a PRELUDE BEAT label, never print a bare `Actor: action` restatement of a listed beat, and never quote the control wording in player-facing text.",
      "PLAYER-BOUNDARY PHYSICAL STATE: after the final automatic prelude beat, preserve the exact physical end state it establishes. Do not move player_identity toward, begin, imply, or partially perform the first unselected player beat before the player chooses it.",
    ].filter(Boolean).join("\n"),
  };
}

export function withSinglePhaseOpeningPrelude(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (!isSplitOpeningRequest(label, request)) return request;
  const beatCount = openingPreludeBeatCount(request.input);
  const narrativeTarget = openingPreludeNarrativeTarget(beatCount);
  const dynamicTargetInstruction =
    `OPENING NARRATIVE TARGET: this opening has ${beatCount} automatic prelude beats. `
    + `Aim for roughly ${narrativeTarget.minimum}-${narrativeTarget.target} words of player-facing prose. `
    + "Give important beats enough narrative space for concrete action, sensory continuity, and character reaction. "
    + "Do not compress the ordered sequence into a checklist or one terse sentence per beat.";
  const input = request.input
    .replace(
      '"kind":"first_unselected_player_beat"',
      '"kind":"player_decision_boundary"',
    )
    .replace(
      "Each PRELUDE BEAT must get its own short, concrete sentence or clause that visibly performs that exact beat. Do not replace an ordered beat with atmosphere, introspection, anticipation, a summary, or a generic setup.",
      "Each PRELUDE BEAT must be clearly visible in the prose, but a beat may use multiple sentences and flow naturally into adjacent beats. Do not replace an ordered beat with atmosphere, introspection, anticipation, a summary, or a generic setup.",
    )
    .replace(
      "PRELUDE TARGET: keep phase-1 player-facing prose at or below 360 words. The 600-word value is only the hard combined opening ceiling after the short decision-boundary phase; do not use that headroom for reflection, recap, choice lists, or decorative filler.",
      "",
    )
    .replace(
      "For this split opening, target at most 360 words for the ordered prelude plus a very short decision-boundary continuation. The hard combined opening ceiling remains 600 words, but it is a safety ceiling, not a target. Spend words on the listed beats, not reflection or recap.",
      "",
    )
    .replace(/\n{3,}/gu, "\n\n");
  return {
    ...request,
    instructions: [
      withoutGenericOpeningWordGuidance(request.instructions ?? ""),
      "SINGLE-PHASE OPENING: generate the complete automatic/NPC prelude and stop immediately after its final listed PRELUDE BEAT, at the first player-decision boundary.",
      dynamicTargetInstruction,
      "Do not write a second boundary scene, decision-point continuation, menu, numbered options, question such as 'What do you do?', or any prose that begins the first unselected player beat. The normal BookRPG choice generator will create the menu after this scene is validated.",
      "Return playerAction exactly '', actionResult exactly '', actionOutcome exactly 'none'. Keep sceneScope at the physical end state of the final PRELUDE BEAT.",
    ].filter(Boolean).join("\n"),
    input,
  };
}

export function withAbsolutePresenceBeatIndex(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene presence review") return request;
  try {
    const input = JSON.parse(request.input) as Record<string, unknown>;
    const nextBeat = record(input.next_required_source_event_beat);
    if (!nextBeat || !Number.isInteger(nextBeat.index)) return request;
    const previous = integerValues(input.previous_completed_source_event_beat_indexes);
    const localIndex = nextBeat.index as number;
    if (previous.length === 0 || localIndex >= previous.length) return request;
    return {
      ...request,
      input: JSON.stringify({
        ...input,
        next_required_source_event_beat: {
          ...nextBeat,
          index: previous.length + localIndex,
        },
      }, null, 2),
    };
  } catch {
    return request;
  }
}

export function withAddressedActionResponseReview(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene repetition review") return request;
  return {
    ...request,
    instructions: [
      request.instructions ?? "",
      "ADDRESSED-ACTION RESPONSE CONTRACT: when immediate_transition.latest_input asks, questions, requests, commands, demands, challenges, promises to, signals, orders, or otherwise directly addresses a reachable NPC, resolving the player action requires an immediate substantive NPC response or an observable refusal/non-response with a concrete reason. A gaze, smile, nod, thoughtful pose, silence, atmosphere, or merely acknowledging that the player spoke is not a substantive answer to a direct question or request.",
      "If candidate_scene performs the player's addressed action but ends before that substantive response/refusal, set latestInputResolvedFaithfully false, latestInputFailureType 'stalled', and explain that the addressed action received no concrete response. The hidden action_result cannot compensate for a response missing from candidate_scene.text.",
      "When source evidence supplies the NPC's immediate answer to the selected question or request, use that answer as continuity grounding; do not leave the response pending merely to create another turn.",
    ].filter(Boolean).join("\n"),
  };
}

function openingPreludeControlLines(input: string): Set<string> {
  const forbidden = new Set<string>();
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    const match = /^PRELUDE BEAT \d+\s+—\s+(.+?):\s+(.+)$/u.exec(line);
    if (!match) continue;
    forbidden.add(line);
    forbidden.add(`${match[1]!.trim()}: ${match[2]!.trim()}`);
  }
  return forbidden;
}

export function stripOpeningControlDataLeak(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (
    response.status === "incomplete"
    || !request.input.includes("OPENING PRELUDE:")
    || !response.output_text.trim()
  ) {
    return response;
  }
  const forbidden = openingPreludeControlLines(request.input);
  if (forbidden.size === 0) return response;

  try {
    const output = JSON.parse(response.output_text) as Record<string, unknown>;
    if (typeof output.text !== "string") return response;
    const originalText = output.text;
    const sanitizedText = originalText
      .split("\n")
      .filter((line) => !forbidden.has(line.trim()))
      .join("\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    if (sanitizedText === originalText.trim()) return response;
    return {
      ...response,
      output_text: JSON.stringify({
        ...output,
        text: sanitizedText,
      }),
    };
  } catch {
    return response;
  }
}

export function correctOpeningDecisionBoundaryReview(
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
    if (input.event_review_target_mode !== "opening_progression") return response;
    const futureActions = Array.isArray(input.future_player_actions)
      ? input.future_player_actions.flatMap((value) => {
          const action = record(value);
          return action && Number.isInteger(action.beatIndex) ? [action] : [];
        })
      : [];
    if (futureActions.length === 0) return response;
    const boundaryIndex = Math.min(...futureActions.map((action) => action.beatIndex as number));
    if (boundaryIndex <= 0) return response;

    const output = JSON.parse(response.output_text) as Record<string, unknown>;
    const completed = new Set(integerValues(output.completedSourceEventBeatIndexes));
    const prefixComplete = Array.from({ length: boundaryIndex }, (_value, index) => index)
      .every((index) => completed.has(index));
    if (!prefixComplete) return response;

    return {
      ...response,
      output_text: JSON.stringify({
        ...output,
        futureActionSetupRequired: true,
        futureActionSetupSupported: true,
        futureActionSetupReason:
          "All ordered source beats before the first player-controlled beat are complete; that player beat is the current decision boundary.",
      }),
    };
  } catch {
    return response;
  }
}

type AutomaticFollowupReviewBeat = {
  index: number;
  action: string;
};

type AutomaticFollowupReviewWindow = {
  followups: AutomaticFollowupReviewBeat[];
  nextPlayerBeat: AutomaticFollowupReviewBeat | null;
};

function automaticFollowupReviewWindow(
  input: Record<string, unknown>,
): AutomaticFollowupReviewWindow | null {
  const playerIdentity = normalizedIdentity(input.player_identity);
  const candidateScene = record(input.candidate_scene);
  const nextRequiredBeat = record(input.next_required_source_event_beat);
  const eventReviewTarget = record(input.event_review_target);
  const beats = Array.isArray(eventReviewTarget?.beats)
    ? eventReviewTarget.beats
    : [];
  const playerAction = normalizedActionText(candidateScene?.player_action);
  const nextAction = normalizedActionText(nextRequiredBeat?.action);
  const nextBeatIndex = nextRequiredBeat?.index;

  if (
    !playerIdentity
    || !playerAction
    || !nextAction
    || playerAction !== nextAction
    || !nextRequiredBeat
    || !isPlayerDecisionBeat(nextRequiredBeat, playerIdentity)
    || typeof nextBeatIndex !== "number"
    || !Number.isInteger(nextBeatIndex)
    || beats.length === 0
  ) {
    return null;
  }

  const previousCount = integerValues(input.previous_completed_source_event_beat_indexes).length;
  const localIndex = nextBeatIndex >= previousCount ? nextBeatIndex : nextBeatIndex - previousCount;
  const beatArrayOffset = previousCount > 0 && beats.length <= previousCount
    ? previousCount
    : 0;
  const effectiveLocalIndex = beatArrayOffset > 0
    ? Math.max(0, nextBeatIndex - beatArrayOffset)
    : localIndex;

  const followups: AutomaticFollowupReviewBeat[] = [];
  let nextPlayerBeat: AutomaticFollowupReviewBeat | null = null;
  for (let index = effectiveLocalIndex + 1; index < beats.length; index += 1) {
    const beat = record(beats[index]);
    if (!beat) break;
    const absoluteIndex = beatArrayOffset + index;
    const action = typeof beat.action === "string"
      ? beat.action
      : `source beat ${absoluteIndex}`;
    if (isPlayerDecisionBeat(beat, playerIdentity)) {
      nextPlayerBeat = { index: absoluteIndex, action };
      break;
    }
    followups.push({ index: absoluteIndex, action });
  }

  return { followups, nextPlayerBeat };
}

export function withAutomaticFollowupPresenceReview(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene presence review") return request;
  try {
    const input = JSON.parse(request.input) as Record<string, unknown>;
    const window = automaticFollowupReviewWindow(input);
    if (!window || (window.followups.length === 0 && !window.nextPlayerBeat)) return request;

    const required = window.followups.length > 0
      ? window.followups.map((beat) => `${beat.index}: ${beat.action}`).join(" | ")
      : "none";
    const forbidden = window.nextPlayerBeat
      ? `${window.nextPlayerBeat.index}: ${window.nextPlayerBeat.action}`
      : "none";

    return {
      ...request,
      instructions: [
        request.instructions ?? "",
        "PLAYER-BOUNDARY FOLLOW-UP REVIEW: the candidate_scene.player_action is the selected player beat for this turn. Review the ordered beats after it using the exact source order below.",
        `Required same-turn non-player/automatic follow-ups: ${required}.`,
        "For every required follow-up whose concrete action is visibly completed in candidate_scene.text, include its absolute beat index in completedSourceEventBeatIndexes. Judge semantic completion by the concrete outcome, not literal wording. Do not omit an intentional NPC beat merely because it is intentional; it is still automatic from this player's perspective.",
        `First forbidden next player decision: ${forbidden}.`,
        "If the candidate visibly begins or completes that forbidden next player decision, include its absolute beat index in completedSourceEventBeatIndexes too. This reporting is intentional: the deterministic guard will reject the scene for crossing the player-decision boundary. Do not hide an over-advanced player beat by omitting its index.",
      ].filter(Boolean).join("\n"),
    };
  } catch {
    return request;
  }
}

export function enforceAutomaticFollowupReview(
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
    const output = JSON.parse(response.output_text) as Record<string, unknown>;
    const eventReviewTarget = record(input.event_review_target);
    const window = automaticFollowupReviewWindow(input);
    if (!window || (window.followups.length === 0 && !window.nextPlayerBeat)) return response;

    const completedIndexes = new Set(integerValues(output.completedSourceEventBeatIndexes));
    if (window.nextPlayerBeat && completedIndexes.has(window.nextPlayerBeat.index)) {
      const crossed = `${window.nextPlayerBeat.index}: ${window.nextPlayerBeat.action}`;
      return {
        ...response,
        output_text: JSON.stringify({
          ...output,
          futureActionSetupRequired: true,
          futureActionSetupSupported: false,
          futureActionSetupReason:
            "The scene crossed the player-decision boundary after its automatic follow-up window. "
            + `The next unselected player beat must remain future: ${crossed}.`,
          reason: [
            typeof output.reason === "string" ? output.reason : "",
            `Player-boundary validation failed: ${crossed}.`,
          ].filter(Boolean).join(" "),
        }),
      };
    }

    if (window.followups.length === 0) return response;

    const targetEventId = typeof eventReviewTarget?.eventId === "string"
      ? eventReviewTarget.eventId
      : null;
    if (targetEventId && output.latestVisibleSourceEventId === targetEventId) {
      return response;
    }

    const missing = window.followups.filter((beat) => !completedIndexes.has(beat.index));
    if (missing.length === 0) return response;

    const missingDescription = missing
      .map((beat) => `${beat.index}: ${beat.action}`)
      .join(" | ");
    return {
      ...response,
      output_text: JSON.stringify({
        ...output,
        futureActionSetupRequired: true,
        futureActionSetupSupported: false,
        futureActionSetupReason:
          "The selected player beat has an automatic follow-up window that must complete before the next decision. "
          + `The candidate did not visibly complete: ${missingDescription}.`,
        reason: [
          typeof output.reason === "string" ? output.reason : "",
          `Automatic follow-up validation failed: ${missingDescription}.`,
        ].filter(Boolean).join(" "),
      }),
    };
  } catch {
    return response;
  }
}

export function hasAutomaticOrderedSourceBoundary(
  setting: Pick<Scene, "sceneScope">,
  state: GameState,
  sourceCandidates: readonly SourceContinuationCandidate[],
  completedSourceEventId?: string,
): boolean {
  const event = buildSourceChoiceNavigationContext(
    sourceCandidates[0],
    state.playerName,
    state.characterProfiles,
    completedSourceEventId,
    setting.sceneScope,
  );
  const remainingEvent = buildSourceEventChoiceBeatState(
    event,
    state.sourceEventProgress,
  ).remainingEvent;
  if (!remainingEvent?.beats?.length) return false;
  return sourceEventHasPendingAutomaticPrefix(
    remainingEvent,
    state.playerName,
    state.characterProfiles,
  );
}

export class GuardedPacedBookRpgProviderGameEngine extends PacedBookRpgProviderGameEngine {
  protected override async createResponse(
    label: string,
    bookId: string,
    request: AiResponseRequest,
  ): Promise<AiResponse> {
    let guardedRequest = withoutAiSourceReferences(request);
    guardedRequest = withCurrentBeatSourceExcerpt(label, guardedRequest);
    guardedRequest = withOpeningPreludeSourceExcerpts(label, guardedRequest);
    guardedRequest = withHiddenOpeningControlData(label, guardedRequest);
    guardedRequest = withSinglePhaseOpeningPrelude(label, guardedRequest);
    guardedRequest = withAddressedActionResponseReview(label, guardedRequest);
    guardedRequest = withAbsolutePresenceBeatIndex(label, guardedRequest);
    guardedRequest = withAutomaticFollowupPresenceReview(label, guardedRequest);
    let response = await super.createResponse(label, bookId, guardedRequest);
    if (label === "scene") {
      response = stripOpeningControlDataLeak(request, response);
    }
    if (label === "scene presence review") {
      response = correctOpeningDecisionBoundaryReview(guardedRequest, response);
      response = enforceAutomaticFollowupReview(guardedRequest, response);
    }
    return response;
  }

  protected override async sceneChoices(
    setting: Scene,
    state: GameState,
    sourceCandidates: readonly SourceContinuationCandidate[],
    consumedAction?: string,
    completedSourceEventId?: string,
    initialAcceptedChoices: Scene["choices"] = [],
    initialRejectedChoices: string[] = [],
    explicitlyUnavailableCharacters: readonly string[] = sourceCandidates.flatMap(
      (candidate) => candidate.unavailableCharacters ?? [],
    ),
    completedAction?: CompletedSceneAction,
  ): Promise<Scene["choices"]> {
    const choices = await super.sceneChoices(
      setting,
      state,
      sourceCandidates,
      consumedAction,
      completedSourceEventId,
      initialAcceptedChoices,
      initialRejectedChoices,
      explicitlyUnavailableCharacters,
      completedAction,
    );
    if (!hasAutomaticOrderedSourceBoundary(
      setting,
      state,
      sourceCandidates,
      completedSourceEventId,
    )) {
      return choices;
    }

    return addSourceContinuationChoiceFallback(
      { ...setting, choices: [] },
      sourceContinuationChoiceText(sourceCandidates[0]),
    ).choices;
  }
}
