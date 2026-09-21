import assert from "node:assert/strict";
import test from "node:test";
import {
  withoutOpeningPreludeInstructions,
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
      automaticPreludeSourceExcerpt: "CURRENT BEAT PRELUDE ONLY",
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

function openingRequest() {
  const openingContext = structuredClone(gameContext) as typeof gameContext & {
    source_guidance_mode?: string;
  };
  openingContext.source_guidance_mode = "optional_opening_reference";
  openingContext.next_significant_event_progress.completed_beat_indexes = [];
  openingContext.next_significant_event_progress.completed_beats = [];
  openingContext.next_significant_event_progress.next_required_beat = {
    actor: "Uncle Henry",
    action: "Recognizes that a cyclone is coming.",
    automaticPreludeSourceExcerpt: "SAFE PRE-PLAYER SOURCE CONTEXT",
    sourceReferencesExcerpt:
      "CURRENT BEAT SOURCE ... Dorothy caught Toto and started toward the cellar.",
  } as unknown as typeof openingContext.next_significant_event_progress.next_required_beat;
  openingContext.next_significant_event_progress.remaining_beats = [
    {
      actor: "Uncle Henry",
      action: "Recognizes that a cyclone is coming.",
      sourceReferencesExcerpt: "PRELUDE SOURCE 0",
    },
    {
      actor: "Uncle Henry",
      action: "Runs to the sheds.",
      sourceReferencesExcerpt: "PRELUDE SOURCE 1",
    },
    {
      actor: "Aunt Em",
      action: "Comes to the door.",
      sourceReferencesExcerpt: "PRELUDE SOURCE 2",
    },
    {
      actor: "Aunt Em",
      action: "Orders Dorothy to the cellar.",
      sourceReferencesExcerpt: "PRELUDE SOURCE 3",
    },
    {
      actor: "Toto",
      action: "Hides under the bed.",
      sourceReferencesExcerpt: "PRELUDE SOURCE 4",
    },
    {
      actor: "Dorothy",
      action: "Starts after Toto.",
      sourceReferencesExcerpt: "PLAYER BOUNDARY SOURCE MUST STAY HIDDEN",
    },
    {
      actor: "Aunt Em",
      action: "Climbs into the cellar.",
      sourceReferencesExcerpt: "POST BOUNDARY SOURCE MUST STAY HIDDEN",
    },
  ] as typeof openingContext.next_significant_event_progress.remaining_beats;
  openingContext.opening_player_future_actions = [
    {
      action: "Starts after Toto.",
      source_excerpt: "PLAYER BOUNDARY SOURCE MUST STAY HIDDEN",
      beat_index: 5,
    },
  ] as unknown as typeof openingContext.opening_player_future_actions;

  return {
    ...request(),
    input: [
      "Start the opening.",
      "",
      "GAME CONTEXT:",
      JSON.stringify(openingContext, null, 2),
      "",
      "AFTER CONTEXT: keep this suffix",
    ].join("\n"),
  };
}

test("scene generation hides broad current-beat source prose but keeps automatic prelude context", () => {
  const restricted = withCurrentBeatOnlyGenerationContext("scene", request());

  assert.doesNotMatch(restricted.input, /CURRENT BEAT SOURCE ONLY/);
  assert.match(restricted.input, /CURRENT BEAT PRELUDE ONLY/);
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

test("opening generation keeps every prelude beat source excerpt and hides the player boundary", () => {
  const restricted = withCurrentBeatOnlyGenerationContext("scene", openingRequest());

  assert.doesNotMatch(restricted.input, /Dorothy caught Toto and started toward the cellar/);
  for (const index of [0, 1, 2, 3, 4]) {
    assert.match(restricted.input, new RegExp(`PRELUDE SOURCE ${index}`));
  }
  assert.doesNotMatch(restricted.input, /PLAYER BOUNDARY SOURCE MUST STAY HIDDEN/);
  assert.doesNotMatch(restricted.input, /POST BOUNDARY SOURCE MUST STAY HIDDEN/);
  assert.doesNotMatch(restricted.input, /upcoming_source_material/);
  assert.match(restricted.input, /SAFE PRE-PLAYER SOURCE CONTEXT/);
  assert.match(restricted.input, /The storm winds rise across the prairie|Recognizes that a cyclone is coming/);
});

test("opening boundary input drops phase-1 prelude instructions but keeps the structured player boundary", () => {
  const input = [
    "Start opening.",
    "OPENING PRELUDE: visibly narrate all 5 ordered beats below.",
    "PRELUDE BEAT 0 — Uncle Henry: warns Aunt Em.",
    "PRELUDE BEAT 1 — Uncle Henry: runs to the sheds.",
    "PRELUDE TARGET: keep phase-1 prose short.",
    "The opening has a structured player-decision boundary.",
    '{"kind":"first_unselected_player_beat","action":"Starts after Toto","mustRemainUnperformed":true}',
    "Stop before the player action.",
  ].join("\n");

  const boundaryInput = withoutOpeningPreludeInstructions(input);

  assert.doesNotMatch(boundaryInput, /OPENING PRELUDE:/);
  assert.doesNotMatch(boundaryInput, /PRELUDE BEAT/);
  assert.doesNotMatch(boundaryInput, /PRELUDE TARGET/);
  assert.match(boundaryInput, /structured player-decision boundary/);
  assert.match(boundaryInput, /first_unselected_player_beat/);
  assert.match(boundaryInput, /Starts after Toto/);
  assert.match(boundaryInput, /Stop before the player action/);
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

test("planned generation removes the legacy single-beat progress projection", () => {
  const prepared = withCurrentBeatOnlyGenerationContext("scene", request(), true);
  assert.doesNotMatch(prepared.input, /"next_significant_event_progress"/);
  const legacy = withCurrentBeatOnlyGenerationContext("scene", request());
  assert.match(legacy.input, /"next_significant_event_progress"/);
});
