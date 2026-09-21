import type {
  ChoiceStakes,
  SourceCursor,
  CharacterProfile,
} from "../../shared/contracts.js";
import {
  configuredAiReasoningEffort,
} from "../provider.js";
import type {
  AiReasoningEffort,
} from "../provider.js";
import {
  SOURCE_EVENT_BLOCK_CHARS,
  SOURCE_EVENT_BLOCK_OVERLAP_CHARS,
} from "./core.js";
import type {
  SourceContinuationCandidate,
} from "./core.js";
import {
  nextSignificantEventForCandidate,
  sourceEventCanOccurWithoutPlayerChoice,
  sourceEventFirstPlayerChoiceBeatIndex,
} from "./source-navigation.js";

export function buildSourceEventBlocks(
  candidate: SourceContinuationCandidate,
): SourceContinuationCandidate[] {
  const sourceStart = candidate.nextTextOffset - candidate.excerpt.length;
  const blocks: SourceContinuationCandidate[] = [];
  for (let start = 0; start < candidate.excerpt.length;) {
    const end = Math.min(candidate.excerpt.length, start + SOURCE_EVENT_BLOCK_CHARS);
    blocks.push({
      ...candidate,
      excerpt: candidate.excerpt.slice(start, end),
      nextTextOffset: sourceStart + end,
    });
    if (end >= candidate.excerpt.length) break;
    start = end - SOURCE_EVENT_BLOCK_OVERLAP_CHARS;
  }
  return blocks;
}

export const SOURCE_GROUNDING_EXCERPT_CHARS = 1_500;

export function groundedSourceProgress(candidate: SourceContinuationCandidate): SourceCursor {
  const excerptStart = candidate.nextTextOffset - candidate.excerpt.length;
  return {
    chapterPosition: candidate.chapterPosition,
    textOffset: excerptStart + Math.min(
      candidate.excerpt.length,
      SOURCE_GROUNDING_EXCERPT_CHARS,
    ),
    ...(candidate.requiredEventId ? { eventId: candidate.requiredEventId } : {}),
  };
}

export interface SourceContinuationSelection {
  compatible: boolean;
  currentChapterPosition: number | null;
  candidateIndex: number | null;
  chapterPosition: number | null;
  reason: string;
}

export function resolveGroundedSourceCandidate(
  chapterPosition: number | null | undefined,
  candidates: readonly SourceContinuationCandidate[],
): SourceContinuationCandidate | undefined {
  if (chapterPosition === null || chapterPosition === undefined) return undefined;
  return candidates.find(
    (candidate) => candidate.chapterPosition === chapterPosition,
  );
}

export function resolveSourceContinuationSelection(
  selection: SourceContinuationSelection,
  candidates: readonly SourceContinuationCandidate[],
): SourceContinuationCandidate | undefined {
  if (!selection.compatible) return undefined;
  if (
    selection.candidateIndex === null
    || selection.chapterPosition === null
  ) {
    return undefined;
  }
  const candidate = candidates[selection.candidateIndex];
  return candidate
    && candidate.chapterPosition === selection.chapterPosition
    ? candidate
    : undefined;
}

export function resolveRecoveryChapterSelection(
  selection: SourceContinuationSelection,
  candidates: readonly SourceContinuationCandidate[],
): SourceContinuationCandidate | undefined {
  return resolveSourceContinuationSelection(selection, candidates)
    ?? (
      selection.currentChapterPosition === null
        ? undefined
        : candidates.find(
            (candidate) =>
              candidate.chapterPosition === selection.currentChapterPosition,
          )
    );
}

