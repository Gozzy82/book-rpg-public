import {reviewResumeAnchor} from './resume-anchor-review.js';
import {normalizeSceneDeaths, peopleKilledInSceneSchema, SCENE_DEATH_POLICY} from '../../shared/scene-deaths.js';
import {withIndependentFinalState, reviewIndependentEndState} from "./independent-end-state-review.js";
import { boundCharacterProfilePayload } from "./character-runtime.js";
import { withTurnReview, decodeTurnReview } from "./turn-review.js";
import { currentTurnBudget, currentTurnExecution, TurnExecutionError, turnContractInstructions } from "./turn-contract.js";
import { reducePresenceReview } from "./turn-validator.js";
import { withSharedStoryPolicy } from "./shared-policy.js";
import crypto from "node:crypto";
import { flowDiagnostic, traceEvent } from "../../util/flow-trace.js";
import {
  recordAiRetry,
  recordAiStepFailure,
  recordAiStepFinish,
  recordAiStepStart,
} from "../../util/live-log.js";
import type {
  GameState,
  Scene,
} from "../../shared/contracts.js";
import {
  lossReviewJsonSchema,
} from "../schema.js";
import {
  createAiClient,
} from "../provider.js";
import type {
  AiClient,
  AiReasoningEffort,
  AiResponse,
  AiResponseRequest,
} from "../provider.js";
import {
  InvalidAiJsonError,
  parseAiJson,
} from "./core.js";
import type {
  GeneratedScene,
  SourceContinuationCandidate,
} from "./core.js";
import {
  normalizeSceneTalkChoices,
} from "./dialogue.js";
import {
  CHOICE_STAKES_RULES,
  SCENE_SCOPE_RULES,
} from "./rules.js";
import {
  choiceParaphrasesConsumedAction,
  sceneScopeFailures,
  sceneScopeOrFallback,
} from "./scene-validation.js";
import {
  configuredReasoningEffort,
} from "./source.js";
import {
  buildImmediateTurnTransition,
} from "./turn.js";

const SCENE_PRESENCE_BEAT_PROGRESS_CORRECTION = [
  "For source beat progress, assess next_required_source_event_beat before evaluating future-action setup.",
  "previous_completed_source_event_beat_indexes is authoritative completed state. Return only additional indexes completed in candidate_scene; the application merges them with prior progress.",
  "When next_required_source_event_beat is present, explicitly compare its actor and action with candidate_scene.text and candidate_scene.player_action. Clear continuous movement into the named destination completes a continuation or travel beat.",
  "A source beat counts as completed when its action is visibly enacted anywhere in candidate_scene.text, even when the physical prerequisite existed only at the beginning of the scene or the end state later changes.",
  "In opening_progression mode there is no selected player menu action yet, so a meaningful player-controlled beat visibly enacted in candidate_scene.text still counts as completed. Do not keep such a beat future merely because candidate_scene.player_action is empty.",
  "In opening_progression mode, earlier ordered beats that are not visibly enacted must not be reported as completed, but their absence alone is not a reason to reject an otherwise source-grounded decision boundary. Judge whether the earliest future player action is immediately executable from the concrete opening end state and source excerpt.",
  "In opening_progression mode, future_player_actions are decision boundaries, not actions the opening must already perform. When the earliest future player beat is the current boundary, judge only whether its physical and social prerequisites are established; never require that player action itself to have been enacted, performed, or completed.",
  "In scene_completion mode, report any later ordered beat that is visibly enacted even when earlier ordered beats were not separately visible to this review. The application may infer the missing ordered prefix as completed only when one later reported beat makes that inference unambiguous; this inference never applies in opening_progression mode.",
  "Treat future_player_actions as provisional candidates derived from the pre-candidate progress state. After identifying beats completed in candidate_scene, ignore any matching completed action when deciding futureActionSetupRequired and evaluate setup only for the earliest meaningful player beat that remains incomplete.",
  "The end-state prerequisite check applies only to that earliest remaining future beat. Never reject a scene because the end state no longer preserves prerequisites for a beat that the same scene already visibly completed.",
  "If unfinished ordered beats still precede the earliest future player action, that player action is not the current decision boundary yet. Set futureActionSetupRequired false and let source-beat validation require the preceding beats first.",
  "In opening_progression mode, never report a later source beat as completed unless every earlier beat is already listed in previous_completed_source_event_beat_indexes or is also reported completed in this candidate scene.",
  "Example: if the candidate visibly shows the Scarecrow perched on the pole and then winking/nodding at Dorothy, report that wink/nod beat as completed. Then evaluate whether the scene end state supports the next remaining beat, such as asking Dorothy to remove the pole.",
].join("\n");

