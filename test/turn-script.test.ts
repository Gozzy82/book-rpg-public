import assert from "node:assert/strict";
import test from "node:test";
import type { GameState, StoryEventBeat } from "../src/shared/contracts.js";
import type { AiResponseRequest } from "../src/ai/provider.js";
import { planTurn, runPlannedTurn } from "../src/ai/engine/turn-contract.js";
import { buildTurnScript, renderTurnScript } from "../src/ai/engine/turn-script.js";
import { validateTurnEvidence } from "../src/ai/engine/turn-validator.js";
import { TurnPipelineGameEngine } from "../src/ai/engine/turn-pipeline-engine.js";
import { summarizeAcceptedSourceWindow } from "../src/ai/engine/cross-event-window.js";

const beat = (actor: string | null, action: string): StoryEventBeat => ({actor, action,
  targets: [], agency: actor ? "intentional" : "external", stakes: "significant", sourceReferences: []});
const event = {eventId: "cyclone", beats: [
  beat("Dorothy", "Catches Toto and follows Aunt Em."),
  beat(null, "The house shakes and Dorothy sits down."),
  beat(null, "The house whirls, rises, and is carried away."),
  beat("Toto", "Runs around the airborne room barking."),
  {...beat("Toto", "Falls through the open trapdoor."), agency: "involuntary" as const},
  beat("Dorothy", "Catches Toto by the ear, pulls him back, and closes the trapdoor."),
  beat("Dorothy", "SECRET LATER SLEEP ACTION"),
]};
const state = {playerName: "Dorothy", characterProfiles: [{name: "Dorothy", aliases: [], description: "Kansas girl"}],
  parameters: [], history: [], scene: {title: "Airborne", text: "I sit on the floor.", choices: []},
  sourceEventProgress: {eventId: "cyclone", completedBeatIndexes: [0,1]},
} as unknown as GameState;

test("starting retrieval completes the selected attempt without authorizing the later catch", () => {
  const attemptEvent = {eventId: "attempt", beats: [
    {...beat("Dorothy", "Starts trying to retrieve Toto from under the bed."), resultingState: "Toto remains under the bed."},
    beat("Aunt Em", "Opens the trapdoor and climbs into the cellar."),
    beat("Dorothy", "Catches Toto and follows Aunt Em."),
  ]};
  const contract = planTurn({state: {...state, sourceEventProgress: undefined}, event: attemptEvent,
    mode: "action", sourceProgression: "required", selectedIntent: attemptEvent.beats[0]!.action});
  const script = buildTurnScript(contract);
  assert.deepEqual(script.ordered_execution.map(b => b.beat_index), [0, 1]);
  assert.equal(script.next_decision?.beat_index, 2);
  assert.equal(script.ordered_execution[0]!.resulting_state, "Toto remains under the bed.");
  assert.match(renderTurnScript(contract), /beginning the attempt completes this beat without completing its ultimate goal/);
  assert.equal(validateTurnEvidence(contract, {completedSourceEventBeatIndexes: [0, 1],
    futureActionSetupRequired: true, futureActionSetupSupported: true}).status, "accepted");
  assert.equal(validateTurnEvidence(contract, {completedSourceEventBeatIndexes: [0, 1, 2],
    futureActionSetupRequired: true, futureActionSetupSupported: true}).status, "repair_scene");
});

test("source continuation renders all remaining automatic actions and one setup-only decision", () => {
  const script = buildTurnScript(planTurn({state, event, mode: "source_continue", sourceProgression: "required"}));
  assert.deepEqual(script.ordered_execution.map(b => b.beat_index), [2,3,4]);
  assert.equal(script.ordered_execution[0]!.do, event.beats[2]!.action);
  assert.equal(script.next_decision?.beat_index, 5);
  assert.equal(script.next_decision?.must_remain_unperformed, true);
  assert.equal(script.next_decision?.purpose, "setup_only");
  assert.doesNotMatch(JSON.stringify(script), /SECRET LATER/);
  assert.equal(script.story_so_far.current_scene.text, state.scene.text);
});