export function buildSourceContinuationInstruction(
  candidate: SourceContinuationCandidate,
  playerName?: string,
  profiles: readonly CharacterProfile[] = [],
): string {
  const requiredEvent = nextSignificantEventForCandidate(candidate);
  const canOccurWithoutPlayerChoice = Boolean(
    playerName
    && sourceEventCanOccurWithoutPlayerChoice(requiredEvent, playerName, profiles),
  );
  const nextRequiredBeat = requiredEvent?.beats?.[0];
  const firstPlayer = playerName ? sourceEventFirstPlayerChoiceBeatIndex(requiredEvent, playerName, profiles) : -1;
  if (firstPlayer > 0 && requiredEvent?.beats) {
    // A mixed event's title often describes the player's later resolution. Sending it as
    // REQUIRED NEXT EVENT competes with the automatic-only execution contract.
    const automatic = requiredEvent.beats.slice(0, firstPlayer);
    return [
      "SOURCE-GUIDED AUTOMATIC CONTINUATION:",
      "The player requested continuation, not the future player choice. Perform only this ordered automatic prefix; the event's later resolution remains unselected.",
      `AUTOMATIC ACTIONS TO COMPLETE NOW: ${JSON.stringify(automatic.map(beat => ({actor: beat.actor, action: beat.action, resultingState: beat.resultingState ?? null})))}`,
      `STOP STATE: ${automatic.at(-1)!.resultingState ?? "The final listed automatic action has occurred."}`,
      "Show the transition from the current visible state into those actions. Do not skip the triggering accident, approach or NPC speech and begin with its aftermath or the player's response.",
      "Use the ORDERED TURN SCRIPT for source evidence and the subsequent decision boundary. Do not complete the overall event, act on the next menu choice, or import later events from chapter summaries.",
      "Preserve the player's identity and established state. Existing possession may change when a listed automatic action visibly causes that change; do not keep the target in the player's arms after its specified escape or fall.",
      "This is not a PLAYER ACTION. Use empty playerAction and actionResult, and actionOutcome 'none'.",
    ].join("\n");
  }
  const sourceLocation = candidate.recovery
    ? `A compatible recovery route was found in chapter ${candidate.chapterPosition + 1}, ${JSON.stringify(candidate.chapterTitle)}.`
    : `The next compatible source material is in chapter ${candidate.chapterPosition + 1}, ${JSON.stringify(candidate.chapterTitle)}.`;
  const excerptLabel = candidate.recovery
    ? "SOURCE EXCERPT FROM THE RECOVERY CHAPTER"
    : "SOURCE EXCERPT AFTER THE SAVED CURSOR";
  return [
    "SOURCE-GUIDED CONTINUATION:",
    "The player explicitly requested direct canonical continuation. This authorizes the next externally occurring event or non-player action, but source material never authorizes an unchosen voluntary action by player_identity.",
    sourceLocation,
    ...(candidate.recovery ? [] : [`SOURCE SUMMARY: ${candidate.summary}`]),
    ...(candidate.surroundingContext
      ? [`SURROUNDING CHAPTER CONTEXT:\n${candidate.surroundingContext}`]
      : []),
    `${excerptLabel}: ${candidate.excerpt}`,
    `ORDERED SOURCE SUMMARY: ${candidate.summary}`,
    "Introduce the earliest concrete source-backed development from this material now.",
    ...(candidate.requiredEvent
      ? [
          `REQUIRED NEXT EVENT: ${candidate.requiredEvent}`,
          "Use the selected event to establish this scene's central new beat. The source excerpt is authoritative; the event label is a navigation summary and must not add unsupported details.",
          ...(canOccurWithoutPlayerChoice
            ? [
                "Agency metadata confirms that REQUIRED NEXT EVENT needs no separate meaningful voluntary choice by player_identity. Its external, non-player, involuntary, or routine beats must visibly happen in scene text now. Do not merely hint that they are coming or record them only in externalDevelopment.",
                ...(nextRequiredBeat
                  ? [
                      `NEXT REQUIRED SOURCE BEAT TO COMPLETE NOW: ${nextRequiredBeat.actor ?? "World"} — ${nextRequiredBeat.action}`,
                      "Complete that beat to its observable end state in this scene. Starting it, volunteering for it, preparing for it, moving toward it, or saying that it will happen does not count as completing it.",
                      "For retrieval, travel, arrival, transfer, or other result-bearing beats, show the named result actually achieved before stopping. Keep sceneScope consistent with the completed end state, including who is present, where they are, and which objects they possess.",
                    ]
                  : []),
              ]
            : [
                "The event contains or may contain a meaningful voluntary player beat. Do not infer authorization from the source request or event wording. Enact that beat only when already selected; otherwise stop before it and offer an explicit informed-consent choice that names it.",
              ]),
        ]
      : []),
    ...(candidate.recovery
      ? ["This exact window was selected after locating the current scene on the book timeline. Do not replay the bridge, arrival, setup, or routine already shown."]
      : []),
    "Adapt that development to the established interactive game state without undoing completed player actions, removing user-created events, resetting locations without a transition, or changing player_identity.",
    ...(candidate.recovery
      ? ["This is a recovery route selected from chapter summaries. Bridge to it causally; do not claim that earlier interactive events never happened or replay resolved events as new."]
      : []),
    "Preserve the source event's narrative function, participants, and consequences where possible; transform only details that conflict with established game state.",
    "Do not quote long or distinctive source prose. Narrate the development freshly.",
    "This is not a PLAYER ACTION. Use empty playerAction and actionResult, and actionOutcome 'none'.",
  ].join("\n");
}