const SCENE_CHOICE_REVIEW_ANCHOR_CORRECTION = [
  "requiresExplicitPlayerChoice constrains anchor selection only. It does not make otherwise executable non-anchor alternatives unusable.",
  "Never put a choice in unusableChoiceIndexes merely because it does not perform REQUIRED PLAYER CHOICE BEATS, does not advance CHOICE NAVIGATION EVENT, or is not suitable as anchorChoiceIndex.",
  "A local alternative may remain usable even when it is not the source anchor. In particular, 'Talk to <character>' is usable when that character is confirmed in candidate_scene.sceneScope.peopleWithinSpeakingDistance; lack of source-anchor progress is not a contradiction.",
  "When CURRENT SIGNIFICANT EVENT is null because CHOICE NAVIGATION EVENT is the partially completed current event, use SOURCE EVENT BEAT PROGRESS to distinguish completed beats from remaining beats. Do not treat the whole navigation event as completed.",
  "Never choose a later REQUIRED PLAYER CHOICE BEAT as the anchor while an earlier listed player beat is still unresolved. A later beat may remain a local alternate, but source-anchor ordering must preserve the earliest remaining player decision.",
].join("\n");

const CHOICE_NAVIGATION_EVENT_MARKER = "\n\nCHOICE NAVIGATION EVENT:\n\n";
const CURRENT_SIGNIFICANT_EVENT_MARKER = "\n\nCURRENT SIGNIFICANT EVENT:\n\n";
const SOURCE_EVENT_BEAT_PROGRESS_MARKER = "\n\nSOURCE EVENT BEAT PROGRESS:\n\n";
const REQUIRED_PLAYER_CHOICE_BEATS_MARKER = "\n\nREQUIRED PLAYER CHOICE BEATS:\n\n";
const UPCOMING_SOURCE_ANCHOR_MATERIAL_MARKER =
  "\n\nUPCOMING SOURCE ANCHOR MATERIAL:\n\n";

interface ScenePresenceReviewInput {
  event_review_target?: {
    eventId?: string;
    beats?: unknown[];
  } | null;
  event_review_target_mode?: "scene_completion" | "opening_progression";
  previous_completed_source_event_beat_indexes?: number[];
  future_player_actions?: Array<{ beatIndex?: number }>;
}

interface ScenePresenceReviewOutput {
  latestVisibleSourceEventId?: string | null;
  completedSourceEventBeatIndexes?: number[];
  futureActionSetupRequired?: boolean;
  futureActionSetupSupported?: boolean;
  futureActionSetupReason?: string;
  [key: string]: unknown;
}

interface SceneChoiceReviewInputContext {
  candidate_scene?: {
    choices?: Array<{
      type?: string;
      text?: string;
      character?: string | null;
    }>;
    sceneScope?: {
      peopleWithinSpeakingDistance?: string[];
    } | null;
  };
}

interface SceneChoiceReviewOutput {
  anchorChoiceIndex?: number | null;
  unusableChoiceIndexes?: number[];
  unusableChoicesReason?: string;
  reason?: string;
  [key: string]: unknown;
}

interface RequiredPlayerChoiceBeat {
  action?: string;
}

function normalizedChoiceIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function withSceneChoiceReviewCorrectionInstructions(
  request: AiResponseRequest,
): AiResponseRequest {
  return {
    ...request,
    instructions: [
      request.instructions,
      SCENE_CHOICE_REVIEW_ANCHOR_CORRECTION,
    ].filter(Boolean).join("\n"),
  };
}

function requiredPlayerChoiceBeatsFromReviewRequest(
  request: AiResponseRequest,
): RequiredPlayerChoiceBeat[] {
  const requiredMarkerIndex = request.input.indexOf(
    REQUIRED_PLAYER_CHOICE_BEATS_MARKER,
  );
  if (requiredMarkerIndex < 0) return [];
  const upcomingMarkerIndex = request.input.indexOf(
    UPCOMING_SOURCE_ANCHOR_MATERIAL_MARKER,
    requiredMarkerIndex + REQUIRED_PLAYER_CHOICE_BEATS_MARKER.length,
  );
  if (upcomingMarkerIndex < 0) return [];
  try {
    const parsed = JSON.parse(
      request.input.slice(
        requiredMarkerIndex + REQUIRED_PLAYER_CHOICE_BEATS_MARKER.length,
        upcomingMarkerIndex,
      ),
    );
    return Array.isArray(parsed) ? parsed as RequiredPlayerChoiceBeat[] : [];
  } catch {
    return [];
  }
}

