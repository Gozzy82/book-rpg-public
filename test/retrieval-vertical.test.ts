// These regression cases explicitly exercise the optional reviewed route.
process.env.BOOKRPG_SCENE_CONTENT_REVIEW = 'true';
import { reviewPlayerActionGroups } from "../src/books/analyze/player-action-review.js";
import { CHAPTER_SOURCE_INDEX_INSTRUCTIONS } from "../src/books/analyze/requests.js";
import { PLAYER_ACTION_ACTOR_POLICY, PLAYER_ACTION_GROUP_POLICY } from "../src/books/analyze/player-action-actor-policy.js";
import { bindSourceAnchorSelection } from "../src/games/source-anchor-selection.js";
import { SOURCE_ANCHOR_CHOICE_ID } from "../src/shared/contracts.js";
import { resolveTurnPlan } from "../src/ai/engine/turn-planner.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameState, ImportedBook, PlayerAction } from "../src/shared/contracts.js";
import type { AiResponseRequest } from "../src/ai/provider.js";
import { requestChapterSourceIndexes as requestChapterSourceIndexesWithReview } from "../src/books/analyze/requests.js";
import { mergeChapterPartSourceIndexes } from "../src/books/source-index/chapter-index.js";
import { buildBookStoryEvents } from "../src/books/source-index/story-events.js";
import { sourceIndexFingerprint, assertGameSourceVersion } from "../src/books/source-index/game-version.js";
import { parsePlayerAction } from "../src/shared/player-actions.js";
import { TurnPipelineGameEngine } from "../src/ai/engine/turn-pipeline-engine.js";
import { planTurn, currentTurnExecution } from "../src/ai/engine/turn-contract.js";
import { buildTurnScript } from "../src/ai/engine/turn-script.js";
import { validateTurnEvidence } from "../src/ai/engine/turn-validator.js";
import { applyGeneratedScene, applyReviewedGeneratedScene } from "../src/games/service/game-state.js";
import { JsonFileStore } from "../src/util/json-file-store.js";

// Existing pipeline cases use a successful semantic audit; dedicated audit tests
// below exercise rejection and correction through the unwrapped production request.
const requestChapterSourceIndexes: typeof requestChapterSourceIndexesWithReview = (provider, ...args) =>
  requestChapterSourceIndexesWithReview(async request => request.text?.format.name === "bookrpg_player_action_group_review"
    ? output({valid: true, issues: []}) : provider(request), ...args);

// Deliberately short synthetic source, based on the PR #101 acceptance scenario.
const source = "Dorothy starts reaching under the bed for Toto.\nAunt Em opens the trapdoor and descends into the cellar.\nDorothy catches Toto, then starts across the room to follow Aunt Em.";
const retrieval: PlayerAction = {id: "action_c0_e0_b0", kind: "player_action", endBeatIndex: 2, boundaryReason: "Following Aunt Em is a new goal", choiceText: "Get Toto out from under the bed", playerBeatIndexes: [0, 2],
  completion: "Toto is in Dorothy's arms before she follows Aunt Em", preconditions: ["Toto is reachable under the bed"],
  interruptWhen: ["A concrete new danger blocks access", "A materially different method is required"]};
