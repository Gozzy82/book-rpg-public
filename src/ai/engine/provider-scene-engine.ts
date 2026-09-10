import { flowDiagnostic } from "../../util/flow-trace.js";
import type {
  ChoiceStakes,
  GameState,
  Scene,
  StoryEventBeat,
  StoryMemory,
  SceneScope,
} from "../../shared/contracts.js";
import {
  sceneSettingJsonSchemaForSourceChapters,
} from "../schema.js";
import {
  InvalidAiJsonError,
  SceneGenerationError,
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
  stripEmbeddedChoiceMenu,
} from "./normalization.js";
import {
  findPlayerCharacterProfile,
  buildPlayerPerspective,
} from "./player.js";
import {
  ProviderSceneReviewer,
} from "./provider-scene-reviewer.js";
import {
  COMPACT_SCENE_STYLE_RULES,
  OBSERVED_SCENE_PROGRESSION_STYLE_RULES,
  SOURCE_GROUNDING_RULES,
  TURN_SCOPE_RULES,
  SCENE_SCOPE_RULES,
  RUNTIME_PARAMETER_RULES,
  STORY_MEMORY_RULES,
  SCENE_TITLE_RULES,
} from "./rules.js";
import {
  sceneUsesUnexpectedWritingSystem,
  buildWritingSystemReference,
  sceneRepeatsRecentNarrative,
  reviewedUnusableChoiceIndexes,
  hasPriorPlayerFacingScene,
  buildSceneRegenerationInstruction,
  buildGameContext,
} from "./scene-context.js";
import type {
  SceneRepetitionReview,
} from "./scene-context.js";
import {
  stripLeakedSceneMetadata,
  sceneLeaksInternalMetadata,
} from "./scene-text.js";
import {
  removeDuplicateChoices,
  removeRecentChoiceParaphrases,
  removeConsumedActionChoices,
  actionResolutionFailures,
  hasTooFewChoicesForActiveScene,
  playerScopeAliases,
  sceneScopeFailures,
  filterSceneScope,
  sceneScopeOrFallback,
  hasSourceContinuationChoiceFallback,
  sourceContinuationChoiceText,
  addSourceContinuationChoiceFallback,
  addSourceContinuationAnchorChoice,
  firstChoiceWasFiltered,
  promoteAnchorChoice,
  filteredAnchorChoiceFailures,
  shouldHandleMissingAnchorChoice,
  applyEstablishedEvent,
  developmentRepeatsHistory,
  removeChoicesWithPlayerIdentityReferences,
  sceneNonInteractableCharacters,
  absentCharacterContinuityFailures,
  repairGeneratedChoices,
  removeChoicesWithUnintroducedCharacters,
} from "./scene-validation.js";
import {
  visibleSourceEventNarrative,
  nextSignificantEventForCandidate,
  sourceSceneBeatReviewTargetId,
  buildSourceEventBeatProgressContext,
  buildSourceEventChoiceBeatState,
  sourceEventFirstPlayerChoiceBeatIndex,
  sourceEventRequiresExplicitPlayerChoice,
  sourceEventPlayerChoiceBeats,
  reviewedVisibleSourceEvent,
  buildRequiredPlayerChoiceFallback,
} from "./source-navigation.js";
import {
  groundedSourceProgress,
  resolveGroundedSourceCandidate,
  reasoningEffortForTurn,
} from "./source.js";
import {
  openingCharacterContinuityFailures,
  buildImmediateTurnTransition,
  isGameStagnating,
  buildStagnationBreakingInstruction,
  buildAnchorChoiceInstruction,
} from "./turn.js";

type SceneGenerationMode = "interactive_turn" | "observed_scene_progression" | "opening";

function sourceBeatLogEntry(beat: StoryEventBeat, index: number) {
  return {
    index,
    actor: beat.actor,
    action: beat.action,
    agency: beat.agency,
    stakes: beat.stakes,
  };
}

export function ensureRequiredPlayerChoiceFirst(
  scene: Scene,
  fallback: Scene["choices"][number] | undefined,
): Scene {
  if (!fallback || (scene.outcome ?? "active") !== "active") return scene;
  const withFallback = removeDuplicateChoices({
    ...scene,
    choices: repairGeneratedChoices([
      fallback,
      ...scene.choices.filter((choice) => choice.id !== fallback.id),
    ]),
  });
  return {
    ...withFallback,
    choices: withFallback.choices.slice(0, 4),
  };
}