export function correctPartialSceneChoiceReviewState(
  request: AiResponseRequest,
): AiResponseRequest {
  const correctedRequest = withSceneChoiceReviewCorrectionInstructions(request);
  const input = correctedRequest.input;
  const navigationMarkerIndex = input.indexOf(CHOICE_NAVIGATION_EVENT_MARKER);
  const currentMarkerIndex = input.indexOf(
    CURRENT_SIGNIFICANT_EVENT_MARKER,
    navigationMarkerIndex + CHOICE_NAVIGATION_EVENT_MARKER.length,
  );
  const progressMarkerIndex = input.indexOf(
    SOURCE_EVENT_BEAT_PROGRESS_MARKER,
    currentMarkerIndex + CURRENT_SIGNIFICANT_EVENT_MARKER.length,
  );
  const requiredBeatsMarkerIndex = input.indexOf(
    REQUIRED_PLAYER_CHOICE_BEATS_MARKER,
    progressMarkerIndex + SOURCE_EVENT_BEAT_PROGRESS_MARKER.length,
  );
  if (
    navigationMarkerIndex < 0
    || currentMarkerIndex < 0
    || progressMarkerIndex < 0
    || requiredBeatsMarkerIndex < 0
  ) {
    return correctedRequest;
  }

  try {
    const navigationEvent = JSON.parse(
      input.slice(
        navigationMarkerIndex + CHOICE_NAVIGATION_EVENT_MARKER.length,
        currentMarkerIndex,
      ),
    ) as { eventId?: string | null } | null;
    const currentEvent = JSON.parse(
      input.slice(
        currentMarkerIndex + CURRENT_SIGNIFICANT_EVENT_MARKER.length,
        progressMarkerIndex,
      ),
    ) as { eventId?: string | null } | null;
    const beatProgress = JSON.parse(
      input.slice(
        progressMarkerIndex + SOURCE_EVENT_BEAT_PROGRESS_MARKER.length,
        requiredBeatsMarkerIndex,
      ),
    ) as {
      eventId?: string | null;
      nextRequiredBeat?: unknown;
      remainingBeats?: unknown[];
    } | null;
    const sameEvent = Boolean(
      navigationEvent?.eventId
      && currentEvent?.eventId === navigationEvent.eventId
      && beatProgress?.eventId === navigationEvent.eventId,
    );
    const eventStillInProgress = Boolean(
      beatProgress?.nextRequiredBeat
      || (beatProgress?.remainingBeats?.length ?? 0) > 0,
    );
    if (!sameEvent || !eventStillInProgress) return correctedRequest;

    const currentJsonStart =
      currentMarkerIndex + CURRENT_SIGNIFICANT_EVENT_MARKER.length;
    return {
      ...correctedRequest,
      input: input.slice(0, currentJsonStart)
        + "null"
        + input.slice(progressMarkerIndex),
    };
  } catch {
    return correctedRequest;
  }
}

export function correctSceneChoiceReviewBeatOrder(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (response.status === "incomplete" || !response.output_text.trim()) return response;
  const markerIndex = request.input.indexOf(CHOICE_NAVIGATION_EVENT_MARKER);
  if (markerIndex < 0) return response;

  try {
    const context = JSON.parse(
      request.input.slice(0, markerIndex),
    ) as SceneChoiceReviewInputContext;
    const review = JSON.parse(response.output_text) as SceneChoiceReviewOutput;
    if (!Number.isInteger(review.anchorChoiceIndex)) return response;
    const choices = context.candidate_scene?.choices ?? [];
    const anchorIndex = review.anchorChoiceIndex as number;
    const anchorText = choices[anchorIndex]?.text?.trim();
    if (!anchorText) return response;

    const requiredBeats = requiredPlayerChoiceBeatsFromReviewRequest(request)
      .filter((beat) => Boolean(beat.action?.trim()));
    if (requiredBeats.length < 2) return response;
    const earliestAction = requiredBeats[0]!.action!;
    if (choiceParaphrasesConsumedAction(anchorText, earliestAction)) return response;
    const matchesLaterBeat = requiredBeats.slice(1).some((beat) =>
      choiceParaphrasesConsumedAction(anchorText, beat.action!)
    );
    if (!matchesLaterBeat) return response;

    const unusableIndexes = new Set(
      Array.isArray(review.unusableChoiceIndexes)
        ? review.unusableChoiceIndexes.filter(Number.isInteger)
        : [],
    );
    const earliestChoiceIndex = choices.findIndex((choice, index) =>
      index !== anchorIndex
      && !unusableIndexes.has(index)
      && Boolean(
        choice.text
        && choiceParaphrasesConsumedAction(choice.text, earliestAction),
      )
    );
    return {
      ...response,
      output_text: JSON.stringify({
        ...review,
        anchorChoiceIndex: earliestChoiceIndex >= 0 ? earliestChoiceIndex : null,
        reason: earliestChoiceIndex >= 0
          ? "The reviewer selected a later source player beat; the anchor was corrected to the earliest remaining player decision."
          : "The reviewer selected a later source player beat while the earliest player decision is still unresolved, so no source anchor is accepted from this menu.",
      }),
    };
  } catch {
    return response;
  }
}

