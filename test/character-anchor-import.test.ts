import { bindSourceAnchorSelection } from "../src/games/source-anchor-selection.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { ImportedBook, CharacterProfile, GameState } from "../src/shared/contracts.js";
import { CHAPTER_SOURCE_INDEX_VERSION, SOURCE_ANCHOR_CHOICE_ID } from "../src/shared/contracts.js";
import type { CreateAnalysisResponse } from "../src/books/analyze/batching.js";
import { importCharacterAnchors, sharedAnchorEvents, materializeCharacterAnchors, assertCharacterAnchorsReady, SharedRouteGap, queueSharedRouteRepair, anchorEntryContexts } from "../src/books/analyze/character-anchor-import.js";
import { playerActionAt } from "../src/shared/player-actions.js";
import { parseImportArguments } from "../src/books/import-options.js";
import { sourceIndexFingerprint } from "../src/books/source-index/game-version.js";
import { startingCharacterOptions } from "../src/games/service/game-start.js";

const output = (value: unknown) => ({status: "completed" as const, output_text: JSON.stringify(value)});
function fixture(): ImportedBook {
  const sourceReferences = [{chapterPosition: 0, chapterIndex: 0, lineStart: 1, lineEnd: 3}];
  const beat = (actor: string, action: string, resultingState: string) => ({actor, action, resultingState, targets: [], agency: "intentional" as const,
    stakes: "significant" as const, sourceReferences, sourceSemantics: {mode: "present" as const, narratedContent: null, intentionalRole: "other" as const, jointAction: null}});
  return {bookId: "oz", sourceSha256: "source", title: "Oz", importedAt: "now", chapters: [{index: 0, title: "Gulf", text: "Lion waits at the gulf.\nScarecrow climbs on Lion.\nLion carries him across.",
    sourceIndex: {schemaVersion: CHAPTER_SOURCE_INDEX_VERSION, extractionMode: "shared_events_v1", summary: "They cross", characters: [], actions: [], relationships: [],
      significantEvents: [{description: "Cross the gulf", category: "departure", sourceReferences, actors: ["Scarecrow", "Cowardly Lion"], targets: [],
        beats: [beat("Scarecrow", "Climb on Lion", "Scarecrow is on Lion's back"), beat("Cowardly Lion", "Carry Scarecrow across", "Both are on the far bank")]}]}}],
    worldBible: {summary: "Oz", characters: ["Scarecrow", "Cowardly Lion"], locations: [], characterProfiles: ["Scarecrow", "Cowardly Lion"].map(name => ({name, aliases: name === "Cowardly Lion" ? ["Lion"] : [], role: "companion", description: name, storyArc: "Crosses", traits: []} as CharacterProfile))}};
}
function provider(calls: string[]): CreateAnalysisResponse {
  return async request => {
    const stage = request.text!.format.name;
    calls.push(stage);
    const input = JSON.parse(request.input);
    if (stage === "bookrpg_playable_cast") return output({characters: ["Scarecrow", "Cowardly Lion"]});
    if (stage === "bookrpg_character_choice_ranges") {
      assert.ok(input.sourceEvidence.source[0].lines.length);
      assert.equal(input.character.significantEvents, undefined);
      return output({groups: input.eligibleStarts.map((i: number) => ({startBeatIndex: i, endBeatIndex: i, label: "Cross the gulf", boundaryReason: "This action ends", completion: input.beats[i].resultingState}))});
    }
    assert.equal(stage, "bookrpg_character_anchor_review");
    assert.ok(input.source[0].lines.length);
    return output({verdict: "accepted", affectedEventIds: [], reason: "Source establishes the setup", conditions: input.entries.map((e: {startBeatIndex: number}) => ({startBeatIndex: e.startBeatIndex, preconditions: []}))});
  };
}

