import type {
  AiResponse,
  AiResponseRequest,
} from "../provider.js";
import { E2eRecoveryBookRpgProviderGameEngine } from "./provider-e2e-recovery-engine.js";

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

function normalizedIdentity(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase()
    : "";
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

function firstPlayerBeatFromReviewRequest(
  request: AiResponseRequest,
): Record<string, unknown> | null {
  const input = firstJsonObject(request.input);
  const playerIdentity = normalizedIdentity(input?.player_identity);
  if (!input || input.immediate_transition !== null || !playerIdentity) return null;
  const recentPriorScenes = Array.isArray(input.recent_prior_scenes)
    ? input.recent_prior_scenes
    : [];
  if (recentPriorScenes.length !== 0) return null;

  const event = jsonObjectAfterMarker(request.input, CHOICE_NAVIGATION_MARKER);
  const beats = Array.isArray(event?.beats) ? event.beats : [];
  for (const value of beats) {
    const beat = record(value);
    if (beat && isPlayerDecisionBeat(beat, playerIdentity)) return beat;
  }
  return null;
}

export function withOpeningBoundaryReviewContract(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene repetition review") return request;
  const firstPlayerBeat = firstPlayerBeatFromReviewRequest(request);
  if (!firstPlayerBeat) return request;

  return {
    ...request,
    instructions: [
      request.instructions ?? "",
      "OPENING PLAYER-DECISION BOUNDARY REVIEW: the exact structured beat below is the first unselected player-controlled source beat. Judge candidate_scene semantically, not by word overlap. The opening may establish every prerequisite and may end with the player poised to act, but it must not actually perform any material part of this beat. If it does, set preservesPlayerAgency false and latestInputResolvedFaithfully false. Mere presence of its participants, location, targets, props, or source vocabulary is not evidence that the action happened.",
      `FIRST UNSELECTED PLAYER BEAT (STRUCTURED CONTROL DATA): ${JSON.stringify(firstPlayerBeat)}`,
    ].filter(Boolean).join("\n"),
  };
}

export function withOpeningProgressReviewContract(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene presence review") return request;
  try {
    const input = JSON.parse(request.input) as Record<string, unknown>;
    if (input.event_review_target_mode !== "opening_progression") return request;
    const nextBeat = record(input.next_required_source_event_beat);
    if (!nextBeat) return request;

    return {
      ...request,
      instructions: [
        request.instructions ?? "",
        "OPENING BEAT SEMANTIC REVIEW: assess the exact structured next beat below from the concrete candidate prose. Credit it when the same action/outcome is visibly realized by natural paraphrase, observation, movement, gesture, or other semantically equivalent narration; do not require source wording or shared verbs. Do not credit it from mere presence or possibility. Keep every later unselected player beat future.",
        `EXACT NEXT OPENING BEAT (STRUCTURED CONTROL DATA): ${JSON.stringify(nextBeat)}`,
      ].filter(Boolean).join("\n"),
    };
  } catch {
    return request;
  }
}

export function withNonInteractableConsistencyContract(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene repetition review") return request;
  return {
    ...request,
    instructions: [
      request.instructions ?? "",
      "NON-INTERACTABLE CONSISTENCY: populate nonInteractableCharacters only from a concrete death, corpse state, or permanent departure established in the reviewed narrative/state. If none is established, return an empty array. Do not infer non-interactability from distance, absence, anticipation, source metadata, or a character merely not participating in the current action.",
    ].filter(Boolean).join("\n"),
  };
}

type IndexedBeat = {
  index: number;
  beat: Record<string, unknown>;
};

type FollowupWindow = {
  followupIndexes: number[];
  followupBeats: IndexedBeat[];
  nextPlayerIndex: number | null;
  nextPlayerBeat: IndexedBeat | null;
};

function automaticFollowupWindow(
  input: Record<string, unknown>,
): FollowupWindow | null {
  const playerIdentity = normalizedIdentity(input.player_identity);
  const nextBeat = record(input.next_required_source_event_beat);
  const event = record(input.event_review_target);
  const beats = Array.isArray(event?.beats) ? event.beats : [];
  const selectedIndex = nextBeat?.index;
  if (
    !playerIdentity
    || typeof selectedIndex !== "number"
    || !Number.isInteger(selectedIndex)
    || !nextBeat
    || !isPlayerDecisionBeat(nextBeat, playerIdentity)
    || beats.length === 0
  ) {
    return null;
  }

  const previousCount = integerValues(input.previous_completed_source_event_beat_indexes).length;
  const beatArrayOffset = previousCount > 0 && beats.length <= previousCount
    ? previousCount
    : 0;
  const localSelectedIndex = beatArrayOffset > 0
    ? selectedIndex - beatArrayOffset
    : selectedIndex;
  if (localSelectedIndex < 0 || localSelectedIndex >= beats.length) return null;

  const followupBeats: IndexedBeat[] = [];
  let nextPlayerBeat: IndexedBeat | null = null;
  for (let localIndex = localSelectedIndex + 1; localIndex < beats.length; localIndex += 1) {
    const beat = record(beats[localIndex]);
    if (!beat) break;
    const absoluteIndex = beatArrayOffset + localIndex;
    if (isPlayerDecisionBeat(beat, playerIdentity)) {
      nextPlayerBeat = { index: absoluteIndex, beat };
      break;
    }
    followupBeats.push({ index: absoluteIndex, beat });
  }
  return {
    followupIndexes: followupBeats.map(({ index }) => index),
    followupBeats,
    nextPlayerIndex: nextPlayerBeat?.index ?? null,
    nextPlayerBeat,
  };
}

export function withAutomaticFollowupProgressReviewContract(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene presence review") return request;
  try {
    const input = JSON.parse(request.input) as Record<string, unknown>;
    const window = automaticFollowupWindow(input);
    if (!window || window.followupBeats.length === 0) return request;

    return {
      ...request,
      instructions: [
        request.instructions ?? "",
        "AUTOMATIC FOLLOW-UP PROGRESS REVIEW: the structured beats below are the ordered non-player/source consequences allowed after the selected player beat and before the next player decision. Evaluate each one semantically against candidate_scene. If its concrete action/outcome is visibly realized, include its absolute index in completedSourceEventBeatIndexes even when phrased naturally or embedded in dialogue/reaction. Do not require source wording. Do not omit a completed automatic beat merely because a later player beat must remain protected.",
        `AUTOMATIC FOLLOW-UP BEATS (STRUCTURED CONTROL DATA): ${JSON.stringify(window.followupBeats)}`,
        window.nextPlayerBeat
          ? `NEXT PLAYER BOUNDARY (MUST REMAIN UNCOMPLETED): ${JSON.stringify(window.nextPlayerBeat)}`
          : "",
      ].filter(Boolean).join("\n"),
    };
  } catch {
    return request;
  }
}

export function relaxMissingAutomaticFollowupReview(
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
    const window = automaticFollowupWindow(input);
    if (!window || window.followupIndexes.length === 0) return response;

    const nextBeat = record(input.next_required_source_event_beat);
    const selectedIndex = nextBeat?.index;
    const completed = integerValues(output.completedSourceEventBeatIndexes);
    if (
      typeof selectedIndex !== "number"
      || !completed.includes(selectedIndex)
      || output.futureActionSetupSupported !== false
    ) {
      return response;
    }

    if (window.nextPlayerIndex !== null && completed.includes(window.nextPlayerIndex)) {
      return response;
    }
    const missingFollowup = window.followupIndexes.some((index) => !completed.includes(index));
    if (!missingFollowup) return response;

    return {
      ...response,
      output_text: JSON.stringify({
        ...output,
        futureActionSetupRequired: false,
        futureActionSetupSupported: true,
        futureActionSetupReason:
          "The selected player beat is complete. A still-pending non-player/source follow-up will continue before the next player decision.",
        reason: [
          typeof output.reason === "string" ? output.reason : "",
          "Accepted the completed selected player beat while leaving the missing automatic follow-up incomplete in source progress.",
        ].filter(Boolean).join(" "),
      }),
    };
  } catch {
    return response;
  }
}

