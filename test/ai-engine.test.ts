import assert from "node:assert/strict";
import test from "node:test";
import {
  addSourceContinuationAnchorChoice,
  applyEstablishedEvent,
  buildActionContinuationInstruction,
  buildAnchorRouteContinuationInstruction,
  buildAnchorChoiceInstruction,
  buildCanonBlock,
  buildDialogueContinuationInstruction,
  buildEventContinuationInstruction,
  buildGameContext,
  buildImmediateTurnTransition,
  buildPlayerAvailabilityContext,
  buildPlayerPerspective,
  buildRequiredSourceRecoveryInstruction,
  buildSceneContinuationInstruction,
  buildSceneRegenerationInstruction,
  buildSourceChoiceNavigationContext,
  buildSourceEventBeatProgressContext,
  normalizeCompletedSourceEventBeatIndexes,
  reviewedSourceEventIdForBeatProgress,
  buildSourceContinuationInstruction,
  buildSourceEventBlocks,
  buildStagnationBreakingInstruction,
  buildWritingSystemReference,
  actionResolutionFailures,
  choiceTextsAreSimilar,
  choiceParaphrasesConsumedAction,
  CHOICE_TIMELINE_RULES,
  COMPACT_DIALOGUE_STYLE_RULES,
  COMPACT_SCENE_STYLE_RULES,
  configuredReasoningEffort,
  developmentRepeatsHistory,
  dialogueAttributionFailures,
  dialogueChoiceStructureFailures,
  filterSceneScope,
  findPlayerCharacterProfile,
  firstChoiceWasFiltered,
  FIRST_CHOICE_ANCHOR_RULES,
  findPassageContext,
  formatDialogueScene,
  hasTooFewChoicesForActiveScene,
  extractLeakedExternalDevelopment,
  isGameStagnating,
  InvalidAiJsonError,
  normalizeEstablishedEventAssessment,
  normalizePlayerAvailability,
  normalizeSceneTalkChoices,
  nextSignificantEventForCandidate,
  openingCharacterContinuityFailures,
  parseAiJson,
  promoteAnchorChoice,
  ProviderGameEngine,
  removeConsumedActionChoices,
  removeChoicesRepeatingCompletedSourceEvent,
  removeDuplicateChoices,
  removeRecentChoiceParaphrases,
  removeChoicesWithPlayerIdentityReferences,
  repairGeneratedChoices,
  RUNTIME_PARAMETER_RULES,
  reasoningEffortForTurn,
  removeChoicesWithUnintroducedCharacters,
  resolveGroundedSourceCandidate,
  resolveRecoveryChapterSelection,
  resolveSourceContinuationSelection,
  SceneGenerationError,
  sceneScopeFailures,
  sceneRepeatsConsumedAction,
  sceneRepeatsCurrentNarrative,
  sceneRepeatsRecentNarrative,
  sceneLeaksInternalMetadata,
  sceneUsesUnexpectedWritingSystem,
  shouldHandleMissingAnchorChoice,
  sourceActionsCompletedAtSelectedMoment,
  sourceEventCanOccurWithoutPlayerChoice,
  sourceEventHasReliableNonPlayerActors,
  sourceEventPlayerChoiceBeats,
  sourceEventNextPlayerChoiceBeats,
  buildRequiredPlayerChoiceFallback,
  sourceEventRequiresExplicitPlayerChoice,
  selectedAnchorRequiresSourceEvent,
  reviewedVisibleSourceEvent,
  visibleSourceEventNarrative,
  stripLeakedSceneMetadata,
  stripEmbeddedChoiceMenu,
  SOURCE_GROUNDING_RULES,
  STORY_MEMORY_RULES,
  SCENE_SCOPE_RULES,
  TURN_SCOPE_RULES,
  OBSERVED_SCENE_PROGRESSION_STYLE_RULES,
} from "../src/ai/engine.js";
import type { AiClient, AiResponseRequest } from "../src/ai/provider.js";
import {
  dialogueSceneJsonSchemaForSourceChapters,
  sceneJsonSchemaForSourceChapters,
  sceneRepetitionReviewJsonSchema,
  talkJsonSchema,
} from "../src/ai/schema.js";
import type {
  GameState,
  ImportedBook,
  StoryEventBeat,
} from "../src/shared/contracts.js";
import {
  CHAPTER_SOURCE_INDEX_VERSION,
  SOURCE_ANCHOR_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_ID,
  SOURCE_CONTINUATION_CHOICE_TEXT,
} from "../src/shared/contracts.js";

function scenePresenceReviewResponse(
  request: AiResponseRequest,
  latestVisibleSourceEventId: string | null = null,
  reportedCompletedBeatIndexes?: number[],
  futureActionSetupSupported = true,
  futureActionSetupRequired = false,
) {
  const input = typeof request.input === "string"
    ? JSON.parse(request.input) as {
        candidate_scene?: {
          proposed_scene_scope?: {
            peoplePresent?: string[];
            peopleWithinSpeakingDistance?: string[];
          };
        };
        event_review_target?: {
          beats?: unknown[];
        } | null;
      }
    : {};
  const proposed = input.candidate_scene?.proposed_scene_scope;
  const completedSourceEventBeatIndexes = reportedCompletedBeatIndexes
    ?? (
      latestVisibleSourceEventId
        ? (input.event_review_target?.beats ?? []).map((_beat, index) => index)
        : []
    );
  return {
    output_text: JSON.stringify({
      peoplePresent: proposed?.peoplePresent ?? [],
      peopleWithinSpeakingDistance:
        proposed?.peopleWithinSpeakingDistance ?? [],
      latestVisibleSourceEventId,
      completedSourceEventBeatIndexes,
      futureActionSetupRequired,
      futureActionSetupSupported,
      futureActionSetupReason: futureActionSetupSupported
        ? "The proposed future-action setup is supported."
        : "The future player beat requires its physical prerequisite to be visibly established.",
      reason: "The proposed test scope is confirmed.",
    }),
  };
}

function validSceneRepetitionReviewResponse(requiredEventOccurred = false) {
  return {
    output_text: JSON.stringify({
      repeatsPriorScene: false,
      latestInputResolvedFaithfully: true,
      preservesPlayerPerspective: true,
      latestInputFailureType: "none",
      preservesPlayerAgency: true,
      staysWithinTurnScope: true,
      latestInputFailureReason: "",
      playerPerspectiveFailureReason: "",
      playerAgencyFailureReason: "",
      turnScopeFailureReason: "",
      requiredEventOccurred,
      anchorChoiceIndex: 0,
      unusableChoiceIndexes: [],
      unusableChoicesReason: "",
      nonInteractableCharacters: [],
      nonInteractableCharactersReason: "",
      reason: "The scene preserves the player identity and establishes the decision point.",
    }),
  };
}

function validSceneChoiceReviewResponse(
  anchorChoiceIndex: number | null = 0,
  unusableChoiceIndexes: number[] = [],
  unusableChoicesReason = "",
) {
  return {
    output_text: JSON.stringify({
      anchorChoiceIndex,
      unusableChoiceIndexes,
      unusableChoicesReason,
      reason: anchorChoiceIndex === null
        ? "No offered choice provides a valid source-facing route."
        : "The selected choice is an immediate executable source-facing route.",
    }),
  };
}

test("scene style stays short, vivid, and consequential", () => {
  const sceneRules = COMPACT_SCENE_STYLE_RULES.join("\n");
  const observedProgressionRules = OBSERVED_SCENE_PROGRESSION_STYLE_RULES.join("\n");
  const dialogueRules = COMPACT_DIALOGUE_STYLE_RULES.join("\n");
  const turnScopeRules = TURN_SCOPE_RULES.join("\n");
  const sceneScopeRules = SCENE_SCOPE_RULES.join("\n");

  assert.match(sceneRules, /65 and 120 words/);
  assert.match(sceneRules, /striking reversal, image, or consequence/i);
  assert.match(sceneRules, /Cut exposition, filler/i);
  assert.match(sceneRules, /State major source-backed events plainly/i);
  assert.match(sceneRules, /vividly and graphically/i);
  assert.match(sceneRules, /do not invent wounds, torture, or gore/i);
  assert.match(observedProgressionRules, /90 and 180 words/i);
  assert.match(observedProgressionRules, /visual and sensory picture/i);
  assert.match(observedProgressionRules, /one cohesive narrated beat/i);
  assert.match(observedProgressionRules, /do not summarize.*race to its final resolution/i);
  assert.match(dialogueRules, /12 and 55 words/);
  assert.match(dialogueRules, /sharp, characterful, and consequential/i);
  assert.match(turnScopeRules, /one player decision per turn/i);
  assert.match(turnScopeRules, /unselected_options.*unrealized alternatives/i);
  assert.match(turnScopeRules, /later plot phase.*second major source event/i);
  assert.match(sceneScopeRules, /currentLocation/);
  assert.match(sceneScopeRules, /peopleWithinSpeakingDistance/);
  assert.match(sceneScopeRules, /immediate dialogue/i);
});

test("scene scope requires speaking-distance people to be present", () => {
  assert.deepEqual(sceneScopeFailures({
    currentLocation: "Living room",
    peoplePresent: ["Joop", "Piet"],
    peopleWithinSpeakingDistance: ["Joop"],
  }), []);
  assert.deepEqual(sceneScopeFailures({
    currentLocation: "Living room",
    peoplePresent: ["Piet"],
    peopleWithinSpeakingDistance: ["Joop"],
  }), [
    'sceneScope lists "Joop" within speaking distance but not present.',
  ]);
});

test("scene scope rejects and removes uncertain character identities", () => {
  const context = {
    knownCharacterProfiles: [
      { name: "Patrick Maloney", aliases: ["Patrick"] },
      { name: "Detective", aliases: [] },
    ],
  };
  const sceneScope = {
    currentLocation: "Living room",
    peoplePresent: ["Patrick Maloney?", "Patrick Maloney\u061f", "possibly Patrick", "Detective"],
    peopleWithinSpeakingDistance: ["Patrick Maloney?", "Patrick Maloney\u061f", "possibly Patrick", "Detective"],
  };

  assert.deepEqual(sceneScopeFailures(sceneScope, context), [
    'sceneScope lists unknown or unqualified identity "Patrick Maloney?" as present.',
    'sceneScope lists unknown or unqualified identity "Patrick Maloney\u061f" as present.',
    'sceneScope lists unknown or unqualified identity "possibly Patrick" as present.',
    'sceneScope lists unknown or unqualified identity "Patrick Maloney?" within speaking distance.',
    'sceneScope lists unknown or unqualified identity "Patrick Maloney\u061f" within speaking distance.',
    'sceneScope lists unknown or unqualified identity "possibly Patrick" within speaking distance.',
    "sceneScope.peoplePresent contains duplicate people.",
    "sceneScope.peopleWithinSpeakingDistance contains duplicate people.",
  ]);
  assert.deepEqual(filterSceneScope(sceneScope, context), {
    currentLocation: "Living room",
    peoplePresent: ["Detective"],
    peopleWithinSpeakingDistance: ["Detective"],
  });
  assert.deepEqual(filterSceneScope({
    currentLocation: "Living room",
    peoplePresent: ["Patrick", "Unknown visitor", "Detective"],
    peopleWithinSpeakingDistance: ["Patrick", "Unknown visitor", "Detective"],
  }, context), {
    currentLocation: "Living room",
    peoplePresent: ["Patrick Maloney", "Detective"],
    peopleWithinSpeakingDistance: ["Patrick Maloney", "Detective"],
  });
});

test("scene scope includes the player and excludes non-interactable NPCs", () => {
  const sceneScope = {
    currentLocation: " Living room ",
    peoplePresent: ["Mary Maloney", "Patrick Maloney", "Detective", "Detective"],
    peopleWithinSpeakingDistance: ["Mary Maloney", "Patrick Maloney", "Detective", "Stranger"],
  };
  const context = {
    playerName: "Mary",
    playerAliases: ["Mary Maloney"],
    nonInteractableCharacters: ["Patrick Maloney"],
  };

  assert.deepEqual(sceneScopeFailures(sceneScope, context), [
    "sceneScope.peoplePresent contains duplicate people.",
    'sceneScope lists non-interactable character "Patrick Maloney" as present.',
    'sceneScope lists non-interactable character "Patrick Maloney" within speaking distance.',
    'sceneScope lists "Stranger" within speaking distance but not present.',
  ]);
  assert.deepEqual(filterSceneScope(sceneScope, context), {
    currentLocation: "Living room",
    peoplePresent: ["Mary", "Detective"],
    peopleWithinSpeakingDistance: ["Mary", "Detective"],
  });
});

test("next significant event prefers the first indexed future event", () => {
  assert.deepEqual(nextSignificantEventForCandidate({
    chapterPosition: 2,
    chapterTitle: "The visit",
    summary: "A visitor arrives.",
    excerpt: "A knock sounds.",
    storyEvents: [{
      eventId: "event_visit",
      sequence: 4,
      description: "Joop arrives at the house.",
      chapterPosition: 2,
    }],
    nextTextOffset: 100,
  }), {
    eventId: "event_visit",
    sequence: 4,
    description: "Joop arrives at the house.",
    chapterPosition: 2,
  });
});

test("a completed required event advances choice planning to the following player action", () => {
  const candidate = {
    chapterPosition: 4,
    chapterTitle: "Lamb to the Slaughter",
    summary: "Mary retrieves the lamb, then kills Patrick.",
    excerpt: "Mary lifts the frozen leg of lamb from the freezer.",
    requiredEvent: "Mary retrieves a leg of lamb from the freezer.",
    requiredEventId: "event_lamb",
    storyEvents: [
      {
        eventId: "event_lamb",
        sequence: 5,
        description: "Mary retrieves a leg of lamb from the freezer.",
        category: "other" as const,
        chapterPosition: 4,
        actors: ["Mary Maloney"],
        targets: [],
      },
      {
        eventId: "event_killing",
        sequence: 6,
        description: "Mary kills Patrick with the frozen leg of lamb.",
        category: "death" as const,
        chapterPosition: 4,
        actors: ["Mary Maloney"],
        targets: ["Patrick Maloney"],
      },
    ],
    nextTextOffset: 8_571,
  };

  const event = nextSignificantEventForCandidate(candidate, "event_lamb");

  assert.equal(event?.eventId, "event_killing");
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(event, "Mary Maloney"),
    true,
  );
});

test("an accepted source event remains selected ahead of earlier story events", () => {
  const event = nextSignificantEventForCandidate({
    chapterPosition: 1,
    chapterTitle: "The doorstep",
    summary: "Harry is placed on the doorstep.",
    excerpt: "Dumbledore carries Harry toward the house.",
    requiredEvent: "Dumbledore places Harry on the doorstep and the group departs.",
    requiredEventId: "event_departure",
    storyEvents: [{
      eventId: "event_scar",
      sequence: 7,
      description: "Harry's scar is identified.",
      chapterPosition: 1,
    }, {
      eventId: "event_departure",
      sequence: 8,
      description: "Dumbledore places Harry on the doorstep and the group departs.",
      category: "departure",
      chapterPosition: 1,
      actors: ["Albus Dumbledore", "Rubeus Hagrid"],
      targets: ["Harry Potter"],
    }],
    nextTextOffset: 1_000,
  });

  assert.equal(event?.eventId, "event_departure");
});

test("choice navigation context distinguishes player-authored violence from NPC world events", () => {
  const playerAttack = buildSourceChoiceNavigationContext({
    chapterPosition: 4,
    chapterTitle: "The living room",
    summary: "Mary attacks Patrick.",
    excerpt: "Mary raises the frozen leg of lamb.",
    storyEvents: [{
      eventId: "event_attack",
      sequence: 6,
      description: "Mary attacks Patrick with the frozen leg of lamb.",
      category: "violence",
      chapterPosition: 4,
      actors: ["Mary Maloney"],
      targets: ["Patrick Maloney"],
    }],
    nextTextOffset: 9_000,
  }, "Mary Maloney");
  const npcArrival = buildSourceChoiceNavigationContext({
    chapterPosition: 4,
    chapterTitle: "The investigation",
    summary: "Detectives arrive later.",
    excerpt: "The detectives drive toward the house.",
    storyEvents: [{
      eventId: "event_detectives_arrive",
      sequence: 7,
      description: "Detectives arrive at the house.",
      category: "arrival",
      chapterPosition: 4,
      actors: ["Detectives"],
      targets: ["Mary Maloney"],
    }],
    nextTextOffset: 9_500,
  }, "Mary Maloney", [
    {
      name: "Mary Maloney",
      aliases: ["Mary"],
      role: "Player",
      description: "",
      traits: [],
      relationships: [],
      storyArc: "",
    },
    {
      name: "Detectives",
      aliases: [],
      role: "Investigators",
      description: "",
      traits: [],
      relationships: [],
      storyArc: "",
    },
  ], undefined, {
    currentLocation: "Mary's house",
    peoplePresent: [],
    peopleWithinSpeakingDistance: [],
  });
  const mixedArrival = buildSourceChoiceNavigationContext({
    chapterPosition: 4,
    chapterTitle: "The living room",
    summary: "Patrick arrives and Mary greets him.",
    excerpt: "A key turns in the lock.",
    storyEvents: [{
      eventId: "event_patrick_arrives",
      sequence: 2,
      description: "Patrick arrives home and Mary greets him.",
      category: "arrival",
      chapterPosition: 4,
      actors: ["Mary Maloney"],
      targets: ["Patrick Maloney"],
    }],
    nextTextOffset: 4_000,
  }, "Mary Maloney", [
    {
      name: "Mary Maloney",
      aliases: ["Mary"],
      role: "Player",
      description: "",
      traits: [],
      relationships: [],
      storyArc: "",
    },
    {
      name: "Patrick Maloney",
      aliases: ["Patrick"],
      role: "Husband",
      description: "",
      traits: [],
      relationships: [],
      storyArc: "",
    },
  ], undefined, {
    currentLocation: "Mary's house",
    peoplePresent: [],
    peopleWithinSpeakingDistance: [],
  });

  assert.equal(playerAttack?.requiresExplicitPlayerChoice, true);
  assert.equal(npcArrival?.requiresExplicitPlayerChoice, false);
  assert.deepEqual(npcArrival?.currentlyAbsentCharacters, ["Detectives"]);
  assert.equal(mixedArrival?.requiresExplicitPlayerChoice, false);
  assert.deepEqual(mixedArrival?.currentlyAbsentCharacters, ["Patrick Maloney"]);
});

test("only reliably non-player source events are mandatory anchor outcomes", () => {
  assert.equal(
    sourceEventHasReliableNonPlayerActors(
      {
        eventId: "event_untyped_player_action",
        description: "Mary retrieves the lamb.",
        chapterPosition: 4,
      },
      "Mary Maloney",
    ),
    false,
  );
  assert.equal(
    sourceEventHasReliableNonPlayerActors(
      {
        eventId: "event_npc_arrival",
        description: "Patrick arrives home.",
        chapterPosition: 4,
        actors: ["Patrick Maloney"],
      },
      "Mary Maloney",
    ),
    true,
  );
  assert.equal(
    sourceEventCanOccurWithoutPlayerChoice(
      {
        eventId: "event_mixed_arrival",
        description: "Patrick arrives and Mary greets him.",
        chapterPosition: 4,
        category: "arrival",
        actors: ["Mary Maloney"],
        targets: ["Patrick Maloney"],
      },
      "Mary Maloney",
      [
        {
          name: "Mary Maloney",
          aliases: ["Mary"],
          role: "Player",
          description: "",
          traits: [],
          relationships: [],
          storyArc: "",
        },
        {
          name: "Patrick Maloney",
          aliases: ["Patrick"],
          role: "Husband",
          description: "",
          traits: [],
          relationships: [],
          storyArc: "",
        },
      ],
      {
        currentLocation: "Mary's house",
        peoplePresent: [],
        peopleWithinSpeakingDistance: [],
      },
    ),
    true,
  );
});

test("event beat agency and stakes determine whether the player must choose", () => {
  const profiles = [
    {
      name: "Scarecrow",
      aliases: ["the Scarecrow"],
      role: "Traveler",
      description: "",
      traits: [],
      relationships: [],
      storyArc: "",
    },
    {
      name: "Dorothy",
      aliases: [],
      role: "Traveler",
      description: "",
      traits: [],
      relationships: [],
      storyArc: "",
    },
  ];
  const sourceReferences = [{
    chapterPosition: 6,
    chapterIndex: 6,
    lineStart: 1,
    lineEnd: 1,
  }];
  const fallingEvent = {
    eventId: "event_scarecrow_falls",
    description:
      "The Scarecrow repeatedly falls on the rough road, and Dorothy lifts him back up.",
    chapterPosition: 6,
    category: "other" as const,
    actors: ["Scarecrow", "Dorothy"],
    targets: ["Scarecrow"],
    beats: [{
      actor: "Scarecrow",
      action: "Stumbles and falls repeatedly on the rough road.",
      targets: [],
      agency: "involuntary" as const,
      stakes: "significant" as const,
      sourceReferences,
    }, {
      actor: "Dorothy",
      action: "Lifts the Scarecrow upright after each fall.",
      targets: ["Scarecrow"],
      agency: "intentional" as const,
      stakes: "routine" as const,
      sourceReferences,
    }],
  };

  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(fallingEvent, "Scarecrow", profiles),
    false,
  );
  assert.equal(
    sourceEventCanOccurWithoutPlayerChoice(fallingEvent, "Scarecrow", profiles),
    true,
  );
  assert.equal(
    sourceEventHasReliableNonPlayerActors(fallingEvent, "Scarecrow", profiles),
    true,
  );
  assert.deepEqual(
    sourceEventPlayerChoiceBeats(fallingEvent, "Scarecrow", profiles),
    [],
  );

  const deliberateJump = {
    ...fallingEvent,
    eventId: "event_deliberate_jump",
    description: "The Scarecrow deliberately jumps into a deep hole.",
    actors: ["Scarecrow"],
    targets: [],
    beats: [{
      actor: "Scarecrow",
      action: "Deliberately jumps into a deep hole.",
      targets: [],
      agency: "intentional" as const,
      stakes: "significant" as const,
      sourceReferences,
    }],
  };
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(deliberateJump, "the Scarecrow", profiles),
    true,
  );
  assert.equal(
    sourceEventCanOccurWithoutPlayerChoice(deliberateJump, "Scarecrow", profiles),
    false,
  );
  assert.equal(
    sourceEventPlayerChoiceBeats(deliberateJump, "Scarecrow", profiles)[0]?.action,
    "Deliberately jumps into a deep hole.",
  );

  const routineIntentionalBeat = {
    ...deliberateJump,
    eventId: "event_adjusts_hat",
    description: "The Scarecrow adjusts his hat.",
    beats: [{
      ...deliberateJump.beats[0]!,
      action: "Adjusts his hat.",
      stakes: "routine" as const,
    }],
  };
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      routineIntentionalBeat,
      "Scarecrow",
      profiles,
    ),
    false,
  );
  assert.equal(
    sourceEventCanOccurWithoutPlayerChoice(
      routineIntentionalBeat,
      "Scarecrow",
      profiles,
    ),
    true,
  );

  const ambiguousCriticalBeat = {
    ...deliberateJump,
    eventId: "event_ambiguous_departure",
    beats: [{
      ...deliberateJump.beats[0]!,
      action: "Leaves the group under unclear circumstances.",
      agency: "ambiguous" as const,
      stakes: "critical" as const,
    }],
  };
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      ambiguousCriticalBeat,
      "Scarecrow",
      profiles,
    ),
    true,
  );

  const arrivalBeforePlayerDecision = {
    eventId: "event_arrival_then_promise",
    description: "The Scarecrow arrives, and Dorothy promises to join his quest.",
    chapterPosition: 6,
    category: "arrival" as const,
    actors: ["Scarecrow", "Dorothy"],
    targets: ["Dorothy", "Scarecrow"],
    beats: [{
      actor: "Scarecrow",
      action: "Arrives beside Dorothy.",
      targets: ["Dorothy"],
      agency: "intentional" as const,
      stakes: "significant" as const,
      sourceReferences,
    }, {
      actor: "Dorothy",
      action: "Promises to join the Scarecrow's quest.",
      targets: ["Scarecrow"],
      agency: "intentional" as const,
      stakes: "significant" as const,
      sourceReferences,
    }],
  };
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      arrivalBeforePlayerDecision,
      "Dorothy",
      profiles,
      {
        currentLocation: "Road",
        peoplePresent: [],
        peopleWithinSpeakingDistance: [],
      },
    ),
    false,
  );
  assert.equal(
    sourceEventCanOccurWithoutPlayerChoice(
      arrivalBeforePlayerDecision,
      "Dorothy",
      profiles,
      {
        currentLocation: "Road",
        peoplePresent: [],
        peopleWithinSpeakingDistance: [],
      },
    ),
    false,
  );
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      arrivalBeforePlayerDecision,
      "Dorothy",
      profiles,
      {
        currentLocation: "Road",
        peoplePresent: ["Scarecrow"],
        peopleWithinSpeakingDistance: ["Scarecrow"],
      },
    ),
    true,
  );

  const playerFirstArrivalProfiles = [...profiles, {
    name: "Munchkins",
    aliases: [],
    role: "Visitors",
    description: "",
    traits: [],
    relationships: [],
    storyArc: "",
  }];
  const doorwayScope = {
    currentLocation: "Open doorway",
    peoplePresent: ["Dorothy"],
    peopleWithinSpeakingDistance: ["Dorothy"],
  };
  const playerDecisionBeforeLaterArrival = {
    eventId: "event_look_then_visitors",
    description: "Dorothy looks outside before the Munchkins approach the house.",
    chapterPosition: 4,
    category: "arrival" as const,
    actors: ["Dorothy", "Munchkins"],
    targets: ["Dorothy"],
    beats: [{
      actor: "Dorothy",
      action: "Looks outside at the unfamiliar country.",
      targets: [],
      agency: "intentional" as const,
      stakes: "significant" as const,
      sourceReferences,
    }, {
      actor: "Munchkins",
      action: "Approach Dorothy's house.",
      targets: ["Dorothy"],
      agency: "intentional" as const,
      stakes: "significant" as const,
      sourceReferences,
    }],
  };
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      playerDecisionBeforeLaterArrival,
      "Dorothy",
      playerFirstArrivalProfiles,
      doorwayScope,
    ),
    true,
  );
  assert.equal(
    sourceEventCanOccurWithoutPlayerChoice(
      playerDecisionBeforeLaterArrival,
      "Dorothy",
      playerFirstArrivalProfiles,
      doorwayScope,
    ),
    false,
  );
  const playerFirstFallback = buildRequiredPlayerChoiceFallback(
    playerDecisionBeforeLaterArrival,
    "Dorothy",
    playerFirstArrivalProfiles,
    doorwayScope,
  );
  assert.equal(playerFirstFallback?.id, SOURCE_ANCHOR_CHOICE_ID);
  assert.equal(playerFirstFallback?.sourceEventId, "event_look_then_visitors");
  assert.equal(playerFirstFallback?.text, "Look outside at the unfamiliar country");

  const automaticPrefixBeforePlayerArrival = {
    ...playerDecisionBeforeLaterArrival,
    eventId: "event_gust_then_look_then_visitors",
    beats: [{
      actor: null,
      action: "A sudden gust pushes the open door wider.",
      targets: [],
      agency: "external" as const,
      stakes: "significant" as const,
      sourceReferences,
    }, ...playerDecisionBeforeLaterArrival.beats],
  };
  assert.equal(
    sourceEventRequiresExplicitPlayerChoice(
      automaticPrefixBeforePlayerArrival,
      "Dorothy",
      playerFirstArrivalProfiles,
      doorwayScope,
    ),
    false,
  );
  assert.equal(
    buildRequiredPlayerChoiceFallback(
      automaticPrefixBeforePlayerArrival,
      "Dorothy",
      playerFirstArrivalProfiles,
      doorwayScope,
    ),
    undefined,
  );
});

test("required player choice fallback exposes only the immediate beat through present listeners", () => {
  const choice = buildRequiredPlayerChoiceFallback(
    {
      eventId: "join-party",
      sequence: 19,
      description: "The Tin Woodman joins the party to seek a heart from Oz.",
      chapterPosition: 7,
      actors: ["Tin Woodman", "Dorothy", "Scarecrow"],
      targets: ["Oz"],
      beats: [{
        actor: "Tin Woodman",
        action: "Asks whether Oz could give him a heart.",
        targets: ["Oz"],
        agency: "intentional",
        stakes: "critical",
        sourceReferences: [],
      }, {
        actor: "Tin Woodman",
        action: "Requests permission to join the party and seek Oz’s help.",
        targets: ["Dorothy", "Scarecrow", "Oz"],
        agency: "intentional",
        stakes: "critical",
        sourceReferences: [],
      }],
    },
    "Tin Woodman",
    [],
    {
      currentLocation: "Forest path",
      peoplePresent: ["Dorothy", "Scarecrow"],
      peopleWithinSpeakingDistance: ["Dorothy", "Scarecrow"],
    },
  );

  assert.equal(
    choice?.text,
    "Ask Dorothy and Scarecrow whether Oz could give me a heart",
  );
  assert.deepEqual(choice?.requiredPresentCharacters, ["Dorothy", "Scarecrow"]);
  assert.equal(choice?.sourceAnchorRoute, "event");
});

test("multi-turn source events expose only the next player decision", () => {
  const event = {
    eventId: "event_scarecrow_joins",
    sequence: 20,
    description:
      "The Scarecrow asks to join Dorothy, Dorothy invites him, and the Scarecrow accepts.",
    chapterPosition: 3,
    actors: ["Scarecrow", "Dorothy"],
    targets: ["Dorothy", "Scarecrow"],
    beats: [{
      actor: "Scarecrow",
      action: "Asks whether I may join Dorothy's journey.",
      targets: ["Dorothy"],
      agency: "intentional" as const,
      stakes: "significant" as const,
      sourceReferences: [],
    }, {
      actor: "Dorothy",
      action: "Invites the Scarecrow to travel with her.",
      targets: ["Scarecrow"],
      agency: "intentional" as const,
      stakes: "significant" as const,
      sourceReferences: [],
    }, {
      actor: "Scarecrow",
      action: "Accepts Dorothy's invitation.",
      targets: ["Dorothy"],
      agency: "intentional" as const,
      stakes: "significant" as const,
      sourceReferences: [],
    }],
  };
  const profiles = [{
    name: "Scarecrow",
    aliases: ["the Scarecrow"],
    role: "Traveler",
    description: "",
    traits: [],
    relationships: [],
    storyArc: "",
  }, {
    name: "Dorothy",
    aliases: [],
    role: "Traveler",
    description: "",
    traits: [],
    relationships: [],
    storyArc: "",
  }];

  assert.deepEqual(
    sourceEventPlayerChoiceBeats(event, "Scarecrow", profiles).map(
      (beat) => beat.action,
    ),
    [
      "Asks whether I may join Dorothy's journey.",
      "Accepts Dorothy's invitation.",
    ],
  );
  assert.deepEqual(
    sourceEventNextPlayerChoiceBeats(event, "Scarecrow", profiles).map(
      (beat) => beat.action,
    ),
    ["Asks whether I may join Dorothy's journey."],
  );

  const choice = buildRequiredPlayerChoiceFallback(
    event,
    "Scarecrow",
    profiles,
    {
      currentLocation: "Cornfield",
      peoplePresent: ["Dorothy"],
      peopleWithinSpeakingDistance: ["Dorothy"],
    },
  );
  assert.equal(
    choice?.text,
    "Ask Dorothy whether I may join Dorothy's journey",
  );
  assert.equal(choice?.sourceAnchorRoute, "event");
});

