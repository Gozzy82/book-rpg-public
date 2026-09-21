import assert from "node:assert/strict";
import test from "node:test";
import {
  filterSceneScope,
  removeChoicesWithUnintroducedCharacters,
} from "../src/ai/engine.js";
import type { GameState, Scene } from "../src/shared/contracts.js";

const characterProfiles = [
  {
    name: "Mary Maloney",
    aliases: ["Mary"],
    role: "Player",
    description: "Mary.",
    traits: [],
    relationships: [],
    actions: [],
    sourceReferences: [],
    storyArc: "",
    significantEvents: [],
  },
  {
    name: "Patrick Maloney",
    aliases: ["Patrick"],
    role: "Husband",
    description: "Patrick.",
    traits: [],
    relationships: [],
    actions: [],
    sourceReferences: [],
    storyArc: "",
    significantEvents: [],
  },
];

function sceneWithPresentCharacters(peoplePresent: string[]): Scene {
  return {
    title: "Homecoming, Quietly Broken",
    text: "Mary waits in the living room for Patrick's expected return.",
    sceneScope: {
      currentLocation: "Mary's living room",
      peoplePresent,
      peopleWithinSpeakingDistance: peoplePresent,
    },
    choices: [
      {
        id: "welcome",
        type: "action",
        text: "Offer a quiet greeting and set aside the kettle to welcome Patrick home",
        character: "Patrick Maloney",
      },
      {
        id: "sew",
        type: "action",
        text: "Continue sewing while the clock keeps its patient rhythm",
      },
    ],
    outcome: "active",
    outcomeReason: "The evening is still unfolding.",
  };
}

function stateFor(scene: Scene) {
  return {
    playerName: "Mary Maloney",
    characterProfiles,
    sourceIntroducedCharacters: [],
    scene,
    history: [],
  } as unknown as Pick<
    GameState,
    "scene" | "history" | "characterProfiles" | "playerName" | "sourceIntroducedCharacters"
  >;
}

test("direct action interaction with an absent named character is filtered by sceneScope", () => {
  const scene = sceneWithPresentCharacters([]);
  const filtered = removeChoicesWithUnintroducedCharacters(scene, stateFor(scene));

  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["sew"]);
});

test("direct action interaction remains available once the named character is present", () => {
  const scene = sceneWithPresentCharacters(["Patrick Maloney"]);
  const filtered = removeChoicesWithUnintroducedCharacters(scene, stateFor(scene));

  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["welcome", "sew"]);
});

test("preparing for an absent character remains available without a presence target", () => {
  const scene = {
    ...sceneWithPresentCharacters([]),
    choices: [
      {
        id: "prepare_tea",
        type: "action" as const,
        text: "Fix a pot of tea and set the cup and saucer for Patrick",
        requiredAbsentCharacters: ["Patrick Maloney"],
      },
      {
        id: "sew",
        type: "action" as const,
        text: "Continue sewing while the clock keeps its patient rhythm",
      },
    ],
  };

  const filtered = removeChoicesWithUnintroducedCharacters(scene, stateFor(scene));

  assert.deepEqual(
    filtered.choices.map((choice) => choice.id),
    ["prepare_tea", "sew"],
  );
});

test("calling and listening for an absent character does not require their participation", () => {
  const scene = {
    ...sceneWithPresentCharacters([]),
    choices: [
      {
        id: "listen_and_call",
        type: "action" as const,
        text:
          "Carefully move toward the edge of the room where Patrick's steps might be "
          + "heard and call again for Patrick, keeping low and listening for a distant reply.",
        requiredPresentCharacters: [],
        requiredAbsentCharacters: ["Patrick Maloney"],
      },
      {
        id: "ask",
        type: "action" as const,
        text: "Listen for Patrick and then ask him why he is late",
        character: "Patrick Maloney",
        requiredPresentCharacters: ["Patrick Maloney"],
        requiredAbsentCharacters: [],
      },
    ],
  };

  const filtered = removeChoicesWithUnintroducedCharacters(scene, stateFor(scene));

  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["listen_and_call"]);
  assert.equal(filtered.choices[0]?.character, undefined);
  assert.deepEqual(filtered.choices[0]?.requiredPresentCharacters, []);
  assert.deepEqual(
    filtered.choices[0]?.requiredAbsentCharacters,
    ["Patrick Maloney"],
  );
});

