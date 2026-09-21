import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceFirstPersonPlayerIdentity,
  normalizeOpeningBoundaryRepetitionReview,
  normalizeSelectedOptionPlayerAction,
  withConcreteAutomaticSceneWindow,
  withPlayerIdentitySourceNarration,
} from "../src/ai/engine/provider-e2e-recovery-engine.js";

function completed(output: Record<string, unknown>) {
  return {
    status: "completed" as const,
    output_text: JSON.stringify(output),
    incomplete_details: null,
  };
}

function reviewRequest(input: string) {
  return {
    model: "test",
    input,
    text: {
      format: {
        name: "bookrpg_scene_repetition_review",
      },
    },
  } as any;
}

test("opening reviewer does not require Lion's first unselected attack beat", () => {
  const input = `${JSON.stringify({
    player_identity: "Cowardly Lion",
    player_identity_aliases: ["Lion"],
    immediate_transition: null,
    recent_prior_scenes: [],
    candidate_scene: {
      text: "I crouch at the forest edge while the travelers come within reach. Not yet the blow; I hold at the decision boundary.",
      player_action: "",
    },
  })}\n\nCHOICE NAVIGATION EVENT:\n\n${JSON.stringify({
    beats: [
      {
        actor: "Cowardly Lion",
        action: "Bounds into the road and strikes Scarecrow, then claws at Tin Woodman",
        agency: "intentional",
      },
    ],
  })}`;
  const response = normalizeOpeningBoundaryRepetitionReview(
    reviewRequest(input),
    completed({
      latestInputResolvedFaithfully: false,
      latestInputFailureType: "omitted",
      latestInputFailureReason: "Candidate opens with setup and inner resolve but omits the required CURRENT SIGNIFICANT EVENT (the attack) to proceed the scene.",
      preservesPlayerAgency: true,
      playerAgencyFailureReason: "",
      reason: "Attack not performed.",
    }),
  );
  const review = JSON.parse(response.output_text);
  assert.equal(review.latestInputResolvedFaithfully, true);
  assert.equal(review.latestInputFailureType, "none");
});

test("opening reviewer does not invent an agency violation before Dorothy starts after Toto", () => {
  const input = `${JSON.stringify({
    player_identity: "Dorothy",
    player_identity_aliases: ["Dorothy"],
    immediate_transition: null,
    recent_prior_scenes: [],
    candidate_scene: {
      text: "Uncle Henry runs for the sheds. Aunt Em orders me toward the cellar. Toto jumps from my arms and hides under the bed. I freeze for a heartbeat.",
      player_action: "",
    },
  })}\n\nCHOICE NAVIGATION EVENT:\n\n${JSON.stringify({
    beats: [
      { actor: "Uncle Henry", action: "Calls to Aunt Em", agency: "intentional" },
      { actor: "Toto", action: "Hides under the bed", agency: "involuntary" },
      { actor: "Dorothy", action: "Starts after Toto", agency: "intentional" },
    ],
  })}`;
  const response = normalizeOpeningBoundaryRepetitionReview(
    reviewRequest(input),
    completed({
      latestInputResolvedFaithfully: true,
      latestInputFailureType: "none",
      latestInputFailureReason: "",
      preservesPlayerAgency: false,
      playerAgencyFailureReason: "The scene introduces Dorothy's actions as part of the narrative.",
      reason: "Agency violation.",
    }),
  );
  const review = JSON.parse(response.output_text);
  assert.equal(review.preservesPlayerAgency, true);
  assert.equal(review.playerAgencyFailureReason, "");
});

test("first-person player cannot appear as a separate named Toto in narration", () => {
  const request = reviewRequest(JSON.stringify({
    player_identity: "Toto",
    player_identity_aliases: ["Toto"],
    immediate_transition: { latest_input: { kind: "selected_option", text: "Wait" } },
    recent_prior_scenes: [],
    candidate_scene: {
      text: "I press closer to Dorothy as Toto leaps from her arms and hides under the bed.",
      player_action: "Wait",
    },
  }));
  const response = enforceFirstPersonPlayerIdentity(
    request,
    completed({
      latestInputResolvedFaithfully: true,
      latestInputFailureType: "none",
      preservesPlayerPerspective: true,
      playerPerspectiveFailureReason: "",
      reason: "Looks fine.",
    }),
  );
  const review = JSON.parse(response.output_text);
  assert.equal(review.preservesPlayerPerspective, false);
  assert.equal(review.latestInputFailureType, "identity_or_roles");
});

test("first-person self-identification by name is not treated as duplication", () => {
  for (const [player, text] of [
    ["Tin Woodman", "I am Tin Woodman, frozen beside the tree, unable to move."],
    ["Cowardly Lion", "I, the Cowardly Lion, stand at the forest edge and watch the road."],
    ["Scarecrow", "I am a scarecrow made of straw, fixed to this pole."],
  ] as const) {
    const request = reviewRequest(JSON.stringify({
      player_identity: player,
      immediate_transition: null,
      recent_prior_scenes: [],
      candidate_scene: { text, player_action: "" },
    }));
    const original = completed({
      latestInputResolvedFaithfully: true,
      latestInputFailureType: "none",
      preservesPlayerPerspective: true,
      playerPerspectiveFailureReason: "",
      reason: "Looks fine.",
    });
    const response = enforceFirstPersonPlayerIdentity(request, original);
    assert.equal(response.output_text, original.output_text);
  }
});