test("a missing multi-turn anchor is repaired without regenerating the opening", async () => {
  const requests: AiResponseRequest[] = [];
  let sceneAttempts = 0;
  const currentEventId = "event_scarecrow_freed";
  const nextEventId = "event_scarecrow_joins";
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return validSceneRepetitionReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request, currentEventId);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse(null);
      }
      sceneAttempts += 1;
      return {
        output_text: JSON.stringify({
          title: "Free in the Cornfield",
          text:
            "Freed from the pole, I flex my straw-filled arms while Dorothy waits beside me on the yellow road.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: "",
          sourceChapterPosition: null,
          sceneScope: {
            currentLocation: "Cornfield beside the yellow road",
            peoplePresent: ["Dorothy"],
            peopleWithinSpeakingDistance: ["Dorothy"],
          },
          choices: [{
            id: "road",
            type: "action",
            text: "Study the yellow road",
            character: null,
            requiredPresentCharacters: [],
            requiredAbsentCharacters: [],
            sourceAnchorRoute: null,
            stakes: "routine",
          }, {
            id: "hat",
            type: "action",
            text: "Adjust my hat",
            character: null,
            requiredPresentCharacters: [],
            requiredAbsentCharacters: [],
            sourceAnchorRoute: null,
            stakes: "routine",
          }],
          outcome: "active",
          outcomeReason: "I can decide what to do with my freedom.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_scarecrow_opening",
    book: { bookId: "book_oz", title: "The Wonderful Wizard of Oz" },
    playerName: "Scarecrow",
    characterProfiles: [{
      name: "Scarecrow",
      aliases: ["the Scarecrow"],
      role: "Traveler",
      description: "",
      traits: [],
      relationships: [],
      storyArc: "",
    }, {
      name: "Dorothy",
      aliases: [],
      role: "Traveler",
      description: "",
      traits: [],
      relationships: [],
      storyArc: "",
    }],
    gameProfile: {
      category: "adventure",
      endingMode: "open_ended",
      description: "A journey through Oz.",
    },
    objective: "Shape the Scarecrow's journey.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Dorothy frees the Scarecrow from the pole.",
    sourceCursor: { chapterPosition: 3, textOffset: 1_000 },
    scene: { title: "Starting...", text: "", choices: [] },
    history: [{ kind: "start", text: "The Wonderful Wizard of Oz" }],
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  const sourceReferences = [{
    chapterPosition: 3,
    chapterIndex: 3,
    lineStart: 1,
    lineEnd: 2,
  }];
  const scene = await new ProviderGameEngine(client, "minimal").start(state, [{
    chapterPosition: 3,
    chapterTitle: "How Dorothy Saved the Scarecrow",
    summary: "Dorothy frees the Scarecrow and he asks to join her journey.",
    excerpt:
      "Dorothy lifted the Scarecrow from the pole. He asked to accompany her, and she invited him to come.",
    nextTextOffset: 1_500,
    currentStoryEvent: {
      eventId: currentEventId,
      sequence: 10,
      description: "Dorothy frees the Scarecrow from the pole.",
      chapterPosition: 3,
      actors: ["Dorothy"],
      targets: ["Scarecrow"],
      beats: [{
        actor: "Dorothy",
        action: "Frees the Scarecrow from the pole.",
        targets: ["Scarecrow"],
        agency: "intentional",
        stakes: "significant",
        sourceReferences,
      }],
    },
    storyEvents: [{
      eventId: currentEventId,
      sequence: 10,
      description: "Dorothy frees the Scarecrow from the pole.",
      chapterPosition: 3,
      actors: ["Dorothy"],
      targets: ["Scarecrow"],
    }, {
      eventId: nextEventId,
      sequence: 11,
      description:
        "The Scarecrow asks to join Dorothy, Dorothy invites him, and the Scarecrow accepts.",
      chapterPosition: 3,
      actors: ["Scarecrow", "Dorothy"],
      targets: ["Dorothy", "Scarecrow"],
      beats: [{
        actor: "Scarecrow",
        action: "Asks whether I may join Dorothy's journey.",
        targets: ["Dorothy"],
        agency: "intentional",
        stakes: "significant",
        sourceReferences,
      }, {
        actor: "Dorothy",
        action: "Invites the Scarecrow to travel with her.",
        targets: ["Scarecrow"],
        agency: "intentional",
        stakes: "significant",
        sourceReferences,
      }, {
        actor: "Scarecrow",
        action: "Accepts Dorothy's invitation.",
        targets: ["Dorothy"],
        agency: "intentional",
        stakes: "significant",
        sourceReferences,
      }],
    }],
  }]);

  assert.equal(sceneAttempts, 1);
  const choiceReviewRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choice_review",
  );
  assert.match(
    choiceReviewRequest?.instructions ?? "",
    /beats already visibly completed in candidate_scene as past/i,
  );
  assert.match(choiceReviewRequest?.input ?? "", /Accepts Dorothy's invitation/);
  assert.equal(scene.choices[0]?.sourceAnchorRoute, "event");
  assert.equal(
    scene.choices[0]?.text,
    "Ask Dorothy whether I may join Dorothy's journey",
  );
  assert.deepEqual(
    scene.choices.slice(1).map((choice) => choice.text),
    ["Study the yellow road", "Adjust my hat"],
  );
});

test("selected anchor route kind overrides the legacy actor heuristic", () => {
  const playerEvent = {
    eventId: "event_player_decision",
    description: "Mary decides whether to reveal the truth.",
    chapterPosition: 4,
    actors: ["Mary Maloney"],
  };
  const npcEvent = {
    eventId: "event_npc_arrival",
    description: "Patrick arrives home.",
    chapterPosition: 4,
    actors: ["Patrick Maloney"],
  };

  assert.equal(
    selectedAnchorRequiresSourceEvent(
      "event",
      playerEvent,
      "Mary Maloney",
    ),
    true,
  );
  assert.equal(
    selectedAnchorRequiresSourceEvent(
      "transition",
      npcEvent,
      "Mary Maloney",
    ),
    false,
  );
  assert.equal(
    selectedAnchorRequiresSourceEvent(
      undefined,
      npcEvent,
      "Mary Maloney",
    ),
    true,
  );
  assert.equal(
    selectedAnchorRequiresSourceEvent(
      "event",
      null,
      "Mary Maloney",
    ),
    false,
  );
});

test("presence-reviewed opening progress accepts only known non-regressing events", () => {
  const candidate = {
    chapterPosition: 0,
    chapterTitle: "Opening",
    summary: "Mary waits before Patrick arrives.",
    excerpt: "Patrick comes through the door.",
    currentStoryEvent: {
      eventId: "event_waiting",
      sequence: 1,
      description: "Mary waits for Patrick.",
      chapterPosition: 0,
    },
    storyEvents: [
      {
        eventId: "event_waiting",
        sequence: 1,
        description: "Mary waits for Patrick.",
        chapterPosition: 0,
      },
      {
        eventId: "event_arrival",
        sequence: 2,
        description: "Patrick arrives home.",
        category: "arrival" as const,
        actors: ["Patrick Maloney"],
        targets: ["Mary Maloney"],
        chapterPosition: 0,
      },
    ],
    nextTextOffset: 200,
  };

  assert.equal(
    reviewedVisibleSourceEvent(candidate, "event_arrival")?.eventId,
    "event_arrival",
  );
  assert.equal(
    reviewedVisibleSourceEvent(candidate, "event_waiting")?.eventId,
    "event_waiting",
  );
  assert.equal(reviewedVisibleSourceEvent(candidate, "unknown_event"), null);
  assert.equal(
    reviewedVisibleSourceEvent(
      {
        ...candidate,
        currentStoryEvent: {
          ...candidate.currentStoryEvent,
          eventId: "event_arrival",
          sequence: 2,
        },
      },
      "event_waiting",
    ),
    null,
  );
});

test("direct source continuation refreshes a consequential player event as an explicit choice", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      assert.equal(request.prompt_cache_key, "bookrpg:book_lamb");
      assert.equal(request.text?.format.name, "bookrpg_scene_choices");
      return {
        output_text: JSON.stringify({
          choices: [
            {
              id: "kill_patrick",
              type: "action",
              text: "Kill Patrick with the frozen leg of lamb",
              character: null,
              sourceAnchorRoute: "event",
              stakes: "critical",
            },
            {
              id: "put_lamb_down",
              type: "action",
              text: "Put the lamb down and step away",
              character: null,
              sourceAnchorRoute: null,
              stakes: "significant",
            },
          ],
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_explicit_source_choice",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A tense domestic drama.",
    },
    objective: "Decide how Mary responds to Patrick.",
    victoryCondition: "There is no fixed ending.",
    status: "active",
    selectedText: "Mary waits for Patrick.",
    sourceCursor: {
      chapterPosition: 4,
      textOffset: 8_571,
      eventId: "event_lamb",
    },
    sourceIntroducedCharacters: ["Mary Maloney", "Patrick Maloney"],
    scene: {
      title: "The frozen lamb",
      text: "You hold the frozen leg of lamb. Patrick stands with his back to you.",
      sceneScope: {
        currentLocation: "Living room",
        peoplePresent: ["Mary Maloney", "Patrick Maloney"],
        peopleWithinSpeakingDistance: ["Mary Maloney", "Patrick Maloney"],
      },
      choices: [{
        id: SOURCE_CONTINUATION_CHOICE_ID,
        type: "action",
        text: SOURCE_CONTINUATION_CHOICE_TEXT,
      }],
      outcome: "active",
    },
    history: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
  const requiredEventBeats: StoryEventBeat[] = [
    {
      actor: "Mary Maloney",
      action: "Swings the frozen leg of lamb at Patrick.",
      targets: ["Patrick Maloney"],
      agency: "intentional",
      stakes: "critical",
      sourceReferences: [],
    },
    {
      actor: "Patrick Maloney",
      action: "Dies from the blow.",
      targets: [],
      agency: "involuntary",
      stakes: "critical",
      sourceReferences: [],
    },
  ];
  const candidate = {
    chapterPosition: 4,
    chapterTitle: "Lamb to the Slaughter",
    summary: "Mary kills Patrick with the frozen leg of lamb.",
    excerpt: "Mary swings the frozen leg of lamb at Patrick.",
    requiredEvent: "Mary kills Patrick with the frozen leg of lamb.",
    requiredEventId: "event_killing",
    requiredEventCategory: "death" as const,
    requiredEventActors: ["Mary Maloney"],
    requiredEventTargets: ["Patrick Maloney"],
    requiredEventBeats,
    storyEvents: [{
      eventId: "event_killing",
      sequence: 6,
      description: "Mary kills Patrick with the frozen leg of lamb.",
      category: "death" as const,
      chapterPosition: 4,
      actors: ["Mary Maloney"],
      targets: ["Patrick Maloney"],
      beats: requiredEventBeats,
    }],
    nextTextOffset: 9_000,
  };

  const result = await new ProviderGameEngine(client, "minimal")
    .continueFromSource(state, [candidate]);

  assert.equal(result?.requiresExplicitPlayerChoice, true);
  assert.equal(result?.eventId, "event_lamb");
  assert.equal(result?.scene.text, state.scene.text);
  assert.equal(result?.scene.choices[0]?.id, SOURCE_ANCHOR_CHOICE_ID);
  assert.equal(result?.scene.choices[0]?.sourceAnchorRoute, "event");
  assert.equal(result?.scene.choices[0]?.stakes, "critical");
  assert.match(
    requests[0]?.instructions ?? "",
    /sourceAnchorRoute 'event'[\s\S]*Use transition only/i,
  );
  assert.match(
    requests[0]?.instructions ?? "",
    /must explicitly name the consequential voluntary act/i,
  );
  assert.match(
    requests[0]?.instructions ?? "",
    /must directly propose the concrete player-controlled act/i,
  );
  assert.match(
    requests[0]?.instructions ?? "",
    /Do not dilute that act into generic movement, continued travel, waiting, watching, scanning, preparation, safety-seeking/i,
  );
  assert.match(
    requests[0]?.instructions ?? "",
    /absent co-actor is not needed[\s\S]*still name the concrete act involving the present participants or targets/i,
  );
  assert.match(
    requests[0]?.instructions ?? "",
    /required_player_choice_beats lists only the immediately eligible player decision/i,
  );
  assert.match(
    requests[0]?.instructions ?? "",
    /source_event_beat_progress still lists a matching source beat as remaining/i,
  );
  assert.match(
    requests[0]?.instructions ?? "",
    /Later uncompleted player decisions remain future/i,
  );
  assert.doesNotMatch(
    requests[0]?.instructions ?? "",
    /make choice 1 the strongest local story-advancing action/i,
  );
  assert.match(
    requests[0]?.input ?? "",
    /"requiresExplicitPlayerChoice": true/,
  );
  const choiceInput = JSON.parse(requests[0]?.input ?? "{}") as {
    next_significant_event?: { beats?: StoryEventBeat[] };
    required_player_choice_beats?: StoryEventBeat[];
  };
  assert.equal(choiceInput.next_significant_event?.beats?.length, 2);
  assert.deepEqual(
    choiceInput.required_player_choice_beats,
    [choiceInput.next_significant_event?.beats?.[0]],
  );
});

test("an established event is inserted structurally without language heuristics", () => {
  const state = {
    establishedEvent: {
      category: "death" as const,
      actor: "Mary Maloney",
      action: "Sloeg Patrick met de bevroren lamsbout",
      target: "Patrick Maloney",
      means: "Een bevroren lamsbout",
      immediateConsequences: ["Patrick stortte dood neer"],
      sourceBacked: true as const,
      narrative: "Mary sloeg de bevroren lamsbout op Patricks schedel. Hij stortte dood aan haar voeten neer.",
    },
    scene: { title: "Starting", text: "", choices: [] },
    history: [{ kind: "start" as const, text: "Lamb to the Slaughter" }],
  };

  assert.equal(
    applyEstablishedEvent(
      state,
      "Mary dwingt haar ademhaling tot rust en begint een alibi te construeren.",
    ),
    [
      "Mary sloeg de bevroren lamsbout op Patricks schedel. Hij stortte dood aan haar voeten neer.",
      "",
      "Mary dwingt haar ademhaling tot rust en begint een alibi te construeren.",
    ].join("\n"),
  );
});

test("scene normalization removes an embedded choice menu without discarding later prose", () => {
  const scene = normalizeSceneTalkChoices({
    title: "A steadier deck",
    text: [
      "The crew settles into a disciplined rhythm.",
      "",
      "Choices:",
      "1) Repeat the order.",
      "2) Call a quick council.",
      "3) Hold the current course.",
      "",
      "The horizon remains open.",
    ].join("\n"),
    choices: [
      { id: "council", type: "action", text: "Call a quick council" },
      { id: "course", type: "action", text: "Hold the current course" },
    ],
  });

  assert.equal(
    scene.text,
    "The crew settles into a disciplined rhythm.\n\nThe horizon remains open.",
  );
  assert.deepEqual(scene.choices.map((choice) => choice.id), ["council", "course"]);
  assert.equal(stripEmbeddedChoiceMenu("Choices are narrowing, but no list follows."), "Choices are narrowing, but no list follows.");
});

test("scene normalization removes a Choice ahead bullet list", () => {
  const text = [
    "Morale becomes the ship's third mast. The horizon answers with a patient roll.",
    "",
    "Choice ahead:",
    "- Secure and study the cargo.",
    "- Test the radar.",
    "- Speak with Awesome.",
    "",
    "The crew awaits your word. The fate of the Pequod hinges on what you do next.",
  ].join("\n");

  assert.equal(
    stripEmbeddedChoiceMenu(text),
    [
      "Morale becomes the ship's third mast. The horizon answers with a patient roll.",
      "",
      "The crew awaits your word. The fate of the Pequod hinges on what you do next.",
    ].join("\n"),
  );
});

test("scene normalization removes an unheaded lettered choice menu and its lead-in", () => {
  const text = [
    "The room goes still after the dull thud. Four paths unfold from this moment, each a careful step forward.",
    "",
    "A) Begin constructing an alibi.",
    "B) Hide the weapon.",
    "C) Call the grocer.",
    "D) Invite the detectives to eat later.",
  ].join("\n");

  assert.equal(
    stripEmbeddedChoiceMenu(text),
    "The room goes still after the dull thud.",
  );
});

test("scene normalization removes a What do you do next menu with parenthesized numbers", () => {
  const text = [
    "Patrick's confession leaves the room dangerously still.",
    "",
    "What do you do next?",
    "",
    "1) Suggest a quiet supper.",
    "2) Call Sam to stage a cheerful scene.",
    "3) Ask Patrick to reconsider.",
  ].join("\n");

  assert.equal(
    stripEmbeddedChoiceMenu(text),
    "Patrick's confession leaves the room dangerously still.",
  );
});

test("player perspective makes the selected role authoritative over the source viewpoint", () => {
  const perspective = buildPlayerPerspective("Detectives (police)");

  assert.match(perspective, /player identity: "Detectives \(police\)"/);
  assert.match(perspective, /first-person singular/i);
  assert.match(perspective, /using I, me, and my/i);
  assert.match(perspective, /Non-player dialogue may address the player as you/i);
  assert.match(perspective, /source passage establishes the situation only/i);
  assert.match(perspective, /Never switch the player to another character/i);
  assert.match(perspective, /implicit actor of every offered choice/i);
  assert.match(perspective, /Never name player_identity or any of their aliases inside a choice/i);
});

test("player perspective preserves a canonical nonhuman body and location", () => {
  const profile = {
    name: "Moby Dick",
    aliases: ["White Whale"],
    role: "The elemental objective of Ahab's pursuit",
    description: "A white sperm whale pursued across the Pacific.",
    traits: ["mysterious", "powerful"],
    relationships: [],
    storyArc: "The whale remains an unknowable force of nature.",
  };

  assert.equal(findPlayerCharacterProfile("white whale", [profile]), profile);

  const perspective = buildPlayerPerspective("White Whale", profile);
  assert.match(perspective, /canonical profile.*white sperm whale/i);
  assert.match(perspective, /physical form, species or nature/i);
  assert.match(perspective, /never place one standing or walking on a ship's deck/i);
  assert.match(perspective, /source narrator's viewpoint and location do not relocate the player/i);
  assert.match(perspective, /physically possible for the player/i);

  const spoilerSafePerspective = buildPlayerPerspective("White Whale", profile, true);
  assert.doesNotMatch(spoilerSafePerspective, /elemental objective/i);
  assert.doesNotMatch(spoilerSafePerspective, /white sperm whale/i);
  assert.doesNotMatch(spoilerSafePerspective, /unknowable force/i);
});

test("choice timeline rules prohibit unreached future premises", () => {
  const rules = CHOICE_TIMELINE_RULES.join("\n");

  assert.match(rules, /only people, objects, events, and information already established/i);
  assert.match(rules, /background knowledge, never as evidence/i);
  assert.match(rules, /presupposes a future character, arrival, crime/i);
  assert.match(rules, /when they arrive.*does not make an unreached event/i);
});

test("canon block repeats durable rules, tone, facts, and present characters", () => {
  const state: GameState = {
    gameId: "game_canon",
    book: { bookId: "book_canon", title: "Canon Story" },
    wholeBookSummary: "SECRET WHOLE-BOOK SUMMARY SENTINEL",
    playerName: "Person Alpha",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "Restrained gothic tension with concrete sensory detail.",
    },
    objective: "Protect the archive.",
    victoryCondition: "Keep the archive intact.",
    establishedEvent: {
      category: "death",
      actor: "Person Alpha",
      action: "killed",
      target: "Person Beta",
      means: "a ritual blade",
      immediateConsequences: ["Person Beta is dead."],
      sourceBacked: true,
      narrative: "Person Alpha killed Person Beta with a ritual blade.",
    },
    status: "active",
    selectedText: "Person Alpha enters the archive.",
    parameters: ["Magic always requires a spoken oath."],
    storyMemory: {
      summary: "Person Alpha entered the archive.",
      openThreads: ["The archive door remains unsealed."],
      canonFacts: ["The silver key is in Person Alpha's pocket."],
    },
    characterProfiles: [{
      name: "Person Beta",
      aliases: ["Beta"],
      role: "Archivist",
      description: "The keeper of the archive.",
      traits: ["careful"],
      relationships: [],
      storyArc: "Guards the archive.",
    }, {
      name: "Person Gamma",
      aliases: ["Gamma"],
      role: "Distant merchant",
      description: "Trades in another city.",
      traits: ["patient"],
      relationships: [],
      storyArc: "Never visits the archive.",
    }],
    sourceIntroducedCharacters: ["Person Beta"],
    scene: {
      title: "The archive",
      text: "Beta lies motionless beside the open archive door.",
      sceneScope: {
        currentLocation: "The archive",
        peoplePresent: ["Person Alpha", "Person Beta"],
        peopleWithinSpeakingDistance: ["Person Alpha", "Person Beta"],
      },
      choices: [
        { id: "seal", type: "action", text: "Seal the archive door" },
        { id: "leave", type: "action", text: "Leave the archive" },
      ],
      outcome: "active",
    },
    history: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };

  assert.deepEqual(buildCanonBlock(state), {
    worldRules: ["Magic always requires a spoken oath."],
    tone: "Restrained gothic tension with concrete sensory detail.",
    playerIdentity: "Person Alpha",
    immutableFacts: [
      "Person Alpha killed Person Beta.",
      "Person Beta is dead.",
      "The silver key is in Person Alpha's pocket.",
    ],
    presentCharacters: ["Person Alpha"],
    knownSourceCharacters: ["Person Beta"],
    continuityRules: [
      "Player-facing established facts override future summaries and source material.",
      "Unselected choices have not happened.",
      "Never change the player identity or swap actor and target roles.",
    ],
  });
  assert.deepEqual(buildCanonBlock({
    ...state,
    establishedEvent: undefined,
    scene: {
      ...state.scene,
      text: "Person Alpha remembers Beta's warning while standing alone in the archive.",
      sceneScope: undefined,
    },
  }).presentCharacters, []);
  const context = buildGameContext(state);
  assert.match(context, /"canon"/);
  assert.match(context, /"story_memory"/);
  assert.match(context, /The archive door remains unsealed/);
  assert.doesNotMatch(context, /SECRET WHOLE-BOOK SUMMARY SENTINEL/);
  assert.equal("whole_book_summary" in JSON.parse(context), false);

  const openingContext = JSON.parse(buildGameContext(state, [], true));
  assert.equal("whole_book_summary" in openingContext, false);
  assert.deepEqual(openingContext.character_profiles, [{
    name: "Person Beta",
    aliases: ["Beta"],
  }]);
  assert.doesNotMatch(JSON.stringify(openingContext), /Person Gamma/);
  assert.deepEqual(openingContext.player_character_profile, null);
  assert.doesNotMatch(JSON.stringify(openingContext), /keeper of the archive/i);

  const playerOpeningContext = JSON.parse(buildGameContext({
    ...state,
    playerName: "Person Beta",
  }, [{
    chapterPosition: 3,
    chapterTitle: "The Archive",
    summary: "Person Beta enters the archive.",
    storySoFar: [{
      chapterPosition: 2,
      chapterTitle: "The Journey",
      summary: "The travellers reach the city.",
    }],
    excerpt: "Person Beta unlocks the archive door while Gamma watches.",
    nextTextOffset: 42,
  }], true));
  assert.deepEqual(playerOpeningContext.player_character_profile, {
    name: "Person Beta",
    aliases: ["Beta"],
  });
  assert.deepEqual(playerOpeningContext.character_profiles, [{
    name: "Person Beta",
    aliases: ["Beta"],
  }, {
    name: "Person Gamma",
    aliases: ["Gamma"],
  }]);
  assert.deepEqual(playerOpeningContext.story_so_far, [{
    chapterPosition: 2,
    chapterTitle: "The Journey",
    summary: "The travellers reach the city.",
  }]);
  assert.equal(playerOpeningContext.source_guidance_mode, "optional_opening_reference");
  assert.equal(playerOpeningContext.game_profile.description, undefined);
  assert.equal(playerOpeningContext.canon.tone, "drama");
  assert.doesNotMatch(JSON.stringify(playerOpeningContext), /keeper of the archive/i);
});

test("ongoing scene context includes compact profiles only for nearby NPCs", () => {
  const sourceReference = {
    chapterPosition: 1,
    chapterIndex: 1,
    lineStart: 10,
    lineEnd: 12,
  };
  const bookWideEventDescription =
    `BOOK-WIDE EVENT SENTINEL ${"irrelevant history ".repeat(2_000)}`;
  const bookWideEvent = {
    eventId: "event_book_wide_history",
    sequence: 99,
    description: bookWideEventDescription,
    category: "other" as const,
    chapterPosition: 1,
    actors: ["Nearby Person"],
    targets: ["Distant Person"],
    sourceReferences: [sourceReference],
  };
  const characterProfiles: NonNullable<GameState["characterProfiles"]> = [
    {
      name: "Player One",
      aliases: ["Player"],
      role: "Player",
      description: "The player character.",
      traits: ["observant"],
      relationships: [{
        character: "Nearby Person",
        description: "Trusts the nearby companion.",
        sourceReferences: [sourceReference],
      }],
      actions: [{
        description: "BOOK-WIDE PLAYER ACTION SENTINEL",
        targets: [{ character: "Distant Person" }],
        sourceReferences: [sourceReference],
      }],
      significantEvents: [bookWideEvent],
      sourceReferences: [sourceReference],
      storyArc: "Protects the immediate group.",
    },
    {
      name: "Nearby Person",
      aliases: ["Companion"],
      role: "Companion",
      description: "Standing beside the player.",
      traits: ["reliable"],
      relationships: [{
        character: "Player One",
        description: "Travels with the player.",
        sourceReferences: [sourceReference],
      }],
      actions: [{
        description: "BOOK-WIDE NPC ACTION SENTINEL",
        targets: [{ character: "Distant Person" }],
        sourceReferences: [sourceReference],
      }],
      significantEvents: [bookWideEvent],
      sourceReferences: [sourceReference],
      storyArc: "Supports the journey.",
    },
    {
      name: "Distant Person",
      aliases: ["Distant"],
      role: "Distant source actor",
      description: "Somewhere else.",
      traits: [],
      relationships: [],
      storyArc: "",
    },
  ];
  const state: GameState = {
    gameId: "game_nearby_profiles",
    book: { bookId: "book_nearby_profiles", title: "Nearby Profiles" },
    playerName: "Player One",
    gameProfile: {
      category: "adventure",
      endingMode: "open_ended",
      description: "A focused adventure.",
    },
    objective: "Stay aware of the immediate surroundings.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "A distant event is approaching.",
    characterProfiles,
    scene: {
      title: "At the crossroads",
      text: "The companion stands beside you at the crossroads.",
      sceneScope: {
        currentLocation: "The crossroads",
        peoplePresent: ["Companion"],
        peopleWithinSpeakingDistance: ["Companion"],
      },
      choices: [],
    },
    history: [],
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };

  const context = JSON.parse(buildGameContext(state, [{
    chapterPosition: 2,
    chapterTitle: "Elsewhere",
    summary: "Distant Person makes a discovery.",
    excerpt: "Far away, Distant Person opens a sealed door.",
    requiredEvent: "Distant Person opens the sealed door.",
    requiredEventActors: ["Distant Person"],
    nextTextOffset: 42,
  }])) as {
    character_profiles: Array<{
      name: string;
      aliases: string[];
      role: string;
      description: string;
      traits: string[];
      relationships: Array<{ character: string; description: string }>;
      storyArc: string;
    }>;
    player_character_profile: {
      name: string;
      aliases: string[];
      role: string;
      description: string;
      traits: string[];
      relationships: Array<{ character: string; description: string }>;
      storyArc: string;
    } | null;
  };

  assert.deepEqual(context.character_profiles, [{
    name: "Nearby Person",
    aliases: ["Companion"],
    role: "Companion",
    description: "Standing beside the player.",
    traits: ["reliable"],
    relationships: [{
      character: "Player One",
      description: "Travels with the player.",
    }],
    storyArc: "Supports the journey.",
  }]);
  assert.deepEqual(context.player_character_profile, {
    name: "Player One",
    aliases: ["Player"],
    role: "Player",
    description: "The player character.",
    traits: ["observant"],
    relationships: [{
      character: "Nearby Person",
      description: "Trusts the nearby companion.",
    }],
    storyArc: "Protects the immediate group.",
  });
  const serializedContext = JSON.stringify(context);
  assert.doesNotMatch(serializedContext, /BOOK-WIDE/);
  assert.ok(
    serializedContext.length < 10_000,
    `Expected compact scene context, received ${serializedContext.length} characters`,
  );
});

test("story memory stays concise and excludes choices and future source events", () => {
  const rules = STORY_MEMORY_RULES.join("\n");

  assert.match(rules, /under 900 characters/i);
  assert.match(rules, /at most 6 unresolved/i);
  assert.match(rules, /Do not treat unselected choices/i);
  assert.match(rules, /unreached source material/i);
  assert.match(rules, /at most 12 durable, established facts/i);
});

test("critical choice metadata raises reasoning without classifying free text", () => {
  assert.equal(reasoningEffortForTurn("minimal", undefined), "minimal");
  assert.equal(reasoningEffortForTurn("minimal", "routine"), "minimal");
  assert.equal(reasoningEffortForTurn("low", "significant"), "low");
  assert.equal(reasoningEffortForTurn("minimal", "critical"), "high");
  assert.equal(reasoningEffortForTurn("max", "critical"), "max");
});

test("a structured severe event is inserted before an opening aftermath", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return validSceneRepetitionReviewResponse();
      }
      return {
        output_text: JSON.stringify({
          title: "The Aftermath",
          text: "Mary forces her breathing to slow and begins constructing an alibi.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: "",
          sourceChapterPosition: null,
          choices: [
            { id: "alibi", type: "action", text: "Rehearse the call to the police", character: null },
            { id: "weapon", type: "action", text: "Put the leg of lamb into the oven", character: null },
          ],
          outcome: "active",
          outcomeReason: "Mary must now conceal what she has done.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_severe_opening",
    book: { bookId: "book-severe", title: "A Severe Story" },
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A violent domestic drama.",
    },
    objective: "Investigate the immediate consequences of the murder.",
    victoryCondition: "Maintain the alibi after the killing.",
    establishedEvent: {
      category: "death",
      actor: "Mary",
      action: "Killed Patrick",
      target: "Patrick",
      means: "Frozen leg of lamb",
      immediateConsequences: ["Patrick died"],
      sourceBacked: true,
      narrative: "Mary brought the frozen leg of lamb down on Patrick's skull. He collapsed dead at her feet, his body motionless on the floor.",
    },
    status: "active",
    selectedText: "Title page",
    scene: { title: "Starting", text: "", choices: [] },
    history: [{ kind: "start", text: "Title page" }],
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  };

  const scene = await new ProviderGameEngine(client, "minimal").start(state);

  assert.equal(requests.length, 3);
  assert.equal(
    requests.some(
      (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
    ),
    false,
  );
  assert.equal(
    requests.find((request) => request.text?.format.name === "bookrpg_scene")
      ?.reasoning?.effort,
    "minimal",
  );
  assert.doesNotMatch(
    sceneJsonSchemaForSourceChapters([]).required.join(" "),
    /establishedEvent/,
  );
  assert.deepEqual(
    sceneJsonSchemaForSourceChapters([]).properties.choices.items.required,
    [
      "id",
      "type",
      "text",
      "character",
      "requiredPresentCharacters",
      "requiredAbsentCharacters",
      "sourceAnchorRoute",
      "stakes",
    ],
  );
  assert.ok(sceneJsonSchemaForSourceChapters([]).required.includes("sceneScope"));
  assert.deepEqual(
    sceneJsonSchemaForSourceChapters([]).properties.sceneScope.required,
    ["currentLocation", "peoplePresent", "peopleWithinSpeakingDistance"],
  );
  assert.match(scene.text, /^Mary brought the frozen leg of lamb down/);
  assert.match(scene.text, /constructing an alibi\.$/);
});

test("an opening performs scene, presence, and choice checks without repetition review", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        throw new Error("Opening must not request semantic repetition review");
      }
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      return {
        output_text: JSON.stringify({
          title: "The Dungeon Classroom",
          text: "I survey the students from the front of my dungeon classroom.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: "",
          sourceChapterPosition: null,
          sceneScope: {
            currentLocation: "Hogwarts Potions classroom",
            peoplePresent: ["Hermione Granger"],
            peopleWithinSpeakingDistance: ["Hermione Granger"],
          },
          choices: [
            {
              id: "begin_lesson",
              type: "action",
              text: "Begin the lesson",
              character: null,
              requiredPresentCharacters: [],
              requiredAbsentCharacters: [],
              stakes: "routine",
            },
            {
              id: "question_hermione",
              type: "talk",
              text: "Question Hermione",
              character: "Hermione Granger",
              requiredPresentCharacters: ["Hermione Granger"],
              requiredAbsentCharacters: [],
              stakes: "routine",
            },
          ],
          outcome: "active",
          outcomeReason: "The lesson is beginning.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_opening_without_repetition_review",
    book: { bookId: "book_opening", title: "A Wizarding Story" },
    playerName: "Severus Snape",
    characterProfiles: [{
      name: "Hermione Granger",
      aliases: ["Hermione"],
      role: "Student",
      description: "A student.",
      traits: ["studious"],
      relationships: [],
      storyArc: "",
    }],
    gameProfile: {
      category: "adventure",
      endingMode: "open_ended",
      description: "A magical school story.",
    },
    objective: "Shape Snape's path.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "The Potions lesson begins.",
    scene: { title: "Starting...", text: "", choices: [] },
    history: [{ kind: "start", text: "A Wizarding Story" }],
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };

  const scene = await new ProviderGameEngine(client, "minimal").start(state);

  assert.equal(scene.title, "The Dungeon Classroom");
  assert.equal(
    requests.filter(
      (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
    ).length,
    0,
  );
  assert.equal(
    requests.filter(
      (request) => request.text?.format.name === "bookrpg_scene_presence_review",
    ).length,
    1,
  );
});

test("an opening scene omits the empty placeholder from game context", () => {
  const state: GameState = {
    gameId: "game_opening_context",
    book: { bookId: "book_opening_context", title: "Opening Context" },
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Navigate the evening.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Mary waits for Patrick to return.",
    scene: { title: "Starting…", text: "", choices: [] },
    history: [{ kind: "start", text: "Mary waits for Patrick to return." }],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };

  const context = JSON.parse(buildGameContext(state)) as {
    current_scene: GameState["scene"] | null;
  };

  assert.equal(context.current_scene, null);
});

test("the dedicated event classifier uses only completed source-indexed actions", async () => {
  const book: ImportedBook = {
    bookId: "book-structured-event",
    sourceSha256: "structured-event-sha",
    title: "Structured Event",
    chapters: [{
      index: 0,
      title: "The event",
      text: "Before.\nThe irreversible event happens.\nAfter.",
      summary: "A major event changes everything.",
      sourceIndex: {
        schemaVersion: CHAPTER_SOURCE_INDEX_VERSION,
        summary: "A major event changes everything.",
        significantEvents: [{
          description: "Person Alpha causes an irreversible event affecting Person Beta.",
          sourceReferences: [{
            chapterPosition: 0,
            chapterIndex: 0,
            lineStart: 2,
            lineEnd: 2,
          }],
        }],
        characters: [],
        actions: [
          {
            actor: "Person Alpha",
            description: "Causes an irreversible event affecting Person Beta.",
            targets: ["Person Beta"],
            sourceReferences: [{
              chapterPosition: 0,
              chapterIndex: 0,
              lineStart: 2,
              lineEnd: 2,
            }],
          },
          {
            actor: "Person Alpha",
            description: "Performs a later action.",
            targets: [],
            sourceReferences: [{
              chapterPosition: 0,
              chapterIndex: 0,
              lineStart: 3,
              lineEnd: 3,
            }],
          },
        ],
        relationships: [],
      },
    }],
    importedAt: "2026-08-28T10:00:00.000Z",
  };
  const state: GameState = {
    gameId: "game-structured-event",
    book: { bookId: book.bookId, title: book.title },
    playerName: "Person Alpha",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "Consequential drama.",
    },
    objective: "Navigate the immediate aftermath.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "The irreversible event happens.",
    scene: { title: "Starting", text: "", choices: [] },
    history: [{ kind: "start", text: "The irreversible event happens." }],
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  };
  assert.deepEqual(
    sourceActionsCompletedAtSelectedMoment(book, state.selectedText).map(
      (action) => action.description,
    ),
    ["Causes an irreversible event affecting Person Beta."],
  );

  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      return {
        output_text: JSON.stringify({
          established: true,
          reason: "The indexed action is irreversible and defines the aftermath.",
          event: {
            category: "other",
            actor: "Person Alpha",
            action: "Causes an irreversible event",
            target: "Person Beta",
            means: "",
            immediateConsequences: ["Person Beta is permanently affected"],
            sourceBacked: true,
            narrative: "Person Alpha causes the irreversible event. Person Beta is permanently affected.",
          },
        }),
      };
    },
  };

  const event = await new ProviderGameEngine(client, "minimal")
    .identifyEstablishedEvent(state, book);

  assert.equal(requests.length, 1);
  assert.match(requests[0]?.input ?? "", /completed_source_actions/);
  assert.doesNotMatch(requests[0]?.input ?? "", /Performs a later action/);
  assert.equal(event?.category, "other");
  assert.equal(event?.sourceBacked, true);
});

test("choices cannot target or name the player as a separate character", () => {
  const profile = {
    name: "Moby Dick",
    aliases: ["White Whale"],
    role: "Whale",
    description: "A white whale.",
    traits: [],
    relationships: [],
    storyArc: "He is hunted.",
  };
  const scene: GameState["scene"] = {
    title: "At sea",
    text: "The whale listens.",
    choices: [
      { id: "self-name", type: "talk", text: "Talk to Moby Dick", character: "Moby Dick" },
      { id: "self-alias", type: "talk", text: "Talk to White Whale", character: "White Whale" },
      {
        id: "self-action-target",
        type: "action",
        text: "Help Ishmael steady Moby Dick",
        character: "Moby Dick",
      },
      {
        id: "self-action-text",
        type: "action",
        text: "Watch while Ishmael approaches the White Whale",
      },
      { id: "other", type: "talk", text: "Talk to Ishmael", character: "Ishmael" },
      { id: "dive", type: "action", text: "Dive" },
    ],
  };

  assert.deepEqual(
    removeChoicesWithPlayerIdentityReferences(
      scene,
      "Moby Dick",
      [profile],
    ).choices.map((choice) => choice.id),
    ["other", "dive"],
  );
});

test("talk choices are unavailable until the character appears in played narrative", () => {
  const state = {
    playerName: "Mary",
    scene: {
      title: "A Quiet Kitchen",
      text: "Mary waits for Patrick to return.",
      choices: [],
    },
    history: [{ kind: "start", text: "Lamb to the Slaughter" }],
    characterProfiles: [{
      name: "Sam",
      aliases: ["the grocer"],
      role: "Grocer",
      description: "The neighborhood grocer.",
      traits: [],
      relationships: [],
      storyArc: "Sam sells Mary groceries later in the story.",
    }],
  } satisfies Pick<
    GameState,
    "scene" | "history" | "characterProfiles" | "playerName" | "sourceIntroducedCharacters"
  >;
  const scene: GameState["scene"] = {
    title: "Supper preparations",
    text: "Patrick's key turns in the lock.",
    choices: [
      { id: "sam", type: "talk", text: "Talk to Sam", character: "Sam" },
      { id: "patrick", type: "talk", text: "Talk to Patrick", character: "Patrick" },
      { id: "wait", type: "action", text: "Wait by the table" },
    ],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(scene, state).choices.map((choice) => choice.id),
    ["patrick", "wait"],
  );
});

test("action choices cannot mention an unintroduced canonical character", () => {
  const state = {
    playerName: "Mary Maloney",
    scene: {
      title: "A crowded room",
      text: "Mary keeps the guests laughing while Patrick watches.",
      choices: [],
    },
    history: [],
    characterProfiles: [{
      name: "Sam",
      aliases: ["the grocer"],
      role: "Grocer",
      description: "The neighborhood grocer.",
      traits: [],
      relationships: [],
      storyArc: "Mary visits him later.",
    }],
  } satisfies Pick<
    GameState,
    "scene" | "history" | "characterProfiles" | "playerName" | "sourceIntroducedCharacters"
  >;
  const scene: GameState["scene"] = {
    title: "Shared laughter",
    text: "The room brightens with communal laughter.",
    choices: [
      {
        id: "sam-refill",
        type: "action",
        text: "Signal to Sam for a discreet refill of drinks.",
      },
      {
        id: "neutral",
        type: "action",
        text: "Turn the conversation toward neutral topics.",
      },
    ],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(scene, state).choices.map((choice) => choice.id),
    ["neutral"],
  );
  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(
      scene,
      { ...state, sourceIntroducedCharacters: ["Sam"] },
    ).choices.map((choice) => choice.id),
    ["sam-refill", "neutral"],
  );
});

