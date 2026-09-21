import { flowDiagnostic } from "../../util/flow-trace.js";
import {
  SOURCE_ANCHOR_CHOICE_ID,
} from "../../shared/contracts.js";
import type {
  CharacterProfile,
  GameState,
  Scene,
  SourceAnchorRoute,
  StoryEventBeat,
} from "../../shared/contracts.js";
import {
  sourceReferenceKey,
} from "../../books/source-index/chapter-index.js";
import {
  sourceAnchorRouteReviewJsonSchema,
} from "../schema.js";
import type {
  AiResponse,
  AiResponseRequest,
} from "../provider.js";
import {
  parseAiJson,
  SceneGenerationError,
} from "./core.js";
import type {
  GeneratedScene,
  ContinuationOptions,
  SourceContinuationCandidate,
  SourceContinuationResult,
} from "./core.js";
import {
  ProviderProfileEngine,
} from "./provider-profile-engine.js";
import {
  addSourceContinuationAnchorChoice,
  hasTooFewChoicesForActiveScene,
  promoteAnchorChoice,
} from "./scene-validation.js";
import {
  buildRequiredPlayerChoiceFallback,
  buildSourceChoiceNavigationContext,
  buildSourceEventBeatProgressContext,
  buildSourceEventChoiceBeatState,
  nextSignificantEventForCandidate,
  selectedAnchorRequiresSourceEvent,
  sourceEventFirstPlayerChoiceBeatIndex,
  sourceEventPlayerChoiceBeats,
  sourceEventRequiresExplicitPlayerChoice,
  sourceEventHasPendingAutomaticPrefix,
  sourceEventCanOccurWithoutPlayerChoice,
} from "./source-navigation.js";
import {
  SOURCE_GROUNDING_EXCERPT_CHARS,
  buildSourceContinuationInstruction,
  buildSceneContinuationInstruction,
  buildEventContinuationInstruction,
  buildActionContinuationInstruction,
  buildAnchorRouteContinuationInstruction,
  buildRequiredSourceRecoveryInstruction,
} from "./source.js";

const OPENING_NO_PLAYER_ACTION_MARKER =
  "There is no completed PLAYER ACTION in an opening.";
const OPENING_SPLIT_PRELUDE_TARGET_WORDS = 360;

export function openingSceneWordBudget(_prefixBeatCount: number): number {
  return 600;
}

export function normalizeOpeningSceneActionMetadata(
  request: AiResponseRequest,
  response: AiResponse,
): AiResponse {
  if (
    response.status === "incomplete"
    || request.text?.format.name !== "bookrpg_scene"
    || !request.input.includes(OPENING_NO_PLAYER_ACTION_MARKER)
    || !response.output_text.trim()
  ) {
    return response;
  }
  try {
    const output = JSON.parse(response.output_text) as Record<string, unknown>;
    if (
      output.playerAction === ""
      && output.actionOutcome === "none"
      && output.actionResult === ""
    ) {
      return response;
    }
    return {
      ...response,
      output_text: JSON.stringify({
        ...output,
        playerAction: "",
        actionOutcome: "none",
        actionResult: "",
      }),
    };
  } catch {
    return response;
  }
}

function sourceBeatReferenceExcerpt(
  beat: StoryEventBeat | null | undefined,
  candidate: SourceContinuationCandidate | undefined,
): string {
  if (!beat || !candidate?.sourceReferenceExcerpts) return "";
  const seen = new Set<string>();
  return beat.sourceReferences.flatMap((reference) => {
    const key = sourceReferenceKey(reference);
    if (seen.has(key)) return [];
    seen.add(key);
    const excerpt = candidate.sourceReferenceExcerpts?.[key];
    return excerpt === undefined ? [] : [excerpt];
  }).join("\n\n");
}

function normalizedProfileIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function sourceScopeCharacterNames(
  candidates: readonly SourceContinuationCandidate[],
): string[] {
  const names = new Map<string, string>();
  const add = (name: string | null | undefined) => {
    const trimmed = name?.trim();
    if (!trimmed) return;
    names.set(normalizedProfileIdentity(trimmed), trimmed);
  };
  const addBeat = (beat: StoryEventBeat) => {
    add(beat.actor);
    beat.targets.forEach(add);
  };
  const addEvent = (
    event: {
      actors?: readonly string[];
      targets?: readonly string[];
      beats?: readonly StoryEventBeat[];
    } | null | undefined,
  ) => {
    event?.actors?.forEach(add);
    event?.targets?.forEach(add);
    event?.beats?.forEach(addBeat);
  };

  for (const candidate of candidates) {
    addEvent(candidate.currentStoryEvent);
    candidate.storyEvents?.forEach(addEvent);
    candidate.requiredEventActors?.forEach(add);
    candidate.requiredEventTargets?.forEach(add);
    candidate.requiredEventBeats?.forEach(addBeat);
  }
  return [...names.values()];
}

export function withSourceScopeCharacterProfiles(
  state: GameState,
  candidates: readonly SourceContinuationCandidate[],
): GameState {
  const existingProfiles = state.characterProfiles ?? [];
  const profiles = [...existingProfiles];
  const known = new Set(
    profiles.flatMap((profile) => [profile.name, ...profile.aliases])
      .map(normalizedProfileIdentity),
  );
  const playerIdentity = normalizedProfileIdentity(state.playerName);
  for (const name of sourceScopeCharacterNames(candidates)) {
    const identity = normalizedProfileIdentity(name);
    if (!identity || identity === playerIdentity || known.has(identity)) continue;
    const profile: CharacterProfile = {
      name,
      aliases: [],
      role: "",
      description: "",
      traits: [],
      relationships: [],
      storyArc: "",
    };
    profiles.push(profile);
    known.add(identity);
  }
  return profiles.length === existingProfiles.length && state.characterProfiles !== undefined
    ? state
    : { ...state, characterProfiles: profiles };
}

function promoteRoutedExplicitPlayerChoice(
  scene: Scene,
  event: ReturnType<typeof nextSignificantEventForCandidate>,
  choices: Scene["choices"],
): Scene["choices"] {
  if (
    choices[0]?.id === SOURCE_ANCHOR_CHOICE_ID
    || choices[0]?.sourceAnchorRoute !== "event"
  ) {
    return choices;
  }
  return promoteAnchorChoice(
    { ...scene, choices },
    0,
    event?.eventId ?? undefined,
  ).choices;
}

function prependRequiredPlayerChoiceFallback(
  scene: Pick<Scene, "sceneScope">,
  state: GameState,
  event: ReturnType<typeof nextSignificantEventForCandidate>,
  choices: Scene["choices"],
): Scene["choices"] {
  const fallback = buildRequiredPlayerChoiceFallback(
    event,
    state.playerName,
    state.characterProfiles,
    scene.sceneScope,
  );
  if (!fallback) return choices;
  const withoutExistingAnchor = choices.filter(
    (choice) => choice.id !== SOURCE_ANCHOR_CHOICE_ID,
  );
  return [fallback, ...withoutExistingAnchor].slice(0, 4);
}

function sourceCandidateForRemainingEvent(
  candidate: SourceContinuationCandidate,
  remainingEvent: ReturnType<typeof nextSignificantEventForCandidate>,
): SourceContinuationCandidate {
  if (!remainingEvent?.beats?.length) return candidate;
  const storyEvents = candidate.storyEvents?.map((event) =>
    event.eventId === remainingEvent.eventId
      ? { ...event, beats: remainingEvent.beats }
      : event
  );
  return {
    ...candidate,
    ...(storyEvents ? { storyEvents } : {}),
    ...(candidate.requiredEventId === remainingEvent.eventId
      ? { requiredEventBeats: remainingEvent.beats }
      : {}),
  };
}