export function correctSceneChoiceReviewAlternatives(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (response.status === "incomplete" || !response.output_text.trim()) return response;
  const markerIndex = request.input.indexOf(CHOICE_NAVIGATION_EVENT_MARKER);
  if (markerIndex < 0) return response;

  try {
    const context = JSON.parse(
      request.input.slice(0, markerIndex),
    ) as SceneChoiceReviewInputContext;
    const review = JSON.parse(response.output_text) as SceneChoiceReviewOutput;
    if (!Array.isArray(review.unusableChoiceIndexes)) return response;
    const choices = context.candidate_scene?.choices ?? [];
    const speaking = new Set(
      (context.candidate_scene?.sceneScope?.peopleWithinSpeakingDistance ?? [])
        .map(normalizedChoiceIdentity),
    );
    const preservedTalkIndexes = new Set(
      choices.flatMap((choice, index) =>
        choice.type === "talk"
        && choice.character
        && speaking.has(normalizedChoiceIdentity(choice.character))
          ? [index]
          : []
      ),
    );
    const unusableChoiceIndexes = review.unusableChoiceIndexes.filter(
      (index) => !preservedTalkIndexes.has(index),
    );
    if (unusableChoiceIndexes.length === review.unusableChoiceIndexes.length) {
      return response;
    }

    return {
      ...response,
      output_text: JSON.stringify({
        ...review,
        unusableChoiceIndexes,
        ...(unusableChoiceIndexes.length === 0
          ? { unusableChoicesReason: "" }
          : {}),
      }),
    };
  } catch {
    return response;
  }
}

export function correctScenePresenceBeatOrder(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (response.status === "incomplete" || !response.output_text.trim()) return response;

  try {
    const input = JSON.parse(request.input) as ScenePresenceReviewInput;
    const review = JSON.parse(response.output_text) as ScenePresenceReviewOutput;
    if (!Array.isArray(review.completedSourceEventBeatIndexes)) return response;
    const beatCount = input.event_review_target?.beats?.length ?? 0;
    if (beatCount <= 0) return response;

    const openingProgression = input.event_review_target_mode === "opening_progression";
    const previousIndexes = new Set(
      (input.previous_completed_source_event_beat_indexes ?? [])
        .filter((index) => Number.isInteger(index) && index >= 0 && index < beatCount),
    );
    const reportedIndexes = new Set(
      review.completedSourceEventBeatIndexes
        .filter((index) => Number.isInteger(index) && index >= 0 && index < beatCount),
    );
    const inferredReportedIndexes = new Set(reportedIndexes);
    if (!openingProgression && inferredReportedIndexes.size === 1) {
      const latestReportedIndex = Math.max(...inferredReportedIndexes);
      for (let index = 0; index <= latestReportedIndex; index += 1) {
        inferredReportedIndexes.add(index);
      }
    }

    const combinedIndexes = new Set([...previousIndexes, ...inferredReportedIndexes]);
    let contiguousLength = 0;
    while (contiguousLength < beatCount && combinedIndexes.has(contiguousLength)) {
      contiguousLength += 1;
    }
    const acceptedAdditionalIndexes = [...inferredReportedIndexes]
      .filter((index) => index < contiguousLength && !previousIndexes.has(index))
      .sort((left, right) => left - right);
    const originalAdditionalIndexes = [...reportedIndexes].sort((left, right) => left - right);
    const progressChanged =
      acceptedAdditionalIndexes.length !== originalAdditionalIndexes.length
      || acceptedAdditionalIndexes.some(
        (index, position) => index !== originalAdditionalIndexes[position],
      );
    const targetEventId = input.event_review_target?.eventId;
    const claimedIncompleteTarget = Boolean(
      targetEventId
      && review.latestVisibleSourceEventId === targetEventId
      && contiguousLength < beatCount,
    );
    const futureActionIndexes = [...new Set(
      (input.future_player_actions ?? [])
        .map((action) => action.beatIndex)
        .filter((index): index is number =>
          Number.isInteger(index) && index >= 0 && index < beatCount
        ),
    )].sort((left, right) => left - right);
    const earliestFutureActionIndex = futureActionIndexes.find(
      (index) => index >= contiguousLength,
    );
    const openingMissingOrderedBeatsBeforeFutureAction = Boolean(
      openingProgression
      && earliestFutureActionIndex !== undefined
      && contiguousLength < earliestFutureActionIndex
    );
    const futureActionBlockedByEarlierBeat = Boolean(
      !openingProgression
      && earliestFutureActionIndex !== undefined
      && contiguousLength < earliestFutureActionIndex
      && review.futureActionSetupRequired === true,
    );
    const openingBoundaryMistakenForCompletion = Boolean(
      openingProgression
      && !openingMissingOrderedBeatsBeforeFutureAction
      && earliestFutureActionIndex !== undefined
      && contiguousLength === earliestFutureActionIndex
      && review.futureActionSetupRequired === true
      && review.futureActionSetupSupported === false
      && /(?:not|has not|hasn't|isn't|is not).{0,80}(?:enacted|performed|completed|occurred)/i.test(
        review.futureActionSetupReason ?? "",
      )
    );
    if (
      !progressChanged
      && !claimedIncompleteTarget
      && !openingMissingOrderedBeatsBeforeFutureAction
      && !futureActionBlockedByEarlierBeat
      && !openingBoundaryMistakenForCompletion
    ) {
      return response;
    }

    const missingOpeningEnd = earliestFutureActionIndex === undefined
      ? contiguousLength
      : earliestFutureActionIndex - 1;
    return {
      ...response,
      output_text: JSON.stringify({
        ...review,
        completedSourceEventBeatIndexes: acceptedAdditionalIndexes,
        ...(claimedIncompleteTarget ? { latestVisibleSourceEventId: null } : {}),
        ...(openingMissingOrderedBeatsBeforeFutureAction
          ? {
              futureActionSetupRequired: false,
              futureActionSetupSupported: false,
              futureActionSetupReason:
                `The opening is still missing ordered source beats ${contiguousLength}-${missingOpeningEnd} before the future player decision can become the current boundary.`,
            }
          : {}),
        ...(futureActionBlockedByEarlierBeat
          ? {
              futureActionSetupRequired: false,
              futureActionSetupSupported: true,
              futureActionSetupReason:
                "Earlier ordered source beats still precede the future player action, so its end-state prerequisites are not part of the current decision boundary yet.",
            }
          : {}),
        ...(openingBoundaryMistakenForCompletion
          ? {
              futureActionSetupRequired: true,
              futureActionSetupSupported: true,
              futureActionSetupReason:
                "The earliest future player beat is the opening decision boundary. It must be executable from the established scene, but it must not already be enacted before the player chooses it.",
            }
          : {}),
      }),
    };
  } catch {
    return response;
  }
}

