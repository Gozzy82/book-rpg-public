import assert from "node:assert/strict";
import test from "node:test";
import type { Scene } from "../src/shared/contracts.js";
import type { AiResponseRequest } from "../src/ai/provider.js";
import {
  correctPartialSceneChoiceReviewState,
  correctSceneChoiceReviewAlternatives,
  correctScenePresenceBeatOrder,
  correctStaleScenePresenceSetup,
} from "../src/ai/engine/provider-engine-base.js";
import { removeChoicesRepeatingCompletedSourceEvent } from "../src/ai/engine/scene-validation.js";
import {
  buildRequiredPlayerChoiceFallback,
  buildSourceEventChoiceBeatState,
  nextRequiredSourceEventBeatReviewContext,
  selectedAnchorRequiresSourceEvent,
} from "../src/ai/engine/source-navigation.js";

test("scene presence ignores stale setup failure after reviewed source event completes", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      event_review_target: { eventId: "scarecrow-freed" },
      future_player_actions: [
        { beatIndex: 0, action: "Winks and nods at Dorothy from his pole." },
        { beatIndex: 1, action: "Asks Dorothy to remove the pole from his back." },
      ],
    }),
  };
  const corrected = correctStaleScenePresenceSetup(request, {
    status: "completed",
    output_text: JSON.stringify({
      latestVisibleSourceEventId: "scarecrow-freed",
      completedSourceEventBeatIndexes: [2],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason: "The old wink beat is no longer executable from the end state.",
    }),
  });
  const review = JSON.parse(corrected.output_text) as {
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
  };

  assert.equal(review.futureActionSetupRequired, false);
  assert.equal(review.futureActionSetupSupported, true);
});

test("completed-event choice filter keeps a different later request to the same character", () => {
  const nextChoice = {
    id: "ask-to-join",
    type: "action" as const,
    text: "Ask Dorothy to accompany me to Oz so I can seek brains.",
    stakes: "significant" as const,
  };
  const scene = {
    choices: [nextChoice],
  } as Scene;
  const completedEvent = {
    eventId: "scarecrow-freed",
    sequence: 9,
    description: "Dorothy discovers that the Scarecrow is alive and frees him.",
    chapterPosition: 3,
    beats: [
      {
        actor: "Scarecrow",
        action: "Winks and nods at Dorothy from his pole.",
        agency: "intentional",
        stakes: "significant",
      },
      {
        actor: "Scarecrow",
        action: "Asks Dorothy to remove the pole from his back.",
        agency: "intentional",
        stakes: "significant",
      },
      {
        actor: "Dorothy",
        action: "Lifts the Scarecrow off the pole.",
        agency: "intentional",
        stakes: "critical",
      },
    ],
  } as NonNullable<Parameters<typeof removeChoicesRepeatingCompletedSourceEvent>[1]>;

  const filtered = removeChoicesRepeatingCompletedSourceEvent(scene, completedEvent);
  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["ask-to-join"]);

  const repeated = removeChoicesRepeatingCompletedSourceEvent({
    ...scene,
    choices: [{
      ...nextChoice,
      id: "repeat-removal-request",
      text: "Ask Dorothy to remove the pole from my back.",
    }],
  }, completedEvent);
  assert.equal(repeated.choices.length, 0);
});

test("choice planning separates reviewed completed beats from remaining beats", () => {
  const beats = [
    {
      actor: "Scarecrow",
      action: "Winks and nods at Dorothy from his pole.",
      agency: "intentional" as const,
      stakes: "significant" as const,
    },
    {
      actor: "Scarecrow",
      action: "Asks Dorothy to remove the pole from his back.",
      agency: "intentional" as const,
      stakes: "significant" as const,
    },
    {
      actor: "Dorothy",
      action: "Lifts the Scarecrow off the pole.",
      agency: "intentional" as const,
      stakes: "critical" as const,
    },
  ];
  const event = {
    eventId: "scarecrow-freed",
    sequence: 9,
    description: "Dorothy discovers that the Scarecrow is alive and frees him.",
    chapterPosition: 3,
    actors: ["Scarecrow", "Dorothy"],
    targets: ["Scarecrow"],
    beats,
  };
  const choiceState = buildSourceEventChoiceBeatState(event, {
    eventId: "scarecrow-freed",
    completedBeatIndexes: [0, 1],
  });

  assert.deepEqual(
    choiceState.completedEvent?.beats?.map((beat) => beat.action),
    beats.slice(0, 2).map((beat) => beat.action),
  );
  assert.deepEqual(
    choiceState.remainingEvent?.beats?.map((beat) => beat.action),
    [beats[2]!.action],
  );

  const filtered = removeChoicesRepeatingCompletedSourceEvent({
    choices: [
      {
        id: "repeat-wink",
        type: "action",
        text: "Wink and nod at Dorothy from my pole.",
        stakes: "significant",
      },
      {
        id: "repeat-request",
        type: "action",
        text: "Ask Dorothy to remove the pole from my back.",
        stakes: "significant",
      },
      {
        id: "new-action",
        type: "action",
        text: "Thank Dorothy after I am freed.",
        stakes: "routine",
      },
    ],
  } as Scene, choiceState.completedEvent);

  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["new-action"]);

  const completeChoiceState = buildSourceEventChoiceBeatState(event, {
    eventId: "scarecrow-freed",
    completedBeatIndexes: [0, 1, 2],
  });
  assert.equal(completeChoiceState.remainingEvent, null);
  assert.deepEqual(
    completeChoiceState.completedEvent?.beats?.map((beat) => beat.action),
    beats.map((beat) => beat.action),
  );
});