export function buildSceneContinuationInstruction(): string {
  return [
    "OBSERVED SCENE PROGRESSION:",
    "The player selected no menu option and asked for the next narrated moment of the scene.",
    "Treat current_scene as the authoritative present moment, not as material to replay. Paint a vivid, concrete picture of what happens immediately next as the same scene progresses.",
    "Carry forward the established setting, character and object positions, physical conditions, mood, dialogue state, and ongoing activity. Change any of them only by showing that change in this passage.",
    "Advance incrementally by one cohesive observable beat. Show a new motion, non-player reaction or line of dialogue, sensory change, environmental development, or immediate consequence; do not merely redescribe the current tableau, summarize unseen events, or rush the whole sequence to its conclusion.",
    "When next_significant_event is supplied, try to incorporate it as this beat when it follows causally and needs no new voluntary player decision.",
    "The next source event is optional during scene_continuation. If it would skip a prerequisite, force an unselected player action, or exceed one immediate beat, continue the local scene instead and keep sourceChapterPosition null. Only a separately selected source event anchor makes that event mandatory.",
    "Continue only activity already in motion or clearly pending at the end of current_scene: ongoing player activity that needs no new decision, non-player character actions and dialogue, external events, and their immediate causal consequences.",
    "Every option listed in immediate_transition.latest_input.unselected_options is unselected and unrealized. Do not perform, paraphrase, combine, or assume any of those options.",
    "Do not invent a consequential new voluntary action, utterance, decision, thought, or intention for player_identity. You may carry forward an already established continuous player action without escalating it, redirecting it, or adding speech; passive observation, involuntary reactions, and maintaining an established posture are also allowed.",
    "If the situation cannot progress without a player decision, show one concrete consequence of continued inaction, environmental motion, or a non-player character's response, then stop at the genuinely necessary decision.",
    "Do not jump to an unrelated scene, skip a substantial span of time, or start a separate plot phase merely to create activity.",
    "This is not a PLAYER ACTION. Use empty playerAction and actionResult, and actionOutcome 'none'.",
  ].join("\n");
}

export function configuredReasoningEffort(
  value = process.env.BOOKRPG_AI_REASONING_EFFORT
    || process.env.OPENAI_REASONING_EFFORT
    || "minimal",
): AiReasoningEffort {
  return configuredAiReasoningEffort(value);
}

export function reasoningEffortForTurn(
  configured: AiReasoningEffort,
  stakes: ChoiceStakes | undefined,
): AiReasoningEffort {
  if (stakes !== "critical") return configured;
  return configured === "xhigh" || configured === "max" ? configured : "high";
}

export function buildEventContinuationInstruction(eventText: string): string {
  return [
    `WORLD EVENT: ${JSON.stringify(eventText)}`,
    "Make this externally initiated world event happen now and narrate its immediate consequences.",
    "Treat WORLD EVENT as an occurrence in the world, not as an action, utterance, thought, decision, intent, or knowledge belonging to player_identity.",
    "Do not reinterpret the event as an attempt, and do not silently ignore or postpone it.",
    "WORLD EVENT is the one major beat of this turn. After it happens, show only direct immediate reactions and observable consequences, then stop at the next player decision point.",
    "Do not add a second independently initiated action, event, plot beat, or substantial time or location transition. Put possible later actions only in the prospective choice menu; do not perform them in scene text.",
    "Keep the player identity unchanged. Do not invent a voluntary reaction, decision, utterance, movement, or other consequential action for player_identity.",
    "This turn has no PLAYER ACTION. Return playerAction and actionResult as empty strings and actionOutcome as 'none'. WORLD EVENT must never be copied into those fields.",
  ].join("\n");
}

export function buildActionContinuationInstruction(actionText: string): string {
  return [
    `PLAYER ACTION: ${JSON.stringify(actionText)}`,
    "The entire PLAYER ACTION is the player's authoritative latest decision and takes precedence over older actions, plans, or inferred intentions in the game context.",
    "Before writing, identify every distinct action beat in the PLAYER ACTION, including speech, movement, object use, targets, and ordering words such as 'then' or 'afterwards'.",
    "Track the grammatical actor, target, and direction of every beat. Never swap them or substitute a mirrored action by the target; for example, do not turn the player telling an NPC to sit into the NPC telling the player to sit.",
    "Treat a player-controlled act written as an already completed fact, and an immediate observation or world fact explicitly supplied in PLAYER ACTION, as established by the user's narration. Do not downgrade such a clause into an attempt or contradict it with an invented reversal.",
    "A command or request establishes that the player delivered it, but does not by itself establish the target's compliance. Treat compliance as established only when PLAYER ACTION also states that it happens.",
    "Resolve every remaining attempted beat in the stated order. Each may succeed, partly succeed, fail, or be credibly interrupted, but no beat may be omitted, merged into another beat, softened into a different action, or left as a thought.",
    "When a beat contains something the player says, shouts, asks, threatens, or otherwise communicates, put that communication on the page as direct speech or a close, semantically faithful paraphrase. Preserve its material claims, demands, threats, target audience, and tone, then show the listeners' immediate reactions.",
    "For every non-speech beat, narrate the concrete attempt and its immediate result. If established circumstances make it impossible, show the failed attempt or credible intervention instead of silently rewriting or ignoring it.",
    "Give severe or disruptive behavior proportionate consequences; do not euphemize it into a harmless display.",
    "Treat staying, waiting, watching, rehearsing, preparing, readying, and similar low-motion choices as bounded actions, not permission to restate the current tableau. Complete the chosen behavior, then show one immediate concrete response or observable world change already made imminent by the scene or source.",
    "Do not end a low-motion choice with the player still merely waiting, rehearsing, preparing, or considering the same choice under unchanged conditions.",
    "Advance the world state beyond the decision point.",
    "Do not merely restate the action, describe the player considering or preparing to do it, or ask whether the player still wants to do it.",
    "After resolving the stated beats, do not invent another consequential voluntary player action. Stop and offer that separate decision among the new choices.",
    "The selected action is consumed. Do not offer the same action or a paraphrase of it among the new choices.",
    "Every new choice must begin after the result of this attempt and respond to a new consequence, obstacle, or opportunity.",
  ].join("\n");
}

