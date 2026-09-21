import {peopleKilledInSceneSchema} from '../shared/scene-deaths.js';
const choicesJsonSchema = {
  type: "array",
  minItems: 0,
  maxItems: 4,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: ["action", "talk"] },
      text: {
        type: "string",
        description: "An immediately executable choice whose implicit actor is player_identity. Never name player_identity or an alias as a separate participant, target, or non-player character in the choice. Preserve established world state. A choice may directly address, greet, hand something to, question, observe a reaction from, or otherwise interact with a non-player character only when that character is already established at the required location in sceneScope.peoplePresent (and in peopleWithinSpeakingDistance for immediate speech). Calling out for an absent character or listening, watching, or searching for possible signs of them is not direct interaction when the choice does not assume they hear, answer, arrive, or otherwise participate. Never write the choice as though an absent character has already arrived. If a desired source event needs an absent participant, offer only a presently executable prerequisite or transition toward that situation. Never require a dead character to act, arrive, return, speak, react, or notice something; never erase an established departure, injury, death, object state, or other irreversible fact.",
      },
      character: {
        type: ["string", "null"],
        description: "For talk, the exact non-player conversation target. For action, the exact known non-player character whose physical participation is required now; null when no non-player character must be present, including preparation, anticipation, calling out for, or listening or watching for an absent person. Never set this to player_identity or one of their aliases.",
      },
      requiredPresentCharacters: {
        type: "array",
        maxItems: 8,
        items: { type: "string" },
        description: "Exact known non-player character names who must already be physically present for this choice to make sense now. Include direct interaction targets.",
      },
      requiredAbsentCharacters: {
        type: "array",
        maxItems: 8,
        items: { type: "string" },
        description: "Exact known non-player character names who must still be absent for this choice to make sense, such as someone whose arrival or return the choice waits or watches for, prepares for, or calls out for without assuming a response.",
      },
      sourceAnchorRoute: {
        type: ["string", "null"],
        enum: ["event", "transition", null],
        description: "For choices[0] only when next_significant_event exists: 'event' means resolving this exact choice either performs all required meaningful player-controlled beats or directly creates conditions for the event's involuntary, external, non-player, or routine beats to occur in the next scene. 'transition' means a separate meaningful player decision, remote prerequisite, or substantial time/location transition remains. Use null for every other choice and when no next_significant_event exists.",
      },
      stakes: {
        type: "string",
        enum: ["routine", "significant", "critical"],
      },
    },
    required: [
      "id",
      "type",
      "text",
      "character",
      "requiredPresentCharacters",
      "requiredAbsentCharacters",
      "sourceAnchorRoute",
      "stakes",
    ],
  },
} as const;

export const sceneChoiceMenuJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    choices: {
      ...choicesJsonSchema,
      minItems: 2,
      description: "Choices must be executable from the exact decision point represented by the supplied sceneScope. Do not jump across an unseen arrival, departure, location change, discovery, conversation, or other causal prerequisite merely because it appears in future source material.",
    },
  },
  required: ["choices"],
} as const;

export const sourceAnchorRouteReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sourceAnchorRoute: {
      type: "string",
      enum: ["event", "transition"],
    },
    reason: { type: "string" },
  },
  required: ["sourceAnchorRoute", "reason"],
} as const;

const storyMemoryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    openThreads: {
      type: "array",
      minItems: 0,
      maxItems: 6,
      items: { type: "string" },
    },
    canonFacts: {
      type: "array",
      minItems: 0,
      maxItems: 12,
      items: {
        type: "string",
        description: "A durable established fact that future scenes, choices, and source adaptation must not contradict, especially deaths, injuries, departures, irreversible relationship changes, acquired or destroyed objects, and binding world rules.",
      },
    },
  },
  required: ["summary", "openThreads", "canonFacts"],
} as const;

const sceneScopeJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    currentLocation: { type: "string" },
    peoplePresent: {
      type: "array",
      minItems: 0,
      maxItems: 16,
      items: { type: "string" },
      description: "Every confirmed living non-player character physically present and interactable at currentLocation at the decision point, including animals and nonhuman characters. Include known characters hiding within the current room even when not visible, unable to speak or beyond immediate physical reach; presence does not require touching them or grant speech. Use only an exact name or alias from the known character profiles, without decorating or qualifying the identity. Always include player_identity exactly once, including a nonhuman player. Exclude corpses, dead characters, anyone absent or departed, anticipated arrivals, and uncertain identities.",
    },
    peopleWithinSpeakingDistance: {
      type: "array",
      minItems: 0,
      maxItems: 16,
      items: { type: "string" },
      description: "Only confirmed living non-player characters from peoplePresent who can immediately hear and answer the player without movement or a transition. Use only an exact name or alias from the known character profiles, without decorating or qualifying the identity. Also include player_identity exactly once as the spatial reference, without granting speech or making the player an NPC target. Exclude corpses, dead characters, absent or departed characters, anticipated arrivals, and uncertain identities.",
    },
  },
  required: [
    "currentLocation",
    "peoplePresent",
    "peopleWithinSpeakingDistance",
  ],
} as const;

