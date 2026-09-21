import {SCENE_DEATH_POLICY} from '../../shared/scene-deaths.js';
import { SOURCE_CONTINUATION_CHOICE_ID } from "../../shared/contracts.js";
import { spokenDialogueCapabilityFailure } from "../../shared/character-dynamics.js";
import { currentTurnExecution, planTurn } from "./turn-contract.js";
import { flowDiagnostic } from "../../util/flow-trace.js";
import type {
  GameState,
  Scene,
  SceneScope,
} from "../../shared/contracts.js";
import {
  sceneChoiceReviewJsonSchema,
  sceneChoiceMenuJsonSchema,
  scenePresenceReviewJsonSchema,
  sceneRepetitionReviewJsonSchema,
} from "../schema.js";
import type {
  AiResponseRequest,
} from "../provider.js";
import {
  InvalidAiJsonError,
  parseAiJson,
} from "./core.js";
import type {
  SourceContinuationCandidate,
} from "./core.js";
import {
  findPlayerCharacterProfile,
} from "./player.js";
import {
  ProviderEngineBase,
} from "./provider-engine-base.js";
import {
  PLAYER_EMBODIMENT_RULES,
  INFORMED_PLAYER_CHOICE_RULES,
  CHOICE_STAKES_RULES,
  CHOICE_TIMELINE_RULES,
  SOURCE_RECOUNTING_RULES,
} from "./rules.js";
import {
  normalizeIndependentReviewFailures,
  SCENE_CHOICE_REVIEW_OUTPUT_TOKENS,
  SCENE_REPETITION_REVIEW_OUTPUT_TOKENS,
  SCENE_PRESENCE_REVIEW_OUTPUT_TOKENS,
  buildSceneChoiceReviewContext,
  buildSceneRepetitionReviewContext,
} from "./scene-context.js";
import type {
  CompletedSceneAction,
  ChoiceRejectionFeedback,
  DialogueSceneReviewContext,
  SceneChoiceReview,
  SceneRepetitionReview,
  ScenePresenceReview,
} from "./scene-context.js";
import {
  removeDuplicateChoices,
  removeRecentChoiceParaphrases,
  removeConsumedActionChoices,
  removeChoicesRepeatingCompletedSourceEvent,
  hasTooFewChoicesForActiveScene,
  sourceContinuationChoiceText,
  addSourceContinuationChoiceFallback,
  addSourceContinuationAnchorChoice,
  firstChoiceWasFiltered,
  promoteAnchorChoice,
  removeChoicesWithPlayerIdentityReferences,
  repairGeneratedChoices,
  removeChoicesWithUnintroducedCharacters,
} from "./scene-validation.js";
import {
  visibleSourceEventNarrative,
  sourceEventCanOccurWithoutPlayerChoice,
  sourceEventPlayerChoiceBeats,
  sourceEventNextPlayerChoiceBeats,
  sourceEventHasReadyPlayerChoice,
  buildRequiredPlayerChoiceFallback,
  buildSourceChoiceNavigationContext,
  buildSourceEventBeatProgressContext,
  buildSourceEventChoiceBeatState,
  normalizeCompletedSourceEventBeatIndexes,
  nextRequiredSourceEventBeatReviewContext,
  reviewedSourceEventIdForBeatProgress,
  reviewedVisibleSourceEvent,
  sourceEventCompletionReference,
} from "./source-navigation.js";
import {
  SOURCE_GROUNDING_EXCERPT_CHARS,
} from "./source.js";

export function contiguousReportedSourceBeatIndexes(
  previousIndexes: readonly number[],
  reportedIndexes: readonly number[],
  beatCount: number,
  startBeatIndex = 0,
): number[] {
  const explicitlyCompleted = new Set(
    [...previousIndexes, ...reportedIndexes].filter(
      (index) => Number.isInteger(index) && index >= startBeatIndex && index < beatCount,
    ),
  );
  const normalized = normalizeCompletedSourceEventBeatIndexes(
    [...explicitlyCompleted],
    beatCount,
    startBeatIndex,
  );
  const firstImplicitIndex = normalized.findIndex(
    (index) => !explicitlyCompleted.has(index),
  );
  return firstImplicitIndex >= 0
    ? normalized.slice(0, firstImplicitIndex)
    : normalized;
}

export function shouldUseAutomaticOrderedSourceContinuation(
  event: ReturnType<typeof buildSourceChoiceNavigationContext>,
  requiresExplicitPlayerChoice: boolean,
): boolean {
  return Boolean(
    event?.beats?.length
    && !requiresExplicitPlayerChoice,
  );
}

