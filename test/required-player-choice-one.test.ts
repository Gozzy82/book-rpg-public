import assert from "node:assert/strict";
import test from "node:test";
import type { Scene } from "../src/shared/contracts.js";
import {
  ensureRequiredPlayerChoiceFirst,
} from "../src/ai/engine/provider-scene-engine.js";

test("required player source beat is restored as choice one after filtering", () => {
  const fallback: Scene["choices"][number] = {
    id: "__bookrpg_required_player_choice_fallback__",
    type: "action",
    text: "Ask Dorothy to take me with her to Oz",
    sourceEventId: "event_seek_brains",
    sourceAnchorRoute: "event",
    requiredPresentCharacters: ["Dorothy"],
    requiredAbsentCharacters: [],
    stakes: "significant",
  };
  const scene: Scene = {
    title: "On the road",
    text: "Dorothy waits beside me.",
    choices: [
      {
        id: "local-choice",
        type: "action",
        text: "Look along the yellow brick road",
        requiredPresentCharacters: [],
        requiredAbsentCharacters: [],
        stakes: "routine",
      },
      {
        id: "another-choice",
        type: "talk",
        text: "Talk to Dorothy",
        character: "Dorothy",
        requiredPresentCharacters: ["Dorothy"],
        requiredAbsentCharacters: [],
        stakes: "routine",
      },
    ],
  };

  const restored = ensureRequiredPlayerChoiceFirst(scene, fallback);

  assert.equal(restored.choices[0]?.id, fallback.id);
  assert.equal(restored.choices[0]?.text, fallback.text);
  assert.equal(restored.choices[0]?.sourceAnchorRoute, "event");
  assert.deepEqual(
    restored.choices.slice(1).map((choice) => choice.id),
    ["local-choice", "another-choice"],
  );
});

test("required player source beat replaces a duplicate generated paraphrase", () => {
  const fallback: Scene["choices"][number] = {
    id: "__bookrpg_required_player_choice_fallback__",
    type: "action",
    text: "Ask Dorothy to take me with her to Oz",
    sourceEventId: "event_seek_brains",
    sourceAnchorRoute: "event",
    requiredPresentCharacters: ["Dorothy"],
    requiredAbsentCharacters: [],
    stakes: "significant",
  };
  const scene: Scene = {
    title: "On the road",
    text: "Dorothy waits beside me.",
    choices: [
      {
        id: "generated-anchor",
        type: "action",
        text: "Ask Dorothy to take me with her to Oz.",
        requiredPresentCharacters: ["Dorothy"],
        requiredAbsentCharacters: [],
        stakes: "significant",
      },
      {
        id: "local-choice",
        type: "action",
        text: "Look along the yellow brick road",
        requiredPresentCharacters: [],
        requiredAbsentCharacters: [],
        stakes: "routine",
      },
    ],
  };

  const restored = ensureRequiredPlayerChoiceFirst(scene, fallback);

  assert.equal(restored.choices[0]?.id, fallback.id);
  assert.equal(restored.choices.length, 2);
  assert.equal(restored.choices[1]?.id, "local-choice");
});

test("terminal scenes do not gain a required player choice", () => {
  const scene: Scene = {
    title: "Done",
    text: "The story has ended.",
    outcome: "completed",
    choices: [],
  };
  const fallback: Scene["choices"][number] = {
    id: "__bookrpg_required_player_choice_fallback__",
    type: "action",
    text: "Continue",
    stakes: "significant",
  };

  assert.deepEqual(ensureRequiredPlayerChoiceFirst(scene, fallback), scene);
});