const beat = (actor: string, action: string, resultingState: string, line: number, targets: string[] = []) => ({
  actor, action, resultingState, targets, agency: "intentional", stakes: "significant", playerAction: null,
  references: [{lineStart: line, lineEnd: line}],
});
const indexed = {summary: "Dorothy retrieves Toto while Aunt Em goes down to the cellar.", characters: [
  {name: "Dorothy", aliases: [], references: [{lineStart: 1, lineEnd: 1}]},
  {name: "Toto", aliases: [], references: [{lineStart: 1, lineEnd: 1}]},
  {name: "Aunt Em", aliases: [], references: [{lineStart: 2, lineEnd: 2}]},
], actions: [], relationships: [], significantEvents: [{description: "Dorothy retrieves Toto before following Aunt Em.", references: [{lineStart: 1, lineEnd: 3}], beats: [
  {...beat("Dorothy", "Starts reaching under the bed for Toto", "Toto remains under the bed; Dorothy is reaching toward him.", 1, ["Toto"]), playerAction: retrieval},
  beat("Aunt Em", "Opens the trapdoor and descends into the cellar", "Aunt Em is below; the trapdoor is open; Toto remains under the bed.", 2),
  beat("Dorothy", "Catches Toto", "Dorothy holds Toto by the bed; the trapdoor remains open.", 3, ["Toto"]),
  beat("Dorothy", "Starts across the room to follow Aunt Em", "Dorothy carries Toto partway across the room, not yet in the cellar.", 3),
]}]};
const output = (value: unknown) => ({status: "completed" as const, output_text: JSON.stringify(value), incomplete_details: null});
async function fixture() {
  const book: ImportedBook = {bookId: "retrieval-test", title: "Retrieval fixture", sourceSha256: "fixture", importedAt: "2026-09-15", chapters: [{index: 0, title: "Farmhouse", text: source}]};
  const part = {sourceId: "part_0", chapterPosition: 0, chapterIndex: 0, chapterTitle: "Farmhouse", partIndex: 0, partCount: 1, lineStart: 1, lineEnd: 3, text: source};
  const result = await requestChapterSourceIndexes(async request => {
    const schema = request.text!.format.schema as any;
    assert.ok(schema.properties.part_0.properties.significantEvents.items.properties.beats.items.required.includes("playerAction"));
    return output({part_0: structuredClone(indexed)});
  }, "test", book, [part], 1, 0, new Map());
  assert.deepEqual([...result.validationErrors], []);
  const parsed = result.indexes.get("part_0")!;
  book.chapters[0]!.sourceIndex = mergeChapterPartSourceIndexes(0, 0, parsed.summary, [parsed]);
  book.storyEvents = buildBookStoryEvents(book);
  const event = book.storyEvents[0]!;
  assert.deepEqual(event.beats![0]!.playerAction, retrieval);
  const sceneScope = {currentLocation: "Farmhouse", peoplePresent: ["Dorothy", "Toto", "Aunt Em"], peopleWithinSpeakingDistance: ["Dorothy", "Toto", "Aunt Em"]};
  const state: GameState = {gameId: "retrieval-game", playerName: "Dorothy", playerActionVersion: 2, sourceIndexFingerprint: sourceIndexFingerprint(book),
    book: {bookId: book.bookId, title: book.title}, characterProfiles: [], parameters: [], history: [], turnNumber: 1,
    scene: {title: "Under the bed", text: "Toto waits under the bed within my reach. Aunt Em stands by the closed trapdoor.", choices: [], sceneScope},
    selectedText: source, objective: "Reach shelter", victoryCondition: "Reach shelter", status: "active", createdAt: "2026-09-15", updatedAt: "2026-09-15",
    gameProfile: {category: "adventure", endingMode: "open_ended", description: "A retrieval."}};
  const candidates = [{chapterPosition: 0, chapterTitle: "Farmhouse", summary: parsed.summary, excerpt: source, nextTextOffset: source.length,
    requiredEvent: event.description, requiredEventId: event.eventId, storyEvents: [event]}];
  return {book, event, state, candidates};
}
function defaults(schema: any): any {
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return defaults(schema.anyOf[0]);
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties).map(([k,v]) => [k, defaults(v)]));
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return true;
  if (schema.type === "integer") return 0;
  return "";
}
const prose = "I kneel beside the bed and stretch my arms toward Toto. He shifts just beyond my fingertips, and I lean a little closer to reach him. Behind me, Aunt Em lifts the trapdoor and climbs down into the cellar, leaving the opening clear. I reach beneath Toto's chest and draw him carefully toward me until I can gather him securely into my arms. His paws rest against my sleeve as I straighten beside the bed. Aunt Em is below in the cellar now, and the open trapdoor lies across the room. I remain where I am, holding Toto, with the path toward the cellar still clear.";
function client(stopped = false, forbidden = false, scenario?: {text: string; goal: string; result: string; end: number}) {
  const calls: Array<{name: string; request: AiResponseRequest; script: ReturnType<typeof buildTurnScript> | null}> = [];
  return {calls, provider: "openai" as const, model: "test", async createResponse(request: AiResponseRequest) {
    const name = request.text?.format.name ?? "";
    const contract = currentTurnExecution()?.contract;
    calls.push({name, request, script: contract ? buildTurnScript(contract) : null});
    const value = defaults(request.text!.format.schema);
    if (name === "bookrpg_single_beat_scene") return output({text: JSON.parse(request.input).transition.action});
    if (name === "bookrpg_next_decision_setup") {
      const input = JSON.parse(request.input);
      return output({text: input.indexed_end_state || "The next player decision is visibly ready to begin."});
    }
    if (name === "bookrpg_canonical_rewrite") return output({title: "Toto within reach", text: prose,
      outcome: "active", outcomeReason: "", storyMemory: {summary: "Dorothy holds Toto; Aunt Em is below.", openThreads: [], canonFacts: []},
      sceneScope: {currentLocation: "Farmhouse", peoplePresent: ["Dorothy", "Toto"], peopleWithinSpeakingDistance: ["Dorothy", "Toto"]}});
    if (name === "bookrpg_canonical_scene_review") {
      const passed = {status: "pass", reason: "Supported by the candidate."};
      return output({...value, resolvedSceneScope: {currentLocation: "Farmhouse", peoplePresent: ["Dorothy", "Toto"], peopleWithinSpeakingDistance: ["Dorothy", "Toto"]}, blocks: Object.fromEntries(Object.keys(value.blocks).map(key => [key, {observedState: "The action is visibly completed.",
        perspective: passed, action: passed, order: passed, resultingState: passed}])),
        finalState: {...passed, observedState: "Dorothy holds Toto beside the bed."},
        productionChecks: Object.fromEntries(Object.keys(value.productionChecks).map(key => [key, passed]))});
    }

    if (name === "observed_end_state") {
      const input = JSON.parse(request.input);
      assert.deepEqual(Object.keys(input).sort(), ["scene_sentences", "viewpoint_character"]);
      return output({location: "beside the bed", posture: "standing", possessions: "Toto", finalState: "Dorothy holds Toto beside the bed; Aunt Em is below.",
        evidenceSentenceIds: [input.scene_sentences.at(-1).id]});
    }
    if (name === "end_state_comparison") return output({matches: true, reason: "Dorothy holds Toto beside the bed with Aunt Em below."});
    if (name === "bookrpg_source_anchor_route_review") return output({...value, sourceAnchorRoute: "event", reason: "The selected full retrieval includes reaching for Toto."});
    if (name === "bookrpg_scene") return output({...value, title: "Toto within reach", text: stopped
      ? "I kneel and reach for Toto. The already-broken bed frame slips down against my wrist, blocking my reach. I pull my hand clear and remain beside the bed; Toto is still underneath it. Aunt Em stays at the trapdoor. The blocked opening leaves no room to lift Toto without first shifting the heavy frame."
      : (scenario?.text ?? prose) + (forbidden ? " I start across the room to follow Aunt Em." : ""),
      playerAction: scenario?.goal ?? retrieval.choiceText, actionOutcome: stopped ? "interrupted" : "succeeded", actionResult: stopped ? "The bed frame blocked my reach." : scenario?.result ?? "I hold Toto beside the bed.",
      externalDevelopment: stopped ? "" : "Aunt Em descended into the cellar.", sourceChapterPosition: null, outcome: "active", outcomeReason: "",
      storyMemory: {summary: stopped ? "Toto remains under the blocked bed." : "Dorothy holds Toto; Aunt Em is below in the cellar.", openThreads: [], canonFacts: []},
      sceneScope: {currentLocation: "Farmhouse", peoplePresent: stopped ? ["Dorothy", "Toto", "Aunt Em"] : ["Dorothy", "Toto"], peopleWithinSpeakingDistance: stopped ? ["Dorothy", "Toto", "Aunt Em"] : ["Dorothy", "Toto"]}});
    if (name === "bookrpg_scene_repetition_review") return output({...value, repeatsPriorScene: false, requiredEventOccurred: false, turnScopeFindings: [], reason: "New selected retrieval; first-person and continuous."});
    if (name === "bookrpg_scene_presence_review") {
      const observations = Object.fromEntries(Object.keys(value.beat_observations).map(key => {
        const i = Number(key.slice(5));
        return [key, {status: stopped ? i === 0 ? "partial" : "absent" : i <= (scenario?.end ?? 2) || forbidden ? "completed" : "absent",
          evidence_sentence_ids: stopped ? i === 0 ? [1] : [] : i <= (scenario?.end ?? 2) || forbidden ? [scenario ? 1 : i === 0 ? 1 : i === 1 ? 3 : i === 2 ? 4 : 8] : []}];
      }));
      const checkpoint = {observed_state: stopped ? "The attempt is blocked by the established frame." : "The depicted action endpoint is reached.", matches: !stopped, reason: stopped ? "The established obstruction stops execution." : "", evidence_sentence_ids: [1]};
      const checkpoints = value.checkpoint_observations ? {checkpoint_observations: Object.fromEntries(Object.keys(value.checkpoint_observations).map(key => [key, checkpoint])),
        final_checkpoint: {...checkpoint, matches: true}} : {};
      return output({...value, ...checkpoints, beat_observations: observations, peoplePresent: stopped ? ["Dorothy", "Toto", "Aunt Em"] : ["Dorothy", "Toto"],
        peopleWithinSpeakingDistance: stopped ? ["Dorothy", "Toto", "Aunt Em"] : ["Dorothy", "Toto"], latestVisibleSourceEventId: null,
        futureActionSetupRequired: !stopped, futureActionSetupSupported: true,
        player_action_resolution: {status: stopped ? "interrupted" : "completed", beforeBeatIndex: stopped ? 0 : null,
          causeEstablished: stopped, reason: stopped ? "The previously broken bed frame blocks access." : "Toto is held.", evidence_sentence_ids: stopped ? [2] : scenario ? [1] : [4]}});
    }
    if (name === "bookrpg_scene_choices") return output({choices: [
      {id: "a", type: "action", text: "Look toward the window", stakes: "routine", requiredPresentCharacters: [], requiredAbsentCharacters: [], sourceAnchorRoute: null},
      {id: "b", type: "action", text: "Listen for the wind outside", stakes: "routine", requiredPresentCharacters: [], requiredAbsentCharacters: [], sourceAnchorRoute: null},
    ]});
    if (name === "bookrpg_scene_choice_review") return output({...value, anchorChoiceIndex: stopped ? null : 0, unusableChoiceIndexes: [], reason: "Playable from the validated end state."});
    throw new Error(`Unexpected model call ${name}`);
  }};
}

