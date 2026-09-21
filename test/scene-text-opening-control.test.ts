import assert from "node:assert/strict";
import test from "node:test";

import {
  sceneLeaksInternalMetadata,
  stripLeakedSceneMetadata,
} from "../src/ai/engine/scene-text.js";

test("strips leaked opening control markers from player-facing scene text", () => {
  const text = [
    "The wind drives dust across the yard.",
    "STOP BEFORE PLAYER BEAT 5 — Retrieves Toto and starts toward the cellar.",
    "Dorothy hears Aunt Em call from the cellar.",
  ].join("\n");

  assert.equal(
    stripLeakedSceneMetadata(text),
    "The wind drives dust across the yard.\nDorothy hears Aunt Em call from the cellar.",
  );
});

test("detects all opening control labels as internal metadata", () => {
  assert.equal(sceneLeaksInternalMetadata("OPENING PRELUDE: narrate three beats"), true);
  assert.equal(sceneLeaksInternalMetadata("PRELUDE BEAT 2 — Aunt Em: Climbs into the cellar."), true);
  assert.equal(sceneLeaksInternalMetadata("STOP BEFORE PLAYER BEAT 5 — Retrieve Toto."), true);
  assert.equal(sceneLeaksInternalMetadata("PENDING PLAYER BEAT — DO NOT PERFORM: Wink at Dorothy."), true);
  assert.equal(sceneLeaksInternalMetadata("The cyclone shakes the farmhouse."), false);
});


test("detects and strips a serialized scene-object tail from prose", () => {
  const leaked = "I keep Toto close while the wind rises.','development':'Dorothy speaks aloud a fanciful idea.','outcome':'active','outcomeReason':'The storm approaches.','sceneScope':{'currentLocation':'farmhouse'}";
  assert.equal(sceneLeaksInternalMetadata(leaked), true);
  assert.equal(stripLeakedSceneMetadata(leaked), "I keep Toto close while the wind rises.");
});

test("does not treat ordinary prose containing schema words as metadata", () => {
  const prose = "The development of the storm worries Uncle Henry, but I stay beside Toto.";
  assert.equal(sceneLeaksInternalMetadata(prose), false);
  assert.equal(stripLeakedSceneMetadata(prose), prose);
});
