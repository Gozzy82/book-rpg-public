import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlayerSelection } from "../src/client/player-selection.js";

const characters = ["Harry Potter", "Rubeus Hagrid"];

test("player selection resolves displayed character numbers", () => {
  assert.equal(resolvePlayerSelection("1", characters), "Harry Potter");
  assert.equal(resolvePlayerSelection(" 2 ", characters), "Rubeus Hagrid");
});

test("player selection rejects custom names and numbers outside the displayed list", () => {
  assert.equal(resolvePlayerSelection("Gordon", characters), undefined);
  assert.equal(resolvePlayerSelection("3", characters), undefined);
  assert.equal(resolvePlayerSelection("", characters), undefined);
});