test("narrow, legacy, divergent and other-player inputs never authorize retrieval completion", async () => {
  const {state, event} = await fixture();
  const selected = planTurn({state, mode: "action", selectedIntent: retrieval.choiceText, event});
  assert.deepEqual(selected.allowedPlayerBeatIndexes, [0, 2]);
  for (const input of ["Start reaching under the bed for Toto", "Only reach toward Toto without picking him up", "Do not get Toto out from under the bed"]) {
    const narrow = planTurn({state, mode: "action", selectedIntent: input, event});
    assert.ok(!narrow.allowedPlayerBeatIndexes.includes(2));
  }
  assert.equal(planTurn({state: {...state, playerActionVersion: undefined}, mode: "action", selectedIntent: retrieval.choiceText, event}).selectedPlayerAction, undefined);
  assert.equal(planTurn({state: {...state, playerName: "Toto"}, mode: "action", selectedIntent: retrieval.choiceText, event}).selectedPlayerAction, undefined);
  assert.equal(planTurn({state, mode: "action", sourceProgression: "optional", selectedIntent: retrieval.choiceText, event}).selectedPlayerAction, undefined);
  assert.equal(validateTurnEvidence(selected, {completedSourceEventBeatIndexes: [0, 1]}).status, "repair_scene");
  const violation = validateTurnEvidence(selected, {completedSourceEventBeatIndexes: [0, 1, 2, 3]});
  assert.equal(violation.status, "repair_scene"); assert.deepEqual(violation.observedCompletedBeatIndexes, [0, 1, 2, 3]);
  assert.deepEqual(violation.authorizedCompletedBeatIndexes, [0, 1, 2]);
});

test("reindex changes are blocked, and malformed or cross-actor retrieval links are rejected", async () => {
  const {book, state, event} = await fixture();
  const changed = structuredClone(book); changed.storyEvents![0]!.beats![2]!.action = "Catches Toto and follows Aunt Em";
  assert.throws(() => assertGameSourceVersion(state, changed), /Start a new game/);
  assert.throws(() => assertGameSourceVersion({...state, sourceIndexFingerprint: undefined}, book), /Start a new game/);
  for (const playerBeatIndexes of [[0, 1], [0, 99], [2, 0], [0, 2, 2]]) assert.throws(() => parsePlayerAction({...retrieval, playerBeatIndexes}, 0, event.beats!));
  const plan = planTurn({state, mode: "action", selectedIntent: retrieval.choiceText, event});
  for (const causeEstablished of [false, true]) {
    const result = validateTurnEvidence(plan, {completedSourceEventBeatIndexes: [0], player_action_resolution: {
      status: "interrupted", beforeBeatIndex: 1, reason: "An obstacle", causeEstablished,
    }});
    assert.equal(result.status, "repair_scene", "a label without grounded candidate evidence cannot waive progress");
  }
});

test("late interruption preserves its completed prefix; missing evidence and post-stop progress never pass", async () => {
  const {state, event} = await fixture();
  const contract = planTurn({state, mode: "action", selectedIntent: retrieval.choiceText, event});
  const observation = {completedSourceEventBeatIndexes: [0, 1], partiallyPerformedSourceEventBeatIndexes: [2], player_action_resolution: {
    status: "interrupted", beforeBeatIndex: 2, reason: "The known broken frame blocks the catch", causeEstablished: true, quote: "The frame blocks my hand."}};
  const result = validateTurnEvidence(contract, observation);
  assert.equal(result.status, "accepted"); assert.equal(result.actionOutcome, "interrupted");
  assert.deepEqual(result.authorizedCompletedBeatIndexes, [0, 1]);
  assert.equal(validateTurnEvidence(contract, {...observation, completedSourceEventBeatIndexes: [0, 1, 2]}).status, "repair_scene");
  assert.equal(validateTurnEvidence(contract, {...observation, completedSourceEventBeatIndexes: [1]}).status, "repair_scene");
  assert.equal(validateTurnEvidence(contract, {...observation, player_action_resolution: {...observation.player_action_resolution, causeEstablished: false}}).status, "repair_scene");
  const after = {...state, sourceEventProgress: {eventId: event.eventId, completedBeatIndexes: [0, 1]}};
  const next = planTurn({state: after, mode: "observe", event});
  assert.equal(next.nextPlayerDecision, 2); assert.equal(next.nextPlayerAction, undefined);
  assert.deepEqual(next.requiredAutomaticBeatIndexes, []);
});

