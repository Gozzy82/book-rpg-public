import assert from "node:assert/strict";
import test from "node:test";
import { parseChoiceInput } from "../src/client/choice-input.js";

test("c selects automatic option-one story progression", () => {
  assert.deepEqual(parseChoiceInput("c", 2), { kind: "continue", count: 1 });
  assert.deepEqual(parseChoiceInput(" C ", 2), { kind: "continue", count: 1 });
});

test("repeated and counted c commands select consecutive automatic story choices", () => {
  assert.deepEqual(parseChoiceInput("ccc", 2), { kind: "continue", count: 3 });
  assert.deepEqual(parseChoiceInput("cccc", 2), { kind: "continue", count: 4 });
  assert.deepEqual(parseChoiceInput("ccccc", 2), { kind: "continue", count: 5 });
  assert.deepEqual(parseChoiceInput("cccccc", 2), { kind: "continue", count: 6 });
  assert.deepEqual(parseChoiceInput("cx10", 2), { kind: "continue", count: 10 });
  assert.deepEqual(parseChoiceInput(" CX15 ", 2), { kind: "continue", count: 15 });
  const excessive = parseChoiceInput("cx26", 2);
  assert.equal(excessive.kind, "invalid");
  if (excessive.kind === "invalid") {
    assert.match(excessive.message ?? "", /at most 25/i);
  }
});

test("choice input still recognizes displayed and hidden commands", () => {
  assert.deepEqual(parseChoiceInput("2", 3), { kind: "choice", index: 1 });
  assert.deepEqual(parseChoiceInput("h", 3), { kind: "history" });
  assert.deepEqual(parseChoiceInput(" HISTORY ", 3), { kind: "history" });
  assert.deepEqual(parseChoiceInput("9", 3), { kind: "story" });
  assert.deepEqual(parseChoiceInput("101", 3), { kind: "custom" });
  assert.deepEqual(parseChoiceInput("4", 3), { kind: "invalid" });
});