export function buildOpeningPlayerDecisionBoundaryInstruction(
  nextRequiredBeat: StoryEventBeat | null | undefined,
): string[] {
  if (!nextRequiredBeat) return [];
  const boundary = {
    kind: "first_unselected_player_beat",
    action: nextRequiredBeat.action,
    mustRemainUnperformed: true,
  } as const;
  return [
    "The opening has a structured player-decision boundary. The following JSON is control data only: never quote, paraphrase, label, or expose it in player-facing scene text.",
    JSON.stringify(boundary),
    "Complete only source-backed prerequisites that occur strictly before this boundary. The boundary action must remain wholly future: do not begin, imply, narrate, speak, decide, gesture, partially execute, complete, or show consequences of it.",
    "Stop as soon as that action is immediately available and offer it as the first canonical choice.",
  ];
}

export abstract class ProviderTurnEngine extends ProviderProfileEngine {
  protected async createResponse(
    label: string,
    bookId: string,
    request: AiResponseRequest,
  ): Promise<AiResponse> {
    const response = await super.createResponse(label, bookId, request);
    const normalized = normalizeOpeningSceneActionMetadata(request, response);
    if (normalized !== response) {
      flowDiagnostic(
        `${this.client.provider} opening scene action metadata normalized to no PLAYER ACTION.`,
      );
    }
    return normalized;
  }