export const scenePresenceReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    peopleKilledInScene: peopleKilledInSceneSchema,
    peoplePresent: {
      type: "array",
      maxItems: 16,
      items: { type: "string" },
      description: "The player plus confirmed living, physically present, interactable non-player characters at the candidate scene's currentLocation, using exact unqualified names.",
    },
    peopleWithinSpeakingDistance: {
      type: "array",
      maxItems: 16,
      items: { type: "string" },
      description: "The player exactly once, plus confirmed characters from peoplePresent who can immediately hear and answer the player without movement or a transition.",
    },
    latestVisibleSourceEventId: {
      type: ["string", "null"],
      description: "Exact eventId of the latest supplied ordered source event visibly completed in the candidate scene, or null when none is completed.",
    },
    completedSourceEventBeatIndexes: {
      type: "array",
      maxItems: 32,
      items: { type: "integer", minimum: 0 },
      description: "Zero-based indexes of additional event_review_target beats visibly completed by the candidate scene; exclude indexes already listed as previously completed.",
    },
    futureActionSetupRequired: {
      type: "boolean",
      description: "Whether the candidate remains causally compatible with a still-future meaningful player beat whose physical or social prerequisites must be established at this decision point.",
    },
    futureActionSetupSupported: {
      type: "boolean",
      description: "Whether the candidate visibly establishes the required prerequisites without performing the future player action. True when futureActionSetupRequired is false.",
    },
    futureActionSetupReason: { type: "string" },
    reason: { type: "string" },
  },
  required: [
    "peopleKilledInScene",
    "peoplePresent",
    "peopleWithinSpeakingDistance",
    "latestVisibleSourceEventId",
    "completedSourceEventBeatIndexes",
    "futureActionSetupRequired",
    "futureActionSetupSupported",
    "futureActionSetupReason",
    "reason",
  ],
} as const;

export const sceneJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    peopleKilledInScene: peopleKilledInSceneSchema,
    title: { type: "string" },
    text: { type: "string" },
    playerAction: { type: "string" },
    actionOutcome: {
      type: "string",
      enum: ["none", "succeeded", "partially_succeeded", "failed", "interrupted"],
    },
    actionResult: { type: "string" },
    externalDevelopment: { type: "string" },
    sourceChapterPosition: { type: ["integer", "null"] },
    storyMemory: storyMemoryJsonSchema,
    sceneScope: sceneScopeJsonSchema,
    choices: choicesJsonSchema,
    outcome: { type: "string", enum: ["active", "won", "completed", "lost"] },
    outcomeReason: { type: "string" },
  },
  required: [
    "peopleKilledInScene",
    "title",
    "text",
    "playerAction",
    "actionOutcome",
    "actionResult",
    "externalDevelopment",
    "sourceChapterPosition",
    "storyMemory",
    "sceneScope",
    "choices",
    "outcome",
    "outcomeReason",
  ],
} as const;

export const lossReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    avoidable: { type: "boolean" },
    reason: { type: "string" },
    continuation: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            text: { type: "string" },
            choices: choicesJsonSchema,
            sceneScope: sceneScopeJsonSchema,
            development: { type: "string" },
            outcome: { type: "string", enum: ["active"] },
            outcomeReason: { type: "string" },
          },
          required: [
            "title",
            "text",
            "choices",
            "sceneScope",
            "development",
            "outcome",
            "outcomeReason",
          ],
        },
      ],
    },
  },
  required: ["avoidable", "reason", "continuation"],
} as const;

