import assert from "node:assert/strict";
import test from "node:test";
import { filterSceneScope, sceneScopeFailures, removeChoicesWithPlayerIdentityReferences } from "../src/ai/engine/scene-validation.js";

const context = {
  playerName: "little dog",
  playerAliases: ["Toto", "little dog"],
  knownCharacterProfiles: [
    { name: "Toto", aliases: ["little dog"] },
    { name: "Dorothy", aliases: [] },
    { name: "Witch", aliases: [] },
  ],
  nonInteractableCharacters: ["Witch"],
};

test("older NPC-only scope gains the canonical player in both lists", () => {
  const scope = filterSceneScope({
    currentLocation: "Road",
    peoplePresent: ["Dorothy", "Witch"],
    peopleWithinSpeakingDistance: ["Dorothy", "Witch"],
  }, context);
  assert.deepEqual(scope.peoplePresent, ["Dorothy", "Toto"]);
  assert.deepEqual(scope.peopleWithinSpeakingDistance, ["Dorothy", "Toto"]);
  assert.deepEqual(sceneScopeFailures(scope, context), []);
  assert.deepEqual(filterSceneScope(scope, context), scope);
});

test("player aliases collapse to one identity while absent NPCs remain unavailable", () => {
  const scope = filterSceneScope({
    currentLocation: "Road",
    peoplePresent: ["Toto", "little dog"],
    peopleWithinSpeakingDistance: ["little dog", "Toto", "Dorothy"],
  }, context);
  assert.deepEqual(scope.peoplePresent, ["Toto"]);
  assert.deepEqual(scope.peopleWithinSpeakingDistance, ["Toto"]);
  assert.deepEqual(sceneScopeFailures(scope, context), []);
});

test("custom player without a book profile remains explicit", () => {
  const custom = { ...context, playerName: "Visitor", playerAliases: [] };
  const scope = filterSceneScope({ currentLocation: "Road", peoplePresent: [], peopleWithinSpeakingDistance: [] }, custom);
  assert.deepEqual(scope.peoplePresent, ["Visitor"]);
  assert.deepEqual(scope.peopleWithinSpeakingDistance, ["Visitor"]);
  assert.deepEqual(sceneScopeFailures(scope, custom), []);
});

test("explicit player presence does not permit a self-targeted conversation", () => {
  const scene = removeChoicesWithPlayerIdentityReferences({
    title: "Road", text: "I stand beside Dorothy.",
    sceneScope: filterSceneScope({ currentLocation: "Road", peoplePresent: ["Dorothy"], peopleWithinSpeakingDistance: ["Dorothy"] }, { playerName: "Toto" }),
    choices: [
      { id: "self", type: "talk", text: "Talk to Toto", character: "Toto" },
      { id: "other", type: "talk", text: "Talk to Dorothy", character: "Dorothy" },
    ],
  }, "Toto");
  assert.deepEqual(scene.choices.map((choice) => choice.id), ["other"]);
});
