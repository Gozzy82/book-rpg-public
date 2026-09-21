import { buildDialogueContinuationInstruction } from "./scene-context.js";
import { completedCharacterEventSequence } from "./character-runtime.js";
import { spokenDialogueCapabilityFailure } from "../../shared/character-dynamics.js";
import { withBoundedOpeningEvidence } from "./opening-source-evidence.js";
import { resolveTurnPlan } from "./turn-planner.js";
import type { AiResponse, AiResponseRequest } from "../provider.js";
import { ProviderGameEngine } from "./provider-game-engine.js";
import { BookRpgResponsePipeline } from "./provider-bookrpg-engine.js";
import { advanceCompletedSourceEventCandidates, withIsolatedSplitOpeningRequest } from "./provider-paced-bookrpg-engine.js";
import { hasAutomaticOrderedSourceBoundary, withoutAiSourceReferences, withCurrentBeatSourceExcerpt, withOpeningPreludeSourceExcerpts, withHiddenOpeningControlData, withSinglePhaseOpeningPrelude, withAddressedActionResponseReview, stripOpeningControlDataLeak, } from "./provider-guarded-paced-bookrpg-engine.js";
import { withPlayerIdentitySourceNarration, withConcreteAutomaticSceneWindow, normalizeSelectedOptionPlayerAction, enforceFirstPersonPlayerIdentity } from "./provider-e2e-recovery-engine.js";
import { withNonInteractableConsistencyContract } from "./provider-e2e-hardening-engine.js";
import { addSourceContinuationChoiceFallback, sourceContinuationChoiceText } from "./scene-validation.js";
import { nextSignificantEventForCandidate } from "./source-navigation.js";
import { currentTurnExecution, planTurn, runPlannedTurn } from "./turn-contract.js";
/** Production orchestration: request preparation, writer/compliance, transport, one evidence reducer.
 * Legacy adapters remain import-compatible but cannot rewrite production review decisions.
 */