test("absolute retrieval indexes remain correct behind a completed prefix and legacy saves remain conservative", async () => {
  const {state, event, book} = await fixture();
  const prefix = {...event.beats![1]!, action: "Calls from the trapdoor"};
  const shifted = {...event, beats: [prefix, ...structuredClone(event.beats!)]};
  shifted.beats[1]!.playerAction!.playerBeatIndexes = [1, 3];
  shifted.beats[1]!.playerAction!.endBeatIndex = 3;
  const advanced = {...state, sourceEventProgress: {eventId: event.eventId, completedBeatIndexes: [0]}};
  const contract = planTurn({state: advanced, mode: "action", selectedIntent: retrieval.choiceText, event: shifted});
  assert.deepEqual(contract.allowedPlayerBeatIndexes, [1, 3]); assert.deepEqual(contract.requiredAutomaticBeatIndexes, [2]);
  assert.equal(contract.nextPlayerDecision, 4);
  const legacyBook = structuredClone(book); legacyBook.chapters[0]!.sourceIndex!.schemaVersion = 8 as any;
  const legacy = {...state, playerActionVersion: undefined, sourceIndexFingerprint: undefined};
  assert.doesNotThrow(() => assertGameSourceVersion(legacy, legacyBook));
  const oldPlan = planTurn({state: legacy, mode: "action", selectedIntent: "Start reaching under the bed for Toto", event});
  assert.deepEqual(oldPlan.allowedPlayerBeatIndexes, [0]); assert.deepEqual(oldPlan.requiredAutomaticBeatIndexes, [1]);
  assert.equal(oldPlan.nextPlayerDecision, 2);
});

test("semantic full-goal paraphrases work while narrow and uncertain inputs keep the first-beat boundary", async () => {
  const {resolveTurnPlan} = await import("../src/ai/engine/turn-planner.js");
  const {state, event} = await fixture();
  const full = await resolveTurnPlan({state, mode: "action", selectedIntent: "Pick Toto up from beneath the bed", event}, "test", async request => {
    assert.equal(JSON.parse(request.input).candidate_player_action.choiceText, retrieval.choiceText);
    return output({selectedPrefixLength: 0, selectedPlayerAction: true, reason: "Explicitly selects the same full goal."});
  });
  assert.deepEqual(full.allowedPlayerBeatIndexes, [0, 2]);
  for (const input of ["Only reach toward Toto", "Maybe I could get Toto", "Do not pick Toto up"]) {
    const plan = await resolveTurnPlan({state, mode: "action", selectedIntent: input, event}, "test", async () => output({
      selectedPrefixLength: input.startsWith("Only") ? 1 : 0, selectedPlayerAction: false, reason: "Does not authorize the whole goal."}));
    assert.equal(plan.selectedPlayerAction, undefined); assert.ok(!plan.allowedPlayerBeatIndexes.includes(2));
  }
  await assert.rejects(resolveTurnPlan({state, mode: "action", selectedIntent: "Pick Toto up", event}, "test", async () => output({
    selectedPrefixLength: 1, reason: "Missing full-goal verdict"})), /could not be verified/);
});

test("production import preserves a social action ending at an NPC answer and rejects crossing its new-information boundary", async () => {
  const {book} = await fixture();
  const raw = structuredClone(indexed) as any;
  raw.significantEvents[0].beats = [
    {...beat("Dorothy", "Asks Aunt Em where the key is", "Dorothy has asked the question", 1, ["Aunt Em"]),
      playerAction: {...retrieval, choiceText: "Ask Aunt Em where the key is", playerBeatIndexes: [0], endBeatIndex: 1, boundaryReason: "The answer provides new information"}},
    beat("Aunt Em", "Answers that the key is in the chest", "Dorothy knows where the key is", 2, ["Dorothy"]),
    {...beat("Dorothy", "Agrees to trade Toto for the key", "Dorothy made a new commitment", 3, ["Aunt Em"]), decisionBoundaryBefore: "New commitment after hearing the answer"},
  ];
  const part = {sourceId: "social", chapterPosition: 0, chapterIndex: 0, chapterTitle: "A question", partIndex: 0, partCount: 1,
    lineStart: 1, lineEnd: 3, text: "Dorothy asks Aunt Em where the key is while Toto waits.\nAunt Em says it is in the chest.\nDorothy agrees to trade Toto for the key."};
  const run = () => requestChapterSourceIndexes(async () => output({social: raw}), "test", book, [part], 1, 0, new Map());
  const valid = await run(); assert.deepEqual([...valid.validationErrors], []);
  const merged = mergeChapterPartSourceIndexes(0, 0, "A question and a decision", [valid.indexes.get("social")!]);
  assert.equal(merged.schemaVersion, 17);
  assert.equal(merged.significantEvents![0]!.beats![0]!.playerAction!.endBeatIndex, 1);
  assert.match(merged.significantEvents![0]!.beats![2]!.decisionBoundaryBefore!, /New commitment/);
  raw.significantEvents[0].beats[0].playerAction.playerBeatIndexes = [0, 2];
  raw.significantEvents[0].beats[0].playerAction.endBeatIndex = 2;
  const invalid = await run(); assert.equal(invalid.indexes.size, 0);
  assert.match([...invalid.validationErrors.values()].join(" "), /decision boundary/);
});


test("invalid player action feedback identifies the field and event-local index for repair", async () => {
  const {event} = await fixture();
  assert.throws(() => parsePlayerAction({...retrieval, endBeatIndex: 99}, 0, event.beats!), /beat index 0: endBeatIndex=99/);
  assert.throws(() => parsePlayerAction({...retrieval, playerBeatIndexes: [1, 2]}, 0, event.beats!), /playerBeatIndexes must start with 0/);
  assert.deepEqual(parsePlayerAction({...retrieval, preconditions: [], interruptWhen: []}, 0, event.beats!)!.preconditions, []);
  assert.throws(() => parsePlayerAction({...retrieval, preconditions: [" "]}, 0, event.beats!), /preconditions must be an array of non-empty strings/);
  const routine = structuredClone(event.beats!);
  routine[0]!.stakes = "routine";
  assert.throws(() => parsePlayerAction(retrieval, 0, routine), /Use playerAction=null on automatic\/routine beats/);
});


const repairPart = {sourceId: "part_0", chapterPosition: 0, chapterIndex: 0, chapterTitle: "Farmhouse", partIndex: 0, partCount: 1, lineStart: 1, lineEnd: 3, text: source};
const repairBook: ImportedBook = {bookId: "repair", title: "Repair", sourceSha256: "repair", importedAt: "2026-09-15", chapters: [{index: 0, title: "Farmhouse", text: source}]};
const repairGoal = () => {
  const {id, kind, playerBeatIndexes, ...fields} = retrieval;
  return fields;
};