  private async reviewSelectedSourceAnchorRoute(
    state: GameState,
    selectedChoiceText: string,
    event: ReturnType<typeof buildSourceChoiceNavigationContext>,
    proposedRoute: SourceAnchorRoute | undefined,
    sourceCandidate?: SourceContinuationCandidate,
  ): Promise<SourceAnchorRoute | undefined> {
    if (proposedRoute === "transition" && !event?.beats?.length) {
      return proposedRoute;
    }
    if (!event) return "transition";
    const beatProgress = buildSourceEventBeatProgressContext(event, state.sourceEventProgress);
    const routingEvent = event.beats?.length
      ? beatProgress?.nextRequiredBeat
        ? { ...event, beats: [beatProgress.nextRequiredBeat] }
        : null
      : event;
    if (!routingEvent) return "transition";
    const requiresExplicitPlayerChoice = sourceEventRequiresExplicitPlayerChoice(
      routingEvent,
      state.playerName,
      state.characterProfiles,
      state.scene.sceneScope,
    );
    const playerChoiceBeats = sourceEventPlayerChoiceBeats(
      routingEvent,
      state.playerName,
      state.characterProfiles,
    );
    const nextRequiredBeatSourceExcerpt = sourceBeatReferenceExcerpt(
      beatProgress?.nextRequiredBeat,
      sourceCandidate,
    );
    const request = {
      model: this.model,
      reasoning: { effort: "low" as const },
      instructions: [
        "You verify whether a selected BookRPG anchor choice directly reaches its source event in the immediately following scene.",
        "player_identity is physically present at current_scene_scope.currentLocation by definition and belongs in both peoplePresent and peopleWithinSpeakingDistance. Never treat player_identity as absent.",
        "Names in next_significant_event.currentlyAbsentCharacters are unavailable as living interactive characters at the current location: do not make them act, hear, answer, or participate as if present. This does not erase a corpse, remains, a visible body part, a possession, or another physical trace that current_scene.text explicitly establishes at the location.",
        "A selected choice may inspect, uncover, move, cover, or otherwise physically handle source-backed remains that current_scene.text establishes without treating the dead character as a living participant. Do not require that dead character to appear in peoplePresent merely for their remains to be physically present.",
        "next_required_beat_source_excerpt is the most specific source evidence for the immediate ordered beat and may extend beyond the bounded source_excerpt. Use it together with current_scene before deciding that the beat or its causal bridge cannot be staged.",
        "The source excerpts are authoritative when compact event metadata obscures who speaks to whom. In particular, never turn a question about an absent living character into direct speech to that character.",
        "Return sourceAnchorRoute 'event' when fully resolving selected_choice either performs the required meaningful player-controlled beats or directly creates conditions in which the event's involuntary, external, non-player, or routine beats can immediately occur.",
        "For ordered events, next_significant_event.beats contains only the next required beat. Route event promises that beat, not completion of the whole event. Later player decisions in source_event_beat_progress remain future and must not downgrade this route. If the next beat is player-controlled, selected_choice must authorize it; if it is an NPC/world beat, require a concrete causal bridge without assigning it to the player. For legacy events without beats, require the whole event.",
        "A choice whose main player action is deferred until after an unmet prerequisite must use 'transition', even when that deferred action matches a required_player_choice_beat. Words such as 'after', 'once', 'when', 'until', or 'then' do not skip the prerequisite.",
        "Only when required_player_choice_beats is empty and requires_explicit_player_choice is false should you avoid demanding that selected_choice name or authorize an accident, reflex, external occurrence, NPC act, or routine reaction. Instead require a concrete causal bridge from the selected action and current scene.",
        "Faithful paraphrases and equivalent wording count; exact word overlap is not required.",
        "Return 'transition' when selected_choice is unrelated, only establishes a remote prerequisite, requires a substantial time or location jump before the event, or leaves any separate meaningful voluntary player decision unselected.",
        "Do not return 'event' merely because proposed_source_anchor_route says event or because this was the first anchor choice.",
        "Do not require selected_choice to predetermine success, involuntary consequences, or non-player reactions.",
        "Explain the concrete causal or authorization match or mismatch briefly in reason.",
      ].join("\n"),
      input: JSON.stringify({
        player_identity: state.playerName,
        runtime_parameters: state.parameters ?? [],
        selected_choice: selectedChoiceText,
        proposed_source_anchor_route: proposedRoute,
        requires_explicit_player_choice: requiresExplicitPlayerChoice,
        required_player_choice_beats: playerChoiceBeats,
        next_significant_event: routingEvent,
        source_event_beat_progress: beatProgress,
        current_scene: {
          title: state.scene.title,
          text: state.scene.text,
          sceneScope: state.scene.sceneScope ?? null,
        },
        current_scene_scope: state.scene.sceneScope ?? null,
        next_required_beat_source_excerpt:
          nextRequiredBeatSourceExcerpt
          || sourceCandidate?.excerpt.slice(0, SOURCE_GROUNDING_EXCERPT_CHARS)
          || null,
        source_excerpt:
          sourceCandidate?.excerpt.slice(0, SOURCE_GROUNDING_EXCERPT_CHARS) ?? null,
      }, null, 2),
      text: {
        format: {
          type: "json_schema" as const,
          name: "bookrpg_source_anchor_route_review",
          strict: true,
          schema: sourceAnchorRouteReviewJsonSchema,
        },
      },
    };
    const outputTokenAttempts = [1_600, 3_200] as const;
    for (const [attempt, maxOutputTokens] of outputTokenAttempts.entries()) {
      const response = await this.createResponse(
        "source anchor route review",
        state.book.bookId,
        {
          ...request,
          max_output_tokens: maxOutputTokens,
        },
      );
      if (response.status === "incomplete") {
        const details = JSON.stringify(response.incomplete_details) ?? "no details";
        const failure = new Error(
          `AI source anchor route review returned an incomplete response: ${details}`,
        );
        if (!details.includes("max_output_tokens")) throw failure;
        const nextMaxOutputTokens = outputTokenAttempts[attempt + 1];
        if (!nextMaxOutputTokens) throw failure;
        flowDiagnostic(
          `${this.client.provider} source anchor route review response was incomplete; `
          + `retrying with ${nextMaxOutputTokens} output tokens.`,
        );
        continue;
      }
      const review = parseAiJson<{
        sourceAnchorRoute: SourceAnchorRoute;
        reason: string;
      }>(response.output_text, "OpenAI source anchor route review");
      if (
        (review.sourceAnchorRoute !== "event"
          && review.sourceAnchorRoute !== "transition")
        || typeof review.reason !== "string"
        || !review.reason.trim()
      ) {
        throw new Error("AI source anchor route review returned an invalid assessment");
      }
      flowDiagnostic(
        `${this.client.provider} source anchor route review: `
        + `proposed=${proposedRoute}; reviewed=${review.sourceAnchorRoute}; `
        + review.reason.trim(),
      );
      return review.sourceAnchorRoute;
    }
    throw new Error("AI source anchor route review exhausted its response attempts");
  }

