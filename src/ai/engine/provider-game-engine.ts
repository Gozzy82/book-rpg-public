import { flowDiagnostic } from "../../util/flow-trace.js";
import type {
  CharacterProfile,
  GameState,
  TalkResponse,
} from "../../shared/contracts.js";
import {
  dialogueSceneJsonSchemaForSourceChapters,
  talkJsonSchema,
} from "../schema.js";
import {
  InvalidAiJsonError,
  parseAiJson,
} from "./core.js";
import type {
  GeneratedScene,
  ContinuationOptions,
  SourceContinuationCandidate,
} from "./core.js";
import {
  formatDialogueScene,
  dialogueAttributionFailures,
  normalizeSceneTalkChoices,
} from "./dialogue.js";
import type {
  DialogueSceneOutput,
} from "./dialogue.js";
import {
  stripEmbeddedChoiceMenu,
} from "./normalization.js";
import {
  findPlayerCharacterProfile,
  buildPlayerPerspective,
} from "./player.js";
import {
  ProviderSourceEngine,
} from "./provider-source-engine.js";
import {
  COMPACT_DIALOGUE_STYLE_RULES,
  SOURCE_GROUNDING_RULES,
  TURN_SCOPE_RULES,
  SCENE_SCOPE_RULES,
  RUNTIME_PARAMETER_RULES,
  DIALOGUE_SUGGESTION_TIMELINE_RULES,
  STORY_MEMORY_RULES,
  SCENE_TITLE_RULES,
} from "./rules.js";
import {
  sceneUsesUnexpectedWritingSystem,
  buildWritingSystemReference,
  sceneRepeatsRecentNarrative,
  reviewedUnusableChoiceIndexes,
  buildSceneRegenerationInstruction,
  buildDialogueContinuationInstruction,
  buildDialogueTargetCharacterProfile,
  buildGameContext,
} from "./scene-context.js";
import {
  stripLeakedSceneMetadata,
} from "./scene-text.js";
import {
  removeDuplicateChoices,
  removeRecentChoiceParaphrases,
  hasTooFewChoicesForActiveScene,
  playerScopeAliases,
  sceneScopeFailures,
  filterSceneScope,
  hasSourceContinuationChoiceFallback,
  addSourceContinuationChoiceFallback,
  addSourceContinuationAnchorChoice,
  firstChoiceWasFiltered,
  promoteAnchorChoice,
  filteredAnchorChoiceFailures,
  removeChoicesWithPlayerIdentityReferences,
  sceneNonInteractableCharacters,
  removeChoicesWithUnintroducedCharacters,
} from "./scene-validation.js";
import {
  visibleSourceEventNarrative,
  nextSignificantEventForCandidate,
  sourceEventRequiresExplicitPlayerChoice,
  reviewedVisibleSourceEvent,
} from "./source-navigation.js";
import {
  groundedSourceProgress,
  resolveGroundedSourceCandidate,
  reasoningEffortForTurn,
  buildAnchorRouteContinuationInstruction,
  buildRequiredSourceRecoveryInstruction,
} from "./source.js";
import {
  buildImmediateTurnTransition,
  isGameStagnating,
  buildStagnationBreakingInstruction,
} from "./turn.js";