test("production import repairs only action metadata using bounded slots and preserves atomic source evidence", async () => {
  const raw = structuredClone(indexed);
  raw.significantEvents[0]!.beats[0]!.playerAction = {...retrieval, endBeatIndex: -1};
  raw.significantEvents[0]!.beats[1]!.stakes = "routine";
  raw.significantEvents[0]!.beats[1]!.playerAction = {...retrieval};
  let calls = 0;
  const result = await requestChapterSourceIndexes(async request => {
    calls++;
    if (calls === 1) return output({part_0: raw});
    assert.equal(request.text!.format.name, "bookrpg_player_action_repair");
    const schema = request.text!.format.schema as any;
    assert.deepEqual(Object.keys(schema.properties), ["beat_0", "beat_2", "beat_3"]);
    assert.deepEqual(schema.properties.beat_2.anyOf[1].properties.endBeatIndex.enum, [2, 3]);
    assert.equal(schema.properties.beat_0.anyOf[1].properties.playerBeatIndexes, undefined);
    assert.match(request.input as string, /IMMUTABLE EVENT/);
    return output({beat_0: repairGoal(), beat_2: null, beat_3: null});
  }, "test", repairBook, [repairPart], 1, 1, new Map());
  assert.equal(calls, 2);
  assert.deepEqual([...result.validationErrors], []);
  const beats = result.indexes.get("part_0")!.significantEvents[0]!.beats;
  assert.deepEqual(beats[0]!.playerAction, Object.fromEntries(Object.entries(retrieval).filter(([key]) => key !== "id")));
  assert.equal(beats[1]!.playerAction, undefined);
  for (const [i, b] of beats.entries()) {
    for (const field of ["actor", "action", "resultingState", "stakes", "agency", "references"] as const) {
      assert.deepEqual(b[field], raw.significantEvents[0]!.beats[i]![field]);
    }
  }
});

test("action repair retries keep the validated source and reject out-of-range endpoints without regenerating the chapter", async () => {
  const raw = structuredClone(indexed);
  raw.significantEvents[0]!.beats[0]!.playerAction = {...retrieval, endBeatIndex: -1};
  const cache = new Map();
  let sourceCalls = 0, repairs = 0;
  const client = async (request: AiResponseRequest) => {
    if (request.text!.format.name !== "bookrpg_player_action_repair") {
      sourceCalls++; return output({part_0: raw});
    }
    repairs++;
    return output({beat_0: {...repairGoal(), endBeatIndex: repairs === 1 ? 99 : 2}, beat_1: null, beat_2: null, beat_3: null});
  };
  const first = await requestChapterSourceIndexes(client, "test", repairBook, [repairPart], 1, 1, new Map(), cache);
  assert.equal(first.indexes.size, 0);
  assert.match(first.validationErrors.get("part_0")!, /endBeatIndex must be one of/);
  assert.equal(cache.size, 1);
  const second = await requestChapterSourceIndexes(client, "test", repairBook, [repairPart], 1, 2, first.validationErrors, cache);
  assert.equal(second.indexes.size, 1);
  assert.equal(sourceCalls, 1);
  assert.equal(repairs, 2);
  assert.equal(cache.size, 0);
});

test("invalid source identities cannot be accepted through action repair", async () => {
  const raw = structuredClone(indexed);
  raw.characters.push({name: "Wicked Witch of the East", aliases: [], references: [{lineStart: 1, lineEnd: 1}]});
  raw.significantEvents[0]!.beats[0]!.playerAction = {...retrieval, endBeatIndex: -1};
  let calls = 0;
  const cache = new Map();
  const result = await requestChapterSourceIndexes(async () => {calls++; return output({part_0: raw});}, "test", repairBook, [repairPart], 1, 1, new Map(), cache);
  assert.equal(result.indexes.size, 0);
  assert.equal(cache.size, 0);
  assert.equal(calls, 1);
});


test("action repair cannot cross decision boundaries or accept overlapping goals", async () => {
  for (const boundary of [true, false]) {
    const raw = structuredClone(indexed);
    raw.significantEvents[0]!.beats[0]!.playerAction = {...retrieval, endBeatIndex: -1};
    if (boundary) Object.assign(raw.significantEvents[0]!.beats[3]!, {decisionBoundaryBefore: "Following is a new goal"});
    const result = await requestChapterSourceIndexes(async request => {
      if (request.text!.format.name !== "bookrpg_player_action_repair") return output({part_0: raw});
      const schema = request.text!.format.schema as any;
      if (boundary) assert.deepEqual(schema.properties.beat_0.anyOf[1].properties.endBeatIndex.enum, [0, 1, 2]);
      return output({beat_0: {...repairGoal(), endBeatIndex: boundary ? 3 : 2}, beat_1: null,
        beat_2: boundary ? null : {...repairGoal(), endBeatIndex: 2}, beat_3: null});
    }, "test", repairBook, [repairPart], 1, 1, new Map());
    assert.equal(result.indexes.size, 0);
    assert.match(result.validationErrors.get("part_0")!, boundary ? /endBeatIndex must be one of/ : /overlapping goals/);
  }
});

test("a masked source error reaches retry feedback with the previous candidate instead of a misleading group error", async () => {
  const raw = structuredClone(indexed);
  raw.significantEvents[0]!.beats[0]!.playerAction = {...retrieval, endBeatIndex: -1};
  const later = structuredClone(raw.significantEvents[0]!);
  later.beats[0]!.agency = "external";
  raw.significantEvents.push(later);
  const sourceCache = new Map();
  const actionCache = new Map();
  let calls = 0;
  const client = async (request: AiResponseRequest) => {
    calls++;
    assert.equal(request.text!.format.name, "bookrpg_chapter_source_index");
    if (calls === 1) return output({part_0: raw});
    assert.match(request.instructions!, /Source validation failed before action repair:.*external/);
    assert.match(request.input as string, /PREVIOUS UNVALIDATED CANDIDATES/);
    assert.ok((request.input as string).includes(JSON.stringify({part_0: raw})));
    return output({part_0: indexed});
  };
  const first = await requestChapterSourceIndexes(client, "test", repairBook, [repairPart], 1, 1, new Map(), actionCache, () => {}, sourceCache);
  assert.match(first.validationErrors.get("part_0")!, /external beat 1 of significant event 2/);
  assert.doesNotMatch(first.validationErrors.get("part_0")!, /endBeatIndex/);
  assert.equal(sourceCache.size, 1);
  assert.equal(actionCache.size, 0);
  const second = await requestChapterSourceIndexes(client, "test", repairBook, [repairPart], 1, 2, first.validationErrors, actionCache, () => {}, sourceCache);
  assert.equal(second.indexes.size, 1);
  assert.equal(sourceCache.size, 0);
  assert.equal(calls, 2);
});