export class E2eHardeningBookRpgProviderGameEngine extends E2eRecoveryBookRpgProviderGameEngine {
  protected override async createResponse(
    label: string,
    bookId: string,
    request: AiResponseRequest,
  ): Promise<AiResponse> {
    let preparedRequest = label === "scene"
      ? {
          ...request,
          reasoning: { effort: "low" as const },
          max_output_tokens: Math.max(request.max_output_tokens ?? 0, 2_400),
          instructions: [
            request.instructions ?? "",
            "ORDERED FOLLOW-UP COMPLETION: when this turn has a mandatory automatic/NPC follow-up before the next player decision, the scene is not complete until that follow-up's concrete physical end state is visible in prose. Do not end on setup, intention, dialogue, or anticipation of that follow-up.",
          ].filter(Boolean).join("\n"),
        }
      : request;

    preparedRequest = withOpeningBoundaryReviewContract(label, preparedRequest);
    preparedRequest = withOpeningProgressReviewContract(label, preparedRequest);
    preparedRequest = withAutomaticFollowupProgressReviewContract(label, preparedRequest);
    preparedRequest = withNonInteractableConsistencyContract(label, preparedRequest);

    let response = await super.createResponse(label, bookId, preparedRequest);
    if (label === "scene presence review") {
      response = relaxMissingAutomaticFollowupReview(preparedRequest, response);
    }
    return response;
  }
}