test("independent cast routes project into runtime without partitioning NPC goals or changing shared source", async () => {
  const book = fixture();
  const original = structuredClone(book.chapters);
  const calls: string[] = [];
  await importCharacterAnchors(book, provider(calls), "test", {log: () => {}});
  assert.deepEqual(book.chapters, original);
  assert.deepEqual(calls, ["bookrpg_playable_cast", "bookrpg_character_choice_ranges", "bookrpg_character_anchor_review", "bookrpg_character_choice_ranges", "bookrpg_character_anchor_review"]);
  assert.deepEqual(startingCharacterOptions(book), ["Scarecrow", "Cowardly Lion"]);
  const beats = book.storyEvents![0]!.beats!;
  assert.deepEqual(playerActionAt(beats, 1, ["Cowardly Lion"])!.playerBeatIndexes, [1]);
  assert.equal(playerActionAt(beats, 1, ["Scarecrow"]), undefined);
  const state = {playerName: "Cowardly Lion", playerActionVersion: 2, status: "active", turnNumber: 1,
    sourceIndexFingerprint: sourceIndexFingerprint(book), sourceEventProgress: {eventId: book.storyEvents![0]!.eventId, completedBeatIndexes: [0]},
    scene: {text: "Scarecrow is on my back.", choices: [{id: SOURCE_ANCHOR_CHOICE_ID, type: "action", text: "placeholder", sourceAnchorRoute: "event", sourceEventId: book.storyEvents![0]!.eventId}]},
  } as unknown as GameState;
  bindSourceAnchorSelection(state, book);
  assert.deepEqual(state.scene.choices[0]!.sourceBeatSelection!.playerBeatIndexes, [1]);
  assert.equal(state.scene.choices[0]!.text, "Cross the gulf");
  assert.ok(sharedAnchorEvents(book)[0]!.beats!.every(b => b.characterActionGroup === undefined));
  const before = sourceIndexFingerprint(book);
  materializeCharacterAnchors(book);
  assert.equal(sourceIndexFingerprint(book), before);
  await importCharacterAnchors(JSON.parse(JSON.stringify(book)), async () => {throw new Error("No repeated model calls for approved work");}, "test", {log: () => {}});
});

test("failed character resumes retained groups and completed characters without publishing partial routes", async () => {
  const book = fixture();
  const good = provider([]);
  let saved = "";
  await assert.rejects(importCharacterAnchors(book, async request => {
    const input = JSON.parse(request.input);
    if (request.text!.format.name === "bookrpg_character_anchor_review" && input.character.name === "Cowardly Lion") throw new Error("service unavailable");
    return good(request);
  }, "test", {save: async () => {saved = JSON.stringify(book);}, log: () => {}}), /service unavailable/);
  assert.equal(book.characterAnchors, undefined);
  assert.throws(() => assertCharacterAnchorsReady(book), /incomplete/);
  assert.deepEqual(startingCharacterOptions(book), []);
  const restored = JSON.parse(saved);
  const calls: string[] = [];
  await importCharacterAnchors(restored, provider(calls), "test", {log: () => {}});
  assert.deepEqual(calls, ["bookrpg_character_anchor_review"]);
});

test("pending legacy groups regenerate editable completions while approved work is reused", async () => {
  const book = fixture();
  const good = provider([]);
  await assert.rejects(importCharacterAnchors(book, async request => {
    const input = JSON.parse(request.input);
    if (request.text!.format.name === "bookrpg_character_anchor_review" && input.character.name === "Cowardly Lion") throw new Error("service unavailable");
    return good(request);
  }, "test", {log: () => {}}), /service unavailable/);
  for (const cp of Object.values(book.anchorImport!.events) as any[]) {
    if (!cp.reviewed) for (const range of cp.ranges) delete range.completion;
  }
  const calls: string[] = [];
  await importCharacterAnchors(JSON.parse(JSON.stringify(book)), provider(calls), "test", {log: () => {}});
  assert.deepEqual(calls, ["bookrpg_character_choice_ranges", "bookrpg_character_anchor_review"]);
});