test("source retry candidates remain untrusted and unsupported names still block import", async () => {
  const raw = structuredClone(indexed);
  raw.characters.push({name: "Soldier with Green Whiskers", aliases: [], references: [{lineStart: 1, lineEnd: 1}]});
  const sourceCache = new Map();
  const actionCache = new Map();
  let calls = 0;
  const client = async (request: AiResponseRequest) => {
    calls++;
    if (calls > 1) {
      assert.match(request.instructions!, /Do not invent an alias/);
      assert.match(request.input as string, /PREVIOUS UNVALIDATED CANDIDATES/);
    }
    return output({part_0: raw});
  };
  const first = await requestChapterSourceIndexes(client, "test", repairBook, [repairPart], 1, 1, new Map(), actionCache, () => {}, sourceCache);
  const second = await requestChapterSourceIndexes(client, "test", repairBook, [repairPart], 1, 2, first.validationErrors, actionCache, () => {}, sourceCache);
  assert.equal(second.indexes.size, 0);
  assert.match(second.validationErrors.get("part_0")!, /Soldier with Green Whiskers/);
  assert.equal(actionCache.size, 0);
  assert.equal(calls, 2);
});


test("clicked canonical anchor uses its saved value, skips intent/route review and binds the next decision", async () => {
  const {book, state, candidates, event} = await fixture();
  const model = client(); const engine = new TurnPipelineGameEngine(model);
  state.scene = await engine.refreshSceneChoices(state, candidates);
  bindSourceAnchorSelection(state, book);
  const choice = state.scene.choices[0]!;
  assert.deepEqual(choice.sourceBeatSelection, {eventId: event.eventId, beatIndex: 0, endBeatIndex: 2, kind: "player_action", actionId: retrieval.id, playerBeatIndexes: [0, 2]});
  // Same value, different grammatical perspective: no model may reinterpret the selection.
  choice.text = "Dorothy brings Toto safely out from beneath the bed.";
  const generated = await engine.continue(state, choice.text, candidates, {anchorDirected: true,
    sourceEventId: choice.sourceEventId, sourceAnchorRoute: choice.sourceAnchorRoute,
    sourceBeatSelection: choice.sourceBeatSelection});
  assert.equal(model.calls.filter(c => c.name === "bookrpg_source_anchor_route_review" || c.name === "bookrpg_turn_intent_review").length, 0);
  const writerScript = model.calls.find(c => c.name === "bookrpg_canonical_rewrite")!.script!;
  const reviewerScript = model.calls.find(c => c.name === "bookrpg_canonical_scene_review")!.script!;
  assert.equal(model.calls.filter(c => c.name === "bookrpg_single_beat_scene").length, 3);
  assert.equal(model.calls.filter(c => ["bookrpg_scene", "bookrpg_scene_repetition_review", "bookrpg_scene_presence_review", "observed_end_state", "end_state_comparison"].includes(c.name)).length, 0);
  assert.equal(writerScript.selected_choice!.value, retrieval.id);
  assert.deepEqual(writerScript.selected_choice!.player_beat_indexes, [0, 2]);
  assert.deepEqual(reviewerScript.selected_choice, writerScript.selected_choice);
  assert.deepEqual(reviewerScript.ordered_execution, writerScript.ordered_execution);
  assert.deepEqual(generated.sourceEventProgress?.completedBeatIndexes, [0, 1, 2]);
  applyGeneratedScene(state, generated, book);
  bindSourceAnchorSelection(state, book);
  assert.deepEqual(state.scene.choices[0]!.sourceBeatSelection, {eventId: event.eventId, beatIndex: 3, endBeatIndex: 3, kind: "beat"});
  assert.throws(() => planTurn({state, event, mode: "action", selectedIntent: choice.text,
    sourceBeatSelection: choice.sourceBeatSelection}), /no longer matches/);
});

test("anchor values authorize one player decision across automatic preludes and consequences, independent of labels", async () => {
  const {state, event} = await fixture();
  const changed = structuredClone(event);
  changed.beats![0]!.agency = "involuntary";
  delete changed.beats![0]!.playerAction;
  changed.beats![2]!.agency = "involuntary";
  changed.beats![1]!.actor = "Dorothy";
  const sourceBeatSelection = {eventId: changed.eventId, beatIndex: 1, endBeatIndex: 1, kind: "beat" as const};
  const contract = await resolveTurnPlan({state, event: changed, mode: "action", selectedIntent: "Dorothy opens the trapdoor.", sourceBeatSelection}, "test",
    async () => {throw new Error("A clicked anchor must not need intent review");});
  assert.deepEqual(contract.allowedPlayerBeatIndexes, [1]);
  assert.deepEqual(contract.requiredAutomaticBeatIndexes, [0, 2]);
  assert.equal(contract.nextPlayerDecision, 3);
  for (const bad of [
    {...sourceBeatSelection, eventId: "other-event"},
    {...sourceBeatSelection, beatIndex: 3, endBeatIndex: 3},
    {...sourceBeatSelection, endBeatIndex: 3},
    {...sourceBeatSelection, kind: "player_action" as const},
  ]) assert.throws(() => planTurn({state, event: changed, mode: "action", selectedIntent: "Label", sourceBeatSelection: bad}));
});

test("only the marked direct action anchor receives a server-owned value", async () => {
  const {state, book, event} = await fixture();
  const fake = {eventId: "forged", beatIndex: 99, endBeatIndex: 99, kind: "beat" as const};
  state.scene.choices = [
    {id: SOURCE_ANCHOR_CHOICE_ID, type: "action", text: "Goal", sourceEventId: event.eventId, sourceAnchorRoute: "event", sourceBeatSelection: fake},
    {id: "local", type: "action", text: "Another choice", sourceBeatSelection: fake},
  ];
  bindSourceAnchorSelection(state, book);
  assert.equal(state.scene.choices[0]!.sourceBeatSelection!.beatIndex, 0);
  assert.equal(state.scene.choices[1]!.sourceBeatSelection, undefined);
  state.scene.choices[0]!.sourceAnchorRoute = "transition";
  bindSourceAnchorSelection(state, book);
  assert.equal(state.scene.choices[0]!.sourceBeatSelection, undefined);
  state.scene.choices[0]!.sourceAnchorRoute = "event";
  state.scene.choices[0]!.type = "talk";
  bindSourceAnchorSelection(state, book);
  assert.equal(state.scene.choices[0]!.sourceBeatSelection, undefined, "opening a conversation does not select an utterance");
});


test("an automatic continuation anchor never acquires consent for a later intentional beat", async () => {
  const {state, book, event} = await fixture();
  book.storyEvents![0]!.beats![0]!.agency = "involuntary";
  delete book.storyEvents![0]!.beats![0]!.playerAction;
  state.sourceIndexFingerprint = sourceIndexFingerprint(book);
  state.scene.choices = [{id: SOURCE_ANCHOR_CHOICE_ID, type: "action", text: "Wait", sourceEventId: event.eventId, sourceAnchorRoute: "event"}];
  bindSourceAnchorSelection(state, book);
  assert.equal(state.scene.choices[0]!.sourceBeatSelection, undefined);
});

