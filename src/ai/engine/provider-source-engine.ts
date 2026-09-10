import { flowDiagnostic } from "../../util/flow-trace.js";
import type {
  GameState,
} from "../../shared/contracts.js";
import {
  sourceContinuationJsonSchemaForCandidates,
  sourceEventJsonSchemaForBlocks,
} from "../schema.js";
import {
  InvalidAiJsonError,
  parseAiJson,
  SOURCE_EVENT_MAX_LOOKAHEAD_BLOCKS,
} from "./core.js";
import type {
  SourceContinuationCandidate,
  SourceEventSelection,
} from "./core.js";
import {
  stripEmbeddedChoiceMenu,
} from "./normalization.js";
import {
  ProviderTurnEngine,
} from "./provider-turn-engine.js";
import {
  RUNTIME_PARAMETER_RULES,
} from "./rules.js";
import {
  buildCanonBlock,
} from "./scene-context.js";
import {
  buildSourceEventBlocks,
  resolveSourceContinuationSelection,
  resolveRecoveryChapterSelection,
} from "./source.js";
import type {
  SourceContinuationSelection,
} from "./source.js";
import {
  buildImmediateTurnTransition,
} from "./turn.js";

function activeSourceEventId(state: GameState): string | undefined {
  return state.sourceEventProgress?.eventId;
}

function activeEventStillIncomplete(
  state: GameState,
  beatCount: number | undefined,
): boolean {
  const progress = state.sourceEventProgress;
  if (!progress) return false;
  if (!beatCount || beatCount <= 0) return true;
  const completed = new Set(
    progress.completedBeatIndexes.filter(
      (index) => Number.isInteger(index) && index >= 0 && index < beatCount,
    ),
  );
  return completed.size < beatCount;
}

function candidateForActiveSourceEvent(
  state: GameState,
  candidate: SourceContinuationCandidate,
): SourceContinuationCandidate | undefined {
  const eventId = activeSourceEventId(state);
  if (!eventId) return undefined;

  if (candidate.requiredEventId === eventId && candidate.requiredEvent?.trim()) {
    if (!activeEventStillIncomplete(state, candidate.requiredEventBeats?.length)) {
      return undefined;
    }
    return candidate;
  }

  const event = candidate.storyEvents?.find((storyEvent) => storyEvent.eventId === eventId);
  if (!event || !activeEventStillIncomplete(state, event.beats?.length)) {
    return undefined;
  }

  return {
    ...candidate,
    requiredEvent: event.description,
    requiredEventId: event.eventId,
    requiredEventCategory: event.category,
    requiredEventActors: event.actors,
    requiredEventTargets: event.targets,
    ...(event.beats ? { requiredEventBeats: event.beats } : {}),
  };
}

function activeSourceCandidate(
  state: GameState,
  candidates: readonly SourceContinuationCandidate[],
): SourceContinuationCandidate | undefined {
  for (const candidate of candidates) {
    const activeCandidate = candidateForActiveSourceEvent(state, candidate);
    if (activeCandidate) return activeCandidate;
  }
  return undefined;
}