test("the reached current source event can introduce a character for opening choices", () => {
  const state = {
    playerName: "Mary Maloney",
    scene: {
      title: "The revelation",
      text: "You listen carefully as his decision lands.",
      choices: [],
    },
    history: [],
    characterProfiles: [{
      name: "Patrick Maloney",
      aliases: ["Patrick"],
      role: "Husband",
      description: "Mary's husband.",
      traits: [],
      relationships: [],
      storyArc: "His announcement changes the evening.",
    }],
    sourceIntroducedCharacters: [],
  } satisfies Pick<
    GameState,
    "scene" | "history" | "characterProfiles" | "playerName" | "sourceIntroducedCharacters"
  >;
  const scene: GameState["scene"] = {
    ...state.scene,
    choices: [
      {
        id: "talk",
        type: "talk",
        text: "Talk to Patrick Maloney",
        character: "Patrick Maloney",
      },
      {
        id: "prepare",
        type: "action",
        text: "Prepare supper while Patrick Maloney remains nearby",
      },
    ],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(
      scene,
      state,
      visibleSourceEventNarrative([{
        chapterPosition: 1,
        chapterTitle: "The revelation",
        summary: "Patrick makes his announcement.",
        excerpt: "Patrick tells Mary he intends to leave.",
        currentStoryEvent: {
          eventId: "patrick-announcement",
          sequence: 2,
          description: "Patrick Maloney reveals that he intends to leave Mary.",
          chapterPosition: 1,
        },
        nextTextOffset: 100,
      }]),
    ).choices.map((choice) => choice.id),
    ["talk", "prepare"],
  );
});

test("an upcoming source event cannot introduce a character for choices", () => {
  const state = {
    playerName: "Mary Maloney",
    scene: {
      title: "A quiet evening",
      text: "You sit alone and listen to the clock.",
      choices: [],
    },
    history: [],
    characterProfiles: [{
      name: "Patrick Maloney",
      aliases: ["Patrick"],
      role: "Husband",
      description: "Mary's husband.",
      traits: [],
      relationships: [],
      storyArc: "He arrives later.",
    }],
    sourceIntroducedCharacters: [],
  } satisfies Pick<
    GameState,
    "scene" | "history" | "characterProfiles" | "playerName" | "sourceIntroducedCharacters"
  >;
  const scene: GameState["scene"] = {
    ...state.scene,
    choices: [
      {
        id: "talk",
        type: "talk",
        text: "Talk to Patrick Maloney",
        character: "Patrick Maloney",
      },
      { id: "wait", type: "action", text: "Continue waiting by the clock" },
    ],
  };
  const upcomingNarrative = visibleSourceEventNarrative([{
    chapterPosition: 1,
    chapterTitle: "The homecoming",
    summary: "Patrick arrives home.",
    excerpt: "Patrick's key turns in the lock.",
    storyEvents: [{
      eventId: "patrick-arrives",
      sequence: 2,
      description: "Patrick Maloney arrives home.",
      chapterPosition: 1,
    }],
    nextTextOffset: 100,
  }]);

  assert.equal(upcomingNarrative, "");
  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(
      scene,
      state,
      upcomingNarrative,
    ).choices.map((choice) => choice.id),
    ["wait"],
  );
});

test("action choices cannot anticipate unintroduced characters by role", () => {
  const state = {
    playerName: "Mary Maloney",
    scene: {
      title: "A quiet evening",
      text: "The room remains warm and still while Patrick considers leaving.",
      choices: [],
    },
    history: [],
    characterProfiles: [{
      name: "Jack Noonan",
      aliases: [],
      role: "Police detective",
      description: "A detective who later investigates the house.",
      traits: [],
      relationships: [],
      storyArc: "He arrives after the crime.",
    }, {
      name: "Unknown Policemen",
      aliases: [],
      role: "Investigative officers",
      description: "Officers who later search the house.",
      traits: [],
      relationships: [],
      storyArc: "They arrive after the police are called.",
    }],
  } satisfies Pick<
    GameState,
    "scene" | "history" | "characterProfiles" | "playerName" | "sourceIntroducedCharacters"
  >;
  const scene: GameState["scene"] = {
    title: "Dinner preparations",
    text: "The clock ticks while you straighten the room.",
    choices: [
      {
        id: "dinner",
        type: "action",
        text: "Continue prepping dinner while keeping the house quiet and orderly.",
      },
      {
        id: "groceries",
        type: "action",
        text: "Check the groceries for anything out of place.",
      },
      {
        id: "detectives",
        type: "action",
        text: "Position yourself to greet the detectives with a calm welcome when they arrive.",
      },
    ],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(scene, state).choices.map(
      (choice) => choice.id,
    ),
    ["dinner", "groceries"],
  );
  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(
      {
        ...scene,
        text: "A car stops outside. Two detectives knock at the front door.",
        choices: [scene.choices[2]!],
      },
      state,
    ).choices.map((choice) => choice.id),
    ["detectives"],
  );
});

test("a character introduced by canonical name or alias becomes available to talk", () => {
  const state = {
    playerName: "Mary",
    scene: { title: "The street", text: "The grocer waves from his doorway.", choices: [] },
    history: [],
    characterProfiles: [{
      name: "Sam",
      aliases: ["the grocer"],
      role: "Grocer",
      description: "The neighborhood grocer.",
      traits: [],
      relationships: [],
      storyArc: "He serves local customers.",
    }],
  } satisfies Pick<
    GameState,
    "scene" | "history" | "characterProfiles" | "playerName" | "sourceIntroducedCharacters"
  >;
  const scene: GameState["scene"] = {
    title: "At the shop",
    text: "You cross the street.",
    choices: [{ id: "sam", type: "talk", text: "Talk to Sam", character: "Sam" }],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(scene, state).choices.map((choice) => choice.id),
    ["sam"],
  );
});

test("a named character awaiting arrival is unavailable to talk", () => {
  const state = {
    playerName: "Mary Maloney",
    scene: {
      title: "Earlier",
      text: "Patrick Maloney was here earlier.",
      choices: [],
    },
    history: [{
      kind: "scene" as const,
      text: "Mary and Patrick Maloney spoke in the kitchen.",
    }],
    characterProfiles: [{
      name: "Patrick Maloney",
      aliases: ["Patrick"],
      role: "Husband",
      description: "Mary's husband.",
      traits: [],
      relationships: [],
      storyArc: "His announcement changes the evening.",
    }],
    sourceIntroducedCharacters: ["Patrick Maloney"],
  };
  const scene: GameState["scene"] = {
    title: "Waiting",
    text: "You listen for Patrick’s return while the kettle boils.",
    sceneScope: { currentLocation: "Kitchen", peoplePresent: ["Mary Maloney"], peopleWithinSpeakingDistance: ["Mary Maloney"] },
    choices: [
      {
        id: "patrick",
        type: "talk",
        text: "Talk to Patrick Maloney",
        character: "Patrick Maloney",
      },
      { id: "wait", type: "action", text: "Keep waiting by the stove" },
    ],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(scene, state).choices.map(
      (choice) => choice.id,
    ),
    ["wait"],
  );
});

test("a conditional future entrance keeps the named character unavailable", () => {
  const state = {
    playerName: "Mary Maloney",
    scene: {
      title: "Waiting",
      text:
        "You listen for tires on gravel. When Patrick's footsteps cross the threshold, "
        + "you will respond with familiar warmth.",
      choices: [],
    },
    history: [],
    characterProfiles: [{
      name: "Patrick Maloney",
      aliases: ["Patrick"],
      role: "Husband",
      description: "Mary's husband.",
      traits: [],
      relationships: [],
      storyArc: "He arrives later.",
    }],
    sourceIntroducedCharacters: ["Patrick Maloney"],
  };
  const scene: GameState["scene"] = {
    ...state.scene,
    sceneScope: { currentLocation: "Kitchen", peoplePresent: ["Mary Maloney"], peopleWithinSpeakingDistance: ["Mary Maloney"] },
    choices: [
      {
        id: "talk",
        type: "talk",
        text: "Talk to Patrick Maloney",
        character: "Patrick Maloney",
      },
      { id: "wait", type: "action", text: "Continue waiting by the window" },
    ],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(scene, state).choices.map((choice) => choice.id),
    ["wait"],
  );
});

test("structured pending arrivals block talk when prose uses only a pronoun", () => {
  const state = {
    playerName: "Mary Maloney",
    scene: {
      title: "Waiting",
      text: "You keep sewing and tell yourself he will walk in soon.",
      choices: [],
    },
    history: [],
    characterProfiles: [{
      name: "Patrick Maloney",
      aliases: ["Patrick"],
      role: "Husband",
      description: "Mary's husband.",
      traits: [],
      relationships: [],
      storyArc: "He arrives later.",
    }],
    sourceIntroducedCharacters: ["Patrick Maloney"],
  };
  const scene: GameState["scene"] = {
    ...state.scene,
    choices: [
      {
        id: "talk",
        type: "talk",
        text: "Talk to Patrick Maloney",
        character: "Patrick Maloney",
      },
      { id: "wait", type: "action", text: "Continue sewing while you wait" },
    ],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(
      scene,
      state,
      "Mary anticipates Patrick's return.",
      ["Patrick Maloney"],
    ).choices.map((choice) => choice.id),
    ["wait"],
  );
});

test("an opening may mention an absent character but cannot make them interact", () => {
  const state = {
    playerName: "Mary Maloney",
    characterProfiles: [
      {
        name: "Mary Maloney",
        aliases: ["Mary"],
        role: "Protagonist",
        description: "She waits at home.",
        traits: [],
        relationships: [],
        storyArc: "Her evening changes.",
      },
      {
        name: "Patrick Maloney",
        aliases: ["Patrick"],
        role: "Husband",
        description: "Mary awaits his return.",
        traits: [],
        relationships: [],
        storyArc: "He arrives next.",
      },
      {
        name: "Sam",
        aliases: ["the grocer"],
        role: "Grocer",
        description: "He appears later.",
        traits: [],
        relationships: [],
        storyArc: "Mary visits him later.",
      },
    ],
    sourceIntroducedCharacters: [],
  };
  const candidate = {
    chapterPosition: 0,
    chapterTitle: "Home",
    summary: "Mary waits for Patrick.",
    excerpt: "Mary waits.",
    requiredEvent: "Mary Maloney anticipates Patrick Maloney's return.",
    requiredEventId: "mary-waits",
    nextTextOffset: 100,
  };

  assert.deepEqual(
    openingCharacterContinuityFailures(
      "You wait for Patrick while remembering Sam's shop.",
      state,
      [candidate],
    ),
    [],
  );
  assert.deepEqual(
    openingCharacterContinuityFailures(
      "Sam enters the room and asks what you need.",
      state,
      [candidate],
      { currentLocation: "Home", peoplePresent: ["Mary Maloney", "Sam"], peopleWithinSpeakingDistance: ["Mary Maloney", "Sam"] },
    ),
    ["The opening scene depicts Sam arriving or interacting before the source introduces that character."],
  );
  assert.deepEqual(
    openingCharacterContinuityFailures(
      "You wait for Patrick while the clock ticks.",
      state,
      [candidate],
    ),
    [],
  );
});



test("choices cannot directly interact with a character awaiting arrival", () => {
  const state = {
    playerName: "Mary Maloney",
    scene: {
      title: "Waiting",
      text: "You listen for Patrick’s return while the kettle boils.",
      choices: [],
    },
    history: [],
    characterProfiles: [{
      name: "Patrick Maloney",
      aliases: ["Patrick"],
      role: "Husband",
      description: "Mary's husband.",
      traits: [],
      relationships: [],
      storyArc: "His announcement changes the evening.",
    }],
    sourceIntroducedCharacters: ["Patrick Maloney"],
  };
  const scene: GameState["scene"] = {
    title: "Still waiting",
    text: "Patrick has not arrived, and the house remains quiet.",
    sceneScope: { currentLocation: "Kitchen", peoplePresent: ["Mary Maloney"], peopleWithinSpeakingDistance: ["Mary Maloney"] },
    choices: [
      {
        id: "ask",
        type: "action",
        text: "Ask Patrick about the timing of his plan",
        character: "Patrick Maloney",
      },
      {
        id: "question",
        type: "action",
        text: "Switch to a softer question about his emotions about leaving",
        character: "Patrick Maloney",
      },
      {
        id: "prepare",
        type: "action",
        text: "Prepare a drink for Patrick before he returns",
      },
    ],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(scene, state).choices.map(
      (choice) => choice.id,
    ),
    ["prepare"],
  );
});

test("AI-classified choice prerequisites are checked against SceneScope", () => {
  const characterProfiles = [{
    name: "Dorothy",
    aliases: [],
    role: "Traveler",
    description: "",
    traits: [],
    relationships: [],
    storyArc: "",
  }, {
    name: "Oz",
    aliases: ["the Wizard"],
    role: "Wizard",
    description: "",
    traits: [],
    relationships: [],
    storyArc: "",
  }];
  const sceneScope = {
    currentLocation: "Forest path toward the Emerald City",
    peoplePresent: ["Dorothy"],
    peopleWithinSpeakingDistance: ["Dorothy"],
  };
  const state = {
    playerName: "Tin Woodman",
    scene: {
      title: "On the road",
      text: "I walk beside Dorothy while Oz remains far ahead in the Emerald City.",
      choices: [],
      sceneScope,
    },
    history: [],
    characterProfiles,
    sourceIntroducedCharacters: ["Dorothy", "Oz"],
  };
  const scene: GameState["scene"] = {
    title: "On the road",
    text: state.scene.text,
    sceneScope,
    choices: [{
      id: "ask-oz",
      type: "action",
      text: "Ask Oz for a heart and permission to join the group",
      requiredPresentCharacters: ["Oz"],
    }, {
      id: "ask-dorothy",
      type: "action",
      text: "Ask Dorothy whether Oz could give me a heart",
    }, {
      id: "travel",
      type: "action",
      text: "Continue along the road toward Oz",
    }],
  };

  assert.deepEqual(
    removeChoicesWithUnintroducedCharacters(scene, state).choices.map(
      (choice) => choice.id,
    ),
    ["ask-dorothy", "travel"],
  );
});


test("choices cannot replay a beat from the latest completed source event", () => {
  const scene: GameState["scene"] = {
    title: "Movement restored",
    text: "Dorothy finishes oiling my joints, and I can move freely.",
    choices: [{
      id: "oil-again",
      type: "action",
      text: "Ask Dorothy to oil my legs until I can move them freely",
    }, {
      id: "lower-again",
      type: "action",
      text: "Lower my axe and step in beside Dorothy",
    }, {
      id: "oil-joints-again",
      type: "action",
      text: "Ask Dorothy to oil my joints again before we travel",
    }, {
      id: "thank",
      type: "action",
      text: "Thank Dorothy for oiling my legs",
    }, {
      id: "heart",
      type: "action",
      text: "Ask Dorothy whether Oz could give me a heart",
    }],
  };
  const filtered = removeChoicesRepeatingCompletedSourceEvent(scene, {
    eventId: "movement-restored",
    sequence: 18,
    description: "Dorothy and the Scarecrow restore the Tin Woodman's movement.",
    chapterPosition: 7,
    beats: [{
      actor: "Dorothy",
      action: "Oils the Tin Woodman's legs until he can move freely.",
      targets: ["Tin Woodman"],
      agency: "intentional",
      stakes: "critical",
      sourceReferences: [],
    }, {
      actor: "Tin Woodman",
      action: "Lowers and sets aside his axe after regaining movement.",
      targets: [],
      agency: "intentional",
      stakes: "significant",
      sourceReferences: [],
    }],
  });

  assert.deepEqual(
    filtered.choices.map((choice) => choice.id),
    ["thank", "heart"],
  );
});


test("scene validation rejects writing systems absent from the game context", () => {
  const scene: GameState["scene"] = {
    title: "The current",
    text: "You move through the حول vastness.",
    choices: [{ id: "dive", type: "action", text: "Dive deeper" }],
  };

  assert.equal(
    sceneUsesUnexpectedWritingSystem(scene, "An English story about the Pacific."),
    true,
  );
  assert.equal(
    sceneUsesUnexpectedWritingSystem(scene, "An English-Arabic story using حول."),
    false,
  );
});

test("writing-system reference includes source and established character identities", () => {
  const state = {
    book: { bookId: "book", title: "Test" },
    selectedText: "English source.",
    wholeBookSummary: "English summary.",
    characterProfiles: [{
      name: "حول",
      aliases: [],
      role: "Guide",
      description: "A named guide.",
      traits: [],
      relationships: [],
      storyArc: "Guides the player.",
    }],
    history: [],
  } as unknown as GameState;

  assert.match(buildWritingSystemReference(state), /English source/);
  assert.match(buildWritingSystemReference(state), /حول/);
});

test("game reasoning defaults to minimal and rejects unsupported values", () => {
  assert.equal(configuredReasoningEffort("minimal"), "minimal");
  assert.equal(configuredReasoningEffort("low"), "low");
  assert.throws(() => configuredReasoningEffort("turbo"), /Unsupported/);
});

test("truncated AI JSON is exposed as a retryable typed error", () => {
  assert.deepEqual(
    parseAiJson<{ title: string }>('{"title":"Complete"}', "OpenAI scene"),
    { title: "Complete" },
  );
  assert.throws(
    () => parseAiJson('{"title":"Unterminated', "OpenAI scene"),
    (error) =>
      error instanceof InvalidAiJsonError
      && /incomplete or invalid JSON/i.test(error.message),
  );
});

test("dialogue continuation assigns the utterance and response to different speakers", () => {
  const instruction = buildDialogueContinuationInstruction(
    "Person Alpha",
    "Person Beta",
    "What practical uses do you foresee?",
  );

  assert.match(instruction, /PLAYER: "Person Alpha"/);
  assert.match(instruction, /TARGET CHARACTER: "Person Beta"/);
  assert.match(instruction, /PLAYER'S UTTERANCE: "What practical uses do you foresee\?"/);
  assert.match(instruction, /authoritative latest player intent/i);
  assert.match(instruction, /Begin the new scene with Person Beta's clearly attributed response/);
  assert.match(instruction, /respond substantively now with concrete information/i);
  assert.match(instruction, /Do not describe Person Alpha as answering/);
  assert.match(instruction, /Every new choice must follow from the latest player intent/i);
  assert.match(instruction, /Do not offer choices that simply repeat/i);
});

test("event continuation treats an initiated event as external to the player", () => {
  const instruction = buildEventContinuationInstruction("A lightning strike cuts the power.");

  assert.match(instruction, /WORLD EVENT: "A lightning strike cuts the power\."/);
  assert.match(instruction, /externally initiated world event/i);
  assert.match(instruction, /not as an action, utterance, thought, decision, intent, or knowledge/i);
  assert.match(instruction, /do not silently ignore or postpone it/i);
  assert.match(instruction, /player identity unchanged/i);
  assert.match(instruction, /one major beat of this turn/i);
  assert.match(instruction, /stop at the next player decision point/i);
  assert.match(instruction, /possible later actions only in the prospective choice menu/i);
  assert.match(instruction, /playerAction and actionResult as empty strings/i);
  assert.match(instruction, /actionOutcome as 'none'/i);
});

test("talk suggestions respond to the newest revelation instead of restarting the scene", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      assert.equal(request.text?.format.name, "bookrpg_talk");
      return {
        output_text: JSON.stringify({
          character: "Patrick Maloney",
          prompt: "Mary Maloney, what do you say to Patrick Maloney?",
          suggestions: [
            "You're leaving me while I'm carrying our child?",
            "When exactly do you intend to leave?",
            "No—sit down and explain how you justify this.",
          ],
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_reactive_talk",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A tense domestic drama.",
    },
    objective: "Respond to Patrick's decision.",
    victoryCondition: "Reach a coherent ending.",
    status: "active",
    selectedText: "Patrick tells Mary he is leaving.",
    scene: {
      title: "A clean break",
      text: "Patrick asks Mary to listen. He calmly says he is leaving her, offers financial support, and asks for a clean break.",
      sceneScope: {
        currentLocation: "Mary Maloney's living room",
        peoplePresent: ["Mary Maloney", "Patrick Maloney"],
        peopleWithinSpeakingDistance: ["Mary Maloney", "Patrick Maloney"],
      },
      choices: [{
        id: "talk_patrick",
        type: "talk",
        text: "Talk to Patrick Maloney",
        character: "Patrick Maloney",
      }],
      outcome: "active",
    },
    history: [
      { kind: "scene", text: "Patrick calmly says he is leaving Mary and asks for a clean break." },
      { kind: "choice", text: "Talk to Patrick Maloney" },
    ],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };

  const talk = await new ProviderGameEngine(client, "minimal")
    .startTalk(state, "Patrick Maloney");
  const request = requests[0];
  const input = request?.input ?? "";

  assert.deepEqual(talk.suggestions, [
    "You're leaving me while I'm carrying our child?",
    "When exactly do you intend to leave?",
    "No—sit down and explain how you justify this.",
  ]);
  assert.match(
    request?.instructions ?? "",
    /exact spoken words in first-person singular voice.*PLAYER'S UTTERANCE/i,
  );
  assert.match(
    request?.instructions ?? "",
    /Never describe or instruct what the player should say/i,
  );
  assert.match(
    request?.instructions ?? "",
    /return "Why did you leave\?", not "Ask the target why they left"/i,
  );
  assert.match(
    talkJsonSchema.properties.suggestions.items.description,
    /exact first-person spoken words.*not an instruction or third-person summary/i,
  );
  assert.match(request?.instructions ?? "", /could just as naturally have been spoken before that beat/i);
  assert.match(request?.instructions ?? "", /ask the target to deliver news already revealed/i);
  assert.match(request?.instructions ?? "", /direct emotional or evaluative response/i);
  assert.match(input, /IMMEDIATE TALK CONTEXT \(AUTHORITATIVE; RESPOND TO ITS NEWEST BEAT\)/i);
  assert.match(input, /he is leaving her, offers financial support, and asks for a clean break/i);
  assert.ok(input.lastIndexOf("IMMEDIATE TALK CONTEXT") > input.lastIndexOf("GAME CONTEXT"));
});

test("world event metadata is normalized without spending another scene draft", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            latestInputFailureType: "none",
            latestInputFailureReason: "",
            preservesPlayerAgency: true,
            playerAgencyFailureReason: "",
            staysWithinTurnScope: true,
            turnScopeFailureReason: "",
            requiredEventOccurred: false,
            anchorChoiceIndex: 0,
            reason: "The police arrival occurs externally and stops at Mary's decision point.",
          }),
        };
      }
      assert.equal(request.text?.format.name, "bookrpg_scene");
      return {
        output_text: JSON.stringify({
          title: "Blue lights at the window",
          text: "Blue light washes across the room as a police car stops outside. Two officers step onto the path and knock sharply. Patrick looks toward the door while they wait for someone inside to answer.",
          playerAction: "The police arrive at the house.",
          actionOutcome: "succeeded",
          actionResult: "The police arrive and knock.",
          externalDevelopment: "Police arrive outside and knock at the door.",
          sourceChapterPosition: null,
          sceneScope: {
            currentLocation: "Living room",
            peoplePresent: ["Patrick"],
            peopleWithinSpeakingDistance: ["Patrick"],
          },
          choices: [
            { id: "door", type: "action", text: "Open the door to the officers", character: null, stakes: "significant" },
            { id: "patrick", type: "talk", text: "Talk to Patrick", character: "Patrick", stakes: "routine" },
          ],
          outcome: "active",
          outcomeReason: "The police are waiting outside.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_world_event",
    book: { bookId: "book_world_event", title: "World Event" },
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A tense domestic drama.",
    },
    objective: "Deal with the consequences.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Patrick waits in the living room.",
    scene: {
      title: "Waiting",
      text: "Patrick waits in the living room while Mary listens to the quiet street.",
      choices: [
        { id: "tea", type: "action", text: "Pour another cup of tea" },
        { id: "patrick", type: "talk", text: "Talk to Patrick", character: "Patrick" },
      ],
      sceneScope: {
        currentLocation: "Living room",
        peoplePresent: ["Patrick"],
        peopleWithinSpeakingDistance: ["Patrick"],
      },
      outcome: "active",
    },
    history: [
      { kind: "scene", text: "Patrick waits in the living room while Mary listens to the quiet street." },
      { kind: "event", text: "The police arrive at the house." },
    ],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };

  const scene = await new ProviderGameEngine(client, "minimal")
    .continueEvent(state, "The police arrive at the house.");
  const sceneRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  const reviewRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );
  const choiceReviewRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choice_review",
  );
  assert.equal(sceneRequests.length, 1);
  assert.match(sceneRequests[0]?.input ?? "", /"kind": "world_event"/);
  assert.match(sceneRequests[0]?.instructions ?? "", /WORLD EVENT turn, not a PLAYER ACTION turn/i);
  assert.match(sceneRequests[0]?.instructions ?? "", /playerAction: '', actionResult: '', and actionOutcome: 'none'/i);
  assert.doesNotMatch(reviewRequest?.input ?? "", /"choices":/i);
  assert.match(choiceReviewRequest?.instructions ?? "", /Review only its prospective choices/i);
  assert.match(reviewRequest?.instructions ?? "", /event itself is the turn's single major beat/i);
  assert.match(scene.text, /police car stops outside/i);
  assert.deepEqual(
    scene.choices.map((choice) => choice.id),
    [SOURCE_ANCHOR_CHOICE_ID, "patrick"],
  );
});