export function correctStaleScenePresenceSetup(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (response.status === "incomplete" || !response.output_text.trim()) return response;

  try {
    const input = JSON.parse(request.input) as ScenePresenceReviewInput;
    const review = JSON.parse(response.output_text) as ScenePresenceReviewOutput;
    if (
      review.futureActionSetupRequired !== true
      || review.futureActionSetupSupported !== false
    ) {
      return response;
    }

    const completedBeatIndexes = new Set(
      Array.isArray(review.completedSourceEventBeatIndexes)
        ? review.completedSourceEventBeatIndexes.filter(Number.isInteger)
        : [],
    );
    const futureActions = input.future_player_actions?.filter(
      (action) => Number.isInteger(action.beatIndex),
    ) ?? [];
    const reviewedTargetCompleted = Boolean(
      input.event_review_target?.eventId
      && review.latestVisibleSourceEventId === input.event_review_target.eventId,
    );
    const reviewedFutureBeatsCompleted = futureActions.length > 0
      && futureActions.every((action) => completedBeatIndexes.has(action.beatIndex!));

    if (!reviewedTargetCompleted && !reviewedFutureBeatsCompleted) {
      return response;
    }

    return {
      ...response,
      output_text: JSON.stringify({
        ...review,
        futureActionSetupRequired: false,
        futureActionSetupSupported: true,
        futureActionSetupReason:
          "The reviewed event or all its future player beats completed, so their old end-state prerequisites no longer apply.",
      }),
    };
  } catch {
    return response;
  }
}

export abstract class ProviderEngineBase {
  async reviewResumeAnchor(state: GameState, anchor: import('../../shared/contracts.js').GameChoice) {
    return reviewResumeAnchor(state,anchor,this.model,
      request=>this.createResponse('saved anchor review',state.book.bookId,request));
  }