test("choice review does not present an in-progress navigation event as completed current state", () => {
  const context = JSON.stringify({
    candidate_scene: {
      choices: [],
      sceneScope: {
        peopleWithinSpeakingDistance: ["Dorothy"],
      },
    },
  }, null, 2);
  const request: AiResponseRequest = {
    model: "test",
    instructions: "base instructions",
    input: [
      context,
      "CHOICE NAVIGATION EVENT:",
      JSON.stringify({ eventId: "scarecrow-freed" }, null, 2),
      "CURRENT SIGNIFICANT EVENT:",
      JSON.stringify({ eventId: "scarecrow-freed" }, null, 2),
      "SOURCE EVENT BEAT PROGRESS:",
      JSON.stringify({
        eventId: "scarecrow-freed",
        completedBeatIndexes: [],
        nextRequiredBeat: {
          action: "Winks and nods at Dorothy from his pole.",
        },
        remainingBeats: [
          { action: "Winks and nods at Dorothy from his pole." },
        ],
      }, null, 2),
      "REQUIRED PLAYER CHOICE BEATS:",
      "[]",
    ].join("\n\n"),
  };

  const corrected = correctPartialSceneChoiceReviewState(request);
  assert.match(
    corrected.input,
    /CURRENT SIGNIFICANT EVENT:\n\nnull\n\nSOURCE EVENT BEAT PROGRESS:/u,
  );
  assert.match(
    corrected.instructions ?? "",
    /constrains anchor selection only/u,
  );
});

test("choice review keeps an executable talk alternative even when the model rejects it for not being the anchor", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: [
      JSON.stringify({
        candidate_scene: {
          choices: [
            {
              type: "action",
              text: "Wink at Dorothy and nod to her.",
              character: null,
            },
            {
              type: "talk",
              text: "Talk to Dorothy",
              character: "Dorothy",
            },
          ],
          sceneScope: {
            peopleWithinSpeakingDistance: ["Dorothy"],
          },
        },
      }, null, 2),
      "CHOICE NAVIGATION EVENT:",
      JSON.stringify({ eventId: "scarecrow-freed" }, null, 2),
    ].join("\n\n"),
  };
  const corrected = correctSceneChoiceReviewAlternatives(request, {
    status: "completed",
    output_text: JSON.stringify({
      anchorChoiceIndex: 0,
      unusableChoiceIndexes: [1],
      unusableChoicesReason:
        "Talk to Dorothy does not name the consequential voluntary source act.",
      reason: "Choice 1 is the source anchor.",
    }),
  });
  const review = JSON.parse(corrected.output_text) as {
    unusableChoiceIndexes: number[];
    unusableChoicesReason: string;
  };

  assert.deepEqual(review.unusableChoiceIndexes, []);
  assert.equal(review.unusableChoicesReason, "");
});

test("choice review still allows an actually unavailable talk choice to remain unusable", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: [
      JSON.stringify({
        candidate_scene: {
          choices: [{
            type: "talk",
            text: "Talk to Dorothy",
            character: "Dorothy",
          }],
          sceneScope: {
            peopleWithinSpeakingDistance: [],
          },
        },
      }, null, 2),
      "CHOICE NAVIGATION EVENT:",
      JSON.stringify({ eventId: "scarecrow-freed" }, null, 2),
    ].join("\n\n"),
  };
  const response = {
    status: "completed",
    output_text: JSON.stringify({
      anchorChoiceIndex: null,
      unusableChoiceIndexes: [0],
      unusableChoicesReason: "Dorothy is not within speaking distance.",
      reason: "No executable anchor.",
    }),
  };

  assert.equal(
    correctSceneChoiceReviewAlternatives(request, response).output_text,
    response.output_text,
  );
});