test("semantic review reported dead characters are filtered without an extra AI call", async () => {
  const requests: AiResponseRequest[] = [];
  let sceneAttempt = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            latestInputFailureType: "none",
            latestInputFailureReason: "",
            preservesPlayerAgency: true,
            playerAgencyFailureReason: "",
            staysWithinTurnScope: true,
            turnScopeFailureReason: "",
            requiredEventOccurred: false,
            anchorChoiceIndex: 0,
            nonInteractableCharacters: sceneAttempt === 1 ? ["Patrick"] : [],
            nonInteractableCharactersReason: sceneAttempt === 1
              ? "Patrick collapsed and stopped breathing after Mary's blow; the narrative shows a corpse, not a living participant."
              : "",
            reason: "The narrative advances cleanly.",
          }),
        };
      }
      assert.equal(request.text?.format.name, "bookrpg_scene");
      sceneAttempt += 1;
      return {
        output_text: JSON.stringify({
          title: "After the blow",
          text: "Patrick collapses and lies motionless on the floor. Mary steps back, breathing hard.",
          playerAction: "Strike Patrick",
          actionOutcome: "succeeded",
          actionResult: "Mary steps away.",
          externalDevelopment: "",
          sourceChapterPosition: null,
          sceneScope: {
            currentLocation: "Living room",
            peoplePresent: sceneAttempt === 1 ? ["Patrick"] : [],
            peopleWithinSpeakingDistance: sceneAttempt === 1 ? ["Patrick"] : [],
          },
          choices: sceneAttempt === 1
            ? [
                { id: "call", type: "action", text: "Call for help", character: null, stakes: "significant" },
                { id: "patrick", type: "talk", text: "Talk to Patrick", character: "Patrick", stakes: "routine" },
              ]
            : [
                { id: "call", type: "action", text: "Call for help", character: null, stakes: "significant" },
                { id: "leave", type: "action", text: "Leave the room", character: null, stakes: "routine" },
              ],
          outcome: "active",
          outcomeReason: "Mary must decide what to do next.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_ai_dead_character",
    book: { bookId: "book_ai_dead_character", title: "A Severe Story" },
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A tense domestic drama.",
    },
    objective: "Deal with the consequences.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Patrick stands in the living room.",
    scene: {
      title: "Confrontation",
      text: "Patrick stands in the living room facing Mary.",
      choices: [
        { id: "strike", type: "action", text: "Strike Patrick" },
      ],
      sceneScope: {
        currentLocation: "Living room",
        peoplePresent: ["Patrick"],
        peopleWithinSpeakingDistance: ["Patrick"],
      },
      outcome: "active",
    },
    history: [
      { kind: "scene", text: "Patrick stands in the living room facing Mary." },
    ],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };

  const scene = await new ProviderGameEngine(client, "minimal")
    .continue(state, "Strike Patrick");

  assert.equal(sceneAttempt, 2);
  assert.deepEqual(
    new Set(scene.choices.map((choice) => choice.id)),
    new Set([SOURCE_ANCHOR_CHOICE_ID, "leave"]),
  );
  assert.deepEqual(scene.sceneScope?.peoplePresent, ["Mary"]);
  const reviewRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );
  assert.equal(reviewRequests.length, 2);
});

test("loss review performs one AI check and continues an avoidable game", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      return {
        output_text: JSON.stringify({
          avoidable: true,
          reason: "The shots hit the ceiling, so the player can still take cover.",
          continuation: {
            title: "Gunfire Overhead",
            text:
              "Plaster falls as the shots strike the ceiling. You remain alive.\n"
              + "Choices:\n1. Leaked menu\n2. Another leaked choice",
            choices: [
              {
                id: "__bookrpg_free_action__",
                type: "talk",
                text: "Malformed dialogue label",
                character: "Noonan",
              },
              {
                id: "ask_noonan",
                type: "talk",
                text: "Ask Noonan why the detectives fired",
                character: "Noonan",
              },
              { id: "cover", type: "action", text: "Stay behind cover", character: null },
            ],
            development: "Gunfire showers the room with plaster.",
            outcome: "active",
            outcomeReason: "You survived and can still act.",
          },
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_loss_review",
    book: { bookId: "book-loss", title: "Loss Review" },
    playerName: "Mary",
    gameProfile: { category: "drama", endingMode: "win", description: "Survive." },
    objective: "Survive the investigation.",
    victoryCondition: "Leave safely.",
    status: "active",
    selectedText: "The detectives search the room.",
    scene: {
      title: "Search",
      text: "The detectives search the room.",
      choices: [],
    },
    history: [{
      kind: "event",
      text: "The detectives fire their guns into the air.",
    }],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  const loss = {
    title: "Game Over",
    text: "You die.",
    choices: [],
    outcome: "lost" as const,
    outcomeReason: "The event was fatal.",
  };

  const reviewed = await new ProviderGameEngine(client, "minimal").reviewLoss(state, loss);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.text?.format.name, "bookrpg_loss_review");
  assert.match(requests[0]?.instructions ?? "", /exactly one review/i);
  assert.match(
    requests[0]?.instructions ?? "",
    /at most one talk choice per target character/i,
  );
  assert.match(requests[0]?.input ?? "", /detectives fire their guns/i);
  assert.equal(reviewed.outcome, "active");
  assert.equal(reviewed.choices.length, 2);
  assert.deepEqual(
    reviewed.choices.map((choice) => choice.id),
    ["__bookrpg_free_action___generated", "cover"],
  );
  assert.equal(reviewed.text.includes("Leaked menu"), false);
  assert.deepEqual(reviewed.choices[0], {
    id: "__bookrpg_free_action___generated",
    type: "talk",
    text: "Talk to Noonan",
    character: "Noonan",
  });
});

test("loss review clearly explains a confirmed unavoidable loss", async () => {
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse() {
      return {
        output_text: JSON.stringify({
          avoidable: false,
          reason: "The player has already died and no established fact permits survival.",
          continuation: null,
        }),
      };
    },
  };
  const state = {
    gameId: "game_unavoidable_loss",
    book: { bookId: "book-loss", title: "Loss Review" },
    playerName: "Mary",
    gameProfile: { category: "drama" as const, endingMode: "win" as const, description: "Survive." },
    objective: "Survive.",
    victoryCondition: "Leave safely.",
    status: "active" as const,
    selectedText: "The fatal event occurs.",
    scene: { title: "Before", text: "Danger closes in.", choices: [] },
    history: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  const loss = {
    title: "Game Over",
    text: "You are dead.",
    choices: [],
    outcome: "lost" as const,
    outcomeReason: "Fatal injuries.",
  };

  const reviewed = await new ProviderGameEngine(client, "minimal").reviewLoss(state, loss);

  assert.equal(reviewed.outcome, "lost");
  assert.match(reviewed.outcomeReason ?? "", /^Why you lost:/);
  assert.match(reviewed.outcomeReason ?? "", /already died/i);
});

test("action continuation consumes the selected choice and advances past its result", () => {
  const instruction = buildActionContinuationInstruction(
    "Secure and study the cargo, integrating the tools into a cautious ambush plan.",
  );

  assert.match(instruction, /authoritative latest decision/i);
  assert.match(instruction, /every distinct action beat/i);
  assert.match(instruction, /actor, target, and direction/i);
  assert.match(instruction, /already completed fact/i);
  assert.match(instruction, /target's compliance/i);
  assert.match(instruction, /Resolve every remaining attempted beat in the stated order/i);
  assert.match(instruction, /may succeed, partly succeed, fail, or be credibly interrupted/i);
  assert.match(instruction, /low-motion choices as bounded actions/i);
  assert.match(instruction, /Do not end a low-motion choice/i);
  assert.match(instruction, /Advance the world state beyond the decision point/i);
  assert.match(instruction, /do not invent another consequential voluntary player action/i);
  assert.match(instruction, /selected action is consumed/i);
  assert.match(instruction, /Do not offer the same action or a paraphrase/i);
});

test("selecting option one explicitly routes the resolved action toward the source anchor", () => {
  const instruction = buildAnchorRouteContinuationInstruction(
    buildActionContinuationInstruction(
      "Scan the room for any other hidden markings or slips that could reveal a second note",
    ),
    {
      chapterPosition: 4,
      chapterTitle: "Lamb to the Slaughter",
      summary: "The detectives search for the murder weapon.",
      excerpt: "A detective asks Mary whether any large heavy object is missing.",
      requiredEvent: "A detective asks Mary to identify any missing heavy household object.",
      nextTextOffset: 15_800,
    },
  );

  assert.match(instruction, /OPTION 1 ANCHOR ROUTE SELECTED/);
  assert.match(instruction, /Resolve the latest player input fully and use it as the causal bridge/i);
  assert.match(instruction, /SOURCE ANCHOR TO REACH: A detective asks Mary/i);
  assert.match(instruction, /source excerpt is authoritative/i);
  assert.match(instruction, /search, scan, examination, or investigation/i);
  assert.match(instruction, /concrete finding, explicit absence, or specific obstacle/i);
  assert.match(instruction, /waits or prepares for a character or event explicitly established as imminent/i);
  assert.match(instruction, /make choices\[0\] the next immediate route/i);
});

test("an anchor-directed first choice reaches source material and promotes the next anchor route", async () => {
  const action =
    "Scan the room for any other hidden markings or slips that could reveal a second note";
  const requests: AiResponseRequest[] = [];
  let sceneAttempt = 0;
  let presenceAttempt = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        presenceAttempt += 1;
        return scenePresenceReviewResponse(
          request,
          presenceAttempt === 1 ? null : "event_missing_object_question",
        );
      }
      if (request.text?.format.name === "bookrpg_source_event") {
        return {
          output_text: JSON.stringify({
            compatible: true,
            blockIndex: 0,
            eventId: "event_missing_object_question",
            event: "A detective asks Mary whether any large heavy household object is missing.",
            reason: "This is the first new concrete event in the selected source block.",
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_source_anchor_route_review") {
        return {
          output_text: JSON.stringify({
            sourceAnchorRoute: "event",
            reason: "The completed scan directly leads into the detective's question.",
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse(1);
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            requiredEventOccurred: true,
            anchorChoiceIndex: 1,
            reason: "The completed scan leads into the detective's source-backed question.",
          }),
        };
      }
      assert.equal(request.text?.format.name, "bookrpg_scene");
      sceneAttempt += 1;
      return {
        output_text: JSON.stringify({
          title: "The Missing Weight",
          text: sceneAttempt === 1
            ? "You finish a careful sweep of the room without finding another note. The detectives continue their quiet inventory."
            : "You finish a careful sweep of the room without finding another note. As you straighten, one detective closes his notebook and asks whether any large, heavy household object is missing. His question redirects the search from invented papers to the weapon itself, and the officers wait for your answer.",
          choices: [
            {
              id: "note",
              type: "action",
              text: "Inspect the same desk again for another note",
              character: null,
            },
            {
              id: "inventory",
              type: "action",
              text: "Walk through the household's heavy objects with the detectives",
              character: null,
            },
          ],
          outcome: "active",
          outcomeReason: "The investigation has returned to the missing weapon.",
          playerAction: action,
          actionOutcome: "succeeded",
          actionResult: sceneAttempt === 1
            ? "Mary completes the scan and finds no second note."
            : "Mary completes the scan, finds no second note, and hears the detective's question.",
          externalDevelopment: sceneAttempt === 1
            ? "The detectives continue their inventory."
            : "A detective asks Mary to identify any missing heavy household object.",
          sourceChapterPosition: 4,
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_anchor_directed_scan",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic investigation.",
    },
    objective: "Keep calm while the detectives search the house.",
    victoryCondition: "Continue through meaningful milestones.",
    status: "active",
    selectedText: "The detectives search the house for the weapon.",
    sourceCursor: { chapterPosition: 4, textOffset: 14_600 },
    scene: {
      title: "Under pressure",
      text: "Noonan and O'Malley catalog the room while a hidden note rests beneath your shawl.",
      choices: [
        { id: "scan", type: "action", text: action },
        { id: "tea", type: "action", text: "Offer another pot of tea" },
      ],
      outcome: "active",
    },
    history: [
      {
        kind: "scene",
        text: "Noonan and O'Malley catalog the room while a hidden note rests beneath your shawl.",
      },
      { kind: "choice", text: action },
    ],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  const candidate = {
    chapterPosition: 4,
    chapterTitle: "Lamb to the Slaughter",
    summary: "The detectives search the house and ask Mary what could be missing.",
    excerpt:
      "One detective asks Mary whether anything in the house is missing, such as a very big spanner or a heavy metal vase.",
    storyEvents: [
      {
        eventId: "event_detectives_enter",
        sequence: 10,
        description: "The detectives enter Mary's living room.",
        chapterPosition: 4,
      },
      {
        eventId: "event_missing_object_question",
        sequence: 11,
        description: "A detective asks Mary which heavy household object is missing.",
        actors: ["Detective"],
        chapterPosition: 4,
      },
    ],
    nextTextOffset: 15_800,
  };

  const scene = await new ProviderGameEngine(client, "minimal").continue(
    state,
    action,
    [candidate],
    {
      anchorDirected: true,
      sourceEventId: "event_missing_object_question",
      sourceAnchorRoute: "event",
    },
  );
  const eventRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_source_event",
  );
  const sceneRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  const sceneRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  const reviewRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );
  const reviewRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );
  const presenceRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene_presence_review",
  );
  const completedEventChoiceReviewRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choice_review",
  );

  assert.ok(eventRequest);
  assert.match(
    eventRequest.instructions ?? "",
    /directly supported by the selected source block/i,
  );
  assert.doesNotMatch(
    eventRequest.input ?? "",
    /detectives enter Mary's living room/i,
  );
  assert.match(
    eventRequest.input ?? "",
    /event_missing_object_question/,
  );
  assert.match(sceneRequest?.input ?? "", /OPTION 1 ANCHOR ROUTE SELECTED/);
  assert.match(
    sceneRequest?.instructions ?? "",
    /selected source-continuation route requires progress[\s\S]*only the next ordered beat is mandatory now/i,
  );
  assert.match(
    sceneRequest?.instructions ?? "",
    /Required beat to complete now: the next required source beat/i,
  );
  assert.match(
    sceneRequest?.instructions ?? "",
    /only the next ordered beat is mandatory now/i,
  );
  assert.doesNotMatch(
    sceneRequest?.instructions ?? "",
    /next_significant_event is a possible source development, not an obligation/i,
  );
  assert.match(
    sceneRequest?.input ?? "",
    /One detective asks Mary whether anything in the house is missing/i,
  );
  assert.match(
    sceneRequest?.input ?? "",
    /SOURCE ANCHOR TO REACH: A detective asks Mary which heavy household object is missing/i,
  );
  assert.match(reviewRequest?.input ?? "", /UPCOMING SOURCE ANCHOR MATERIAL/);
  assert.match(
    completedEventChoiceReviewRequest?.input ?? "",
    /CURRENT SIGNIFICANT EVENT:[\s\S]*?"eventId": "event_missing_object_question"[\s\S]*?UPCOMING SOURCE ANCHOR MATERIAL:/,
  );
assert.equal(reviewRequests.length, 1);
assert.equal(presenceRequests.length, 1);
for (const index of [0]) {
  assert.ok(
    requests.indexOf(reviewRequests[index]!) < requests.indexOf(presenceRequests[index]!),
    "repetition review must run before presence review",
  );
}
assert.deepEqual(
  scene.choices.map((choice) => choice.id),
  [SOURCE_ANCHOR_CHOICE_ID, "note"],
);
assert.equal(sceneAttempt, 1);
  
assert.equal(scene.sourceProgress, undefined);
});

test("source events are mandatory only after semantic causal route confirmation", async () => {
  const transitionAction =
    "Step forward beside Dorothy and call out a greeting to the A-Team";
  const requiredEventId = "event_scarecrow_falls";
  const requiredEvent =
    "The Scarecrow repeatedly falls on the rough road, and Dorothy lifts him back up.";
  const requiredEventBeats: StoryEventBeat[] = [{
    actor: "Scarecrow",
    action: "Stumbles and falls repeatedly on the rough road.",
    targets: [],
    agency: "involuntary",
    stakes: "significant",
    sourceReferences: [{
      chapterPosition: 6,
      chapterIndex: 6,
      lineStart: 1,
      lineEnd: 1,
    }],
  }, {
    actor: "Dorothy",
    action: "Lifts the Scarecrow upright after each fall.",
    targets: ["Scarecrow"],
    agency: "intentional",
    stakes: "routine",
    sourceReferences: [{
      chapterPosition: 6,
      chapterIndex: 6,
      lineStart: 1,
      lineEnd: 1,
    }],
  }];
  const state: GameState = {
    gameId: "game_reviewed_player_anchor",
    book: { bookId: "book_oz", title: "The Wonderful Wizard of Oz" },
    playerName: "Scarecrow",
    characterProfiles: [
      {
        name: "Scarecrow",
        aliases: ["the Scarecrow"],
        role: "Dorothy's companion",
        description: "",
        traits: [],
        relationships: [],
        storyArc: "",
      },
      {
        name: "Dorothy",
        aliases: [],
        role: "Traveler",
        description: "",
        traits: [],
        relationships: [],
        storyArc: "",
      },
    ],
    gameProfile: {
      category: "adventure",
      endingMode: "open_ended",
      description: "A journey through Oz.",
    },
    objective: "Reach the Emerald City.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "The companions prepare to follow the road.",
    sourceCursor: {
      chapterPosition: 6,
      textOffset: 4_000,
      eventId: "event_companions_depart",
    },
    scene: {
      title: "New allies",
      text: "I stand beside Dorothy while the A-Team considers my greeting.",
      sceneScope: {
        currentLocation: "Road beside the cornfield",
        peoplePresent: ["Dorothy"],
        peopleWithinSpeakingDistance: ["Dorothy"],
      },
      choices: [],
      outcome: "active",
    },
    history: [{
      kind: "scene",
      text: "I stand beside Dorothy while the A-Team considers my greeting.",
    }],
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
  const candidate = {
    chapterPosition: 6,
    chapterTitle: "The Road Through the Forest",
    summary: requiredEvent,
    excerpt: "The rough stones trip the Scarecrow, and Dorothy helps him upright.",
    requiredEvent,
    requiredEventId,
    requiredEventCategory: "other" as const,
    requiredEventActors: ["Scarecrow", "Dorothy"],
    requiredEventTargets: ["Dorothy", "Scarecrow"],
    requiredEventBeats,
    currentStoryEvent: {
      eventId: "event_companions_depart",
      sequence: 28,
      description: "The companions set out along the road.",
      chapterPosition: 6,
    },
    storyEvents: [{
      eventId: requiredEventId,
      sequence: 29,
      description: requiredEvent,
      category: "other" as const,
      chapterPosition: 6,
      actors: ["Scarecrow", "Dorothy"],
      targets: ["Dorothy", "Scarecrow"],
      beats: requiredEventBeats,
    }],
    nextTextOffset: 4_600,
  };

  for (const reviewedRoute of ["transition", "event"] as const) {
    const selectedAction = reviewedRoute === "event"
      ? "Continue along the rough road beside Dorothy despite the risk of falling"
      : transitionAction;
    const requests: AiResponseRequest[] = [];
    let routeReviewAttempt = 0;
    let choiceReviewAttempt = 0;
    let sceneAttempt = 0;
    const client: AiClient = {
      provider: "openai",
      model: "test-model",
      async createResponse(request) {
        requests.push(request);
        if (request.text?.format.name === "bookrpg_source_anchor_route_review") {
          routeReviewAttempt += 1;
          if (reviewedRoute === "transition" && routeReviewAttempt === 1) {
            return {
              output_text: "",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            };
          }
          return {
            output_text: JSON.stringify({
              sourceAnchorRoute: reviewedRoute,
              reason: reviewedRoute === "event"
                ? "The selected wording authorizes continuing onto the rough road."
                : "Greeting the A-Team does not authorize the later fall.",
            }),
          };
        }
        if (request.text?.format.name === "bookrpg_scene_presence_review") {
          return scenePresenceReviewResponse(
            request,
            reviewedRoute === "event" && sceneAttempt === 2
              ? requiredEventId
              : null,
          );
        }
        if (request.text?.format.name === "bookrpg_scene_choice_review") {
          choiceReviewAttempt += 1;
          if (reviewedRoute === "transition" && choiceReviewAttempt < 3) {
            return {
              output_text: "",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            };
          }
          return validSceneChoiceReviewResponse();
        }
        if (request.text?.format.name === "bookrpg_scene_repetition_review") {
          return validSceneRepetitionReviewResponse(
            reviewedRoute === "event" && sceneAttempt === 2,
          );
        }
        assert.equal(request.text?.format.name, "bookrpg_scene");
        sceneAttempt += 1;
        const depictsRequiredEvent = reviewedRoute === "event" && sceneAttempt === 2;
        return {
          output_text: JSON.stringify({
            title: depictsRequiredEvent ? "A rough stretch" : "The greeting answered",
            text: depictsRequiredEvent
              ? "I continue along the rough road beside Dorothy. My foot catches on the stones, and I tumble onto the road. Dorothy takes my arm and lifts me upright before we continue."
              : "I step beside Dorothy and greet the A-Team. Their leader returns a cautious nod and asks what help we need, leaving the road ahead for later.",
            playerAction: selectedAction,
            actionOutcome: "succeeded",
            actionResult: depictsRequiredEvent
              ? "The greeting is delivered before the Scarecrow falls and Dorothy helps him."
              : "The Scarecrow greets the A-Team and receives a cautious response.",
            externalDevelopment: depictsRequiredEvent
              ? "The Scarecrow falls on the rough road and Dorothy lifts him."
              : "The A-Team responds cautiously to the greeting.",
            sourceChapterPosition: depictsRequiredEvent ? 6 : null,
            sceneScope: {
              currentLocation: "Road beside the cornfield",
              peoplePresent: ["Dorothy"],
              peopleWithinSpeakingDistance: ["Dorothy"],
            },
            choices: [
              {
                id: "stitching",
                type: "action",
                text: "Check the stitching around my knee",
                character: null,
              },
              {
                id: "ask",
                type: "action",
                text: "Ask Dorothy whether the road improves ahead",
                character: null,
              },
            ],
            outcome: "active",
            outcomeReason: "The journey remains active.",
          }),
        };
      },
    };

    const scene = await new ProviderGameEngine(client, "minimal").continue(
      state,
      selectedAction,
      [candidate],
      {
        anchorDirected: true,
        sourceEventId: requiredEventId,
        sourceAnchorRoute: reviewedRoute === "event" ? "event" : undefined,
      },
    );
    const routeReviewRequests = requests.filter(
      (request) =>
        request.text?.format.name === "bookrpg_source_anchor_route_review",
    );
    const routeReview = routeReviewRequests[0];
    const sceneRequests = requests.filter(
      (request) => request.text?.format.name === "bookrpg_scene",
    );
    const choiceReviewRequests = requests.filter(
      (request) => request.text?.format.name === "bookrpg_scene_choice_review",
    );
    const presenceReviewRequests = requests.filter(
      (request) => request.text?.format.name === "bookrpg_scene_presence_review",
    );

    assert.match(
      routeReview?.input ?? "",
      reviewedRoute === "event" ? /risk of falling/ : /greeting to the A-Team/,
    );
    assert.match(routeReview?.input ?? "", /Scarecrow repeatedly falls/);
    const routeReviewInput = JSON.parse(routeReview?.input ?? "{}") as {
      requires_explicit_player_choice?: boolean;
      next_significant_event?: {
        beats?: StoryEventBeat[];
        currentlyAbsentCharacters?: string[];
      };
      source_excerpt?: string | null;
    };
    assert.equal(routeReviewInput.requires_explicit_player_choice, false);
    assert.equal(
      routeReviewInput.next_significant_event?.beats?.[0]?.agency,
      "involuntary",
    );
    assert.deepEqual(
      routeReviewInput.next_significant_event?.currentlyAbsentCharacters,
      [],
    );
    assert.match(routeReviewInput.source_excerpt ?? "", /rough stones trip the Scarecrow/i);
    assert.match(
      routeReview?.instructions ?? "",
      /Faithful paraphrases and equivalent wording count/i,
    );
    assert.match(
      routeReview?.instructions ?? "",
      /player_identity is physically present.*belongs in both peoplePresent/i,
    );
    assert.match(
      routeReview?.instructions ?? "",
      /Only when required_player_choice_beats is empty/i,
    );
    assert.match(
      routeReview?.instructions ?? "",
      /main player action is deferred until after an unmet prerequisite/i,
    );
    assert.deepEqual(
      routeReviewRequests.map((request) => request.max_output_tokens),
      reviewedRoute === "transition" ? [1_600, 3_200] : [1_600],
    );
    assert.deepEqual(
      choiceReviewRequests.map((request) => request.max_output_tokens),
      reviewedRoute === "transition" ? [800, 1_600, 3_200] : [800],
    );
    assert.equal(sceneRequests.length, reviewedRoute === "event" ? 2 : 1);
    if (reviewedRoute === "event") {
      const presenceInput = JSON.parse(
        presenceReviewRequests.at(-1)?.input ?? "{}",
      ) as {
        current_source_event?: { eventId?: string } | null;
        event_review_target?: {
          eventId?: string;
          beats?: Array<{ action?: string }>;
        } | null;
      };
      assert.equal(
        presenceInput.current_source_event?.eventId,
        "event_companions_depart",
      );
      assert.equal(presenceInput.event_review_target?.eventId, requiredEventId);
      assert.deepEqual(
        presenceInput.event_review_target?.beats?.map((beat) => beat.action),
        [
          "Stumbles and falls repeatedly on the rough road.",
          "Lifts the Scarecrow upright after each fall.",
        ],
      );
      assert.match(
        presenceReviewRequests.at(-1)?.instructions ?? "",
        /review only that exact event/i,
      );
      assert.match(
        sceneRequests[0]?.instructions ?? "",
        /selected source-continuation route requires progress[\s\S]*only the next ordered beat is mandatory now/i,
      );
      assert.equal(scene.sourceProgress?.eventId, requiredEventId);
    } else {
      assert.doesNotMatch(
        sceneRequests[0]?.instructions ?? "",
        /selected source-continuation route requires progress[\s\S]*only the next ordered beat is mandatory now/i,
      );
      assert.equal(scene.title, "The greeting answered");
      assert.equal(scene.sourceProgress, undefined);
    }
  }
});

test("scene continuation paints one new beat without choosing for the player", () => {
  const instruction = buildSceneContinuationInstruction();

  assert.match(instruction, /selected no menu option/i);
  assert.match(instruction, /authoritative present moment, not as material to replay/i);
  assert.match(instruction, /vivid, concrete picture/i);
  assert.match(instruction, /setting, character and object positions, physical conditions, mood/i);
  assert.match(instruction, /incrementally by one cohesive observable beat/i);
  assert.match(instruction, /do not merely redescribe the current tableau/i);
  assert.match(instruction, /next_significant_event.*try to incorporate/i);
  assert.match(instruction, /next source event is optional during scene_continuation/i);
  assert.match(instruction, /Only a separately selected source event anchor.*mandatory/i);
  assert.match(instruction, /activity already in motion or clearly pending/i);
  assert.match(instruction, /ongoing player activity that needs no new decision/i);
  assert.match(instruction, /immediate_transition\.latest_input\.unselected_options/i);
  assert.match(instruction, /Do not invent a consequential new voluntary action, utterance, decision/i);
  assert.match(instruction, /carry forward an already established continuous player action/i);
  assert.match(instruction, /consequence of continued inaction/i);
  assert.match(instruction, /not a PLAYER ACTION/i);
});

test("source recovery retries require a concrete forward event without dropping the action", () => {
  const action = "Set the table and invite Patrick to sit.";
  const instruction = buildRequiredSourceRecoveryInstruction(
    buildActionContinuationInstruction(action),
    {
      chapterPosition: 4,
      chapterTitle: "Lamb to the Slaughter",
      summary: "Patrick makes an announcement that changes the evening.",
      excerpt: "Patrick drains his glass and tells Mary his decision.",
      nextTextOffset: 7_500,
      recovery: true,
    },
  );

  assert.match(instruction, new RegExp(`PLAYER ACTION: ${JSON.stringify(action)}`));
  assert.match(instruction, /normal cursor route did not provide a reliable concrete next event/i);
  assert.match(instruction, /earliest compatible concrete event/i);
  assert.match(instruction, /must create a new observable state/i);
  assert.match(instruction, /require a new player-controlled decision.*do not enact it/i);
  assert.match(instruction, /Set sourceChapterPosition to 4 only after actually adapting/i);
  assert.match(instruction, /otherwise keep it null/i);
});



test("the immediate turn transition binds the previous scene to the selected option", () => {
  const transition = buildImmediateTurnTransition({
    scene: {
      title: "Home Front",
      text: "Patrick settles opposite Mary while she pours his drink.",
      choices: [],
    },
    history: [
      {
        kind: "scene",
        text: "Patrick settles opposite Mary while she pours his drink.",
      },
      {
        kind: "choice",
        text: "Ask Patrick for a concrete date for his planned change",
      },
    ],
  });

  assert.deepEqual(transition, {
    previous_scene: {
      title: "Home Front",
      text: "Patrick settles opposite Mary while she pours his drink.",
    },
    latest_input: {
      kind: "selected_option",
      text: "Ask Patrick for a concrete date for his planned change",
    },
  });
});

test("the immediate turn transition marks rejected menu alternatives as unrealized", () => {
  const transition = buildImmediateTurnTransition({
    scene: {
      title: "Maps and weather",
      text: "The navigator reaches for the chart while the compass rests nearby.",
      choices: [
        { id: "lamb", type: "action", text: "Take up the compass and check the heading" },
        { id: "stay", type: "action", text: "Keep still while the navigator marks the chart" },
        { id: "bottle", type: "action", text: "Take the pencil from the navigator's hand" },
      ],
    },
    history: [
      { kind: "choice", text: "Keep still while the navigator marks the chart" },
    ],
  });

  assert.deepEqual(transition?.latest_input, {
    kind: "selected_option",
    text: "Keep still while the navigator marks the chart",
    unselected_options: [
      "Take up the compass and check the heading",
      "Take the pencil from the navigator's hand",
    ],
  });
});

test("the immediate turn transition leaves every menu option unrealized for scene continuation", () => {
  const transition = buildImmediateTurnTransition({
    scene: {
      title: "The unfinished confession",
      text: "Patrick's unfinished news hangs behind the visitors' ongoing commotion.",
      choices: [
        { id: "supper", type: "action", text: "Go start supper" },
        { id: "stop", type: "action", text: "Order the visitors to stop" },
      ],
    },
    history: [{
      kind: "continuation",
      text: "Narrate the next moment as the scene progresses without choosing a player action.",
    }],
  });

  assert.deepEqual(transition?.latest_input, {
    kind: "scene_continuation",
    text: "Narrate the next moment as the scene progresses without choosing a player action.",
    unselected_options: [
      "Go start supper",
      "Order the visitors to stop",
    ],
  });
});

test("provider scene continuation paints the next beat from current state and settings", async () => {
  const requests: AiResponseRequest[] = [];
  let sceneDraftCount = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            requiredEventOccurred: false,
            anchorChoiceIndex: 0,
            reason: "The ongoing exchange reaches a concrete new consequence.",
          }),
        };
      }
      sceneDraftCount += 1;
      const followsPriorGeneratedScene = sceneDraftCount >= 3;
      return {
        output_text: JSON.stringify({
          title: followsPriorGeneratedScene ? "Patrick leans forward" : "The room falls quiet",
          text: followsPriorGeneratedScene
            ? "Patrick leans into the lamplight and tests his freed hand against the chair arm. The departing visitors' footsteps fade beyond the front door. He fixes his attention on Mary, draws a careful breath, and begins the first words of the news that the argument interrupted."
            : "The visitors finish their argument in a rush of accusations. One backs toward the door while the other gathers the scattered papers. Patrick watches until the last interruption ends, then draws breath to finish what he began.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: sceneDraftCount === 1
            ? ""
            : followsPriorGeneratedScene
              ? "The visitors leave and Patrick starts delivering his interrupted news."
              : "The visitors finish their argument and prepare to leave.",
          sourceChapterPosition: null,
          choices: [
            { id: "listen", type: "action", text: "Let Patrick finish speaking", character: null },
            { id: "papers", type: "action", text: "Examine the scattered papers", character: null },
          ],
          outcome: "active",
          outcomeReason: "Patrick's unfinished news still matters.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_scene_continuation",
    book: { bookId: "book_scene_continuation", title: "Scene Continuation" },
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Learn what Patrick was trying to say.",
    victoryCondition: "Reach meaningful milestones without a fixed ending.",
    status: "active",
    selectedText: "Patrick begins to speak.",
    parameters: ["Keep the household in the established lamplit room."],
    scene: {
      title: "An interruption",
      text: "Patrick's confession stalls while two visitors argue across the room.",
      choices: [
        { id: "supper", type: "action", text: "Go start supper" },
        { id: "stop", type: "action", text: "Order the visitors to stop" },
      ],
      outcome: "active",
    },
    history: [
      {
        kind: "scene",
        text: "Patrick's confession stalls while two visitors argue across the room.",
      },
      {
        kind: "continuation",
        text: "Narrate the next moment as the scene progresses without choosing a player action.",
      },
    ],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };

  const engine = new ProviderGameEngine(client, "minimal");
  const scene = await engine.continueScene(state);
  state.scene = scene;
  state.history.push(
    { kind: "scene", text: scene.text, development: scene.development },
    {
      kind: "continuation",
      text: "Narrate the next moment as the scene progresses without choosing a player action.",
    },
  );
  const followingScene = await engine.continueScene(state);
  const sceneRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  const sceneRequest = sceneRequests[0];
  const staticSceneRetry = sceneRequests[1];
  const followingSceneRequest = sceneRequests[2];
  const reviewRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );

  assert.equal(scene.title, "The room falls quiet");
  assert.equal(followingScene.title, "Patrick leans forward");
  assert.equal(sceneRequests.length, 3);
  assert.match(sceneRequest?.input ?? "", /OBSERVED SCENE PROGRESSION/);
  assert.match(sceneRequest?.input ?? "", /"kind": "scene_continuation"/);
  assert.match(sceneRequest?.input ?? "", /"unselected_options"/);
  assert.match(
    sceneRequest?.input ?? "",
    /Patrick's confession stalls while two visitors argue across the room/,
  );
  assert.match(
    sceneRequest?.input ?? "",
    /Keep the household in the established lamplit room/,
  );
  assert.match(sceneRequest?.instructions ?? "", /between 90 and 180 words/i);
  assert.match(sceneRequest?.instructions ?? "", /paint the next observable beat/i);
  assert.match(sceneRequest?.instructions ?? "", /Treat its setting, positions, props/i);
  assert.doesNotMatch(sceneRequest?.instructions ?? "", /between 65 and 120 words/i);
  assert.equal(sceneRequest?.max_output_tokens, 2_200);
  assert.match(
    staticSceneRetry?.input ?? "",
    /Observed scene progression requires a concrete non-player or environmental development/i,
  );
  assert.match(
    followingSceneRequest?.input ?? "",
    /The visitors finish their argument in a rush of accusations/,
  );
  assert.match(
    followingSceneRequest?.input ?? "",
    /Keep the household in the established lamplit room/,
  );
  assert.match(reviewRequest?.instructions ?? "", /one cohesive non-player or world beat/i);
  assert.match(reviewRequest?.instructions ?? "", /races the active sequence to its final resolution/i);
});

