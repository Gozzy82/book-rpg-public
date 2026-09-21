import { withSharedStoryPolicy } from "../src/ai/engine/shared-policy.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { AiResponseRequest } from "../src/ai/provider.js";
import {
  clampOpeningSplitSceneText,
  guardScenePresenceReviewPlayerBoundary,
  openingSplitSceneTextWordCount,
  withImmediateBeatOnlyChoiceContext,
} from "../src/ai/engine/provider-bookrpg-engine.js";
import {
  correctScenePresenceBeatOrder,
} from "../src/ai/engine/provider-engine-base.js";

test("opening setup review waits until preceding ordered beats reach the player boundary", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      event_review_target: {
        eventId: "cyclone",
        beats: Array.from({ length: 9 }, (_value, index) => ({
          actor: index === 8 ? "Dorothy" : "World",
          action: `beat-${index}`,
        })),
      },
      event_review_target_mode: "opening_progression",
      previous_completed_source_event_beat_indexes: [0, 1, 2, 3, 4, 5, 6],
      future_player_actions: [
        {
          beatIndex: 8,
          actor: "Dorothy",
          action: "Pull Toto back into the room and close the trapdoor.",
        },
      ],
    }),
  };
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason:
        "Dorothy cannot yet pull Toto back because the house-lift beat has not happened.",
    }),
  };

  const corrected = JSON.parse(
    correctScenePresenceBeatOrder(request, response).output_text,
  ) as {
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
    futureActionSetupReason: string;
    completedSourceEventBeatIndexes: number[];
  };

  assert.deepEqual(corrected.completedSourceEventBeatIndexes, []);
  assert.equal(corrected.futureActionSetupRequired, false);
  assert.equal(corrected.futureActionSetupSupported, false);
  assert.match(corrected.futureActionSetupReason, /missing ordered source beats? 7(?:-7)?/i);
});

test("normal scene setup review also waits for preceding ordered beats", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      event_review_target: {
        eventId: "heart-choice",
        beats: [
          { actor: "Oz", action: "Offers the Tin Woodman a choice." },
          { actor: "Tin Woodman", action: "Chooses a heart." },
        ],
      },
      event_review_target_mode: "scene_completion",
      previous_completed_source_event_beat_indexes: [],
      future_player_actions: [
        {
          beatIndex: 1,
          actor: "Tin Woodman",
          action: "Chooses a heart.",
        },
      ],
    }),
  };
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason:
        "Oz is not present or reachable, so the Tin Woodman cannot choose a heart yet.",
    }),
  };

  const corrected = JSON.parse(
    correctScenePresenceBeatOrder(request, response).output_text,
  ) as {
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
    completedSourceEventBeatIndexes: number[];
  };

  assert.deepEqual(corrected.completedSourceEventBeatIndexes, []);
  assert.equal(corrected.futureActionSetupRequired, false);
  assert.equal(corrected.futureActionSetupSupported, true);
});

test("opening setup review still enforces prerequisites once the player beat is next", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      event_review_target: {
        eventId: "cyclone",
        beats: Array.from({ length: 9 }, (_value, index) => ({
          actor: index === 8 ? "Dorothy" : "World",
          action: `beat-${index}`,
        })),
      },
      event_review_target_mode: "opening_progression",
      previous_completed_source_event_beat_indexes: [0, 1, 2, 3, 4, 5, 6, 7],
      future_player_actions: [
        {
          beatIndex: 8,
          actor: "Dorothy",
          action: "Pull Toto back into the room and close the trapdoor.",
        },
      ],
    }),
  };
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason:
        "The room and open trapdoor are not established at the decision point.",
    }),
  };

  const corrected = JSON.parse(
    correctScenePresenceBeatOrder(request, response).output_text,
  ) as {
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
  };

  assert.equal(corrected.futureActionSetupRequired, true);
  assert.equal(corrected.futureActionSetupSupported, false);
});

test("split opening text is deterministically bounded after model overrun", () => {
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      text: Array.from({ length: 500 }, (_value, index) => `word${index}`).join(" "),
    }),
  };

  assert.equal(openingSplitSceneTextWordCount(response), 500);
  const clamped = clampOpeningSplitSceneText(response, 360);
  assert.equal(openingSplitSceneTextWordCount(clamped), 360);
});

