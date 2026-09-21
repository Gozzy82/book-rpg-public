import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildSourceContinuationInstruction } from "../src/ai/engine/source.js";
import { bindSourceAnchorSelection } from "../src/games/source-anchor-selection.js";
import { sourceIndexFingerprint } from "../src/books/source-index/game-version.js";
import { planTurn } from "../src/ai/engine/turn-contract.js";
import { buildTurnScript } from "../src/ai/engine/turn-script.js";
import { SOURCE_ANCHOR_CHOICE_ID, SOURCE_CONTINUATION_CHOICE_ID } from "../src/shared/contracts.js";
import type { GameState, ImportedBook, BookStoryEvent } from "../src/shared/contracts.js";
import type { SourceContinuationCandidate } from "../src/ai/engine/core.js";

const captured = JSON.parse(fs.readFileSync(new URL("./fixtures/trapdoor-transition.json", import.meta.url), "utf8"));
function fixture() {
  const event = structuredClone(captured.event) as BookStoryEvent;
  const state = structuredClone(captured.state) as GameState;
  const book = {bookId: state.bookId, chapters: [], storyEvents: [event]} as unknown as ImportedBook;
  state.sourceIndexFingerprint = sourceIndexFingerprint(book);
  state.playerActionVersion = 2;
  const candidate = {chapterPosition: 3, chapterTitle: "Oz", excerpt: "Later Dorothy rescues Toto and the house lands.", summary: "Dorothy rescues Toto. The house lands.",
    nextTextOffset: 100, requiredEventId: event.eventId, requiredEvent: event.description,
    requiredEventBeats: event.beats, requiredEventActors: event.actors, requiredEventTargets: event.targets,
    storyEvents: [event], currentStoryEvent: event,
  } as SourceContinuationCandidate;
  return {event, state, book, candidate};
}

test("captured turn 4 cannot offer the rescue before Toto's automatic fall", () => {
  const {state, book} = fixture();
  const beforeText = state.scene.text;
  state.scene.choices.push({id: "free", type: "action", text: "Look at the ceiling"});
  bindSourceAnchorSelection(state, book);
  assert.equal(state.scene.choices[0]!.id, SOURCE_CONTINUATION_CHOICE_ID);
  assert.equal(state.scene.choices.filter(c => c.id === SOURCE_CONTINUATION_CHOICE_ID).length, 1);
  assert.equal(state.scene.choices.some(c => c.id === SOURCE_ANCHOR_CHOICE_ID), false);
  assert.equal(state.scene.choices.at(-1)!.id, "free");
  assert.equal(state.scene.text, beforeText);
  assert.equal(state.sourceEventProgress, undefined);
});

test("mixed event continuation tells only the automatic prefix, not the rescue or later chapter", () => {
  const {state, candidate, event} = fixture();
  const instruction = buildSourceContinuationInstruction(candidate, "Dorothy");
  assert.match(instruction, /Falls through the open trapdoor/);
  assert.match(instruction, /one ear visible/);
  assert.doesNotMatch(instruction, /REQUIRED NEXT EVENT|SOURCE SUMMARY|Dorothy rescues|house lands|Creeps to the opening/);
  const contract = planTurn({state, event, mode: "source"});
  const script = buildTurnScript(contract);
  assert.deepEqual(script.ordered_execution.map(b => b.beat_index), [0]);
  assert.equal(script.next_decision!.beat_index, 1);
  assert.equal(script.selected_choice, null);
});

test("once the fall is completed the rescue receives a bound value and cannot replay the fall", () => {
  const {state, book, event} = fixture();
  state.sourceEventProgress = {eventId: event.eventId, completedBeatIndexes: [0]};
  bindSourceAnchorSelection(state, book);
  const choice = state.scene.choices[0]!;
  assert.equal(choice.id, SOURCE_ANCHOR_CHOICE_ID);
  assert.equal(choice.sourceBeatSelection!.beatIndex, 1);
  const plan = planTurn({state, event, mode: "action", selectedIntent: choice.text, sourceBeatSelection: choice.sourceBeatSelection});
  assert.deepEqual(plan.allowedPlayerBeatIndexes, [1]);
  assert.deepEqual(plan.requiredAutomaticBeatIndexes, []);
});

test("automatic-prefix prompting is relative to player identity, including intentional NPC actions", () => {
  const {candidate} = fixture();
  candidate.requiredEventBeats = [
    {...candidate.requiredEventBeats![0]!, actor: "Guide", agency: "intentional", action: "Explains the locked gate", resultingState: "The traveler knows why the gate is locked."},
    {...candidate.requiredEventBeats![1]!, actor: "Traveler", action: "Asks the guide for the key"},
  ];
  candidate.storyEvents = undefined;
  candidate.currentStoryEvent = undefined;
  const prompt = buildSourceContinuationInstruction(candidate, "Traveler");
  assert.match(prompt, /Explains the locked gate/);
  assert.doesNotMatch(prompt, /Asks the guide for the key/);
});