test("scene continuation tries an unfinished source event without requiring it", async () => {
  const requests: AiResponseRequest[] = [];
  const requiredEventId = "event_dorothy_and_toto_sleep";
  const requiredEvent =
    "After the house is carried for hours, Dorothy and Toto fall asleep inside it.";
  let depictSourceEvent = true;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(
          request,
          depictSourceEvent ? requiredEventId : null,
        );
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return validSceneRepetitionReviewResponse(depictSourceEvent);
      }
      return {
        output_text: JSON.stringify({
          title: depictSourceEvent ? "Sleep in the storm" : "A sharper jolt",
          text: depictSourceEvent
            ? "Hours of wind and swaying timber wear the room into a dim rhythm. Dorothy settles beside Toto, her hand resting near his paws. His eyes close as her breathing steadies, and before long they are both asleep while the house continues through the dark."
            : "The farmhouse drops through a pocket of air, and a cupboard door swings open. Tin cups tumble across the floor while Dorothy braces against the wall and keeps watch beside Toto.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: depictSourceEvent
            ? "Dorothy and Toto fall asleep as the house continues moving."
            : "A sudden drop sends tin cups across the farmhouse floor.",
          sourceChapterPosition: depictSourceEvent ? 3 : null,
          sceneScope: {
            currentLocation: "Kansas farmhouse room",
            peoplePresent: ["Dorothy"],
            peopleWithinSpeakingDistance: ["Dorothy"],
          },
          choices: [
            {
              id: "wake",
              type: "action",
              text: "Wake when the movement changes",
              character: null,
            },
            {
              id: "listen",
              type: "action",
              text: "Listen through the floorboards",
              character: null,
            },
          ],
          outcome: "active",
          outcomeReason: "The journey through the storm continues.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_passive_required_event",
    book: { bookId: "book_oz", title: "The Wonderful Wizard of Oz" },
    playerName: "Toto",
    characterProfiles: [
      {
        name: "Toto",
        aliases: [],
        role: "Dorothy's dog",
        description: "",
        traits: [],
        relationships: [],
        storyArc: "",
      },
      {
        name: "Dorothy",
        aliases: [],
        role: "Toto's companion",
        description: "",
        traits: [],
        relationships: [],
        storyArc: "",
      },
    ],
    gameProfile: {
      category: "adventure",
      endingMode: "open_ended",
      description: "A journey through Oz.",
    },
    objective: "Stay with Dorothy.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Dorothy pulls Toto back from the trapdoor.",
    sourceCursor: {
      chapterPosition: 3,
      textOffset: 5_380,
      eventId: "event_trapdoor",
    },
    scene: {
      title: "Inside the farmhouse",
      text: "Dorothy closes the trapdoor while the house continues to sway.",
      sceneScope: {
        currentLocation: "Kansas farmhouse room",
        peoplePresent: ["Dorothy"],
        peopleWithinSpeakingDistance: ["Dorothy"],
      },
      choices: [],
      outcome: "active",
    },
    history: [
      {
        kind: "scene",
        text: "Dorothy closes the trapdoor while the house continues to sway.",
      },
      {
        kind: "continuation",
        text: "Narrate the next moment as the scene progresses without choosing a player action.",
      },
    ],
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
  const candidate = {
    chapterPosition: 3,
    chapterTitle: "The Cyclone",
    summary: requiredEvent,
    excerpt: "Hour after hour passed, and at last Dorothy and Toto fell asleep.",
    requiredEvent,
    requiredEventId,
    requiredEventCategory: "other" as const,
    requiredEventActors: ["Dorothy"],
    requiredEventTargets: ["Toto"],
    currentStoryEvent: {
      eventId: "event_trapdoor",
      sequence: 4,
      description: "Dorothy pulls Toto back from the trapdoor.",
      chapterPosition: 3,
    },
    storyEvents: [{
      eventId: requiredEventId,
      sequence: 5,
      description: requiredEvent,
      category: "other" as const,
      chapterPosition: 3,
      actors: ["Dorothy"],
      targets: ["Toto"],
    }],
    nextTextOffset: 5_900,
  };

  const scene = await new ProviderGameEngine(client, "minimal").continueScene(
    state,
    [candidate],
  );
  depictSourceEvent = false;
  const localScene = await new ProviderGameEngine(client, "minimal").continueScene(
    state,
    [candidate],
  );
  const sceneRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  const sceneRequest = sceneRequests[0];

  assert.match(sceneRequest?.input ?? "", /OBSERVED SCENE PROGRESSION/);
  assert.match(sceneRequest?.input ?? "", /next_significant_event.*try to incorporate/i);
  assert.match(sceneRequest?.input ?? "", /next source event is optional/i);
  assert.match(
    sceneRequest?.instructions ?? "",
    /possible source development, not an obligation/,
  );
  assert.doesNotMatch(
    sceneRequest?.instructions ?? "",
    /selected anchor choice directly reaches.*SOURCE ANCHOR TO REACH/,
  );
  assert.equal(sceneRequests.length, 2);
  assert.equal(scene.sourceProgress?.eventId, requiredEventId);
  assert.equal(localScene.title, "A sharper jolt");
  assert.equal(localScene.sourceProgress, undefined);
});

test("scene continuation preserves a safe final beat after progression heuristics exhaust", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: true,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            requiredEventOccurred: false,
            anchorChoiceIndex: 0,
            reason: "The detectives continue cataloging evidence in the same room.",
          }),
        };
      }
      return {
        output_text: JSON.stringify({
          title: "Under pressure",
          text: "Noonan shifts the receipts into a precise stack while O'Malley marks another line in the inventory. Patrick remains at the window. The detectives exchange a restrained nod and resume cataloging the room, their attention settling on the desk.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: "",
          sourceChapterPosition: null,
          choices: [
            {
              id: "receipts",
              type: "action",
              text: "Compare the newly ordered receipts with the inventory",
              character: null,
            },
            {
              id: "omalley",
              type: "talk",
              text: "Talk to O'Malley",
              character: "O'Malley",
            },
          ],
          outcome: "active",
          outcomeReason: "The investigation remains active.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_scene_continuation_fallback",
    book: { bookId: "book_scene_continuation_fallback", title: "Scene Continuation" },
    playerName: "Mary",
    gameProfile: {
      category: "mystery",
      endingMode: "win",
      description: "An investigation under pressure.",
    },
    objective: "Avoid implication in Patrick's death.",
    victoryCondition: "The investigation ends without implicating Mary.",
    status: "active",
    selectedText: "The detectives catalog the room.",
    scene: {
      title: "Under pressure",
      text: "Noonan and O'Malley quietly catalog the evidence while Patrick stands by the window.",
      choices: [
        { id: "wait", type: "action", text: "Remain still and watch the detectives" },
        { id: "desk", type: "action", text: "Study the papers on the desk" },
      ],
      outcome: "active",
    },
    history: [
      {
        kind: "scene",
        text: "Noonan and O'Malley quietly catalog the evidence while Patrick stands by the window.",
      },
      {
        kind: "continuation",
        text: "Narrate the next moment as the scene progresses without choosing a player action.",
      },
    ],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };

  const scene = await new ProviderGameEngine(client, "minimal").continueScene(state);
  const sceneRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  const reviewRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );

  assert.equal(sceneRequests.length, 4);
  assert.equal(reviewRequests.length, 1);
  assert.match(sceneRequests[1]?.input ?? "", /REGENERATION REQUIRED/);
  assert.match(
    sceneRequests[1]?.input ?? "",
    /Observed scene progression requires a concrete non-player or environmental development/i,
  );
  assert.equal(scene.title, "Under pressure");
  assert.match(scene.text, /marks another line in the inventory/i);
  assert.deepEqual(
    scene.choices.map((choice) => choice.id),
    [SOURCE_ANCHOR_CHOICE_ID, "omalley"],
  );
});

test("scene continuation rejects a final draft that stalls the latest input", async () => {
  let sceneDraftCount = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: false,
            preservesPlayerPerspective: true,
            latestInputFailureType: "stalled",
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            latestInputFailureReason: "The latest continuation beat remains unresolved.",
            playerAgencyFailureReason: "",
            turnScopeFailureReason: "",
            requiredEventOccurred: false,
            anchorChoiceIndex: 0,
            reason: "The prose changes details without resolving the authoritative beat.",
          }),
        };
      }
      sceneDraftCount += 1;
      return {
        output_text: JSON.stringify({
          title: "Still waiting",
          text:
            `Patrick shifts the papers into a new stack ${sceneDraftCount}, then watches the clock. `
            + "The interrupted question still hangs unanswered between him and Mary.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: `Patrick rearranges the papers for the ${sceneDraftCount} time.`,
          sourceChapterPosition: null,
          choices: [
            { id: "ask", type: "action", text: "Ask Patrick to answer now", character: null },
            { id: "door", type: "action", text: "Move toward the door", character: null },
          ],
          outcome: "active",
          outcomeReason: "The question remains unresolved.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_rejected_stalled_scene",
    book: { bookId: "book_stalled_scene", title: "Stalled Scene" },
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Receive Patrick's answer.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Mary waits for Patrick to answer.",
    scene: {
      title: "The question",
      text: "Mary has asked Patrick a direct question. He draws breath to answer.",
      choices: [],
      outcome: "active",
    },
    history: [{
      kind: "continuation",
      text: "Narrate the next moment as the scene progresses without choosing a player action.",
    }],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };

  await assert.rejects(
    new ProviderGameEngine(client, "minimal").continueScene(state),
    (error: unknown) => {
      assert.ok(error instanceof SceneGenerationError);
      assert.equal(error.attempts, 4);
      assert.match(error.validationFailures.join(" "), /did not faithfully resolve/i);
      assert.match(error.validationFailures.join(" "), /remains unresolved/i);
      return true;
    },
  );
  assert.equal(sceneDraftCount, 4);
});

test("action resolution requires an exact action echo and explicit outcome", () => {
  const action = "Throw the visitor overboard and threaten her companion.";
  assert.deepEqual(
    actionResolutionFailures(
      action,
      "succeeded",
      "The visitor falls into the sea; her companion hears the threat.",
      action,
    ),
    [],
  );
  assert.match(
    actionResolutionFailures(
      "Question the visitors instead.",
      "succeeded",
      "Ahab questions them.",
      action,
    )[0] ?? "",
    /exactly preserve/i,
  );
  assert.match(
    actionResolutionFailures(action, "none", "Ahab waits.", action).join(" "),
    /cannot use actionOutcome 'none'/i,
  );
});

test("invalid action metadata and prose leaks are rejected before AI reviews", async () => {
  const action = "Wait and listen for Patrick's next words";
  const requests: AiResponseRequest[] = [];
  let sceneAttempt = 0;
  let choiceReviewAttempt = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        choiceReviewAttempt += 1;
        return validSceneChoiceReviewResponse(
          null,
          choiceReviewAttempt === 1 ? [1] : [],
          choiceReviewAttempt === 1
            ? "Choice 2 prepares for Patrick to arrive even though he is already present."
            : "",
        );
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            requiredEventOccurred: false,
            reason: "Patrick answers while Mary listens.",
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_choices") {
        return {
          output_text: JSON.stringify({
            choices: [
              {
                id: "window",
                type: "action",
                text: "Step to the window to consider Patrick's explanation",
                character: null,
                requiredPresentCharacters: [],
                requiredAbsentCharacters: [],
                stakes: "routine",
              },
              {
                id: "talk",
                type: "talk",
                text: "Talk to Patrick",
                character: "Patrick",
                requiredPresentCharacters: ["Patrick"],
                requiredAbsentCharacters: [],
                stakes: "significant",
              },
            ],
          }),
        };
      }
      assert.equal(request.text?.format.name, "bookrpg_scene");
      sceneAttempt += 1;
      return {
        output_text: JSON.stringify({
          title: "Patrick continues",
          text: sceneAttempt === 1
            ? "You wait while Patrick gathers his thoughts."
            : sceneAttempt === 2
              ? "External Development: Patrick begins explaining his departure."
              : "You wait, and Patrick explains the practical terms of his departure.",
          playerAction: action,
          actionOutcome: sceneAttempt === 1 ? "none" : "succeeded",
          actionResult: sceneAttempt === 1
            ? ""
            : "Patrick explains the practical terms while Mary listens.",
          externalDevelopment: "Patrick continues speaking.",
          sourceChapterPosition: null,
          sceneScope: {
            currentLocation: "The living room",
            peoplePresent: ["Patrick"],
            peopleWithinSpeakingDistance: ["Patrick"],
          },
          choices: [
            { id: "ask", type: "action", text: "Ask Patrick why he decided this" },
            {
              id: "prepare",
              type: "action",
              text: "Prepare the doorway for Patrick's arrival",
            },
          ],
          outcome: "active",
          outcomeReason: "Mary must decide how to respond.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_early_action_validation",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Respond to Patrick.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Patrick has begun speaking.",
    scene: {
      title: "The announcement",
      text: "Patrick says he has something important to explain.",
      choices: [{ id: "listen", type: "action", text: action }],
      sceneScope: {
        currentLocation: "The living room",
        peoplePresent: ["Patrick"],
        peopleWithinSpeakingDistance: ["Patrick"],
      },
      outcome: "active",
    },
    history: [
      { kind: "scene", text: "Patrick says he has something important to explain." },
      { kind: "choice", text: action },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };

  const scene = await new ProviderGameEngine(client, "minimal").continue(state, action);

  assert.equal(sceneAttempt, 3);
  assert.deepEqual(
    requests.slice(0, 3).map((request) => request.text?.format.name),
    ["bookrpg_scene", "bookrpg_scene", "bookrpg_scene"],
  );
  assert.equal(
    requests.filter(
      (request) => request.text?.format.name === "bookrpg_scene_presence_review",
    ).length,
    1,
  );
  const choiceRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choices",
  );
  assert.ok(choiceRequest);
  assert.equal(choiceReviewAttempt, 2);
  assert.match(choiceRequest.input ?? "", /Ask Patrick why he decided this/);
  assert.match(choiceRequest.input ?? "", /Prepare the doorway for Patrick's arrival/);
  assert.doesNotMatch(
    JSON.stringify(scene.choices),
    /Prepare the doorway for Patrick's arrival/,
  );
  assert.match(scene.text, /Patrick explains the practical terms/i);
});

test("scene regeneration overproduces choices so a repeated action can be filtered", () => {
  const instruction = buildSceneRegenerationInstruction(
    "Resolve the player's latest action.",
    "Observe Mary's routine.",
    ["Only 1 distinct usable choice remained; at least 2 are required."],
    ["Observe Mary's routine.", "Watch Mary's routine."],
  );

  assert.match(instruction, /Resolve "Observe Mary's routine\."/);
  assert.match(instruction, /instead of leaving it as the next decision/i);
  assert.match(instruction, /Choices are generated separately after the scene is approved/i);
  assert.match(instruction, /must be visibly resolved before the new decision point/i);
  assert.match(instruction, /Do not embed a choice menu/i);
  assert.match(instruction, /REJECTED BECAUSE/);
  assert.match(instruction, /Only 1 distinct usable choice/);
  assert.match(instruction, /DO NOT END AT A DECISION POINT THAT ONLY SUPPORTS THESE REJECTED CHOICES/);
  assert.match(instruction, /Watch Mary's routine/);
});

test("scene choices regenerate options that treat the player as a separate character", async () => {
  const malformedChoice =
    "Help Dorothy steady the Scarecrow when he stumbles, keeping him on his feet";
  let choiceAttempt = 0;
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      assert.equal(request.text?.format.name, "bookrpg_scene_choices");
      choiceAttempt += 1;
      return {
        output_text: JSON.stringify({
          choices: choiceAttempt === 1
            ? [
                {
                  id: "wrong_perspective",
                  type: "action",
                  text: malformedChoice,
                  character: "Scarecrow",
                  requiredPresentCharacters: ["Dorothy"],
                  requiredAbsentCharacters: [],
                  sourceAnchorRoute: "event",
                  stakes: "significant",
                },
                {
                  id: "scout",
                  type: "action",
                  text: "Offer to scout the road ahead for hazards",
                  character: null,
                  requiredPresentCharacters: ["Dorothy"],
                  requiredAbsentCharacters: [],
                  sourceAnchorRoute: null,
                  stakes: "significant",
                },
                {
                  id: "ask",
                  type: "action",
                  text: "Ask Dorothy what she hopes to find in the Emerald City",
                  character: "Dorothy",
                  requiredPresentCharacters: ["Dorothy"],
                  requiredAbsentCharacters: [],
                  sourceAnchorRoute: null,
                  stakes: "routine",
                },
              ]
            : [
                {
                  id: "keep_balance",
                  type: "action",
                  text: "Regain your balance and keep walking beside Dorothy",
                  character: null,
                  requiredPresentCharacters: ["Dorothy"],
                  requiredAbsentCharacters: [],
                  sourceAnchorRoute: "event",
                  stakes: "significant",
                },
                {
                  id: "check_stitching",
                  type: "action",
                  text: "Check the stitching around your knees",
                  character: null,
                  requiredPresentCharacters: [],
                  requiredAbsentCharacters: [],
                  sourceAnchorRoute: null,
                  stakes: "routine",
                },
              ],
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_scarecrow_choice_perspective",
    book: { bookId: "book_oz", title: "The Wonderful Wizard of Oz" },
    playerName: "Scarecrow",
    characterProfiles: [
      {
        name: "Scarecrow",
        aliases: ["the Scarecrow"],
        role: "Dorothy's traveling companion",
        description: "A living figure made of straw.",
        traits: [],
        relationships: [],
        storyArc: "He seeks brains.",
      },
      {
        name: "Dorothy",
        aliases: [],
        role: "Traveler",
        description: "A girl traveling toward the Emerald City.",
        traits: [],
        relationships: [],
        storyArc: "She seeks a way home.",
      },
    ],
    gameProfile: {
      category: "open_ended",
      endingMode: "open_ended",
      description: "A journey through Oz.",
    },
    objective: "Travel toward the Emerald City.",
    victoryCondition: "Reach meaningful story milestones.",
    status: "active",
    selectedText: "Dorothy and the Scarecrow begin walking together.",
    scene: {
      title: "Open Field, New Partnership",
      text: "I walk beside Dorothy while the cornfield rustles behind us.",
      sceneScope: {
        currentLocation: "Beside the cornfield",
        peoplePresent: ["Dorothy"],
        peopleWithinSpeakingDistance: ["Dorothy"],
      },
      choices: [],
      outcome: "active",
    },
    history: [{ kind: "start", text: "The Wonderful Wizard of Oz" }],
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
  const candidate = {
    chapterPosition: 5,
    chapterTitle: "Chapter III",
    summary: "Dorothy and the Scarecrow travel toward the Emerald City.",
    excerpt: "The Scarecrow sometimes stumbled, and Dorothy helped him stay upright.",
    requiredEvent: "The Scarecrow stumbles while walking beside Dorothy.",
    requiredEventId: "event_scarecrow_stumbles",
    storyEvents: [{
      eventId: "event_scarecrow_stumbles",
      sequence: 2,
      description: "The Scarecrow stumbles while walking beside Dorothy.",
      category: "other" as const,
      chapterPosition: 5,
      actors: ["Scarecrow"],
      targets: [],
    }],
    nextTextOffset: 1_200,
  };

  const scene = await new ProviderGameEngine(client, "minimal")
    .refreshSceneChoices(state, [candidate]);
  const retryInput = JSON.parse(requests[1]?.input ?? "{}") as {
    rejected_choices?: Array<{text: string; role: string; reason: string}>;
  };

  assert.equal(requests.length, 2);
  assert.match(
    requests[0]?.instructions ?? "",
    /player_identity as its implicit actor/i,
  );
  assert.match(
    requests[0]?.input ?? "",
    /"player_identity_aliases":[\s\S]*"the Scarecrow"/,
  );
  assert.equal(retryInput.rejected_choices?.some(choice => choice.text === malformedChoice), true);
  assert.equal(retryInput.rejected_choices?.[0]?.role, "anchor");
  assert.match(retryInput.rejected_choices?.[0]?.reason ?? "", /player identity/);
  assert.equal(scene.choices[0]?.id, SOURCE_ANCHOR_CHOICE_ID);
  assert.equal(scene.choices[0]?.text, "Regain your balance and keep walking beside Dorothy");
  assert.equal(
    scene.choices.some((choice) =>
      choice.character === "Scarecrow" || choice.text === malformedChoice
    ),
    false,
  );
});

test("scene choices receive the next significant event to formulate option one", async (t) => {
  const action = "Continue the ledger verification as if nothing unusual happened";
  const loggedErrors: string[] = [];
  t.mock.method(console, "error", (...values: unknown[]) => {
    loggedErrors.push(values.map(String).join(" "));
  });
  const responses = [{
      title: "The ledger",
      text: [
        "You keep your attention fixed on the rows of figures.",
        "",
        "What do you do next?",
        "",
        "1) Inspect the next column.",
        "2) Call Sam for help.",
      ].join("\n"),
      outcome: "active",
      outcomeReason: "The work continues.",
      playerAction: action,
      actionOutcome: "succeeded",
      actionResult: "You verify the next column without acknowledging the seal.",
      externalDevelopment: "",
      sourceChapterPosition: null,
  }];
  let truncateFirstScene = true;
  let truncateFirstChoice = true;
  let choiceAttempt = 0;
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse(1);
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            requiredEventOccurred: false,
            anchorChoiceIndex: 0,
            reason: "Walking to the shop entrance is the strongest immediate route toward the next event.",
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_choices") {
        if (truncateFirstChoice) {
          truncateFirstChoice = false;
          return {
            output_text: '{"choices":[',
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          };
        }
        choiceAttempt += 1;
        return {
          output_text: JSON.stringify({
            choices: choiceAttempt === 1
              ? [
                  { id: "repeat", type: "action", text: action, character: null, stakes: "routine" },
                  { id: "entrance", type: "action", text: "Walk to the shop entrance", character: null, stakes: "significant" },
                  { id: "window", type: "action", text: "Listen for movement outside", character: null, stakes: "routine" },
                ]
              : [
                  { id: "entrance", type: "action", text: "Walk to the shop entrance", character: null, stakes: "significant" },
                  { id: "window", type: "action", text: "Listen for movement outside", character: null, stakes: "routine" },
                  { id: "sam", type: "talk", text: "Talk to Sam", character: "Sam", stakes: "significant" },
                ],
          }),
        };
      }
      if (truncateFirstScene) {
        truncateFirstScene = false;
        return {
          output_text: '{"title":"The ledger',
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        };
      }
      const output = responses.shift();
      assert.ok(output, "Unexpected extra scene generation attempt");
      return { output_text: JSON.stringify(output) };
    },
  };
  const engine = new ProviderGameEngine(client, "minimal");
  const state: GameState = {
    gameId: "game_anchor_retry",
    book: { bookId: "book_anchor_retry", title: "Anchor Retry" },
    playerName: "Mary",
    characterProfiles: [{
      name: "Sam",
      aliases: [],
      role: "Grocer",
      description: "The neighborhood grocer.",
      traits: [],
      relationships: [],
      storyArc: "Mary visits him later.",
    }],
    gameProfile: {
      category: "drama",
      endingMode: "completion",
      description: "A domestic drama.",
    },
    objective: "Understand the pressure surrounding the household.",
    victoryCondition: "Reach the story's natural resolution.",
    status: "active",
    selectedText: "Mary checks the ledger while Patrick sits nearby.",
    sourceCursor: { chapterPosition: 0, textOffset: 48 },
    scene: {
      title: "The sealed envelope",
      text: "You conceal the sealed envelope and refocus on the ledger. Patrick waits beside you.",
      choices: [{ id: "ledger", type: "action", text: action }],
      outcome: "active",
    },
    history: [
      { kind: "start", text: "Mary checks the ledger while Patrick sits nearby." },
      { kind: "choice", text: action },
    ],
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  };
  const candidate = {
    chapterPosition: 0,
    chapterTitle: "The Shop",
    summary: "A visitor arrives and changes the household's routine.",
    chapterSummary: "Mary quietly verifies the household accounts.",
    currentStoryEvent: {
      eventId: "event_ledger_opened",
      sequence: 1,
      description: "Mary opens the household ledger.",
      chapterPosition: 0,
    },
    excerpt: "A customer knocks at the shop door and Patrick rises to answer.",
    requiredEvent:
      "A customer knocks at the shop door, changing the household routine.",
    storyEvents: [{
      eventId: "event_customer_arrives",
      sequence: 2,
      description:
        "A customer knocks at the shop door (interrupting the ledger work), changing the household routine.",
      chapterPosition: 0,
    }],
    nextTextOffset: 110,
  };

  const scene = await engine.continue(state, action, [candidate]);
  const sceneRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  const reviewRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );
  const choiceReviewRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene_choice_review",
  );
  const choiceRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene_choices",
  );

  assert.equal(sceneRequests.length, 2);
  assert.deepEqual(
    sceneRequests.map((request) => request.max_output_tokens),
    [1_600, 3_200],
  );
  assert.equal(reviewRequests.length, 1);
  assert.equal(choiceReviewRequests.length, 1);
  assert.equal(choiceRequests.length, 3);
  assert.ok(
    requests.indexOf(reviewRequests[0]!) < requests.indexOf(choiceRequests[0]!),
    "repetition review must run before choice generation",
  );
  assert.ok(
    requests.indexOf(choiceRequests.at(-1)!) < requests.indexOf(choiceReviewRequests[0]!),
    "choice review must run after the generated menu is complete",
  );
  assert.equal(
    requests
      .slice(requests.indexOf(choiceReviewRequests[0]!) + 1)
      .some((request) => request.text?.format.name === "bookrpg_scene_choices"),
    false,
    "an accepted choice menu must not be regenerated",
  );
  assert.deepEqual(
    choiceRequests.map((request) => request.reasoning?.effort),
    ["minimal", "minimal", "minimal"],
  );
  assert.deepEqual(
    choiceRequests.map((request) => request.max_output_tokens),
    [1_600, 3_200, 4_800],
  );
  const repairedChoiceInput = JSON.parse(
    choiceRequests[2]?.input ?? "{}",
  ) as {
    accepted_choices?: Array<{ text: string }>;
    rejected_choices?: Array<{text: string; role: string; reason: string}>;
  };
  assert.deepEqual(
    repairedChoiceInput.accepted_choices?.map((choice) => choice.text),
    ["Walk to the shop entrance", "Listen for movement outside"],
  );
  assert.equal(
    repairedChoiceInput.rejected_choices?.some(choice => choice.text === action),
    true,
  );
  assert.equal(
    repairedChoiceInput.rejected_choices?.some(choice => choice.text === "Walk to the shop entrance"),
    false,
  );
  assert.equal(
    loggedErrors.some((message) =>
      /model-generated choices\[0\] candidate .* could not serve as the anchor because it repeats the consumed player action/i
        .test(message)
    ),
    true,
  );
  assert.equal(
    loggedErrors.some((message) => /the anchor-directed first choice/i.test(message)),
    false,
  );
  assert.match(
    choiceRequests[0]?.instructions ?? "",
    /If a character is visibly present in setting, never offer waiting for that character to arrive or return/,
  );
  assert.match(
    choiceRequests[0]?.instructions ?? "",
    /Calling out for an absent character or listening, watching, or searching for possible footsteps/,
  );
  assert.match(
    choiceRequests[0]?.instructions ?? "",
    /main voluntary act can begin only after an unmet prerequisite/i,
  );
  assert.match(
    choiceRequests[0]?.instructions ?? "",
    /latest source event already completed.*Every listed beat is complete/i,
  );
  assert.match(
    choiceRequests[0]?.instructions ?? "",
    /direct base-form selectable verb/i,
  );
  assert.match(
    choiceReviewRequests[0]?.instructions ?? "",
    /REQUIRED PLAYER CHOICE BEATS lists only the immediately eligible player-controlled decision/i,
  );
  assert.match(
    choiceReviewRequests[0]?.input ?? "",
    /REQUIRED PLAYER CHOICE BEATS:/,
  );
  assert.match(choiceRequests[0]?.instructions ?? "", /Classify every choice by its likely consequences/);
  assert.equal(scene.choices[0]?.id, SOURCE_ANCHOR_CHOICE_ID);
  assert.equal(scene.choices[0]?.sourceEventId, "event_customer_arrives");
  assert.equal(scene.choices[0]?.stakes, "routine");
  assert.match(
    choiceRequests[0]?.input ?? "",
    /"current_significant_event":[\s\S]*"eventId": "event_ledger_opened"/,
  );
  assert.match(
    choiceRequests[0]?.input ?? "",
    /"next_significant_event":[\s\S]*"eventId": "event_customer_arrives"/,
  );
  assert.match(
    choiceRequests[0]?.instructions ?? "",
    /hidden navigation target for choice 1/i,
  );
  assert.doesNotMatch(choiceRequests[0]?.input ?? "", /upcoming_story_events/);
  assert.doesNotMatch(choiceRequests[0]?.input ?? "", /chapter_summary/);
  assert.match(
    choiceReviewRequests[0]?.instructions ?? "",
    /choice index whose wording contradicts candidate_scene's confirmed end state/,
  );
  assert.match(
    reviewRequests[0]?.instructions ?? "",
    /optional upcoming REQUIRED NEXT EVENT.*evaluating source progress/i,
  );
  assert.match(
    reviewRequests[0]?.instructions ?? "",
    /For an ordinary turn, the REQUIRED NEXT EVENT may remain future/i,
  );
  assert.match(
    reviewRequests[0]?.instructions ?? "",
    /development describes state already realized.*never a queue of future beats/i,
  );
  assert.doesNotMatch(
    reviewRequests[0]?.instructions ?? "",
    /The draft uses REQUIRED NEXT EVENT as its source direction/i,
  );
  assert.match(
    reviewRequests[0]?.input ?? "",
    /CURRENT SIGNIFICANT EVENT:[\s\S]*event_ledger_opened/,
  );
  assert.doesNotMatch(sceneRequests[0]?.input ?? "", /STAGNATION BREAK REQUIRED/);
  assert.match(
    sceneRequests[0]?.instructions ?? "",
    /Once this scene establishes that a character is present or has arrived/,
  );
  assert.doesNotMatch(sceneRequests[1]?.input ?? "", /STAGNATION BREAK REQUIRED/);
  assert.match(sceneRequests[1]?.input ?? "", /current_significant_event/i);
  assert.match(sceneRequests[1]?.input ?? "", /Mary opens the household ledger/i);
  assert.match(sceneRequests[1]?.input ?? "", /next_significant_event/i);
  assert.match(sceneRequests[1]?.input ?? "", /A customer knocks at the shop door/i);
  assert.match(choiceRequests[0]?.input ?? "", /rows of figures/);
  assert.doesNotMatch(choiceRequests[0]?.input ?? "", /What do you do next|Call Sam/i);
  assert.doesNotMatch(
    choiceRequests[0]?.input ?? "",
    /Mary quietly verifies the household accounts/i,
  );
  assert.match(choiceRequests[0]?.input ?? "", /customer knocks at the shop door/i);
  assert.equal(responses.length, 0);
  assert.equal(scene.title, "The ledger");
  assert.equal(
    scene.text,
    "You keep your attention fixed on the rows of figures.",
  );
  assert.deepEqual(scene.choices, [
    {
      id: SOURCE_ANCHOR_CHOICE_ID,
      type: "action",
      text: "Listen for movement outside",
      sourceEventId: "event_customer_arrives",
      sourceAnchorRoute: "transition",
      stakes: "routine",
    },
    {
      id: `${SOURCE_ANCHOR_CHOICE_ID}_generated`,
      type: "action",
      text: "Walk to the shop entrance",
      stakes: "significant",
    },
  ]);
  assert.equal(scene.sourceProgress, undefined);
});

