import assert from "node:assert/strict";
import test from "node:test";
import {
  relaxMissingAutomaticFollowupReview,
  withAutomaticFollowupProgressReviewContract,
  withNonInteractableConsistencyContract,
  withOpeningBoundaryReviewContract,
  withOpeningProgressReviewContract,
} from "../src/ai/engine/provider-e2e-hardening-engine.js";

function completed(output: Record<string, unknown>) {
  return {
    status: "completed" as const,
    output_text: JSON.stringify(output),
    incomplete_details: null,
  };
}

function repetitionReviewRequest(input: string) {
  return {
    model: "test",
    input,
    instructions: "base",
    text: {
      format: {
        name: "bookrpg_scene_repetition_review",
      },
    },
  } as any;
}

function presenceReviewRequest(input: Record<string, unknown>) {
  return {
    model: "test",
    input: JSON.stringify(input),
    instructions: "base",
    text: {
      format: {
        name: "bookrpg_scene_presence_review",
      },
    },
  } as any;
}

test("opening boundary review receives the exact first unselected player beat as structured control data", () => {
  const input = `${JSON.stringify({
    player_identity: "Cowardly Lion",
    immediate_transition: null,
    recent_prior_scenes: [],
    candidate_scene: {
      text: "I crouch at the forest edge while the travelers approach.",
    },
  })}\n\nCHOICE NAVIGATION EVENT:\n\n${JSON.stringify({
    beats: [
      {
        actor: "Cowardly Lion",
        action: "Bounds into the road and strikes Scarecrow, then claws at Tin Woodman",
        agency: "intentional",
      },
      {
        actor: "Toto",
        action: "Runs barking toward the Lion",
        agency: "intentional",
      },
    ],
  })}`;

  const request = withOpeningBoundaryReviewContract(
    "scene repetition review",
    repetitionReviewRequest(input),
  );

  assert.match(request.instructions, /FIRST UNSELECTED PLAYER BEAT/);
  assert.match(request.instructions, /Bounds into the road and strikes Scarecrow/);
  assert.match(request.instructions, /Judge candidate_scene semantically, not by word overlap/);
});

test("opening progress review receives the exact next beat instead of lexical prose heuristics", () => {
  const request = withOpeningProgressReviewContract(
    "scene presence review",
    presenceReviewRequest({
      event_review_target_mode: "opening_progression",
      next_required_source_event_beat: {
        index: 0,
        actor: "Dorothy",
        action: "Finds a Scarecrow beside the road and examines it",
        agency: "intentional",
      },
    }),
  );

  assert.match(request.instructions, /EXACT NEXT OPENING BEAT/);
  assert.match(request.instructions, /Finds a Scarecrow beside the road and examines it/);
  assert.match(request.instructions, /natural paraphrase/);
});

test("automatic follow-up review receives the exact NPC beat and next player boundary", () => {
  const request = withAutomaticFollowupProgressReviewContract(
    "scene presence review",
    presenceReviewRequest({
      player_identity: "Scarecrow",
      previous_completed_source_event_beat_indexes: [0],
      next_required_source_event_beat: {
        index: 1,
        actor: "Scarecrow",
        action: "Explains that he has no brains and asks whether Oz might give him some",
        agency: "intentional",
      },
      event_review_target: {
        beats: [
          { actor: "Dorothy", action: "Explains where she is going", agency: "intentional" },
          { actor: "Scarecrow", action: "Explains that he has no brains and asks whether Oz might give him some", agency: "intentional" },
          { actor: "Dorothy", action: "Invites the Scarecrow to travel with her", agency: "intentional" },
          { actor: "Scarecrow", action: "Accepts Dorothy's invitation", agency: "intentional" },
        ],
      },
    }),
  );

  assert.match(request.instructions, /AUTOMATIC FOLLOW-UP PROGRESS REVIEW/);
  assert.match(request.instructions, /Invites the Scarecrow to travel with her/);
  assert.match(request.instructions, /"index":2/);
  assert.match(request.instructions, /NEXT PLAYER BOUNDARY/);
  assert.match(request.instructions, /Accepts Dorothy's invitation/);
  assert.match(request.instructions, /"index":3/);
});

test("non-interactable consistency is delegated to the structured reviewer", () => {
  const request = withNonInteractableConsistencyContract(
    "scene repetition review",
    repetitionReviewRequest(JSON.stringify({
      player_identity: "Cowardly Lion",
      immediate_transition: null,
      recent_prior_scenes: [],
    })),
  );

  assert.match(request.instructions, /NON-INTERACTABLE CONSISTENCY/);
  assert.match(request.instructions, /death, corpse state, or permanent departure/);
  assert.match(request.instructions, /return an empty array/);
});

test("completed player beat may leave an NPC follow-up pending for source continuation", () => {
  const request = presenceReviewRequest({
    player_identity: "Dorothy",
    previous_completed_source_event_beat_indexes: [0, 1, 2, 3, 4],
    next_required_source_event_beat: {
      index: 5,
      actor: "Dorothy",
      action: "Starts after Toto",
      agency: "intentional",
    },
    event_review_target: {
      beats: [
        { actor: "Uncle Henry", action: "Warns of cyclone", agency: "intentional" },
        { actor: "Uncle Henry", action: "Runs to sheds", agency: "intentional" },
        { actor: "Aunt Em", action: "Comes to door", agency: "intentional" },
        { actor: "Aunt Em", action: "Orders Dorothy to cellar", agency: "intentional" },
        { actor: "Toto", action: "Hides under bed", agency: "involuntary" },
        { actor: "Dorothy", action: "Starts after Toto", agency: "intentional" },
        { actor: "Aunt Em", action: "Opens trapdoor and climbs down", agency: "intentional" },
        { actor: "Dorothy", action: "Catches Toto and starts toward cellar", agency: "intentional" },
      ],
    },
  });

  const response = relaxMissingAutomaticFollowupReview(
    request,
    completed({
      completedSourceEventBeatIndexes: [5],
      futureActionSetupRequired: true,
      futureActionSetupSupported: false,
      futureActionSetupReason: "missing automatic follow-up",
      reason: "Aunt Em has not yet climbed down.",
    }),
  );
  const review = JSON.parse(response.output_text);
  assert.equal(review.futureActionSetupSupported, true);
  assert.equal(review.futureActionSetupRequired, false);
  assert.match(review.futureActionSetupReason, /still-pending non-player\/source follow-up/);
});

test("automatic follow-up fallback never hides a crossed next player boundary", () => {
  const request = presenceReviewRequest({
    player_identity: "Cowardly Lion",
    previous_completed_source_event_beat_indexes: [],
    next_required_source_event_beat: {
      index: 0,
      actor: "Cowardly Lion",
      action: "Attacks the travelers",
      agency: "intentional",
    },
    event_review_target: {
      beats: [
        { actor: "Cowardly Lion", action: "Attacks the travelers", agency: "intentional" },
        { actor: "Toto", action: "Runs barking toward Lion", agency: "intentional" },
        { actor: "Cowardly Lion", action: "Opens mouth to bite Toto", agency: "intentional" },
      ],
    },
  });
  const original = completed({
    completedSourceEventBeatIndexes: [0, 2],
    futureActionSetupRequired: true,
    futureActionSetupSupported: false,
    futureActionSetupReason: "crossed player boundary",
    reason: "Beat 2 was also performed.",
  });

  const response = relaxMissingAutomaticFollowupReview(request, original);
  assert.equal(response.output_text, original.output_text);
});