export abstract class ProviderSourceEngine extends ProviderTurnEngine {
  async selectSourceCandidate(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<SourceContinuationCandidate | undefined> {
    if (candidates.length === 0) return undefined;
    const reusedActiveCandidate = activeSourceCandidate(state, candidates);
    if (reusedActiveCandidate) {
      flowDiagnostic(
        `${this.client.provider} source continuation selection skipped: `
        + `reusing active source event ${state.sourceEventProgress!.eventId}.`,
      );
      return reusedActiveCandidate;
    }
    const recoverySelection = candidates.some((candidate) => candidate.recovery);
    const response = await this.createResponse("source continuation selection", state.book.bookId, {
      model: this.model,
      reasoning: { effort: this.reasoningEffort },
      instructions: [
        recoverySelection
          ? "Use CURRENT PLAYER-FACING STATE to locate the current scene approximately among ORDERED CHAPTER SUMMARIES, then select the chapter containing the earliest concrete event that should happen next."
          : "Select the earliest candidate chapter whose next source-backed development can be adapted coherently into the current interactive game state.",
        "Chapter summaries are an ordered timeline map. They do not establish that future events already happened.",
        ...RUNTIME_PARAMETER_RULES,
        "Set currentChapterPosition to the chapter that best contains the current player-facing beat.",
        "Select that chapter only when material after the saved cursor still contains a concrete new event. If it merely repeats the visible setup, routine, waiting state, or already resolved beat, select the nearest later story chapter with a compatible concrete development.",
        "A selected candidate is a navigation anchor, not authorization to perform another player decision now. It remains compatible when the generated scene must stop at a voluntary choice that causally leads toward its event.",
        "You may select a later chapter when that is the earliest reliable way to escape a repeated local beat. Prefer the nearest compatible later chapter; do not skip a usable earlier concrete event for drama.",
        "A later chapter cannot represent the current beat when reaching it requires an intervening death, attack, departure, discovery, visit, investigation, or other irreversible event absent from CURRENT PLAYER-FACING STATE.",
        "Completed player actions and established world changes are authoritative and cannot be undone.",
        "A chapter is compatible when its next narrative development can still occur with reasonable adaptation.",
        "Reject candidates that require resurrecting dead characters, erasing established events, changing player identity, or otherwise contradicting immutable game facts.",
        "When compatible is true, copy candidateIndex and chapterPosition exactly from the selected chapter.",
        "Return compatible false with candidateIndex and chapterPosition null only when no chapter can coherently continue. Keep currentChapterPosition as the best position estimate when one exists.",
        "Explain the compatibility decision briefly in reason.",
      ].join("\n"),
      input: [
        "CURRENT PLAYER-FACING STATE (ONLY THESE EVENTS HAVE HAPPENED):",
        JSON.stringify({
          playerIdentity: state.playerName,
          currentScene: {
            title: state.scene.title,
            text: stripEmbeddedChoiceMenu(state.scene.text),
            development: state.scene.development ?? "",
            sceneScope: state.scene.sceneScope ?? null,
          },
          recentScenes: state.history
            .filter((item) => item.kind === "scene")
            .slice(-6)
            .map((item) => ({
              text: stripEmbeddedChoiceMenu(item.text),
              development: item.development ?? "",
            })),
          sourceCursor: state.sourceCursor ?? null,
          runtime_parameters: state.parameters ?? [],
          immediateTransition: buildImmediateTurnTransition(state) ?? null,
          objective: state.objective,
          storyMemory: state.storyMemory ?? null,
          canon: buildCanonBlock(state),
          explicitTimelineRule: "Every summary event absent from currentScene and recentScenes is still in the future.",
        }, null, 2),
        "ORDERED CHAPTER SUMMARIES:",
        JSON.stringify(candidates.map((candidate, candidateIndex) => ({
          candidateIndex,
          chapterPosition: candidate.chapterPosition,
          chapterTitle: candidate.chapterTitle,
          summary: candidate.summary,
          openingAfterCursor: candidate.excerpt.slice(0, 240),
        })), null, 2),
      ].join("\n\n"),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_source_continuation",
          strict: true,
          schema: sourceContinuationJsonSchemaForCandidates(
            candidates.map((candidate) => candidate.chapterPosition),
          ),
        },
      },
      max_output_tokens: 500,
    });
    let selection: SourceContinuationSelection;
    try {
      selection = parseAiJson<SourceContinuationSelection>(
        response.output_text,
        "OpenAI source continuation selection",
      );
    } catch (error) {
      if (!(error instanceof InvalidAiJsonError)) throw error;
      flowDiagnostic(`OpenAI source continuation selection rejected: ${error.message}`);
      return recoverySelection && state.sourceCursor
        ? candidates.find(
            (candidate) =>
              candidate.chapterPosition === state.sourceCursor?.chapterPosition,
          )
        : undefined;
    }
    flowDiagnostic(
      `${this.client.provider} source continuation selection: `
      + `currentChapterPosition=${selection.currentChapterPosition ?? "none"}, `
      + `candidateIndex=${selection.candidateIndex ?? "none"}, `
      + `chapterPosition=${selection.chapterPosition ?? "none"}, `
      + `${selection.reason}`,
    );
    return recoverySelection
      ? resolveRecoveryChapterSelection(selection, candidates)
      : resolveSourceContinuationSelection(selection, candidates);
  }

  async selectSourceEvent(
    state: GameState,
    candidate: SourceContinuationCandidate,
  ): Promise<SourceContinuationCandidate | undefined> {
    const reusedActiveCandidate = candidateForActiveSourceEvent(state, candidate);
    if (reusedActiveCandidate) {
      flowDiagnostic(
        `${this.client.provider} source event selection skipped: `
        + `reusing active source event ${state.sourceEventProgress!.eventId}.`,
      );
      return reusedActiveCandidate;
    }

    const blocks = buildSourceEventBlocks(candidate)
      .slice(0, SOURCE_EVENT_MAX_LOOKAHEAD_BLOCKS);
    if (blocks.length === 0) return undefined;

    const tokenAttempts = [300, 600, 1_200] as const;
    let lastFailure = "no response";
    let selection: SourceEventSelection | undefined;

    for (const maxOutputTokens of tokenAttempts) {
      const response = await this.createResponse("source event selection", state.book.bookId, {
        model: this.model,
        reasoning: { effort: this.reasoningEffort },
        instructions: [
          "Locate the current player-facing scene on the ordered event timeline in SELECTED CHAPTER SUMMARY.",
          "Identify the next major summary event after that scene, then choose the earliest source block that contains or directly leads into that event.",
          "If the selected chapter begins later than the current player-facing beat and does not contain that beat, choose the chapter's earliest compatible concrete event instead of inventing a match.",
          "Use only CURRENT PLAYER-FACING STATE to decide what already happened.",
          "Return a complete JSON object that matches the required schema exactly. Do not output partial JSON or a truncated response.",
          ...RUNTIME_PARAMETER_RULES,
          "An event has happened only when currentScene or recentScenes explicitly depicts it. Mood, tension, preparation, a character's motive, an objective, an outcome reason, or wording such as 'as if nothing changed' does not establish an unseen announcement, attack, death, cover-up, or investigation.",
          "The selected event must visibly change the state beyond currentScene. Do not select another description of waiting, rehearsing, preparing, greeting, or other setup already visible in the player-facing scene.",
          "Never infer skipped events between the latest visible action and a later summary event. Every intervening summary event absent from the player-facing scenes is still in the future.",
          "An event described by the summary but not yet shown is still in the future and is exactly what you must select.",
          "Do not skip an earlier major summary event to choose a more dramatic later event.",
          "Before choosing a block, list the causal prerequisites of its event mentally. A death must be visibly caused before its discovery or investigation; an investigation requires the triggering incident; an aftermath requires the event it follows.",
          "If the earliest still-unshown summary event is a prerequisite for every event in the supplied blocks but is not itself present in any supplied block, set compatible false, blockIndex null, event to an empty string, and explain which prerequisite is missing.",
          "Never treat a later block's reference to an outcome, such as finding someone dead, as evidence that the unseen event causing that outcome already occurred.",
          "The source may deliberately omit or paraphrase the contents of dialogue. In that case, use the chapter summary to identify the event and select the block where the dialogue occurs.",
          "The selected block must contain enough source material to make the next event visibly happen in a new interactive scene.",
          "Set event to one concise, explicit sentence describing only the selected next event. Include the material content of an announcement or revelation from the summary rather than saying merely that someone speaks or reveals something.",
          "Every person, object, action, and fact named in event must be directly supported by the selected source block. Do not import an interactive-scene invention or infer a different event from mood, metadata, or prior game history.",
          "Keep consecutive summary events separate. If the summary says an announcement causes a later attack, select and describe only the announcement; never combine it with the attack using 'after', 'then', or similar wording.",
          "Select the block where the chosen event begins, not a later block that overlaps its ending or leads into the following event.",
          "When compatible is true, you must select exactly one supplied block and describe its earliest unshown event.",
          "When ORDERED SIGNIFICANT EVENTS is non-empty and compatible is true, eventId must exactly equal the earliest still-unshown listed event represented by the selected block. Copy its description into event without merging it with a later event.",
          "When ORDERED SIGNIFICANT EVENTS is empty, set eventId null.",
        ].join("\n"),
        input: [
          "CURRENT PLAYER-FACING STATE:",
          JSON.stringify({
            currentScene: {
              title: state.scene.title,
              text: stripEmbeddedChoiceMenu(state.scene.text),
              development: state.scene.development ?? "",
              sceneScope: state.scene.sceneScope ?? null,
            },
            recentScenes: state.history
              .filter((item) => item.kind === "scene")
              .slice(-6),
            sourceCursor: state.sourceCursor ?? null,
            runtime_parameters: state.parameters ?? [],
          }, null, 2),
          "SELECTED CHAPTER SUMMARY:",
          candidate.summary,
          "ORDERED SIGNIFICANT EVENTS:",
          JSON.stringify(candidate.storyEvents ?? [], null, 2),
          "ORDERED SOURCE BLOCKS:",
          JSON.stringify(blocks.map((block, blockIndex) => ({
            blockIndex,
            sourceStart: block.nextTextOffset - block.excerpt.length,
            sourceEnd: block.nextTextOffset,
            text: block.excerpt,
          })), null, 2),
        ].join("\n\n"),
        text: {
          format: {
            type: "json_schema",
            name: "bookrpg_source_event",
            strict: true,
            schema: sourceEventJsonSchemaForBlocks(blocks.length),
          },
        },
        max_output_tokens: maxOutputTokens,
      });

      if (response.status === "incomplete") {
        const details = JSON.stringify(response.incomplete_details) ?? "no details";
        if (!details.includes("max_output_tokens")) {
          throw new Error(`AI source event selection returned an incomplete response: ${details}`);
        }
        lastFailure = `incomplete response: ${details}`;
        continue;
      }

      try {
        selection = parseAiJson<SourceEventSelection>(
          response.output_text,
          "OpenAI source event selection",
        );
        break;
      } catch (error) {
        if (!(error instanceof InvalidAiJsonError)) throw error;
        lastFailure = error.message;
        flowDiagnostic(`OpenAI source event selection rejected: ${error.message}`);
      }
    }

    if (!selection) {
      flowDiagnostic(
        `OpenAI source event selection unavailable after ${tokenAttempts.length} attempts; `
        + `keeping the confirmed source cursor. Last failure: ${lastFailure}`,
      );
      return undefined;
    }

    if (!selection.compatible || selection.blockIndex === null) {
      flowDiagnostic(
        `${this.client.provider} source event selection: `
        + `compatible=false; blockIndex=${selection.blockIndex ?? "none"}; `
        + `reportedEventId=${selection.eventId ?? "none"}; `
        + `reportedEvent=${selection.event.trim() || "none"}; `
        + `acceptedEventId=none; acceptedEvent=none; ${selection.reason}`,
      );
      return undefined;
    }
    const selectedBlock = blocks[selection.blockIndex];
    const selectedStoryEvent = candidate.storyEvents?.find(
      (event) => event.eventId === selection.eventId,
    );
    if (
      candidate.storyEvents?.length
      && (!selection.eventId || !selectedStoryEvent)
    ) {
      throw new Error("OpenAI source event selection returned an invalid story event ID");
    }
    const requiredEvent = selectedStoryEvent?.description ?? selection.event.trim();
    if (!selectedBlock || !requiredEvent) {
      throw new Error("OpenAI source event selection returned an invalid event");
    }
    flowDiagnostic(
      `${this.client.provider} source event selection: `
      + `compatible=true; blockIndex=${selection.blockIndex}; `
      + `reportedEventId=${selection.eventId ?? "none"}; `
      + `reportedEvent=${selection.event.trim()}; `
      + `acceptedEventId=${selectedStoryEvent?.eventId ?? "none"}; `
      + `acceptedEvent=${requiredEvent}; ${selection.reason}`,
    );
    return {
      ...selectedBlock,
      ...(candidate.currentStoryEvent
        ? { currentStoryEvent: candidate.currentStoryEvent }
        : {}),
      ...(candidate.storyEvents
        ? { storyEvents: candidate.storyEvents }
        : {}),
      requiredEvent,
      ...(selectedStoryEvent
        ? {
            requiredEventId: selectedStoryEvent.eventId,
            requiredEventCategory: selectedStoryEvent.category,
            requiredEventActors: selectedStoryEvent.actors,
            requiredEventTargets: selectedStoryEvent.targets,
            ...(selectedStoryEvent.beats
              ? { requiredEventBeats: selectedStoryEvent.beats }
              : {}),
          }
        : {}),
    };
  }
}