  /** One-time migration for saves predating structured scene death metadata. */
  async assessEstablishedDeaths(state: GameState): Promise<string[]> {
    const response = await this.createResponse('saved game death assessment', state.book.bookId, {
      model: this.model, reasoning: {effort:'low'}, max_output_tokens: 1600,
      instructions: SCENE_DEATH_POLICY + '\nAssess actual deaths already established in this saved game. Use accepted history, scene and memory only; no future index or book knowledge. Here peopleKilledInScene contains all confirmed deaths in the supplied saved state, not only the last turn. Do not treat a quest demanding proof of death as evidence that the character has died. Return exact known profile names; omit uncertain cases.',
      input: JSON.stringify({characters:state.characterProfiles?.map(p=>({name:p.name,aliases:p.aliases})),
        scene:state.scene.text, memory:state.storyMemory, establishedEvent:state.establishedEvent,
        history:state.history.filter(h=>h.kind==='scene').map(h=>h.text)}),
      text:{format:{type:'json_schema',name:'bookrpg_saved_deaths',strict:true,schema:{
        type:'object',additionalProperties:false,properties:{peopleKilledInScene:peopleKilledInSceneSchema},required:['peopleKilledInScene'],
      }}},
    });
    if(response.status!=='completed') throw new Error('Incomplete saved game death assessment.');
    const result=JSON.parse(response.output_text);
    if(!Array.isArray(result.peopleKilledInScene)) throw new Error('Invalid saved game death assessment.');
    return normalizeSceneDeaths(result.peopleKilledInScene,state.characterProfiles);
  }