test("scene generation exhaustion reports the final validation failure", async () => {
  const action = "Make a difficult accusation";
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return validSceneRepetitionReviewResponse();
      }
      return {
        output_text: JSON.stringify({
          title: "No viable continuation",
          text: "The room remains tense after the accusation.",
          choices: [{ id: "wait", type: "action", text: "Wait in silence" }],
          outcome: "active",
          outcomeReason: "The confrontation remains unresolved.",
          playerAction: action,
          actionOutcome: "succeeded",
          actionResult: "The accusation is heard.",
          externalDevelopment: "",
          sourceChapterPosition: null,
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_generation_failure",
    book: { bookId: "book_generation_failure", title: "Generation Failure" },
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A tense investigation.",
    },
    objective: "Navigate the investigation.",
    victoryCondition: "There is no fixed ending.",
    status: "active",
    selectedText: "The detectives wait for Mary's answer.",
    scene: {
      title: "The question",
      text: "The detectives wait for Mary's answer.",
      choices: [{ id: "accuse", type: "action", text: action }],
      outcome: "active",
    },
    history: [
      { kind: "start", text: "The detectives begin their inquiry." },
      { kind: "choice", text: action },
    ],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };

  await assert.rejects(
    new ProviderGameEngine(client, "minimal").continue(state, action),
    (error: unknown) => {
      assert.ok(error instanceof SceneGenerationError);
      assert.equal(error.attempts, 4);
      assert.deepEqual(error.validationFailures, [
        "Only 1 distinct usable choice(s) remained; at least 2 are required.",
      ]);
      assert.match(error.message, /could not continue from that input after 4 generation attempts/i);
      assert.match(error.message, /Last rejection: Only 1 distinct usable choice/);
      assert.match(error.message, /turn was not saved/i);
      assert.doesNotMatch(error.message, /^OpenAI /);
      return true;
    },
  );
});

test("anchor choice recovery without forward material uses established source pressure", () => {
  const instruction = buildAnchorChoiceInstruction("Resolve the latest action.");

  assert.match(instruction, /ANCHOR CHOICE REQUIRED/);
  assert.match(instruction, /unresolved source-backed conflict, relationship, location, or pressure/i);
  assert.match(instruction, /do not reveal later events in the choice/i);
  assert.doesNotMatch(instruction, /whole_book_summary/i);
  assert.match(instruction, /Keep the choice voluntary/i);
});

test("option one is reserved for the anchor-directed route", () => {
  const rules = FIRST_CHOICE_ANCHOR_RULES.join("\n");
  const timelineRules = CHOICE_TIMELINE_RULES.join("\n");
  assert.match(rules, /prefer choices\[0\].*upcoming source development/i);
  assert.match(rules, /Do not force every local decision back/i);
  assert.match(rules, /application can add a separate Continue story option/i);
  assert.match(rules, /executable attempt, not as a promise/i);
  assert.match(rules, /avoid placing a repetitive or stalling option first/i);
  assert.match(timelineRules, /Every choice must have a plausible immediate consequence/i);
  assert.match(timelineRules, /Waiting or observing is valid only when.*visibly progress/i);
  assert.match(
    timelineRules,
    /main voluntary act can begin only after an unmet prerequisite/i,
  );

  const original = [
    { id: "anchor", type: "action" as const, text: "Follow the source-backed lead" },
    { id: "local", type: "action" as const, text: "Remain with the ledger" },
  ];
  assert.equal(firstChoiceWasFiltered(original, original, "active"), false);
  assert.equal(firstChoiceWasFiltered(original, original.slice(1), "active"), true);
  assert.equal(firstChoiceWasFiltered(original, [], "completed"), false);
});

test("semantic anchor selection promotes the strongest route to option one", () => {
  const scene = {
    title: "The search",
    text: "The detectives continue searching the sitting room.",
    choices: [
      { id: "local", type: "action" as const, text: "Inspect another invented note" },
      {
        id: "weapon",
        type: "action" as const,
        text: "Offer to identify any heavy household object that may be missing",
      },
      { id: "tea", type: "action" as const, text: "Make more tea" },
    ],
    outcome: "active" as const,
  };

  const promoted = promoteAnchorChoice(scene, 1, "event_missing_object");

  assert.deepEqual(
    promoted.choices.map((choice) => choice.id),
    [SOURCE_ANCHOR_CHOICE_ID, "local", "tea"],
  );
  assert.equal(promoted.choices[0]?.sourceEventId, "event_missing_object");
  assert.equal(promoted.choices[0]?.sourceAnchorRoute, "transition");
  assert.deepEqual(scene.choices.map((choice) => choice.id), ["local", "weapon", "tea"]);
  assert.deepEqual(
    promoteAnchorChoice({
      ...scene,
      choices: [{
        ...scene.choices[0]!,
        sourceAnchorRoute: "event",
      }],
    }, 0).choices[0],
    {
      ...scene.choices[0],
      id: SOURCE_ANCHOR_CHOICE_ID,
      sourceAnchorRoute: "event",
    },
  );
  const repromoted = promoteAnchorChoice(
    promoteAnchorChoice(scene, 0, "old-event"),
    1,
    "new-event",
  );
  assert.deepEqual(repromoted.choices, [
    {
      ...scene.choices[1],
      id: SOURCE_ANCHOR_CHOICE_ID,
      sourceEventId: "new-event",
      sourceAnchorRoute: "transition",
    },
    {
      ...scene.choices[0],
      id: `${SOURCE_ANCHOR_CHOICE_ID}_generated`,
    },
    scene.choices[2],
  ]);
  assert.equal(promoteAnchorChoice(scene, 9), scene);
});

test("a scene without a usable anchor route receives continue story as option one", () => {
  const scene = {
    title: "After the reveal",
    text: "Patrick waits beside the cold fireplace.",
    choices: [
      { id: "glass", type: "action" as const, text: "Study Patrick's empty glass" },
      { id: "window", type: "action" as const, text: "Look through the window" },
      { id: "chair", type: "action" as const, text: "Remain beside the chair" },
      { id: "clock", type: "action" as const, text: "Check the clock" },
    ],
    outcome: "active" as const,
  };

  const repaired = addSourceContinuationAnchorChoice(scene);

  assert.deepEqual(repaired.choices, [
    {
      id: SOURCE_CONTINUATION_CHOICE_ID,
      type: "action",
      text: SOURCE_CONTINUATION_CHOICE_TEXT,
      stakes: "significant",
    },
    ...scene.choices.slice(0, 3),
  ]);
});

test("missing anchor handling ignores invalid scenes and completed source events", () => {
  const validPendingScene = {
    hasValidationFailures: false,
    activeScene: true,
    anchorChoiceIndex: null,
    finalAttempt: false,
    sourceEventOccurred: false,
  };

  assert.equal(shouldHandleMissingAnchorChoice(validPendingScene), true);
  assert.equal(shouldHandleMissingAnchorChoice({
    ...validPendingScene,
    anchorChoiceIndex: 0,
  }), false);
  assert.equal(shouldHandleMissingAnchorChoice({
    ...validPendingScene,
    hasValidationFailures: true,
  }), false);
  assert.equal(shouldHandleMissingAnchorChoice({
    ...validPendingScene,
    sourceEventOccurred: true,
  }), false);
});

test("a stale event anchor repairs the menu without requiring unavailable source progress", async () => {
  const action = "Ask Patrick to explain what happens next";
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse(null);
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            latestInputFailureReason: "",
            playerAgencyFailureReason: "",
            turnScopeFailureReason: "",
            requiredEventOccurred: false,
            anchorChoiceIndex: null,
            reason: "The turn is valid, but neither local option reaches the next anchor.",
          }),
        };
      }
      return {
        output_text: JSON.stringify({
          title: "Terms stated",
          text: "Patrick names the monthly allowance and waits for Mary's response.",
          choices: [
            { id: "glass", type: "action", text: "Study Patrick's empty glass" },
            { id: "window", type: "action", text: "Look through the window" },
          ],
          outcome: "active",
          outcomeReason: "Mary must decide how to respond.",
          playerAction: action,
          actionOutcome: "succeeded",
          actionResult: "Patrick explains the financial terms.",
          externalDevelopment: "Patrick names the monthly allowance.",
          sourceChapterPosition: null,
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_anchor_menu_repair",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Navigate Patrick's announcement.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Patrick makes his announcement.",
    scene: {
      title: "The announcement",
      text: "Patrick says he intends to leave Mary.",
      choices: [
        { id: "ask", type: "action", text: action },
        { id: "wait", type: "action", text: "Wait for more details" },
      ],
      outcome: "active",
    },
    history: [
      { kind: "scene", text: "Patrick says he intends to leave Mary." },
      { kind: "choice", text: action },
    ],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };

  const scene = await new ProviderGameEngine(client, "minimal").continue(
    state,
    action,
    [],
    {
      anchorDirected: true,
      sourceEventId: "stale_source_event",
      sourceAnchorRoute: "event",
    },
  );

  assert.equal(
    requests.filter((request) => request.text?.format.name === "bookrpg_scene").length,
    1,
  );
  assert.equal(
    requests.filter(
      (request) => request.text?.format.name === "bookrpg_source_anchor_route_review",
    ).length,
    0,
  );
  const sceneRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  const sceneInput = typeof sceneRequest?.input === "string"
    ? sceneRequest.input
    : JSON.stringify(sceneRequest?.input ?? "");
  assert.match(
    sceneInput,
    /No compatible forward source excerpt was found/i,
  );
  assert.doesNotMatch(
    sceneInput,
    /must identify the adapted sourceChapterPosition/i,
  );
  assert.equal(scene.choices[0]?.id, SOURCE_CONTINUATION_CHOICE_ID);
  assert.equal(scene.choices[0]?.text, SOURCE_CONTINUATION_CHOICE_TEXT);
  assert.equal(scene.sourceProgress, undefined);
});

test("runtime parameters override canonical characterization and newest conflicts win", () => {
  const rules = RUNTIME_PARAMETER_RULES.join("\n");

  assert.match(rules, /persistent, user-authored overrides/i);
  assert.match(rules, /newest \(last\) world rule wins/i);
  assert.match(
    rules,
    /authoritative over character_profiles, source characterizations/i,
  );
  assert.match(rules, /act, speak, choose, and react according to these world rules/i);
  assert.match(rules, /not itself a player action or a completed scene event/i);
});

test("game context sanitizes and does not duplicate a legacy current scene", () => {
  const currentScene: GameState["scene"] = {
    title: "After the warning shot",
    text: [
      "The report fades and the crew watches you warily.",
      "",
      "Choices:",
      "1) Lower the weapon.",
      "2) Address the crew.",
    ].join("\n"),
    choices: [
      { id: "stand_down", type: "action", text: "Lower the weapon" },
      { id: "speak", type: "action", text: "Address the crew" },
    ],
  };
  const state: GameState = {
    gameId: "game-id",
    book: { bookId: "book-id", title: "Test Book" },
    playerName: "Deckhand",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "Navigate conflict aboard ship.",
    },
    objective: "Keep your place among the crew.",
    victoryCondition: "There is no fixed ending; survive meaningful confrontations.",
    status: "active",
    selectedText: "Selected passage.",
    scene: currentScene,
    history: [
      { kind: "choice", text: "Fire a warning shot" },
      { kind: "scene", text: currentScene.text },
      { kind: "choice", text: "Shout an order, then confront a sailor" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const context = JSON.parse(buildGameContext(state)) as {
    current_scene: GameState["scene"];
    history: GameState["history"];
  };

  assert.equal(context.current_scene.text, "The report fades and the crew watches you warily.");
  assert.deepEqual(context.history, [
    { kind: "choice", text: "Fire a warning shot" },
    { kind: "choice", text: "Shout an order, then confront a sailor" },
  ]);
});

test("game context includes bounded upcoming source excerpts without chapter-wide spoilers", () => {
  const state: GameState = {
    gameId: "game-source-context",
    book: { bookId: "book-id", title: "Test Book" },
    playerName: "Reader",
    gameProfile: {
      category: "adventure",
      endingMode: "completion",
      description: "Follow the journey.",
    },
    objective: "Reach the destination.",
    victoryCondition: "Complete the journey.",
    status: "active",
    selectedText: "The journey begins.",
    sourceCursor: { chapterPosition: 1, textOffset: 900 },
    scene: { title: "Beginning", text: "The road opens ahead.", choices: [] },
    history: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const context = JSON.parse(buildGameContext(state, [{
    chapterPosition: 2,
    chapterTitle: "The Crossing",
    summary: "A storm blocks the road.",
    requiredEvent: "The storm blocks the crossing.",
    requiredEventId: "event_storm",
    excerpt: `A storm arrives. ${"x".repeat(2_000)}`,
    nextTextOffset: 2_100,
  }])) as {
    upcoming_source_material: Array<{
      chapterPosition: number;
      chapterTitle: string;
      startsNewChapter: boolean;
      summary?: string;
      chapterSummary?: string;
      requiredEventId?: string;
      excerpt: string;
    }>;
    source_cursor: GameState["sourceCursor"];
  };

  assert.deepEqual(context.source_cursor, { chapterPosition: 1, textOffset: 900 });
  assert.equal(context.upcoming_source_material[0]?.chapterPosition, 2);
  assert.equal(context.upcoming_source_material[0]?.chapterTitle, "The Crossing");
  assert.equal(context.upcoming_source_material[0]?.startsNewChapter, true);
  assert.equal(context.upcoming_source_material[0]?.summary, "A storm blocks the road.");
  assert.equal(context.upcoming_source_material[0]?.requiredEventId, "event_storm");
  assert.equal(
    context.upcoming_source_material[0]?.chapterSummary,
    "A storm blocks the road.",
  );
  assert.equal(context.upcoming_source_material[0]?.excerpt.length, 1_500);

  const recoveryContext = JSON.parse(buildGameContext(state, [{
    chapterPosition: 2,
    chapterTitle: "The Crossing",
    summary: "A storm blocks the road.",
    excerpt: "A storm arrives.",
    nextTextOffset: 16,
    recovery: true,
  }])) as {
    upcoming_source_material: Array<{ summary?: string; chapterSummary?: string }>;
  };
  assert.equal(
    recoveryContext.upcoming_source_material[0]?.summary,
    "A storm blocks the road.",
  );
  assert.equal(
    recoveryContext.upcoming_source_material[0]?.chapterSummary,
    "A storm blocks the road.",
  );
});

test("game context grounds the next required beat with its exact source text", () => {
  const nextBeat: StoryEventBeat = {
    actor: "Patrick",
    action: "warns Mary about the road",
    targets: ["Mary"],
    agency: "intentional",
    stakes: "significant",
    sourceReferences: [
      {
        chapterPosition: 0,
        chapterIndex: 4,
        lineStart: 2,
        lineEnd: 2,
      },
      {
        chapterPosition: 0,
        chapterIndex: 4,
        lineStart: 4,
        lineEnd: 5,
      },
    ],
  };
  const state: GameState = {
    gameId: "game-beat-source-context",
    book: { bookId: "book-id", title: "Test Book" },
    playerName: "Mary",
    gameProfile: {
      category: "adventure",
      endingMode: "completion",
      description: "Follow the road.",
    },
    objective: "Reach the destination.",
    victoryCondition: "Complete the journey.",
    status: "active",
    selectedText: "Mary waits.",
    sourceEventProgress: {
      eventId: "event_warning",
      completedBeatIndexes: [],
    },
    scene: { title: "At the crossroads", text: "Mary waits.", choices: [] },
    history: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const context = JSON.parse(buildGameContext(state, [{
    chapterPosition: 0,
    chapterTitle: "The Road",
    summary: "Patrick warns Mary.",
    excerpt: "Patrick approaches.",
    nextTextOffset: 19,
    requiredEvent: "Patrick warns Mary.",
    requiredEventId: "event_warning",
    requiredEventBeats: [nextBeat],
    storyEvents: [{
      eventId: "event_warning",
      sequence: 2,
      description: "Patrick warns Mary.",
      chapterPosition: 0,
      beats: [nextBeat],
    }],
    sourceReferenceExcerpts: {
      "0:4:2:2": "The northern road is flooded.",
      "0:4:4:5": "Take the bridge instead.\nIt is still passable.",
    },
  }])) as {
    next_significant_event_progress: {
      next_required_beat: StoryEventBeat & {
        sourceReferencesExcerpt: string;
      };
    };
  };

  assert.deepEqual(
    context.next_significant_event_progress.next_required_beat,
    {
      ...nextBeat,
      sourceReferencesExcerpt:
        "The northern road is flooded.\n\n"
        + "Take the bridge instead.\nIt is still passable.",
    },
  );
});

test("source grounding is limited to supplied chapters and introduces chapter events in-story", () => {
  const sourceRules = SOURCE_GROUNDING_RULES.join("\n");
  assert.match(sourceRules, /upcoming_source_material is empty.*must be null/i);
  assert.match(sourceRules, /startsNewChapter true.*earliest concrete event/i);
  assert.match(sourceRules, /natural in-story transition/i);
  assert.match(sourceRules, /Only then may later narration or choices rely on that event/i);

  assert.deepEqual(
    sceneJsonSchemaForSourceChapters([]).properties.sourceChapterPosition.enum,
    [null],
  );
  assert.deepEqual(
    dialogueSceneJsonSchemaForSourceChapters([4, 5, 4])
      .properties.sourceChapterPosition.enum,
    [null, 4, 5],
  );
  assert.equal(
    "choices" in dialogueSceneJsonSchemaForSourceChapters([4]).properties,
    false,
  );
});

test("talk choices start a conversation without containing an utterance", () => {
  const scene = normalizeSceneTalkChoices({
    title: "Investigation",
    text: "The detectives consider the debt lead.",
    choices: [
      {
        id: "ask_person_alpha",
        type: "talk",
        text: "Person Alpha, walk me through every contact.",
        character: "Person Alpha",
      },
      {
        id: "check_records",
        type: "action",
        text: "Check the available phone records",
      },
    ],
  });

  assert.deepEqual(scene.choices[0], {
    id: "ask_person_alpha",
    type: "talk",
    text: "Talk to Person Alpha",
    character: "Person Alpha",
  });
  assert.deepEqual(scene.choices[1], {
    id: "check_records",
    type: "action",
    text: "Check the available phone records",
  });
});

test("talk choice normalization removes duplicate routes to the same character", () => {
  const scene = normalizeSceneTalkChoices({
    title: "Departure",
    text: "Mary steps aside, leaving the stairs open.",
    choices: [
      { id: "leave", type: "action", text: "Walk toward the stairs" },
      {
        id: "reassure",
        type: "talk",
        text: "Tell Mary you will still support the family",
        character: "Mary Maloney",
      },
      {
        id: "last_words",
        type: "talk",
        text: "Ask Mary whether she has any last words",
        character: "Mary Maloney",
      },
      { id: "call", type: "action", text: "Call your new girlfriend" },
    ],
  });

  assert.deepEqual(
    scene.choices.map((choice) => choice.id),
    ["leave", "reassure", "call"],
  );
  assert.equal(scene.choices[1]?.text, "Talk to Mary Maloney");
});

test("generated choices normalize the literal null character sentinel", () => {
  const choices = repairGeneratedChoices([
    {
      id: "greet",
      type: "action",
      text: "Stand and greet Patrick warmly",
      character: "null",
      requiredPresentCharacters: ["Patrick Maloney"],
    },
    {
      id: "talk",
      type: "talk",
      text: "Talk to Patrick Maloney",
      character: "null",
      requiredPresentCharacters: ["Patrick Maloney"],
    },
  ]);

  assert.equal(choices[0]?.character, undefined);
  assert.equal(choices[1]?.character, "Patrick Maloney");
});

test("generated choices discard incomplete transitive actions", () => {
  assert.deepEqual(
    repairGeneratedChoices([
      { id: "lower", type: "action", text: "Lower" },
      { id: "wait", type: "action", text: "Wait" },
    ]).map((choice) => choice.id),
    ["wait"],
  );
});

test("generated choices discard third-person finite player actions", () => {
  assert.deepEqual(
    repairGeneratedChoices([
      { id: "asks", type: "action", text: "Asks whether Oz could help" },
      { id: "lowers", type: "action", text: "Lowers the axe" },
      { id: "continues", type: "action", text: "Continues along the road" },
      { id: "ask", type: "action", text: "Ask whether Oz could help" },
      { id: "address", type: "action", text: "Address the travelers" },
      { id: "focus", type: "action", text: "Focus on the road ahead" },
    ]).map((choice) => choice.id),
    ["ask", "address", "focus"],
  );
});

test("talk choices without a target character are rejected", () => {
  assert.throws(
    () => normalizeSceneTalkChoices({
      title: "Investigation",
      text: "Someone is nearby.",
      choices: [
        { id: "talk", type: "talk", text: "Ask what happened" },
        { id: "wait", type: "action", text: "Wait" },
      ],
    }),
    /missing a character/,
  );
});

test("an exact Talk to label repairs a missing target character", () => {
  const scene = normalizeSceneTalkChoices({
    title: "At the table",
    text: "Patrick is still alive and sitting across from Mary.",
    choices: [
      { id: "patrick", type: "talk", text: "Talk to Patrick" },
      { id: "wait", type: "action", text: "Wait for Patrick to continue" },
    ],
  });

  assert.deepEqual(scene.choices[0], {
    id: "patrick",
    type: "talk",
    text: "Talk to Patrick",
    character: "Patrick",
  });
});



test("dialogue choice validation sends missing talk targets to regeneration", () => {
  assert.deepEqual(
    dialogueChoiceStructureFailures([
      { id: "c1", type: "action", text: "Wait" },
      { id: "c2", type: "talk", text: "Ask for an explanation" },
    ]),
    ['Talk choice "c2" is missing a target character.'],
  );
  assert.deepEqual(
    dialogueChoiceStructureFailures([
      {
        id: "c2",
        type: "talk",
        text: "Talk to the stranger",
        character: "the stranger",
      },
      { id: "c3", type: "action", text: "End the conversation" },
    ]),
    [],
  );
  assert.deepEqual(
    dialogueChoiceStructureFailures([
      { id: "c1", type: "action", text: "Cook the leg of lamb" },
    ]),
    ["Only 1 distinct usable choice(s) were returned for an active dialogue; at least 2 are required."],
  );
  assert.deepEqual(
    dialogueChoiceStructureFailures([], "lost"),
    [],
  );
});

test("dialogue scenes keep the target response separate from player narration", () => {
  const scene = formatDialogueScene("Detective", {
    title: "The offered meal",
    playerUtterance: "I made you a meal.",
    playerIntent: "Person Alpha offers the investigators food.",
    intentType: "statement",
    responseSpeaker: "Detective",
    responseAnchor: "meal",
    characterResponse: "A meal, you say? When did you prepare it?",
    narration: "You keep your expression composed as the detective studies the kitchen.",
    choices: [
      { id: "answer", type: "action", text: "Explain when you began cooking", character: undefined },
      { id: "talk", type: "talk", text: "Deflect with another question", character: "Detective" },
    ],
    outcome: "active",
    outcomeReason: "The interrogation continues.",
  });

  assert.match(scene.text, /^Detective: A meal, you say\?/);
  assert.match(scene.text, /You keep your expression composed/);
  assert.equal(scene.choices[1]?.text, "Talk to Detective");
});

test("dialogue scenes reject an empty target response", () => {
  assert.throws(
    () => formatDialogueScene("Detective", {
      title: "No response",
      playerUtterance: "Will you answer?",
      playerIntent: "Person Alpha waits for a response.",
      intentType: "statement",
      responseSpeaker: "Detective",
      responseAnchor: "answer",
      characterResponse: " ",
      narration: "You wait.",
      choices: [
        { id: "wait", type: "action", text: "Wait" },
        { id: "leave", type: "action", text: "Leave" },
      ],
      outcome: "active",
      outcomeReason: "The conversation continues.",
    }),
    /empty response for Detective/,
  );
});

test("dialogue instructions treat an explicit departure as the latest authoritative action", () => {
  const instruction = buildDialogueContinuationInstruction(
    "Detectives (police)",
    "Person Beta",
    "I'm fed up with this. I'm going home.",
  );

  assert.match(instruction, /changes or abandons the previous topic/i);
  assert.match(instruction, /declares that they are leaving/i);
  assert.match(instruction, /use outcome 'lost'/i);
  assert.match(instruction, /do not force the old objective to continue/i);
});



test("an advancing dialogue may leave the next source event for option one", async () => {
  const requests: AiResponseRequest[] = [];
  let choiceDraftCount = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            latestInputFailureType: "none",
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            latestInputFailureReason: "",
            playerAgencyFailureReason: "",
            turnScopeFailureReason: "",
            requiredEventOccurred: false,
            anchorChoiceIndex: 0,
            reason: "Patrick gives a new concrete answer; Mary's next physical action remains future.",
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_choices") {
        choiceDraftCount += 1;
        return {
          output_text: JSON.stringify({
            choices: [
              {
                id: "kitchen",
                type: "action",
                text: "Go to the kitchen",
                character: null,
                requiredPresentCharacters: [],
                requiredAbsentCharacters: [],
                sourceAnchorRoute: "transition",
                stakes: "significant",
              },
              ...(choiceDraftCount === 1
                ? []
                : [{
                    id: "solicitor",
                    type: "action" as const,
                    text: "Ask for the solicitor's name",
                    character: null,
                    requiredPresentCharacters: [],
                    requiredAbsentCharacters: [],
                    sourceAnchorRoute: null,
                    stakes: "routine" as const,
                  }]),
            ],
          }),
        };
      }
      return {
        output_text: JSON.stringify({
          title: "The allowance",
          playerUtterance: "How much will you give me each month?",
          playerIntent: "Mary asks Patrick for the exact monthly allowance.",
          intentType: "question",
          responseSpeaker: "Patrick",
          responseAnchor: "how much",
          characterResponse: "Fifty pounds. The solicitor will arrange it tomorrow.",
          narration: "I finally have a figure, but Patrick's clipped certainty leaves the decision with me.",
          sourceChapterPosition: 1,
          storyMemory: {
            summary: "Patrick told Mary he would leave and offered fifty pounds per month.",
            openThreads: ["Mary must decide how to respond."],
            canonFacts: ["Patrick named a monthly allowance of fifty pounds."],
          },
          sceneScope: {
            currentLocation: "Living room",
            peoplePresent: ["Patrick"],
            peopleWithinSpeakingDistance: ["Patrick"],
          },
          outcome: "active",
          outcomeReason: "Mary must decide what to do next.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_dialogue_before_anchor",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A tense domestic drama.",
    },
    objective: "Choose how Mary responds to Patrick.",
    victoryCondition: "Reach a coherent ending.",
    status: "active",
    selectedText: "Patrick tells Mary he is leaving her.",
    sourceIntroducedCharacters: ["Patrick"],
    scene: {
      title: "Patrick's decision",
      text: "Patrick says he is leaving and waits for Mary's response.",
      sceneScope: {
        currentLocation: "Living room",
        peoplePresent: ["Patrick"],
        peopleWithinSpeakingDistance: ["Patrick"],
      },
      choices: [],
      outcome: "active",
    },
    history: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
  const candidate = {
    chapterPosition: 1,
    chapterTitle: "The living room",
    summary: "After answering Mary, Patrick leaves the house.",
    excerpt: "Patrick answered her, took his coat, and went out through the front door.",
    requiredEvent: "Patrick leaves the house.",
    requiredEventId: "event_patrick_leaves",
    storyEvents: [{
      eventId: "event_patrick_leaves",
      sequence: 4,
      description: "Patrick leaves the house.",
      chapterPosition: 1,
      actors: ["Patrick"],
      targets: [],
    }],
    nextTextOffset: 80,
  };

  const scene = await new ProviderGameEngine(client, "minimal").continueDialogue(
    state,
    "Patrick",
    "How much will you give me each month?",
    [candidate],
    {
      anchorDirected: true,
      sourceEventId: "event_patrick_leaves",
      sourceAnchorRoute: "event",
    },
  );

  assert.equal(scene.sourceProgress, undefined);
  assert.match(scene.text, /Fifty pounds/);
  const dialogueRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_dialogue_scene",
  );
  assert.equal(dialogueRequests.length, 1);
  assert.match(
    dialogueRequests[0]?.input ?? "",
    /OPTION 1 ANCHOR ROUTE SELECTED/,
  );
  const choiceRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene_choices",
  );
  assert.equal(choiceRequests.length, 2);
  assert.match(
    choiceRequests[0]?.input ?? "",
    /Fifty pounds/,
  );
  const review = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );
  assert.match(review?.instructions ?? "", /new substantive answer.*meaningful advancement/i);
  assert.match(review?.instructions ?? "", /Never use failure to reach REQUIRED NEXT EVENT.*evidence.*repeats/i);
  const reviewInput = JSON.parse(
    String(review?.input).split("\n\nCHOICE NAVIGATION EVENT:", 1)[0]!,
  ) as {
    candidate_scene: {
      text: string;
      dialogue: {
        player_utterance: string;
        response_speaker: string;
        character_response: string;
      };
    };
  };
  assert.equal(
    reviewInput.candidate_scene.text,
    "I finally have a figure, but Patrick's clipped certainty leaves the decision with me.",
  );
  assert.deepEqual(reviewInput.candidate_scene.dialogue, {
    player_utterance: "How much will you give me each month?",
    response_speaker: "Patrick",
    character_response: "Fifty pounds. The solicitor will arrange it tomorrow.",
  });
  assert.doesNotMatch(reviewInput.candidate_scene.text, /Mary:|Patrick:/);
  assert.match(
    review?.instructions ?? "",
    /candidate_scene\.text contains only narration/i,
  );
  assert.match(
    review?.instructions ?? "",
    /mere presence of I, me, or my is not enough/i,
  );
  assert.match(
    review?.instructions ?? "",
    /if player_identity entrusts something.*cannot call it 'his trust'.*'nods back'/i,
  );
  assert.ok(
    sceneRepetitionReviewJsonSchema.required.includes("preservesPlayerPerspective"),
  );
  assert.ok(
    sceneRepetitionReviewJsonSchema.required.includes("playerPerspectiveFailureReason"),
  );
});

test("dialogue rejects a final response that stalls the player's utterance", async () => {
  let dialogueDraftCount = 0;
  let presenceReviewCount = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        presenceReviewCount += 1;
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: false,
            preservesPlayerPerspective: true,
            latestInputFailureType: "stalled",
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            latestInputFailureReason: "Patrick never answers the player's direct question.",
            playerAgencyFailureReason: "",
            turnScopeFailureReason: "",
            requiredEventOccurred: false,
            anchorChoiceIndex: 0,
            reason: "The response delays instead of resolving the utterance.",
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_choices") {
        return {
          output_text: JSON.stringify({
            choices: [
              { id: "press", type: "action", text: "Press Patrick for an answer", character: null },
              { id: "leave", type: "action", text: "End the conversation", character: null },
            ],
          }),
        };
      }
      dialogueDraftCount += 1;
      return {
        output_text: JSON.stringify({
          title: "No answer",
          playerUtterance: "Will you answer me?",
          playerIntent: "Mary asks Patrick for a direct answer.",
          intentType: "question",
          responseSpeaker: "Patrick",
          responseAnchor: "answer",
          characterResponse: `Patrick glances at the clock for the ${dialogueDraftCount} time.`,
          narration: "You wait, but he offers no answer to your question.",
          sourceChapterPosition: null,
          outcome: "active",
          outcomeReason: "The question remains unresolved.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_rejected_stalled_dialogue",
    book: { bookId: "book_stalled_dialogue", title: "Stalled Dialogue" },
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Receive Patrick's answer.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Patrick has difficult news.",
    sourceIntroducedCharacters: ["Patrick"],
    scene: {
      title: "The question",
      text: "Patrick sits across from Mary in the living room.",
      choices: [],
      outcome: "active",
    },
    history: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };

  await assert.rejects(
    new ProviderGameEngine(client, "minimal").continueDialogue(
      state,
      "Patrick",
      "Will you answer me?",
    ),
    /reply was not saved/i,
  );
  assert.equal(dialogueDraftCount, 4);
  assert.equal(presenceReviewCount, 0);
});

test("dialogue and semantic prompts disclose only the player-authored consequential source action", async () => {
  async function capturePrompts(
    event: {
      eventId: string;
      sequence: number;
      description: string;
      category: "violence" | "arrival";
      chapterPosition: number;
      actors: string[];
      targets: string[];
    },
  ): Promise<AiResponseRequest[]> {
    const requests: AiResponseRequest[] = [];
    const client: AiClient = {
      provider: "openai",
      model: "test-model",
      async createResponse(request) {
        requests.push(request);
        if (request.text?.format.name === "bookrpg_scene_presence_review") {
          return scenePresenceReviewResponse(request);
        }
        if (request.text?.format.name === "bookrpg_scene_choice_review") {
          return validSceneChoiceReviewResponse();
        }
        if (request.text?.format.name === "bookrpg_scene_repetition_review") {
          return {
            output_text: JSON.stringify({
              repeatsPriorScene: false,
              latestInputResolvedFaithfully: true,
              preservesPlayerPerspective: true,
              latestInputFailureType: "none",
              preservesPlayerAgency: true,
              staysWithinTurnScope: true,
              latestInputFailureReason: "",
              playerAgencyFailureReason: "",
              turnScopeFailureReason: "",
              requiredEventOccurred: false,
              anchorChoiceIndex: 0,
              reason: "Patrick answers Mary and leaves the next source development unperformed.",
            }),
          };
        }
        if (request.text?.format.name === "bookrpg_scene_choices") {
          return {
            output_text: JSON.stringify({
              choices: event.category === "violence"
                ? [
                    {
                      id: "attack_patrick",
                      type: "action",
                      text: "Attack Patrick with the frozen leg of lamb",
                      character: null,
                      stakes: "critical",
                    },
                    {
                      id: "put_lamb_down",
                      type: "action",
                      text: "Put the frozen lamb down",
                      character: null,
                      stakes: "significant",
                    },
                  ]
                : [
                    {
                      id: "stay",
                      type: "action",
                      text: "Stay by the table and collect yourself",
                      character: null,
                      stakes: "routine",
                    },
                    {
                      id: "talk",
                      type: "talk",
                      text: "Talk to Patrick Maloney",
                      character: "Patrick Maloney",
                      stakes: "routine",
                    },
                  ],
            }),
          };
        }
        return {
          output_text: JSON.stringify({
            title: "Patrick's answer",
            playerUtterance: "Will you reconsider?",
            playerIntent: "Mary asks Patrick to reconsider leaving.",
            intentType: "question",
            responseSpeaker: "Patrick Maloney",
            responseAnchor: "reconsider",
            characterResponse: "No. My decision is final.",
            narration: "His refusal leaves the next move to you.",
            sourceChapterPosition: null,
            storyMemory: {
              summary: "Patrick refused to reconsider leaving Mary.",
              openThreads: ["Mary must decide how to respond."],
              canonFacts: ["Patrick says his decision is final."],
            },
            sceneScope: {
              currentLocation: "Living room",
              peoplePresent: ["Patrick Maloney"],
              peopleWithinSpeakingDistance: ["Patrick Maloney"],
            },
            outcome: "active",
            outcomeReason: "Mary must choose her next move.",
          }),
        };
      },
    };
    const state: GameState = {
      gameId: `game_dialogue_${event.eventId}`,
      book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
      playerName: "Mary Maloney",
      gameProfile: {
        category: "drama",
        endingMode: "open_ended",
        description: "A tense domestic drama.",
      },
      objective: "Decide how Mary responds to Patrick.",
      victoryCondition: "Reach a coherent ending.",
      status: "active",
      selectedText: "Patrick tells Mary he is leaving.",
      sourceIntroducedCharacters: ["Patrick Maloney"],
      scene: {
        title: "Patrick's decision",
        text: "Patrick says he is leaving and waits for Mary's response.",
        sceneScope: {
          currentLocation: "Living room",
          peoplePresent: ["Patrick Maloney"],
          peopleWithinSpeakingDistance: ["Patrick Maloney"],
        },
        choices: [],
        outcome: "active",
      },
      history: [],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    await new ProviderGameEngine(client, "minimal").continueDialogue(
      state,
      "Patrick Maloney",
      "Will you reconsider?",
      [{
        chapterPosition: 4,
        chapterTitle: "The living room",
        summary: event.description,
        excerpt: event.description,
        storyEvents: [event],
        nextTextOffset: 9_000,
      }],
    );
    return requests;
  }

  const playerActionRequests = await capturePrompts({
    eventId: "event_attack",
    sequence: 6,
    description: "Mary attacks Patrick with the frozen leg of lamb.",
    category: "violence",
    chapterPosition: 4,
    actors: ["Mary Maloney"],
    targets: ["Patrick Maloney"],
  });
  const npcEventRequests = await capturePrompts({
    eventId: "event_detectives_arrive",
    sequence: 7,
    description: "Detectives arrive at the house.",
    category: "arrival",
    chapterPosition: 4,
    actors: ["Detectives"],
    targets: ["Mary Maloney"],
  });
  const playerDialogue = playerActionRequests.find(
    (request) => request.text?.format.name === "bookrpg_dialogue_scene",
  );
  const playerReview = playerActionRequests.find(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );
  const playerChoiceReview = playerActionRequests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choice_review",
  );
  const playerChoices = playerActionRequests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choices",
  );
  const npcDialogue = npcEventRequests.find(
    (request) => request.text?.format.name === "bookrpg_dialogue_scene",
  );
  const npcReview = npcEventRequests.find(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );
  const npcChoiceReview = npcEventRequests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choice_review",
  );
  const npcChoices = npcEventRequests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choices",
  );

  assert.match(playerDialogue?.input ?? "", /"requiresExplicitPlayerChoice": true/);
  assert.match(playerReview?.input ?? "", /"requiresExplicitPlayerChoice": true/);
  assert.match(playerChoiceReview?.input ?? "", /"requiresExplicitPlayerChoice": true/);
  assert.doesNotMatch(playerDialogue?.instructions ?? "", /informed-consent exception, not a spoiler/i);
  assert.match(playerChoices?.instructions ?? "", /informed-consent exception, not a spoiler/i);
  assert.doesNotMatch(playerReview?.instructions ?? "", /informed-consent exception, not a spoiler/i);
  assert.match(playerChoiceReview?.instructions ?? "", /informed-consent exception, not a spoiler/i);
  assert.match(npcDialogue?.input ?? "", /"requiresExplicitPlayerChoice": false/);
  assert.match(npcReview?.input ?? "", /"requiresExplicitPlayerChoice": false/);
  assert.match(npcChoiceReview?.input ?? "", /"requiresExplicitPlayerChoice": false/);
  assert.doesNotMatch(npcDialogue?.instructions ?? "", /Preserve spoiler protection for NPC or world events/i);
  assert.match(npcChoices?.instructions ?? "", /Preserve spoiler protection for NPC or world events/i);
  assert.doesNotMatch(npcReview?.instructions ?? "", /Preserve spoiler protection for NPC or world events/i);
  assert.match(npcChoiceReview?.instructions ?? "", /Preserve spoiler protection for NPC or world events/i);
});

