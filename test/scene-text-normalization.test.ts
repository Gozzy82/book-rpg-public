import assert from "node:assert/strict";
import test from "node:test";
import { stripEmbeddedChoiceMenu } from "../src/ai/engine/normalization.js";

test("scene normalization removes an inline numbered Choices menu", () => {
  const text = [
    "The air tastes of corn and possibility. I am ready to signal.",
    "",
    "Choices: 1) Wink and nod at Dorothy from my pole. 2) Speak first, greeting Dorothy before the nod. 3) Stay silent and observe Dorothy's reaction.",
  ].join("\n");

  assert.equal(
    stripEmbeddedChoiceMenu(text),
    "The air tastes of corn and possibility. I am ready to signal.",
  );
});

test("scene normalization removes an inline choice-menu suffix", () => {
  const text = "The road remains quiet. Choices: 1) Walk on. 2) Wait here.";

  assert.equal(stripEmbeddedChoiceMenu(text), "The road remains quiet.");
});

test("scene normalization preserves prose that merely mentions choices", () => {
  const text = "My choices: one road through the corn or another past the river.";

  assert.equal(stripEmbeddedChoiceMenu(text), text);
});