export abstract class ProviderSceneEngine extends ProviderSceneReviewer {
  protected async scene(
    instruction: string,
    state: GameState,
    consumedAction?: string,
    sourceCandidates: readonly SourceContinuationCandidate[] = [],
    maxAttempts = 4,
    mode: SceneGenerationMode = "interactive_turn",
    requiredSourceEvent = false,
    choiceStakes?: ChoiceStakes,
  ): Promise<GeneratedScene> {
    const stagnating = isGameStagnating(state);
    let anchorRecoveryRequired = stagnating;
    let anchorChoiceRequired = false;
    const applyStagnationBreak = (
      candidateInstruction: string,
      forceReanchor = false,
    ): string => {
      anchorRecoveryRequired ||= forceReanchor;
      const recoveryInstruction = anchorRecoveryRequired
        ? buildStagnationBreakingInstruction(
            candidateInstruction,
            sourceCandidates.length > 0,
          )
        : candidateInstruction;
      return anchorChoiceRequired
        ? buildAnchorChoiceInstruction(
            recoveryInstruction,
            sourceCandidates.length > 0,
          )
        : recoveryInstruction;
    };
    let turnInstruction = applyStagnationBreak(instruction);
    const openingSourceEvent = mode === "opening"
      ? sourceCandidates[0]?.currentStoryEvent
      : undefined;
    const sourceBeatNavigationEvent = openingSourceEvent
      ?? nextSignificantEventForCandidate(sourceCandidates[0]);
    const sourceBeatProgress = buildSourceEventBeatProgressContext(
      sourceBeatNavigationEvent,
      state.sourceEventProgress,
    );
    const nextRequiredSourceBeat = sourceBeatProgress?.nextRequiredBeat;
    const nextRequiredBeatIsPlayerChoice =
      Boolean(nextRequiredSourceBeat)
      && sourceEventPlayerChoiceBeats(
        sourceBeatNavigationEvent && nextRequiredSourceBeat
          ? {
              ...sourceBeatNavigationEvent,
              beats: [nextRequiredSourceBeat],
            }
          : null,
        state.playerName,
        state.characterProfiles,
      ).length > 0;
    const openingNextRequiredBeatIsPlayerChoice =
      mode === "opening" && nextRequiredBeatIsPlayerChoice;
    const openingFirstPlayerBeatOffset =
      mode === "opening" && sourceBeatNavigationEvent && sourceBeatProgress
        ? sourceEventFirstPlayerChoiceBeatIndex(
            {
              ...sourceBeatNavigationEvent,
              beats: sourceBeatProgress.remainingBeats,
            },
            state.playerName,
            state.characterProfiles,
          )
        : -1;
    const openingFirstPlayerBeatIndex =
      openingFirstPlayerBeatOffset >= 0 && sourceBeatProgress
        ? sourceBeatProgress.completedBeatIndexes.length + openingFirstPlayerBeatOffset
        : -1;
    const openingWordBudget = mode === "opening" ? 300 : 120;
    const requiredSourceBeatProgress =
      requiredSourceEvent && nextRequiredSourceBeat
        ? sourceBeatProgress
        : null;
    const requiredSourceBeatIndex = requiredSourceBeatProgress
      ? requiredSourceBeatProgress.completedBeatIndexes.length
      : undefined;
    if (sourceBeatProgress) {
      const completedCount = sourceBeatProgress.completedBeatIndexes.length;
      flowDiagnostic(
        "OpenAI scene source beat context: "
        + JSON.stringify({
          event_id: sourceBeatProgress.eventId,
          completed_beats: sourceBeatProgress.completedBeats.map(
            (beat, index) => sourceBeatLogEntry(beat, index),
          ),
          next_required_beat: sourceBeatProgress.nextRequiredBeat
            ? sourceBeatLogEntry(
                sourceBeatProgress.nextRequiredBeat,
                completedCount,
              )
            : null,
          remaining_beats: sourceBeatProgress.remainingBeats.map(
            (beat, index) => sourceBeatLogEntry(beat, completedCount + index),
          ),
        }),
      );
    }
    const gameContext = buildGameContext(state, sourceCandidates, mode === "opening");
    const playerProfile = findPlayerCharacterProfile(
      state.playerName,
      state.characterProfiles,
    );
    const playerPerspective = buildPlayerPerspective(
      state.playerName,
      playerProfile,
      mode === "opening",
    );
    const writingSystemReference = buildWritingSystemReference(state);
    const immediateTurnTransition = buildImmediateTurnTransition(state);
    const isWorldEventTurn = immediateTurnTransition?.latest_input.kind === "world_event";
    const shouldReviewSemanticContinuity = mode !== "opening"
      && (
        hasPriorPlayerFacingScene(state)
        || sourceCandidates.some((candidate) => Boolean(candidate.requiredEvent?.trim()))
      );
    const sceneSchema = sceneSettingJsonSchemaForSourceChapters(
      sourceCandidates.map((candidate) => candidate.chapterPosition),
    );
    const sceneStyleRules = mode === "observed_scene_progression"
      ? OBSERVED_SCENE_PROGRESSION_STYLE_RULES
      : mode === "opening"
        ? [
            ...COMPACT_SCENE_STYLE_RULES,
            `Opening scene text may use up to ${openingWordBudget} words when ordered pre-player beats require the extra room. This opening-specific budget overrides the generic 120-word compact target.`,
          ]
        : COMPACT_SCENE_STYLE_RULES;
    const turnReasoningEffort = reasoningEffortForTurn(
      this.reasoningEffort,
      choiceStakes,
    );
    let maxOutputTokens = mode === "observed_scene_progression" ? 2_200 : 1_600;
    let lastValidationFailures: string[] = [];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const isFinalObservedProgressionAttempt =
        mode === "observed_scene_progression" && attempt === maxAttempts - 1;
      const response = await this.createResponse("scene", state.book.bookId, {
        model: this.model,
        reasoning: {
          effort: attempt === 0 ? turnReasoningEffort : "low",
        },
        instructions: [
          "You are the game engine for BookRPG.",
          "Create an interactive scene inspired by the supplied book context, but do not quote long passages from the source.",
          "Use the bounded source passage, relevant character profiles, game profile, story memory, and upcoming source material as background for the setting, character relationships, and role-specific stakes.",
          "story_so_far and upcoming_source_material may contain canonical events after the selected passage. Do not reveal those events as spoilers, treat them as already known to the player, or force them to occur after the interactive timeline diverges.",
          "established_event is authoritative structured timeline state. When present in an opening scene, its narrative is inserted by the application before your text; begin with the immediate aftermath and do not repeat or contradict the event.",
          "When established_event is null, do not invent a completed major event merely from later information in story_so_far or upcoming_source_material.",
          "The player_identity field is authoritative. Keep that character or persona consistent in narration, knowledge, dialogue, and available actions.",
          "When player_character_profile is present, treat it as authoritative for the player's identity, role, physical nature, and capabilities.",
          ...RUNTIME_PARAMETER_RULES,
          "Never infer that the player is the source passage's viewpoint character unless player_identity explicitly names that character.",
          "The turn instruction is newer than every entry in GAME CONTEXT. Resolve it instead of repeating or continuing an older player action.",
          "When IMMEDIATE TURN TRANSITION is present, previous_scene has already happened and latest_input is the exact option, dialogue, event, or scene-continuation request to resolve now. Do not recap or replay it. Treat its setting, positions, props, physical conditions, ongoing activity, relationships, and atmosphere as established state until this turn visibly changes them.",
          "For an option, dialogue, or event, begin at its consequence. For scene_continuation, paint the next observable beat from previous_scene's final moment while preserving that established state. By the decision point, establish at least one concrete new response, fact, consequence, obstacle, opportunity, or observable world-state change beyond previous_scene.",
          ...(isWorldEventTurn
            ? [
                "This is a WORLD EVENT turn, not a PLAYER ACTION turn. Make latest_input.text occur externally; never assign its initiating action, decision, intent, or hidden action metadata to player_identity.",
                "Use the WORLD EVENT as this turn's one major plot beat. Show only its direct immediate reactions and observable consequences, then stop before another independently initiated event, voluntary player action, major decision, or substantial time/location transition.",
                "For this WORLD EVENT turn, return playerAction: '', actionResult: '', and actionOutcome: 'none'. Put later player actions only in choices and do not enact them in scene text.",
              ]
            : []),
          "Continue causally from current_scene and the latest history. Preserve established world-state facts unless the current turn changes them.",
          "Keep the scene internally consistent from first sentence to last. Once this scene establishes that a character is present or has arrived, later prose and the resulting decision point must not place them before arrival, await their return, or prepare for them to come home unless their departure is visibly narrated first.",
          "current_significant_event is the latest canonical event already reached. Do not replay, restate, or move backward before it.",
          ...(requiredSourceEvent
            ? [
                "The selected source-continuation route requires progress in the current source event, but only the next ordered beat is mandatory now.",
                "Visibly complete next_significant_event_progress.next_required_beat in this scene. Do not require or summarize every later remaining beat.",
                "After the required beat and its immediate inseparable consequence, stop at the next meaningful decision or observable beat boundary. Later remaining beats stay future unless they follow automatically without crossing a player decision boundary.",
                "Do not mark the source event complete unless every beat is actually completed.",
                `Required beat to complete now: ${requiredSourceBeatProgress?.nextRequiredBeat?.action ?? "the next required source beat"}`,
              ]
            : [
                "upcoming_source_material is optional canonical reference, not a required route, unless the player explicitly selected the source-continuation option.",
                "In an ordinary player turn, adapt a compatible source development only when it follows naturally from latest_input or occurs independently without choosing another action for the player. If the interactive timeline has diverged, follow the divergence instead.",
                "next_significant_event is a possible source development, not an obligation. Do not steer toward it merely to restore the book's original plot.",
                "Do not depict next_significant_event as completed when reaching it still requires another voluntary player decision or an unmet causal prerequisite. In that case, establish the nearest immediate setup, pressure, opportunity, or transition toward it.",
                "When the next source-backed development requires another voluntary player decision, do not make it happen in this turn and keep sourceChapterPosition null.",
              ]),
          "Preserve the source development's narrative function, participants, and consequences where possible, but never undo completed player actions or established interactive world changes.",
          "next_significant_event_progress is authoritative cumulative state. Never repeat completed_beats or skip next_required_beat for a later remaining beat. If next_required_beat is a meaningful player-controlled action that latest_input did not select, establish only its prerequisites and leave it as a choice; otherwise resolve it before later remaining_beats. Do not claim the event complete until remaining_beats is empty.",
          ...(mode === "opening" && openingFirstPlayerBeatOffset > 0
            ? [
                "OPENING AUTOMATIC PREFIX: the first meaningful player-controlled beat lies later in the ordered event. Before presenting any menu, visibly complete every still-unfinished ordered beat before that player beat, including intentional NPC actions as well as world, external, involuntary, and routine beats. Stop immediately before the player beat and leave it wholly unperformed so it can become option 1.",
              ]
            : []),
          ...(openingNextRequiredBeatIsPlayerChoice
            ? [
                "OPENING HARD STOP: next_significant_event_progress.next_required_beat belongs to player_identity and has not been selected. Do not perform, paraphrase as completed, or hide that action in narration or metadata. Establish only its prerequisites, stop immediately before the action, and offer it as a choice.",
              ]
            : []),
          "next_player_future_actions lists meaningful player-controlled beats from that event, with source excerpts. Treat an item as still future unless latest_input or the selected SOURCE ANCHOR explicitly authorizes that same action.",
          "Only prepare a future player action when it is the next required ordered beat. Never jump across intervening NPC, external, involuntary, or other source beats merely to stage a later player beat.",
          "When latest_input and the established world state remain causally compatible with the source route, use the current next player beat plus its source_excerpt to infer and visibly establish its physical and social prerequisites at the decision point.",
          "Never speak, decide, or perform an unselected next_player_future_action for the player. Stop before it so the choice generator can offer it.",
          "If latest_input or established interactive state has diverged incompatibly, follow that divergence and do not force, reconstruct, or prepare the source action.",
          ...SOURCE_GROUNDING_RULES,
          ...TURN_SCOPE_RULES,
          ...SCENE_SCOPE_RULES,
          "The prior scene's choice menu is absent from GAME CONTEXT because it is not world state. Any unselected_options supplied in IMMEDIATE TURN TRANSITION are rejection constraints, not events to reconstruct.",
          "If an absent character becomes available during this turn, explicitly narrate their arrival before any speech, answer, gesture, or other interaction from them.",
          "An absent or not-yet-introduced character may be mentioned as a memory, relationship, or person elsewhere, but must not appear, arrive, speak, respond, or interact until the source context or this scene introduces them.",
          "Use the writing system and language established by the source passage and game context. Do not insert words from an unrelated language or writing system.",
          "Set externalDevelopment to a concise description of the concrete external event, discovery, environmental change, NPC action, arrival, accident, threat, or opportunity introduced this turn. Use an empty string only when no such development occurs.",
          "externalDevelopment is hidden metadata. Never mention its field name, label, value, or existence in actionResult, scene text, titles, choices, or any player-facing prose.",
          "When STAGNATION BREAK REQUIRED appears, externalDevelopment must be non-empty and the described development must visibly happen in scene text.",
          "Copy PLAYER ACTION exactly and completely into playerAction. If there is no PLAYER ACTION, use an empty string.",
          "Set actionOutcome to succeeded, partially_succeeded, failed, or interrupted for a PLAYER ACTION, and to none only when there is no PLAYER ACTION.",
          "Set actionResult to hidden metadata containing a concise, concrete account of what happened because of PLAYER ACTION. Use an empty string only when this turn has no PLAYER ACTION.",
          "Never expose actionResult as a separate summary in player-facing prose. The scene text itself must naturally show the action and its immediate consequences before continuing.",
          "When PLAYER ACTION asks, demands, questions, guarantees, promises, signals, orders, or otherwise addresses someone, actionResult must include that person's immediate substantive response or observable refusal.",
          "actionResult must advance the action rather than restate it, leave it pending, or return the situation to the state before it happened.",
          "An imperative, request, or merely desired outcome in PLAYER ACTION may fail; never treat it as automatically successful. However, a player-controlled act phrased as already completed, or an explicitly stated immediate observation or world fact, is authoritative user narration and must not be downgraded into an attempt or contradicted.",
          "Preserve the actor, target, and direction of PLAYER ACTION in both the scene and its choices. Never substitute the target performing a mirrored action back at the player.",
          "This is fictional roleplay. Do not silently replace a harmful, crude, coercive, or morally objectionable PLAYER ACTION with a safer decision. Show the concrete attempt and consequences. Another character may stop or interrupt it only through a specific action narrated on the page.",
          "Use objective and victoryCondition as the persistent goal.",
          "Respect game_profile.endingMode when deciding how the game can end.",
          "Set outcome to 'active' while the goal remains unresolved.",
          "For endingMode 'win', set outcome to 'won' only when victoryCondition has concretely happened.",
          "For endingMode 'completion', use 'completed' at the natural narrative conclusion; do not call completion a win.",
          "For endingMode 'open_ended', keep outcome 'active' and provide meaningful milestones instead of inventing a final victory.",
          "Set outcome to 'lost' only when the role's objective has become irreversibly impossible.",
          "For an investigation whose victoryCondition requires a confession, only an explicit admission by the actual culprit counts. Suspicion, accusation, bluffing, or a witness statement alone never counts.",
          "A credible bluff or sustained extreme psychological pressure may cause a plausible confession even without complete forensic proof; do not postpone a confession forever once the culprit plausibly breaks.",
          "For 'won' or 'lost', explain the result in outcomeReason.",
          ...STORY_MEMORY_RULES,
          ...SCENE_TITLE_RULES,
          ...sceneStyleRules,
        ].join("\n"),
        input: `${turnInstruction}`
          + (immediateTurnTransition
            ? `\n\nIMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):\n${JSON.stringify(immediateTurnTransition, null, 2)}`
            : "")
          + `\n\nPLAYER PERSPECTIVE RULES:\n${playerPerspective}`
          + `\n\nGAME CONTEXT:\n${gameContext}`,
        text: {
          format: {
            type: "json_schema",
            name: "bookrpg_scene",
            strict: true,
            schema: sceneSchema,
          },
        },
        max_output_tokens: maxOutputTokens,
      });
      if (response.status === "incomplete") {
        const details = JSON.stringify(response.incomplete_details) ?? "no details";
        const failure = `AI scene response was incomplete: ${details}`;
        if (!details.includes("max_output_tokens")) {
          throw new Error(failure);
        }
        lastValidationFailures = [failure];
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${failure}`,
        );
        maxOutputTokens *= 2;
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            instruction,
            consumedAction,
            lastValidationFailures,
          ),
        );
        continue;
      }
      let output: Omit<Scene, "choices"> & {
        choices?: Scene["choices"];
        playerAction: string;
        actionOutcome: string;
        actionResult: string;
        externalDevelopment: string;
        sourceChapterPosition: number | null;
        storyMemory?: StoryMemory;
      };
      try {
        output = parseAiJson<Omit<Scene, "choices"> & {
          choices?: Scene["choices"];
          playerAction: string;
          actionOutcome: string;
          actionResult: string;
          externalDevelopment: string;
          sourceChapterPosition: number | null;
          storyMemory?: StoryMemory;
        }>(
          response.output_text,
          "OpenAI scene",
        );
      } catch (error) {
        if (!(error instanceof InvalidAiJsonError)) throw error;
        lastValidationFailures = [error.message];
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${error.message}`,
        );
        maxOutputTokens *= 2;
        const regenerationInstruction = buildSceneRegenerationInstruction(
          instruction,
          consumedAction,
          lastValidationFailures,
        );
        turnInstruction = applyStagnationBreak(regenerationInstruction);
        continue;
      }
      const {
        playerAction,
        actionOutcome,
        actionResult,
        externalDevelopment,
        sourceChapterPosition,
        storyMemory,
        choices: embeddedChoices,
        ...draft
      } = output;
      const resolvedPlayerAction = isWorldEventTurn ? "" : playerAction;
      const resolvedActionOutcome = isWorldEventTurn ? "none" : actionOutcome;
      const resolvedActionResult = isWorldEventTurn ? "" : actionResult;
      const immediateActionFailures = actionResolutionFailures(
        resolvedPlayerAction,
        resolvedActionOutcome,
        resolvedActionResult,
        consumedAction,
      );
      if (immediateActionFailures.length > 0) {
        lastValidationFailures = immediateActionFailures;
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${immediateActionFailures.join(" ")}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            instruction,
            consumedAction,
            immediateActionFailures,
          ),
        );
        continue;
      }
      const completedAction = consumedAction
        ? {
            playerAction: resolvedPlayerAction,
            actionResult: resolvedActionResult,
          }
        : undefined;
      if (
        sceneLeaksInternalMetadata(
          resolvedActionResult,
          draft.title,
          draft.text,
        )
      ) {
        const validationFailures = [
          "Player-facing prose exposed the hidden externalDevelopment field.",
        ];
        lastValidationFailures = validationFailures;
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${validationFailures.join(" ")}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            instruction,
            consumedAction,
            validationFailures,
          ),
        );
        continue;
      }
      const sourceCandidate = resolveGroundedSourceCandidate(
        sourceChapterPosition,
        sourceCandidates,
      ) ?? (
        requiredSourceEvent && sourceChapterPosition === null
          ? sourceCandidates[0]
          : undefined
      );
      if (sourceChapterPosition !== null && !sourceCandidate) {
        flowDiagnostic(
          `${this.client.provider} scene draft ${attempt + 1}/${maxAttempts} returned unsupported `
          + `sourceChapterPosition ${sourceChapterPosition}; source progress will not advance.`,
        );
      }
      const settingText = stripLeakedSceneMetadata(
        stripEmbeddedChoiceMenu(applyEstablishedEvent(state, draft.text)),
      );
      const sceneWordCount = settingText.trim()
        ? settingText.trim().split(/\s+/u).length
        : 0;
      const explicitlyUnavailable = sourceCandidates.flatMap(
        (candidate) => candidate.unavailableCharacters ?? [],
      );
      const unavailableCharacters = [
        ...sceneNonInteractableCharacters(
          state,
          { title: draft.title, text: settingText },
          explicitlyUnavailable,
        ),
      ];
      const proposedSceneScope = filterSceneScope(
        sceneScopeOrFallback(draft.sceneScope, state.scene.sceneScope),
        {
          playerName: state.playerName,
          playerAliases: playerScopeAliases(
            state.playerName,
            state.characterProfiles,
          ),
          knownCharacterProfiles: state.characterProfiles,
          nonInteractableCharacters: unavailableCharacters,
        },
      );
      const proposedSetting: Scene = {
        ...draft,
        choices: [],
        sceneScope: proposedSceneScope,
        text: settingText,
        development: externalDevelopment.trim() || undefined,
      };
      const repeatsCurrentNarrative =
        sceneRepeatsRecentNarrative(draft, state)
        || sceneRepeatsRecentNarrative(proposedSetting, state);
      const repeatsRecentDevelopment = stagnating
        && developmentRepeatsHistory(externalDevelopment, state.history);
      const validationFailures = [
        ...sceneScopeFailures(proposedSetting.sceneScope, {
          playerName: state.playerName,
          playerAliases: playerScopeAliases(
            state.playerName,
            state.characterProfiles,
          ),
          knownCharacterProfiles: state.characterProfiles,
          nonInteractableCharacters: unavailableCharacters,
        }),
        ...(repeatsCurrentNarrative && !isFinalObservedProgressionAttempt
          ? ["The narrative substantially repeats a recent scene's events, actions, setting beats, or imagery instead of advancing the world state."]
          : []),
        ...(sceneUsesUnexpectedWritingSystem(proposedSetting, writingSystemReference)
          ? ["The draft inserted a writing system absent from the established context."]
          : []),
        ...absentCharacterContinuityFailures(
          state,
          draft.text,
          resolvedActionResult,
          externalDevelopment,
        ),
        ...(mode === "opening"
          ? [
              ...openingCharacterContinuityFailures(
                draft.text,
                state,
                sourceCandidates,
              ),
              ...(sceneWordCount > openingWordBudget
                ? [
                    `Opening scene text contains ${sceneWordCount} words; keep it at or below the opening budget of ${openingWordBudget} words and stop at the immediate next player decision.`,
                  ]
                : []),
            ]
          : []),
        ...(stagnating && !externalDevelopment.trim() && !isFinalObservedProgressionAttempt
          ? ["Stagnation requires a concrete externalDevelopment."]
          : []),
        ...(
          mode === "observed_scene_progression"
          && !externalDevelopment.trim()
          && !isFinalObservedProgressionAttempt
          ? [
              "Observed scene progression requires a concrete non-player or environmental "
              + "development that visibly changes the scene.",
            ]
          : []),
        ...(requiredSourceEvent && !requiredSourceBeatProgress
          ? ["Direct source continuation requires a next ordered source beat."]
          : []),
        ...(repeatsRecentDevelopment && !isFinalObservedProgressionAttempt
          ? ["externalDevelopment repeats a recent development instead of introducing a new fact."]
          : []),
      ];
      lastValidationFailures = validationFailures;
      let semanticRepeat = false;
      const reviewSourceCandidate = sourceCandidate ?? sourceCandidates[0];
      const recoveryCandidate = sourceCandidates.find((candidate) => candidate.recovery);
      const shouldEnforceSemanticRepetition = !isFinalObservedProgressionAttempt
        && (
          !recoveryCandidate
          || attempt < maxAttempts - 1
        );
      let repetitionReview: SceneRepetitionReview | undefined;
      if (validationFailures.length === 0 && shouldReviewSemanticContinuity) {
        repetitionReview = await this.reviewSceneRepetition(
          state,
          { ...proposedSetting, actionResult: resolvedActionResult },
          reviewSourceCandidate,
          false,
          false,
          false,
          undefined,
        );
        const aiNonInteractableFailures = sceneScopeFailures(
          proposedSetting.sceneScope,
          {
            playerName: state.playerName,
            playerAliases: playerScopeAliases(
              state.playerName,
              state.characterProfiles,
            ),
            knownCharacterProfiles: state.characterProfiles,
            nonInteractableCharacters: repetitionReview.nonInteractableCharacters,
          },
        ).filter((failure) => failure.includes("non-interactable character"));
        if (aiNonInteractableFailures.length > 0) {
          validationFailures.push(
            ...aiNonInteractableFailures,
            "The semantic continuity review found that "
            + `${repetitionReview.nonInteractableCharacters!.join(", ")} `
            + "are dead or otherwise not physically interactable: "
            + `${repetitionReview.nonInteractableCharactersReason?.trim() || repetitionReview.reason}`,
          );
        }
        if (!repetitionReview.latestInputResolvedFaithfully) {
          validationFailures.push(
            "The semantic continuity review found that the draft did not faithfully resolve "
            + "the latest input while preserving player identity and actor/target roles: "
            + `${repetitionReview.latestInputFailureReason?.trim() || repetitionReview.reason}`,
          );
        }
        if (repetitionReview.preservesPlayerPerspective === false) {
          validationFailures.push(
            "The semantic continuity review found that the narration switched away from "
            + `the player's first-person perspective: ${repetitionReview.playerPerspectiveFailureReason?.trim() || repetitionReview.reason}`,
          );
        }
        if (!repetitionReview.preservesPlayerAgency) {
          validationFailures.push(
            "The semantic continuity review found that the draft performed a consequential "
            + "player action that was not selected: "
            + `${repetitionReview.playerAgencyFailureReason?.trim() || repetitionReview.reason}`,
          );
        }
        if (!repetitionReview.staysWithinTurnScope) {
          validationFailures.push(
            "The semantic continuity review found that the draft advanced beyond the selected "
            + "action and its immediate consequences: "
            + `${repetitionReview.turnScopeFailureReason?.trim() || repetitionReview.reason}`,
          );
        }
        const recoveryEventOccurred = sourceCandidates.some(
          (candidate) => candidate.recovery,
        ) && repetitionReview.requiredEventOccurred;
        semanticRepeat = Boolean(
          shouldEnforceSemanticRepetition
          && repetitionReview.repeatsPriorScene
          && !recoveryEventOccurred
        );
      }

      if (validationFailures.length > 0) {
        lastValidationFailures = validationFailures;
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${validationFailures.join(" ")}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            instruction,
            consumedAction,
            validationFailures,
          ),
          repeatsCurrentNarrative || repeatsRecentDevelopment || semanticRepeat,
        );
        continue;
      }

      const reviewedUnavailableCharacters = [
        ...new Set([
          ...unavailableCharacters,
          ...(repetitionReview?.nonInteractableCharacters ?? []),
        ]),
      ];
      const eventReviewTargetId = sourceSceneBeatReviewTargetId(
        sourceBeatNavigationEvent,
        undefined,
      );
      const presenceReview = await this.reviewScenePresence(
        state,
        { ...proposedSetting, playerAction: resolvedPlayerAction },
        reviewedUnavailableCharacters,
        sourceCandidates,
        eventReviewTargetId,
        mode === "opening",
      );
      const setting: Scene = {
        ...proposedSetting,
        sceneScope: filterSceneScope(
          {
            currentLocation: proposedSceneScope.currentLocation,
            peoplePresent: presenceReview.peoplePresent,
            peopleWithinSpeakingDistance:
              presenceReview.peopleWithinSpeakingDistance,
          },
          {
            playerName: state.playerName,
            playerAliases: playerScopeAliases(
              state.playerName,
              state.characterProfiles,
            ),
            knownCharacterProfiles: state.characterProfiles,
            nonInteractableCharacters: reviewedUnavailableCharacters,
          },
        ),
      };
      const reviewedVisibleEvent = reviewedVisibleSourceEvent(
        sourceCandidates[0],
        presenceReview.latestVisibleSourceEventId,
      );
      const reviewedSourceEventProgress = eventReviewTargetId
        ? reviewedVisibleEvent?.eventId === eventReviewTargetId
          ? null
          : presenceReview.completedSourceEventBeatIndexes.length > 0
            ? {
                eventId: eventReviewTargetId,
                completedBeatIndexes:
                  presenceReview.completedSourceEventBeatIndexes,
              }
            : undefined
        : undefined;
      const choiceReviewState = eventReviewTargetId
        ? { ...state, sourceEventProgress: reviewedSourceEventProgress ?? undefined }
        : state;
      const candidateOpeningProgressEvent = mode === "opening"
        ? reviewedVisibleEvent
        : undefined;
      const openingProgressEvent:
        | { eventId: string; chapterPosition: number }
        | undefined = candidateOpeningProgressEvent?.eventId
        ? {
            eventId: candidateOpeningProgressEvent.eventId,
            chapterPosition: candidateOpeningProgressEvent.chapterPosition,
          }
        : undefined;
      const reviewedCompletedSourceEventId =
        eventReviewTargetId
        && reviewedVisibleEvent?.eventId === eventReviewTargetId
          ? reviewedVisibleEvent.eventId
          : undefined;
      const completedSourceEventId = requiredSourceEvent
        ? reviewedCompletedSourceEventId
        : mode === "opening"
          ? openingProgressEvent?.eventId
          : reviewedCompletedSourceEventId;
      const previousCompletedBeatCount =
        state.sourceEventProgress?.eventId === eventReviewTargetId
          ? state.sourceEventProgress.completedBeatIndexes.length
          : 0;
      const confirmedBeatProgress =
        reviewedVisibleEvent?.eventId === eventReviewTargetId
        || presenceReview.completedSourceEventBeatIndexes.length > previousCompletedBeatCount;
      const requiredBeatCompleted =
        requiredSourceBeatIndex === undefined
        || presenceReview.completedSourceEventBeatIndexes.includes(requiredSourceBeatIndex)
        || reviewedVisibleEvent?.eventId === eventReviewTargetId;
      const openingAutomaticPrefixIndexes =
        mode === "opening"
        && sourceBeatProgress
        && openingFirstPlayerBeatIndex > sourceBeatProgress.completedBeatIndexes.length
          ? Array.from(
              {
                length:
                  openingFirstPlayerBeatIndex
                  - sourceBeatProgress.completedBeatIndexes.length,
              },
              (_value, index) =>
                sourceBeatProgress.completedBeatIndexes.length + index,
            )
          : [];
      const openingAutomaticPrefixCompleted =
        openingAutomaticPrefixIndexes.every((index) =>
          presenceReview.completedSourceEventBeatIndexes.includes(index)
        );
      const openingPlayerBeatWasPerformed =
        openingFirstPlayerBeatIndex >= 0
        && (
          presenceReview.completedSourceEventBeatIndexes.includes(
            openingFirstPlayerBeatIndex,
          )
          || reviewedVisibleEvent?.eventId === eventReviewTargetId
        );
      const presenceValidationFailures = [
        ...sceneScopeFailures(setting.sceneScope, {
          playerName: state.playerName,
          playerAliases: playerScopeAliases(
            state.playerName,
            state.characterProfiles,
          ),
          knownCharacterProfiles: state.characterProfiles,
          nonInteractableCharacters: reviewedUnavailableCharacters,
        }),
        ...(
          mode === "opening"
          && openingFirstPlayerBeatOffset > 0
          && !openingAutomaticPrefixCompleted
            ? [
                "The opening stopped before reaching the first meaningful player decision. Visibly complete every ordered NPC/world/involuntary/routine beat before that player beat in the same opening, then stop immediately before the player action so it can be option 1.",
              ]
            : []
        ),
        ...(
          mode === "opening"
          && openingFirstPlayerBeatIndex >= 0
          && openingPlayerBeatWasPerformed
            ? [
                "The opening performed the first meaningful player beat before it was selected. Leave that player beat entirely future and present it as option 1.",
              ]
            : []
        ),
        ...(
          presenceReview.futureActionSetupRequired
          && !presenceReview.futureActionSetupSupported
            ? [
                "The scene did not establish the physical and social prerequisites "
                + "for the current next required player beat and source excerpt: "
                + (presenceReview.futureActionSetupReason?.trim() || presenceReview.reason),
              ]
            : []
        ),
        ...(
          requiredSourceBeatProgress
          && !requiredBeatCompleted
            ? [
                "Direct source continuation did not visibly complete the required next source beat.",
                `Required beat ${requiredSourceBeatIndex}: ${requiredSourceBeatProgress.nextRequiredBeat?.action ?? "unknown beat"}.`,
                ...(requiredSourceBeatProgress.completedBeats.length > 0
                  ? [
                      "Do not replay already completed beats while correcting this failure: "
                      + requiredSourceBeatProgress.completedBeats
                        .map((beat, index) =>
                          `${requiredSourceBeatProgress.completedBeatIndexes[index]}: ${beat.action}`
                        )
                        .join(" | "),
                    ]
                  : []),
              ]
            : []
        ),
        ...(
          semanticRepeat && !confirmedBeatProgress
            ? [
                `The semantic repetition review found that the draft repeats prior narrative state without confirmed source-beat progress: ${repetitionReview?.reason ?? "no new ordered beat was confirmed"}`,
              ]
            : []
        ),
      ];
      if (presenceValidationFailures.length > 0) {
        lastValidationFailures = presenceValidationFailures;
        flowDiagnostic(
          `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${presenceValidationFailures.join(" ")}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            instruction,
            consumedAction,
            presenceValidationFailures,
          ),
        );
        continue;
      }
      let verifiedSourceCandidate = mode === "opening"
        ? undefined
        : sourceCandidate?.requiredEvent
          ? undefined
          : sourceCandidate;
      if (
        reviewSourceCandidate?.requiredEvent
        && reviewedVisibleEvent?.eventId === eventReviewTargetId
      ) {
        verifiedSourceCandidate = reviewSourceCandidate;
      }
      const generatedChoices = repairGeneratedChoices(
        embeddedChoices ?? (
          (setting.outcome ?? "active") === "active"
            ? await this.sceneChoices(
                setting,
                choiceReviewState,
                sourceCandidates,
                consumedAction,
                completedSourceEventId,
                [],
                [],
                reviewedUnavailableCharacters,
                completedAction,
              )
            : []
        ),
      );
      const choicesLeakInternalMetadata = sceneLeaksInternalMetadata(
        ...generatedChoices.map((choice) => choice.text),
      );
      const cleanedDraft: Scene = {
        ...setting,
        choices: generatedChoices,
      };
      const actionFilteredScene = consumedAction
        ? removeConsumedActionChoices(cleanedDraft, consumedAction)
        : cleanedDraft;
      const identityFilteredScene = removeChoicesWithPlayerIdentityReferences(
        actionFilteredScene,
        state.playerName,
        state.characterProfiles,
      );
      const introducedCharacterScene = removeChoicesWithUnintroducedCharacters(
        identityFilteredScene,
        state,
        visibleSourceEventNarrative(sourceCandidates),
        reviewedUnavailableCharacters,
      );
      const distinctScene = removeDuplicateChoices(introducedCharacterScene);
      const filteredScene = removeRecentChoiceParaphrases(distinctScene, state.history);
      const choiceNavigationEvent = buildSourceEventChoiceBeatState(
        nextSignificantEventForCandidate(sourceCandidates[0], completedSourceEventId),
        choiceReviewState.sourceEventProgress,
      ).remainingEvent;
      const requiresExplicitPlayerChoice = sourceEventRequiresExplicitPlayerChoice(
        choiceNavigationEvent,
        state.playerName,
        state.characterProfiles,
        setting.sceneScope,
      );
      const requiredPlayerFallback = requiresExplicitPlayerChoice
        ? buildRequiredPlayerChoiceFallback(
            choiceNavigationEvent,
            state.playerName,
            state.characterProfiles,
            setting.sceneScope,
          )
        : undefined;
      const continuationText = sourceContinuationChoiceText(sourceCandidates[0]);
      const scene = requiresExplicitPlayerChoice
        ? ensureRequiredPlayerChoiceFirst(filteredScene, requiredPlayerFallback)
        : addSourceContinuationChoiceFallback(
            filteredScene,
            continuationText,
          );
      const hadNoUsableChoices = (scene.outcome ?? "active") === "active"
        && scene.choices.length === 0;
      const hasInsufficientChoices = hasTooFewChoicesForActiveScene(scene);
      const anchorChoiceWasFiltered = requiredPlayerFallback
        ? false
        : firstChoiceWasFiltered(
            generatedChoices,
            scene.choices,
            scene.outcome,
          );
      const choiceValidationFailures = [
        ...(hadNoUsableChoices && attempt < maxAttempts - 1
          ? [
              "No usable player choices remained. Generate 2 to 4 distinct, immediately "
              + "playable options; include a route toward the next indexed story event "
              + "when possible without forcing an unselected player action.",
            ]
          : []),
        ...(hasInsufficientChoices
          ? [
              `Only ${scene.choices.length} distinct usable choice(s) remained; at least 2 are required.`,
            ]
          : []),
        ...filteredAnchorChoiceFailures(
          anchorChoiceWasFiltered,
          attempt,
          maxAttempts,
        ),
        ...(choicesLeakInternalMetadata
          ? ["Player-facing prose exposed the hidden externalDevelopment field."]
          : []),
      ];
      let anchorOrderedScene = scene;
      if (
        choiceValidationFailures.length === 0
        && (scene.outcome ?? "active") === "active"
      ) {
        let choiceReview = await this.reviewSceneChoices(
          choiceReviewState,
          scene,
          reviewSourceCandidate,
          completedSourceEventId,
          completedAction,
        );
        const unusableChoiceIndexes = reviewedUnusableChoiceIndexes(
          choiceReview,
          scene.choices.length,
        );
        if (unusableChoiceIndexes.length > 0) {
          const unusableIndexes = new Set(unusableChoiceIndexes);
          const acceptedChoices = scene.choices.filter(
            (_choice, index) => !unusableIndexes.has(index),
          );
          const rejectedChoiceTexts = scene.choices
            .filter((_choice, index) => unusableIndexes.has(index))
            .map((choice) => choice.text);
          const repairedChoices =
            acceptedChoices.length >= 2 && !requiresExplicitPlayerChoice
              ? acceptedChoices
              : await this.sceneChoices(
                  setting,
                  choiceReviewState,
                  sourceCandidates,
                  consumedAction,
                  completedSourceEventId,
                  acceptedChoices,
                  rejectedChoiceTexts,
                  reviewedUnavailableCharacters,
                  completedAction,
                );
          anchorOrderedScene = requiresExplicitPlayerChoice
            ? ensureRequiredPlayerChoiceFirst(
                { ...scene, choices: repairedChoices },
                requiredPlayerFallback,
              )
            : { ...scene, choices: repairedChoices };
          flowDiagnostic(
            `${this.client.provider} scene choice scope review removed `
            + `${unusableChoiceIndexes.length} unusable choice(s): `
            + `${choiceReview.unusableChoicesReason || choiceReview.reason}`,
          );
          if (hasTooFewChoicesForActiveScene(anchorOrderedScene)) {
            choiceValidationFailures.push(
              "The semantic choice scope review left fewer than two immediately usable choices.",
            );
          }
          if (
            sceneLeaksInternalMetadata(
              ...anchorOrderedScene.choices.map((choice) => choice.text),
            )
          ) {
            choiceValidationFailures.push(
              "Player-facing prose exposed the hidden externalDevelopment field.",
            );
          }
          if (choiceValidationFailures.length === 0) {
            choiceReview = await this.reviewSceneChoices(
              choiceReviewState,
              anchorOrderedScene,
              reviewSourceCandidate,
              completedSourceEventId,
              completedAction,
            );
            if (
              reviewedUnusableChoiceIndexes(
                choiceReview,
                anchorOrderedScene.choices.length,
              ).length > 0
            ) {
              choiceValidationFailures.push(
                "Regenerated choices still contradicted the confirmed SceneScope or completed scene state.",
              );
            }
          }
        }
        if (shouldHandleMissingAnchorChoice({
          hasValidationFailures: choiceValidationFailures.length > 0,
          activeScene: true,
          anchorChoiceIndex: choiceReview.anchorChoiceIndex,
          finalAttempt: isFinalObservedProgressionAttempt,
          sourceEventOccurred: reviewedVisibleEvent?.eventId === eventReviewTargetId,
        })) {
          if (requiresExplicitPlayerChoice) {
            const fallback = requiredPlayerFallback
              ?? buildRequiredPlayerChoiceFallback(
                choiceNavigationEvent,
                state.playerName,
                state.characterProfiles,
                setting.sceneScope,
              );
            if (fallback) {
              anchorOrderedScene = ensureRequiredPlayerChoiceFirst(
                anchorOrderedScene,
                fallback,
              );
            } else {
              choiceValidationFailures.push(
                "No offered choice explicitly asks the player to perform the consequential next source event.",
              );
            }
          } else if (!hasSourceContinuationChoiceFallback(anchorOrderedScene)) {
            anchorOrderedScene = addSourceContinuationAnchorChoice(
              anchorOrderedScene,
              continuationText,
            );
          }
        } else if (
          choiceValidationFailures.length === 0
          && requiresExplicitPlayerChoice
          && requiredPlayerFallback
        ) {
          anchorOrderedScene = ensureRequiredPlayerChoiceFirst(
            anchorOrderedScene,
            requiredPlayerFallback,
          );
        } else if (
          choiceValidationFailures.length === 0
          && choiceReview.anchorChoiceIndex !== null
        ) {
          anchorOrderedScene = promoteAnchorChoice(
            anchorOrderedScene,
            choiceReview.anchorChoiceIndex,
            choiceNavigationEvent?.eventId ?? undefined,
          );
        }
      }

      lastValidationFailures = choiceValidationFailures;
      if (choiceValidationFailures.length === 0) {
        if (eventReviewTargetId) {
          flowDiagnostic(
            "OpenAI scene accepted source beat progress: "
            + JSON.stringify({
              event_id: eventReviewTargetId,
              previous_completed_beat_indexes:
                state.sourceEventProgress?.eventId === eventReviewTargetId
                  ? state.sourceEventProgress.completedBeatIndexes
                  : [],
              completed_beat_indexes: presenceReview.completedSourceEventBeatIndexes,
              event_completed: reviewedSourceEventProgress === null,
              source_event_progress: reviewedSourceEventProgress ?? null,
            }),
          );
        }
        const openingCursor = state.sourceCursor;
        const sourceProgress = openingProgressEvent
          ? {
              chapterPosition: openingProgressEvent.chapterPosition,
              textOffset:
                openingCursor?.chapterPosition === openingProgressEvent.chapterPosition
                  ? openingCursor.textOffset
                  : sourceCandidates[0]?.nextTextOffset ?? 0,
              eventId: openingProgressEvent.eventId,
            }
          : verifiedSourceCandidate
            ? groundedSourceProgress(verifiedSourceCandidate)
            : undefined;
        return {
          ...normalizeSceneTalkChoices(anchorOrderedScene),
          ...(storyMemory ? { storyMemory } : {}),
          ...(sourceProgress ? { sourceProgress } : {}),
          ...(reviewedSourceEventProgress !== undefined
            ? { sourceEventProgress: reviewedSourceEventProgress }
            : {}),
        };
      }

      const usableChoiceIds = new Set(scene.choices.map((choice) => choice.id));
      const rejectedChoices = generatedChoices
        .filter((choice) => !usableChoiceIds.has(choice.id))
        .map((choice) => choice.text);
      flowDiagnostic(
        `response.status: ${response.status} - OpenAI scene draft ${attempt + 1}/${maxAttempts} rejected: ${choiceValidationFailures.join(" ")}`,
      );
      const regenerationInstruction = buildSceneRegenerationInstruction(
        instruction,
        consumedAction,
        choiceValidationFailures,
        rejectedChoices,
      );
      anchorChoiceRequired ||= hasInsufficientChoices || anchorChoiceWasFiltered;
      turnInstruction = applyStagnationBreak(
        regenerationInstruction,
        false,
      );
    }

    throw new SceneGenerationError(lastValidationFailures, maxAttempts);
  }
}
