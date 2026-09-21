import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpeningPlayerDecisionBoundaryInstruction,
} from "../src/ai/engine/provider-turn-engine.js";
import {
  buildSourceContinuationInstruction,
} from "../src/ai/engine/source.js";

test("opening player decision boundary keeps the Scarecrow wink wholly future", () => {
  const instruction = buildOpeningPlayerDecisionBoundaryInstruction({
    actor: "Scarecrow",
    action: "Winks and nods at Dorothy from his pole.",
    targets: ["Dorothy"],
    agency: "intentional",
    stakes: "significant",
    sourceReferences: [],
  } as any).join("\n");

  assert.match(instruction, /structured player-decision boundary/i);
  assert.match(instruction, /"kind":"first_unselected_player_beat"/i);
  assert.match(instruction, /"mustRemainUnperformed":true/i);
  assert.match(instruction, /Winks and nods at Dorothy from his pole/i);
  assert.match(instruction, /must remain wholly future/i);
  assert.doesNotMatch(instruction, /STOP BEFORE PLAYER BEAT/i);
  assert.doesNotMatch(instruction, /PENDING PLAYER BEAT/i);
});

test("direct source continuation requires an NPC retrieval beat to reach its result", () => {
  const fetchOilBeat = {
    actor: "Dorothy",
    action: "Fetches the oil-can from the cottage.",
    targets: [],
    agency: "intentional",
    stakes: "significant",
    sourceReferences: [],
  } as any;
  const candidate = {
    chapterPosition: 4,
    chapterTitle: "The Rescue of the Tin Woodman",
    excerpt: "Dorothy went back to the cottage for the oil-can.",
    nextTextOffset: 100,
    summary: "Dorothy fetches the oil-can and the Tin Woodman is oiled.",
    requiredEvent: "Dorothy and the Scarecrow free the Tin Woodman by oiling his rusted joints.",
    requiredEventId: "event_oil",
    requiredEventActors: ["Dorothy", "Scarecrow"],
    requiredEventTargets: ["Tin Woodman"],
    requiredEventBeats: [fetchOilBeat],
  } as any;
  const profiles = [
    { name: "Tin Woodman", aliases: [] },
    { name: "Dorothy", aliases: [] },
    { name: "Scarecrow", aliases: [] },
  ] as any;

  const instruction = buildSourceContinuationInstruction(
    candidate,
    "Tin Woodman",
    profiles,
  );

  assert.match(
    instruction,
    /NEXT REQUIRED SOURCE BEAT TO COMPLETE NOW: Dorothy.*Fetches the oil-can from the cottage/s,
  );
  assert.match(instruction, /Starting it.*does not count as completing it/s);
  assert.match(instruction, /show the named result actually achieved before stopping/i);
});
