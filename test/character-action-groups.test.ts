import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { BookStoryEvent, GameState, ImportedBook } from "../src/shared/contracts.js";
import { SOURCE_ANCHOR_CHOICE_ID } from "../src/shared/contracts.js";
import { applyCharacterChoiceRanges, groupExistingCharacterEvent } from "../src/books/analyze/character-action-groups.js";
import { playerActionAt } from "../src/shared/player-actions.js";
import { sourceIndexFingerprint } from "../src/books/source-index/game-version.js";
import { bindSourceAnchorSelection } from "../src/games/source-anchor-selection.js";
import { resolveTurnPlan } from "../src/ai/engine/turn-planner.js";
import { buildTurnScript } from "../src/ai/engine/turn-script.js";

// Actual stored character events from the uploaded (7).json index, not a newly generated timeline.
const events: BookStoryEvent[] = JSON.parse(fs.readFileSync(new URL("./fixtures/import-goals/existing-character-events.json", import.meta.url), "utf8"));
const dorothy = {characterId: "dorothy", name: "Dorothy", aliases: []};
const range = (startBeatIndex: number, endBeatIndex: number, label = "Complete this action") => ({startBeatIndex, endBeatIndex, label, boundaryReason: "Goal completed or physically interrupted at this endpoint"});
const totoRanges = [range(3, 5, "Retrieve Toto and try to reach the cellar")];
const oilRanges = [range(0, 1, "Find water and have breakfast"), range(2, 3, "Ask about the groan"), range(4, 6, "Discover the motionless figure"), range(7, 11, "Fetch oil and help the Tin Woodman move again")];

test("existing Toto and oil timelines gain character groups without changing any original source field", () => {
  for (const [i, ranges] of [totoRanges, oilRanges].entries()) {
    const original = events[i]!;
    const grouped = applyCharacterChoiceRanges(original, dorothy, ranges);
    assert.deepEqual({...grouped, beats: grouped.beats!.map(({characterActionGroup: _g, ...b}) => b)}, original);
    assert.ok(original.beats!.every(b => b.characterActionGroup === undefined));
    const start = i === 0 ? 3 : 7;
    const group = playerActionAt(grouped.beats!, start, ["Dorothy"])!;
    assert.deepEqual(group.playerBeatIndexes, i === 0 ? [3, 5] : [7, 8, 9, 11]);
    assert.equal(group.endBeatIndex, i === 0 ? 5 : 11);
    assert.equal(playerActionAt(grouped.beats!, start, ["Toto"]), undefined);
    assert.equal(playerActionAt(grouped.beats!, group.endBeatIndex, ["Dorothy"]), undefined);
  }
});

test("canonical label/value authorizes Toto retrieval across Em, includes shock and never invokes intent review", async () => {
  const event = applyCharacterChoiceRanges(events[0]!, dorothy, totoRanges);
  const book = {bookId: "test", chapters: [], storyEvents: [event]} as unknown as ImportedBook;
  const state = {playerName: "Dorothy", playerActionVersion: 2, status: "active", turnNumber: 1,
    sourceIndexFingerprint: sourceIndexFingerprint(book), sourceEventProgress: {eventId: event.eventId, completedBeatIndexes: [0, 1, 2]},
    scene: {text: "Toto is under the bed.", choices: [{id: SOURCE_ANCHOR_CHOICE_ID, type: "action", text: "placeholder", sourceAnchorRoute: "event", sourceEventId: event.eventId}]},
  } as unknown as GameState;
  bindSourceAnchorSelection(state, book);
  const choice = state.scene.choices[0]!;
  assert.equal(choice.text, totoRanges[0]!.label);
  assert.deepEqual(choice.sourceBeatSelection!.playerBeatIndexes, [3, 5]);
  const contract = await resolveTurnPlan({state, event, mode: "action", selectedIntent: "Dorothy retrieves Toto and tries to reach shelter.", sourceBeatSelection: choice.sourceBeatSelection}, "unused", async () => {throw new Error("No model intent review allowed");});
  assert.deepEqual(contract.allowedPlayerBeatIndexes, [3, 5]);
  assert.deepEqual(contract.requiredAutomaticBeatIndexes, [4, 6]);
  const script = buildTurnScript(contract);
  assert.equal(script.selected_choice!.value, event.beats![3]!.characterActionGroup!.id);
  assert.deepEqual(script.selected_choice!.player_beat_indexes, [3, 5]);
  assert.throws(() => applyCharacterChoiceRanges(event, {name: "Toto", aliases: []}, totoRanges), /Invalid/);
});

test("grouping rejects missing coverage, overlap, invalid ends and ambiguous player authorization", () => {
  const oil = events[1]!;
  for (const ranges of [[], [range(7, 11)], [...oilRanges, range(11, 11)], [...oilRanges.slice(0, 3), range(7, 99)]]) {
    assert.throws(() => applyCharacterChoiceRanges(oil, dorothy, ranges));
  }
  const uncertain = structuredClone(oil);
  uncertain.beats![9]!.agency = "ambiguous";
  assert.throws(() => applyCharacterChoiceRanges(uncertain, dorothy, oilRanges), /unlisted/);
});

test("existing-event grouping uses one model call and surfaces rejection without retry or source rewrite", async () => {
  let calls = 0;
  const success = await groupExistingCharacterEvent(async request => {
    calls++;
    assert.equal(request.text!.format.name, "bookrpg_character_choice_ranges");
    assert.equal(request.reasoning!.effort, "medium");
    assert.deepEqual(JSON.parse(request.input).eligibleStarts, [3, 5]);
    return {status: "completed", output_text: JSON.stringify({groups: totoRanges})};
  }, "test", events[0]!, dorothy);
  assert.equal(success.event.beats![3]!.characterActionGroup!.endBeatIndex, 5);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(groupExistingCharacterEvent(async () => {
    calls++;
    return {status: "completed", output_text: JSON.stringify({groups: []})};
  }, "test", events[0]!, dorothy), /Every intentional/);
  assert.equal(calls, 1);
});

test("full runtime character profiles cannot leak other events or old grouping into the request", async () => {
  const marker = "STALE_PROFILE_PAYLOAD";
  const fullProfile = {...dorothy, description: marker.repeat(30000), significantEvents: events,
    actions: [{description: marker}], dynamics: {history: marker}, relationships: [{description: marker}]};
  await groupExistingCharacterEvent(async request => {
    const input = JSON.parse(request.input);
    assert.deepEqual(input.character, dorothy);
    assert.deepEqual(Object.keys(input).sort(), ["beats", "character", "description", "eligibleStarts", "eventId"]);
    assert.equal(input.beats.length, events[0]!.beats!.length);
    assert.equal(request.input.includes(marker), false);
    assert.equal(request.input.includes(events[1]!.eventId), false);
    assert.equal(request.input.includes('"playerAction"'), false);
    assert.equal(request.input.includes('"characterActionGroup"'), false);
    assert.ok(request.input.length < 5000, `Unexpected request size: ${request.input.length}`);
    return {status: "completed", output_text: JSON.stringify({groups: totoRanges})};
  }, "test", events[0]!, fullProfile);
});