test("a selected anchor group includes following automatic consequences but stops at the next player choice", async () => {
  const {state, event} = await fixture();
  const changed = structuredClone(event);
  const nextDecision = structuredClone(changed.beats![3]!);
  changed.beats![3]!.actor = "Aunt Em";
  changed.beats!.push(nextDecision);
  const selection = {eventId: changed.eventId, beatIndex: 0, endBeatIndex: 2, kind: "player_action" as const, actionId: retrieval.id, playerBeatIndexes: [0, 2]};
  const contract = planTurn({state, event: changed, mode: "action", selectedIntent: "Display label", sourceBeatSelection: selection});
  assert.deepEqual(contract.allowedPlayerBeatIndexes, [0, 2]);
  assert.deepEqual(contract.requiredAutomaticBeatIndexes, [1, 3]);
  assert.equal(contract.nextPlayerDecision, 4);
  assert.deepEqual(state.sourceEventProgress, undefined, "selection is not itself completed progress");
});


test("index generation and semantic review repair a fragmented goal before it becomes a saved executable group", async () => {
  const broken = structuredClone(indexed);
  const beats = broken.significantEvents[0]!.beats;
  beats[0]!.playerAction = {...retrieval, endBeatIndex: 0, playerBeatIndexes: [0],
    completion: "Dorothy only begins reaching", boundaryReason: "Aunt Em descends", interruptWhen: ["Aunt Em descends"]};
  beats[2]!.action = "Catches Toto and follows Aunt Em";
  beats.pop();
  const sourceCache = new Map();
  const repairCache = new Map();
  let generations = 0, reviews = 0;
  const provider = async (request: AiResponseRequest) => {
    if (request.text!.format.name === "bookrpg_player_action_group_review") {
      reviews++;
      assert.match(request.instructions!, /NPC interleaving alone is not an interruption/);
      assert.match(request.instructions!, /Atomic beats must split different player goals/);
      return output(reviews === 1 ? {valid: false, issues: [{repairTarget: "source", eventIndex: 0, beatIndexes: [0, 1, 2],
        reason: "Split catching from following; include starting and catching in the retrieval group across Aunt Em's descent. The label currently promises more than the group completes."}]} : {valid: true, issues: []});
    }
    generations++;
    if (generations > 1) {
      assert.match(request.instructions!, /Split catching from following/);
      assert.match(request.input as string, /PREVIOUS UNVALIDATED CANDIDATES/);
    }
    return output({part_0: generations === 1 ? broken : indexed});
  };
  const rejected = await requestChapterSourceIndexesWithReview(provider, "test", repairBook, [repairPart], 1, 1, new Map(), repairCache, () => {}, sourceCache);
  assert.equal(rejected.indexes.size, 0, "semantic rejection cannot become a checkpoint");
  assert.match(rejected.validationErrors.get("part_0")!, /group review rejected/);
  const accepted = await requestChapterSourceIndexesWithReview(provider, "test", repairBook, [repairPart], 1, 2, rejected.validationErrors, repairCache, () => {}, sourceCache);
  assert.equal(accepted.indexes.size, 1);
  assert.equal(reviews, 2);
  const parsed = accepted.indexes.get("part_0")!;
  const chapter = mergeChapterPartSourceIndexes(0, 0, parsed.summary, [parsed]);
  const group = chapter.significantEvents![0]!.beats![0]!.playerAction!;
  assert.equal(group.id, "action_c0_e0_b0");
  assert.deepEqual(group.playerBeatIndexes, [0, 2]);
  assert.equal(group.endBeatIndex, 2);
  assert.match(chapter.significantEvents![0]!.beats![3]!.action, /follow Aunt Em/);
});

test("group identity supplies every selected beat to generator and reviewer, independently of the label", async () => {
  const {state, book, event} = await fixture();
  state.scene.choices = [{id: SOURCE_ANCHOR_CHOICE_ID, type: "action", text: "A display label", sourceEventId: event.eventId, sourceAnchorRoute: "event"}];
  bindSourceAnchorSelection(state, book);
  const value = state.scene.choices[0]!.sourceBeatSelection!;
  assert.equal(value.actionId, retrieval.id);
  assert.deepEqual(value.playerBeatIndexes, [0, 2]);
  const contract = planTurn({state, event, mode: "action", selectedIntent: "Different display text", sourceBeatSelection: value});
  const script = buildTurnScript(contract);
  assert.equal(script.selected_choice!.value, retrieval.id);
  assert.equal(script.selected_choice!.label, "Different display text");
  assert.deepEqual(script.selected_choice!.player_beat_indexes, [0, 2]);
  assert.deepEqual(script.selected_choice!.automatic_beat_indexes, [1]);
  assert.equal(script.selected_action, retrieval.completion);
  for (const bad of [{...value, actionId: "another-group"}, {...value, playerBeatIndexes: [0]}]) {
    assert.throws(() => planTurn({state, event, mode: "action", selectedIntent: "Same label", sourceBeatSelection: bad}), /window changed/);
  }
});

test("unavailable or inconsistent group reviews fail closed before checkpointing", async () => {
  for (const verdict of [output({valid: true, issues: [{eventIndex: 0, beatIndexes: [0], reason: "Mismatch"}]}),
    {status: "incomplete" as const, output_text: "", incomplete_details: {reason: "max_output_tokens"}}]) {
    const result = await requestChapterSourceIndexesWithReview(async request => request.text!.format.name === "bookrpg_player_action_group_review"
      ? verdict : output({part_0: indexed}), "test", repairBook, [repairPart], 1, 1, new Map());
    assert.equal(result.indexes.size, 0);
    assert.equal(result.invalidParts.length, 1);
  }
});


test("index generation and review use each group's actor as hypothetical player, never a fixed protagonist", async () => {
  const {event} = await fixture();
  const index = {summary: "Two characters pursue their own goals", characters: [], actions: [], relationships: [], significantEvents: [{
    description: event.description, actors: ["Dorothy", "Aunt Em"], targets: [], references: [{lineStart: 1, lineEnd: 3}],
    beats: event.beats!.map(b => ({...b, references: [{lineStart: 1, lineEnd: 3}]})),
  }]};
  index.significantEvents[0]!.beats[1]!.playerAction = {...retrieval, playerBeatIndexes: [1], endBeatIndex: 1,
    choiceText: "Open the trapdoor and descend", completion: "Aunt Em is below in the cellar"};
  assert.ok(CHAPTER_SOURCE_INDEX_INSTRUCTIONS.includes(PLAYER_ACTION_ACTOR_POLICY));
  let calls = 0;
  await reviewPlayerActionGroups(async request => {
    calls++;
    assert.ok(request.instructions!.includes(PLAYER_ACTION_ACTOR_POLICY));
    assert.match(request.instructions!, /no player character has been selected during import/);
    const input = request.input as string;
    const contexts = JSON.parse(input.split("GROUP ACTOR CONTEXTS (no global player):\n")[1]!.split("\nCANDIDATE INDEX:")[0]!);
    assert.deepEqual(contexts.map((c: any) => [c.beatIndex, c.hypotheticalPlayer, c.playerBeatIndexes]),
      [[0, "Dorothy", [0, 2]], [1, "Aunt Em", [1]]]);
    return output({valid: true, issues: []});
  }, "test", repairPart, index);
  assert.equal(calls, 1);
  assert.deepEqual(index.significantEvents[0]!.beats[1]!.playerAction!.playerBeatIndexes, [1]);
});


