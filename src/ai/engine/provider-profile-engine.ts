import { flowDiagnostic } from "../../util/flow-trace.js";
import type {
  BookGameProfile,
  EstablishedEvent,
  GameState,
  ImportedBook,
} from "../../shared/contracts.js";
import {
  bookGameProfileJsonSchema,
  establishedEventAssessmentJsonSchema,
  playerAvailabilityJsonSchema,
} from "../schema.js";
import type {
  AiResponse,
  AiResponseRequest,
} from "../provider.js";
import {
  parseAiJson,
} from "./core.js";
import type {
  PlayerAvailability,
  SourceContinuationCandidate,
} from "./core.js";
import {
  stripEmbeddedChoiceMenu,
  normalizePlayerAvailability,
  normalizeEstablishedEventAssessment,
} from "./normalization.js";
import {
  ProviderSceneEngine,
} from "./provider-scene-engine.js";
import {
  findPassageContext,
  buildPlayerAvailabilityContext,
  sourceActionsCompletedAtSelectedMoment,
} from "./scene-context.js";
import {
  sourceEventCompletionReference,
} from "./source-navigation.js";

const MAX_SCENE_OUTPUT_TOKENS = 25_600;

export abstract class ProviderProfileEngine extends ProviderSceneEngine {
  protected async createResponse(
    label: string,
    bookId: string,
    request: AiResponseRequest,
  ): Promise<AiResponse> {
    let response = await super.createResponse(label, bookId, request);
    if (request.text?.format.name !== "bookrpg_scene") return response;

    let maxOutputTokens = request.max_output_tokens ?? 1_600;
    while (
      response.status === "incomplete"
      && JSON.stringify(response.incomplete_details).includes("max_output_tokens")
      && maxOutputTokens < MAX_SCENE_OUTPUT_TOKENS
    ) {
      const nextMaxOutputTokens = Math.min(
        maxOutputTokens * 2,
        MAX_SCENE_OUTPUT_TOKENS,
      );
      flowDiagnostic(
        `${this.client.provider} scene response was truncated at ${maxOutputTokens} output tokens; `
        + `retrying the same generation attempt with ${nextMaxOutputTokens} output tokens.`,
      );
      maxOutputTokens = nextMaxOutputTokens;
      response = await super.createResponse(label, bookId, {
        ...request,
        max_output_tokens: maxOutputTokens,
      });
    }
    return response;
  }

