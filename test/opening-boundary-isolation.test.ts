import test from "node:test";
import assert from "node:assert/strict";
import {
  withIsolatedSplitOpeningRequest,
} from "../src/ai/engine/provider-paced-bookrpg-engine.js";

const request = {
  model: "gpt-5-nano",
  instructions: [
    "Keep normal scene rules.",
    "next_significant_event_progress is authoritative cumulative state.",
    "OPENING AUTOMATIC PREFIX: complete every pre-player beat now.",
    "Never perform next_player_future_actions.",
  ].join("\n"),
  input: [
    "Start opening.",
    "OPENING PRELUDE: visibly narrate all 2 ordered beats below.",
    "PRELUDE BEAT 0 — Aunt Em: Opens the trapdoor",
    "PRELUDE BEAT 1 — Toto: Hides under the bed",
    "The opening has a structured player-decision boundary.",
    '{"kind":"first_unselected_player_beat","action":"Start after Toto","mustRemainUnperformed":true}',
    "Find the earliest meaningful player-controlled beat in opening_player_future_actions.",
    "When next_required_beat is one of those pre-player beats, complete it now.",
    "Use next_significant_event_progress to complete the prefix.",
    "PLAYER PERSPECTIVE RULES:",
    "Use first person.",
    "GAME CONTEXT:",
    JSON.stringify({
      player_identity: "Dorothy",
      next_significant_event_progress: {
        event_id: "event_cyclone",
        next_required_beat: { actor: "Aunt Em", action: "Opens the trapdoor" },
        remaining_beats: [{ actor: "Aunt Em" }, { actor: "Dorothy" }],
      },
      next_player_future_actions: [{ action: "Start after Toto" }],
      opening_player_future_actions: [{ action: "Start after Toto" }],
      opening_event_sequence: [{ eventId: "event_cyclone" }],
      character_profiles: [{ name: "Dorothy", aliases: [] }],
    }, null, 2),
  ].join("\n"),
} as const;

test("split opening isolates phase 2 from stale prelude progress", () => {
  const isolated = withIsolatedSplitOpeningRequest("scene", request);

  assert.match(isolated.input, /OPENING PRELUDE:/);
  assert.match(isolated.input, /PRELUDE BEAT 0/);
  assert.match(isolated.input, /first_unselected_player_beat/);
  assert.match(isolated.input, /The boundary action is the next player decision/);
  assert.doesNotMatch(isolated.input, /Find the earliest meaningful player-controlled beat/);
  assert.doesNotMatch(isolated.input, /When next_required_beat is one of those pre-player beats/);
  assert.doesNotMatch(isolated.input, /"next_significant_event_progress"/);
  assert.doesNotMatch(isolated.input, /"next_player_future_actions"/);
  assert.doesNotMatch(isolated.input, /"opening_player_future_actions"/);
  assert.doesNotMatch(isolated.input, /"opening_event_sequence"/);

  assert.match(isolated.instructions ?? "", /Keep normal scene rules/);
  assert.doesNotMatch(isolated.instructions ?? "", /next_significant_event_progress/);
  assert.doesNotMatch(isolated.instructions ?? "", /OPENING AUTOMATIC PREFIX/);
  assert.doesNotMatch(isolated.instructions ?? "", /next_player_future_actions/);
});

test("ordinary scene requests remain unchanged", () => {
  const ordinary = {
    ...request,
    input: "PLAYER PERSPECTIVE RULES:\nUse first person.\nGAME CONTEXT:\n{}",
  };
  assert.deepEqual(withIsolatedSplitOpeningRequest("scene", ordinary), ordinary);
});