export const dialogueSceneJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    playerUtterance: { type: "string" },
    playerIntent: { type: "string" },
    intentType: {
      type: "string",
      enum: ["question", "statement", "accusation", "threat", "departure", "action", "other"],
    },
    responseSpeaker: { type: "string" },
    responseAnchor: { type: "string" },
    characterResponse: { type: "string" },
    narration: { type: "string" },
    sourceChapterPosition: { type: ["integer", "null"] },
    storyMemory: storyMemoryJsonSchema,
    sceneScope: sceneScopeJsonSchema,
    outcome: { type: "string", enum: ["active", "won", "completed", "lost"] },
    outcomeReason: { type: "string" },
  },
  required: [
    "title",
    "playerUtterance",
    "playerIntent",
    "intentType",
    "responseSpeaker",
    "responseAnchor",
    "characterResponse",
    "narration",
    "sourceChapterPosition",
    "storyMemory",
    "sceneScope",
    "outcome",
    "outcomeReason",
  ],
} as const;

export const sceneRepetitionReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    repeatsPriorScene: { type: "boolean" },
    latestInputResolvedFaithfully: { type: "boolean" },
    preservesPlayerPerspective: { type: "boolean" },
    latestInputFailureType: {
      type: "string",
      enum: ["none", "stalled", "omitted", "contradicted", "identity_or_roles"],
    },
    preservesPlayerAgency: { type: "boolean" },
    staysWithinTurnScope: { type: "boolean" },
    latestInputFailureReason: { type: "string" },
    playerPerspectiveFailureReason: { type: "string" },
    playerAgencyFailureReason: { type: "string" },
    turnScopeFailureReason: { type: "string" },
    requiredEventOccurred: { type: "boolean" },
    nonInteractableCharacters: {
      type: "array",
      items: { type: "string" },
      description:
        "Named characters from recent_prior_scenes or candidate_scene who are dead, a corpse, "
        + "or otherwise established as departed/gone and therefore cannot be physically present, "
        + "spoken to, or otherwise interacted with right now. Empty when none apply.",
    },
    nonInteractableCharactersReason: { type: "string" },
    reason: { type: "string" },
  },
  required: [
    "repeatsPriorScene",
    "latestInputResolvedFaithfully",
    "preservesPlayerPerspective",
    "latestInputFailureType",
    "preservesPlayerAgency",
    "staysWithinTurnScope",
    "latestInputFailureReason",
    "playerPerspectiveFailureReason",
    "playerAgencyFailureReason",
    "turnScopeFailureReason",
    "requiredEventOccurred",
    "nonInteractableCharacters",
    "nonInteractableCharactersReason",
    "reason",
  ],
} as const;

export const sceneChoiceReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    anchorChoiceIndex: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 3,
    },
    unusableChoiceIndexes: {
      type: "array",
      items: {
        type: "integer",
        minimum: 0,
        maximum: 3,
      },
      maxItems: 4,
    },
    unusableChoicesReason: { type: "string" },
    reason: { type: "string" },
  },
  required: [
    "anchorChoiceIndex",
    "unusableChoiceIndexes",
    "unusableChoicesReason",
    "reason",
  ],
} as const;

function constrainSourceChapterPositions<
  const Schema extends { properties: Record<string, unknown> },
>(
  schema: Schema,
  chapterPositions: readonly number[],
) {
  return {
    ...schema,
    properties: {
      ...schema.properties,
      sourceChapterPosition: {
        type: ["integer", "null"],
        enum: [null, ...new Set(chapterPositions)],
      },
    },
  };
}

export function sceneJsonSchemaForSourceChapters(
  chapterPositions: readonly number[],
) {
  return constrainSourceChapterPositions(sceneJsonSchema, chapterPositions);
}

export function sceneSettingJsonSchemaForSourceChapters(
  chapterPositions: readonly number[],
) {
  const { choices: _choices, ...properties } = sceneJsonSchema.properties;
  return constrainSourceChapterPositions({
    ...sceneJsonSchema,
    properties,
    required: sceneJsonSchema.required.filter((field) => field !== "choices"),
  }, chapterPositions);
}

export function dialogueSceneJsonSchemaForSourceChapters(
  chapterPositions: readonly number[],
) {
  return constrainSourceChapterPositions(dialogueSceneJsonSchema, chapterPositions);
}

export const playerAvailabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    playable: { type: "boolean" },
    reason: { type: "string" },
    objective: { type: "string" },
    victoryCondition: { type: "string" },
  },
  required: ["playable", "reason", "objective", "victoryCondition"],
} as const;

const establishedEventJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: {
      type: "string",
      enum: [
        "death",
        "violence",
        "betrayal",
        "disaster",
        "abduction",
        "accident",
        "other",
      ],
    },
    actor: { type: "string" },
    action: { type: "string" },
    target: { type: "string" },
    means: { type: "string" },
    immediateConsequences: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string" },
    },
    sourceBacked: { type: "boolean", const: true },
    narrative: { type: "string" },
  },
  required: [
    "category",
    "actor",
    "action",
    "target",
    "means",
    "immediateConsequences",
    "sourceBacked",
    "narrative",
  ],
} as const;

export const establishedEventAssessmentJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    established: { type: "boolean" },
    reason: { type: "string" },
    event: {
      anyOf: [
        establishedEventJsonSchema,
        { type: "null" },
      ],
    },
  },
  required: ["established", "reason", "event"],
} as const;

export const bookGameProfileJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: {
      type: "string",
      enum: ["mystery", "adventure", "survival", "drama", "exploration", "open_ended"],
    },
    endingMode: {
      type: "string",
      enum: ["win", "completion", "open_ended"],
    },
    description: { type: "string" },
  },
  required: ["category", "endingMode", "description"],
} as const;

export const talkJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    character: { type: "string" },
    prompt: { type: "string" },
    suggestions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "string",
        description: "The player's exact first-person spoken words, not an instruction or third-person summary of what the player should say.",
      },
    },
  },
  required: ["character", "prompt", "suggestions"],
} as const;

const sourceContinuationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    compatible: {
      type: "boolean",
      description: "True only when the selected canonical continuation remains causally reachable from established player-facing world state. Established deaths, departures, injuries, destroyed objects, and other irreversible facts cannot be undone merely to restore canon. A canonical player action is not immediately reachable merely because it is next in the book: every external prerequisite needed to execute it must already be established or must first be introduced by a separate world-state transition.",
    },
    currentChapterPosition: { type: ["integer", "null"] },
    candidateIndex: { type: ["integer", "null"] },
    chapterPosition: { type: ["integer", "null"] },
    reason: { type: "string" },
  },
  required: [
    "compatible",
    "currentChapterPosition",
    "candidateIndex",
    "chapterPosition",
    "reason",
  ],
} as const;

export function sourceContinuationJsonSchemaForCandidates(
  chapterPositions: readonly number[],
) {
  return {
    ...sourceContinuationJsonSchema,
    properties: {
      ...sourceContinuationJsonSchema.properties,
      candidateIndex: {
        type: ["integer", "null"],
        enum: [
          null,
          ...Array.from({ length: chapterPositions.length }, (_, index) => index),
        ],
      },
      currentChapterPosition: {
        type: ["integer", "null"],
        enum: [null, ...new Set(chapterPositions)],
      },
      chapterPosition: {
        type: ["integer", "null"],
        enum: [null, ...new Set(chapterPositions)],
      },
    },
  };
}

export function sourceEventJsonSchemaForBlocks(blockCount: number) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      compatible: {
        type: "boolean",
        description: "True only if the chosen source event can still occur without contradicting the current or recent player-facing state. An earlier canonical event made impossible by an established irreversible fact is invalidated, not merely pending. Never resurrect a dead character, reverse an established departure or injury, recreate a destroyed object, or erase an established action to make an event compatible. For a player-authored event, distinguish 'eventually reachable' from 'executable now': if direct interaction requires another participant who is not yet established present, that participant's arrival or other independent prerequisite must be introduced before the player action can be offered. Prefer the earliest supplied source beat that establishes the missing prerequisite; never silently jump across it. If a later supplied event remains independently reachable, select that earliest reachable event instead; otherwise return false.",
      },
      blockIndex: {
        type: ["integer", "null"],
        enum: [null, ...Array.from({ length: blockCount }, (_, index) => index)],
        description: "The source block containing the earliest still-reachable event or necessary prerequisite after excluding earlier events invalidated by established irreversible world state. Do not point directly at a player interaction that assumes an absent participant has already arrived.",
      },
      eventId: {
        type: ["string", "null"],
        description: "The earliest ordered significant event that is both unshown and causally reachable from the current state. Do not return an event whose actor is established dead or otherwise incapable of performing it. When a player-authored event depends on an absent non-player participant, do not treat the player action as immediately executable until the participant's prerequisite arrival or presence has been established.",
      },
      event: {
        type: "string",
        description: "One concise description of the selected still-reachable event or prerequisite beat. It must preserve established world state and may adapt canonical details, but must never undo irreversible player-facing facts or imply that an absent participant is already present.",
      },
      reason: { type: "string" },
    },
    required: ["compatible", "blockIndex", "eventId", "event", "reason"],
  } as const;
}