test("Tin Woodman source narration explicitly forbids a second Tin Woodman", () => {
  const request = withPlayerIdentitySourceNarration("scene", {
    model: "test",
    instructions: "base",
    input: `GAME CONTEXT:\n${JSON.stringify({ player_identity: "Tin Woodman" })}`,
  } as any);
  assert.match(request.instructions ?? "", /every source reference to Tin Woodman denotes the first-person narrator/);
  assert.match(request.instructions ?? "", /never a second copy/);
  assert.match(request.instructions ?? "", /I\/me\/my/);
});

test("selected Scarecrow wink gets Dorothy's approach and forbids Scarecrow's next speech", () => {
  const request = withConcreteAutomaticSceneWindow("scene", {
    model: "test",
    instructions: "base",
    input: `IMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):\n${JSON.stringify({
      latest_input: { kind: "selected_option", text: "Winks and nods to Dorothy" },
    })}\n\nGAME CONTEXT:\n${JSON.stringify({
      player_identity: "Scarecrow",
      next_significant_event_progress: {
        next_required_beat: { actor: "Scarecrow", action: "Winks and nods to Dorothy", agency: "intentional" },
        remaining_beats: [
          { actor: "Scarecrow", action: "Winks and nods to Dorothy", agency: "intentional" },
          { actor: "Dorothy", action: "Approaches the Scarecrow after climbing down from the fence", agency: "intentional" },
          { actor: "Scarecrow", action: "Speaks to Dorothy", agency: "intentional" },
        ],
      },
    })}`,
  } as any);
  assert.match(request.input, /Approaches the Scarecrow after climbing down from the fence/);
  assert.match(request.input, /FIRST FORBIDDEN NEXT PLAYER BEAT/);
  assert.match(request.input, /Speaks to Dorothy/);
});

test("selected Scarecrow speech requires Dorothy to lift him before his next player beat", () => {
  const request = withConcreteAutomaticSceneWindow("scene", {
    model: "test",
    instructions: "base",
    input: `IMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):\n${JSON.stringify({
      latest_input: { kind: "selected_option", text: "Speak to Dorothy" },
    })}\n\nGAME CONTEXT:\n${JSON.stringify({
      player_identity: "Scarecrow",
      next_significant_event_progress: {
        next_required_beat: { actor: "Scarecrow", action: "Speaks to Dorothy", agency: "intentional" },
        remaining_beats: [
          { actor: "Scarecrow", action: "Speaks to Dorothy", agency: "intentional" },
          { actor: "Dorothy", action: "Lifts the Scarecrow off the pole", agency: "intentional" },
          { actor: "Scarecrow", action: "Stands, moves, and thanks Dorothy after being freed", agency: "intentional" },
        ],
      },
    })}`,
  } as any);
  assert.match(request.instructions ?? "", /REQUIRED BEFORE ENDING THIS SCENE/);
  assert.match(request.instructions ?? "", /Lifts the Scarecrow off the pole/);
  assert.match(request.input, /FIRST FORBIDDEN NEXT PLAYER BEAT/);
  assert.match(request.input, /Stands, moves, and thanks Dorothy after being freed/);
});

test("Dorothy automatic window tolerates Starts versus Start inflection and forbids catching Toto", () => {
  const request = withConcreteAutomaticSceneWindow("scene", {
    model: "test",
    instructions: "base",
    input: `IMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):\n${JSON.stringify({
      latest_input: { kind: "selected_option", text: "Start after Toto" },
    })}\n\nGAME CONTEXT:\n${JSON.stringify({
      player_identity: "Dorothy",
      next_significant_event_progress: {
        next_required_beat: { actor: "Dorothy", action: "Starts after Toto", agency: "intentional" },
        remaining_beats: [
          { actor: "Dorothy", action: "Starts after Toto", agency: "intentional" },
          { actor: "Aunt Em", action: "Throws open the trapdoor and climbs down into the cyclone cellar", agency: "intentional" },
          { actor: "Dorothy", action: "Catches Toto and starts toward the cellar", agency: "intentional" },
        ],
      },
    })}`,
  } as any);
  assert.match(request.input, /Throws open the trapdoor and climbs down into the cyclone cellar/);
  assert.match(request.input, /FIRST FORBIDDEN NEXT PLAYER BEAT/);
  assert.match(request.input, /Catches Toto and starts toward the cellar/);
});

test("selected option playerAction metadata is restored exactly", () => {
  const request = {
    model: "test",
    input: `IMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):\n${JSON.stringify({
      latest_input: { kind: "selected_option", text: "Start after Toto" },
    })}`,
  } as any;
  const response = normalizeSelectedOptionPlayerAction(
    request,
    completed({
      title: "Dash",
      text: "I start after Toto.",
      playerAction: "Start after Toto - catch Toto and move toward the cellar",
    }),
  );
  assert.equal(JSON.parse(response.output_text).playerAction, "Start after Toto");
});
