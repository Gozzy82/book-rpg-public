import {
  SOURCE_CONTINUATION_CHOICE_TEXT,
} from "../../shared/contracts.js";
import type {
  GameState,
} from "../../shared/contracts.js";
import type {
  AiResponse,
  AiResponseRequest,
} from "../provider.js";
import type {
  SourceContinuationCandidate,
  SourceContinuationResult,
} from "./core.js";
import { BookRpgProviderGameEngine } from "./provider-bookrpg-engine.js";

const GAME_CONTEXT_MARKER = "GAME CONTEXT:\n";
const IMMEDIATE_TURN_MARKER =
  "IMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):\n";
const OPENING_BOUNDARY_MARKER =
  "The opening has a structured player-decision boundary.";
const PLAYER_PERSPECTIVE_MARKER = "PLAYER PERSPECTIVE RULES:\n";

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

function parsedObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = jsonObjectEnd(text, start);
  if (end === null) return null;
  try {
    const value = JSON.parse(text.slice(start, end));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function jsonObjectAfterMarker(
  text: string,
  marker: string,
): { start: number; end: number; value: Record<string, unknown> } | null {
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  const end = jsonObjectEnd(text, start);
  if (end === null) return null;
  try {
    const value = JSON.parse(text.slice(start, end));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { start, end, value: value as Record<string, unknown> }
      : null;
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

function selectedOptionText(input: string): string {
  const transition = jsonObjectAfterMarker(input, IMMEDIATE_TURN_MARKER)?.value;
  const latestInput = transition?.latest_input;
  if (!latestInput || typeof latestInput !== "object" || Array.isArray(latestInput)) {
    return "";
  }
  const latest = latestInput as Record<string, unknown>;
  return latest.kind === "selected_option" && typeof latest.text === "string"
    ? latest.text
    : "";
}

function beatRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPlayerDecisionBeat(
  beat: Record<string, unknown>,
  playerIdentity: string,
): boolean {
  return normalizedIdentity(beat.actor) === playerIdentity
    && (beat.agency === "intentional" || beat.agency === "ambiguous");
}

function compactAutomaticBeat(
  beat: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const sourceReferencesExcerpt = typeof beat.sourceReferencesExcerpt === "string"
    ? beat.sourceReferencesExcerpt.trim()
    : "";
  return {
    index,
    actor: typeof beat.actor === "string" || beat.actor === null ? beat.actor : null,
    action: typeof beat.action === "string" ? beat.action : "",
    targets: Array.isArray(beat.targets)
      ? beat.targets.filter((value): value is string => typeof value === "string")
      : [],
    agency: beat.agency,
    stakes: beat.stakes,
    ...(sourceReferencesExcerpt ? { sourceReferencesExcerpt } : {}),
  };
}

function compactOpeningBoundarySection(input: string): string {
  const boundaryStart = input.indexOf(OPENING_BOUNDARY_MARKER);
  if (boundaryStart < 0) return input;
  const boundaryJsonStart = input.indexOf("{", boundaryStart + OPENING_BOUNDARY_MARKER.length);
  if (boundaryJsonStart < 0) return input;
  const boundaryJsonEnd = jsonObjectEnd(input, boundaryJsonStart);
  if (boundaryJsonEnd === null) return input;
  const perspectiveStart = input.indexOf(PLAYER_PERSPECTIVE_MARKER, boundaryJsonEnd);
  if (perspectiveStart < 0) return input;

  return input.slice(0, boundaryJsonEnd)
    + "\nThe boundary action is the next player decision. Leave it wholly unperformed and end with it immediately executable.\n\n"
    + input.slice(perspectiveStart);
}

export function withIsolatedSplitOpeningRequest(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (
    label !== "scene"
    || !request.input.includes("OPENING PRELUDE:")
    || !request.input.includes('"kind":"first_unselected_player_beat"')
  ) {
    return request;
  }

  let input = compactOpeningBoundarySection(request.input);
  const contextLocation = jsonObjectAfterMarker(input, GAME_CONTEXT_MARKER);
  if (contextLocation) {
    const context = { ...contextLocation.value };
    delete context.next_significant_event_progress;
    delete context.next_player_future_actions;
    delete context.opening_player_future_actions;
    delete context.opening_event_sequence;
    input = input.slice(0, contextLocation.start)
      + JSON.stringify(context, null, 2)
      + input.slice(contextLocation.end);
  }

  const conflictingInstructionFragments = [
    "next_significant_event_progress",
    "next_player_future_actions",
    "OPENING AUTOMATIC PREFIX",
  ];
  const instructions = request.instructions
    ?.split("\n")
    .filter((line) =>
      !conflictingInstructionFragments.some((fragment) => line.includes(fragment))
    )
    .join("\n");

  return {
    ...request,
    ...(instructions !== undefined ? { instructions } : {}),
    input,
  };
}

export function withAutomaticFollowupWindow(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene") return request;

  const selectedAction = selectedOptionText(request.input);
  if (!selectedAction) return request;

  const contextLocation = jsonObjectAfterMarker(request.input, GAME_CONTEXT_MARKER);
  if (!contextLocation) return request;
  const context = { ...contextLocation.value };
  const progressValue = context.next_significant_event_progress;
  if (!progressValue || typeof progressValue !== "object" || Array.isArray(progressValue)) {
    return request;
  }
  const progress = { ...(progressValue as Record<string, unknown>) };
  const nextBeat = beatRecord(progress.next_required_beat);
  const remaining = Array.isArray(progress.remaining_beats)
    ? progress.remaining_beats
    : [];
  if (!nextBeat || remaining.length < 2) return request;

  const playerIdentity = normalizedIdentity(context.player_identity);
  if (
    !playerIdentity
    || !isPlayerDecisionBeat(nextBeat, playerIdentity)
    || normalizedActionText(selectedAction) !== normalizedActionText(nextBeat.action)
  ) {
    return request;
  }

  const nextBeatOffset = remaining.findIndex((value) => {
    const beat = beatRecord(value);
    return Boolean(
      beat
      && normalizedIdentity(beat.actor) === normalizedIdentity(nextBeat.actor)
      && normalizedActionText(beat.action) === normalizedActionText(nextBeat.action),
    );
  });
  if (nextBeatOffset < 0) return request;

  const completedCount = Array.isArray(progress.completed_beat_indexes)
    ? progress.completed_beat_indexes.length
    : 0;
  const automaticFollowups: Record<string, unknown>[] = [];
  for (let offset = nextBeatOffset + 1; offset < remaining.length; offset += 1) {
    const beat = beatRecord(remaining[offset]);
    if (!beat || isPlayerDecisionBeat(beat, playerIdentity)) break;
    automaticFollowups.push(
      compactAutomaticBeat(beat, completedCount + offset),
    );
  }
  if (automaticFollowups.length === 0) return request;

  progress.automatic_followup_beats = automaticFollowups;
  context.next_significant_event_progress = progress;
  const input = request.input.slice(0, contextLocation.start)
    + JSON.stringify(context, null, 2)
    + request.input.slice(contextLocation.end);

  return {
    ...request,
    instructions: [
      request.instructions ?? "",
      "AUTOMATIC FOLLOW-UP WINDOW: latest_input selected next_significant_event_progress.next_required_beat. After resolving that selected player beat, visibly complete every beat in next_significant_event_progress.automatic_followup_beats in listed order in this same scene. Use each listed beat's sourceReferencesExcerpt as bounded evidence for that beat. These are immediate non-player beats, including intentional NPC actions, plus external or involuntary consequences; they require no extra player menu turn. Stop before the next intentional or ambiguous player-controlled beat. Never invent another voluntary player action to bridge the automatic follow-up window.",
    ].filter(Boolean).join("\n"),
    input,
  };
}

const INDIRECT_QUESTION_WORDS = new Set([
  "whether",
  "if",
  "how",
  "why",
  "what",
  "when",
  "where",
]);

function selectedSpeechActionMatchesBeat(
  input: Record<string, unknown>,
  playerAction: unknown,
  beatAction: unknown,
): boolean {
  const playerTokens = normalizedActionText(playerAction).split(" ").filter(Boolean);
  const beatTokens = normalizedActionText(beatAction).split(" ").filter(Boolean);
  if (playerTokens.join(" ") === beatTokens.join(" ")) return true;
  if (playerTokens.length < 2 || beatTokens.length < 2) return false;
  if (playerTokens[0] !== "ask" || beatTokens[0] !== "ask") return false;

  const playerQuestionIndex = playerTokens.findIndex((token) =>
    INDIRECT_QUESTION_WORDS.has(token)
  );
  const beatQuestionIndex = beatTokens.findIndex((token) =>
    INDIRECT_QUESTION_WORDS.has(token)
  );
  if (playerQuestionIndex < 1 || beatQuestionIndex !== 1) return false;
  if (
    playerTokens.slice(playerQuestionIndex).join(" ")
    !== beatTokens.slice(beatQuestionIndex).join(" ")
  ) {
    return false;
  }

  const playerIdentity = normalizedIdentity(input.player_identity);
  const profiles = Array.isArray(input.character_profiles) ? input.character_profiles : [];
  const knownNonPlayerNameTokens = new Set<string>();
  for (const profile of profiles) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) continue;
    const record = profile as Record<string, unknown>;
    const names = [record.name, ...(Array.isArray(record.aliases) ? record.aliases : [])];
    for (const name of names) {
      if (typeof name !== "string" || normalizedIdentity(name) === playerIdentity) continue;
      for (const token of normalizedActionText(name).split(" ").filter(Boolean)) {
        knownNonPlayerNameTokens.add(token);
      }
    }
  }

  const addresseeTokens = playerTokens.slice(1, playerQuestionIndex);
  return addresseeTokens.length > 0
    && addresseeTokens.every((token) =>
      token === "and" || knownNonPlayerNameTokens.has(token)
    );
}

export function withCanonicalSelectedPlayerBeatReview(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene presence review") return request;
  try {
    const input = JSON.parse(request.input) as Record<string, unknown>;
    const candidateScene = beatRecord(input.candidate_scene);
    const nextBeat = beatRecord(input.next_required_source_event_beat);
    if (!candidateScene || !nextBeat) return request;
    if (normalizedIdentity(nextBeat.actor) !== normalizedIdentity(input.player_identity)) {
      return request;
    }
    if (
      !selectedSpeechActionMatchesBeat(
        input,
        candidateScene.player_action,
        nextBeat.action,
      )
    ) {
      return request;
    }
    if (typeof nextBeat.action !== "string") return request;

    return {
      ...request,
      input: JSON.stringify({
        ...input,
        candidate_scene: {
          ...candidateScene,
          player_action: nextBeat.action,
        },
      }, null, 2),
    };
  } catch {
    return request;
  }
}

export function withSemanticAutomaticBeatReview(
  label: string,
  request: AiResponseRequest,
): AiResponseRequest {
  if (label !== "scene presence review") return request;
  return {
    ...request,
    instructions: [
      request.instructions ?? "",
      "AUTOMATIC BEAT SEMANTICS: assess involuntary and external source beats by their concrete physical outcome, not literal verb overlap. If candidate_scene visibly realizes the same forced movement, loss of balance, fall, impact, reflex, environmental motion, or other involuntary/external outcome, report that beat complete even when the prose uses natural synonyms or a more specific posture. Do not keep an automatic beat pending merely because its wording differs from the typed beat.",
    ].filter(Boolean).join("\n"),
  };
}

export function normalizeReviewerResponse(
  label: string,
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (response.status !== "completed" || !response.output_text.trim()) return response;
  const assessment = parsedObject(response.output_text);
  if (!assessment) return response;

  if (label === "scene repetition review") {
    const context = parsedObject(request.input);
    const recentPriorScenes = context?.recent_prior_scenes;
    const immediateTransition = context?.immediate_transition;
    if (
      Array.isArray(recentPriorScenes)
      && recentPriorScenes.length === 0
      && immediateTransition === null
    ) {
      const playerAgencyFailureReason = typeof assessment.playerAgencyFailureReason === "string"
        ? assessment.playerAgencyFailureReason
        : "";
      const invalidNoActionFailure = /no\b[^.]{0,80}\bplayer\b[^.]{0,80}\b(?:action|decision)\b/iu.test(
        playerAgencyFailureReason,
      );
      const normalized = {
        ...assessment,
        repeatsPriorScene: false,
        ...(invalidNoActionFailure
          ? {
              preservesPlayerAgency: true,
              playerAgencyFailureReason: "",
            }
          : {}),
      };
      return { ...response, output_text: JSON.stringify(normalized) };
    }
  }

  if (label === "scene presence review") {
    const input = parsedObject(request.input);
    if (input?.event_review_target_mode === "opening_progression") {
      const futurePlayerActions = Array.isArray(input.future_player_actions)
        ? input.future_player_actions
        : [];
      const firstFuturePlayerBeatIndex = futurePlayerActions
        .map((value) => beatRecord(value)?.beatIndex)
        .filter((value): value is number => Number.isInteger(value) && Number(value) >= 0)
        .map(Number)
        .sort((left, right) => left - right)[0];
      const previousCompleted = new Set(
        (Array.isArray(input.previous_completed_source_event_beat_indexes)
          ? input.previous_completed_source_event_beat_indexes
          : [])
          .filter((value): value is number => Number.isInteger(value) && Number(value) >= 0)
          .map(Number),
      );
      if (
        firstFuturePlayerBeatIndex !== undefined
        && firstFuturePlayerBeatIndex > 0
        && assessment.futureActionSetupRequired === true
        && assessment.futureActionSetupSupported === true
      ) {
        const reported = new Set(
          (Array.isArray(assessment.completedSourceEventBeatIndexes)
            ? assessment.completedSourceEventBeatIndexes
            : [])
            .filter((value): value is number => Number.isInteger(value) && Number(value) >= 0)
            .map(Number),
        );
        for (let index = 0; index < firstFuturePlayerBeatIndex; index += 1) {
          if (!previousCompleted.has(index)) reported.add(index);
        }
        return {
          ...response,
          output_text: JSON.stringify({
            ...assessment,
            completedSourceEventBeatIndexes: [...reported].sort((left, right) => left - right),
          }),
        };
      }
    }
  }

  if (label === "scene choice review") {
    const context = parsedObject(request.input);
    const candidateScene = beatRecord(context?.candidate_scene);
    const choices = Array.isArray(candidateScene?.choices) ? candidateScene.choices : [];
    const onlyChoice = beatRecord(choices[0]);
    if (
      choices.length === 1
      && onlyChoice?.type === "action"
      && onlyChoice.text === SOURCE_CONTINUATION_CHOICE_TEXT
    ) {
      return {
        ...response,
        output_text: JSON.stringify({
          ...assessment,
          unusableChoiceIndexes: [],
          unusableChoicesReason: "",
        }),
      };
    }
  }

  return response;
}

export function advanceCompletedSourceEventCandidates(
  state: GameState,
  candidates: readonly SourceContinuationCandidate[],
): SourceContinuationCandidate[] {
  const progress = state.sourceEventProgress;
  if (!progress?.eventId) return [...candidates];

  return candidates.map((candidate) => {
    if (candidate.requiredEventId !== progress.eventId) return candidate;
    const storyEvents = candidate.storyEvents ?? [];
    const currentIndex = storyEvents.findIndex(
      (event) => event.eventId === progress.eventId,
    );
    if (currentIndex < 0) return candidate;
    const currentEvent = storyEvents[currentIndex]!;
    const beats = currentEvent.beats ?? [];
    if (beats.length === 0) return candidate;
    const completed = new Set(progress.completedBeatIndexes);
    const fullyCompleted = beats.every((_beat, index) => index < (progress.startBeatIndex ?? 0) || completed.has(index));
    if (!fullyCompleted) return candidate;

    const nextEvent = storyEvents[currentIndex + 1];
    if (!nextEvent) return candidate;
    return {
      ...candidate,
      requiredEventId: nextEvent.eventId ?? undefined,
      requiredEvent: nextEvent.description,
      requiredEventCategory: nextEvent.category,
      requiredEventActors: nextEvent.actors,
      requiredEventTargets: nextEvent.targets,
      requiredEventBeats: nextEvent.beats,
    };
  });
}

export class PacedBookRpgProviderGameEngine extends BookRpgProviderGameEngine {
  override async continueFromSource(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<SourceContinuationResult | undefined> {
    return super.continueFromSource(
      state,
      advanceCompletedSourceEventCandidates(state, candidates),
    );
  }

  protected override async createResponse(
    label: string,
    bookId: string,
    request: AiResponseRequest,
  ): Promise<AiResponse> {
    let pacedRequest = withIsolatedSplitOpeningRequest(label, request);
    pacedRequest = withAutomaticFollowupWindow(label, pacedRequest);
    pacedRequest = withCanonicalSelectedPlayerBeatReview(label, pacedRequest);
    pacedRequest = withSemanticAutomaticBeatReview(label, pacedRequest);
    const response = await super.createResponse(label, bookId, pacedRequest);
    return normalizeReviewerResponse(label, pacedRequest, response);
  }
}
