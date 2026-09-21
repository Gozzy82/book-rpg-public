import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const providerTurnEngineSource = await readFile(
  new URL("../src/ai/engine/provider-turn-engine.ts", import.meta.url),
  "utf8",
);

test("split opening prompt treats 360 words as the prelude target and 600 as ceiling only", () => {
  assert.doesNotMatch(
    providerTurnEngineSource,
    /Opening word budget for this prelude: up to \$\{openingBudget\} words\. Use the extra room/i,
  );
  assert.match(
    providerTurnEngineSource,
    /PRELUDE TARGET: keep phase-1 player-facing prose at or below \$\{OPENING_SPLIT_PRELUDE_TARGET_WORDS\} words/i,
  );
  assert.match(
    providerTurnEngineSource,
    /hard combined opening ceiling after the short decision-boundary phase/i,
  );
});

test("split opening prompt requires every ordered prelude beat to be explicit instead of reflective filler", () => {
  assert.match(
    providerTurnEngineSource,
    /Each PRELUDE BEAT must get its own short, concrete sentence or clause that visibly performs that exact beat/i,
  );
  assert.match(
    providerTurnEngineSource,
    /Do not replace an ordered beat with atmosphere, introspection, anticipation, a summary, or a generic setup/i,
  );
  assert.match(
    providerTurnEngineSource,
    /Spend words on the listed beats, not reflection or recap/i,
  );
});