test("dialogue formatting removes duplicate target speaker labels", () => {
  const scene = formatDialogueScene("Person Beta", {
    title: "Departure",
    playerUtterance: "I am leaving.",
    playerIntent: "The detective ends the interview and leaves.",
    intentType: "departure",
    responseSpeaker: "Person Beta",
    responseAnchor: "leaving",
    characterResponse: "Person Beta: Fine. Go, then. I have nothing else to say.",
    narration: "You turn toward the door, ending the interview.",
    choices: [],
    outcome: "lost",
    outcomeReason: "You abandoned the investigation.",
  });

  assert.match(scene.text, /^Person Beta: Fine\. Go, then\./);
  assert.doesNotMatch(scene.text, /^Person Beta: Person Beta:/);
  assert.equal(scene.outcome, "lost");
});

test("dialogue attribution requires exact player words, target speaker, and response anchor", () => {
  const base = {
    title: "A reply",
    playerUtterance: "Strangers are bad luck aboard this ship!",
    playerIntent: "Ahab invokes a superstition.",
    intentType: "statement" as const,
    responseSpeaker: "the stranger",
    responseAnchor: "bad luck",
    characterResponse: "Bad luck? Judge my warning by what I know.",
    narration: "You hear the crew react.",
    choices: [
      { id: "reply", type: "action" as const, text: "Ask what she knows" },
      { id: "leave", type: "action" as const, text: "End the interview" },
    ],
    outcome: "active" as const,
    outcomeReason: "The exchange continues.",
  };

  assert.deepEqual(
    dialogueAttributionFailures(base, base.playerUtterance, "the stranger"),
    [],
  );
  assert.match(
    dialogueAttributionFailures(
      { ...base, playerUtterance: "Tell me who sent you." },
      base.playerUtterance,
      "the stranger",
    )[0] ?? "",
    /exactly preserve/i,
  );
  assert.match(
    dialogueAttributionFailures(
      { ...base, responseSpeaker: "Ahab" },
      base.playerUtterance,
      "the stranger",
    )[0] ?? "",
    /responseSpeaker/i,
  );
  assert.deepEqual(
    dialogueAttributionFailures(
      {
        ...base,
        characterResponse: "That request is insulting. Address me with respect.",
      },
      base.playerUtterance,
      "the stranger",
    ),
    [],
  );
  assert.match(
    dialogueAttributionFailures(
      { ...base, responseAnchor: "superstition" },
      base.playerUtterance,
      "the stranger",
    )[0] ?? "",
    /responseAnchor/i,
  );
});

test("passage context resolves pasted text to its actual chapter", () => {
  const context = findPassageContext({
    chapters: [
      { index: 0, title: "Contents", text: "Contents and front matter" },
      {
        index: 1,
        title: "The story",
        text: "Earlier events happen. Later, one detective asks about the weapon.",
      },
    ],
  }, "Later, one detective asks about the weapon.");

  assert.equal(context.chapterPosition, 1);
  assert.equal(context.chapterTitle, "The story");
  assert.equal(
    context.passageEnd,
    "Earlier events happen. Later, one detective asks about the weapon.".length,
  );
  assert.match(context.textThroughPassage, /Earlier events happen/);
  assert.match(context.textThroughPassage, /asks about the weapon\.$/);
});

test("explicit source continuation selects a supplied compatible candidate", () => {
  const candidates = [{
    chapterPosition: 4,
    chapterTitle: "The next turn",
    summary: "A witness arrives.",
    excerpt: "A witness approaches the house.",
    requiredEvent: "A witness arrives at the house.",
    nextTextOffset: 31,
    recovery: true,
  }];
  assert.equal(
    resolveGroundedSourceCandidate(4, candidates),
    candidates[0],
  );
  assert.equal(
    resolveGroundedSourceCandidate(5, candidates),
    undefined,
  );
  assert.equal(
    resolveSourceContinuationSelection(
      {
        compatible: true,
        currentChapterPosition: 4,
        candidateIndex: 0,
        chapterPosition: 4,
        reason: "The arrival still fits.",
      },
      candidates,
    ),
    candidates[0],
  );
  assert.equal(
    resolveSourceContinuationSelection(
      {
        compatible: true,
        currentChapterPosition: 4,
        candidateIndex: 0,
        chapterPosition: 5,
        reason: "Unknown candidate.",
      },
      candidates,
    ),
    undefined,
  );
  const instruction = buildSourceContinuationInstruction(candidates[0]!);
  assert.match(instruction, /earliest concrete source-backed development/i);
  assert.match(instruction, /without undoing completed player actions/i);
  assert.match(instruction, /recovery route selected from chapter summaries/i);
  assert.match(instruction, /required next event: a witness arrives at the house/i);
  assert.match(instruction, /establish this scene's central new beat/i);
  assert.match(
    instruction,
    /event contains or may contain a meaningful voluntary player beat/i,
  );
  assert.match(instruction, /offer an explicit informed-consent choice/i);
  assert.doesNotMatch(
    instruction,
    /authorized even when it includes an action by player_identity/i,
  );

  const regularInstruction = buildSourceContinuationInstruction({
    ...candidates[0]!,
    recovery: false,
    requiredEventActors: ["Witness"],
  }, "Mary Maloney");
  assert.match(regularInstruction, /required next event: a witness arrives at the house/i);
  assert.match(regularInstruction, /establish this scene's central new beat/i);
  assert.match(regularInstruction, /agency metadata confirms/i);
  assert.match(regularInstruction, /needs no separate meaningful voluntary choice/i);
  assert.match(regularInstruction, /must visibly happen in scene text now/i);
  assert.match(regularInstruction, /record them only in externalDevelopment/i);
});

test("source event selection retries when OpenAI returns an incomplete JSON response", async () => {
  const requests: AiResponseRequest[] = [];
  let attempt = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      attempt += 1;
      if (attempt === 1) {
        return {
          output_text: '{"compatible": true, "blockIndex": 0, "eventId": "event_murder", "event": "Mary kills Patrick with the frozen leg of lamb"',
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        };
      }
      return {
        output_text: JSON.stringify({
          compatible: true,
          blockIndex: 0,
          eventId: "event_murder",
          event: "Mary kills Patrick with the frozen leg of lamb.",
          reason: "This is the earliest unshown event in the selected source block.",
        }),
      };
    },
  };

  const state: GameState = {
    gameId: "game_incomplete_source_event_retry",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Continue the story.",
    victoryCondition: "Reach the next milestone.",
    status: "active",
    selectedText: "Patrick says he is leaving.",
    scene: {
      title: "The announcement",
      text: "Patrick says he is leaving but will provide for Mary and the baby.",
      choices: [],
      outcome: "active",
    },
    history: [{
      kind: "scene",
      text: "Patrick says he is leaving but will provide for Mary and the baby.",
    }],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };

  const result = await new ProviderGameEngine(client, "minimal").selectSourceEvent(
    state,
    {
      chapterPosition: 0,
      chapterTitle: "Lamb to the Slaughter",
      summary: "Mary kills Patrick.",
      excerpt: "Mary swings the frozen leg of lamb.",
      storyEvents: [{
        eventId: "event_murder",
        sequence: 2,
        description: "Mary kills Patrick with the frozen leg of lamb.",
        chapterPosition: 0,
      }],
      nextTextOffset: 40,
    },
  );

  assert.ok(result);
  assert.equal(result?.requiredEventId, "event_murder");
  assert.equal(requests.length, 2);
});

test("source event selection rejects a later block when an unshown prerequisite is before the cursor", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      return {
        output_text: JSON.stringify({
          compatible: false,
          blockIndex: null,
          eventId: null,
          event: "",
          reason: "Patrick's killing is still unshown and is not present in the supplied blocks.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_cursor_ahead_of_visible_story",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Navigate Patrick's announcement.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Patrick says he is leaving.",
    sourceCursor: { chapterPosition: 0, textOffset: 80 },
    scene: {
      title: "The announcement",
      text: "Patrick says he is leaving but will provide for Mary and the baby.",
      choices: [],
      outcome: "active",
    },
    history: [{
      kind: "scene",
      text: "Patrick says he is leaving but will provide for Mary and the baby.",
    }],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  const result = await new ProviderGameEngine(client, "minimal").selectSourceEvent(
    state,
    {
      chapterPosition: 0,
      chapterTitle: "Lamb to the Slaughter",
      summary:
        "Patrick announces he is leaving. Mary kills him. Mary later discovers his body and calls the police.",
      excerpt: "Mary finds Patrick motionless and telephones the police.",
      nextTextOffset: 130,
    },
  );

  assert.equal(result, undefined);
  assert.match(requests[0]?.instructions ?? "", /compatible false/i);
  assert.match(requests[0]?.instructions ?? "", /death must be visibly caused/i);
});

test("source event selection preserves the selected global story event ID", async () => {
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse() {
      return {
        output_text: JSON.stringify({
          compatible: true,
          blockIndex: 0,
          eventId: "event_murder",
          event: "A paraphrased event label.",
          reason: "This is the earliest indexed event.",
        }),
      };
    },
  };
  const state = {
    gameId: "game_global_event_selection",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama" as const,
      endingMode: "open_ended" as const,
      description: "A domestic drama.",
    },
    objective: "Continue.",
    victoryCondition: "Reach milestones.",
    status: "active" as const,
    selectedText: "Patrick speaks.",
    scene: { title: "The reveal", text: "Patrick says he is leaving.", choices: [] },
    history: [{ kind: "scene" as const, text: "Patrick says he is leaving." }],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  const result = await new ProviderGameEngine(client, "minimal").selectSourceEvent(
    state,
    {
      chapterPosition: 0,
      chapterTitle: "The story",
      summary: "Mary kills Patrick.",
      excerpt: "Mary swings the frozen leg of lamb.",
      storyEvents: [{
        eventId: "event_murder",
        sequence: 2,
        description: "Mary kills Patrick with the frozen leg of lamb.",
        chapterPosition: 0,
      }],
      nextTextOffset: 40,
    },
  );

  assert.equal(result?.requiredEventId, "event_murder");
  assert.equal(result?.requiredEvent, "Mary kills Patrick with the frozen leg of lamb.");
});

test("direct source continuation does not authorize a player action when actor metadata is absent", async () => {
  let sceneAttempt = 0;
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_source_event") {
        return {
          output_text: JSON.stringify({
            compatible: true,
            blockIndex: 0,
            eventId: null,
            event: "Mary strikes Patrick with the frozen leg of lamb and kills him.",
            reason: "The killing is the earliest unshown major event.",
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            latestInputFailureType: "none",
            preservesPlayerAgency: false,
            staysWithinTurnScope: true,
            latestInputFailureReason: "",
            playerAgencyFailureReason:
              "Mary kills Patrick without the player selecting that consequential action.",
            turnScopeFailureReason: "",
            requiredEventOccurred: sceneAttempt === 2,
            anchorChoiceIndex: 0,
            reason: "The draft performs an unchosen consequential player action.",
          }),
        };
      }
      sceneAttempt += 1;
      return {
        output_text: JSON.stringify({
          title: sceneAttempt === 1 ? "After the question" : "The blow",
          text: sceneAttempt === 1
            ? "Patrick repeats that he will provide for Mary and the baby."
            : "Mary brings the frozen leg of lamb down on Patrick. He collapses and lies motionless on the floor.",
          choices: [
            { id: "check", type: "action", text: "Check whether Patrick is breathing" },
            { id: "phone", type: "action", text: "Move toward the telephone" },
          ],
          outcome: "active",
          outcomeReason: "The household has changed irreversibly.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: sceneAttempt === 1
            ? ""
            : "Mary kills Patrick with the frozen leg of lamb.",
          sourceChapterPosition: 0,
        }),
      };
    },
  };
  const engine = new ProviderGameEngine(client, "minimal");
  await assert.rejects(() => engine.continueFromSource({
    gameId: "game_required_source_event",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Navigate the consequences.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Patrick says he is leaving.",
    sourceCursor: { chapterPosition: 0, textOffset: 24 },
    scene: {
      title: "The announcement",
      text: "Patrick says he is leaving but will provide for Mary and the baby.",
      choices: [{
        id: SOURCE_CONTINUATION_CHOICE_ID,
        type: "action",
        text: SOURCE_CONTINUATION_CHOICE_TEXT,
      }],
      outcome: "active",
    },
    history: [{
      kind: "scene",
      text: "Patrick says he is leaving but will provide for Mary and the baby.",
    }],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  }, [{
    chapterPosition: 0,
    chapterTitle: "Lamb to the Slaughter",
    summary: "Patrick announces he is leaving. Mary kills him with a frozen lamb. She later calls the police.",
    excerpt: "Mary crossed the room and swung the frozen leg of lamb. Patrick fell.",
    nextTextOffset: 96,
  }]), /performed a consequential player action that was not selected/);

  assert.equal(sceneAttempt, 4);
  const reviewRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
  );
  assert.match(
    reviewRequest?.instructions ?? "",
    /contains or may contain a meaningful voluntary player beat/i,
  );
  assert.match(
    reviewRequest?.instructions ?? "",
    /assigns player_identity a meaningful intentional or ambiguous beat/i,
  );
  assert.doesNotMatch(
    reviewRequest?.instructions ?? "",
    /authorizes the REQUIRED NEXT EVENT even when it contains a consequential action by player_identity/i,
  );
});