test("semantic label and boundary repairs preserve source beats, routine stakes and unrelated events", async () => {
  const raw = structuredClone(indexed);
  raw.significantEvents.push(structuredClone(indexed.significantEvents[0]!));
  raw.significantEvents[0]!.beats[1]!.stakes = "routine";
  raw.significantEvents[0]!.beats[0]!.playerAction = {...retrieval, choiceText: "Tell Dorothy about Kansas",
    interruptWhen: ["Aunt Em responds"]};
  const original = structuredClone(raw);
  const cache = new Map(), sourceCache = new Map();
  let generations = 0, repairs = 0, reviews = 0;
  const provider = async (request: AiResponseRequest) => {
    assert.ok(request.instructions!.includes(PLAYER_ACTION_GROUP_POLICY));
    switch (request.text!.format.name) {
      case "bookrpg_chapter_source_index": generations++; return output({part_0: raw});
      case "bookrpg_player_action_repair": {
        repairs++;
        const schema = request.text!.format.schema as any;
        assert.equal(schema.properties.beat_1, undefined, "routine beat cannot become a choice");
        assert.match(schema.properties.beat_0.description, /owner Dorothy: Starts reaching/);
        assert.match(request.input as string, /IMMUTABLE EVENT 0/);
        assert.match(request.instructions!, /wrong label and NPC interruption/);
        return output({beat_0: repairGoal(), beat_2: null, beat_3: null});
      }
      case "bookrpg_player_action_group_review":
        reviews++;
        assert.match(request.instructions!, /null annotation alone is not a review defect/);
        assert.match(request.instructions!, /an event has no hypothetical player/);
        return output(reviews === 1 ? {valid: false, issues: [{repairTarget: "player_action", eventIndex: 0,
          beatIndexes: [0], reason: "Correct wrong label and NPC interruption on Dorothy's retrieval."}]} : {valid: true, issues: []});
      default: throw new Error("Unexpected request");
    }
  };
  const first = await requestChapterSourceIndexesWithReview(provider, "test", repairBook, [repairPart], 1, 1, new Map(), cache, () => {}, sourceCache);
  assert.equal(first.indexes.size, 0);
  assert.equal(sourceCache.size, 0);
  const second = await requestChapterSourceIndexesWithReview(provider, "test", repairBook, [repairPart], 1, 2, first.validationErrors, cache, () => {}, sourceCache);
  assert.equal(second.indexes.size, 1);
  assert.deepEqual([generations, repairs, reviews], [1, 1, 2]);
  assert.equal(cache.size, 0);
  assert.deepEqual(raw.significantEvents[1], original.significantEvents[1], "unrelated event is untouched");
  for (const [i, b] of raw.significantEvents[0]!.beats.entries()) {
    const {playerAction: _actual, ...actual} = b;
    const {playerAction: _expected, ...expected} = original.significantEvents[0]!.beats[i]!;
    assert.deepEqual(actual, expected);
  }
  const corrected = second.indexes.get("part_0")!.significantEvents[0]!.beats;
  assert.equal(corrected[0]!.playerAction!.choiceText, retrieval.choiceText);
  assert.equal(corrected[1]!.stakes, "routine");
  assert.equal(corrected[1]!.playerAction, undefined);
});

test("semantic repair cannot remove rejected goals and retries without rebuilding source", async () => {
  const cache = new Map();
  let generations = 0, repairs = 0, reviews = 0;
  const provider = async (request: AiResponseRequest) => {
    if (request.text!.format.name === "bookrpg_chapter_source_index") {
      generations++; return output({part_0: structuredClone(indexed)});
    }
    if (request.text!.format.name === "bookrpg_player_action_group_review") {
      reviews++;
      return output(reviews === 1 ? {valid: false, issues: [{repairTarget: "player_action", eventIndex: 0,
        beatIndexes: [0], reason: "Correct the label on the existing goal."}]} : {valid: true, issues: []});
    }
    repairs++;
    return output({beat_0: repairs === 1 ? null : repairGoal(), beat_1: null, beat_2: null, beat_3: null});
  };
  const first = await requestChapterSourceIndexesWithReview(provider, "test", repairBook, [repairPart], 1, 1, new Map(), cache);
  const second = await requestChapterSourceIndexesWithReview(provider, "test", repairBook, [repairPart], 1, 2, first.validationErrors, cache);
  assert.equal(second.indexes.size, 0);
  assert.match(second.validationErrors.get("part_0")!, /preserve the reviewed goal/);
  const third = await requestChapterSourceIndexesWithReview(provider, "test", repairBook, [repairPart], 1, 3, second.validationErrors, cache);
  assert.equal(third.indexes.size, 1);
  assert.deepEqual([generations, repairs, reviews], [1, 2, 2]);
});

test("an unavailable or unclassified semantic verdict retries only review on the same candidate", async () => {
  for (const badReview of [output({valid: false, issues: [{eventIndex: 0, beatIndexes: [0], reason: "Missing repair target"}]}),
    {status: "incomplete" as const, output_text: "", incomplete_details: {reason: "max_output_tokens"}}]) {
    const cache = new Map();
    let generations = 0, reviews = 0;
    const provider = async (request: AiResponseRequest) => {
      if (request.text!.format.name === "bookrpg_player_action_group_review") {
        reviews++; return reviews === 1 ? badReview : output({valid: true, issues: []});
      }
      assert.equal(request.text!.format.name, "bookrpg_chapter_source_index");
      generations++; return output({part_0: structuredClone(indexed)});
    };
    const first = await requestChapterSourceIndexesWithReview(provider, "test", repairBook, [repairPart], 1, 1, new Map(), cache);
    assert.equal(first.indexes.size, 0);
    const second = await requestChapterSourceIndexesWithReview(provider, "test", repairBook, [repairPart], 1, 2, first.validationErrors, cache);
    assert.equal(second.indexes.size, 1);
    assert.deepEqual([generations, reviews], [1, 2]);
    assert.equal(cache.size, 0);
  }
});