test("searching for arrival signs is unavailable once the character is present", () => {
  const scene = {
    ...sceneWithPresentCharacters(["Patrick Maloney"]),
    choices: [{
      id: "listen_and_call",
      type: "action" as const,
      text: "Listen for Patrick's footsteps and call out for Patrick",
      requiredPresentCharacters: [],
      requiredAbsentCharacters: ["Patrick Maloney"],
    }],
  };

  const filtered = removeChoicesWithUnintroducedCharacters(scene, stateFor(scene));

  assert.deepEqual(filtered.choices, []);
});

test("player identities are removed from NPC presence prerequisites", () => {
  const scene = {
    ...sceneWithPresentCharacters([]),
    choices: [
      {
        id: "stand",
        type: "action" as const,
        text: "Stand and listen for Patrick",
        requiredPresentCharacters: ["Mary Maloney"],
        requiredAbsentCharacters: ["Patrick Maloney"],
      },
      {
        id: "sew",
        type: "action" as const,
        text: "Continue sewing",
        requiredPresentCharacters: ["Mary"],
      },
    ],
  };

  const filtered = removeChoicesWithUnintroducedCharacters(scene, stateFor(scene));

  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["stand", "sew"]);
  assert.deepEqual(filtered.choices[0]?.requiredPresentCharacters, []);
  assert.deepEqual(filtered.choices[0]?.requiredAbsentCharacters, ["Patrick Maloney"]);
  assert.deepEqual(filtered.choices[1]?.requiredPresentCharacters, []);
});

test("arrival preparation is removed once the character is present", () => {
  const scene = {
    ...sceneWithPresentCharacters(["Patrick Maloney"]),
    text: "The door opens and Patrick steps inside with a brief warm greeting.",
    choices: [
      {
        id: "prepare_arrival",
        type: "action" as const,
        text: "Prepare the room for Patrick's arrival",
        requiredAbsentCharacters: ["Patrick Maloney"],
      },
      {
        id: "share_tea",
        type: "action" as const,
        text: "Invite Patrick to share the tea",
        character: "Patrick Maloney",
        requiredPresentCharacters: ["Patrick Maloney"],
      },
    ],
  };

  const filtered = removeChoicesWithUnintroducedCharacters(scene, stateFor(scene));

  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["share_tea"]);
});

test("direct interaction is filtered when a present name is known to be non-interactable", () => {
  const scene = sceneWithPresentCharacters(["Patrick Maloney"]);
  const filtered = removeChoicesWithUnintroducedCharacters(
    scene,
    stateFor(scene),
    "",
    ["Patrick Maloney"],
  );

  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["sew"]);
});

test("uncertain presence cannot enable talk or direct interaction choices", () => {
  const untrustedScene = {
    ...sceneWithPresentCharacters(["Patrick Maloney?"]),
    text: "A stair creaks as someone steps inside; Mary waits for Patrick to appear.",
    choices: [
      { id: "talk", type: "talk" as const, text: "Talk to Patrick Maloney", character: "Patrick Maloney" },
      { id: "greet", type: "action" as const, text: "Move into the hall and greet Patrick as he enters", character: "Patrick Maloney" },
      { id: "wait", type: "action" as const, text: "Remain seated and listen for the latch" },
    ],
  };
  const scene = {
    ...untrustedScene,
    sceneScope: filterSceneScope(untrustedScene.sceneScope!, {
      knownCharacterProfiles: characterProfiles,
    }),
  };

  const filtered = removeChoicesWithUnintroducedCharacters(scene, stateFor(scene));

  assert.deepEqual(scene.sceneScope, {
    currentLocation: "Mary's living room",
    peoplePresent: [],
    peopleWithinSpeakingDistance: [],
  });
  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["wait"]);
});

test("prose cannot override an explicit unavailability verdict", () => {
  const scene = {
    ...sceneWithPresentCharacters(["Patrick Maloney"]),
    text: "Patrick Maloney arrives home and steps inside the living room.",
  };
  const filtered = removeChoicesWithUnintroducedCharacters(
    scene,
    stateFor(scene),
    "",
    ["Patrick Maloney"],
  );

  assert.deepEqual(filtered.choices.map((choice) => choice.id), ["sew"]);
});