test("future visible gesture itself is never required as its own setup", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      player_identity: "Scarecrow",
      character_profiles: [
        { name: "Scarecrow", aliases: [] },
        { name: "Dorothy", aliases: [] },
      ],
      event_review_target: {
        eventId: "event_freed",
        beats: [
          {
            actor: "Scarecrow",
            action: "Winks and nods to attract Dorothy's attention.",
          },
        ],
      },
      future_player_actions: [
        {
          eventId: "event_freed",
          beatIndex: 0,
          actor: "Scarecrow",
          action: "Winks and nods to attract Dorothy's attention.",
          targets: ["Dorothy"],
        },
      ],
      candidate_scene: {
        text: "I hang fixed on the pole while Dorothy stands directly before me and looks my way.",
        player_action: "",
        proposed_scene_scope: {
          currentLocation: "cornfield",
          peoplePresent: ["Scarecrow", "Dorothy"],
          peopleWithinSpeakingDistance: ["Scarecrow", "Dorothy"],
        },
      },
    }),
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_scene_presence_review",
        strict: true,
        schema: {},
      },
    },
  };
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason:
        "The Scarecrow's gaze/gesture and wink or nod are not clearly demonstrated in the scene text.",
    }),
  };

  const corrected = JSON.parse(
    guardScenePresenceReviewPlayerBoundary(request, response).output_text,
  ) as {
    futureActionSetupRequired: boolean;
    futureActionSetupSupported: boolean;
    futureActionSetupReason: string;
  };

  assert.equal(corrected.futureActionSetupRequired, true);
  assert.equal(corrected.futureActionSetupSupported, true);
  assert.match(corrected.futureActionSetupReason, /future player action itself must remain unperformed/i);
});

test("selected player source beat is completed across first-person possessive perspective", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      player_identity: "Cowardly Lion",
      character_profiles: [
        { name: "Cowardly Lion", aliases: ["Lion"] },
        { name: "Toto", aliases: [] },
      ],
      event_review_target: {
        eventId: "lion-attack",
        beats: [
          { actor: "Cowardly Lion", action: "Bounds into the road and strikes Scarecrow, then claws at Tin Woodman" },
          { actor: "Toto", action: "Runs barking toward the Lion" },
          { actor: "Cowardly Lion", action: "Opens his mouth to bite Toto" },
        ],
      },
      next_required_source_event_beat: {
        index: 2,
        actor: "Cowardly Lion",
        action: "Opens his mouth to bite Toto",
      },
      future_player_actions: [
        {
          eventId: "lion-attack",
          beatIndex: 2,
          actor: "Cowardly Lion",
          action: "Opens his mouth to bite Toto",
          targets: ["Toto"],
        },
      ],
      candidate_scene: {
        text: "Toto is directly in front of me as my jaws open toward him.",
        player_action: "Open my mouth to bite Toto",
        proposed_scene_scope: {
          currentLocation: "dusty road",
          peoplePresent: ["Cowardly Lion", "Toto"],
          peopleWithinSpeakingDistance: ["Cowardly Lion", "Toto"],
        },
      },
    }),
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_scene_presence_review",
        strict: true,
        schema: {},
      },
    },
  };
  const response = {
    status: "completed" as const,
    output_text: JSON.stringify({
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason: "The bite action is still future.",
    }),
  };

  const corrected = JSON.parse(
    guardScenePresenceReviewPlayerBoundary(request, response).output_text,
  ) as {
    completedSourceEventBeatIndexes: number[];
  };

  assert.deepEqual(corrected.completedSourceEventBeatIndexes, [2]);
});

test("choice generation sees only the immediate player beat source excerpt", () => {
  const request: AiResponseRequest = {
    model: "test",
    instructions: "Generate choices.",
    input: JSON.stringify({
      upcoming_source_excerpt: "FUTURE MATERIAL THAT MUST NOT LEAK",
      required_player_choice_beats: [
        {
          actor: "Scarecrow",
          action: "Asks Dorothy whether Oz might give him brains.",
          sourceReferencesExcerpt: "CURRENT BEAT SOURCE ONLY",
        },
      ],
      setting: { text: "Dorothy stands beside me on the road." },
    }),
  };

  const bounded = withSharedStoryPolicy("scene choices",
    withImmediateBeatOnlyChoiceContext("scene choices", request));
  const parsed = JSON.parse(bounded.input) as Record<string, unknown>;

  assert.equal("upcoming_source_excerpt" in parsed, false);
  assert.deepEqual(parsed.immediate_player_beat_source_excerpts, [
    "CURRENT BEAT SOURCE ONLY",
  ]);
  assert.deepEqual(
    parsed.required_player_choice_beats,
    JSON.parse(request.input).required_player_choice_beats,
  );
  assert.doesNotMatch(bounded.input, /FUTURE MATERIAL THAT MUST NOT LEAK/);
  assert.match(bounded.instructions ?? "", /immediate player intent and expected immediate outcome/i);
  assert.match(bounded.instructions ?? "", /non-speaking animal/i);
});