  async start(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[] = [],
  ): Promise<GeneratedScene> {
    const openingEvent = candidates[0]?.currentStoryEvent
      ?? nextSignificantEventForCandidate(candidates[0]);
    const openingProgress = buildSourceEventBeatProgressContext(
      openingEvent,
      state.sourceEventProgress,
    );
    const openingFirstPlayerBeatOffset = openingEvent && openingProgress
      ? sourceEventFirstPlayerChoiceBeatIndex(
          { ...openingEvent, beats: openingProgress.remainingBeats },
          state.playerName,
          state.characterProfiles,
        )
      : -1;
    const openingPreludeBeats = openingFirstPlayerBeatOffset > 0 && openingProgress
      ? openingProgress.remainingBeats.slice(0, openingFirstPlayerBeatOffset)
      : [];
    const openingPlayerStopBeat = openingFirstPlayerBeatOffset >= 0 && openingProgress
      ? openingProgress.remainingBeats[openingFirstPlayerBeatOffset]
      : undefined;
    const openingNextRequiredBeat = openingProgress?.nextRequiredBeat;
    const openingNextRequiredBeatIsPlayerChoice = Boolean(
      openingEvent
      && openingNextRequiredBeat
      && sourceEventPlayerChoiceBeats(
        { ...openingEvent, beats: [openingNextRequiredBeat] },
        state.playerName,
        state.characterProfiles,
      ).length > 0,
    );
    const requireOpeningSourceProgress = Boolean(candidates[0]?.requiredEvent)
      && !openingNextRequiredBeatIsPlayerChoice;
    const openingPlayerDecisionBoundary =
      buildOpeningPlayerDecisionBoundaryInstruction(openingPlayerStopBeat);
    const openingBudget = openingSceneWordBudget(openingPreludeBeats.length);
    const openingPreludeInstruction = openingPreludeBeats.length > 0
      ? [
          `OPENING PRELUDE: visibly narrate all ${openingPreludeBeats.length} ordered beats below in this single opening, in exactly this order. These beats are NOT pre-completed state; each must actually appear in player-facing prose before the menu.`,
          ...openingPreludeBeats.map((beat, index) =>
            `PRELUDE BEAT ${openingProgress!.startBeatIndex + openingProgress!.completedBeatIndexes.length + index} — ${beat.actor ?? "WORLD"}: ${beat.action}`
          ),
          ...(openingPlayerStopBeat
            ? [
                "After the final prelude beat, stop at the structured player-decision boundary supplied below. Do not narrate the boundary action itself.",
              ]
            : []),
          "Each PRELUDE BEAT must get its own short, concrete sentence or clause that visibly performs that exact beat. Do not replace an ordered beat with atmosphere, introspection, anticipation, a summary, or a generic setup.",
          `PRELUDE TARGET: keep phase-1 player-facing prose at or below ${OPENING_SPLIT_PRELUDE_TARGET_WORDS} words. The ${openingBudget}-word value is only the hard combined opening ceiling after the short decision-boundary phase; do not use that headroom for reflection, recap, choice lists, or decorative filler.`,
        ]
      : [];

    return this.scene(
      [
        "Start a new alternate interactive timeline at player_identity's earliest grounded story moment, from their own physically coherent perspective and location.",
        "Do not transplant the player into the source narrator's body or location.",
        "story_so_far contains bounded summaries from chapters before this opening. Use it only as chronology and setting context; do not assume player_identity personally knows every summarized fact.",
        ...(openingNextRequiredBeatIsPlayerChoice
          ? [
              "opening_reference_event is future decision context only at this boundary. Do not stage or advance it until the pending player beat has actually been selected.",
            ]
          : [
              "opening_reference_event is the first future source event to stage, not a completed event. Build the opening toward it from the earliest physically coherent moment supported by the excerpt.",
            ]),
        "next_significant_event_progress is authoritative for the opening. Follow remaining_beats strictly in order and never skip an unfinished beat.",
        ...openingPreludeInstruction,
        ...openingPlayerDecisionBoundary,
        ...(openingNextRequiredBeatIsPlayerChoice
          ? []
          : [
              "Find the earliest meaningful player-controlled beat in opening_player_future_actions. Every still-unfinished ordered beat before that player beat is mandatory opening progression: visibly enact those preceding NPC, external, involuntary, or routine beats in order in this opening instead of stopping after only next_required_beat.",
              "When next_required_beat is one of those pre-player beats, complete it and continue through the following pre-player beats until the first meaningful player decision is reached. Do not cross that player decision boundary.",
            ]),
        "Use next_significant_event_progress, each beat's sourceReferencesExcerpt, and upcoming_source_material.excerpt together. The ordered beats define what must happen; the excerpts supply concrete location, people, objects, positions, and ongoing action.",
        "When next_required_beat is already the earliest meaningful player-controlled beat, write only the short prerequisite situation that makes that action immediately possible. Do not perform, speak, decide, promise, suggest internally, or paraphrase that action for the player.",
        "After all ordered pre-player beats are complete, stop immediately before the earliest meaningful player-controlled beat and offer it as a concrete choice. For example, when the Scarecrow's first player beat is to wink and nod at Dorothy from his pole, show him fixed on the pole with Dorothy able to notice him, but do not wink, nod, ask to be freed, or mention later travel.",
        "opening_event_sequence and opening_player_future_actions are ordering and decision-boundary context. They must never cause a later beat to happen before an earlier one or allow the opening to cross the earliest meaningful player decision.",
        "If several ordered NPC, external, involuntary, or routine beats precede the first meaningful player action, narrate all of those prerequisite beats now. The opening progression review requires a contiguous completed prefix before that player choice can be offered.",
        openingPreludeBeats.length > 0
          ? `For this split opening, target at most ${OPENING_SPLIT_PRELUDE_TARGET_WORDS} words for the ordered prelude plus a very short decision-boundary continuation. The hard combined opening ceiling remains ${openingBudget} words, but it is a safety ceiling, not a target. Spend words on the listed beats, not reflection or recap.`
          : "Keep this opening especially compact: 65 to 120 words, normally one or two short paragraphs, ending at the immediate choice rather than explaining the character's future, purpose, or feelings at length.",
        "Preserve every immediate physical fact in the excerpt that is compatible with the event sequence and future player actions. Do not replace its setting or participants with a generic clearing, cottage, shelter, distant location, or other invented place.",
        "Use upcoming_source_material.summary and chapterSummary only as supporting chronology and background. They must not override the excerpt's immediate physical facts or establish later events that the excerpt has not yet reached.",
        "The opening source context is exhaustive for chronology. Do not introduce later plans, revelations, crimes, deaths, investigations, or character knowledge from familiarity with the book.",
        "The selected player's opening profile is deliberately spoiler-safe and contains only their name and aliases. Infer immediate identity context from the source excerpt, opening event sequence, and player future actions; do not invent an unsupported future role, trait, motive, plan, relationship change, or story arc.",
        "There is no completed PLAYER ACTION in an opening. This is a schema-level invariant, not a narrative judgement: on every opening draft return playerAction exactly '', actionResult exactly '', and actionOutcome exactly 'none'. Never copy next_required_beat, an opening_reference_event action, or a future choice into those metadata fields.",
        "End with distinct choices that let the player shape the alternate timeline. When the earliest future player action is immediately executable, one choice must offer that action without assuming its outcome.",
        "Set sourceChapterPosition to null unless the opening visibly completes the whole opening_reference_event without performing a meaningful player-controlled beat. Never advance merely because the event was supplied as context.",
        "When established_event is present, continue from its concrete aftermath. Its narrative is inserted automatically before your text, so do not repeat it.",
      ].join("\n"),
      withSourceScopeCharacterProfiles(state, candidates),
      undefined,
      candidates,
      4,
      "opening",
      requireOpeningSourceProgress,
    );
  }

