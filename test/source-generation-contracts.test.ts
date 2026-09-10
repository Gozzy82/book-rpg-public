import assert from "node:assert/strict";
import test from "node:test";

import {
  CHOICE_TIMELINE_RULES,
  SOURCE_GROUNDING_RULES,
  TURN_SCOPE_RULES,
} from "../src/ai/engine/rules.js";
import {
  buildGameContext,
} from "../src/ai/engine/scene-context.js";
import {
  sourceEventNextPlayerChoiceBeats,
} from "../src/ai/engine/source-navigation.js";
import type {
  SourceContinuationCandidate,
} from "../src/ai/engine/core.js";
import {
  sourceReferenceKey,
} from "../src/books/source-index/chapter-index.js";
import type {
  GameState,
  StoryEventBeat,
} from "../src/shared/contracts.js";

const externalBeat: StoryEventBeat = {
  actor: null,
  action: "The cyclone lifts the farmhouse from its foundations.",
  targets: ["Dorothy", "Toto"],
  agency: "external",
  stakes: "significant",
  sourceReferences: [{
    chapterPosition: 0,
    chapterIndex: 0,
    lineStart: 10,
    lineEnd: 12,
  }],
};

const involuntaryBeat: StoryEventBeat = {
  actor: "Dorothy",
  action: "Loses her footing when the airborne house lurches.",
  targets: [],
  agency: "involuntary",
  stakes: "significant",
  sourceReferences: [{
    chapterPosition: 0,
    chapterIndex: 0,
    lineStart: 13,
    lineEnd: 15,
  }],
};

const playerBeat: StoryEventBeat = {
  actor: "Dorothy",
  action: "Pulls Toto away from the open trap door.",
  targets: ["Toto"],
  agency: "intentional",
  stakes: "significant",
  sourceReferences: [{
    chapterPosition: 0,
    chapterIndex: 0,
    lineStart: 16,
    lineEnd: 18,
  }],
};

test("external and involuntary beats form one automatic prefix before the next player decision", () => {
  const nextPlayerBeats = sourceEventNextPlayerChoiceBeats(
    {
      eventId: "cyclone",
      description: "The cyclone carries the farmhouse away.",
      chapterPosition: 0,
      beats: [externalBeat, involuntaryBeat, playerBeat],
    },
    "Dorothy",
  );

  assert.deepEqual(nextPlayerBeats, [playerBeat]);

  const sourceRules = SOURCE_GROUNDING_RULES.join("\n");
  const scopeRules = TURN_SCOPE_RULES.join("\n");
  assert.match(sourceRules, /consecutive unfinished ordered beats.*external.*involuntary/i);
  assert.match(sourceRules, /same generated scene/i);
  assert.match(scopeRules, /automatic progression window/i);
  assert.match(scopeRules, /do not force a player decision between those beats/i);
});

test("choice contract requires the selected action to be possible from visible prose", () => {
  const rules = CHOICE_TIMELINE_RULES.join("\n");

  assert.match(rules, /main voluntary verb must be able to begin immediately/i);
  assert.match(rules, /Catch a fish/i);
  assert.match(rules, /player fishing with access to fish/i);
  assert.match(rules, /Start fishing/i);
});

test("game context sends beat-specific source text for the automatic prefix", () => {
  const event = {
    eventId: "cyclone",
    sequence: 1,
    description: "The cyclone carries the farmhouse away.",
    chapterPosition: 0,
    actors: ["Dorothy", "Toto"],
    targets: ["Dorothy", "Toto"],
    beats: [externalBeat, involuntaryBeat, playerBeat],
  };
  const candidate = {
    chapterPosition: 0,
    chapterTitle: "The Cyclone",
    summary: "A cyclone strikes the farm.",
    excerpt: "A broader bounded excerpt around the cyclone.",
    storyEvents: [event],
    requiredEvent: event.description,
    requiredEventId: event.eventId,
    requiredEventBeats: event.beats,
    sourceReferenceExcerpts: {
      [sourceReferenceKey(externalBeat.sourceReferences[0]!)]:
        "The house whirled around two or three times and rose slowly through the air.",
      [sourceReferenceKey(involuntaryBeat.sourceReferences[0]!)]:
        "Dorothy lost her footing as the floor pitched beneath her.",
      [sourceReferenceKey(playerBeat.sourceReferences[0]!)]:
        "Toto slipped toward the opening and Dorothy reached for him.",
    },
  } as SourceContinuationCandidate;
  const state = {
    book: { bookId: "oz", title: "The Wonderful Wizard of Oz" },
    playerName: "Dorothy",
    characterProfiles: [],
    parameters: [],
    gameProfile: {
      category: "adventure",
      description: "Adventure",
      endingMode: "open_ended",
    },
    objective: "Survive the journey.",
    victoryCondition: "",
    status: "active",
    selectedText: "Kansas farm",
    history: [],
    sourceEventProgress: {
      eventId: event.eventId,
      completedBeatIndexes: [],
    },
    sourceIntroducedCharacters: ["Dorothy", "Toto"],
    scene: {
      title: "Kansas",
      text: "The wind screams around the farmhouse.",
      choices: [],
      sceneScope: {
        currentLocation: "Kansas farmhouse",
        peoplePresent: ["Dorothy", "Toto"],
        peopleWithinSpeakingDistance: ["Dorothy", "Toto"],
      },
    },
  } as unknown as GameState;

  const context = JSON.parse(buildGameContext(state, [candidate]));
  const progress = context.next_significant_event_progress;

  assert.equal(
    progress.next_required_beat.sourceReferencesExcerpt,
    candidate.sourceReferenceExcerpts![sourceReferenceKey(externalBeat.sourceReferences[0]!)],
  );
  assert.equal(
    progress.remaining_beats[1].sourceReferencesExcerpt,
    candidate.sourceReferenceExcerpts![sourceReferenceKey(involuntaryBeat.sourceReferences[0]!)],
  );

  const sourceRules = SOURCE_GROUNDING_RULES.join("\n");
  assert.match(sourceRules, /sourceReferencesExcerpt is the most specific source evidence/i);
  assert.match(sourceRules, /before the broader upcoming_source_material\.excerpt/i);
});
