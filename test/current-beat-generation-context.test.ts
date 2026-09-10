import assert from "node:assert/strict";
import test from "node:test";
import {
  withCurrentBeatOnlyGenerationContext,
} from "../src/ai/engine/provider-bookrpg-engine.js";

const gameContext = {
  history: [
    { kind: "scene", text: "The door {is still open} behind me." },
  ],
  current_significant_event: {
    eventId: "event_current",
    description: "Dorothy meets the Scarecrow.",
    beats: [
      { actor: "Scarecrow", action: "Winks at Dorothy." },
      { actor: "Scarecrow", action: "Asks to be freed." },
    ],
  },
  next_significant_event: {
    eventId: "event_future",
    description: "The Scarecrow decides to seek brains.",
    beats: [
      { actor: "Scarecrow", action: "Asks to go to Oz for brains." },
    ],
  },
  next_significant_event_progress: {
    event_id: "event_current",
    completed_beat_indexes: [0],
    completed_beats: [
      { actor: "Scarecrow", action: "Winks at Dorothy." },
    ],
    next_required_beat: {
      actor: "Scarecrow",
      action: "Asks Dorothy to remove the pole from his back.",
      sourceReferencesExcerpt: "CURRENT BEAT SOURCE ONLY",
    },
    remaining_beats: [
      {
        actor: "Dorothy",
        action: "Lifts the Scarecrow off the pole.",
        sourceReferencesExcerpt: "FUTURE BEAT SOURCE",
      },
      {
        actor: "Scarecrow",
        action: "Asks to travel to Oz for brains.",
        sourceReferencesExcerpt: "LATER FUTURE SOURCE",
      },
    ],
  },
  next_player_future_actions: [
    {
      action: "Ask to travel to Oz for brains.",
      source_excerpt: "BRAINS FUTURE SOURCE",
    },
  ],
  opening_player_future_actions: [
    {
      action: "Announce a future plan.",
      source_excerpt: "OPENING FUTURE SOURCE",
    },
  ],
  opening_event_sequence: [
    { eventId: "event_later", description: "A later event." },
  ],
  story_so_far: ["A source-derived future summary."],
  upcoming_source_material: [
    {
      chapterPosition: 4,
      summary: "The Scarecrow seeks brains.",
      excerpt: "UPCOMING SOURCE MATERIAL",
    },
  ],
};

function request() {
  return {
    model: "test",
    instructions: [
      "Use next_significant_event_progress.next_required_beat.",
      "Use upcoming_source_material as a future anchor.",
      "Use next_player_future_actions to prepare later actions.",
      "Keep history authoritative.",
    ].join("\n"),
    input: [
      "PLAYER ACTION: wave",
      "",
      "GAME CONTEXT:",
      JSON.stringify(gameContext, null, 2),
      "",
      "AFTER CONTEXT: keep this suffix",
    ].join("\n"),
  };
}

test("generation context exposes only the current beat source material", () => {
  const restricted = withCurrentBeatOnlyGenerationContext("scene", request());

  assert.match(restricted.input, /CURRENT BEAT SOURCE ONLY/);
  assert.match(restricted.input, /The door \{is still open\} behind me\./);
  assert.match(restricted.input, /AFTER CONTEXT: keep this suffix/);

  assert.doesNotMatch(restricted.input, /upcoming_source_material/);
  assert.doesNotMatch(restricted.input, /UPCOMING SOURCE MATERIAL/);
  assert.doesNotMatch(restricted.input, /FUTURE BEAT SOURCE/);
  assert.doesNotMatch(restricted.input, /LATER FUTURE SOURCE/);
  assert.doesNotMatch(restricted.input, /BRAINS FUTURE SOURCE/);
  assert.doesNotMatch(restricted.input, /Ask to travel to Oz for brains/);
  assert.doesNotMatch(restricted.input, /The Scarecrow decides to seek brains/);
  assert.doesNotMatch(restricted.input, /A source-derived future summary/);
  assert.doesNotMatch(restricted.input, /A later event/);

  assert.match(restricted.input, /"remaining_beats": \[/);
  assert.match(restricted.input, /"pending": true/);
  assert.doesNotMatch(restricted.instructions ?? "", /upcoming_source_material/);
  assert.doesNotMatch(restricted.instructions ?? "", /next_player_future_actions/);
  assert.match(restricted.instructions ?? "", /next_significant_event_progress\.next_required_beat/);
  assert.match(restricted.instructions ?? "", /Keep history authoritative/);
});

test("current-beat restriction applies to player-facing generation calls", () => {
  for (const label of [
    "scene",
    "scene choices",
    "dialogue response",
    "dialogue suggestions",
  ]) {
    const restricted = withCurrentBeatOnlyGenerationContext(label, request());
    assert.doesNotMatch(restricted.input, /UPCOMING SOURCE MATERIAL/, label);
  }
});

test("review and source-selection requests retain their original context", () => {
  const original = request();
  const untouched = withCurrentBeatOnlyGenerationContext(
    "source continuation selection",
    original,
  );

  assert.equal(untouched, original);
  assert.match(untouched.input, /UPCOMING SOURCE MATERIAL/);
});