  async continue(
    state: GameState,
    actionText: string,
    candidates: readonly SourceContinuationCandidate[] = [],
    options: ContinuationOptions = {},
  ): Promise<GeneratedScene> {
    const routedCandidates = options.anchorDirected
      ? await this.anchorRouteCandidates(state, candidates, options.sourceEventId)
      : candidates;
    const baseInstruction = buildRequiredSourceRecoveryInstruction(
      buildActionContinuationInstruction(actionText),
      routedCandidates[0],
    );
    const routedEvent = buildSourceChoiceNavigationContext(
      routedCandidates[0],
      state.playerName,
      state.characterProfiles,
      undefined,
      state.scene.sceneScope,
    );
    const reviewedAnchorRoute = options.anchorDirected && options.sourceBeatSelection ? "event" : options.anchorDirected
      ? await this.reviewSelectedSourceAnchorRoute(
          state,
          actionText,
          routedEvent,
          options.sourceAnchorRoute,
          routedCandidates[0],
        )
      : options.sourceAnchorRoute;
    const selectedAnchorRequiresEvent = Boolean(options.anchorDirected)
      && (Boolean(options.sourceBeatSelection) || selectedAnchorRequiresSourceEvent(
        reviewedAnchorRoute,
        routedEvent,
        state.playerName,
        state.characterProfiles,
        state.scene.sceneScope,
      ));
    const generated = await this.scene(
      options.anchorDirected
        ? buildAnchorRouteContinuationInstruction(
            baseInstruction,
            routedCandidates[0],
          )
        : baseInstruction,
      withSourceScopeCharacterProfiles(state, routedCandidates),
      actionText,
      routedCandidates,
      4,
      "interactive_turn",
      selectedAnchorRequiresEvent,
      options.choiceStakes,
      options.anchorDirected ? options.sourceBeatSelection : undefined,
    );
    if (!options.anchorDirected || routedCandidates.length > 0) return generated;
    const withFallback = addSourceContinuationAnchorChoice(generated);
    return { ...generated, choices: withFallback.choices };
  }