test("an optional source route neither requires automatic beats nor forces the next anchor setup", () => {
  const contract = planTurn({state, event, mode: "action", selectedIntent: "Inspect the floor", sourceProgression: "optional"});
  const script = buildTurnScript(contract);
  assert.deepEqual(script.ordered_execution, []);
  assert.equal(script.next_decision, null);
  assert.equal(validateTurnEvidence(contract, {completedSourceEventBeatIndexes: [],
    futureActionSetupRequired: true, futureActionSetupSupported: false}).status, "accepted");
});

test("the chosen source action executes before automatic consequences; the next action stays future", () => {
  const contract = planTurn({state: {...state, sourceEventProgress: undefined}, event, mode: "action",
    sourceProgression: "required", selectedIntent: event.beats[0]!.action});
  const script = buildTurnScript(contract);
  assert.deepEqual(script.ordered_execution.map(b => b.beat_index), [0,1,2,3,4]);
  assert.equal(script.ordered_execution[0]!.execution, "selected_player_action");
  assert.equal(script.next_decision?.beat_index, 5);
  const decision = validateTurnEvidence(contract, {completedSourceEventBeatIndexes: [0,1,2,3,4],
    futureActionSetupRequired: false, futureActionSetupSupported: false});
  assert.equal(decision.status, "repair_scene");
  assert.ok(decision.findings.some(f => f.code === "missing_setup"));
});

class Probe extends TurnPipelineGameEngine {
  send(label: string, request: AiResponseRequest) {return this.createResponse(label, "test", request);}
}

test("the identical bounded script survives final request adapters for writer and presence review", async () => {
  const requests: AiResponseRequest[] = [];
  const engine = new Probe({provider: "openai", model: "test", async createResponse(request) {
    requests.push(request);
    return {status: "completed", output_text: JSON.stringify({completedSourceEventBeatIndexes: [2,3,4],
      futureActionSetupRequired: true, futureActionSetupSupported: true}), incomplete_details: null};
  }});
  const contract = planTurn({state, event, mode: "source_continue", sourceProgression: "required"});
  await runPlannedTurn(contract, async () => {
    await engine.send("scene", {model: "test", input: "GAME CONTEXT:\n{}"});
    await engine.send("scene presence review", {model: "test", input: "{}"});
  });
  const script = (request: AiResponseRequest) => request.instructions!.split("ORDERED TURN SCRIPT")[1];
  assert.equal(script(requests[0]!), script(requests[1]!));
  assert.match(script(requests[0]!), /The house whirls, rises, and is carried away/);
  assert.match(script(requests[0]!), /Runs around the airborne room barking/);
  assert.match(script(requests[0]!), /Falls through the open trapdoor/);
  assert.doesNotMatch(script(requests[0]!), /SECRET LATER/);
});

test("opening context snapshots stay immutable and exclude the future character profile", () => {
  const contract = planTurn({state, event, mode: "opening"});
  const before = buildTurnScript(contract);
  assert.equal(before.player.profile.description, undefined);
  const changed = {...state, scene: {...state.scene, text: "changed"}};
  assert.notEqual(buildTurnScript(contract).story_so_far.current_scene.text, changed.scene.text);
});

test("source checkpoints enter the shared script without authorizing the next postcondition", () => {
  const checkpointEvent = {...event, beats: event.beats.map((beat, i) => ({...beat, resultingState: `Checkpoint ${i}`}))};
  const planned = planTurn({state, event: checkpointEvent, mode: "source_continue"});
  const script = buildTurnScript(planned);
  assert.equal(script.source_start_state, "Checkpoint 1");
  assert.equal(script.ordered_execution[0]!.resulting_state, "Checkpoint 2");
  assert.doesNotMatch(JSON.stringify(script.next_decision), /Checkpoint 5/);
  assert.equal(script.next_decision?.must_remain_unperformed, true);
});