export class TurnPipelineGameEngine extends ProviderGameEngine {
  protected override readonly centralReviewValidation = true;
  private readonly pipeline = new BookRpgResponsePipeline(this.model, (label, bookId, request) => super.createResponse(label, bookId, request), true);
  protected override async createResponse(label: string, bookId: string, request: AiResponseRequest): Promise<AiResponse> {
    let prepared = withPlayerIdentitySourceNarration(label, request);
    if (!currentTurnExecution()) prepared = withConcreteAutomaticSceneWindow(label, prepared);
    prepared = withoutAiSourceReferences(prepared);
    if (!currentTurnExecution()) prepared = withCurrentBeatSourceExcerpt(label, prepared);
    prepared = withOpeningPreludeSourceExcerpts(label, prepared);
    prepared = withHiddenOpeningControlData(label, prepared);
    prepared = withSinglePhaseOpeningPrelude(label, prepared);
    prepared = withIsolatedSplitOpeningRequest(label, prepared);
    prepared = withAddressedActionResponseReview(label, prepared);
    prepared = withNonInteractableConsistencyContract(label, prepared);
    prepared = withBoundedOpeningEvidence(label, prepared);
    if (label === "scene" && currentTurnExecution()) prepared = {...prepared, max_output_tokens: Math.max(prepared.max_output_tokens ?? 0, 2400)};
    let response = await this.pipeline.execute(label, bookId, prepared);
    if (label === "scene") {
      // Historical selected_option text in repair context is not a new action.
      if (currentTurnExecution()?.contract.selectedIntent) response = normalizeSelectedOptionPlayerAction(prepared, response);
      response = stripOpeningControlDataLeak(request, response);
      const contract = currentTurnExecution()?.contract;
      if (contract?.sourceBeatSelection && response.status === "completed") {
        // This field identifies the selected action, not evidence that it succeeded.
        // The server owns it for a clicked anchor; prose/outcomes still require review.
        try {
          const value = JSON.parse(response.output_text);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            response = {...response, output_text: JSON.stringify({...value, playerAction: contract.selectedIntent})};
          }
        } catch { /* Preserve malformed output for the normal generation retry. */ }
      }
    }
    if (label === "scene repetition review") response = enforceFirstPersonPlayerIdentity(prepared, response);
    return response;
  }
  protected override scene(...args: Parameters<ProviderGameEngine["scene"]>) {
    const [, state, selectedIntent, candidates = [], , mode = "interactive_turn", requiredSourceEvent = false, , sourceBeatSelection] = args;
    const input = { state, selectedIntent, sourceBeatSelection,
      currentEventSequence: completedCharacterEventSequence(state, candidates, mode === "opening"),
      sourceProgression: requiredSourceEvent || mode === "opening" ? "required" as const : "optional" as const,
      sourceReferenceExcerpts: candidates[0]?.sourceReferenceExcerpts,
      followingEvents: candidates[0]?.storyEvents,
      sourceEventEntries: candidates[0]?.sourceEventEntries,
      mode: mode === "opening" ? "opening" as const : mode === "observed_scene_progression" ? "observe" as const : mode === "source_continuation" ? "source_continue" as const : "action" as const,
      event: mode === "opening" ? candidates[0]?.currentStoryEvent ?? nextSignificantEventForCandidate(candidates[0])
        : nextSignificantEventForCandidate(candidates[0]),
    };
    return runPlannedTurn(planTurn(input), async () => {
      const contract = await resolveTurnPlan(input, this.model,
        request => this.createResponse("turn intent review", state.book.bookId, request));
      return runPlannedTurn(contract, () => super.scene(...args));
    });
  }
  override continueDialogue(...args: Parameters<ProviderGameEngine["continueDialogue"]>) {
    const [state, character, playerText, candidates = [], options = {}] = args;
    const failure = spokenDialogueCapabilityFailure(state.playerName, character, state.characterProfiles);
    if (failure) throw new Error(failure);
    const currentEventSequence = completedCharacterEventSequence(state, candidates);
    const initial = planTurn({ state, currentEventSequence, mode: "dialogue", selectedIntent: playerText,
      event: nextSignificantEventForCandidate(candidates[0]) });
    return runPlannedTurn(initial, async () => {
      const routed = options.anchorDirected
        ? await this.anchorRouteCandidates(state, candidates, options.sourceEventId) : candidates;
      const contract = await resolveTurnPlan({state, currentEventSequence, mode: "dialogue", selectedIntent: playerText,
        sourceProgression: options.anchorDirected && options.sourceAnchorRoute !== "transition" ? "required" : "optional",
        sourceReferenceExcerpts: routed[0]?.sourceReferenceExcerpts,
        event: nextSignificantEventForCandidate(routed[0])}, this.model,
        request => this.createResponse("turn intent review", state.book.bookId, request));
      return runPlannedTurn(contract, () => contract.selectedPlayerAction
        ? super.scene(buildDialogueContinuationInstruction(state.playerName, character, playerText), state, playerText,
            routed, 4, "interactive_turn", contract.sourceProgression === "required")
        : this.resolveDialogue(state, character, playerText, routed, options));
    });
  }
  override startTalk(...args: Parameters<ProviderGameEngine["startTalk"]>) {
    const [state, character, candidates = []] = args;
    const failure = spokenDialogueCapabilityFailure(state.playerName, character, state.characterProfiles);
    if (failure) throw new Error(failure);
    return runPlannedTurn(planTurn({state, mode: "dialogue", sourceProgression: "optional",
      currentEventSequence: completedCharacterEventSequence(state, candidates)}), () => super.startTalk(...args));
  }
  override refreshSceneChoices(...args: Parameters<ProviderGameEngine["refreshSceneChoices"]>) {
    const [state, candidates] = args;
    return runPlannedTurn(planTurn({state, mode: "observe", sourceProgression: "required",
      event: nextSignificantEventForCandidate(candidates[0]),
      currentEventSequence: completedCharacterEventSequence(state, candidates)}), () => super.refreshSceneChoices(...args));
  }
  override continueFromSource(...args: Parameters<ProviderGameEngine["continueFromSource"]>) {
    return super.continueFromSource(args[0], advanceCompletedSourceEventCandidates(...args));
  }
  protected override async sceneChoices(...args: Parameters<ProviderGameEngine["sceneChoices"]>) {
    const [setting, state, candidates, , completedEventId] = args;
    // A pending automatic boundary has no new player decision. Do not generate and discard a menu.
    if (!setting.sourceActionOutcome && currentTurnExecution()?.contract.sourceProgression !== "optional" && hasAutomaticOrderedSourceBoundary(setting, state, candidates, completedEventId)) {
      return addSourceContinuationChoiceFallback({ ...setting, choices: [] }, sourceContinuationChoiceText(candidates[0])).choices;
    }
    const planned = currentTurnExecution()?.contract;
    const contract = planTurn({state: {...state, scene: setting}, mode: "observe",
      sourceProgression: setting.sourceActionOutcome || planned?.sourceProgression === "optional" ? "optional" : "required",
      event: nextSignificantEventForCandidate(candidates[0], completedEventId),
      currentEventSequence: completedCharacterEventSequence(state, candidates)});
    return runPlannedTurn(contract, () => super.sceneChoices(...args));
  }
}

