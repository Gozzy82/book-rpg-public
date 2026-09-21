import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {turnCharacters} from "../src/ai/engine/turn-characters.js";
import {buildTurnScript} from "../src/ai/engine/turn-script.js";
import type {TurnContract} from "../src/ai/engine/turn-contract.js";
const contract: TurnContract = JSON.parse(fs.readFileSync(new URL("./fixtures/selected-retrieval-contract.json", import.meta.url), "utf8"));

test("retrieval keeps Dorothy once and only present or acting characters, without event lists", () => {
  const characters = turnCharacters(contract);
  assert.equal(characters.player.name, "Dorothy");
  assert.deepEqual(characters.characters.map((p: any) => p.name).sort(), ["Aunt Em", "Toto", "Uncle Henry"]);
  assert.equal(characters.characters.find((p: any) => p.name === "Toto").speech.mode, "nonverbal");
  assert.doesNotMatch(JSON.stringify(characters), /significantEvents|evidenceEventIds|valid_after_event_id|storyArc|Scarecrow/);
  assert.deepEqual(buildTurnScript(contract).ordered_execution.map(b => b.beat_index), [3,4,5,6]);
});

test("authorized arriving actors and aliases are included but later-event actors are not", () => {
  const context = JSON.parse(contract.contextJson);
  context.current_scene.sceneScope = {peoplePresent: ["Dorothy"], peopleWithinSpeakingDistance: []};
  const em = context.character_runtime.characters.find((p: any) => p.name === "Aunt Em");
  em.aliases = ["Em"];
  const beats = contract.beats.map((b, i) => i === 4 ? {...b, actor: "Em"} : b);
  const scoped = {...contract, beats, contextJson: JSON.stringify(context)};
  const snapshot = scoped.contextJson;
  assert.ok(turnCharacters(scoped).characters.some((p: any) => p.name === "Aunt Em"));
  assert.ok(!turnCharacters(scoped).characters.some((p: any) => p.name === "Uncle Henry"));
  assert.equal(scoped.contextJson, snapshot);
  const originalPlayer = context.character_runtime.player;
  assert.deepEqual(turnCharacters(scoped).player.development.known_facts, originalPlayer.development.known_facts);
});