test("an opening retries incomplete presence output with semantic continuity review", async () => {
  const requests: AiResponseRequest[] = [];
  let presenceAttempt = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        presenceAttempt += 1;
        if (presenceAttempt === 1) {
          return {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output_text: "",
          };
        }
        return scenePresenceReviewResponse(
          request,
          presenceAttempt >= 3 ? "event_arrival" : null,
        );
      }
      if (request.text?.format.name === "bookrpg_scene_choices") {
        return {
          output_text: JSON.stringify({
            choices: [
              {
                id: "open_door",
                type: "action",
                text: "Join Mary in the living room",
                character: null,
                stakes: "significant",
              },
              {
                id: "pause",
                type: "action",
                text: "Hang up your coat before joining Mary",
                character: null,
                stakes: "routine",
              },
            ],
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return validSceneRepetitionReviewResponse();
      }
      return {
        output_text: JSON.stringify({
          title: "At the Front Door",
          text: "You open the front door and step into the house. Mary looks up as you enter the warm living room.",
          outcome: "active",
          outcomeReason: "Patrick chooses what to do next.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: "Patrick reaches his home after work.",
          sourceChapterPosition: null,
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_opening_source_progress",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Patrick Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Shape Patrick's alternate path.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Lamb to the Slaughter",
    sourceCursor: { chapterPosition: 4, textOffset: 21 },
    scene: { title: "Starting...", text: "", choices: [] },
    history: [{ kind: "start", text: "Lamb to the Slaughter" }],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  const result = await new ProviderGameEngine(client, "minimal").start(state, [{
    chapterPosition: 4,
    chapterTitle: "Lamb to the Slaughter",
    summary: "Patrick arrives home.",
    storySoFar: [{
      chapterPosition: 4,
      chapterTitle: "Lamb to the Slaughter",
      summary: "Earlier in this chapter: Mary waits peacefully for Patrick.",
    }],
    excerpt: "Patrick came home from work.",
    currentStoryEvent: {
      eventId: "event_arrival",
      sequence: 2,
      description: "Patrick arrives home.",
      chapterPosition: 4,
    },
    storyEvents: [
      {
        eventId: "event_arrival",
        sequence: 2,
        description: "Patrick arrives home.",
        category: "arrival",
        chapterPosition: 4,
        actors: ["Patrick Maloney"],
        targets: [],
      },
      {
        eventId: "event_enter",
        sequence: 3,
        description: "Patrick opens the door and enters the house.",
        category: "other",
        chapterPosition: 4,
        actors: ["Patrick Maloney"],
        targets: [],
        beats: [{
          actor: "Patrick Maloney",
          action: "Opens the door and enters the house.",
          targets: [],
          agency: "intentional",
          stakes: "critical",
          sourceReferences: [{
            chapterPosition: 4,
            chapterIndex: 4,
            lineStart: 1,
            lineEnd: 1,
          }],
        }],
      },
      {
        eventId: "event_settle",
        sequence: 4,
        description: "Patrick joins Mary and they settle into their evening routine.",
        category: "other",
        chapterPosition: 4,
        actors: ["Patrick Maloney", "Mary Maloney"],
        targets: [],
      },
    ],
    nextTextOffset: 6_000,
  }]);

  assert.equal(result.sourceProgress, undefined);
  assert.equal(
    requests.filter((request) => request.text?.format.name === "bookrpg_scene").length,
    1,
  );
  assert.equal(presenceAttempt, 2);
  assert.equal(
    requests.some(
      (request) => request.text?.format.name === "bookrpg_scene_repetition_review",
    ),
    true,
  );
  assert.match(requests[0]?.input ?? "", /optional_opening_reference/);
  assert.match(requests[0]?.input ?? "", /Earlier in this chapter/);
  assert.match(
    requests[0]?.input ?? "",
    /opening_reference_event is the first future source event to stage/i,
  );
  assert.match(
    requests[0]?.input ?? "",
    /Use next_significant_event_progress, each beat's sourceReferencesExcerpt, and upcoming_source_material\.excerpt together/i,
  );
  assert.match(
    requests[0]?.input ?? "",
    /Scarecrow's first player beat is to wink and nod.*show him fixed on the pole/i,
  );
  assert.match(
    requests[0]?.input ?? "",
    /stop immediately before the earliest meaningful player-controlled beat and offer it as a concrete choice/i,
  );
  const choiceRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choices",
  );
  const presenceRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_presence_review",
  );
  const presenceRequests = requests.filter(
    (request) => request.text?.format.name === "bookrpg_scene_presence_review",
  );
  assert.match(
    presenceRequest?.instructions ?? "",
    /uncertain sound.*does not establish presence/i,
  );
  assert.match(
    presenceRequest?.instructions ?? "",
    /short description plus all listed beats as its completion contract/i,
  );
  assert.match(
    presenceRequest?.instructions ?? "",
    /general outcome phrase does not substitute for a missing listed beat/i,
  );
  const presenceInput = JSON.parse(presenceRequest?.input ?? "{}") as {
    event_review_target_mode?: string;
    previous_completed_source_event_beat_indexes?: number[];
    ordered_source_events?: Array<Record<string, unknown>>;
  };
  assert.equal(
    presenceInput.event_review_target_mode,
    "opening_progression",
  );
  assert.deepEqual(
    presenceInput.previous_completed_source_event_beat_indexes,
    [],
  );
  assert.match(
    presenceRequest?.instructions ?? "",
    /future narrative structure, not pre-completed state/i,
  );
  assert.deepEqual(
    presenceInput.ordered_source_events?.find(
      (event) => event.eventId === "event_enter",
    ),
    {
      eventId: "event_enter",
      sequence: 3,
      description: "Patrick opens the door and enters the house.",
      beats: [{
        actor: "Patrick Maloney",
        action: "Opens the door and enters the house.",
        agency: "intentional",
        stakes: "critical",
      }],
      criticalBeats: [{
        actor: "Patrick Maloney",
        action: "Opens the door and enters the house.",
      }],
    },
  );
  assert.match(presenceRequest?.input ?? "", /"beats"/);
  assert.deepEqual(
    presenceRequests.map((request) => request.max_output_tokens),
    [3_200, 6_400],
  );
  assert.doesNotMatch(choiceRequest?.input ?? "", /"eventId": "event_enter"/);
  assert.equal(result.choices[0]?.text, "Join Mary in the living room");
});

test("scene text alignment identifies the latest visibly completed event", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      return {
        output_text: JSON.stringify({
          nextEventOccurred: true,
          reason: "Mary explicitly processes the announcement and weighs her future.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_scene_event_alignment",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Navigate Patrick's announcement.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Lamb to the Slaughter",
    sourceCursor: {
      chapterPosition: 4,
      textOffset: 6_000,
      eventId: "event_revelation",
    },
    scene: {
      title: "After the reveal",
      text:
        "Patrick finishes explaining that he will leave. Mary sits in disbelief, "
        + "then thinks practically about her unborn child's future.",
      choices: [],
    },
    history: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  const eventId = await new ProviderGameEngine(
    client,
    "minimal",
  ).identifyLatestVisibleStoryEvent(state, {
    chapterPosition: 4,
    chapterTitle: "Lamb to the Slaughter",
    summary: "Patrick makes an announcement and Mary processes it.",
    excerpt: "Mary sat still and considered the child.",
    currentStoryEvent: {
      eventId: "event_revelation",
      sequence: 3,
      description: "Patrick announces that he will leave Mary.",
      chapterPosition: 4,
    },
    storyEvents: [
      {
        eventId: "event_reaction",
        sequence: 4,
        description:
          "Mary processes the revelation with disbelief and concern for her unborn child.",
        chapterPosition: 4,
        beats: [{
          actor: "Mary Maloney",
          action: "Processes the revelation with disbelief and concern for her unborn child.",
          targets: [],
          agency: "involuntary",
          stakes: "critical",
          sourceReferences: [{
            chapterPosition: 4,
            chapterIndex: 4,
            lineStart: 1,
            lineEnd: 1,
          }],
        }],
      },
      {
        eventId: "event_lamb",
        sequence: 5,
        description: "Mary retrieves a frozen leg of lamb.",
        chapterPosition: 4,
      },
    ],
    nextTextOffset: 7_500,
  });

  assert.equal(eventId, "event_reaction");
  assert.match(requests[0]?.input ?? "", /Mary sits in disbelief/);
  assert.match(requests[0]?.instructions ?? "", /Use only CURRENT SCENE TEXT as evidence/i);
  assert.match(
    requests[0]?.instructions ?? "",
    /DIRECT NEXT EVENT\.description plus any listed criticalBeats as the completion contract/i,
  );
  assert.match(requests[0]?.input ?? "", /"criticalBeats"/);
  assert.match(
    requests[0]?.input ?? "",
    /Processes the revelation with disbelief and concern for her unborn child/,
  );
  assert.doesNotMatch(requests[0]?.input ?? "", /event_lamb/);
});

test("scene text alignment cannot infer a physical next event from an intention", async () => {
  let alignmentAttempt = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse() {
      alignmentAttempt += 1;
      if (alignmentAttempt === 1) {
        return {
          output_text: "",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        };
      }
      return {
        output_text: JSON.stringify({
          nextEventOccurred: false,
          reason: "Mary decides to act but does not retrieve the lamb.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_scene_event_skip_guard",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Navigate Patrick's announcement.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Lamb to the Slaughter",
    sourceCursor: {
      chapterPosition: 4,
      textOffset: 6_000,
      eventId: "event_reaction",
    },
    scene: {
      title: "A decision",
      text: "Mary considers her unborn child and decides that she must act.",
      choices: [],
    },
    history: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };

  const eventId = await new ProviderGameEngine(
    client,
    "minimal",
  ).identifyLatestVisibleStoryEvent(state, {
    chapterPosition: 4,
    chapterTitle: "Lamb to the Slaughter",
    summary: "Mary reacts, retrieves the lamb, and later kills Patrick.",
    excerpt: "Mary sat still and considered the child.",
    currentStoryEvent: {
      eventId: "event_reaction",
      sequence: 4,
      description: "Mary decides that she must act.",
      chapterPosition: 4,
    },
    storyEvents: [
      {
        eventId: "event_lamb",
        sequence: 5,
        description: "Mary retrieves a frozen leg of lamb.",
        chapterPosition: 4,
      },
      {
        eventId: "event_killing",
        sequence: 6,
        description: "Mary kills Patrick with the leg of lamb.",
        chapterPosition: 4,
      },
    ],
    nextTextOffset: 7_500,
  });

  assert.equal(eventId, "event_reaction");
  assert.equal(alignmentAttempt, 2);
});

test("a confirmed overlapping source event advances without replaying it in the next choices", async () => {
  const action = "Ask to accompany the group so I can seek courage from Oz";
  const replayChoice =
    "Stride forward to walk beside Dorothy and Toto, solidifying my commitment to travel the road to Oz with them, and ready to face danger and honesty together";
  const requests: AiResponseRequest[] = [];
  let sceneAttempt = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: true,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            latestInputFailureType: "none",
            preservesPlayerAgency: true,
            staysWithinTurnScope: true,
            latestInputFailureReason: "",
            playerAgencyFailureReason: "",
            turnScopeFailureReason: "",
            requiredEventOccurred: true,
            nonInteractableCharacters: [],
            nonInteractableCharactersReason: "",
            reason:
              "The joining beat overlaps the prior scene, but the company now sets off and Toto accepts the Lion.",
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request, "event_lion_joins");
      }
      if (request.text?.format.name === "bookrpg_scene_choices") {
        return {
          output_text: JSON.stringify({
            choices: [
              {
                id: "repeat_joining",
                type: "action",
                text: replayChoice,
                character: "Dorothy",
                requiredPresentCharacters: ["Dorothy", "Toto"],
                requiredAbsentCharacters: [],
                sourceAnchorRoute: null,
                stakes: "significant",
              },
              {
                id: "inspect_ditch",
                type: "action",
                text: "Examine the deep ditch now blocking the road",
                character: null,
                requiredPresentCharacters: [],
                requiredAbsentCharacters: [],
                sourceAnchorRoute: "event",
                stakes: "significant",
              },
              {
                id: "test_bank",
                type: "action",
                text: "Test the soil at the ditch's edge",
                character: null,
                requiredPresentCharacters: [],
                requiredAbsentCharacters: [],
                sourceAnchorRoute: null,
                stakes: "routine",
              },
            ],
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        const contextText = (request.input ?? "").split(
          "\n\nCHOICE NAVIGATION EVENT:",
          1,
        )[0]!;
        const context = JSON.parse(contextText) as {
          candidate_scene: {
            choices: Array<{ text: string }>;
          };
        };
        const replayIndex = context.candidate_scene.choices.findIndex(
          (choice) => choice.text === replayChoice,
        );
        return validSceneChoiceReviewResponse(
          replayIndex >= 0 ? null : 0,
          replayIndex >= 0 ? [replayIndex] : [],
          replayIndex >= 0
            ? "The choice replays the completed joining action."
            : "",
        );
      }

      sceneAttempt += 1;
      return {
        output_text: JSON.stringify({
          title: "The company sets out",
          text:
            "I stride up beside Dorothy and Toto and ask to come with them to Oz so I can seek courage. "
            + "Dorothy welcomes me, and Toto relaxes enough to trot at my shoulder as the company sets out.",
          playerAction: action,
          actionOutcome: "succeeded",
          actionResult:
            "The Lion joins the traveling company; Toto accepts him as a companion.",
          externalDevelopment:
            "The company sets out together and Toto becomes comfortable with the Lion.",
          sourceChapterPosition: 8,
          storyMemory: {
            summary: "The Lion joins the travelers and earns Toto's trust.",
            openThreads: ["A deep ditch blocks the road ahead."],
            canonFacts: ["The Lion travels with Dorothy and Toto."],
          },
          sceneScope: {
            currentLocation: "Forest road",
            peoplePresent: ["Dorothy", "Toto"],
            peopleWithinSpeakingDistance: ["Dorothy"],
          },
          outcome: "active",
          outcomeReason: "The Lion is now traveling with Dorothy and Toto.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_overlapping_source_event",
    book: { bookId: "book_oz", title: "The Wonderful Wizard of Oz" },
    playerName: "Cowardly Lion",
    gameProfile: {
      category: "adventure",
      endingMode: "open_ended",
      description: "A journey through Oz.",
    },
    objective: "Travel with Dorothy to Oz.",
    victoryCondition: "Reach meaningful story milestones.",
    status: "active",
    selectedText: "The Lion asks to accompany Dorothy so he can seek courage.",
    sourceCursor: {
      chapterPosition: 8,
      textOffset: 5_742,
      eventId: "event_lion_decides",
    },
    scene: {
      title: "An honest confession",
      text:
        "I confess that my roar hides how deeply I fear real danger. Dorothy listens without judgment, "
        + "and Toto watches me from beside her.",
      choices: [{ id: "join", type: "action", text: action }],
      sceneScope: {
        currentLocation: "Forest road",
        peoplePresent: ["Dorothy", "Toto"],
        peopleWithinSpeakingDistance: ["Dorothy"],
      },
      outcome: "active",
    },
    history: [
      {
        kind: "scene",
        text:
          "I confess that my roar hides how deeply I fear real danger. Dorothy listens without judgment, "
          + "and Toto watches me from beside her.",
      },
      { kind: "choice", text: action },
    ],
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  const scene = await new ProviderGameEngine(client, "minimal").continue(
    state,
    action,
    [{
      chapterPosition: 8,
      chapterTitle: "Chapter VI",
      summary:
        "The Lion joins the company. The travelers then encounter a deep ditch.",
      excerpt:
        "The company set off with the Lion. Toto grew friendly with him. A deep ditch blocked the road.",
      currentStoryEvent: {
        eventId: "event_lion_decides",
        sequence: 26,
        description: "The Lion decides to join Dorothy.",
        category: "decision",
        chapterPosition: 8,
      },
      requiredEvent: "The Lion joins the traveling company and becomes friends with Toto.",
      requiredEventId: "event_lion_joins",
      storyEvents: [
        {
          eventId: "event_lion_joins",
          sequence: 27,
          description: "The Lion joins the traveling company and becomes friends with Toto.",
          category: "other",
          chapterPosition: 8,
          actors: ["Dorothy", "Toto"],
          targets: ["Cowardly Lion"],
        },
        {
          eventId: "event_ditch",
          sequence: 28,
          description: "The travelers encounter a deep ditch blocking the road.",
          category: "other",
          chapterPosition: 8,
          actors: ["Dorothy", "Toto"],
          targets: [],
        },
      ],
      nextTextOffset: 6_200,
    }],
  );

  const choiceRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choices",
  );
  const choiceInput = JSON.parse(choiceRequest?.input ?? "{}") as {
    next_significant_event?: { eventId?: string };
    completed_action?: { playerAction?: string; actionResult?: string };
    setting?: { outcomeReason?: string };
  };
  const choiceReviewRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_choice_review",
  );
  const choiceReviewContext = JSON.parse(
    (choiceReviewRequest?.input ?? "").split("\n\nCHOICE NAVIGATION EVENT:", 1)[0]!,
  ) as {
    candidate_scene?: {
      playerAction?: string;
      actionResult?: string;
      outcomeReason?: string;
    };
  };

  assert.equal(sceneAttempt, 1);
  assert.equal(scene.sourceProgress?.eventId, "event_lion_joins");
  assert.equal(choiceInput.next_significant_event?.eventId, "event_ditch");
  assert.equal(choiceInput.completed_action?.playerAction, action);
  assert.match(choiceInput.completed_action?.actionResult ?? "", /Toto accepts/i);
  assert.match(choiceInput.setting?.outcomeReason ?? "", /now traveling/i);
  assert.equal(choiceReviewContext.candidate_scene?.playerAction, action);
  assert.match(choiceReviewContext.candidate_scene?.actionResult ?? "", /Toto accepts/i);
  assert.match(
    choiceReviewRequest?.instructions ?? "",
    /reenacts, restates, reconfirms, rehearses/i,
  );
  assert.equal(scene.choices.some((choice) => choice.text === replayChoice), false);
  assert.equal(
    scene.choices.some((choice) => choice.text.includes("deep ditch")),
    true,
  );
});

test("an ordinary turn cannot advance the source cursor past an unshown required event", async () => {
  const action = "Ask Patrick how the practical arrangements will work";
  let sceneAttempt = 0;
  const reviewRequests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        return scenePresenceReviewResponse(request);
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        reviewRequests.push(request);
        return {
          output_text: JSON.stringify({
            repeatsPriorScene: false,
            latestInputResolvedFaithfully: true,
            preservesPlayerPerspective: true,
            latestInputFailureType: "none",
            preservesPlayerAgency: true,
            staysWithinTurnScope: sceneAttempt !== 1,
            latestInputFailureReason: "",
            playerAgencyFailureReason: "",
            turnScopeFailureReason: sceneAttempt === 1
              ? "The detectives appear before the killing and police call."
              : "",
            requiredEventOccurred: false,
            anchorChoiceIndex: 0,
            reason: sceneAttempt === 1
              ? "The detectives appear before the required killing occurs."
              : "Patrick gives a concrete answer while the killing remains future.",
          }),
        };
      }
      sceneAttempt += 1;
      const jumpsToDetectives = sceneAttempt === 1;
      return {
        output_text: JSON.stringify({
          title: jumpsToDetectives ? "The detectives arrive" : "Terms discussed",
          text: jumpsToDetectives
            ? "Detectives question Mary about Patrick's death and accept her offer of supper."
            : "Patrick names a monthly allowance and says his solicitor will send the papers tomorrow.",
          choices: [
            { id: "figure", type: "action", text: "Ask Patrick to write down the figure" },
            { id: "timing", type: "action", text: "Ask when he plans to leave" },
          ],
          outcome: "active",
          outcomeReason: "Mary must decide how to respond.",
          playerAction: action,
          actionOutcome: "succeeded",
          actionResult: "Patrick answers Mary's question about the arrangements.",
          externalDevelopment: jumpsToDetectives
            ? "Detectives investigate Patrick's death."
            : "Patrick provides a specific allowance and timetable.",
          sourceChapterPosition: jumpsToDetectives ? 0 : null,
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_ordinary_source_chronology",
    book: { bookId: "book_lamb", title: "Lamb to the Slaughter" },
    playerName: "Mary Maloney",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A domestic drama.",
    },
    objective: "Navigate Patrick's announcement.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Patrick says he is leaving.",
    sourceCursor: { chapterPosition: 0, textOffset: 24 },
    scene: {
      title: "The announcement",
      text: "Patrick says he is leaving but will provide for Mary and the baby.",
      choices: [
        { id: "arrangements", type: "action", text: action },
        { id: "wait", type: "action", text: "Wait in silence" },
      ],
      outcome: "active",
    },
    history: [
      {
        kind: "scene",
        text: "Patrick says he is leaving but will provide for Mary and the baby.",
      },
      { kind: "choice", text: action },
    ],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  const scene = await new ProviderGameEngine(client, "minimal").continue(
    state,
    action,
    [{
      chapterPosition: 0,
      chapterTitle: "Lamb to the Slaughter",
      summary:
        "Patrick announces he is leaving. Mary kills him with a frozen lamb. She later calls the police.",
      excerpt: "Mary crossed the room and swung the frozen leg of lamb. Patrick fell.",
      requiredEvent: "Mary strikes Patrick with the frozen leg of lamb and kills him.",
      nextTextOffset: 96,
    }],
  );

  assert.equal(sceneAttempt, 2);
  assert.equal(scene.title, "Terms discussed");
  assert.equal(scene.sourceProgress, undefined);
  assert.match(reviewRequests[0]?.instructions ?? "", /source cursor may advance/i);
  assert.match(
    reviewRequests[0]?.instructions ?? "",
    /turnScopeFailureReason only to name.*skipped causal prerequisite.*advance beyond/i,
  );
  assert.match(
    reviewRequests[0]?.instructions ?? "",
    /merely leaving a source event in the future.*must never be copied/i,
  );
  assert.doesNotMatch(
    reviewRequests[0]?.instructions ?? "",
    /Direct source continuation authorizes the REQUIRED NEXT EVENT/i,
  );
});

test("source anchor selection can proactively choose a later chapter", async () => {
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      return {
        output_text: JSON.stringify({
          compatible: true,
          currentChapterPosition: 0,
          candidateIndex: 1,
          chapterPosition: 3,
          reason: "The current excerpt repeats the waiting setup; chapter four has the nearest concrete event.",
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_later_source_anchor",
    book: { bookId: "book_later_source_anchor", title: "Later Source Anchor" },
    wholeBookSummary: "SECRET SOURCE-SELECTION SUMMARY SENTINEL",
    playerName: "Mary",
    gameProfile: {
      category: "drama",
      endingMode: "completion",
      description: "A domestic drama.",
    },
    objective: "Reach the next concrete story development.",
    victoryCondition: "Reach the natural conclusion.",
    status: "active",
    selectedText: "Mary waits for Patrick.",
    sourceCursor: { chapterPosition: 0, textOffset: 24 },
    scene: {
      title: "Still waiting",
      text: "Mary rehearses the same greeting while awaiting Patrick.",
      choices: [
        { id: "wait", type: "action", text: "Keep waiting for Patrick" },
        { id: "leave", type: "action", text: "Leave the room" },
      ],
    },
    history: [
      {
        kind: "scene",
        text: "Mary rehearses the same greeting while awaiting Patrick.",
      },
      { kind: "choice", text: "Keep waiting for Patrick" },
    ],
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
  };
  const candidates = [{
    chapterPosition: 0,
    chapterTitle: "Waiting",
    summary: "Mary waits for Patrick.",
    excerpt: "Mary rehearses her greeting.",
    nextTextOffset: 53,
  }, {
    chapterPosition: 3,
    chapterTitle: "The arrival",
    summary: "Patrick arrives with consequential news.",
    excerpt: "Patrick's key turns in the lock.",
    nextTextOffset: 32,
  }];

  const selected = await new ProviderGameEngine(client, "minimal")
    .selectSourceCandidate(state, candidates);

  assert.equal(selected, candidates[1]);
  assert.match(requests[0]?.instructions ?? "", /select a later chapter/i);
  assert.match(requests[0]?.instructions ?? "", /navigation anchor/i);
  assert.match(requests[0]?.input ?? "", /"immediateTransition"/);
  assert.match(requests[0]?.input ?? "", /"kind": "selected_option"/);
  assert.doesNotMatch(
    requests[0]?.input ?? "",
    /SECRET SOURCE-SELECTION SUMMARY SENTINEL/,
  );
  assert.doesNotMatch(requests[0]?.input ?? "", /BOOK SUMMARY/);
});

test("source event blocks overlap and preserve absolute source offsets", () => {
  const blocks = buildSourceEventBlocks({
    chapterPosition: 3,
    chapterTitle: "A long chapter",
    summary: "Several events occur.",
    excerpt: "A".repeat(3_000),
    nextTextOffset: 5_000,
    recovery: true,
  });

  assert.deepEqual(
    blocks.map((block) => ({
      length: block.excerpt.length,
      start: block.nextTextOffset - block.excerpt.length,
      end: block.nextTextOffset,
    })),
    [
      { length: 1_500, start: 2_000, end: 3_500 },
      { length: 1_500, start: 3_300, end: 4_800 },
      { length: 400, start: 4_600, end: 5_000 },
    ],
  );
});

test("chapter recovery selection can identify the current chapter without a later chapter", () => {
  const candidates = [{
    chapterPosition: 4,
    chapterTitle: "The whole story",
    summary: "The arrival is followed by an announcement and a confrontation.",
    excerpt: "The complete bounded chapter context.",
    nextTextOffset: 37,
    recovery: true,
  }];

  assert.equal(
    resolveRecoveryChapterSelection(
      {
        compatible: false,
        currentChapterPosition: 4,
        candidateIndex: null,
        chapterPosition: null,
        reason: "The current and next events share one stored chapter.",
      },
      candidates,
    ),
    candidates[0],
  );
});

test("player availability includes the whole-book summary while bounding selected-moment text", () => {
  const book = {
    bookId: "book-id",
    sourceSha256: "sha256",
    title: "Test Book",
    chapters: [{
      index: 0,
      title: "The story",
      text: "Person Beta enters. Person Beta dies. Later, an investigator asks Person Alpha about an object. Future spoiler.",
    }],
    worldBible: {
      summary: "Whole story.",
      characters: ["Person Alpha"],
      characterProfiles: [{
        name: "Person Beta",
        aliases: ["Beta"],
        role: "Victim",
        description: "A person connected to Person Alpha.",
        traits: ["distant"],
        relationships: [{
          character: "Person Alpha",
          description: "Person Beta is connected to Person Alpha.",
        }],
        storyArc: "His decision triggers the central conflict.",
      }],
      locations: ["House"],
    },
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  const state: GameState = {
    gameId: "game-id",
    book: { bookId: book.bookId, title: book.title },
    position: { chapterIndex: 7, chapterTitle: "Wrong front matter" },
    playerName: "Beta",
    gameProfile: {
      category: "mystery",
      endingMode: "win",
      description: "Solve or evade the central crime.",
    },
    objective: "",
    victoryCondition: "",
    status: "active",
    selectedText: "Later, an investigator asks Person Alpha about an object.",
    scene: { title: "Starting", text: "", choices: [] },
    history: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const availability = buildPlayerAvailabilityContext(state, book);
  const context = JSON.parse(availability.context) as {
    canonical_book_character: boolean;
    player_character_profile: { name: string; role: string };
    position: { chapterIndex: number; chapterTitle: string };
    story_text_ending_at_selected_moment: string;
    whole_book_summary: string;
  };

  assert.equal(context.canonical_book_character, true);
  assert.equal(context.player_character_profile.name, "Person Beta");
  assert.equal(context.player_character_profile.role, "Victim");
  assert.equal(context.whole_book_summary, "Whole story.");
  assert.deepEqual(context.position, { chapterIndex: 0, chapterTitle: "The story" });
  assert.match(context.story_text_ending_at_selected_moment, /Person Beta dies/);
  assert.doesNotMatch(context.story_text_ending_at_selected_moment, /Future spoiler/);
});

test("unavailable players only require a rejection reason", () => {
  assert.deepEqual(
    normalizePlayerAvailability({
      playable: false,
      reason: "  The character cannot act in this scene.  ",
      objective: "",
      victoryCondition: "",
    }),
    {
      playable: false,
      reason: "The character cannot act in this scene.",
      objective: "",
      victoryCondition: "",
    },
  );
});

test("playable players require game goals but not a confirmation reason", () => {
  assert.deepEqual(
    normalizePlayerAvailability({
      playable: true,
      reason: "",
      objective: "  Reach the harbor.  ",
      victoryCondition: "  Arrive safely.  ",
    }),
    {
      playable: true,
      reason: "",
      objective: "Reach the harbor.",
      victoryCondition: "Arrive safely.",
    },
  );
  assert.throws(
    () => normalizePlayerAvailability({
      playable: true,
      reason: "The character can act here.",
      objective: "",
      victoryCondition: "",
    }),
    /without complete game goals/,
  );
});

test("player availability normalizes a language-independent established event", () => {
  assert.deepEqual(
    normalizeEstablishedEventAssessment({
      established: true,
      reason: "Een onomkeerbare bronactie bepaalt de opening.",
      event: {
        category: "death",
        actor: "Mary Maloney",
        action: "  Sloeg Patrick neer.  ",
        target: "Patrick Maloney",
        means: "  Een bevroren lamsbout  ",
        immediateConsequences: ["  Patrick overleed.  "],
        sourceBacked: true,
        narrative: "  Mary sloeg Patrick met de bevroren lamsbout; hij stortte dood neer.  ",
      },
    }),
    {
      category: "death",
      actor: "Mary Maloney",
      action: "Sloeg Patrick neer.",
      target: "Patrick Maloney",
      means: "Een bevroren lamsbout",
      immediateConsequences: ["Patrick overleed."],
      sourceBacked: true,
      narrative: "Mary sloeg Patrick met de bevroren lamsbout; hij stortte dood neer.",
    },
  );
  assert.throws(
    () => normalizeEstablishedEventAssessment({
      established: true,
      reason: "Ongeldig event.",
      event: {
        category: "death",
        actor: "Mary",
        action: "",
        target: "Patrick",
        means: "",
        immediateConsequences: [],
        sourceBacked: false,
        narrative: "",
      },
    }),
    /incomplete or ungrounded established event/,
  );
});

test("terminal victory scenes remove choices", () => {
  const scene = normalizeSceneTalkChoices({
    title: "Confession",
    text: "Person Alpha explicitly admits responsibility for harming Person Beta.",
    choices: [
      { id: "continue", type: "action", text: "Continue questioning" },
      { id: "leave", type: "action", text: "Leave" },
    ],
    outcome: "won",
    outcomeReason: "The actual culprit confessed.",
  });

  assert.equal(scene.outcome, "won");
  assert.equal(scene.outcomeReason, "The actual culprit confessed.");
  assert.deepEqual(scene.choices, []);
});

test("natural story endings complete without declaring a winner", () => {
  const scene = normalizeSceneTalkChoices({
    title: "Journey's end",
    text: "The expedition reaches its natural destination.",
    choices: [
      { id: "continue", type: "action", text: "Continue beyond the ending" },
      { id: "return", type: "action", text: "Return home" },
    ],
    outcome: "completed",
    outcomeReason: "The role-specific journey has reached its conclusion.",
  });

  assert.equal(scene.outcome, "completed");
  assert.equal(scene.outcomeReason, "The role-specific journey has reached its conclusion.");
  assert.deepEqual(scene.choices, []);
});


test("source beat progress infers prerequisites through the latest completed beat", () => {
  assert.deepEqual(
    normalizeCompletedSourceEventBeatIndexes([0, 2, 3, 99, -1], 4),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    normalizeCompletedSourceEventBeatIndexes([2, 1, 0, 1], 4),
    [0, 1, 2],
  );
  assert.deepEqual(
    normalizeCompletedSourceEventBeatIndexes([3, 4], 5),
    [0, 1, 2, 3, 4],
  );
});

test("an incomplete beat prefix cannot be upgraded by a reported event id", () => {
  assert.equal(
    reviewedSourceEventIdForBeatProgress(
      "event_travel",
      "event_travel",
      [0, 1],
      3,
    ),
    null,
  );
  assert.equal(
    reviewedSourceEventIdForBeatProgress(
      "event_travel",
      "event_travel",
      [0, 1, 2],
      3,
    ),
    "event_travel",
  );
  assert.equal(
    reviewedSourceEventIdForBeatProgress(
      "event_without_beats",
      "event_without_beats",
      [],
      0,
    ),
    "event_without_beats",
  );
});

test("source beat progress exposes completed, next, and remaining beats", () => {
  const beats: StoryEventBeat[] = [
    {
      actor: "Scarecrow",
      action: "asks Dorothy if he may travel with her",
      targets: ["Dorothy"],
      agency: "intentional",
      stakes: "meaningful",
      sourceReferences: [],
    },
    {
      actor: "Dorothy",
      action: "invites Scarecrow to join her",
      targets: ["Scarecrow"],
      agency: "intentional",
      stakes: "meaningful",
      sourceReferences: [],
    },
    {
      actor: "Scarecrow",
      action: "accepts Dorothy's invitation",
      targets: ["Dorothy"],
      agency: "intentional",
      stakes: "meaningful",
      sourceReferences: [],
    },
  ];
  const progress = buildSourceEventBeatProgressContext(
    {
      eventId: "event_join",
      description: "Scarecrow joins Dorothy.",
      chapterPosition: 1,
      beats,
    },
    {
      eventId: "event_join",
      completedBeatIndexes: [0, 1],
    },
  );

  assert.deepEqual(progress?.completedBeatIndexes, [0, 1]);
  assert.deepEqual(progress?.completedBeats, beats.slice(0, 2));
  assert.deepEqual(progress?.nextRequiredBeat, beats[2]);
  assert.deepEqual(progress?.remainingBeats, beats.slice(2));
});


test("opening keeps player beats pending and stages their physical prerequisites", async () => {
  const requests: AiResponseRequest[] = [];
  let sceneAttempt = 0;
  let presenceReviews = 0;
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return validSceneRepetitionReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        presenceReviews += 1;
        const input = JSON.parse(String(request.input)) as {
          candidate_scene?: { text?: string };
        };
        const sceneText = input.candidate_scene?.text ?? "";
        const setupSupported = /fixed high on the pole/i.test(sceneText);
        const completedBeatIndexes = /wink and nod/i.test(sceneText) ? [0] : [];
        return scenePresenceReviewResponse(
          request,
          null,
          completedBeatIndexes,
          setupSupported,
          true,
        );
      }
      if (request.text?.format.name === "bookrpg_scene_choices") {
        return {
          output_text: JSON.stringify({
            choices: [
              {
                id: "ask",
                type: "action",
                text: "Wink and nod at Dorothy from the pole",
                character: "Dorothy",
                stakes: "meaningful",
              },
              {
                id: "look",
                type: "action",
                text: "Look down the road",
                character: null,
                stakes: "routine",
              },
            ],
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse(0);
      }
      sceneAttempt += 1;
      return {
        output_text: JSON.stringify({
          title: "Waiting on the Pole",
          text: sceneAttempt === 1
            ? Array.from({ length: 121 }, () => "word").join(" ")
            : sceneAttempt === 2
              ? "I remain fixed high on the pole above the corn and wink and nod as Dorothy comes into view along the field path."
              : "I remain fixed high on the pole above the corn while Dorothy comes into view along the field path.",
          outcome: "active",
          outcomeReason: "The Scarecrow can choose what to do next.",
          playerAction: "",
          actionOutcome: "none",
          actionResult: "",
          externalDevelopment: "Dorothy comes within sight of the Scarecrow's pole.",
          sourceChapterPosition: null,
          sceneScope: {
            currentLocation: "The pole in the cornfield",
            peoplePresent: ["Dorothy"],
            peopleWithinSpeakingDistance: ["Dorothy"],
          },
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_opening_established_beats",
    book: { bookId: "book_oz", title: "The Wonderful Wizard of Oz" },
    playerName: "Scarecrow",
    gameProfile: {
      category: "fantasy",
      endingMode: "open_ended",
      description: "A fantasy journey.",
    },
    objective: "Seek brains.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Dorothy discovers and frees the living Scarecrow.",
    sourceCursor: { chapterPosition: 2, textOffset: 100 },
    characterProfiles: [],
    scene: { title: "Starting...", text: "", choices: [] },
    history: [{ kind: "start", text: "The Wonderful Wizard of Oz" }],
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  const beats: StoryEventBeat[] = [
    {
      actor: "Scarecrow",
      action: "winks and nods to attract Dorothy's attention",
      targets: ["Dorothy"],
      agency: "intentional",
      stakes: "significant",
      sourceReferences: [],
    },
    {
      actor: "Dorothy",
      action: "approaches the Scarecrow after seeing him move",
      targets: ["Scarecrow"],
      agency: "intentional",
      stakes: "significant",
      sourceReferences: [],
    },
    {
      actor: "Scarecrow",
      action: "explains that the pole is stuck in his back",
      targets: ["Dorothy"],
      agency: "intentional",
      stakes: "significant",
      sourceReferences: [],
    },
    {
      actor: "Dorothy",
      action: "lifts the Scarecrow off the pole and frees him",
      targets: ["Scarecrow"],
      agency: "intentional",
      stakes: "critical",
      sourceReferences: [],
    },
    {
      actor: "Scarecrow",
      action: "walks beside Dorothy after being freed",
      targets: ["Dorothy"],
      agency: "intentional",
      stakes: "significant",
      sourceReferences: [],
    },
  ];
  const result = await new ProviderGameEngine(client, "minimal").start(state, [{
    chapterPosition: 2,
    chapterTitle: "The Scarecrow",
    summary: "Dorothy discovers and frees the living Scarecrow.",
    excerpt: "The Scarecrow was still fastened to his pole when Dorothy came along the cornfield path.",
    currentStoryEvent: {
      eventId: "event_freed",
      sequence: 4,
      description: "Dorothy discovers and frees the living Scarecrow.",
      chapterPosition: 2,
      beats,
    },
    storyEvents: [{
      eventId: "event_freed",
      sequence: 4,
      description: "Dorothy discovers and frees the living Scarecrow.",
      chapterPosition: 2,
      beats,
    }],
    nextTextOffset: 300,
  }]);

  const presenceRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_presence_review",
  );
  const presenceInput = JSON.parse(presenceRequest?.input ?? "{}") as {
    event_review_target_mode?: string;
    previous_completed_source_event_beat_indexes?: number[];
  };
  assert.equal(
    presenceInput.event_review_target_mode,
    "opening_progression",
  );
  assert.deepEqual(
    presenceInput.previous_completed_source_event_beat_indexes,
    [],
  );
  assert.equal(result.sourceProgress, undefined);
  assert.equal(result.sourceEventProgress, undefined);
  assert.equal(sceneAttempt, 3);
  assert.equal(presenceReviews, 3);
  assert.match(result.text, /fixed high on the pole/i);
  assert.doesNotMatch(result.text, /wink and nod/i);
  assert.ok(result.text.trim().split(/\s+/u).length <= 120);
  assert.match(result.choices[0]?.text ?? "", /wink and nod.*Dorothy/i);
  const sceneRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  assert.match(sceneRequest?.input ?? "", /"opening_player_future_actions"/);
  assert.match(sceneRequest?.input ?? "", /"next_significant_event_progress"/);
  assert.match(sceneRequest?.input ?? "", /"next_required_beat"/);
  assert.match(sceneRequest?.input ?? "", /winks and nods to attract Dorothy's attention/i);
  assert.match(
    sceneRequest?.input ?? "",
    /The Scarecrow was still fastened to his pole when Dorothy came along/i,
  );
  assert.match(
    String(sceneRequest?.input ?? ""),
    /next_significant_event_progress is authoritative for the opening/i,
  );
  assert.match(sceneRequest?.input ?? "", /explains that the pole is stuck in his back/i);
  assert.match(
    presenceRequest?.input ?? "",
    /still fastened to his pole when Dorothy came along/i,
  );
});


async function assertFuturePlayerSetup(npcPrelude: boolean) {
  const requests: AiResponseRequest[] = [];
  let sceneAttempt = 0;
  const action = "Listen while the host explains the rules";
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      if (request.text?.format.name === "bookrpg_scene_repetition_review") {
        return validSceneRepetitionReviewResponse();
      }
      if (request.text?.format.name === "bookrpg_scene_presence_review") {
        const input = JSON.parse(String(request.input)) as {
          candidate_scene?: { text?: string };
        };
        const setupSupported = /standing on the chair/i.test(
          input.candidate_scene?.text ?? "",
        );
        return scenePresenceReviewResponse(
          request,
          null,
          npcPrelude ? [0] : [],
          setupSupported,
          true,
        );
      }
      if (request.text?.format.name === "bookrpg_scene_choices") {
        return {
          output_text: JSON.stringify({
            choices: [
              {
                id: "ask_down",
                type: "action",
                text: "Ask whether I may get down from the chair",
                character: "Host",
                stakes: "meaningful",
              },
              {
                id: "wait",
                type: "action",
                text: "Wait for another instruction",
                character: "Host",
                stakes: "routine",
              },
            ],
          }),
        };
      }
      if (request.text?.format.name === "bookrpg_scene_choice_review") {
        return validSceneChoiceReviewResponse(0);
      }
      sceneAttempt += 1;
      return {
        output_text: JSON.stringify({
          title: "The rules",
          text: sceneAttempt === 1
            ? "The host finishes explaining the rules and looks at me expectantly."
            : "Still standing on the chair, I listen as the host finishes explaining the rules and looks at me expectantly.",
          outcome: "active",
          outcomeReason: "I must decide what to ask next.",
          playerAction: action,
          actionOutcome: "succeeded",
          actionResult: "I listen to the host's explanation.",
          externalDevelopment: "The host finishes explaining the rules.",
          sourceChapterPosition: null,
          sceneScope: {
            currentLocation: "The dining room",
            peoplePresent: ["Host"],
            peopleWithinSpeakingDistance: ["Host"],
          },
        }),
      };
    },
  };
  const state: GameState = {
    gameId: "game_later_future_action_setup",
    book: { bookId: "book_rules", title: "The Rules" },
    playerName: "Alex",
    gameProfile: {
      category: "drama",
      endingMode: "open_ended",
      description: "A tense social drama.",
    },
    objective: "Navigate the host's rules.",
    victoryCondition: "Reach meaningful milestones.",
    status: "active",
    selectedText: "Alex is made to stand on a chair while the rules are explained.",
    sourceCursor: {
      chapterPosition: 1,
      textOffset: 120,
      eventId: "event_rules_explained",
    },
    establishedEvent: {
      category: "other",
      actor: "Host",
      action: "Explains the rules to Alex",
      target: "Alex",
      means: "Speech",
      immediateConsequences: ["Alex knows the rules."],
      sourceBacked: true,
      narrative: "The host explains the rules to Alex.",
    },
    characterProfiles: [{
      name: "Host",
      aliases: ["the host"],
      role: "Rule keeper",
      description: "The person enforcing the rules.",
      traits: ["strict"],
      relationships: [],
      storyArc: "Explains and enforces the rules.",
    }],
    scene: {
      title: "Instructions",
      text: "The host begins explaining a strict set of rules.",
      choices: [{ id: "listen", type: "action", text: action }],
      sceneScope: {
        currentLocation: "The dining room",
        peoplePresent: ["Host"],
        peopleWithinSpeakingDistance: ["Host"],
      },
      outcome: "active",
    },
    history: [
      { kind: "scene", text: "The host begins explaining a strict set of rules." },
      { kind: "choice", text: action },
    ],
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  const futureBeats: StoryEventBeat[] = [...(npcPrelude ? [{
    actor: "Host",
    action: "Finishes explaining the rules.",
    targets: ["Alex"],
    agency: "intentional" as const,
    stakes: "significant" as const,
    sourceReferences: [],
  }] : []), {
    actor: "Alex",
    action: "Asks whether they may get down from the chair.",
    targets: ["Host"],
    agency: "intentional",
    stakes: "significant",
    sourceReferences: [],
  }];
  const result = await new ProviderGameEngine(client, "minimal").continue(
    state,
    action,
    [{
      chapterPosition: 1,
      chapterTitle: "The Rules",
      summary: "Alex listens, then asks permission to get down from the chair.",
      excerpt: "Alex remained standing on the chair until there was a chance to ask permission to step down.",
      currentStoryEvent: {
        eventId: "event_rules_explained",
        sequence: 2,
        description: "The host explains the rules to Alex.",
        chapterPosition: 1,
      },
      requiredEvent: "Alex asks whether they may get down from the chair.",
      requiredEventId: "event_ask_down",
      requiredEventBeats: futureBeats,
      storyEvents: [{
        eventId: "event_ask_down",
        sequence: 3,
        description: "Alex asks whether they may get down from the chair.",
        chapterPosition: 1,
        actors: ["Alex"],
        targets: ["Host"],
        beats: futureBeats,
      }],
      nextTextOffset: 260,
    }],
  );

  assert.equal(sceneAttempt, 2);
  assert.match(result.text, /standing on the chair/i);
  assert.match(result.choices[0]?.text ?? "", /^Ask whether (?:I|they) may get down from the chair$/);
  const sceneRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene",
  );
  assert.match(sceneRequest?.input ?? "", /"next_player_future_actions"/);
  assert.match(
    sceneRequest?.input ?? "",
    /Asks whether they may get down from the chair/i,
  );
  assert.match(
    sceneRequest?.input ?? "",
    /remained standing on the chair/i,
  );
  const presenceRequest = requests.find(
    (request) => request.text?.format.name === "bookrpg_scene_presence_review",
  );
  assert.match(presenceRequest?.input ?? "", /"future_player_actions"/);
  assert.equal(JSON.parse(presenceRequest!.input!).candidate_scene.player_action, action);
  assert.match(presenceRequest?.input ?? "", /standing on the chair/i);
}

test("later scenes stage a compatible future player action without performing it", () =>
  assertFuturePlayerSetup(false));

test("NPC progress cannot bypass setup review for the newly exposed player choice", () =>
  assertFuturePlayerSetup(true));