test("source gap uses expanded evidence before reopening implicated shared checkpoints", async () => {
  const book = fixture();
  book.importAnalysis = {version: 1, parts: {chapter_1_part_1: {sourceReviewed: true, timeline: "retained"}, chapter_2_part_1: {sourceReviewed: true}}};
  let reviews = 0;
  const good = provider([]);
  const gap = await importCharacterAnchors(book, async request => {
    if (request.text!.format.name === "bookrpg_character_anchor_review") { reviews++; return output({verdict: "source_gap", affectedEventIds: [JSON.parse(request.input).event.eventId], reason: "Chapter 0 line 2: mounting omitted", conditions: []}); }
    return good(request);
  }, "test", {characters: ["Lion"], log: () => {}}).catch(e => e);
  assert.ok(gap instanceof SharedRouteGap);
  assert.equal(reviews, 2);
  queueSharedRouteRepair(book, gap);
  assert.equal(book.chapters[0]!.sourceIndex, undefined);
  assert.deepEqual(book.importAnalysis.parts.chapter_1_part_1, {timeline: "retained", routeDefect: gap.message, events: {}});
  assert.deepEqual(book.importAnalysis.parts.chapter_2_part_1, {sourceReviewed: true});
});

test("source changes invalidate approval and runtime access; explicit cast excludes supporting actors", async () => {
  const book = fixture();
  await importCharacterAnchors(book, provider([]), "test", {characters: ["Lion"], log: () => {}});
  assert.deepEqual(book.characterAnchors!.playableCharacters, ["Cowardly Lion"]);
  assertCharacterAnchorsReady(book, "Lion");
  assert.throws(() => assertCharacterAnchorsReady(book, "Scarecrow"), /No approved/);
  book.chapters[0]!.sourceIndex!.significantEvents![0]!.beats![0]!.resultingState = "Different bank";
  assert.throws(() => assertCharacterAnchorsReady(book), /stale/);
  assert.throws(() => materializeCharacterAnchors(book), /stale/);
  const calls: string[] = [];
  await importCharacterAnchors(book, provider(calls), "test", {log: () => {}});
  assert.equal(calls.filter(c => c === "bookrpg_character_choice_ranges").length, 1);
});

test("joint participants use one entry cutoff; CLI explicit names preserve quoted spaces", () => {
  const event = sharedAnchorEvents(fixture())[0]!;
  for (const b of event.beats!) b.sourceSemantics!.jointAction = {id: "joint", participants: ["Scarecrow", "Cowardly Lion"]} as any;
  event.beats![1]!.characterActionGroup = {kind: "player_action"} as any;
  assert.equal(anchorEntryContexts(event)[0]!.preconditionCutoffBeatIndex, 0);
  assert.deepEqual(parseImportArguments(["oz.epub", "--character", "Cowardly Lion", "--character", "Toto"]), {filePath: "oz.epub", reanalyze: false, characters: ["Cowardly Lion", "Toto"]});
  assert.throws(() => parseImportArguments(["oz.epub", "--character", "--reanalyze"]), /Missing character/);
});

test("entry context preserves each prior actor and excludes the current and future actions", () => {
  const event = sharedAnchorEvents(fixture())[0]!;
  const base = event.beats![0]!;
  event.beats = [
    {...base, actor: 'Winged Monkeys', targets: ['Scarecrow'], action: 'Carry Scarecrow through the air', resultingState: 'Scarecrow is airborne and frightened'},
    {...base, actor: 'Tin Woodman', targets: [], action: 'Look down', resultingState: 'Tin Woodman watches the ground'},
    {...base, actor: 'Scarecrow', action: 'Relax during the flight', resultingState: 'Scarecrow is no longer frightened', characterActionGroup: {kind:'player_action'} as any},
    {...base, actor: 'Scarecrow', action: 'Land', resultingState: 'Scarecrow is on the ground'},
  ];
  const entry = anchorEntryContexts(event)[0]!;
  assert.equal('previousState' in entry, false);
  assert.deepEqual(entry.priorBeats.map(b => b.actor), ['Winged Monkeys','Tin Woodman']);
  assert.equal(entry.priorBeats[0]!.resultingState,'Scarecrow is airborne and frightened');
  assert.equal(entry.priorBeats.length,2);
});

test("entry prefix excludes earlier representations of the same joint action", () => {
  const event = sharedAnchorEvents(fixture())[0]!;
  for (const b of event.beats!) b.sourceSemantics!.jointAction = {id:'cross',participants:['Scarecrow','Cowardly Lion']} as any;
  event.beats![1]!.characterActionGroup = {kind:'player_action'} as any;
  assert.deepEqual(anchorEntryContexts(event)[0]!.priorBeats,[]);
});
