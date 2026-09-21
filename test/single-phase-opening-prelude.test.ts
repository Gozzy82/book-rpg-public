import assert from "node:assert/strict";
import test from "node:test";

import type { AiResponseRequest } from "../src/ai/provider.js";
import {
  openingPreludeNarrativeTarget,
  withoutAiSourceReferences,
  withCurrentBeatSourceExcerpt,
  withOpeningPreludeSourceExcerpts,
  withSinglePhaseOpeningPrelude,
} from "../src/ai/engine/provider-guarded-paced-bookrpg-engine.js";
import {
  withCurrentBeatOnlyGenerationContext,
} from "../src/ai/engine/provider-bookrpg-engine.js";

function request(input: string): AiResponseRequest {
  return {
    model: "gpt-5-nano",
    instructions: "Base scene instructions",
    input,
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_scene",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  };
}

test("split openings are routed through one prelude generation phase", () => {
  const original = request([
    "OPENING PRELUDE: visibly narrate all ordered beats.",
    "PRELUDE BEAT 0 — Aunt Em: Orders Dorothy to run for the cellar",
    "PRELUDE BEAT 1 — Toto: Jumps from Dorothy's arms and hides under the bed",
    "Each PRELUDE BEAT must get its own short, concrete sentence or clause that visibly performs that exact beat. Do not replace an ordered beat with atmosphere, introspection, anticipation, a summary, or a generic setup.",
    "PRELUDE TARGET: keep phase-1 player-facing prose at or below 360 words. The 600-word value is only the hard combined opening ceiling after the short decision-boundary phase; do not use that headroom for reflection, recap, choice lists, or decorative filler.",
    "The opening has a structured player-decision boundary.",
    '{"kind":"first_unselected_player_beat","action":"Starts after Toto","mustRemainUnperformed":true}',
  ].join("\n"));
  original.instructions = [
    "Keep scene text between 65 and 150 words. The former 65 and 120 words target is obsolete.",
    "Opening scene text may use up to 600 words when ordered pre-player beats require the extra room.",
  ].join("\n");

  const transformed = withSinglePhaseOpeningPrelude("scene", original);

  assert.match(transformed.input, /PRELUDE BEAT 0/);
  assert.match(transformed.input, /PRELUDE BEAT 1/);
  assert.match(transformed.input, /Starts after Toto/);
  assert.match(transformed.input, /"kind":"player_decision_boundary"/);
  assert.doesNotMatch(transformed.input, /"kind":"first_unselected_player_beat"/);
  assert.doesNotMatch(transformed.input, /short, concrete sentence or clause/);
  assert.doesNotMatch(transformed.input, /at or below 360 words/);
  assert.match(
    transformed.input,
    /Each PRELUDE BEAT must be clearly visible in the prose, but a beat may use multiple sentences/,
  );
  assert.match(
    transformed.instructions ?? "",
    /SINGLE-PHASE OPENING: generate the complete automatic\/NPC prelude/,
  );
  assert.match(
    transformed.instructions ?? "",
    /Aim for roughly 145-170 words of player-facing prose/,
  );
  assert.doesNotMatch(transformed.instructions ?? "", /65 and 150 words/);
  assert.doesNotMatch(transformed.instructions ?? "", /600 words/);
  assert.match(
    transformed.instructions ?? "",
    /normal BookRPG choice generator will create the menu/,
  );
  const combinedPrompt = `${transformed.instructions ?? ""}\n${transformed.input}`;
  assert.equal(
    combinedPrompt.match(/OPENING NARRATIVE TARGET:/gu)?.length ?? 0,
    1,
  );
});

test("opening narrative target grows with the automatic prelude", () => {
  assert.deepEqual(openingPreludeNarrativeTarget(0), { minimum: 95, target: 120 });
  assert.deepEqual(openingPreludeNarrativeTarget(2), { minimum: 145, target: 170 });
  assert.deepEqual(openingPreludeNarrativeTarget(5), { minimum: 220, target: 245 });
  assert.deepEqual(openingPreludeNarrativeTarget(6), { minimum: 235, target: 260 });
  assert.deepEqual(openingPreludeNarrativeTarget(20), { minimum: 235, target: 260 });
});

test("AI requests keep source excerpts but never source reference coordinates", () => {
  const original = request(JSON.stringify({
    next_significant_event_progress: {
      next_required_beat: {
        actor: "Dorothy",
        action: "Starts after Toto",
        sourceReferences: [{
          chapterPosition: 3,
          chapterIndex: 3,
          lineStart: 57,
          lineEnd: 57,
        }],
        sourceReferencesExcerpt: "Toto jumped out of Dorothy's arms and hid under the bed.",
      },
    },
    upcoming_source_material: [{
      excerpt: "The bounded source text remains available to the scene model.",
    }],
  }, null, 2));

  const transformed = withoutAiSourceReferences(original);
  const parsed = JSON.parse(transformed.input);
  const beat = parsed.next_significant_event_progress.next_required_beat;

  assert.equal("sourceReferences" in beat, false);
  assert.equal(
    beat.sourceReferencesExcerpt,
    "Toto jumped out of Dorothy's arms and hid under the bed.",
  );
  assert.equal(
    parsed.upcoming_source_material[0].excerpt,
    "The bounded source text remains available to the scene model.",
  );
});

test("ordinary scene preserves only the current beat source excerpt after current-beat filtering", () => {
  const original = request([
    "Resolve the current turn.",
    "",
    "GAME CONTEXT:",
    JSON.stringify({
      next_significant_event_progress: {
        next_required_beat: {
          actor: "Dorothy",
          action: "Starts after Toto",
          sourceReferences: [{ lineStart: 57, lineEnd: 57 }],
          sourceReferencesExcerpt: "Dorothy starts after Toto.",
        },
        remaining_beats: [
          {
            actor: "Aunt Em",
            action: "Climbs into the cellar",
            sourceReferences: [{ lineStart: 58, lineEnd: 59 }],
            sourceReferencesExcerpt: "Aunt Em opens the trapdoor and climbs down.",
          },
        ],
      },
      upcoming_source_material: [{ excerpt: "DO NOT SEND THIS BROAD FUTURE SOURCE" }],
    }, null, 2),
  ].join("\n"));

  let transformed = withoutAiSourceReferences(original);
  transformed = withCurrentBeatSourceExcerpt("scene", transformed);
  transformed = withCurrentBeatOnlyGenerationContext("scene", transformed);

  assert.doesNotMatch(transformed.input, /"sourceReferences"/);
  assert.doesNotMatch(transformed.input, /DO NOT SEND THIS BROAD FUTURE SOURCE/);
  assert.doesNotMatch(transformed.input, /Aunt Em opens the trapdoor and climbs down\./);
  assert.match(transformed.input, /CURRENT SOURCE BEAT EXCERPT/);
  assert.match(transformed.input, /"action": "Starts after Toto"/);
  assert.match(transformed.input, /"sourceReferencesExcerpt": "Dorothy starts after Toto\."/);
  assert.equal(
    transformed.input.match(/Dorothy starts after Toto\./gu)?.length ?? 0,
    1,
  );
});

test("opening prelude preserves only pre-boundary source excerpts after current-beat filtering", () => {
  const original = request([
    "OPENING PRELUDE: visibly narrate all ordered beats.",
    "PRELUDE BEAT 0 — Uncle Henry: Calls to Aunt Em",
    "PRELUDE BEAT 1 — Toto: Hides under the bed",
    "The opening has a structured player-decision boundary.",
    '{"kind":"first_unselected_player_beat","action":"Starts after Toto","mustRemainUnperformed":true}',
    "",
    "GAME CONTEXT:",
    JSON.stringify({
      next_significant_event_progress: {
        next_required_beat: {
          actor: "Uncle Henry",
          action: "Calls to Aunt Em",
          sourceReferences: [{ lineStart: 45, lineEnd: 52 }],
          sourceReferencesExcerpt: "Uncle Henry calls to Aunt Em.",
        },
        remaining_beats: [
          {
            actor: "Uncle Henry",
            action: "Calls to Aunt Em",
            sourceReferences: [{ lineStart: 45, lineEnd: 52 }],
            sourceReferencesExcerpt: "Uncle Henry calls to Aunt Em.",
          },
          {
            actor: "Toto",
            action: "Hides under the bed",
            sourceReferences: [{ lineStart: 57, lineEnd: 57 }],
            sourceReferencesExcerpt: "Toto jumps free and hides under the bed.",
          },
          {
            actor: "Dorothy",
            action: "Starts after Toto",
            sourceReferences: [{ lineStart: 57, lineEnd: 57 }],
            sourceReferencesExcerpt: "Dorothy starts after Toto.",
          },
        ],
      },
      upcoming_source_material: [{ excerpt: "DO NOT SEND THIS BROAD FUTURE SOURCE" }],
    }, null, 2),
  ].join("\n"));

  let transformed = withoutAiSourceReferences(original);
  transformed = withOpeningPreludeSourceExcerpts("scene", transformed);
  transformed = withCurrentBeatOnlyGenerationContext("scene", transformed);

  assert.doesNotMatch(transformed.input, /"sourceReferences"/);
  assert.doesNotMatch(transformed.input, /DO NOT SEND THIS BROAD FUTURE SOURCE/);
  assert.match(transformed.input, /OPENING PRELUDE SOURCE EXCERPTS/);
  assert.match(transformed.input, /"sourceReferencesExcerpt": "Uncle Henry calls to Aunt Em\."/);
  assert.match(transformed.input, /"sourceReferencesExcerpt": "Toto jumps free and hides under the bed\."/);
  assert.doesNotMatch(transformed.input, /Dorothy starts after Toto\./);
});

test("mixed opening prompts also strip serialized source reference coordinates", () => {
  const original = request([
    "OPENING PRELUDE: visibly narrate all ordered beats.",
    "GAME CONTEXT:",
    "{",
    '  "next_required_beat": {',
    '    "action": "Starts after Toto",',
    '    "sourceReferences": [',
    "      {",
    '        "chapterPosition": 3,',
    '        "lineStart": 57,',
    '        "lineEnd": 57',
    "      }",
    "    ],",
    '    "sourceReferencesExcerpt": "Toto hides under the bed."',
    "  },",
    '  "upcoming_source_material": [{"excerpt":"bounded text"}]',
    "}",
  ].join("\n"));

  const transformed = withoutAiSourceReferences(original);

  assert.doesNotMatch(transformed.input, /"sourceReferences"/);
  assert.match(transformed.input, /"sourceReferencesExcerpt": "Toto hides under the bed\."/);
  assert.match(transformed.input, /"upcoming_source_material"/);
});

test("ordinary scene requests remain unchanged", () => {
  const original = request("Continue the ordinary scene.");
  assert.equal(withSinglePhaseOpeningPrelude("scene", original), original);
  assert.equal(withSinglePhaseOpeningPrelude("scene choices", original), original);
});