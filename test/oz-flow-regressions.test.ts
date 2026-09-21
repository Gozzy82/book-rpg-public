import assert from "node:assert/strict";
import test from "node:test";
import type { CharacterProfile, Scene } from "../src/shared/contracts.js";
import { removeChoicesRepeatingCompletedSourceEvent } from "../src/ai/engine/scene-validation.js";
import { openingCharacterContinuityFailures } from "../src/ai/engine/turn.js";

test("after the wink, asking for release is a new action despite Dorothy and pole overlap", () => {
  const scene: Scene = {
    title: "On the pole",
    text: "Dorothy watches me from beside the pole.",
    choices: [
      { id: "release", type: "action", text: "Ask Dorothy to remove the pole from my back" },
      { id: "wink", type: "action", text: "Wink and nod at Dorothy from my pole" },
      { id: "new-again", type: "action", text: "Ask Dorothy again to remove the pole from my back" },
    ],
  };
  const filtered = removeChoicesRepeatingCompletedSourceEvent(scene, {
    eventId: "scarecrow-freed", sequence: 9, chapterPosition: 5,
    description: "Dorothy discovers that the Scarecrow is alive and frees him.",
    beats: [{ actor: "Scarecrow", action: "Winks and nods at Dorothy from his pole.",
      targets: ["Dorothy"], agency: "intentional", stakes: "significant", sourceReferences: [] }],
  });
  assert.deepEqual(filtered.choices.map(choice => choice.id), ["release", "new-again"]);
});

test("opening accepts indexed participants omitted by the short event description", () => {
  const profiles: CharacterProfile[] = ["Dorothy", "Toto", "Aunt Em", "Uncle Henry", "Scarecrow"].map(name => ({
    name, aliases: [], role: "Character", description: "", traits: [], relationships: [], storyArc: "",
  }));
  const state = { playerName: "Dorothy", characterProfiles: profiles, sourceIntroducedCharacters: [] };
  const candidate = {
    chapterPosition: 3, chapterTitle: "Kansas", summary: "A cyclone approaches.",
    excerpt: "The wind rises.", nextTextOffset: 100,
    requiredEvent: "A cyclone approaches the Kansas farmhouse.", requiredEventId: "cyclone",
    requiredEventActors: ["Uncle Henry", "Aunt Em", "Toto", "Dorothy"],
    requiredEventTargets: ["Aunt Em", "Dorothy", "Toto"],
  };
  for (const name of ["Toto", "Aunt Em", "Uncle Henry"]) {
    assert.deepEqual(openingCharacterContinuityFailures(`${name} enters the room.`, state, [candidate], { currentLocation: "Kansas", peoplePresent: [name], peopleWithinSpeakingDistance: [name] }), []);
  }
  assert.equal(openingCharacterContinuityFailures("Scarecrow enters the room.", state, [candidate], { currentLocation: "Kansas", peoplePresent: ["Scarecrow"], peopleWithinSpeakingDistance: ["Scarecrow"] }).length, 1);
});