test("presence review isolates the next incomplete source beat", () => {
  const event = {
    eventId: "rough-country-and-forest",
    description: "Dorothy and the Scarecrow continue into rough country and the forest.",
    chapterPosition: 4,
    beats: [
      {
        actor: "Scarecrow",
        action: "Stumbles into holes in the damaged road.",
        agency: "involuntary" as const,
        stakes: "routine" as const,
      },
      {
        actor: "Dorothy",
        action: "Picks up the fallen Scarecrow.",
        agency: "intentional" as const,
        stakes: "routine" as const,
      },
      {
        actor: "Dorothy",
        action: "Recounts to the Scarecrow how the cyclone carried her from Kansas to Oz.",
        agency: "intentional" as const,
        stakes: "significant" as const,
      },
      {
        actor: "Dorothy",
        action: "Continues with the Scarecrow into the forest.",
        agency: "intentional" as const,
        stakes: "significant" as const,
      },
    ],
  };

  assert.deepEqual(
    nextRequiredSourceEventBeatReviewContext(event, [0, 1, 2]),
    {
      index: 3,
      actor: "Dorothy",
      action: "Continues with the Scarecrow into the forest.",
      agency: "intentional",
      stakes: "significant",
    },
  );
  assert.equal(
    nextRequiredSourceEventBeatReviewContext(event, [0, 1, 2, 3]),
    null,
  );

  assert.equal(
    selectedAnchorRequiresSourceEvent(
      "event",
      event,
      "Scarecrow",
    ),
    true,
    "an event-directed anchor must advance an NPC/world beat when no player choice is required first",
  );
});

test("source-directed anchors advance Toto past an involuntary Dorothy beat", () => {
  const event = {
    eventId: "cyclone",
    description: "A cyclone approaches the Kansas farm.",
    chapterPosition: 1,
    actors: ["Dorothy", "Toto"],
    beats: [{
      actor: "Dorothy",
      action: "Loses her footing when the shaking house throws her down.",
      agency: "involuntary" as const,
      stakes: "significant" as const,
    }],
  };

  assert.equal(selectedAnchorRequiresSourceEvent("event", event, "Toto"), true);
  assert.equal(selectedAnchorRequiresSourceEvent("transition", event, "Toto"), false);
});

test("source transition still does not force a meaningful player-controlled beat", () => {
  const event = {
    eventId: "toto-choice",
    description: "Toto must make a consequential choice.",
    chapterPosition: 1,
    actors: ["Toto"],
    beats: [{
      actor: "Toto",
      action: "Jumps from Dorothy's arms and hides under the bed.",
      agency: "intentional" as const,
      stakes: "significant" as const,
    }],
  };

  assert.equal(selectedAnchorRequiresSourceEvent("transition", event, "Toto"), false);
});

test("opening progression waits for the ordered prefix before accepting the decision boundary", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      event_review_target_mode: "opening_progression",
      event_review_target: {
        eventId: "cyclone",
        beats: Array.from({ length: 12 }, (_value, index) => ({ index })),
      },
      previous_completed_source_event_beat_indexes: [],
      future_player_actions: [
        { beatIndex: 5 },
        { beatIndex: 9 },
        { beatIndex: 10 },
      ],
    }),
  };
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: false,
      futureActionSetupSupported: true,
      futureActionSetupReason: "The player can act from the established opening state.",
    }),
  };
  const corrected = correctScenePresenceBeatOrder(request, response);
  const review = JSON.parse(corrected.output_text) as {
    completedSourceEventBeatIndexes: number[];
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
    futureActionSetupReason: string;
  };

  assert.deepEqual(review.completedSourceEventBeatIndexes, []);
  assert.equal(review.futureActionSetupRequired, false);
  assert.equal(review.futureActionSetupSupported, false);
  assert.match(review.futureActionSetupReason, /missing ordered source beats 0-4/i);

  const ready = correctScenePresenceBeatOrder(request, {
    status: "completed",
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [0, 1, 2, 3, 4],
      futureActionSetupRequired: true,
      futureActionSetupSupported: true,
      futureActionSetupReason: "The player can now perform beat 5.",
    }),
  });
  const readyReview = JSON.parse(ready.output_text) as {
    futureActionSetupSupported: boolean;
  };
  assert.equal(readyReview.futureActionSetupSupported, true);
});

test("required player choice fallback converts -es action verbs to selectable base form", () => {
  const choice = buildRequiredPlayerChoiceFallback(
    {
      eventId: "cyclone",
      description: "Dorothy is caught in the cyclone.",
      chapterPosition: 3,
      beats: [{
        actor: "Dorothy",
        action: "Catches Toto and starts toward the cellar.",
        agency: "intentional",
        stakes: "significant",
      }],
    },
    "Dorothy",
  );

  assert.equal(choice?.text, "Catch Toto and start toward the cellar");
});