  async continueScene(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[] = [],
  ): Promise<GeneratedScene> {
    return this.scene(
      buildRequiredSourceRecoveryInstruction(
        buildSceneContinuationInstruction(),
        candidates[0],
      ),
      withSourceScopeCharacterProfiles(state, candidates),
      undefined,
      candidates,
      4,
      "observed_scene_progression",
    );
  }

  async continueEvent(
    state: GameState,
    eventText: string,
    candidates: readonly SourceContinuationCandidate[] = [],
  ): Promise<GeneratedScene> {
    return this.scene(
      buildRequiredSourceRecoveryInstruction(
        buildEventContinuationInstruction(eventText),
        candidates[0],
      ),
      withSourceScopeCharacterProfiles(state, candidates),
      undefined,
      candidates,
    );
  }

  async continueFromSource(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<SourceContinuationResult | undefined> {
    const candidate = candidates.length === 1
      ? candidates[0]
      : await this.selectSourceCandidate(state, candidates);
    if (!candidate) return undefined;
    const eventCandidate = candidate.requiredEvent?.trim()
      ? candidate
      : await this.selectSourceEvent(state, candidate);
    if (!eventCandidate?.requiredEvent?.trim()) return undefined;
    const event = nextSignificantEventForCandidate(eventCandidate);
    const sourceBeatState = buildSourceEventChoiceBeatState(
      event,
      state.sourceEventProgress,
    );
    const remainingEvent = sourceBeatState.remainingEvent;
    if (
      !sourceEventHasPendingAutomaticPrefix(remainingEvent, state.playerName, state.characterProfiles)
      && sourceEventRequiresExplicitPlayerChoice(
        remainingEvent,
        state.playerName,
        state.characterProfiles,
        state.scene.sceneScope,
      )
    ) {
      const choiceState = withSourceScopeCharacterProfiles(state, [eventCandidate]);
      let choices = await this.sceneChoices(
        choiceState.scene,
        choiceState,
        [eventCandidate],
      );
      choices = promoteRoutedExplicitPlayerChoice(
        choiceState.scene,
        remainingEvent,
        choices,
      );
      if (choices[0]?.id !== SOURCE_ANCHOR_CHOICE_ID) {
        choices = prependRequiredPlayerChoiceFallback(
          choiceState.scene,
          choiceState,
          remainingEvent,
          choices,
        );
      }
      if (
        choices.length < 2
        || choices[0]?.id !== SOURCE_ANCHOR_CHOICE_ID
      ) {
        throw new SceneGenerationError(
          ["The consequential next source event could not be presented as an explicit player choice."],
          4,
        );
      }
      return {
        scene: {
          ...state.scene,
          choices,
        },
        chapterPosition: state.sourceCursor?.chapterPosition
          ?? eventCandidate.chapterPosition,
        nextTextOffset: state.sourceCursor?.textOffset
          ?? eventCandidate.nextTextOffset,
        ...(state.sourceCursor?.eventId
          ? { eventId: state.sourceCursor.eventId }
          : {}),
        requiresExplicitPlayerChoice: true,
      };
    }
    const instructionCandidate = sourceCandidateForRemainingEvent(
      eventCandidate,
      remainingEvent,
    );
    let scene: GeneratedScene;
    try {
      scene = await this.scene(
        buildSourceContinuationInstruction(
          instructionCandidate,
          state.playerName,
          state.characterProfiles,
        ),
        withSourceScopeCharacterProfiles(state, [eventCandidate]),
        undefined,
        [eventCandidate],
        eventCandidate.recovery ? 2 : 4,
        "source_continuation",
        true,
      );
    } catch (error) {
      if (error instanceof SceneGenerationError) {
        flowDiagnostic(`OpenAI source continuation rejected: ${error.message}`);
      }
      throw error;
    }
    return {
      scene,
      chapterPosition: eventCandidate.chapterPosition,
      nextTextOffset: eventCandidate.nextTextOffset,
      ...(eventCandidate.requiredEventId
        ? { eventId: eventCandidate.requiredEventId }
        : {}),
    };
  }

  async refreshSceneChoices(
    state: GameState,
    candidates: readonly SourceContinuationCandidate[],
  ): Promise<Scene> {
    const choiceState = withSourceScopeCharacterProfiles(state, candidates);
    let choices = await this.sceneChoices(
      choiceState.scene,
      choiceState,
      candidates,
    );
    const nextEvent = nextSignificantEventForCandidate(candidates[0]);
    const remainingNextEvent = buildSourceEventChoiceBeatState(
      nextEvent,
      state.sourceEventProgress,
    ).remainingEvent;
    const requiresExplicitPlayerChoice = sourceEventRequiresExplicitPlayerChoice(
      remainingNextEvent,
      state.playerName,
      state.characterProfiles,
      state.scene.sceneScope,
    );
    if (requiresExplicitPlayerChoice) {
      choices = promoteRoutedExplicitPlayerChoice(
        choiceState.scene,
        remainingNextEvent,
        choices,
      );
    }
    if (
      requiresExplicitPlayerChoice
      && choices[0]?.id !== SOURCE_ANCHOR_CHOICE_ID
    ) {
      choices = prependRequiredPlayerChoiceFallback(
        choiceState.scene,
        choiceState,
        remainingNextEvent,
        choices,
      );
    }
    if (
      hasTooFewChoicesForActiveScene({
        choices,
        outcome: state.scene.outcome,
      })
      || (
        requiresExplicitPlayerChoice
        && choices[0]?.id !== SOURCE_ANCHOR_CHOICE_ID
      )
    ) {
      throw new SceneGenerationError(
        ["The aligned next source event could not be presented as a usable concrete choice menu."],
        4,
      );
    }
    return {
      ...state.scene,
      choices,
    };
  }
}


