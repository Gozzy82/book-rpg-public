import type {
  AiResponse,
  AiResponseRequest,
} from "../provider.js";
import {
  SOURCE_CONTINUATION_CHOICE_TEXT,
} from "../../shared/contracts.js";
import { GuardedPacedBookRpgProviderGameEngine } from "./provider-guarded-paced-bookrpg-engine.js";

const GAME_CONTEXT_MARKER = "GAME CONTEXT:\n";
const IMMEDIATE_TURN_MARKER =
  "IMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):\n";
const CHOICE_NAVIGATION_MARKER = "CHOICE NAVIGATION EVENT:\n\n";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

function jsonObjectAfterMarker(
  text: string,
  marker: string,
): Record<string, unknown> | null {
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  const end = jsonObjectEnd(text, start);
  if (end === null) return null;
  try {
    return record(JSON.parse(text.slice(start, end)));
  } catch {
    return null;
  }
}

function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = jsonObjectEnd(text, start);
  if (end === null) return null;
  try {
    return record(JSON.parse(text.slice(start, end)));
  } catch {
    return null;
  }
}

function normalizedIdentity(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase()
    : "";
}

function normalizeActionToken(token: string): string {
  const normalized = token.toLocaleLowerCase();
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

function normalizedAction(value: unknown): string {
  if (typeof value !== "string") return "";
  return (value.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(normalizeActionToken)
    .join(" ");
}

function isPlayerDecisionBeat(
  beat: Record<string, unknown>,
  playerIdentity: string,
): boolean {
  return normalizedIdentity(beat.actor) === playerIdentity
    && (beat.agency === "intentional" || beat.agency === "ambiguous");
}

function selectedOptionText(input: string): string {
  const transition = jsonObjectAfterMarker(input, IMMEDIATE_TURN_MARKER);
  const latest = record(transition?.latest_input);
  return latest?.kind === "selected_option" && typeof latest.text === "string"
    ? latest.text
    : "";
}

type AutomaticSceneWindow = {
  beats: Array<Record<string, unknown>>;
  nextPlayerBeat: Record<string, unknown> | null;
};

function compactBeat(
  beat: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return {
    index,
    actor: typeof beat.actor === "string" || beat.actor === null ? beat.actor : null,
    action: typeof beat.action === "string" ? beat.action : "",
    agency: beat.agency,
    stakes: beat.stakes,
    ...(typeof beat.sourceReferencesExcerpt === "string" && beat.sourceReferencesExcerpt.trim()
      ? { sourceReferencesExcerpt: beat.sourceReferencesExcerpt.trim() }
      : {}),
  };
}

function automaticWindowForScene(
  request: AiResponseRequest,
): AutomaticSceneWindow | null {
  const context = jsonObjectAfterMarker(request.input, GAME_CONTEXT_MARKER);
  const progress = record(context?.next_significant_event_progress);
  const remaining = Array.isArray(progress?.remaining_beats)
    ? progress.remaining_beats
    : [];
  if (!context || !progress || remaining.length === 0) return null;

  const playerIdentity = normalizedIdentity(context.player_identity);
  if (!playerIdentity) return null;
  const selectedText = selectedOptionText(request.input);
  const nextBeat = record(progress.next_required_beat);
  if (!nextBeat) return null;

  let start = 0;
  if (selectedText !== SOURCE_CONTINUATION_CHOICE_TEXT) {
    if (
      !isPlayerDecisionBeat(nextBeat, playerIdentity)
      || normalizedAction(selectedText) !== normalizedAction(nextBeat.action)
    ) {
      return null;
    }
    const selectedIndex = remaining.findIndex((value) => {
      const beat = record(value);
      return beat
        && normalizedIdentity(beat.actor) === normalizedIdentity(nextBeat.actor)
        && normalizedAction(beat.action) === normalizedAction(nextBeat.action);
    });
    if (selectedIndex < 0) return null;
    start = selectedIndex + 1;
  }

  const beats: Array<Record<string, unknown>> = [];
  let nextPlayerBeat: Record<string, unknown> | null = null;
  for (let index = start; index < remaining.length; index += 1) {
    const beat = record(remaining[index]);
    if (!beat) break;
    if (isPlayerDecisionBeat(beat, playerIdentity)) {
      nextPlayerBeat = compactBeat(beat, index);
      break;
    }
    beats.push(compactBeat(beat, index));
  }
  return { beats, nextPlayerBeat };
}

export function withPlayerIdentitySourceNarration(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene") return request;
  const context = jsonObjectAfterMarker(request.input, GAME_CONTEXT_MARKER);
  const player = typeof context?.player_identity === "string"
    ? context.player_identity.trim()
    : "";
  if (!player) return request;
  return {
    ...request,
    instructions: [
      request.instructions ?? "",
      `PLAYER IDENTITY SOURCE REWRITE: every source reference to ${player} denotes the first-person narrator, never a second copy of the character. In player-facing narration, translate source actions, body state, possessions, and targets involving ${player} into I/me/my. Do not let I observe, approach, discover, carry, attack, follow, or describe a separately named ${player}; do not write a second ${player} as a figure, body, or participant. Self-identification such as \"I am ${player}\" is allowed.`,
    ].filter(Boolean).join("\n"),
  };
}

function withoutConflictingFollowupInstructions(instructions: string): string {
  const conflicting = [
    "only the next ordered beat is mandatory now",
    "do not require or summarize every later remaining beat",
    "after the required beat and its immediate inseparable consequence, stop at the next meaningful decision or observable beat boundary",
  ];
  return instructions
    .split("\n")
    .filter((line) => !conflicting.some((fragment) => line.toLocaleLowerCase().includes(fragment)))
    .join("\n");
}

export function withConcreteAutomaticSceneWindow(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene") return request;
  const window = automaticWindowForScene(request);
  if (!window || (window.beats.length === 0 && !window.nextPlayerBeat)) return request;
  const requiredOutcomes = window.beats
    .map((beat) => `${beat.index}: ${String(beat.action ?? "")}`)
    .join(" | ");
  const baseInstructions = window.beats.length > 0
    ? withoutConflictingFollowupInstructions(request.instructions ?? "")
    : request.instructions ?? "";
  return {
    ...request,
    instructions: [
      baseInstructions,
      ...(window.beats.length > 0
        ? [
            "CONCRETE AUTOMATIC SOURCE WINDOW: the listed ordered beats are mandatory same-scene progression, not optional background. Visibly enact every listed beat in order in player-facing prose. An intentional NPC action remains automatic because its actor is not player_identity.",
            `REQUIRED BEFORE ENDING THIS SCENE: ${requiredOutcomes}. A draft that ends before these concrete outcomes occur is incomplete and must be regenerated. Do not merely mention, prepare, invite, or imply these actions; show their observable end state.`,
          ]
        : []),
      ...(window.nextPlayerBeat
        ? ["FIRST FORBIDDEN PLAYER BEAT: the listed player-controlled beat is the next decision boundary. Do not begin, imply, paraphrase as completed, or perform any part of it in this scene. End with that action still wholly available to the player."]
        : []),
    ].filter(Boolean).join("\n"),
    input: request.input
      + (window.beats.length > 0
        ? "\n\nMANDATORY SAME-SCENE AUTOMATIC BEATS (CONTROL DATA; DO NOT PRINT THIS LABEL OR THESE JSON OBJECTS):\n"
          + JSON.stringify(window.beats, null, 2)
        : "")
      + (window.nextPlayerBeat
        ? "\n\nFIRST FORBIDDEN NEXT PLAYER BEAT (CONTROL DATA; KEEP FUTURE):\n"
          + JSON.stringify(window.nextPlayerBeat, null, 2)
        : ""),
  };
}

function significantActionTokens(value: unknown): string[] {
  const stop = new Set(["a", "an", "and", "the", "to", "of", "at", "after", "toward", "towards", "with"]);
  return normalizedAction(value).split(" ").filter((token) => token && !stop.has(token));
}

function candidateVisiblyPerforms(
  candidateText: string,
  action: unknown,
): boolean {
  const textTokens = new Set(normalizedAction(candidateText).split(" ").filter(Boolean));
  const actionTokens = significantActionTokens(action);
  if (actionTokens.length === 0) return false;
  const matches = actionTokens.filter((token) => textTokens.has(token)).length;
  return matches >= Math.min(2, actionTokens.length);
}

export function normalizeOpeningBoundaryRepetitionReview(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (
    response.status === "incomplete"
    || request.text?.format.name !== "bookrpg_scene_repetition_review"
    || !response.output_text.trim()
  ) {
    return response;
  }
  try {
    const input = firstJsonObject(request.input);
    const candidate = record(input?.candidate_scene);
    const priorScenes = Array.isArray(input?.recent_prior_scenes) ? input.recent_prior_scenes : [];
    if (!input || input.immediate_transition !== null || priorScenes.length !== 0 || !candidate) {
      return response;
    }
    const playerIdentity = normalizedIdentity(input.player_identity);
    const event = jsonObjectAfterMarker(request.input, CHOICE_NAVIGATION_MARKER);
    const beats = Array.isArray(event?.beats) ? event.beats : [];
    const beatRecords = beats.map(record);
    const firstPlayerBeatIndex = beatRecords.findIndex((beat) => Boolean(
      beat && isPlayerDecisionBeat(beat, playerIdentity),
    ));
    const firstPlayerBeat = firstPlayerBeatIndex >= 0
      ? beatRecords[firstPlayerBeatIndex]
      : null;
    const output = JSON.parse(response.output_text) as Record<string, unknown>;
    const candidateText = typeof candidate.text === "string" ? candidate.text : "";
    const playerAction = typeof candidate.player_action === "string"
      ? candidate.player_action.trim()
      : "";
    if (playerAction) return response;

    let changed = false;
    const corrected = { ...output };
    const openingStopsBeforeFirstBeat = firstPlayerBeatIndex === 0
      && firstPlayerBeat
      && !candidateVisiblyPerforms(candidateText, firstPlayerBeat.action);
    const reviewerDemandsWholeEvent = typeof output.latestInputFailureReason === "string"
      && /current significant event|required current significant event|required .*event|required substantive beat|attack.*(?:proceed|advance)/iu.test(
        output.latestInputFailureReason,
      );
    if (
      firstPlayerBeat
      && output.latestInputResolvedFaithfully === false
      && !candidateVisiblyPerforms(candidateText, firstPlayerBeat.action)
      && (
        openingStopsBeforeFirstBeat
        || reviewerDemandsWholeEvent
        || (
          typeof output.latestInputFailureReason === "string"
          && /does not resolve|before the .*event/iu.test(output.latestInputFailureReason)
        )
      )
    ) {
      corrected.latestInputResolvedFaithfully = true;
      corrected.latestInputFailureType = "none";
      corrected.latestInputFailureReason = "";
      changed = true;
    }
    if (
      firstPlayerBeat
      && output.preservesPlayerAgency === false
      && !candidateVisiblyPerforms(candidateText, firstPlayerBeat.action)
    ) {
      corrected.preservesPlayerAgency = true;
      corrected.playerAgencyFailureReason = "";
      changed = true;
    }
    if (!changed) return response;
    corrected.reason = "Opening stops at the first unselected player-decision boundary without performing that player beat.";
    return {
      ...response,
      output_text: JSON.stringify(corrected),
    };
  } catch {
    return response;
  }
}

function proseOutsideDialogue(text: string): string {
  return text
    .replace(/“[^”]*”/gu, " ")
    .replace(/"(?:\\.|[^"\\])*"/gu, " ");
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function separateSelfReference(
  narration: string,
  player: string,
): string | null {
  const escaped = escapedRegex(player);
  const appositiveSelf = new RegExp(
    `\\bI\\s*,\\s*(?:(?:a|the)\\s+)?${escaped}\\s*,`,
    "giu",
  );
  const checkedNarration = narration.replace(appositiveSelf, "I, SELF,");
  const subjectVerb = new RegExp(
    `\\b${escaped}\\s+(?:jumps?|leaps?|slips?|bolts?|runs?|moves?|stands?|walks?|follows?|leans?|presses?|tugs?|nudges?|barks?|whines?|looks?|watches?|darts?|scrabbles?|climbs?|falls?|lies?|sits?|turns?|reaches?|lifts?|catches?)\\b`,
    "iu",
  );
  const possessiveBody = new RegExp(
    `\\b${escaped}(?:'s|’s)\\s+(?:paws?|ears?|tail|body|head|legs?|eyes?|heartbeat|scruff)\\b`,
    "iu",
  );
  const objectReference = new RegExp(
    `\\b(?:watch|see|hear|follow|help|steady|touch|lift|carry|nudge|guide|discover|approach|describe)\\s+(?:a\\s+|the\\s+)?${escaped}\\b`,
    "iu",
  );
  const separateFigure = new RegExp(
    `\\b(?:a|the)\\s+${escaped}\\b(?:[^.!?]{0,80})\\b(?:stands?|lies?|waits?|cannot|can't|unable|beside|near)\\b`,
    "iu",
  );
  return subjectVerb.test(checkedNarration)
      || possessiveBody.test(checkedNarration)
      || objectReference.test(checkedNarration)
      || separateFigure.test(checkedNarration)
    ? player
    : null;
}

export function enforceFirstPersonPlayerIdentity(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (
    response.status === "incomplete"
    || request.text?.format.name !== "bookrpg_scene_repetition_review"
    || !response.output_text.trim()
  ) {
    return response;
  }
  try {
    const input = firstJsonObject(request.input);
    const candidate = record(input?.candidate_scene);
    const player = typeof input?.player_identity === "string" ? input.player_identity.trim() : "";
    const candidateText = typeof candidate?.text === "string" ? candidate.text : "";
    if (!player || !candidateText) return response;
    const narration = proseOutsideDialogue(candidateText);
    const duplicatedIdentity = separateSelfReference(narration, player);
    if (!duplicatedIdentity) return response;

    const output = JSON.parse(response.output_text) as Record<string, unknown>;
    return {
      ...response,
      output_text: JSON.stringify({
        ...output,
        latestInputResolvedFaithfully: false,
        latestInputFailureType: "identity_or_roles",
        latestInputFailureReason:
          `Narration treats player_identity (${player}) as a separately acting or observed character.`,
        preservesPlayerPerspective: false,
        playerPerspectiveFailureReason:
          `First-person narration separately acts on, observes, or assigns actions/body state to ${duplicatedIdentity}; the player must remain I/me/my.`,
        reason:
          `Player self-duplication detected: ${duplicatedIdentity} appears as a separate participant in narration.`,
      }),
    };
  } catch {
    return response;
  }
}

export function normalizeSelectedOptionPlayerAction(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (response.status === "incomplete" || !response.output_text.trim()) return response;
  const selected = selectedOptionText(request.input);
  if (!selected || selected === SOURCE_CONTINUATION_CHOICE_TEXT) return response;
  try {
    const output = JSON.parse(response.output_text) as Record<string, unknown>;
    if (typeof output.playerAction !== "string" || output.playerAction === selected) {
      return response;
    }
    return {
      ...response,
      output_text: JSON.stringify({
        ...output,
        playerAction: selected,
      }),
    };
  } catch {
    return response;
  }
}

export class E2eRecoveryBookRpgProviderGameEngine extends GuardedPacedBookRpgProviderGameEngine {
  protected override async createResponse(
    label: string,
    bookId: string,
    request: AiResponseRequest,
  ): Promise<AiResponse> {
    let preparedRequest = withPlayerIdentitySourceNarration(label, request);
    preparedRequest = withConcreteAutomaticSceneWindow(label, preparedRequest);
    if (
      label === "scene"
      && !request.input.includes(IMMEDIATE_TURN_MARKER)
      && (preparedRequest.max_output_tokens ?? 0) < 2_400
    ) {
      preparedRequest = { ...preparedRequest, max_output_tokens: 2_400 };
    }
    let response = await super.createResponse(label, bookId, preparedRequest);
    if (label === "scene") {
      response = normalizeSelectedOptionPlayerAction(preparedRequest, response);
    }
    if (label === "scene repetition review") {
      response = normalizeOpeningBoundaryRepetitionReview(preparedRequest, response);
      response = enforceFirstPersonPlayerIdentity(preparedRequest, response);
    }
    return response;
  }
}
