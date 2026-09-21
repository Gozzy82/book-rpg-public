import assert from "node:assert/strict";
import test from "node:test";
import {
  withAutomaticFollowupWindow,
} from "../src/ai/engine/provider-paced-bookrpg-engine.js";
import {
  withCurrentBeatOnlyGenerationContext,
} from "../src/ai/engine/provider-bookrpg-engine.js";

const beats = [
  {
    actor: "Dorothy",
    action: "Starts after Toto",
    targets: ["Toto"],
    agency: "intentional",
    stakes: "significant",
    sourceReferencesExcerpt: "SOURCE BEAT 5",
  },
  {
    actor: "Aunt Em",
    action: "Throws open the trapdoor and climbs down into the cyclone cellar",
    targets: ["Dorothy"],
    agency: "intentional",
    stakes: "significant",
    sourceReferencesExcerpt: "SOURCE BEAT 6",
  },
  {
    actor: "Dorothy",
    action: "Catches Toto and starts toward the cellar",
    targets: ["Toto"],
    agency: "intentional",
    stakes: "significant",
    sourceReferencesExcerpt: "SOURCE BEAT 7",
  },
  {
    actor: "Dorothy",
    action: "Loses her footing and sits down when the shaking house throws her off balance",
    targets: [],
    agency: "involuntary",
    stakes: "significant",
    sourceReferencesExcerpt: "SOURCE BEAT 8",
  },
];

function request(
  selectedText: string,
  nextBeatOffset: number,
  completedBeatIndexes: number[],
) {
  const remaining = beats.slice(nextBeatOffset);
  return {
    model: "test",
    instructions: "Resolve exactly one player decision.",
    input: [
      "Resolve the selected option.",
      "",
      "IMMEDIATE TURN TRANSITION (AUTHORITATIVE; DO NOT REPLAY PREVIOUS SCENE):",
      JSON.stringify({
        previous_scene: { title: "Before", text: "Before." },
        latest_input: {
          kind: "selected_option",
          text: selectedText,
          unselected_options: [],
        },
      }, null, 2),
      "",
      "GAME CONTEXT:",
      JSON.stringify({
        player_identity: "Dorothy",
        next_significant_event_progress: {
          event_id: "event_cyclone",
          completed_beat_indexes: completedBeatIndexes,
          completed_beats: [],
          next_required_beat: remaining[0],
          remaining_beats: remaining,
        },
      }, null, 2),
    ].join("\n"),
  };
}

function gameContext(input: string): Record<string, any> {
  const marker = "GAME CONTEXT:\n";
  const start = input.lastIndexOf(marker) + marker.length;
  return JSON.parse(input.slice(start)) as Record<string, any>;
}

test("selected Dorothy beat 5 carries Aunt Em's NPC beat 6 but stops before Dorothy beat 7", () => {
  const paced = withAutomaticFollowupWindow(
    "scene",
    request("Start after Toto", 0, [0, 1, 2, 3, 4]),
  );
  const context = gameContext(paced.input);
  const automatic = context.next_significant_event_progress.automatic_followup_beats;

  assert.equal(automatic.length, 1);
  assert.equal(automatic[0].index, 6);
  assert.equal(
    automatic[0].action,
    "Throws open the trapdoor and climbs down into the cyclone cellar",
  );
  assert.equal(automatic[0].agency, "intentional");
  assert.equal(automatic[0].sourceReferencesExcerpt, "SOURCE BEAT 6");
  assert.doesNotMatch(JSON.stringify(automatic), /Catches Toto/);
  assert.doesNotMatch(JSON.stringify(automatic), /Loses her footing/);
});

test("selected Dorothy beat 7 carries the following involuntary beat 8 in the same turn", () => {
  const paced = withAutomaticFollowupWindow(
    "scene",
    request("Catch Toto and start toward the cellar", 2, [0, 1, 2, 3, 4, 5, 6]),
  );
  const context = gameContext(paced.input);
  const automatic = context.next_significant_event_progress.automatic_followup_beats;

  assert.equal(automatic.length, 1);
  assert.equal(automatic[0].index, 8);
  assert.equal(automatic[0].agency, "involuntary");
  assert.match(automatic[0].action, /Loses her footing/);
  assert.equal(automatic[0].sourceReferencesExcerpt, "SOURCE BEAT 8");
});

test("automatic follow-up window is absent when a different action was selected", () => {
  const paced = withAutomaticFollowupWindow(
    "scene",
    request("Wait by the bed", 0, [0, 1, 2, 3, 4]),
  );
  const context = gameContext(paced.input);

  assert.equal(
    context.next_significant_event_progress.automatic_followup_beats,
    undefined,
  );
});

test("current-beat filtering preserves the non-player continuation window", () => {
  const paced = withAutomaticFollowupWindow(
    "scene",
    request("Start after Toto", 0, [0, 1, 2, 3, 4]),
  );
  const restricted = withCurrentBeatOnlyGenerationContext("scene", paced);

  assert.match(restricted.input, /automatic_followup_beats/);
  assert.match(restricted.input, /Throws open the trapdoor/);
  assert.match(restricted.input, /SOURCE BEAT 6/);
  assert.doesNotMatch(restricted.input, /SOURCE BEAT 5/);
  assert.doesNotMatch(restricted.input, /SOURCE BEAT 7/);
  assert.doesNotMatch(restricted.input, /SOURCE BEAT 8/);
  assert.match(restricted.instructions ?? "", /AUTOMATIC FOLLOW-UP WINDOW/);
  assert.match(restricted.instructions ?? "", /non-player beats/);
});