export function buildAnchorRouteContinuationInstruction(
  instruction: string,
  candidate?: SourceContinuationCandidate,
): string {
  const sourceDirection = candidate
    ? [
        "Use the supplied upcoming_source_material as the authoritative anchor.",
        ...(candidate.requiredEvent
          ? [`SOURCE ANCHOR TO REACH: ${candidate.requiredEvent}`]
          : ["Use the earliest concrete event in that material as the source anchor."]),
        "The source excerpt is authoritative; the SOURCE ANCHOR label is only a navigation summary and must not add a person, object, fact, or event absent from the excerpt.",
        "After resolving the latest input, make that anchor visibly affect this turn when the selected action directly creates its immediate causal conditions or performs its required player-controlled beat.",
        `Set sourceChapterPosition to ${candidate.chapterPosition} only if the source-backed event visibly occurs; otherwise keep it null.`,
      ]
    : [
        "No compatible forward source excerpt was found. Move toward an unresolved source-backed conflict, relationship, location, or pressure already established in the player-facing timeline.",
      ];
  return [
    instruction,
    "",
    "OPTION 1 ANCHOR ROUTE SELECTED:",
    "The player deliberately selected the first menu option, which is reserved for returning to a concrete story anchor.",
    "Resolve the latest player input fully and use it as the causal bridge; do not ignore it, replace it with the anchor, or replay the previous setup.",
    ...sourceDirection,
    "Do not detour into an invented clue or side plot while the source-backed route remains compatible.",
    "For a search, scan, examination, or investigation, complete one bounded attempt and show a concrete finding, explicit absence, or specific obstacle. Do not stop with the player merely beginning or continuing to look.",
    "When the selected action waits or prepares for a character or event explicitly established as imminent, let that arrival or event supply the immediate external beat and source bridge. This does not invent another player action.",
    "An involuntary, external, non-player, or routine beat does not require separate player authorization, but it still needs a direct causal bridge from the selected action and current scene.",
    "If reaching the anchor truly requires another distinct significant or critical voluntary player action, stop at that decision point and make choices[0] the next immediate route toward it.",
  ].join("\n");
}

export function buildRequiredSourceRecoveryInstruction(
  instruction: string,
  candidate: SourceContinuationCandidate | undefined,
): string {
  if (!candidate?.recovery) return instruction;
  return [
    instruction,
    "",
    "FORWARD SOURCE RECOVERY REQUIRED:",
    `Recover through chapter ${candidate.chapterPosition + 1}, ${JSON.stringify(candidate.chapterTitle)}.`,
    `SOURCE SUMMARY: ${candidate.summary}`,
    `FORWARD SOURCE EXCERPT: ${candidate.excerpt}`,
    ...(candidate.requiredEvent
      ? [`REQUIRED NEXT EVENT: ${candidate.requiredEvent}`]
      : []),
    "The forward source excerpt is authoritative. REQUIRED NEXT EVENT is a navigation summary only; never introduce a person, object, fact, or event from that label unless the excerpt supports it.",
    "The normal cursor route did not provide a reliable concrete next event. Use this selected recovery window instead of recycling the current scene.",
    "Resolve the authoritative latest player input first. Introduce the earliest compatible concrete event from this forward source material only if it follows directly or can occur without choosing another voluntary action for the player.",
    "If REQUIRED NEXT EVENT would require a new player-controlled decision absent from the latest input, do not enact it. End at the new decision point, offer choices[0] as a voluntary route toward it, and keep sourceChapterPosition null.",
    "Do not replay the previous scene's setup. The recovered event must create a new observable state, consequence, obstacle, discovery, arrival, or opportunity.",
    `Set sourceChapterPosition to ${candidate.chapterPosition} only after actually adapting that event; otherwise keep it null.`,
  ].join("\n");
}