test("presence script omits source quotations while preserving the authorized actions and checkpoints", () => {
  const planned = planTurn({state, event, mode: "source_continue"});
  const withEvidence = {...planned, sourceEvidence: {2: "SOURCE WORDING MUST NOT BE QUOTED AS CANDIDATE EVIDENCE"}};
  const writer = buildTurnScript(withEvidence);
  const reviewer = buildTurnScript(withEvidence, false);
  assert.match(writer.ordered_execution[0]!.source_evidence, /SOURCE WORDING/);
  assert.equal(reviewer.ordered_execution[0]!.source_evidence, "");
  assert.deepEqual(reviewer.ordered_execution.map(b => [b.beat_index, b.do, b.resulting_state]), writer.ordered_execution.map(b => [b.beat_index, b.do, b.resulting_state]));
});


test("a pinned anchor batches direct automatic events until the next player decision", () => {
  const withState = (actor: string | null, action: string, resultingState: string): StoryEventBeat => ({
    ...beat(actor, action),
    resultingState,
  });
  const stormWatch = {
    eventId: "storm-watch",
    sequence: 1,
    chapterPosition: 3,
    beats: [
      withState("Uncle Henry", "Looks anxiously at the gray sky.", "Uncle Henry watches the sky."),
      withState("Dorothy", "Looks toward the sky while holding Toto.", "Dorothy watches the sky holding Toto."),
      withState(null, "Wind from north and south bends the prairie grass.", "The storm is visibly close."),
    ],
  };
  const warning = {
    eventId: "cyclone-warning",
    sequence: 2,
    chapterPosition: 3,
    beats: [
      withState("Uncle Henry", "Warns Aunt Em about the cyclone.", "Aunt Em has been warned."),
      withState("Uncle Henry", "Runs toward the livestock sheds.", "Uncle Henry is running to the sheds."),
      withState("Aunt Em", "Drops her work and comes to the door.", "Aunt Em is at the doorway."),
      withState("Aunt Em", "Tells Dorothy to run to the cellar.", "Dorothy has been told to reach the cellar."),
    ],
  };
  const retrievalStart = withState(
    "Dorothy",
    "Starts trying to get Toto from under the bed.",
    "Dorothy has begun retrieving Toto but does not yet have him.",
  );
  retrievalStart.characterActionGroup = {
    kind: "player_action",
    endBeatIndex: 3,
    boundaryReason: "The bounded goal ends after Dorothy has Toto and starts toward shelter.",
    choiceText: "Retrieve Toto and head for the cellar",
    playerBeatIndexes: [1, 3],
    completion: "Dorothy is holding Toto and has started toward the cellar.",
    preconditions: [],
    interruptWhen: [],
  };
  const retrievalFinish = withState(
    "Dorothy",
    "Catches Toto and starts following Aunt Em toward the cellar.",
    "Dorothy is holding Toto and has started toward shelter.",
  );
  retrievalFinish.characterActionGroup = null;
  const toto = {
    eventId: "toto-escapes",
    sequence: 3,
    chapterPosition: 3,
    beats: [
      withState("Toto", "Jumps from Dorothy's arms and hides under the bed.", "Toto is under the bed."),
      retrievalStart,
      withState("Aunt Em", "Opens the trapdoor and climbs into the cellar.", "Aunt Em is in the cellar."),
      retrievalFinish,
    ],
  };
  const crossState = {
    ...state,
    playerActionVersion: 2 as const,
    sourceEventProgress: {eventId: stormWatch.eventId, completedBeatIndexes: [0]},
  };
  const contract = planTurn({
    state: crossState,
    event: stormWatch,
    followingEvents: [stormWatch, warning, toto],
    sourceEventEntries: {},
    mode: "action",
    sourceProgression: "required",
    selectedIntent: stormWatch.beats[1]!.action,
    sourceBeatSelection: {
      eventId: stormWatch.eventId,
      beatIndex: 1,
      endBeatIndex: 1,
      kind: "beat",
    },
  });

  assert.deepEqual(contract.allowedPlayerBeatIndexes, [1]);
  assert.deepEqual(contract.requiredAutomaticBeatIndexes, [2, 3, 4, 5, 6, 7]);
  assert.equal(contract.nextPlayerDecision, 8);
  assert.equal(contract.nextPlayerAction?.choiceText, "Retrieve Toto and head for the cellar");
  assert.deepEqual(contract.nextPlayerAction?.playerBeatIndexes, [8, 10]);
  assert.equal(contract.nextPlayerAction?.endBeatIndex, 10);
  assert.equal(contract.beatOrigins[7]?.eventId, toto.eventId);
  assert.equal(contract.beatOrigins[7]?.beatIndex, 0);
  assert.deepEqual(contract.nextPlayerDecisionOrigin, {
    eventId: toto.eventId,
    beatIndex: 1,
    chapterPosition: 3,
  });

  const script = buildTurnScript(contract);
  assert.deepEqual(
    script.ordered_execution.map((step) => [step.event_id, step.source_beat_index]),
    [
      [stormWatch.eventId, 1],
      [stormWatch.eventId, 2],
      [warning.eventId, 0],
      [warning.eventId, 1],
      [warning.eventId, 2],
      [warning.eventId, 3],
      [toto.eventId, 0],
    ],
  );
  assert.equal(script.next_decision?.event_id, toto.eventId);
  assert.equal(script.next_decision?.source_beat_index, 1);

  const accepted = summarizeAcceptedSourceWindow({
    primaryEventId: contract.eventId,
    primaryStartBeatIndex: contract.startBeatIndex,
    primaryCompletedBeatIndexes: contract.completedBeatIndexes,
    beatOrigins: contract.beatOrigins,
    completedFlatBeatIndexes: [0, 1, 2, 3, 4, 5, 6, 7],
    events: [stormWatch, warning, toto],
  });
  assert.deepEqual(accepted.completedEventIds, [stormWatch.eventId, warning.eventId]);
  assert.equal(accepted.lastCompletedEventId, warning.eventId);
  assert.deepEqual(accepted.sourceEventProgress, {
    eventId: toto.eventId,
    completedBeatIndexes: [0],
  });
});