  abstract selectSourceCandidate(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<SourceContinuationCandidate | undefined>;

  abstract selectSourceEvent(
    state: GameState,
    candidate: SourceContinuationCandidate,
  ): Promise<SourceContinuationCandidate | undefined>;

  protected readonly model: string;
  protected readonly centralReviewValidation: boolean = false;

  protected readonly reasoningEffort: AiReasoningEffort;

  constructor(
    protected readonly client: AiClient = createAiClient(),
    reasoningEffort: AiReasoningEffort = configuredReasoningEffort(),
  ) {
    this.model = client.model;
    this.reasoningEffort = reasoningEffort;
  }

  protected async anchorRouteCandidates(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
    sourceEventId?: string,
  ): Promise<readonly SourceContinuationCandidate[]> {
    if (candidates.length === 0) return [];
    const targetCandidate = sourceEventId
      ? candidates.find((candidate) =>
          candidate.storyEvents?.some((event) => event.eventId === sourceEventId)
        )
      : undefined;
    const candidate = targetCandidate ?? (
      candidates.length === 1
        ? candidates[0]
        : await this.selectSourceCandidate(state, candidates)
    );
    if (!candidate) return [];
    const targetEvent = sourceEventId
      ? candidate.storyEvents?.find((event) => event.eventId === sourceEventId)
      : undefined;
    const candidateAlreadyTargetsEvent = !sourceEventId
      || candidate.requiredEventId === sourceEventId;
    const eventCandidate = candidate.requiredEvent?.trim()
      && candidateAlreadyTargetsEvent
      ? candidate
      : await this.selectSourceEvent(
          state,
          targetEvent ? { ...candidate, storyEvents: [targetEvent] } : candidate,
        );
    if (!eventCandidate) return [candidate];
    return [eventCandidate];
  }

  /** Isolated staged generation: exact inputs, but shared budget and full request/response traces. */
  protected async createCanonicalSceneResponse(label: string, bookId: string, request: AiResponseRequest): Promise<AiResponse> {
    const traced = {...request, prompt_cache_key: `bookrpg:${bookId}`};
    currentTurnBudget()?.reserve(traced.max_output_tokens ?? 2000);
    const call = {callId: crypto.randomUUID(), label, bookId, provider: this.client.provider, model: traced.model};
    const start = performance.now();
    recordAiStepStart(label);
    flowDiagnostic(`${this.client.provider} ${label}...`);
    traceEvent('ai.request', {...call, request: traced});
    let succeeded = false;
    try {
      const response = await this.client.createResponse(traced);
      succeeded = true;
      traceEvent('ai.response', {...call, response});
      return response;
    } catch (error) {
      recordAiStepFailure(label);
      traceEvent('ai.error', {...call, error});
      throw error;
    } finally {
      if (succeeded) recordAiStepFinish(label, performance.now() - start);
      flowDiagnostic(`${this.client.provider} ${label} finished in ${((performance.now()-start)/1000).toFixed(1)}s.`);
    }
  }

  protected async createResponse(
    label: string,
    bookId: string,
    request: AiResponseRequest,
  ) {
    const startedAt = performance.now();
    recordAiStepStart(label);
    flowDiagnostic(`${this.client.provider} ${label}...`);
    const effectiveRequest = !this.centralReviewValidation && label === "scene presence review"
      ? {
          ...request,
          instructions: [
            request.instructions,
            SCENE_PRESENCE_BEAT_PROGRESS_CORRECTION,
          ].filter(Boolean).join("\n"),
        }
      : label === "scene choice review"
        ? correctPartialSceneChoiceReviewState(request)
        : request;
    const scope = this.centralReviewValidation ? currentTurnExecution() : undefined;
    const contract = this.centralReviewValidation && label !== "turn intent review" ? request.turnContract ?? scope?.contract : undefined;
    const reviewRequest = contract ? withTurnReview(label, effectiveRequest, contract) : effectiveRequest;
    const { turnContract: _internalContract, ...providerRequest } = withSharedStoryPolicy(label, contract && label === "scene presence review" ? withIndependentFinalState(reviewRequest) : reviewRequest);
    const characterRuntime = contract ? JSON.parse(contract.contextJson).character_runtime : undefined;
    const tracedRequest = { ...providerRequest, ...(characterRuntime ? {input: boundCharacterProfilePayload(providerRequest.input, characterRuntime)} : {}), prompt_cache_key: `bookrpg:${bookId}`,
      ...(contract ? { instructions: [providerRequest.instructions, turnContractInstructions(contract, label !== "scene presence review")].filter(Boolean).join("\n") } : {}),
    };
    if (this.centralReviewValidation) currentTurnBudget()?.reserve(tracedRequest.max_output_tokens ?? 2_000);
    const callId = crypto.randomUUID();
    const call = { callId, label, bookId, provider: this.client.provider, model: tracedRequest.model };
    traceEvent("ai.request", { ...call, request: tracedRequest });
    let succeeded = false;
    try {
      let response = await this.client.createResponse(tracedRequest);
      traceEvent("ai.response", { ...call, response });
      if (this.centralReviewValidation) {
        let decoded;
        try {
          decoded = decodeTurnReview(label, tracedRequest, response);
        } catch (error) {
          if (!(error instanceof TurnExecutionError) || error.code !== "review_unavailable") throw error;
          // Retry only the assessment, with the same candidate and authorization.
          recordAiRetry(label);
          const retryRequest = {...tracedRequest, instructions: `${tracedRequest.instructions}\nEvidence correction: ${error.message} ${label === "scene presence review" ? "Select evidence_sentence_ids only from candidate_sentences; do not return source quotations." : "Copy supporting quotes exactly from candidate_scene.text."} Return the full assessment.`};
          currentTurnBudget()?.reserve(retryRequest.max_output_tokens ?? 2_000);
          const retryCall = {...call, callId: crypto.randomUUID(), retryOf: callId};
          traceEvent("ai.request", {...retryCall, request: retryRequest});
          response = await this.client.createResponse(retryRequest);
          traceEvent("ai.response", {...retryCall, response});
          decoded = decodeTurnReview(label, retryRequest, response);
        }
        if (label === "scene presence review" && contract) {
          const candidateText = JSON.parse(tracedRequest.input).candidate_scene?.text ?? "";
          decoded = await reviewIndependentEndState(contract, decoded, candidateText, tracedRequest.model, async (stage, stageRequest) => {
            // Deliberately bypass story-policy/contract transforms: the observer must
            // never receive the expected state or book knowledge from the engine.
            currentTurnBudget()?.reserve(stageRequest.max_output_tokens ?? 2_000);
            const stageCall = {...call, callId: crypto.randomUUID(), label: stage};
            recordAiStepStart(stage);
            flowDiagnostic(`${this.client.provider} ${stage}...`);
            const stageStarted = performance.now();
            traceEvent("ai.request", {...stageCall, request: stageRequest});
            let stageSucceeded = false;
            try {
              const result = await this.client.createResponse(stageRequest);
              stageSucceeded = true;
              traceEvent("ai.response", {...stageCall, response: result});
              return result;
            } catch (error) {
              recordAiStepFailure(stage);
              traceEvent("ai.error", {...stageCall, error});
              throw error;
            } finally {
              if (stageSucceeded) recordAiStepFinish(stage, performance.now() - stageStarted);
              flowDiagnostic(`${this.client.provider} ${stage} finished in ${((performance.now()-stageStarted)/1000).toFixed(1)}s.`);
            }
          });
        }
        const reviewed = label === "scene presence review" && contract
          ? reducePresenceReview(contract, decoded) : decoded;
        succeeded = true;
        traceEvent("ai.effective_response", { ...call, contract, response: reviewed });
        return reviewed;
      }
      if (label === "scene presence review") {
        const beatOrdered = correctScenePresenceBeatOrder(effectiveRequest, response);
        const corrected = correctStaleScenePresenceSetup(effectiveRequest, beatOrdered);
        succeeded = true;
        traceEvent("ai.effective_response", { ...call, response: corrected });
        return corrected;
      }
      if (label === "scene choice review") {
        const beatOrdered = correctSceneChoiceReviewBeatOrder(effectiveRequest, response);
        const corrected = correctSceneChoiceReviewAlternatives(effectiveRequest, beatOrdered);
        succeeded = true;
        traceEvent("ai.effective_response", { ...call, response: corrected });
        return corrected;
      }
      succeeded = true;
      return response;
    } catch (error) {
      recordAiStepFailure(label);
      traceEvent("ai.error", { ...call, error });
      throw error;
    } finally {
      if (succeeded) recordAiStepFinish(label, performance.now() - startedAt);
      const durationSeconds = ((performance.now() - startedAt) / 1_000).toFixed(1);
      flowDiagnostic(`${this.client.provider} ${label} finished in ${durationSeconds}s.`);
    }
  }

  protected async sceneEventAlignment<T>(
    bookId: string,
    request: AiResponseRequest,
  ): Promise<T | undefined> {
    const outputTokenAttempts = [400, 800] as const;
    let lastFailure = "no response";
    for (const maxOutputTokens of outputTokenAttempts) {
      const response = await this.createResponse("scene event alignment", bookId, {
        ...request,
        max_output_tokens: maxOutputTokens,
      });
      if (response.status === "incomplete") {
        const details = JSON.stringify(response.incomplete_details) ?? "no details";
        if (!details.includes("max_output_tokens")) {
          throw new Error(`AI scene event alignment returned an incomplete response: ${details}`);
        }
        lastFailure = `incomplete response: ${details}`;
        continue;
      }

      try {
        return parseAiJson<T>(
          response.output_text,
          "OpenAI scene event alignment",
        );
      } catch (error) {
        if (!(error instanceof InvalidAiJsonError)) throw error;
        lastFailure = error.message;
      }
    }
    flowDiagnostic(
      `OpenAI scene event alignment unavailable after ${outputTokenAttempts.length} attempts; `
      + `keeping the confirmed source cursor. Last failure: ${lastFailure}`,
    );
    return undefined;
  }

  async reviewLoss(state: GameState, lossScene: Scene): Promise<GeneratedScene> {
    const response = await this.createResponse(
      "loss avoidability review",
      state.book.bookId,
      {
        model: this.model,
        reasoning: { effort: "low" },
        instructions: [
          "You are the final loss adjudicator for BookRPG. Perform exactly one review.",
          "Decide whether the proposed loss is unavoidable given the established game state, latest input, player capabilities, and immediate causal consequences.",
          "A loss is avoidable only when a plausible continuation can preserve all established facts and the latest input without undoing a completed death, inventing immunity, changing player identity, or granting unearned success.",
          "Technical scene-generation failure is not itself an in-world cause of death. Treat it as avoidable when you can provide a continuity-safe scene that resolves the latest input.",
          "If the loss is unavoidable, set avoidable false, continuation null, and clearly explain why the objective cannot continue.",
          "If the loss is avoidable, set avoidable true and provide one replacement continuation with outcome active, 2 to 4 meaningful choices, and a clear account of how the player survives or the objective remains possible.",
          "The replacement must continue from the current scene and latest input. Do not replay the prior scene, erase consequences, or add a second voluntary player action.",
          "A talk choice must only say 'Talk to <character>'; actual utterances are generated separately.",
          "Offer at most one talk choice per target character.",
          ...SCENE_SCOPE_RULES,
          ...CHOICE_STAKES_RULES,
        ].join("\n"),
        input: JSON.stringify({
          player_identity: state.playerName,
          runtime_parameters: state.parameters ?? [],
          objective: state.objective,
          victoryCondition: state.victoryCondition,
          immediate_transition: buildImmediateTurnTransition(state) ?? null,
          current_scene: state.scene,
          proposed_loss: lossScene,
        }, null, 2),
        text: {
          format: {
            type: "json_schema",
            name: "bookrpg_loss_review",
            strict: true,
            schema: lossReviewJsonSchema,
          },
        },
        max_output_tokens: 1_600,
      },
    );
    const review = parseAiJson<{
      avoidable: boolean;
      reason: string;
      continuation: Scene | null;
    }>(response.output_text, "AI loss avoidability review");
    const reason = review.reason.trim();
    if (!reason) {
      throw new Error("AI loss review did not explain its decision");
    }
    if (!review.avoidable) {
      if (review.continuation !== null) {
        throw new Error("AI loss review returned a continuation for an unavoidable loss");
      }
      return {
        ...lossScene,
        outcomeReason: `Why you lost: ${reason}`,
      };
    }
    const continuation = review.continuation
      ? {
          ...review.continuation,
          sceneScope: sceneScopeOrFallback(
            review.continuation.sceneScope,
            lossScene.sceneScope ?? state.scene.sceneScope,
          ),
        }
      : null;
    if (
      !continuation
      || continuation.outcome !== "active"
      || continuation.choices.length < 2
      || continuation.choices.length > 4
      || sceneScopeFailures(continuation.sceneScope).length > 0
    ) {
      throw new Error("AI loss review did not provide a valid active continuation");
    }
    return normalizeSceneTalkChoices(continuation);
  }
}