export class ProviderGameEngine extends ProviderSourceEngine {
  async startTalk(
    state: GameState,
    character: string,
    candidates: readonly SourceContinuationCandidate[] = [],
    options: ContinuationOptions = {},
  ): Promise<TalkResponse> {
    const playerPerspective = buildPlayerPerspective(
      state.playerName,
      findPlayerCharacterProfile(state.playerName, state.characterProfiles),
    );
    const latestHistoryItem = state.history.at(-1);
    const immediateTalkContext = {
      scene_title: state.scene.title,
      scene_text: stripLeakedSceneMetadata(stripEmbeddedChoiceMenu(state.scene.text)),
      target_character: character,
      selected_talk_choice: latestHistoryItem?.kind === "choice"
        ? latestHistoryItem.text
        : `Talk to ${character}`,
    };
    const response = await this.createResponse("dialogue suggestions", state.book.bookId, {
      model: this.model,
      reasoning: {
        effort: reasoningEffortForTurn(
          this.reasoningEffort,
          options.choiceStakes,
        ),
      },
      instructions: [
        "Create exactly three short, distinct utterances the player might say to the target character.",
        "Write every suggestion as the player's exact spoken words in first-person singular voice, ready to copy unchanged into PLAYER'S UTTERANCE.",
        "Use I, me, my, and mine whenever player_identity refers to themself, and address the target directly as you (or by name as direct address).",
        "Never describe or instruct what the player should say. For example, return \"Why did you leave?\", not \"Ask the target why they left\"; return \"I will protect you\", not \"Tell the target I will protect them\".",
        "Never refer to player_identity by name or with third-person pronouns inside a suggestion.",
        "Keep every suggestion punchy and under 12 words.",
        "Every suggestion must be spoken by player_identity, not by the target character.",
        "The prompt must clearly name both player_identity as the speaker and the target character as the listener.",
        "Do not answer the suggestions; the target character responds only after the player selects one.",
        "Free text will also be allowed by the client.",
        "IMMEDIATE TALK CONTEXT is the authoritative conversational present and appears last in the input. Treat the newest statement, revelation, request, refusal, threat, or action in scene_text as what the player has just heard or witnessed.",
        "Every suggestion must be a plausible immediate spoken response to that newest conversational beat and must presuppose its important new facts. A suggestion fails if it could just as naturally have been spoken before that beat occurred.",
        "Do not restart the encounter, greet a character who is already present, offer routine hospitality as though nothing happened, ask the target to deliver news already revealed, or return to an older topic merely because it appears in source material or story memory.",
        "Make suggestions[0] a direct emotional or evaluative response, suggestions[1] a concrete follow-up question about the new information, and suggestions[2] a meaningfully different strategic response such as challenging, pleading, refusing, deflecting, or setting a boundary. Keep all three in character for player_identity.",
        "Upcoming source material is future navigation context only. Never let it overwrite, precede, or soften the immediate response owed to scene_text.",
        ...(options.anchorDirected
          ? [
              "This conversation was opened through option 1, the anchor-directed route.",
              "Make suggestions[0] the strongest concise utterance for moving toward the earliest compatible development in upcoming_source_material without revealing it as foreknowledge.",
              "If no upcoming source material exists, make suggestions[0] address an unresolved source-backed pressure already established in the current scene.",
            ]
          : []),
        ...RUNTIME_PARAMETER_RULES,
        ...DIALOGUE_SUGGESTION_TIMELINE_RULES,
      ].join("\n"),
      input: `TARGET CHARACTER: ${JSON.stringify(character)}\n`
        + `PLAYER IDENTITY: ${JSON.stringify(state.playerName)}\n\n`
        + `PLAYER PERSPECTIVE RULES:\n${playerPerspective}\n\n`
        + `GAME CONTEXT:\n${buildGameContext(state, candidates)}\n\n`
        + "IMMEDIATE TALK CONTEXT (AUTHORITATIVE; RESPOND TO ITS NEWEST BEAT):\n"
        + JSON.stringify(immediateTalkContext, null, 2),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_talk",
          strict: true,
          schema: talkJsonSchema,
        },
      },
      max_output_tokens: 300,
    });
    const talk = JSON.parse(response.output_text) as TalkResponse;
    return {
      ...talk,
      character,
      prompt: `${state.playerName}, what do you say to ${character}?`,
    };
  }

  async continueDialogue(
    state: GameState,
    character: string,
    playerText: string,
    sourceCandidates: readonly SourceContinuationCandidate[] = [],
    options: ContinuationOptions = {},
  ): Promise<GeneratedScene> {
    const routedCandidates = options.anchorDirected
      ? await this.anchorRouteCandidates(
          state,
          sourceCandidates,
          options.sourceEventId,
        )
      : sourceCandidates;
    return this.resolveDialogue(state, character, playerText, routedCandidates, options);
  }

  protected async resolveDialogue(
    state: GameState,
    character: string,
    playerText: string,
    routedCandidates: readonly SourceContinuationCandidate[],
    options: ContinuationOptions,
  ): Promise<GeneratedScene> {
    const baseInstruction = buildRequiredSourceRecoveryInstruction(
      buildDialogueContinuationInstruction(
        state.playerName,
        character,
        playerText,
      ),
      routedCandidates[0],
    );
    const dialogueInstruction = options.anchorDirected
      ? buildAnchorRouteContinuationInstruction(
          baseInstruction,
          routedCandidates[0],
        )
      : baseInstruction;
    const gameContext = buildGameContext(state, routedCandidates);
    const targetCharacterProfile = buildDialogueTargetCharacterProfile(
      character,
      state.playerName,
      state.characterProfiles as CharacterProfile[],
    );
    const immediateTurnTransition = buildImmediateTurnTransition(state);
    const playerPerspective = buildPlayerPerspective(
      state.playerName,
      findPlayerCharacterProfile(state.playerName, state.characterProfiles),
    );
    let anchorRecoveryRequired = isGameStagnating(state);
    const applyStagnationBreak = (
      candidateInstruction: string,
      forceReanchor = false,
    ): string => {
      anchorRecoveryRequired ||= forceReanchor;
      return anchorRecoveryRequired
        ? buildStagnationBreakingInstruction(
            candidateInstruction,
            routedCandidates.length > 0,
          )
        : candidateInstruction;
    };
    let turnInstruction = applyStagnationBreak(dialogueInstruction);

    const writingSystemReference = buildWritingSystemReference(state);
    const dialogueSchema = dialogueSceneJsonSchemaForSourceChapters(
      routedCandidates.map((candidate) => candidate.chapterPosition),
    );
    const turnReasoningEffort = reasoningEffortForTurn(
      this.reasoningEffort,
      undefined,
    );
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await this.createResponse("dialogue response", state.book.bookId, {
        model: this.model,
        reasoning: {
          effort: attempt === 0 ? turnReasoningEffort : "low",
        },
        instructions: [
          "You are resolving one dialogue turn in BookRPG.",
          "Copy PLAYER'S UTTERANCE exactly and completely into playerUtterance. Do not correct, paraphrase, replace, or answer it there.",
          "First summarize the actual meaning of the latest PLAYER'S UTTERANCE in playerIntent and classify its speech act in intentType.",
          "The latest utterance is authoritative and takes precedence over the previous interrogation topic or planned narrative direction.",
          ...RUNTIME_PARAMETER_RULES,
          "When IMMEDIATE TURN TRANSITION is present, previous_scene has already happened. Begin with the target's new response to latest_input; do not replay the previous setup, positioning, mood, or conversation beat.",
          "If intentType is 'departure', the target must react to the player leaving and narration must enact the departure unless it is credibly prevented.",
          "If departure or refusal irreversibly abandons the objective, set outcome to 'lost' and return no choices.",
          "Never ignore a departure, refusal, surrender, accusation, threat, or concrete action merely to continue asking earlier questions.",
          "characterResponse must contain only the target character's substantive spoken response and immediately accompanying actions.",
          "Set responseSpeaker to exactly the TARGET CHARACTER, never player_identity.",
          "Set responseAnchor to a meaningful phrase copied exactly from playerUtterance. characterResponse must address the meaning of that phrase, but it need not repeat explicit, insulting, or otherwise objectionable wording.",
          "The player's utterance is an allowed in-game statement. Let the target respond in character, including accepting, rejecting, objecting to, or setting a boundary against the request as appropriate; do not silently discard the turn.",
          "TARGET CHARACTER PROFILE is authoritative for the target's identity, stable role, traits, and established relationship with player_identity, except where runtime_parameters or established player-facing events override it.",
          "Use TARGET CHARACTER PROFILE to keep characterResponse specific to the target. Do not invent or reveal omitted actions, significant events, story arc, or source references.",
          "Do not include a speaker-name prefix in characterResponse; the application adds it.",
          "characterResponse must not contain the player's thoughts, speech, decisions, or internal perspective.",
          "narration must follow the target response and describe its effect from player_identity's first-person singular perspective.",
          "Do not swap the target character and player_identity.",
          "In the PLAYER'S UTTERANCE, first-person words such as I, me, and my always refer to player_identity; second-person words such as you and your refer to the TARGET CHARACTER.",
          "When the player thanks the target for doing something to the player, preserve that direction: the target performed the action and the player received it. Never reverse actor and recipient in characterResponse.",
          "upcoming_source_material contains canonical events after the saved story cursor. Let the earliest compatible development affect the response or immediate narration only when it follows directly or occurs independently without assigning the player another unchosen action.",
          ...SOURCE_GROUNDING_RULES,
          ...TURN_SCOPE_RULES,
          ...SCENE_SCOPE_RULES,
          "Do not let an absent character answer or interact unless narration first makes their arrival explicit.",
          "Use objective and victoryCondition from the game context.",
          "Respect game_profile.endingMode: 'win' may produce won, 'completion' may produce completed, and 'open_ended' stays active.",
          "For a detective objective requiring a confession, set outcome to 'won' only if characterResponse contains the actual culprit's explicit admission of the crime.",
          "A credible bluff or extreme accumulated pressure may plausibly break the culprit and produce that confession even without complete forensic proof.",
          "If no confession occurs, outcome remains 'active'.",
          "For a terminal outcome explain it in outcomeReason.",
          ...STORY_MEMORY_RULES,
          ...SCENE_TITLE_RULES,
          ...COMPACT_DIALOGUE_STYLE_RULES,
        ].join("\n"),
        input: `${turnInstruction}`
          + (immediateTurnTransition
            ? `\n\nIMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):\n${JSON.stringify(immediateTurnTransition, null, 2)}`
            : "")
          + `\n\nPLAYER PERSPECTIVE RULES:\n${playerPerspective}`
          + "\n\nTARGET CHARACTER PROFILE (COMPACT; AUTHORITATIVE FOR THE TARGET):\n"
          + JSON.stringify(targetCharacterProfile, null, 2)
          + `\n\nGAME CONTEXT:\n${gameContext}`,
        text: {
          format: {
            type: "json_schema",
            name: "bookrpg_dialogue_scene",
            strict: true,
            schema: dialogueSchema,
          },
        },
        max_output_tokens: 1_400,
      });
      let output: DialogueSceneOutput;
      try {
        output = parseAiJson<DialogueSceneOutput>(
          response.output_text,
          "OpenAI dialogue response",
        );
      } catch (error) {
        if (!(error instanceof InvalidAiJsonError)) throw error;
        flowDiagnostic(
          `OpenAI dialogue draft ${attempt + 1}/4 rejected: ${error.message}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            dialogueInstruction,
            undefined,
            [error.message],
          ),
        );
        continue;
      }
      const sourceChapterPosition = output.sourceChapterPosition ?? null;
      const sourceCandidate = resolveGroundedSourceCandidate(
        sourceChapterPosition,
        routedCandidates,
      );
      if (sourceChapterPosition !== null && !sourceCandidate) {
        flowDiagnostic(
          `${this.client.provider} dialogue draft ${attempt + 1}/4 returned unsupported `
          + `sourceChapterPosition ${sourceChapterPosition}; source progress will not advance.`,
        );
      }
      const formatted = formatDialogueScene(
        character,
        output,
        state.playerName,
        playerText,
        state.scene.sceneScope,
        false,
      );
      const embeddedChoices = output.choices ?? [];
      const attributionFailures = dialogueAttributionFailures(
        output,
        playerText,
        character,
      );
      if (attributionFailures.length > 0) {
        flowDiagnostic(
          `OpenAI dialogue draft ${attempt + 1}/4 rejected: ${attributionFailures.join(" ")}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            dialogueInstruction,
            undefined,
            attributionFailures,
          ),
        );
        continue;
      }
      const unavailableCharacters = [
        ...sceneNonInteractableCharacters(
          state,
          formatted,
          routedCandidates.flatMap(
            (candidate) => candidate.unavailableCharacters ?? [],
          ),
        ),
      ];
      const proposedDialogueSetting = {
        ...formatted,
        choices: [],
        sceneScope: filterSceneScope(
          formatted.sceneScope!,
          {
            playerName: state.playerName,
            playerAliases: playerScopeAliases(
              state.playerName,
              state.characterProfiles,
            ),
            knownCharacterProfiles: state.characterProfiles,
            nonInteractableCharacters: unavailableCharacters,
          },
        ),
      };
      const repeatsRecentNarrative = sceneRepeatsRecentNarrative(
        proposedDialogueSetting,
        state,
      );
      const validationFailures = [
        ...sceneScopeFailures(proposedDialogueSetting.sceneScope, {
          playerName: state.playerName,
          playerAliases: playerScopeAliases(
            state.playerName,
            state.characterProfiles,
          ),
          knownCharacterProfiles: state.characterProfiles,
          nonInteractableCharacters: unavailableCharacters,
        }),
        ...(repeatsRecentNarrative
          ? ["The narrative substantially repeats a recent scene's events, actions, setting beats, or imagery instead of advancing the world state."]
          : []),
        ...(sceneUsesUnexpectedWritingSystem(
          proposedDialogueSetting,
          writingSystemReference,
        )
          ? ["The draft inserted a writing system absent from the established context."]
          : []),
      ];
      let semanticRepeat = false;
      let repetitionReview;
      if (validationFailures.length === 0) {
        const claimedRequiredSourceEvent = Boolean(sourceCandidate?.requiredEvent);
        repetitionReview = await this.reviewSceneRepetition(
          state,
          proposedDialogueSetting,
          routedCandidates[0],
          false,
          claimedRequiredSourceEvent,
          true,
          undefined,
          {
            playerUtterance: output.playerUtterance,
            responseSpeaker: output.responseSpeaker,
            characterResponse: output.characterResponse,
            narration: output.narration,
          },
        );
        if (
          repetitionReview
          && !repetitionReview.latestInputResolvedFaithfully
        ) {
          validationFailures.push(
            "The semantic continuity review found that the draft did not faithfully resolve "
            + "the latest input while preserving player identity and speaker roles: "
            + `${repetitionReview.latestInputFailureReason?.trim() || repetitionReview.reason}`,
          );
        }
        if (repetitionReview?.preservesPlayerPerspective === false) {
          validationFailures.push(
            "The semantic continuity review found that the dialogue narration switched away "
            + `from the player's first-person perspective: ${repetitionReview.playerPerspectiveFailureReason?.trim() || repetitionReview.reason}`,
          );
        }
        const aiNonInteractableFailures = sceneScopeFailures(
          proposedDialogueSetting.sceneScope,
          {
            playerName: state.playerName,
            playerAliases: playerScopeAliases(
              state.playerName,
              state.characterProfiles,
            ),
            knownCharacterProfiles: state.characterProfiles,
            nonInteractableCharacters: repetitionReview?.nonInteractableCharacters,
          },
        ).filter((failure) => failure.includes("non-interactable character"));
        if (aiNonInteractableFailures.length > 0) {
          validationFailures.push(
            ...aiNonInteractableFailures,
            "The semantic continuity review found that "
            + `${repetitionReview!.nonInteractableCharacters!.join(", ")} `
            + "are dead or otherwise not physically interactable: "
            + `${repetitionReview!.nonInteractableCharactersReason?.trim() || repetitionReview!.reason}`,
          );
        }
        if (repetitionReview && !repetitionReview.preservesPlayerAgency) {
          validationFailures.push(
            "The semantic continuity review found that the draft performed a consequential "
            + "player action that was not selected: "
            + `${repetitionReview.playerAgencyFailureReason?.trim() || repetitionReview.reason}`,
          );
        }
        if (repetitionReview && !repetitionReview.staysWithinTurnScope) {
          validationFailures.push(
            "The semantic continuity review found that the draft advanced beyond the player's "
            + "utterance and its immediate consequences: "
            + `${repetitionReview.turnScopeFailureReason?.trim() || repetitionReview.reason}`,
          );
        }
        if (repetitionReview?.repeatsPriorScene) {
          semanticRepeat = true;
          validationFailures.push(
            `The semantic repetition review found that the draft repeats prior narrative state: ${repetitionReview.reason}`,
          );
        }
      }

      if (validationFailures.length > 0) {
        flowDiagnostic(
          `OpenAI dialogue draft ${attempt + 1}/4 rejected: ${validationFailures.join(" ")}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            dialogueInstruction,
            undefined,
            validationFailures,
          ),
          repeatsRecentNarrative || semanticRepeat,
        );
        continue;
      }

      const reviewedUnavailableCharacters = [
        ...new Set([
          ...unavailableCharacters,
          ...(repetitionReview?.nonInteractableCharacters ?? []),
        ]),
      ];
      const presenceReview = await this.reviewScenePresence(
        state,
        proposedDialogueSetting,
        reviewedUnavailableCharacters,
        routedCandidates,
      );
      const reviewedVisibleEvent = reviewedVisibleSourceEvent(
        routedCandidates[0],
        presenceReview.latestVisibleSourceEventId,
      );
      const dialogueSetting = {
        ...proposedDialogueSetting,
        sceneScope: filterSceneScope(
          {
            currentLocation: proposedDialogueSetting.sceneScope.currentLocation,
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
      const presenceValidationFailures = sceneScopeFailures(
        dialogueSetting.sceneScope,
        {
          playerName: state.playerName,
          playerAliases: playerScopeAliases(
            state.playerName,
            state.characterProfiles,
          ),
          knownCharacterProfiles: state.characterProfiles,
          nonInteractableCharacters: reviewedUnavailableCharacters,
        },
      );
      if (presenceReview.turnValidation?.status === "repair_scene") {
        presenceValidationFailures.push(...presenceReview.turnValidation.findings.map(finding => finding.message));
      }
      if (presenceValidationFailures.length > 0) {
        flowDiagnostic(
          `OpenAI dialogue draft ${attempt + 1}/4 rejected: ${presenceValidationFailures.join(" ")}`,
        );
        turnInstruction = applyStagnationBreak(
          buildSceneRegenerationInstruction(
            dialogueInstruction,
            undefined,
            presenceValidationFailures,
          ),
        );
        continue;
      }
      const verifiedSourceCandidate: SourceContinuationCandidate | undefined =
        sourceCandidate
        && (
          !sourceCandidate.requiredEvent
          || (
            repetitionReview?.requiredEventOccurred
            && (
              !sourceCandidate.requiredEventId
              || reviewedVisibleEvent?.eventId === sourceCandidate.requiredEventId
            )
          )
        )
          ? sourceCandidate
          : undefined;
      const completedSourceEventId = reviewedVisibleEvent?.eventId ?? undefined;
      const choiceNavigationEvent = nextSignificantEventForCandidate(
        routedCandidates[0],
        completedSourceEventId,
      );
      const generatedChoices = embeddedChoices.length > 0
        ? embeddedChoices
        : (dialogueSetting.outcome ?? "active") === "active"
          ? await this.sceneChoices(
              dialogueSetting,
              state,
              routedCandidates,
              undefined,
              completedSourceEventId,
              [],
              [],
              reviewedUnavailableCharacters,
            )
          : [];
      const scopedFormatted = normalizeSceneTalkChoices({
        ...dialogueSetting,
        choices: generatedChoices,
      }, false);
      const identityFiltered = removeChoicesWithPlayerIdentityReferences(
        scopedFormatted,
        state.playerName,
        state.characterProfiles,
      );
      const introducedCharacterScene = removeChoicesWithUnintroducedCharacters(
        identityFiltered,
        state,
        visibleSourceEventNarrative(routedCandidates),
        reviewedUnavailableCharacters,
      );
      const distinct = removeDuplicateChoices(introducedCharacterScene);
      const scene = addSourceContinuationChoiceFallback(
        removeRecentChoiceParaphrases(distinct, state.history),
      );
      const anchorChoiceWasFiltered = firstChoiceWasFiltered(
        generatedChoices,
        scene.choices,
        scene.outcome,
      );
      const choiceValidationFailures = [
        ...(hasTooFewChoicesForActiveScene(scene)
          ? [
              `Only ${scene.choices.length} distinct usable choice(s) remained; at least 2 are required.`,
            ]
          : []),
        ...filteredAnchorChoiceFailures(
          anchorChoiceWasFiltered,
          attempt,
          maxAttempts,
        ),
      ];
      let anchorOrderedScene = scene;
      if (
        choiceValidationFailures.length === 0
        && (scene.outcome ?? "active") === "active"
      ) {
        let choiceReview = await this.reviewSceneChoices(
          state,
          scene,
          routedCandidates[0],
          completedSourceEventId,
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
          const requiresExplicitPlayerChoice = sourceEventRequiresExplicitPlayerChoice(
            choiceNavigationEvent,
            state.playerName,
            state.characterProfiles,
            dialogueSetting.sceneScope,
          );
          const repairedChoices =
            acceptedChoices.length >= 2 && !requiresExplicitPlayerChoice
              ? acceptedChoices
              : await this.sceneChoices(
                  dialogueSetting,
                  state,
                  routedCandidates,
                  undefined,
                  completedSourceEventId,
                  acceptedChoices,
                  rejectedChoiceTexts,
                  reviewedUnavailableCharacters,
                );
          anchorOrderedScene = normalizeSceneTalkChoices({
            ...scene,
            choices: repairedChoices,
          }, false);
          flowDiagnostic(
            `${this.client.provider} dialogue choice scope review removed `
            + `${unusableChoiceIndexes.length} unusable choice(s): `
            + `${choiceReview.unusableChoicesReason || choiceReview.reason}`,
          );
          if (hasTooFewChoicesForActiveScene(anchorOrderedScene)) {
            choiceValidationFailures.push(
              "The semantic choice scope review left fewer than two immediately usable choices.",
            );
          }
          if (choiceValidationFailures.length === 0) {
            choiceReview = await this.reviewSceneChoices(
              state,
              anchorOrderedScene,
              routedCandidates[0],
              completedSourceEventId,
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
        if (
          choiceReview.anchorChoiceIndex === null
          && !hasSourceContinuationChoiceFallback(anchorOrderedScene)
        ) {
          anchorOrderedScene = addSourceContinuationAnchorChoice(anchorOrderedScene);
        } else if (choiceReview.anchorChoiceIndex !== null) {
          anchorOrderedScene = promoteAnchorChoice(
            anchorOrderedScene,
            choiceReview.anchorChoiceIndex,
            choiceNavigationEvent?.eventId ?? undefined,
          );
        }
      }
      if (choiceValidationFailures.length === 0) {
        return {
          ...anchorOrderedScene,
          ...(verifiedSourceCandidate
            ? {
                sourceProgress: groundedSourceProgress(verifiedSourceCandidate),
              }
            : {}),
        };
      }

      flowDiagnostic(
        `OpenAI dialogue draft ${attempt + 1}/4 rejected: ${choiceValidationFailures.join(" ")}`,
      );
      turnInstruction = applyStagnationBreak(
        buildSceneRegenerationInstruction(
          dialogueInstruction,
          undefined,
          choiceValidationFailures,
          generatedChoices.map((choice) => choice.text),
        ),
      );
    }

    throw new Error(
      "The dialogue response could not be generated. Your reply was not saved; please rephrase it or choose another response.",
    );
  }
}

