import assert from "node:assert/strict";
import test from "node:test";
import type { AiResponse, AiResponseRequest } from "../src/ai/provider.js";
import {
  enforceAutomaticFollowupReview,
  withAutomaticFollowupPresenceReview,
} from "../src/ai/engine/provider-guarded-paced-bookrpg-engine.js";

function requestFor(
  playerIdentity: string,
  playerAction: string,
  nextBeat: Record<string, unknown>,
  beats: Record<string, unknown>[],
): AiResponseRequest {
  return {
    model: "test-model",
    instructions: "Review source progress.",
    input: JSON.stringify({
      player_identity: playerIdentity,
      candidate_scene: { player_action: playerAction },
      next_required_source_event_beat: nextBeat,
      event_review_target: {
        eventId: "event_test",
        beats,
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
  } as AiResponseRequest;
}

function response(completedSourceEventBeatIndexes: number[]): AiResponse {
  return {
    status: "completed",
    output_text: JSON.stringify({
      peoplePresent: [],
      peopleWithinSpeakingDistance: [],
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes,
      futureActionSetupRequired: false,
      futureActionSetupSupported: true,
      futureActionSetupReason: "",
      reason: "ok",
    }),
    incomplete_details: null,
  } as AiResponse;
}

test("tells the presence reviewer to credit an intentional NPC follow-up and report the next player boundary if crossed", () => {
  const beats = [
    {
      actor: "Dorothy",
      action: "Starts after Toto",
      agency: "intentional",
    },
    {
      actor: "Aunt Em",
      action: "Throws open the trapdoor and climbs down into the cyclone cellar",
      agency: "intentional",
    },
    {
      actor: "Dorothy",
      action: "Catches Toto and starts toward the cellar",
      agency: "intentional",
    },
  ];
  const reviewed = withAutomaticFollowupPresenceReview(
    "scene presence review",
    requestFor(
      "Dorothy",
      "Start after Toto",
      { ...beats[0], index: 0 },
      beats,
    ),
  );

  assert.match(reviewed.instructions ?? "", /1: Throws open the trapdoor/);
  assert.match(reviewed.instructions ?? "", /2: Catches Toto and starts toward the cellar/);
  assert.match(reviewed.instructions ?? "", /include its absolute beat index/);
  assert.match(reviewed.instructions ?? "", /Do not omit an intentional NPC beat/);
});

test("Scarecrow review contract credits Dorothy approach before the next Scarecrow decision", () => {
  const beats = [
    {
      actor: "Scarecrow",
      action: "Winks and nods to Dorothy",
      agency: "intentional",
    },
    {
      actor: "Dorothy",
      action: "Approaches the Scarecrow after climbing down from the fence",
      agency: "intentional",
    },
    {
      actor: "Scarecrow",
      action: "Speaks to Dorothy",
      agency: "intentional",
    },
  ];
  const reviewed = withAutomaticFollowupPresenceReview(
    "scene presence review",
    requestFor(
      "Scarecrow",
      "Wink and nod to Dorothy",
      { ...beats[0], index: 0 },
      beats,
    ),
  );

  assert.match(reviewed.instructions ?? "", /1: Approaches the Scarecrow/);
  assert.match(reviewed.instructions ?? "", /2: Speaks to Dorothy/);
});

test("rejects a scene that skips an automatic NPC beat after the selected player beat", () => {
  const beats = [
    {
      actor: "Tin Woodman",
      action: "Lowers his axe and leans it against the tree",
      agency: "intentional",
    },
    {
      actor: "Dorothy",
      action: "Oils the Tin Woodman's leg joints",
      agency: "intentional",
    },
    {
      actor: "Tin Woodman",
      action: "Moves freely and thanks Dorothy and the Scarecrow for releasing him",
      agency: "intentional",
    },
  ];
  const guarded = enforceAutomaticFollowupReview(
    requestFor(
      "Tin Woodman",
      "Lower my axe and lean it against the tree",
      { ...beats[0], index: 0 },
      beats,
    ),
    response([0]),
  );
  const output = JSON.parse(guarded.output_text);

  assert.equal(output.futureActionSetupRequired, true);
  assert.equal(output.futureActionSetupSupported, false);
  assert.match(output.futureActionSetupReason, /Oils the Tin Woodman's leg joints/);
});

test("accepts a scene once every automatic follow-up before the next player decision is complete", () => {
  const beats = [
    {
      actor: "Tin Woodman",
      action: "Lowers his axe and leans it against the tree",
      agency: "intentional",
    },
    {
      actor: "Dorothy",
      action: "Oils the Tin Woodman's leg joints",
      agency: "intentional",
    },
    {
      actor: "Tin Woodman",
      action: "Moves freely and thanks Dorothy and the Scarecrow for releasing him",
      agency: "intentional",
    },
  ];
  const original = response([0, 1]);
  const guarded = enforceAutomaticFollowupReview(
    requestFor(
      "Tin Woodman",
      "Lower my axe and lean it against the tree",
      { ...beats[0], index: 0 },
      beats,
    ),
    original,
  );

  assert.deepEqual(guarded, original);
});

test("rejects a scene that performs the next unselected player beat after the follow-up window", () => {
  const beats = [
    {
      actor: "Dorothy",
      action: "Starts after Toto",
      agency: "intentional",
    },
    {
      actor: "Aunt Em",
      action: "Throws open the trapdoor and climbs down into the cyclone cellar",
      agency: "intentional",
    },
    {
      actor: "Dorothy",
      action: "Catches Toto and starts toward the cellar",
      agency: "intentional",
    },
  ];
  const guarded = enforceAutomaticFollowupReview(
    requestFor(
      "Dorothy",
      "Start after Toto",
      { ...beats[0], index: 0 },
      beats,
    ),
    response([0, 1, 2]),
  );
  const output = JSON.parse(guarded.output_text);

  assert.equal(output.futureActionSetupRequired, true);
  assert.equal(output.futureActionSetupSupported, false);
  assert.match(output.futureActionSetupReason, /crossed the player-decision boundary/);
  assert.match(output.futureActionSetupReason, /Catches Toto and starts toward the cellar/);
});

test("treats an involuntary player beat as automatic rather than a new decision", () => {
  const beats = [
    {
      actor: "Dorothy",
      action: "Catches Toto and starts toward the cellar",
      agency: "intentional",
    },
    {
      actor: "Dorothy",
      action: "Loses her footing and sits down when the shaking house throws her off balance",
      agency: "involuntary",
    },
  ];
  const guarded = enforceAutomaticFollowupReview(
    requestFor(
      "Dorothy",
      "Catch Toto and start toward the cellar",
      { ...beats[0], index: 0 },
      beats,
    ),
    response([0]),
  );
  const output = JSON.parse(guarded.output_text);

  assert.equal(output.futureActionSetupSupported, false);
  assert.match(output.futureActionSetupReason, /Loses her footing/);
});