  async classifyBook(book: ImportedBook): Promise<BookGameProfile> {
    const response = await this.createResponse("book classification", book.bookId, {
      model: this.model,
      reasoning: { effort: this.reasoningEffort },
      instructions: [
        "Classify how this book naturally supports an interactive role-playing experience.",
        "Choose category 'mystery' for investigation/revelation, 'adventure' for goal-driven journeys, 'survival' for enduring danger, 'drama' for interpersonal conflict, 'exploration' for discovery-led narratives, or 'open_ended' when no other category dominates.",
        "Choose endingMode 'win' only when player roles can have a clear success/failure objective.",
        "Choose endingMode 'completion' when the experience should reach a natural narrative destination without declaring a winner.",
        "Choose endingMode 'open_ended' when play should continue through milestones without a forced final endpoint.",
        "Base the classification on the supplied whole-book analysis, not on assumptions from the title alone.",
      ].join("\n"),
      input: JSON.stringify({
        title: book.title,
        author: book.author,
        summary: book.worldBible?.summary,
        characters: book.worldBible?.characters,
        characterProfiles: book.worldBible?.characterProfiles,
        locations: book.worldBible?.locations,
      }, null, 2),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_book_game_profile",
          strict: true,
          schema: bookGameProfileJsonSchema,
        },
      },
      max_output_tokens: 800,
    });
    const profile = JSON.parse(response.output_text) as BookGameProfile;
    if (!profile.description?.trim()) {
      throw new Error("OpenAI returned an empty book game profile description");
    }
    return { ...profile, description: profile.description.trim() };
  }

  async validatePlayer(state: GameState, book: ImportedBook): Promise<PlayerAvailability> {
    const availabilityContext = buildPlayerAvailabilityContext(state, book);
    state.position = availabilityContext.resolvedPosition;
    const response = await this.createResponse("player validation", state.book.bookId, {
      model: this.model,
      reasoning: { effort: this.reasoningEffort },
      instructions: [
        "Determine whether the selected player identity can physically and coherently participate in a game anchored at the selected passage.",
        "When story_text_ending_at_selected_moment contains an actionable narrative scene, treat its ending as the exact selected story moment.",
        "When the selected text is front matter, bibliographic text, a heading, or otherwise has no actionable scene, use whole_book_summary to establish a plausible opening point in the story. Do not reject a player solely because no character is active in non-narrative selected text.",
        "When player_character_profile is present, treat it as authoritative for the player's identity, role, physical nature, and capabilities.",
        "A canonical character does not need to share the source narrator's location. If that character can act elsewhere at the same story moment, playable may be true and the game should use the character's own concurrent, physically coherent location.",
        "For a canonical book character at an actionable selected moment, playable must be false if that character is already dead, unconscious, imprisoned without any meaningful action, or otherwise unable to act anywhere at this moment.",
        "Do not revive characters, create ghosts, rewrite prior events, or silently create an alternate timeline.",
        "A custom persona does not need to appear in the canonical text and should be playable when they can plausibly be introduced without contradicting established events.",
        "Use whole_book_summary to understand the overall plot, setting, roles, and possible game stakes.",
        "The summary may describe events after an actionable selected moment. Do not reveal those later events in reason, treat them as having happened early, or use them to reject a player who is currently able to act.",
        "When playable is false, explain the current incompatibility briefly in reason without revealing later plot events, and set objective and victoryCondition to empty strings.",
        "When playable is true, give a brief confirmation in reason based on the character's status at this moment, then create a concise role-specific objective and an observable victoryCondition.",
        "Align the objective and victoryCondition with book_game_profile.endingMode.",
        "For endingMode 'win', define clear success. If player_identity is investigating a crime, victoryCondition must require an explicit confession by the actual culprit.",
        "That confession may be earned through accumulated evidence, contradictions, a credible bluff, or extreme psychological pressure; complete forensic proof is not mandatory.",
        "For endingMode 'completion', victoryCondition describes the natural role-specific conclusion to reach, not a victory over someone.",
        "For endingMode 'open_ended', victoryCondition must say there is no fixed ending and name meaningful role-specific milestones instead.",
      ].join("\n"),
      input: availabilityContext.context,
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_player_availability",
          strict: true,
          schema: playerAvailabilityJsonSchema,
        },
      },
      max_output_tokens: 1_000,
    });
    return normalizePlayerAvailability(JSON.parse(response.output_text));
  }

  async identifyEstablishedEvent(
    state: GameState,
    book: ImportedBook,
  ): Promise<EstablishedEvent | undefined> {
    const completedActions = sourceActionsCompletedAtSelectedMoment(
      book,
      state.selectedText,
    );
    if (completedActions.length === 0) return undefined;
    const passage = findPassageContext(book, state.selectedText);
    const response = await this.createResponse("established event assessment", state.book.bookId, {
      model: this.model,
      reasoning: { effort: this.reasoningEffort },
      instructions: [
        "Determine whether one supplied completed source action is a major irreversible event whose immediate aftermath materially defines this game's exact opening point.",
        "Routine movement, conversation, preparation, observation, and reversible decisions are not established events. Death, major violence, betrayal, disaster, abduction, and consequential accidents normally are.",
        "Only use COMPLETED SOURCE ACTIONS. Do not select later events from the whole-book summary or invent an event.",
        "When no supplied action qualifies, set established false and event null.",
        "When one qualifies, set established true and populate event entirely from supplied context. sourceBacked must be true.",
        "Choose a language-independent category. actor and means may be empty only when they genuinely do not apply; action, target, immediateConsequences, and narrative must be concrete.",
        "Write narrative as 1 to 3 player-facing sentences stating the event and its immediate physical or social consequences.",
        "For central source-backed violence, use vivid graphic sensory and bodily detail supported by the source without inventing injuries.",
      ].join("\n"),
      input: JSON.stringify({
        player_identity: state.playerName,
        objective: state.objective,
        victoryCondition: state.victoryCondition,
        selected_moment: passage.textThroughPassage,
        completed_source_actions: completedActions,
      }, null, 2),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_established_event_assessment",
          strict: true,
          schema: establishedEventAssessmentJsonSchema,
        },
      },
      max_output_tokens: 800,
    });
    return normalizeEstablishedEventAssessment(
      parseAiJson(response.output_text, "OpenAI established event assessment"),
    );
  }

  async identifyLatestVisibleStoryEvent(
    state: GameState,
    candidate: SourceContinuationCandidate,
  ): Promise<string | undefined> {
    if (candidate.currentStoryEvent) {
      const nextEvent = (candidate.storyEvents ?? [])
        .filter((event) => event.sequence > candidate.currentStoryEvent!.sequence)
        .sort((left, right) => left.sequence - right.sequence)[0];
      if (!nextEvent) return candidate.currentStoryEvent.eventId;

      const alignment = await this.sceneEventAlignment<{
        nextEventOccurred: boolean;
        reason: string;
      }>(state.book.bookId, {
        model: this.model,
        reasoning: { effort: "low" },
        instructions: [
          "Decide only whether DIRECT NEXT EVENT is visibly completed in CURRENT SCENE TEXT.",
          "CURRENT EVENT is already completed before this check. Do not assess or select any later event.",
          "Use DIRECT NEXT EVENT.description plus any listed criticalBeats as the completion contract. Require every distinct action or outcome named there and every listed critical beat.",
          "A general outcome phrase does not substitute for a missing critical beat. Do not require unlisted source beats, participants, causes, or details that the completion contract omits.",
          "Use only CURRENT SCENE TEXT as evidence. Ignore metadata, memory, summaries, future knowledge, implications, intentions, preparation, and events merely described as imminent.",
          "An intention or decision to perform a physical act does not complete that act. A concrete physical event requires the text to explicitly depict its action, participants, and named object when applicable.",
          "An internal reaction or decision event counts only when the text explicitly depicts that reaction or decision.",
          "Set nextEventOccurred false whenever the exact next event is absent or ambiguous.",
        ].join("\n"),
        input: [
          "CURRENT SCENE TEXT:",
          stripEmbeddedChoiceMenu(state.scene.text),
          "CURRENT EVENT:",
          JSON.stringify(
            sourceEventCompletionReference(candidate.currentStoryEvent),
            null,
            2,
          ),
          "DIRECT NEXT EVENT:",
          JSON.stringify(sourceEventCompletionReference(nextEvent), null, 2),
        ].join("\n\n"),
        text: {
          format: {
            type: "json_schema",
            name: "bookrpg_scene_event_alignment",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                nextEventOccurred: { type: "boolean" },
                reason: { type: "string" },
              },
              required: ["nextEventOccurred", "reason"],
            },
          },
        },
      });
      return alignment?.nextEventOccurred
        ? nextEvent.eventId
        : candidate.currentStoryEvent.eventId;
    }

    const events = [
      ...(candidate.storyEvents ?? []),
    ].filter(
      (event, index, all) =>
        all.findIndex((candidateEvent) => candidateEvent.eventId === event.eventId) === index,
    );
    if (events.length === 0) return undefined;
    const eventIds = events.map((event) => event.eventId);
    const alignment = await this.sceneEventAlignment<{
      eventId: string | null;
      reason: string;
    }>(state.book.bookId, {
      model: this.model,
      reasoning: { effort: "low" },
      instructions: [
        "Identify the latest ordered significant event that is visibly completed in CURRENT SCENE TEXT.",
        "Use each event's short description plus any listed criticalBeats as its completion contract. Require every distinct action or outcome named there and every listed critical beat.",
        "A general outcome phrase does not substitute for a missing critical beat. Do not require unlisted source beats, participants, causes, or details that the completion contract omits.",
        "Use only CURRENT SCENE TEXT as evidence. Do not use development metadata, memory, summaries, future knowledge, implications, intentions, preparation, or an event merely being imminent.",
        "A decision or intention to perform a physical act is never evidence that the physical act occurred. For an event involving a concrete action or named object, the scene must explicitly depict that action and object.",
        "An internal reaction or decision event counts only when the scene text explicitly depicts that reaction or decision.",
        "Return null when none of the listed events is visibly completed.",
        "Never move backward merely because an earlier event is mentioned as context.",
      ].join("\n"),
      input: [
        "CURRENT SCENE TEXT:",
        stripEmbeddedChoiceMenu(state.scene.text),
        "ORDERED SIGNIFICANT EVENTS:",
        JSON.stringify(events.map(sourceEventCompletionReference), null, 2),
      ].join("\n\n"),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_scene_event_alignment",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              eventId: {
                type: ["string", "null"],
                enum: [null, ...eventIds],
              },
              reason: { type: "string" },
            },
            required: ["eventId", "reason"],
          },
        },
      },
    });
    if (!alignment || alignment.eventId === null) return undefined;
    if (!eventIds.includes(alignment.eventId)) {
      flowDiagnostic(
        "OpenAI scene event alignment returned an invalid event ID; keeping the confirmed source cursor.",
      );
      return undefined;
    }
    return alignment.eventId;
  }
}