test("cross-event batching stops before a source-backed event-entry gap", () => {
  const primary = {
    eventId: "before-gap",
    sequence: 1,
    chapterPosition: 3,
    beats: [
      {...beat("Dorothy", "Choose the canonical action."), resultingState: "The action is complete."},
      {...beat(null, "An automatic consequence follows."), resultingState: "The consequence is complete."},
    ],
  };
  const afterGap = {
    eventId: "after-gap",
    sequence: 2,
    chapterPosition: 3,
    beats: [
      {...beat("Uncle Henry", "Acts after omitted source transition text."), resultingState: "The later action is complete."},
      {...beat("Dorothy", "Makes the next decision."), resultingState: "The next decision is complete."},
    ],
  };
  const contract = planTurn({
    state: {...state, sourceEventProgress: undefined},
    event: primary,
    followingEvents: [primary, afterGap],
    sourceEventEntries: {
      [afterGap.eventId]: {
        fromEventId: primary.eventId,
        excerpt: "After a while the circumstances change.",
        entryExcerpt: "The later action can now begin.",
      },
    },
    mode: "action",
    sourceProgression: "required",
    selectedIntent: primary.beats[0]!.action,
    sourceBeatSelection: {
      eventId: primary.eventId,
      beatIndex: 0,
      endBeatIndex: 0,
      kind: "beat",
    },
  });

  assert.equal(contract.beats.length, primary.beats.length);
  assert.deepEqual(contract.requiredAutomaticBeatIndexes, [1]);
  assert.equal(contract.nextPlayerDecision, null);
  assert.ok(contract.beatOrigins.every((origin) => origin.eventId === primary.eventId));
});


test("legacy serialized turn contracts render without event-origin metadata", () => {
  const planned = planTurn({state, event, mode: "source_continue", sourceProgression: "required"});
  const legacy = JSON.parse(JSON.stringify(planned)) as typeof planned;
  delete (legacy as any).beatOrigins;
  delete (legacy as any).nextPlayerDecisionOrigin;
  const script = buildTurnScript(legacy);
  assert.deepEqual(script.ordered_execution.map((step) => step.event_id), ["cyclone", "cyclone", "cyclone"]);
  assert.deepEqual(script.ordered_execution.map((step) => step.source_beat_index), [2, 3, 4]);
  assert.equal(script.next_decision?.event_id, "cyclone");
  assert.equal(script.next_decision?.source_beat_index, 5);
});