export abstract class ProviderSceneReviewer extends ProviderEngineBase {
  protected async reviewSceneRepetition(
    state: Pick<
      GameState,
      | "book"
      | "scene"
      | "history"
      | "playerName"
      | "characterProfiles"
      | "objective"
      | "selectedText"
      | "sourceEventProgress"
    >,
    candidate: Pick<Scene, "title" | "text" | "development" | "sceneScope"> & {
      actionResult?: string;
    },
    sourceCandidate?: SourceContinuationCandidate,
    requiredSourceEvent = false,
    sourceProgressClaimed = false,
    dialogueTurn = false,
    completedSourceEventId?: string,
    dialogue?: DialogueSceneReviewContext,
  ): Promise<SceneRepetitionReview> {
    const reviewContext = buildSceneRepetitionReviewContext(
      state,
      candidate,
      dialogue,
    );
    const choiceNavigationEvent = buildSourceChoiceNavigationContext(
      sourceCandidate,
      state.playerName,
      state.characterProfiles,
      completedSourceEventId,
    );
    const sourceEventBeatProgress = buildSourceEventBeatProgressContext(
      choiceNavigationEvent,
      state.sourceEventProgress,
    );
    const remainingChoiceNavigationEvent =
      sourceEventBeatProgress && choiceNavigationEvent
        ? {
            ...choiceNavigationEvent,
            beats: sourceEventBeatProgress.remainingBeats,
          }
        : choiceNavigationEvent;
    const requiredSourceEventCanOccurWithoutPlayerChoice = Boolean(
      requiredSourceEvent
      && sourceEventCanOccurWithoutPlayerChoice(
        choiceNavigationEvent,
        state.playerName,
        state.characterProfiles,
        state.scene.sceneScope,
      ),
    );
    const requiredSourceReviewInput =
      (
        sourceCandidate?.recovery
        || sourceCandidate?.requiredEvent
        || requiredSourceEvent
        || sourceProgressClaimed
      )
        && sourceCandidate
        ? [
            "REQUIRED SOURCE RECOVERY WINDOW:",
            sourceCandidate.excerpt,
            "ORDERED SOURCE SUMMARY:",
            sourceCandidate.summary,
            "REQUIRED NEXT EVENT:",
            sourceCandidate.requiredEvent
              || "The first concrete event in the recovery window.",
            "SOURCE EVENT BEAT PROGRESS:",
            JSON.stringify(sourceEventBeatProgress, null, 2),
          ]
        : [];

    const request: AiResponseRequest = {
      model: this.model,
      reasoning: { effort: "low" },
      instructions: [
        "You are a strict semantic continuity and player-agency reviewer for an interactive story.",
        "Decide whether candidate_scene substantially repeats any recent_prior_scene instead of advancing beyond it.",
        "Set repeatsPriorScene true when the candidate reenacts or restates the same arrival, setup, actions, conversation beat, revealed information, character positions, decision point, or distinctive imagery, even if it uses synonyms, reordered prose, or added atmosphere.",
        "A vague hint, intention, mood shift, or promise of later action is not meaningful advancement when the same interaction and world state remain in place.",
        "When latest_input asks, commands, requests, challenges, threatens, or otherwise addresses an NPC, judge the immediate substantive response as a new beat even when the same conflict, topic, or relationship interaction continues.",
        "Never use failure to reach REQUIRED NEXT EVENT, or mere distance from that event, as evidence that a directly caused NPC response repeats prior narrative state. On an ordinary turn, the next source event may remain future.",
        ...(dialogueTurn
          ? [
              "For a dialogue turn, candidate_scene.text contains only narration. candidate_scene.dialogue separately contains the already-spoken player_utterance, the NPC response_speaker, and that NPC's character_response.",
              "Assess first-person player perspective only in candidate_scene.text. Never treat response_speaker, player_utterance, character_response, or their attribution as narration or as evidence of a viewpoint switch.",
              "player_utterance belongs to player_identity and has already been spoken. character_response belongs to response_speaker and must answer that utterance; do not demand that response_speaker repeat the player's words or mistake the displayed transcript order for a speaker reversal.",
              "For a dialogue turn, a new substantive answer, refusal, disclosure, commitment, threat, emotional reversal, relationship shift, physical reaction, or concrete conversational consequence is meaningful advancement even when the next source event remains future.",
              "Judge dialogue repetition against the actual information, response, and resulting decision point in recent_prior_scenes. Never use failure to reach REQUIRED NEXT EVENT, or mere distance from that event, as evidence that the dialogue repeats prior state.",
              "If the dialogue draft claims source progress but REQUIRED NEXT EVENT is not visibly completed, set requiredEventOccurred false. That only prevents cursor advancement; it does not by itself make an otherwise advancing dialogue invalid or repetitive.",
            ]
          : []),
        "The latest_input has already been selected, spoken, initiated, or requested. The candidate may show its execution once, but it must not replay the previous scene before resolving it.",
        "Also decide whether candidate_scene faithfully resolves immediate_transition.latest_input while keeping player_identity as the player and preserving who does what to whom.",
        "Assess that rule independently in preservesPlayerPerspective. Resolve who the first-person narrator actually is from dialogue attribution, actions, possessions, relationships, and pronoun referents; the mere presence of I, me, or my is not enough.",
        "Set preservesPlayerPerspective false when an NPC is the apparent first-person narrator, or when the narrator observes, names, or refers to player_identity or one of their aliases as he, she, they, him, her, them, his, or their. For example, if player_identity entrusts something to an NPC, narration from the player cannot call it 'his trust' or say that the player 'nods back'.",
        "Use playerPerspectiveFailureReason only to identify the concrete phrase or referent that switches viewpoint. Set it to an empty string when preservesPlayerPerspective is true.",
        "Set latestInputResolvedFaithfully false when the candidate omits or contradicts an explicit beat, narrates the player outside first person, changes the player identity, depicts player_identity or one of their aliases as a separate person observed by the player, swaps an actor and target, or turns the player's command into the target's command back at the player as a substitute.",
        "Classify latestInputFailureType as none when input fidelity succeeds; stalled when the correct input is attempted or restated but receives no concrete outcome; omitted when an explicit beat is absent; contradicted when the result denies an authoritative completed fact; or identity_or_roles when identity, actor, target, or direction is changed.",
        "In a selected_option, a player-controlled act phrased as an already completed fact and an explicitly stated immediate observation or world fact are authoritative user narration. The candidate must not reinterpret them as failed attempts or claim the opposite.",
        "A command or request establishes only that it was delivered unless latest_input also explicitly says the target complies. An attempted or requested outcome may fail through a concrete, causally plausible response without changing the player identity.",
        "The hidden action_result may support the assessment but cannot compensate when candidate_scene.text omits or contradicts the latest input.",
        "For player_dialogue, require the player's stated meaning and addressee to remain intact. For world_event, require the event itself to happen rather than become a player action or be denied.",
        "For scene_continuation, require the candidate to paint one concrete new observable beat of already ongoing activity without treating the request as a new player action. It may mechanically continue player activity visibly in progress in previous_scene, but may not escalate, redirect, or add a new decision or utterance.",
        "A new non-player request, proposal, revelation, reaction, arrival, or interruption that awaits the player's response is a valid scene_continuation beat. It is not an unselected player action, does not exceed turn scope, and does not fail input fidelity merely because the player has not acted on it yet.",
        "When immediate_transition is null, assess perspective, identity, and role consistency for latestInputResolvedFaithfully. Set it false with failure type identity_or_roles if narration is not first-person singular or candidate_scene separates player_identity or one of their aliases from the first-person player; otherwise set it true.",
        "For an opening with no recent_prior_scenes, CURRENT SIGNIFICANT EVENT is the mandatory starting endpoint. Set latestInputResolvedFaithfully false when candidate_scene begins before it, omits a required participant or concrete outcome, or replaces it with a merely approaching or anticipated version.",
        "An opening contains no selected player action. Set preservesPlayerAgency false if it invents a promise, goal, decision, departure, or other consequential voluntary act for player_identity, and reject knowledge taken only from later source material.",
        "Also assess candidate_scene prose for internal temporal and spatial consistency. Set latestInputResolvedFaithfully false with failure type contradicted when the prose itself contradicts its established state.",
        "When CURRENT SIGNIFICANT EVENT is supplied, treat it as completed authoritative state. Reject prose that reverses its irreversible consequences.",
        "For turn scope, judge only actions and events completed in candidate_scene.text, the hidden action_result, and development metadata.",
        "candidate_scene.development describes state already realized by the end of candidate_scene, never a queue of future beats. If the prose completes an event but development puts one of that event's prerequisites or beats back into the future, set staysWithinTurnScope false and identify the contradiction.",
        "Separately assess player agency. Set preservesPlayerAgency false when candidate_scene gives player_identity any consequential voluntary action or decision not contained in latest_input, even when that action follows the source, objective, genre, or likely character behavior.",
        "The unselected_options in latest_input are alternatives the player explicitly did not choose. If candidate_scene performs or blends in any of them, set preservesPlayerAgency false.",
        "Do not count involuntary bodily reactions, perception, or a minor motion mechanically necessary to execute latest_input as a new decision.",
        "For a selected option to stay, wait, watch, rehearse, prepare, or ready for an explicitly imminent event, require the bounded behavior to complete and one concrete next observable beat to occur. An independently occurring arrival, NPC action, or world event does not violate player agency or turn scope.",
        "If such a low-motion option ends in the same waiting or preparation state with no observable change, mark repetition true, but do not mark the other continuity fields false unless separate specific evidence supports each failure.",
        "For scene_continuation, also do not count the unchanged mechanical continuation of player activity already visibly in progress in previous_scene as a new decision. Any escalation, redirection, new speech, or other added intent is a new unselected player action.",
        "Assess turn pacing independently. Set staysWithinTurnScope false when the candidate resolves latest_input and then also completes another unselected menu-worthy player action, an unrelated major plot beat outside a supplied automatic window, or an unauthorized substantial time/location transition that should have been the next decision.",
        "Judge perspective, continuity, agency, and turn-scope independently. Repetition or lack of advancement alone does not prove that perspective switched, the latest input was changed, an unselected player action occurred, or the turn advanced too far; set each field false only when candidate_scene contains specific evidence for that separate failure.",
        "Use latestInputFailureReason only for a concrete omission, contradiction, identity change, or actor/target reversal. Use playerAgencyFailureReason only to name the specific consequential voluntary player action candidate_scene performs without selection. Use turnScopeFailureReason only to name the specific second player action, later major plot beat, substantial transition, or skipped causal prerequisite that makes candidate_scene advance beyond the established timeline.",
        "Set each dedicated failure reason to an empty string when its corresponding boolean is true. Repetition, merely leaving a source event in the future, or an NPC beat awaiting player response must never be copied into these dedicated failure reasons.",
        "A well-scoped ordinary turn may show all explicit beats in a compound latest_input, immediate NPC reactions, and one directly caused or independently occurring external consequence. It must stop before the player makes the next distinct choice.",
        "For world_event, the event itself is the turn's single major beat. Allow its direct immediate reactions and observable consequences, but require the scene to stop before a second independently initiated major event or any voluntary response by player_identity.",
        "For scene_continuation, allow one cohesive non-player or world beat that visibly changes the scene. Mark scope false if it summarizes or completes later beats, races the active sequence to its final resolution, starts an unrelated sequence, makes a substantial time or location jump, or performs a voluntary player decision.",
        "When immediate_transition is null, preservesPlayerAgency and staysWithinTurnScope are true only if the candidate establishes or advances the situation without inventing a major voluntary decision for player_identity.",
        "Separately identify every named character from recent_prior_scenes or candidate_scene who is dead, a corpse, or otherwise established as permanently departed or gone, based on the narrative prose and any CURRENT SIGNIFICANT EVENT, not merely a name mentioned in passing.",
        "List those names in nonInteractableCharacters using the same identity as they appear in the story; leave it an empty array when none apply, and explain the basis briefly in nonInteractableCharactersReason.",
        "A character who is merely absent, mentioned in memory, or referenced without being physically present is not automatically dead; only report a character as non-interactable when the narrative establishes death, a corpse, or permanent departure.",
        ...((
          sourceCandidate?.recovery
          || sourceCandidate?.requiredEvent
          || requiredSourceEvent
          || sourceProgressClaimed
        )
          && sourceCandidate
          ? [
              requiredSourceEvent
                ? requiredSourceEventCanOccurWithoutPlayerChoice
                  ? "Agency metadata confirms that REQUIRED NEXT EVENT needs no separate meaningful voluntary player choice; it must occur in this scene."
                  : "REQUIRED NEXT EVENT contains or may contain a meaningful voluntary player beat. The request and source material do not authorize that beat unless immediate_transition.latest_input selected it."
                : sourceProgressClaimed
                  ? "The draft uses REQUIRED NEXT EVENT as its source direction. Confirm occurrence only to decide whether the source cursor may advance; absence alone is not a continuity or repetition failure."
                  : sourceCandidate.recovery
                    ? "A REQUIRED SOURCE RECOVERY window and REQUIRED NEXT EVENT are supplied."
                    : "An optional upcoming REQUIRED NEXT EVENT is supplied only for evaluating source progress.",
              requiredSourceEvent
                ? requiredSourceEventCanOccurWithoutPlayerChoice
                  ? "When immediate_transition is null, direct source continuation was requested for an event needing no separate meaningful player choice: set repeatsPriorScene true unless candidate_scene makes the required event visibly happen now."
                  : "When immediate_transition is null, do not demand that player_identity perform a meaningful intentional or ambiguous beat from REQUIRED NEXT EVENT. It must remain future behind an explicit informed-consent choice."
                : "For an ordinary turn, the REQUIRED NEXT EVENT may remain future. Do not mark input fidelity or repetition as failed merely because this scene only makes a concrete new move toward it.",
              requiredSourceEvent
                ? requiredSourceEventCanOccurWithoutPlayerChoice
                  ? "Direct source continuation may enact this agency-classified event. It does not authorize any additional meaningful voluntary action by player_identity."
                  : "If candidate_scene assigns player_identity a meaningful intentional or ambiguous beat that was not selected, set preservesPlayerAgency false even when the source requires that event."
                : "An ordinary option or dialogue does not authorize a new consequential action by player_identity merely because it appears in REQUIRED NEXT EVENT.",
              "When immediate_transition is present, the latest input still controls the turn. Require the source event now only if it follows directly or can occur without a separate consequential choice by player_identity.",
              "If the required event needs another voluntary player action absent from latest_input, it must remain future. Set requiredEventOccurred false, preserve agency, and do not mark the draft repetitive merely because it stops at a concrete new decision point leading toward that event.",
              "When REQUIRED NEXT EVENT remains future, candidate_scene must not depict an investigation, arrival, discovery, aftermath, or any other canonical event that follows it. If it does, set staysWithinTurnScope false and identify the skipped prerequisite.",
              "When the event is required now, a hint, ominous pause, stated intention, 'about to' framing, or externalDevelopment metadata is not enough. The event itself and its immediate observable effect must appear in candidate_scene.text.",
              "When CHOICE NAVIGATION EVENT contains beats, it contains only the still-remaining beats. SOURCE EVENT BEAT PROGRESS is authoritative cumulative state; completed beats need not be repeated in candidate_scene.",
              "Set requiredEventOccurred true when candidate_scene visibly completes every remaining beat and, together with the stored completed beats, satisfies REQUIRED NEXT EVENT. Do not mistake an involuntary beat for a voluntary player decision.",
              "Set requiredEventOccurred true exactly when stored progress plus candidate_scene visibly complete REQUIRED NEXT EVENT and its immediate observable effect.",
              "The required event was independently selected as the next future event. Treat it as already completed only when a recent_prior_scene explicitly depicts that same event.",
              "Use ORDERED SOURCE SUMMARY to verify causal prerequisites. Set requiredEventOccurred false when candidate_scene assumes an earlier death, attack, departure, discovery, or other prerequisite that no recent_prior_scene visibly established.",
              "A body already being dead does not depict or establish the missing killing; an investigation does not depict its missing triggering incident. If candidate_scene skips such a prerequisite, also set staysWithinTurnScope false and name it in turnScopeFailureReason.",
              "Compare candidate_scene only against recent_prior_scenes. Never treat the recovery window, source summary, candidate_scene, or development metadata as evidence that the required event happened earlier.",
              "When the required event is absent from every recent_prior_scene and visibly occurs in candidate_scene.text, set repeatsPriorScene false even when the room, characters, or short causal bridge remain the same.",
            ]
          : []),
        ...(
          !sourceCandidate?.recovery
          && !sourceCandidate?.requiredEvent
          && !requiredSourceEvent
          && !sourceProgressClaimed
          ? ["No REQUIRED NEXT EVENT is being reviewed, so set requiredEventOccurred false."]
          : []),
        "Judge only semantic continuity, player-agency fidelity, and the required recovery event. Do not rewrite the scene, assess style, or demand an unrelated surprise.",
        "Give a concise, specific reason of no more than 40 words for any failed criterion; otherwise summarize the concrete advancement.",
      ].join("\n"),
      input: [
        reviewContext,
        "CHOICE NAVIGATION EVENT:",
        JSON.stringify(remainingChoiceNavigationEvent, null, 2),
        ...(sourceCandidate
          ? [
              "CURRENT SIGNIFICANT EVENT:",
              JSON.stringify(sourceCandidate.currentStoryEvent ?? null, null, 2),
              "UPCOMING SOURCE ANCHOR MATERIAL:",
              JSON.stringify({
                chapterPosition: sourceCandidate.chapterPosition,
                chapterTitle: sourceCandidate.chapterTitle,
                excerpt: sourceCandidate.excerpt.slice(0, SOURCE_GROUNDING_EXCERPT_CHARS),
              }, null, 2),
            ]
          : ["UPCOMING SOURCE ANCHOR MATERIAL:\nNone supplied."]),
        ...requiredSourceReviewInput,
      ].filter(Boolean).join("\n\n"),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_scene_repetition_review",
          strict: true,
          schema: sceneRepetitionReviewJsonSchema,
        },
      },
    };

    for (
      let attempt = 0;
      attempt < SCENE_REPETITION_REVIEW_OUTPUT_TOKENS.length;
      attempt += 1
    ) {
      const maxOutputTokens = SCENE_REPETITION_REVIEW_OUTPUT_TOKENS[attempt]!;
      const response = await this.createResponse("scene repetition review", state.book.bookId, {
        ...request,
        max_output_tokens: maxOutputTokens,
      });
      let failure: Error | undefined;
      if (response.status === "incomplete") {
        const details = JSON.stringify(response.incomplete_details) ?? "no details";
        failure = new Error(
          `AI scene repetition review returned an incomplete response: ${details}`,
        );
        if (!details.includes("max_output_tokens")) throw failure;
      } else {
        try {
          const review = parseAiJson<SceneRepetitionReview>(
            response.output_text,
            "AI scene repetition review",
          );
          if (
            typeof review.repeatsPriorScene === "boolean"
            && typeof review.latestInputResolvedFaithfully === "boolean"
            && (
              review.latestInputFailureType === undefined
              || review.latestInputFailureType === "none"
              || review.latestInputFailureType === "stalled"
              || review.latestInputFailureType === "omitted"
              || review.latestInputFailureType === "contradicted"
              || review.latestInputFailureType === "identity_or_roles"
            )
            && typeof review.preservesPlayerPerspective === "boolean"
            && typeof review.preservesPlayerAgency === "boolean"
            && typeof review.staysWithinTurnScope === "boolean"
            && (
              review.latestInputFailureReason === undefined
              || typeof review.latestInputFailureReason === "string"
            )
            && (
              review.playerPerspectiveFailureReason === undefined
              || typeof review.playerPerspectiveFailureReason === "string"
            )
            && (
              review.playerAgencyFailureReason === undefined
              || typeof review.playerAgencyFailureReason === "string"
            )
            && (
              review.turnScopeFailureReason === undefined
              || typeof review.turnScopeFailureReason === "string"
            )
            && typeof review.requiredEventOccurred === "boolean"
            && typeof review.reason === "string"
          ) {
            const assessedReview = {
              ...review,
              reason: review.reason.trim() || "No additional semantic review rationale was provided.",
            };
            const normalizedReview = this.centralReviewValidation ? assessedReview : normalizeIndependentReviewFailures(assessedReview);
            return !this.centralReviewValidation && requiredSourceEvent && normalizedReview.requiredEventOccurred
              ? {
                  ...normalizedReview,
                  repeatsPriorScene: false,
                  latestInputResolvedFaithfully: true,
                  latestInputFailureType: "none",
                  latestInputFailureReason: "",
                }
              : normalizedReview;
          }
          failure = new Error("AI scene repetition review returned an invalid assessment");
        } catch (error) {
          if (!(error instanceof InvalidAiJsonError)) throw error;
          failure = error;
        }
      }

      if (attempt === SCENE_REPETITION_REVIEW_OUTPUT_TOKENS.length - 1) {
        throw failure;
      }
      flowDiagnostic(
        `${this.client.provider} scene repetition review response was incomplete; `
        + `retrying with ${SCENE_REPETITION_REVIEW_OUTPUT_TOKENS[attempt + 1]} output tokens.`,
      );
    }
    throw new Error("AI scene repetition review exhausted its response attempts");
  }

  protected async reviewSceneChoices(
    state: Pick<
      GameState,
      | "book"
      | "scene"
      | "history"
      | "playerName"
      | "characterProfiles"
      | "objective"
      | "selectedText"
      | "sourceEventProgress"
    >,
    candidate: Pick<
      Scene,
      "title" | "text" | "development" | "choices" | "sceneScope" | "outcomeReason"
    >,
    sourceCandidate?: SourceContinuationCandidate,
    completedSourceEventId?: string,
    completedAction?: CompletedSceneAction,
  ): Promise<SceneChoiceReview> {
    // Source continuation is an engine control, not a voluntary player action.
    // Review only player choices and translate the assessment back to menu indexes.
    const playerChoices = candidate.choices.flatMap((choice, index) =>
      choice.id === SOURCE_CONTINUATION_CHOICE_ID ? [] : [{ choice, index }],
    );
    if (playerChoices.length === 0) {
      return {
        anchorChoiceIndex: null,
        unusableChoiceIndexes: [],
        unusableChoicesReason: "",
        reason: "No voluntary player choices to review.",
      };
    }
    const reviewCandidate = {
      ...candidate,
      choices: playerChoices.map(({ choice }) => choice),
    };
    const choiceNavigationEvent = buildSourceChoiceNavigationContext(
      sourceCandidate,
      state.playerName,
      state.characterProfiles,
      completedSourceEventId,
      candidate.sceneScope,
    );
    const choiceBeatState = buildSourceEventChoiceBeatState(
      choiceNavigationEvent,
      state.sourceEventProgress,
    );
    const sourceEventBeatProgress = choiceBeatState.progress;
    const remainingChoiceNavigationEvent = choiceBeatState.remainingEvent;
    const currentSignificantEvent =
      reviewedVisibleSourceEvent(sourceCandidate, completedSourceEventId)
      ?? (
        choiceBeatState.hasOrderedBeats
          ? choiceBeatState.completedEvent
          : sourceCandidate?.currentStoryEvent ?? null
      );
    const requiredPlayerChoiceBeats = sourceEventNextPlayerChoiceBeats(
      remainingChoiceNavigationEvent,
      state.playerName,
      state.characterProfiles,
    );
    const automaticOrderedSourceBoundary = Boolean(
      remainingChoiceNavigationEvent?.beats?.length
      && requiredPlayerChoiceBeats.length === 0,
    );
    const request: AiResponseRequest = {
      model: this.model,
      reasoning: { effort: "low" },
      instructions: [
        "You are a strict semantic choice-menu reviewer for an interactive story.",
        "The candidate scene is already completed and approved. Review only its prospective choices; do not rewrite or reassess the narrative.",
        "For an active candidate_scene, inspect every offered choice and set anchorChoiceIndex to the zero-based index of the strongest immediate, executable, voluntary route toward CHOICE NAVIGATION EVENT when supplied; otherwise use the earliest compatible event in UPCOMING SOURCE ANCHOR MATERIAL.",
        "CHOICE NAVIGATION EVENT may be the event after a source event completed in candidate_scene. Keep the completed and future beats separate.",
        "REQUIRED PLAYER CHOICE BEATS lists only the immediately eligible player-controlled decision; later player decisions behind an unfinished NPC beat are excluded. Treat beats already visibly completed in candidate_scene as past, then find the earliest remaining contiguous player decision before an intervening NPC, external, involuntary, or routine beat. An anchor choice must authorize that decision only; later player decisions remain future.",
        "If CHOICE NAVIGATION EVENT has ordered beats but REQUIRED PLAYER CHOICE BEATS is empty, the next ordered beat belongs to an NPC, the world, or otherwise is not a meaningful player-controlled decision. Set anchorChoiceIndex to null; never reinterpret that beat as a voluntary player action or choose a player action merely because it helps that beat happen.",
        ...INFORMED_PLAYER_CHOICE_RULES,
        ...CHOICE_TIMELINE_RULES,
        ...SOURCE_RECOUNTING_RULES,
        ...PLAYER_EMBODIMENT_RULES,
        "The first remaining ordered beat is the immediate routing target, even if required player choice beats occur later. Never choose a repeated protective or preparatory action merely because it fits the event theme; return null when no choice enables that next beat or a concrete unmet prerequisite.",
        "The anchor route needs a clear causal bridge; thematic similarity is insufficient. Reject invented side clues, repeated local activity, and stalling observation when a supplied source event can move the story.",
        "A choice may investigate, converse, move, or act without revealing the future event, but it must not promise an uncertain discovery, answer, or NPC reaction as if guaranteed.",
        "When no upcoming source material is supplied, choose the strongest route toward an unresolved source-backed conflict, relationship, location, or pressure already visible in source_passage, recent_prior_scenes, candidate_scene, or objective.",
        "Set anchorChoiceIndex to null for a terminal scene with no choices, or when no offered choice satisfies the anchor-routing requirement. Do not automatically choose index 0; judge all choices.",
        "CURRENT SIGNIFICANT EVENT and candidate_scene are authoritative completed state. Choices must preserve all irreversible consequences, including deaths, injuries, departures, disclosures, consumed or destroyed objects, and changed relationships.",
        "CURRENT SIGNIFICANT EVENT is the latest source event confirmed complete; all of its listed beats are behind the decision point. Never select or retain a choice that performs, prepares for, or finishes one of those completed beats.",
        "Return every zero-based choice index whose wording contradicts candidate_scene's confirmed end state in unusableChoiceIndexes. This includes waiting or preparing for an already-present character to arrive, placing an action before an already-completed event, treating an absent character as interactive, naming player_identity or an alias as a separate participant, or otherwise undoing a visible spatial, temporal, or identity fact.",
        "Treat a choice that violates the choice-timeline rules or phrases the player's action as a third-person finite verb rather than a direct selectable action as unusable.",
        "player_identity is the actor of every choice regardless of the character metadata field. That field can name a required non-player participant, but never transfers the choice's action to that participant.",
        "player_identity is physically present at candidate_scene.sceneScope.currentLocation by definition and belongs in both peoplePresent and peopleWithinSpeakingDistance. Never classify the player as absent for that reason.",
        "Also return every choice index that reenacts, restates, reconfirms, rehearses, or merely continues an action, movement, decision, disclosure, arrival, departure, or relationship change already completed in candidate_scene. A paraphrase remains unusable even when it calls the replay 'affirming', 'solidifying', or 'finishing' the completed result.",
        "candidate_scene.playerAction and candidate_scene.actionResult are hidden completed-turn metadata when present. Use them together with candidate_scene.text, development, and outcomeReason to reject replay choices; never expose the metadata field names in the rationale.",
        "Apply the shared choice execution policy to usability too: report semantic duplicates and choices requiring unsupported verbal capabilities in unusableChoiceIndexes. For duplicates retain the earliest otherwise usable choice and flag later equivalents.",
        "Assess physical feasibility from the scene's final state and established capabilities. Report choices requiring currently impossible movement in unusableChoiceIndexes. Distinguish actual paralysis, restraint, rust or injury from memories, fears, negation and limitations already resolved in this scene. An attempt to move may remain executable without guaranteeing success; asking for help need not require walking. Do not infer ability or inability from a keyword alone.",
        "Judge the choice wording itself rather than trusting its requiredPresentCharacters or requiredAbsentCharacters classification. Leave unusableChoiceIndexes empty when every choice is immediately executable from candidate_scene.sceneScope and prose.",
        "Explain the concrete choice/state contradiction briefly in unusableChoicesReason, or use an empty string when no choice is unusable.",
        "Give a concise reason of no more than 40 words for the selected anchor route, or explain why no choice qualifies.",
      ].join("\n"),
      input: [
        buildSceneChoiceReviewContext(state, reviewCandidate, completedAction),
        "CHOICE NAVIGATION EVENT:",
        JSON.stringify(remainingChoiceNavigationEvent ? {
          ...remainingChoiceNavigationEvent,
          requiresExplicitPlayerChoice: sourceEventHasReadyPlayerChoice(
            remainingChoiceNavigationEvent,
            state.playerName,
            state.characterProfiles,
            candidate.sceneScope,
          ),
        } : null, null, 2),
        ...(sourceCandidate
          ? [
              "CURRENT SIGNIFICANT EVENT:",
              JSON.stringify(currentSignificantEvent, null, 2),
              "SOURCE EVENT BEAT PROGRESS:",
              JSON.stringify(sourceEventBeatProgress, null, 2),
              "REQUIRED PLAYER CHOICE BEATS:",
              JSON.stringify(requiredPlayerChoiceBeats, null, 2),
              "UPCOMING SOURCE ANCHOR MATERIAL:",
              JSON.stringify({
                chapterPosition: sourceCandidate.chapterPosition,
                chapterTitle: sourceCandidate.chapterTitle,
                excerpt: sourceCandidate.excerpt.slice(0, SOURCE_GROUNDING_EXCERPT_CHARS),
              }, null, 2),
            ]
          : [
              "CURRENT SIGNIFICANT EVENT:\nNone supplied.",
              "UPCOMING SOURCE ANCHOR MATERIAL:\nNone supplied.",
            ]),
      ].join("\n\n"),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_scene_choice_review",
          strict: true,
          schema: sceneChoiceReviewJsonSchema,
        },
      },
    };

    for (
      let attempt = 0;
      attempt < SCENE_CHOICE_REVIEW_OUTPUT_TOKENS.length;
      attempt += 1
    ) {
      const maxOutputTokens = SCENE_CHOICE_REVIEW_OUTPUT_TOKENS[attempt]!;
      const response = await this.createResponse("scene choice review", state.book.bookId, {
        ...request,
        max_output_tokens: maxOutputTokens,
      });
      let failure: Error | undefined;
      if (response.status === "incomplete") {
        const details = JSON.stringify(response.incomplete_details) ?? "no details";
        failure = new Error(`AI scene choice review response was incomplete: ${details}`);
        if (!details.includes("max_output_tokens")) throw failure;
      } else {
        try {
          const review = parseAiJson<SceneChoiceReview>(
            response.output_text,
            "AI scene choice review",
          );
          const validAnchor = review.anchorChoiceIndex === null
            || (
              Number.isInteger(review.anchorChoiceIndex)
              && review.anchorChoiceIndex >= 0
              && review.anchorChoiceIndex < playerChoices.length
            );
          const validUnusableIndexes = Array.isArray(review.unusableChoiceIndexes)
            && review.unusableChoiceIndexes.every((index) =>
              Number.isInteger(index)
              && index >= 0
              && index < playerChoices.length
            );
          if (
            validAnchor
            && validUnusableIndexes
            && typeof review.unusableChoicesReason === "string"
            && typeof review.reason === "string"
          ) {
            return {
              ...review,
              anchorChoiceIndex: automaticOrderedSourceBoundary || review.anchorChoiceIndex === null
                ? null
                : playerChoices[review.anchorChoiceIndex]!.index,
              unusableChoiceIndexes: [...new Set(review.unusableChoiceIndexes)]
                .map((index) => playerChoices[index]!.index),
              unusableChoicesReason: review.unusableChoicesReason.trim(),
              reason: review.reason.trim() || "No semantic choice-review rationale was provided.",
            };
          }
          failure = new Error("AI scene choice review returned an invalid assessment");
        } catch (error) {
          if (!(error instanceof InvalidAiJsonError)) throw error;
          failure = error;
        }
      }

      if (attempt === SCENE_CHOICE_REVIEW_OUTPUT_TOKENS.length - 1) {
        throw failure;
      }
      flowDiagnostic(
        `${this.client.provider} scene choice review response was incomplete; `
        + `retrying with ${SCENE_CHOICE_REVIEW_OUTPUT_TOKENS[attempt + 1]} output tokens.`,
      );
    }
    throw new Error("AI scene choice review exhausted its response attempts");
  }

  protected async reviewScenePresence(
    state: GameState,
    candidate: Pick<Scene, "title" | "text" | "sceneScope"> & {
      playerAction?: string;
    },
    explicitlyUnavailable: readonly string[],
    sourceCandidates: readonly SourceContinuationCandidate[] = [],
    eventReviewTargetId?: string,
    openingProgressionReview = false,
  ): Promise<ScenePresenceReview> {
    const orderedSourceEvents = [
      ...(sourceCandidates[0]?.currentStoryEvent
        ? [sourceCandidates[0].currentStoryEvent]
        : []),
      ...(sourceCandidates[0]?.storyEvents ?? []),
    ].filter(
      (event, index, events) =>
        events.findIndex((candidateEvent) =>
          candidateEvent.eventId === event.eventId
        ) === index,
    );
    const reviewTargetId = eventReviewTargetId ?? (this.centralReviewValidation ? currentTurnExecution()?.contract.eventId ?? undefined : undefined);
    const eventReviewTarget = reviewTargetId
      ? orderedSourceEvents.find((event) => event.eventId === reviewTargetId)
        ?? (
          sourceCandidates[0]?.requiredEventId === reviewTargetId
          && sourceCandidates[0]?.requiredEvent
            ? {
                eventId: reviewTargetId,
                description: sourceCandidates[0].requiredEvent,
                chapterPosition: sourceCandidates[0].chapterPosition,
                category: sourceCandidates[0].requiredEventCategory,
                actors: sourceCandidates[0].requiredEventActors,
                targets: sourceCandidates[0].requiredEventTargets,
                beats: sourceCandidates[0].requiredEventBeats,
              }
            : undefined
        )
      : undefined;
    const previousCompletedEventBeatIndexes =
      eventReviewTarget?.eventId
        && state.sourceEventProgress?.eventId === eventReviewTarget.eventId
          ? state.sourceEventProgress.completedBeatIndexes
          : [];
    const futureActionEvent = eventReviewTarget
      ?? buildSourceChoiceNavigationContext(
        sourceCandidates[0],
        state.playerName,
        state.characterProfiles,
        undefined,
        candidate.sceneScope,
      );
    const futureActionProgress = buildSourceEventBeatProgressContext(
      futureActionEvent,
      state.sourceEventProgress,
    );
    const futurePlayerActions = sourceEventPlayerChoiceBeats(
      futureActionEvent && futureActionProgress
        ? { ...futureActionEvent, beats: futureActionProgress.remainingBeats }
        : futureActionEvent,
      state.playerName,
      state.characterProfiles,
    ).map((beat) => ({
      eventId: futureActionEvent?.eventId ?? null,
      beatIndex: Math.max(
        0,
        ((futureActionProgress?.startBeatIndex ?? 0) + (futureActionProgress?.completedBeatIndexes.length ?? 0))
          + (futureActionProgress?.remainingBeats.indexOf(beat) ?? 0),
      ),
      action: beat.action,
      actor: beat.actor,
      targets: beat.targets,
      agency: beat.agency,
      stakes: beat.stakes,
    }));
    const planned = currentTurnExecution()?.contract;
    const contract = planned && planned.eventId === (eventReviewTarget?.eventId ?? null) ? planned : planTurn({
      state, event: eventReviewTarget, mode: openingProgressionReview ? "opening" : "action",
      selectedIntent: planned?.selectedIntent ?? undefined,
      sourceProgression: planned?.sourceProgression,
      sourceReferenceExcerpts: sourceCandidates[0]?.sourceReferenceExcerpts,
    });
    const request: AiResponseRequest = {
      ...(this.centralReviewValidation ? { turnContract: contract } : {}),
      model: this.model,
      reasoning: { effort: "low" },
      instructions: [
        SCENE_DEATH_POLICY,
        "You are the authoritative physical-presence reviewer for an interactive story scene.",
        "Determine peoplePresent and peopleWithinSpeakingDistance from the actual end state of the visible scene and established continuity. Mere mention, memory, wishes, hypothetical/future arrivals, and plans to return home do not change presence. A character standing here discussing returning home remains here.",
        "Preserve established nearby participants unless the scene establishes departure, separation, or another real change. Ordinary nearby conversation establishes speaking distance without a literal distance statement. Presence alone does not imply reach through a barrier or between separate rooms.",
        "A previously absent living person may become present through a supported arrival in this scene. Judge that transition semantically; do not require a named arrival verb or a literal quotation. Future source events do not establish a current arrival.",
        "CURRENT SIGNIFICANT EVENT is structured authoritative state and overrides ambiguous prose.",
        "When event_review_target_mode is 'scene_completion', review only that exact event. Return its eventId only when previous completed beats plus candidate_scene.text and any explicitly selected matching candidate_scene.player_action complete its description and every listed beat; otherwise return null. Previously completed beats need not be repeated. Never return another event as a substitute.",
        "When event_review_target_mode is 'opening_progression', the target event and its beats are future narrative structure, not pre-completed state. Count only beats visibly completed in candidate_scene and return its eventId only when every beat is complete.",
        "In opening_progression mode, the scene may legitimately stop before the first meaningful player-controlled beat. Preserve that beat as a future choice; never mark it complete merely because the scene establishes its physical prerequisite.",
        "Review future_player_actions for both opening and later scenes. They are still-future meaningful player-controlled beats, not completed actions unless candidate_scene.player_action explicitly selected that same beat for this turn.",
        ...SOURCE_RECOUNTING_RULES,
        "Only entries in future_player_actions are eligible for future-action setup review. Never substitute an NPC beat from event_review_target or next_required_source_event_beat, even when it targets the player. An NPC order to Dorothy is not Dorothy's voluntary action.",
        "First account for previous completed beats and additional beats completed in this candidate; assess setup only for the earliest still-uncompleted entry in future_player_actions. Completed NPC warnings or departures do not require their actors to remain present at the end of the scene.",
        "Set futureActionSetupRequired true only when the earliest future action is still causally compatible with previous_scene, candidate_scene, and candidate_scene.player_action, and its physical or social prerequisites belong at the candidate's next decision point.",
        "The setup check asks only whether the earliest future player action is immediately executable from the scene's end state. It must never require candidate_scene to perform, speak, decide, request, signal, or otherwise enact that future action itself.",
        "Assess only the sensory reach required by the earliest future action: a visible wink or nod needs the intended observer able to see the player, not speaking distance. Do not require setup for a later request or infer absence from an approaching character who is visibly looking at the player in candidate_scene.text.",
        "For a future speech, request, question, command, gesture, or other interpersonal player beat, prerequisites include a present/reachable intended participant and the physical/social opportunity to act. For a response to a statement, question, accusation, offer, or revelation, also require its specific content to have been conveyed in previous_scene.text or candidate_scene.text. Source excerpts, beat descriptions, and metadata do not establish player knowledge. The player's response itself must remain unperformed.",
        "Being greeted as a liberator does not establish being told that one's house killed someone. Before offering a denial of killing, require the concrete attribution to have been communicated to the player; otherwise set futureActionSetupRequired true and futureActionSetupSupported false when that response is the next decision boundary.",
        "Re-evaluate the decision boundary after newly completed NPC beats. If an NPC arrives or speaks in this candidate and the next remaining beat is the player's response, review that response's setup now even when the first unfinished beat before this candidate belonged to the NPC.",
        "If the earliest future player beat is already executable at the decision point, set futureActionSetupSupported true even when candidate_scene contains none of that beat's action wording. For example, after the Scarecrow has winked and Dorothy is present and able to hear him, 'ask Dorothy to remove the pole' is properly left entirely to choices[0].",
        "If candidate_scene.player_action already explicitly authorizes or performs that source action, it is no longer a future choice: set futureActionSetupRequired false. Also set it false when the interactive timeline has diverged incompatibly, when a different immediate decision comes first, or when there is no future player action.",
        "When futureActionSetupRequired is true, set futureActionSetupSupported true only when candidate_scene visibly establishes the prerequisites needed to make the future choice executable, without performing any part of that future choice for the player.",
        "Infer concrete prerequisite state from the future action, but do not confuse the action with its prerequisite. If a Scarecrow's future beat is to wink and nod at Dorothy from his pole, the scene must visibly place him on the pole with Dorothy able to notice him; it must not depict the wink or nod as already performed.",
        "When futureActionSetupRequired is false, set futureActionSetupSupported true. Explain the confirmed setup, incompatibility, already-authorized action, or missing prerequisite concisely in futureActionSetupReason.",
        "previous_completed_source_event_beat_indexes is authoritative completed state. Do not repeat those indexes in completedSourceEventBeatIndexes; report only additional beats completed by candidate_scene.",
        ...(this.centralReviewValidation ? [
          "Report a compound beat as partiallyPerformedSourceEventBeatIndexes when any constituent act is performed but others remain future. Catching Toto already partially performs 'catch Toto and follow Aunt Em', even if Dorothy has not followed her yet. Intention alone is not performance, but reaching to retrieve him or already holding him is observable action/state.",
          "Check every claimed beat against candidate_scene.text independently. The event_review_target, source_excerpt, resultingState and hidden scene summaries are verification references, never proof that the candidate depicts them. Do not credit an entire event from its general title or threat.",
          "In the reason, identify the concrete missing constituent action of each incomplete mandatory beat. Preserve both completed and partially performed observations, including forbidden player acts; do not omit evidence to protect the cursor.",
        ] : []),
        "When next_required_source_event_beat is present, assess that exact beat explicitly before considering later beats or future-action setup. Include its index when candidate_scene.text visibly enacts its action, including clear continuous movement such as entering, continuing into, or moving deeper into a named location.",
        "Add a meaningful player-controlled beat when candidate_scene.player_action explicitly selects or performs that same source action; the scene text is expected to begin at its consequence and need not restate the selected action verbatim.",
        "Never mark a player-controlled beat complete merely because a later NPC, external, involuntary, or routine consequence appears. A player beat must already be in previous_completed_source_event_beat_indexes, be visibly completed in candidate_scene.text, or be explicitly authorized by matching candidate_scene.player_action.",
        "Beat progress is an ordered contiguous prefix, but do not fill that prefix across an earlier unselected meaningful player-controlled beat. If candidate_scene depicts a later beat that causally depends on such an unselected player beat, do not report the later beat as completed; preserve the player beat and its dependent beats as future.",
        "Outside opening_progression, current_source_event is baseline state already reached before candidate_scene. In opening_progression it is the future event being staged; do not treat it as completed unless candidate_scene visibly completes every beat.",
        "Without event_review_target, identify the latest event strictly after current_source_event that candidate_scene.text visibly completes. Return its exact eventId, or null when none is visibly completed.",
        "Use each event's short description plus all listed beats as its completion contract.",
        "For each communicative NPC beat, require every material claim in its action to be conveyed in player-facing prose. A broad summary such as greets the player as a liberator does not complete a beat that also explicitly credits the player with killing a named person. Do not mark the whole beat completed from its greeting alone.",
        "In scene_completion mode, require every distinct action or outcome explicitly named in the description and every still-incomplete listed beat. A general outcome phrase does not substitute for a missing listed beat.",
        "In opening_progression mode, use the event and ordered beats to verify actual progress while allowing the scene to establish the setup before an unselected player action.",
        "Do not require unlisted source beats, participants, causes, or details that the completion contract omits.",
        "In scene_completion mode, do not mark an event complete from anticipation, preparation, intention, atmosphere, an unselected choice, or mere mention. An arrival requires the character to visibly arrive or enter; later events require their material action or disclosure to occur.",
      ].join("\n"),
      input: JSON.stringify({
        player_identity: state.playerName,
        runtime_parameters: state.parameters ?? [],
        character_profiles: (state.characterProfiles ?? []).map((profile) => ({
          name: profile.name,
          aliases: profile.aliases,
        })),
        current_significant_event: state.establishedEvent ?? null,
        explicitly_unavailable: explicitlyUnavailable,
        current_source_event: sourceCandidates[0]?.currentStoryEvent
          ? sourceEventCompletionReference(sourceCandidates[0].currentStoryEvent)
          : null,
        event_review_target: eventReviewTarget
          ? sourceEventCompletionReference(eventReviewTarget)
          : null,
        event_review_target_mode: openingProgressionReview
          ? "opening_progression"
          : "scene_completion",
        previous_completed_source_event_beat_indexes:
          previousCompletedEventBeatIndexes,
        next_required_source_event_beat:
          nextRequiredSourceEventBeatReviewContext(
            eventReviewTarget,
            previousCompletedEventBeatIndexes,
            state.sourceEventProgress?.eventId === eventReviewTarget?.eventId ? state.sourceEventProgress?.startBeatIndex ?? 0 : 0,
          ),
        future_player_actions: futurePlayerActions,
        source_excerpt: sourceCandidates[0]?.excerpt ?? "",
        ordered_source_events: orderedSourceEvents.map(sourceEventCompletionReference),
        previous_scene: {
          title: state.scene.title,
          text: state.scene.text,
          sceneScope: state.scene.sceneScope ?? null,
        },
        candidate_scene: {
          title: candidate.title,
          text: candidate.text,
          proposed_scene_scope: candidate.sceneScope ?? null,
          player_action: candidate.playerAction ?? "",
        },
      }, null, 2),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_scene_presence_review",
          strict: true,
          schema: this.centralReviewValidation ? {
            ...scenePresenceReviewJsonSchema,
            properties: {...scenePresenceReviewJsonSchema.properties,
              partiallyPerformedSourceEventBeatIndexes: {type: "array", items: {type: "integer", minimum: 0}, maxItems: 32,
                description: "Beat indexes whose action is visibly begun or partly performed, but not fully completed. Include partial unselected player acts; never credit these as complete."},
            },
            required: [...scenePresenceReviewJsonSchema.required, "partiallyPerformedSourceEventBeatIndexes"],
          } : scenePresenceReviewJsonSchema,
        },
      },
    };
    let openingProgressRecheckInstruction = "";
    let openingProgressRecheckUsed = false;
    for (
      let attempt = 0;
      attempt < SCENE_PRESENCE_REVIEW_OUTPUT_TOKENS.length;
      attempt += 1
    ) {
      const response = await this.createResponse("scene presence review", state.book.bookId, {
        ...request,
        instructions: [
          request.instructions,
          openingProgressRecheckInstruction,
        ].filter(Boolean).join("\n"),
        max_output_tokens: SCENE_PRESENCE_REVIEW_OUTPUT_TOKENS[attempt],
      });
      let failure: Error | undefined;
      let review: ScenePresenceReview | undefined;
      if (response.status === "incomplete") {
        const details = JSON.stringify(response.incomplete_details) ?? "no details";
        failure = new Error(
          `AI scene presence review returned an incomplete response: ${details}`,
        );
        if (!details.includes("max_output_tokens")) throw failure;
      } else {
        try {
          review = parseAiJson<ScenePresenceReview>(
            response.output_text,
            "OpenAI scene presence review",
          );
          const previousCompletedBeatIndexes =
            previousCompletedEventBeatIndexes;
          const reportedCompletedBeatIndexes =
            Array.isArray(review.completedSourceEventBeatIndexes)
              ? review.completedSourceEventBeatIndexes
              : [];
          const beatCount = eventReviewTarget?.beats?.length ?? 0;
          const startBeatIndex = state.sourceEventProgress?.eventId === eventReviewTarget?.eventId ? state.sourceEventProgress?.startBeatIndex ?? 0 : 0;
          review.completedSourceEventBeatIndexes =
            contiguousReportedSourceBeatIndexes(
              previousCompletedBeatIndexes,
              reportedCompletedBeatIndexes,
              beatCount,
              startBeatIndex,
            );
          review.latestVisibleSourceEventId =
            reviewedSourceEventIdForBeatProgress(
              eventReviewTarget?.eventId,
              review.latestVisibleSourceEventId,
              review.completedSourceEventBeatIndexes,
              beatCount,
              startBeatIndex,
            );
          if (
            eventReviewTarget?.eventId
            && reportedCompletedBeatIndexes.length > 0
            && beatCount > 0
            && review.completedSourceEventBeatIndexes.length + startBeatIndex === beatCount
          ) {
            review.latestVisibleSourceEventId = eventReviewTarget.eventId;
          }
          if (!review.turnValidation && (futurePlayerActions.length === 0 || futurePlayerActions.every(
            (action) => review!.completedSourceEventBeatIndexes.includes(action.beatIndex),
          ))) {
            review.futureActionSetupRequired = false;
            review.futureActionSetupSupported = true;
            review.futureActionSetupReason = "No uncompleted player action remains in the reviewed event.";
          }

          const firstOpeningPlayerBeatIndex = openingProgressionReview
            ? futurePlayerActions
                .map((action) => action.beatIndex)
                .filter((index) => Number.isInteger(index) && index >= 0)
                .sort((left, right) => left - right)[0]
            : undefined;
          const completedOpeningBeatIndexes = new Set([
            ...previousCompletedEventBeatIndexes,
            ...review.completedSourceEventBeatIndexes,
          ]);
          let completedOpeningPrefixLength = 0;
          while (
            completedOpeningPrefixLength < (firstOpeningPlayerBeatIndex ?? 0)
            && completedOpeningBeatIndexes.has(completedOpeningPrefixLength)
          ) {
            completedOpeningPrefixLength += 1;
          }
          if (
            firstOpeningPlayerBeatIndex !== undefined
            && firstOpeningPlayerBeatIndex > 0
            && completedOpeningPrefixLength < firstOpeningPlayerBeatIndex
            && !openingProgressRecheckUsed
            && (!review.turnValidation || review.turnValidation.findings.every(
              finding => finding.code === "missing_required_progress" || finding.code === "out_of_order_progress",
            ))
          ) {
            openingProgressRecheckUsed = true;
            openingProgressRecheckInstruction = [
              "OPENING PROGRESS RECHECK:",
              `The previous parseable review omitted one or more ordered opening prelude beats before player beat ${firstOpeningPlayerBeatIndex}.`,
              `Re-read candidate_scene.text and explicitly reassess prelude beats ${completedOpeningPrefixLength}-${firstOpeningPlayerBeatIndex - 1} one by one.`,
              "Credit a beat when its action is visibly enacted with semantically equivalent wording; do not require a verbatim phrase match.",
              "Do not require or complete the future player beat or any later beat. Return only the visibly completed contiguous opening prefix.",
            ].join("\n");
            flowDiagnostic(
              `${this.client.provider} scene presence review omitted opening prelude progress; rechecking once before regenerating the scene.`,
            );
            attempt -= 1;
            continue;
          }
        } catch (error) {
          if (!(error instanceof InvalidAiJsonError)) throw error;
          failure = error;
        }
      }
      if (review) {
        const acceptedEvent = reviewedVisibleSourceEvent(
          sourceCandidates[0],
          review.latestVisibleSourceEventId,
        );
        if (sourceCandidates.length > 0) {
          flowDiagnostic(
            "OpenAI scene presence review: "
            + `reportedEvent=${review.latestVisibleSourceEventId ?? "none"}; `
            + `acceptedEvent=${acceptedEvent?.eventId ?? "none"}; `
            + `currentEvent=${sourceCandidates[0]?.currentStoryEvent?.eventId ?? "none"}; `
            + `targetEvent=${eventReviewTargetId ?? "none"}; `
            + `completedBeats=[${review.completedSourceEventBeatIndexes.join(",")}]`,
          );
        }
        return review;
      }
      if (attempt === SCENE_PRESENCE_REVIEW_OUTPUT_TOKENS.length - 1) {
        throw failure;
      }
      flowDiagnostic(
        `${this.client.provider} scene presence review response was incomplete; `
        + `retrying with ${SCENE_PRESENCE_REVIEW_OUTPUT_TOKENS[attempt + 1]} output tokens.`,
      );
    }
    throw new Error("AI scene presence review exhausted its response attempts");
  }

  protected async sceneChoices(
    setting: Scene,
    state: GameState,
    sourceCandidates: readonly SourceContinuationCandidate[],
    consumedAction?: string,
    completedSourceEventId?: string,
    initialAcceptedChoices: Scene["choices"] = [],
    initialRejectedChoices: Array<string | ChoiceRejectionFeedback> = [],
    explicitlyUnavailableCharacters: readonly string[] = sourceCandidates.flatMap(
      (candidate) => candidate.unavailableCharacters ?? [],
    ),
    completedAction?: CompletedSceneAction,
    alternativesOnly = false,
  ): Promise<Scene["choices"]> {
    const maxAttempts = 4;
    const nextSignificantEvent = alternativesOnly ? null : buildSourceChoiceNavigationContext(
      sourceCandidates[0],
      state.playerName,
      state.characterProfiles,
      completedSourceEventId,
      setting.sceneScope,
    );
    const choiceBeatState = buildSourceEventChoiceBeatState(
      nextSignificantEvent,
      state.sourceEventProgress,
    );
    const sourceEventBeatProgress = choiceBeatState.progress;
    const remainingNextSignificantEvent = choiceBeatState.remainingEvent;
    const currentSignificantEvent =
      reviewedVisibleSourceEvent(sourceCandidates[0], completedSourceEventId)
      ?? (
        choiceBeatState.hasOrderedBeats
          ? choiceBeatState.completedEvent
          : sourceCandidates[0]?.currentStoryEvent ?? null
      );
    const requiredPlayerChoiceBeats = sourceEventNextPlayerChoiceBeats(
      remainingNextSignificantEvent,
      state.playerName,
      state.characterProfiles,
    );
    const requiresExplicitPlayerChoice = sourceEventHasReadyPlayerChoice(
      remainingNextSignificantEvent,
      state.playerName,
      state.characterProfiles,
      setting.sceneScope,
    );
    const playerProfile = findPlayerCharacterProfile(
      state.playerName,
      state.characterProfiles,
    );
    let rejectedChoices: ChoiceRejectionFeedback[] = initialRejectedChoices.map(choice =>
      typeof choice === "string" ? {text: choice, role: "unknown", reason: "Rejected by an earlier executability filter; reassess against the visible setting."} : choice);
    let acceptedChoices = [...initialAcceptedChoices];
    let filteredAnchorRetryConsumed = false;
    const requiredPlayerFallbackChoices = (
      choices: Scene["choices"],
    ): Scene["choices"] => {
      const fallback = buildRequiredPlayerChoiceFallback(
        remainingNextSignificantEvent,
        state.playerName,
        state.characterProfiles,
        setting.sceneScope,
        currentTurnExecution()?.contract.nextPlayerAction?.choiceText,
      );
      if (!fallback) return choices;
      const combined = removeDuplicateChoices({
        ...setting,
        choices: repairGeneratedChoices([fallback, ...choices]),
      }).choices.slice(0, 4);
      if (combined.length >= 2) return combined;
      const playerIdentities = new Set(
        [state.playerName, ...(playerProfile ? [playerProfile.name, ...playerProfile.aliases] : [])]
          .map((name) => name.normalize("NFKC").trim().toLocaleLowerCase()),
      );
      const talkTarget = setting.sceneScope?.peopleWithinSpeakingDistance.find(
        (name) => !playerIdentities.has(name.normalize("NFKC").trim().toLocaleLowerCase())
          && !spokenDialogueCapabilityFailure(state.playerName, name, state.characterProfiles),
      );
      return [
        ...combined,
        ...(talkTarget
          ? [{
              id: "__bookrpg_required_player_choice_alternative__",
              type: "talk" as const,
              text: `Talk to ${talkTarget}`,
              character: talkTarget,
              requiredPresentCharacters: [talkTarget],
              requiredAbsentCharacters: [],
              stakes: "routine" as const,
            }]
          : [{
              id: "__bookrpg_required_player_choice_alternative__",
              type: "action" as const,
              text: "Pause and consider another course",
              requiredPresentCharacters: [],
              requiredAbsentCharacters: [],
              stakes: "routine" as const,
            }]),
      ];
    };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await this.createResponse("scene choices", state.book.bookId, {
        model: this.model,
        reasoning: { effort: this.reasoningEffort },
        instructions: [
          "You generate only the next player choice menu for an already completed BookRPG scene.",
          "The supplied setting is authoritative. Do not rewrite it, assume unshown events happened, or move time forward.",
          "setting.text, setting.development, setting.outcomeReason, and completed_action describe state already completed before the new decision point. Never offer a choice that reenacts, reconfirms, rehearses, or paraphrases that completed action or result.",
          "Return 2 to 4 distinct, immediately playable choices grounded in concrete facts visible in setting.",
          "Write every choice from player_identity's perspective, with player_identity as its implicit actor. Never describe player_identity or any player_identity_aliases as a separate named participant, target, or non-player character.",
          "player_identity is physically present at setting.sceneScope.currentLocation by definition and belongs in both peoplePresent and peopleWithinSpeakingDistance. Never treat the player as absent.",
          "current_significant_event is the latest source event already completed in the player-facing timeline. Every listed beat is complete and must not be offered, prepared for, or finished again.",
          "When setting.development conflicts with a later confirmed end state in setting.text or setting.outcomeReason, the confirmed end state wins and the stale development must not shape a choice.",
          ...CHOICE_TIMELINE_RULES,
          ...SOURCE_RECOUNTING_RULES,
          alternativesOnly
            ? "CANONICAL ALTERNATIVES ONLY: the server owns and injects choice 1. Generate only free-world alternatives; do not reproduce, paraphrase, route toward, or replace the canonical anchor."
            : currentTurnExecution()?.contract.nextPlayerAction
              ? "Choice 1 must offer the indexed player goal goal in required_anchor_decision. This single decision includes the indexed continuation across automatic beats, but never the next distinct goal."
              : "When next_significant_event.beats is present, use setting.text and their order to preserve decision boundaries. Skip beats already visibly completed in setting, then make choice 1 authorize only the earliest remaining contiguous player-controlled decision. A later player beat after an intervening NPC, external, involuntary, or routine beat must remain a future choice.",
          ...(requiresExplicitPlayerChoice
            ? [
                "next_significant_event requires an explicit player choice. Choice 1 (choices[0]) must directly propose the concrete player-controlled act described by that event when it is executable from the visible setting.",
                currentTurnExecution()?.contract.nextPlayerAction
                  ? "required_player_choice_beats describes the first atomic act of the indexed player goal. Use the full player goal for the menu text; the turn contract defines its endpoint."
                  : "required_player_choice_beats lists only the immediately eligible player decision, excluding later decisions behind an unfinished NPC beat. Ignore those already visibly completed in setting, then make choice 1 clearly authorize the earliest remaining contiguous player decision without also authorizing a later decision beyond an intervening beat.",
                "For ordered beats, use sourceAnchorRoute 'event' when choice 1 directly enables or selects source_event_beat_progress.nextRequiredBeat. Later uncompleted player decisions remain future and do not require route transition. Use transition only when the next beat itself still needs an unmet prerequisite.",
                "If the earliest remaining player decision cannot begin from the visible setting, steer choice 1 toward the single closest concrete prerequisite and classify it as 'transition'.",
                "Do not dilute that act into generic movement, continued travel, waiting, watching, scanning, preparation, safety-seeking, or another merely adjacent step. Those actions do not provide informed consent for the event.",
                "If an absent co-actor is not needed for the player's executable part of the event, omit interaction with that co-actor and still name the concrete act involving the present participants or targets.",
                "Only when the concrete player act truly cannot begin without an absent participant or unmet physical prerequisite may choice 1 propose the single immediate transition that establishes that prerequisite.",
              ]
            : [
                "When next_significant_event is supplied, use it as a hidden navigation target for choice 1 (choices[0]). Formulate the strongest immediate, voluntary, causally plausible step that lets its involuntary, external, non-player, or routine beats follow without exposing the future event.",
              ]),
          "When the first remaining ordered beat belongs to an NPC or the world, route choice 1 toward that beat before any later player decision. Do not substitute another shielding, crouching, preparing, or reconfirming action already completed in setting. A bounded wait may enable an independently occurring beat; it must lead to observable change when resolved.",
          "For next_significant_event.beats not listed in required_player_choice_beats, choice 1 should establish the immediate causal conditions for them to follow in order; never phrase an NPC, external, routine, or involuntary beat as an action controlled by the player.",
          "When next_significant_event exists, classify choices[0] with sourceAnchorRoute. For ordered events, event means resolving the next required beat, not all remaining beats. For events without beats, event still means completing the event. Use transition for an unmet prerequisite to that immediate target.",
          "sourceAnchorRoute 'event' does not merely mean that choices[0] is the preferred route. For an event requiring explicit player choice, the choice text must concretely authorize its player-controlled beat. For an event needing no explicit player choice, the wording need not reveal or consent to the future occurrence, but it must create a direct causal bridge.",
          "Set sourceAnchorRoute to null on choices[1+] and on every choice when next_significant_event is absent.",
          "next_significant_event describes a possible future state; it does not make its actors or targets present in the current setting.",
          "Characters listed in next_significant_event.currentlyAbsentCharacters remain absent now. Choice 1 may create or accept a transition toward their arrival, but must not greet, address, touch, observe, or otherwise interact with them before the next scene visibly establishes their arrival.",
          "When the next event is an absent non-player character's arrival or return, end choice 1 at an immediate prerequisite or transition point. Selecting the anchor choice lets the next scene depict the arrival; do not write the post-arrival interaction into the choice itself.",
          "Choice 1 must not state unrevealed future knowledge, name the future event as inevitable, guarantee an uncertain result, or make the event happen already. It should express only the concrete action the player can take now.",
          ...INFORMED_PLAYER_CHOICE_RULES,
          ...(requiresExplicitPlayerChoice
            ? [
                "If the exact outcome is uncertain, phrase choice 1 as an honest attempt at the required player act rather than substituting an unrelated local action.",
              ]
            : [
                "If the visible setting offers no honest causal route toward next_significant_event, make choice 1 the strongest local story-advancing action instead of inventing a clue, arrival, object, or relationship.",
              ]),
          alternativesOnly
            ? "Return 2 to 3 distinct free-world alternatives. Every returned item is an alternative; the canonical anchor is deliberately absent from this request."
            : "Generate choices[1+] as distinct free-world alternatives. They may radically change the story through an immediately executable player action; they need not help, preserve or return to the canonical route.",
          "Do not infer future revelations, decisions, plans, objects, crimes, arrivals, or other developments from book familiarity.",
          "Choices may explore plausible immediate alternatives without breaking established chronology.",
          "current_significant_event is authoritative completed state. Preserve all irreversible consequences it establishes, including deaths, injuries, departures, disclosures, consumed or destroyed objects, and changed relationships.",
          "Do not offer conversation, rehearsal for conversation, waiting, preparation, or another future interaction with a character whose death or permanent departure is established by current_significant_event.",
          "Check every choice against the complete setting text before returning it. The final menu must preserve who is already present, who has already arrived, current locations, object states, and completed events.",
          "Use setting.sceneScope as authoritative spatial scope. A talk choice may target only a character in peopleWithinSpeakingDistance. People absent from peoplePresent cannot be treated as if they are in the current location.",
          "For every action choice that directly interacts with a named non-player character — for example greeting, welcoming, handing something to, touching, kissing, questioning, or starting an exchange with them — that character must already be in setting.sceneScope.peoplePresent. If they are absent, do not generate the interaction; generate only actions executable before their arrival or another visible prerequisite.",
          "If a character is visibly present in setting, never offer waiting for that character to arrive or return, preparing for their arrival, observing for signs before they arrive, or imagining a conversation as a substitute for talking to the present character.",
          "Never mention or interact with a character unless that character appears in setting or source_introduced_characters.",
          "Do not offer an action that presupposes a future arrival, discovery, conversation, object state, or relationship change.",
          "Return the complete repaired menu, retaining usable accepted_choices without duplication. rejected_choices contains text, prior role and concrete reason: repair the stated defect, not just the wording. A routing defect applies only to the anchor slot and never bans that action as an executable alternative. Do not repeat consumed_action.",
          "A talk choice only starts a conversation: use type 'talk', text exactly 'Talk to <character>', and set character.",
          "For an action choice, set character to the exact known character name only when that person's physical participation is required to perform the action now. Set character to null when the action merely mentions, prepares for, waits for, calls out for, listens or watches for, thinks about, or changes an object intended for an absent person.",
          "For every choice, classify spatial prerequisites in requiredPresentCharacters and requiredAbsentCharacters using exact known non-player character names.",
          "A choice that waits for, prepares for, calls out for, listens for, watches for, or otherwise presupposes someone's future arrival must list that person in requiredAbsentCharacters. A choice that greets, starts an exchange with, touches, hands something to, or observes an immediate reaction from someone must list that person in requiredPresentCharacters.",
          "Never return a choice whose requiredAbsentCharacters already appears in setting.sceneScope.peoplePresent or whose requiredPresentCharacters is absent from setting.sceneScope.peoplePresent.",
          ...CHOICE_STAKES_RULES,
          ...PLAYER_EMBODIMENT_RULES,
          `You are ${state.playerName} and all the generated options will be from your perspective`
        ].join("\n"),
        input: JSON.stringify({
          setting: {
            title: setting.title,
            text: setting.text,
            development: setting.development ?? null,
            outcomeReason: setting.outcomeReason ?? null,
            sceneScope: setting.sceneScope ?? null,
          },
          player_identity: state.playerName,
          runtime_parameters: state.parameters ?? [],
          player_identity_aliases: playerProfile
            ? [playerProfile.name, ...playerProfile.aliases]
            : [],
          source_introduced_characters: state.sourceIntroducedCharacters ?? [],
          current_significant_event: currentSignificantEvent,
          next_significant_event: remainingNextSignificantEvent ? {
            ...remainingNextSignificantEvent,
            requiresExplicitPlayerChoice,
          } : null,
          upcoming_source_excerpt: alternativesOnly
            ? null
            : sourceCandidates[0]?.excerpt.slice(0, SOURCE_GROUNDING_EXCERPT_CHARS) ?? null,
          source_event_beat_progress: alternativesOnly ? null : sourceEventBeatProgress,
          required_player_choice_beats: alternativesOnly ? [] : requiredPlayerChoiceBeats,
          unavailable_characters: explicitlyUnavailableCharacters,
          consumed_action: consumedAction ?? null,
          completed_action: completedAction ?? null,
          accepted_choices: acceptedChoices,
          rejected_choices: rejectedChoices,
        }, null, 2),
        text: {
          format: {
            type: "json_schema",
            name: "bookrpg_scene_choices",
            strict: true,
            schema: sceneChoiceMenuJsonSchema,
          },
        },
        max_output_tokens: 1_600 * (attempt + 1),
      });
      if (response.status === "incomplete") {
        const details = JSON.stringify(response.incomplete_details) ?? "no details";
        if (!details.includes("max_output_tokens")) {
          throw new Error(`AI scene choices response was incomplete: ${details}`);
        }
        flowDiagnostic(
          `OpenAI scene choices draft ${attempt + 1}/${maxAttempts} incomplete: ${details}`,
        );
        continue;
      }

      let generated: Pick<Scene, "choices">;
      try {
        generated = parseAiJson<Pick<Scene, "choices">>(
          response.output_text,
          "OpenAI scene choices",
        );
      } catch (error) {
        if (!(error instanceof InvalidAiJsonError)) throw error;
        if (attempt === maxAttempts - 1) {
          return requiresExplicitPlayerChoice
            ? []
            : addSourceContinuationChoiceFallback(
                setting,
                sourceContinuationChoiceText(sourceCandidates[0]),
              ).choices;
        }
        continue;
      }
      const repairedChoices = repairGeneratedChoices(generated.choices);
      const combinedChoices = repairGeneratedChoices([
        ...repairedChoices,
        ...acceptedChoices,
      ]);
      const withGeneratedChoices = { ...setting, choices: combinedChoices };
      const withoutConsumedAction = consumedAction
        ? removeConsumedActionChoices(withGeneratedChoices, consumedAction)
        : withGeneratedChoices;
      const withoutCompletedSourceEvent = removeChoicesRepeatingCompletedSourceEvent(
        withoutConsumedAction,
        currentSignificantEvent,
      );
      const withoutInvalidPlayerPerspective =
        removeChoicesWithPlayerIdentityReferences(
          withoutCompletedSourceEvent,
          state.playerName,
          state.characterProfiles,
        );
      const withoutUnavailableCharacters = removeChoicesWithUnintroducedCharacters(
        withoutInvalidPlayerPerspective,
        state,
        visibleSourceEventNarrative(sourceCandidates),
        explicitlyUnavailableCharacters,
      );
      const withoutImpossibleSpeech = {...withoutUnavailableCharacters, choices: withoutUnavailableCharacters.choices.filter(choice => {
        if (choice.type !== "talk") return true;
        const target = choice.character?.trim() || /^talk to\s+(.+?)\s*$/iu.exec(choice.text)?.[1]?.trim() || "";
        const failure = spokenDialogueCapabilityFailure(state.playerName, target, state.characterProfiles);
        return !failure;
      })};
      const withoutDuplicates = removeDuplicateChoices(withoutImpossibleSpeech);
      const filteredResult = removeRecentChoiceParaphrases(
        withoutDuplicates,
        state.history,
      );
      const filtered = {
        ...filteredResult,
        choices: filteredResult.choices.slice(0, 4),
      };
      const firstGeneratedChoiceWasFiltered = firstChoiceWasFiltered(
        repairedChoices,
        filtered.choices,
        filtered.outcome,
      );
      const generatedAnchor = repairedChoices[0];
      const choiceSurvives = (testedChoice: Scene["choices"][number], candidate: Scene): boolean => Boolean(
        testedChoice
        && candidate.choices.some(
          (choice) =>
            choice.id === testedChoice.id
            && choice.text === testedChoice.text,
        ),
      );
      const filterReason = (testedChoice: Scene["choices"][number]): string | undefined =>
        !choiceSurvives(testedChoice, withoutConsumedAction)
          ? "it repeats the consumed player action"
          : !choiceSurvives(testedChoice, withoutCompletedSourceEvent)
            ? "it repeats a beat from the latest completed source event"
          : !choiceSurvives(testedChoice, withoutInvalidPlayerPerspective)
            ? "it names or targets the player identity as a separate character"
            : !choiceSurvives(testedChoice, withoutUnavailableCharacters)
              ? "it targets a character who is absent, unavailable, or outside the confirmed SceneScope"
              : !choiceSurvives(testedChoice, withoutImpossibleSpeech)
                ? "spoken dialogue is impossible for the indexed player or target"
              : !choiceSurvives(testedChoice, withoutDuplicates)
                ? "it duplicates another generated or previously accepted choice"
                : !choiceSurvives(testedChoice, filteredResult)
                  ? "it paraphrases a recent player choice"
                  : choiceSurvives(testedChoice, filtered)
                    ? undefined
                    : "it fell outside the four-choice menu limit";
      const anchorFilterReason = generatedAnchor ? filterReason(generatedAnchor) : "the response did not contain a first choice";
      const hasTooFewChoices = hasTooFewChoicesForActiveScene(filtered);
      const retryFilteredAnchor: boolean =
        Boolean(nextSignificantEvent)
        && firstGeneratedChoiceWasFiltered
        && !hasTooFewChoices
        && !filteredAnchorRetryConsumed;
      if (
        !hasTooFewChoices
        && !retryFilteredAnchor
      ) {
        if (!nextSignificantEvent) return filtered.choices;
        if (requiresExplicitPlayerChoice) {
          return requiredPlayerFallbackChoices(filtered.choices);
        }
        return firstGeneratedChoiceWasFiltered
          ? addSourceContinuationAnchorChoice(
              filtered,
              sourceContinuationChoiceText(sourceCandidates[0]),
            ).choices
          : promoteAnchorChoice(
              filtered,
              0,
              nextSignificantEvent.eventId ?? undefined,
            ).choices;
      }
      if (attempt === maxAttempts - 1) {
        return requiresExplicitPlayerChoice
          ? requiredPlayerFallbackChoices(filtered.choices)
          : addSourceContinuationAnchorChoice(
              filtered,
              sourceContinuationChoiceText(sourceCandidates[0]),
            ).choices;
      }
      const rejectedOnThisAttempt: ChoiceRejectionFeedback[] = repairedChoices
        .filter((choice) =>
          !filtered.choices.some(
            (survivor) =>
              survivor.id === choice.id && survivor.text === choice.text,
          )
        )
        .map((choice) => ({text: choice.text, role: choice === generatedAnchor ? "anchor" : "alternative",
          reason: filterReason(choice) ?? "The choice did not survive executability filtering."}));
      acceptedChoices = filtered.choices;
      filteredAnchorRetryConsumed ||= retryFilteredAnchor;
      rejectedChoices = [...new Map([...rejectedChoices, ...rejectedOnThisAttempt]
        .map(choice => [JSON.stringify([choice.text, choice.role, choice.reason]), choice])).values()];
      flowDiagnostic(
        `OpenAI scene choices draft ${attempt + 1}/${maxAttempts} rejected: `
        + (
          retryFilteredAnchor
            ? `The model-generated choices[0] candidate ${JSON.stringify(generatedAnchor?.text ?? "")} `
              + `could not serve as the anchor because ${anchorFilterReason ?? "it did not survive filtering"}; retrying once.`
            : `Only ${filtered.choices.length} distinct usable choice(s) remained; at least 2 are required.`
        ),
      );
    }
    return requiresExplicitPlayerChoice
      ? requiredPlayerFallbackChoices([])
      : addSourceContinuationChoiceFallback(
          setting,
          sourceContinuationChoiceText(sourceCandidates[0]),
        ).choices;
  }
}


