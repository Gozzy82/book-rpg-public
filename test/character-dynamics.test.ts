import assert from "node:assert/strict";
import test from "node:test";
import type {
  CharacterProfile,
  GameState,
} from "../src/shared/contracts.js";
import {
  resolveCharacterDevelopmentStateAtSequence,
  spokenDialogueCapabilityFailure,
} from "../src/shared/character-dynamics.js";
import {
  buildCharacterRuntimeState,
  withCharacterRuntimeContext,
} from "../src/ai/engine/character-runtime.js";

function lionProfile(): CharacterProfile {
  return {
    name: "Cowardly Lion",
    aliases: ["Lion"],
    role: "Companion",
    description: "A lion who believes himself cowardly.",
    traits: ["cowardly", "loyal"],
    relationships: [],
    storyArc: "Learns that courage is acting despite fear.",
    dynamics: {
      version: 1,
      capabilities: {
        speech: {
          mode: "verbal",
          communicationModes: ["speech"],
          evidenceEventIds: ["lion_joins"],
        },
      },
      development: [
        {
          afterEventId: null,
          afterEventSequence: null,
          chapterPosition: 5,
          stateSummary: "He sees himself as a coward and uses bluster to hide fear.",
          traits: ["fearful", "boastful"],
          goals: ["find courage"],
          fears: ["danger"],
          beliefs: ["I am a coward"],
          knownFacts: [],
          relationships: [],
        },
        {
          afterEventId: "lion_defends_friends",
          afterEventSequence: 42,
          chapterPosition: 11,
          stateSummary: "He repeatedly acts bravely for his friends while still feeling fear.",
          traits: ["fearful", "protective", "brave in action"],
          goals: ["protect his companions", "find courage"],
          fears: ["danger"],
          beliefs: ["I still feel cowardly, but I can act despite fear"],
          knownFacts: ["he has protected his companions under threat"],
          relationships: [{ character: "Dorothy", description: "trusted companion" }],
        },
      ],
    },
  };
}

function totoProfile(): CharacterProfile {
  return {
    name: "Toto",
    aliases: [],
    role: "Dorothy's dog",
    description: "A small dog.",
    traits: ["loyal"],
    relationships: [],
    storyArc: "Stays with Dorothy.",
    dynamics: {
      version: 1,
      capabilities: {
        speech: {
          mode: "nonverbal",
          communicationModes: ["barking", "whining", "body language"],
          evidenceEventIds: ["toto_barks"],
        },
      },
      development: [{
        afterEventId: null,
        afterEventSequence: null,
        chapterPosition: 0,
        stateSummary: "Toto is an alert, loyal dog.",
        traits: ["loyal", "alert"],
        goals: ["stay with Dorothy"],
        fears: [],
        beliefs: [],
        knownFacts: [],
        relationships: [{ character: "Dorothy", description: "devoted companion" }],
      }],
    },
  };
}

test("character development resolves only after its canonical event boundary", () => {
  const lion = lionProfile();
  assert.match(
    resolveCharacterDevelopmentStateAtSequence(lion, 41)?.stateSummary ?? "",
    /coward/i,
  );
  assert.doesNotMatch(
    resolveCharacterDevelopmentStateAtSequence(lion, 41)?.stateSummary ?? "",
    /repeatedly acts bravely/i,
  );
  assert.match(
    resolveCharacterDevelopmentStateAtSequence(lion, 42)?.stateSummary ?? "",
    /acts bravely/i,
  );
});

test("nonverbal characters cannot enter the spoken dialogue flow", () => {
  const profiles = [lionProfile(), totoProfile()];
  assert.match(
    spokenDialogueCapabilityFailure("Toto", "Cowardly Lion", profiles) ?? "",
    /Toto.*nonverbal/i,
  );
  assert.match(
    spokenDialogueCapabilityFailure("Cowardly Lion", "Toto", profiles) ?? "",
    /Toto.*nonverbal/i,
  );
  assert.equal(
    spokenDialogueCapabilityFailure("Cowardly Lion", "Cowardly Lion", profiles),
    undefined,
  );
});

test("runtime context exposes current state and hard speech capability", () => {
  const characterProfiles = [lionProfile(), totoProfile()];
  const state = {
    playerName: "Cowardly Lion",
    characterProfiles,
  } as Pick<GameState, "playerName" | "characterProfiles">;

  const before = buildCharacterRuntimeState(state, 41);
  assert.match(before.player?.development?.state_summary ?? "", /coward/i);
  const after = buildCharacterRuntimeState(state, 42);
  assert.match(after.player?.development?.state_summary ?? "", /acts bravely/i);

  const request = withCharacterRuntimeContext(
    {
      model: "test",
      input: "GAME CONTEXT:\n{}",
      instructions: "Generate a scene.",
    },
    state,
    41,
  );
  assert.match(request.input, /CHARACTER RUNTIME STATE/);
  assert.match(request.input, /"mode": "nonverbal"/);
  assert.match(request.instructions ?? "", /hard constraints/i);
  assert.match(request.input, /Toto/);
});

test("an event in progress does not unlock its after-event development", async () => {
  const { completedCharacterEventSequence } = await import("../src/ai/engine/character-runtime.js");
  const candidates = [{currentStoryEvent: {eventId: "lion_defends_friends", sequence: 42, beats: [{}, {}]}}] as any;
  const partial = {sourceCursor: {eventId: "lion_defends_friends"}, sourceEventProgress: {eventId: "lion_defends_friends", completedBeatIndexes: [0]}} as any;
  assert.equal(completedCharacterEventSequence(partial, candidates), 41);
  assert.equal(completedCharacterEventSequence({...partial, sourceEventProgress: {...partial.sourceEventProgress, completedBeatIndexes: [0,1]}}, candidates), 42);
  assert.equal(completedCharacterEventSequence(partial, candidates, true), null);
});

test("old profile projections and full dynamics cannot leak future development", async () => {
  const { boundCharacterProfilePayload } = await import("../src/ai/engine/character-runtime.js");
  const lion = lionProfile();
  lion.storyArc = "SECRET FUTURE ARC";
  lion.dynamics!.development[1]!.knownFacts = ["SECRET FUTURE KNOWLEDGE"];
  const state = {playerName: lion.name, characterProfiles: [lion]};
  const runtime = buildCharacterRuntimeState(state, 41);
  const prepared = boundCharacterProfilePayload("GAME CONTEXT:\n" + JSON.stringify({player_profile: lion,
    character_profiles: [{name: lion.name, aliases: [], traits: ["SECRET FUTURE TRAIT"], storyArc: lion.storyArc}]}), runtime);
  assert.doesNotMatch(prepared, /SECRET FUTURE/);
  assert.match(prepared, /coward/);
});

test("production blocks nonverbal dialogue before making a provider call", async () => {
  const { TurnPipelineGameEngine } = await import("../src/ai/engine/turn-pipeline-engine.js");
  let calls = 0;
  const engine = new TurnPipelineGameEngine({provider: "openai", model: "test", async createResponse() {calls++; throw new Error("unexpected call");}});
  const state = {playerName: "Toto", characterProfiles: [totoProfile(), lionProfile()]} as GameState;
  assert.throws(() => engine.startTalk(state, "Cowardly Lion"), /nonverbal/);
  assert.throws(() => engine.continueDialogue({...state, playerName: "Cowardly Lion"}, "Toto", "Hello"), /nonverbal/);
  assert.equal(calls, 0);
});

test("enrichment validates event evidence and derives snapshot sequences from the index", async () => {
  const { enrichCharacterProfilesWithDynamics, hasCompleteCharacterDynamics } = await import("../src/books/analyze/character-dynamics.js");
  const profile = lionProfile();
  const sourceDynamics = structuredClone(profile.dynamics!);
  delete profile.dynamics;
  const book = {title: "Synthetic", chapters: [{title: "Forest"}], storyEvents: [
    {eventId: "lion_joins", sequence: 1, chapterPosition: 5, description: "Lion joins", actors: [profile.name], targets: [], beats: []},
    {eventId: "lion_defends_friends", sequence: 42, chapterPosition: 11, description: "Lion defends his companions", actors: [profile.name], targets: [], beats: []},
  ]} as any;
  const bible = {characterProfiles: [profile]} as any;
  let calls = 0;
  await enrichCharacterProfilesWithDynamics(book, bible, async () => {
    calls++;
    return {output_text: JSON.stringify({characterDynamics: [{name: profile.name,
      capabilities: {...sourceDynamics.capabilities, speech: {...sourceDynamics.capabilities.speech,
        evidenceEventIds: calls === 1 ? ["invented_event"] : ["lion_joins"]}},
      development: sourceDynamics.development,
    }]})};
  }, "test", () => {});
  assert.equal(calls, 2);
  assert.equal(hasCompleteCharacterDynamics(bible), true);
  assert.equal(profile.dynamics?.development[1]?.afterEventSequence, 42);
});

test("the production provider request contains bounded character state from its turn contract", async () => {
  const { TurnPipelineGameEngine } = await import("../src/ai/engine/turn-pipeline-engine.js");
  const { planTurn } = await import("../src/ai/engine/turn-contract.js");
  const { buildTurnScript } = await import("../src/ai/engine/turn-script.js");
  type Request = import("../src/ai/provider.js").AiResponseRequest;
  class Probe extends TurnPipelineGameEngine {
    send(request: Request) {return this.createResponse("scene choices", "test", request);}
  }
  const seen: Request[] = [];
  const engine = new Probe({provider: "openai", model: "test", async createResponse(request) {
    seen.push(request); return {status: "completed", output_text: "{}", incomplete_details: null};
  }});
  const lion = lionProfile(); lion.storyArc = "SECRET FUTURE ARC";
  const state = {playerName: lion.name, characterProfiles: [lion], scene: {text: "I wait.", title: "Forest", choices: []}, history: []} as unknown as GameState;
  const contract = planTurn({state, mode: "action", currentEventSequence: 41});
  await engine.send({model: "test", turnContract: contract, input: JSON.stringify({character_profiles: [lion]})});
  assert.doesNotMatch(seen[0]!.input, /SECRET FUTURE ARC|repeatedly acts bravely/);
  assert.match(seen[0]!.instructions ?? "", /CHARACTER RUNTIME STATE/);
  assert.equal(buildTurnScript(contract).character_runtime_state.player.development.valid_after_event_sequence, null);
});


test("profiles without development cannot carry full-book events into a turn", async () => {
  const { boundCharacterProfilePayload } = await import("../src/ai/engine/character-runtime.js");
  const { planTurn, turnContractInstructions } = await import("../src/ai/engine/turn-contract.js");
  const profile = {...lionProfile(), description: "SECRET FUTURE DESCRIPTION", traits: ["SECRET FUTURE TRAIT"],
    role: "SECRET FUTURE ROLE", storyArc: "SECRET FUTURE ARC",
    actions: [{description: "SECRET FUTURE ACTION"}],
    significantEvents: [{description: "SECRET FUTURE EVENT", automaticPreludeSourceExcerpt: "x".repeat(100000)}],
    sourceReferences: [{excerpt: "SECRET FUTURE SOURCE"}], relationships: [{description: "SECRET FUTURE RELATIONSHIP"}],
  } as unknown as CharacterProfile;
  delete profile.dynamics;
  const state = {playerName: profile.name, characterProfiles: [profile]};
  const runtime = buildCharacterRuntimeState(state, null);
  const projected = JSON.parse(boundCharacterProfilePayload(JSON.stringify(profile), runtime));
  assert.deepEqual(Object.keys(projected).sort(), ["aliases", "development", "name", "speech"]);
  assert.equal(projected.development, null);
  assert.equal(projected.speech.mode, "unknown");
  assert.equal(projected.name, profile.name);
  const planned = planTurn({state: {...state, turnNumber: 2}, mode: "action", sourceProgression: "optional"});
  const instructions = turnContractInstructions(planned);
  assert.doesNotMatch(instructions, /SECRET FUTURE|significantEvents|automaticPreludeSourceExcerpt/);
  assert.ok(instructions.length < 15000);
  assert.ok(profile.significantEvents?.length); // Projection must not mutate the stored index.
});

test("missing snapshots preserve indexed speech and unknown profile projections stay bounded", async () => {
  const { boundCharacterProfilePayload } = await import("../src/ai/engine/character-runtime.js");
  const toto = totoProfile(); toto.dynamics!.development = [];
  const runtime = buildCharacterRuntimeState({playerName: toto.name, characterProfiles: [toto]}, null);
  const input = {characters: [toto, {name: "Unknown NPC", aliases: [], significantEvents: [{description: "SECRET FUTURE"}]}],
    next_required_beat: {actor: "Toto", action: "Barks", sourceReferences: [{chapterPosition: 1}]}};
  const projected = JSON.parse(boundCharacterProfilePayload(JSON.stringify(input), runtime));
  assert.equal(projected.characters[0].speech.mode, "nonverbal");
  assert.equal(projected.characters[0].development, null);
  assert.equal(projected.characters[1].significantEvents, undefined);
  assert.deepEqual(projected.next_required_beat, input.next_required_beat);
});


test("dynamics schema permits only exact events involving each character", async () => {
  const { characterDynamicsSchemaForProfiles } = await import("../src/books/analyze/character-dynamics.js");
  const lion = lionProfile(), toto = totoProfile();
  const events = [{eventId: "lion_event", sequence: 1, actors: ["Lion"], targets: [], beats: []},
    {eventId: "toto_event", sequence: 2, actors: [], targets: [], beats: [{actor: "Toto", targets: []}]}] as any;
  const schema = characterDynamicsSchemaForProfiles([lion, toto, {...lion, name: "No events", aliases: []}], events);
  const rows = schema.properties.characterDynamics.items.anyOf;
  assert.deepEqual(rows[0]!.properties.development.items.properties.afterEventId.enum, [null, "lion_event"]);
  assert.deepEqual(rows[1]!.properties.development.items.properties.afterEventId.enum, [null, "toto_event"]);
  assert.deepEqual(rows[1]!.properties.capabilities.properties.speech.properties.evidenceEventIds.items, {type: "string", enum: ["toto_event"]});
  assert.deepEqual(rows[2]!.properties.development.items.properties.afterEventId.enum, [null]);
  assert.equal(rows[2]!.properties.capabilities.properties.speech.properties.evidenceEventIds.maxItems, 0);
});

test("development order is derived from validated event boundaries without another model call", async () => {
  const { enrichCharacterProfilesWithDynamics } = await import("../src/books/analyze/character-dynamics.js");
  const profile = lionProfile();
  const initial = profile.dynamics!.development[0]!;
  const later = profile.dynamics!.development[1]!;
  delete profile.dynamics;
  const book = {title: "Synthetic", chapters: [], storyEvents: [
    {eventId: "lion_joins", sequence: 1, chapterPosition: 5, description: "Joins", actors: [profile.name], targets: [], beats: []},
    {eventId: "lion_learns", sequence: 2, chapterPosition: 6, description: "Learns", actors: [profile.name], targets: [], beats: []},
    {eventId: "lion_defends_friends", sequence: 42, chapterPosition: 11, description: "Defends", actors: [profile.name], targets: [], beats: []},
  ]} as any;
  let calls = 0;
  await enrichCharacterProfilesWithDynamics(book, {characterProfiles: [profile]} as any, async () => {
    calls++;
    return {output_text: JSON.stringify({characterDynamics: [{name: profile.name,
      capabilities: {speech: {mode: "unknown", communicationModes: [], evidenceEventIds: []}},
      development: [initial, later, {...initial, afterEventId: "lion_learns", chapterPosition: 6}],
    }]})};
  }, "test", () => {});
  assert.equal(calls, 1);
  assert.deepEqual(profile.dynamics?.development.map(snapshot => snapshot.afterEventSequence), [null, 2, 42]);
});

test("character enrichment requests bounded groups with matching event catalogs", async () => {
  const { enrichCharacterProfilesWithDynamics } = await import("../src/books/analyze/character-dynamics.js");
  const profiles = Array.from({length: 5}, (_, i) => ({...lionProfile(), name: `Character ${i}`, aliases: [], dynamics: undefined}));
  const events = profiles.map((profile, i) => ({eventId: `event_${i}`, sequence: i, chapterPosition: 5,
    description: "Arrives", actors: [profile.name], targets: [], beats: []}));
  let calls = 0;
  await enrichCharacterProfilesWithDynamics({title: "Synthetic", chapters: [], storyEvents: events} as any,
    {characterProfiles: profiles} as any, async request => {
      calls++;
      const rows = (request.text!.format.schema as any).properties.characterDynamics.items.anyOf;
      assert.ok(rows.length <= 4);
      return {output_text: JSON.stringify({characterDynamics: rows.map((row: any) => ({name: row.properties.name.enum[0],
        capabilities: {speech: {mode: "unknown", communicationModes: [], evidenceEventIds: []}},
        development: [lionProfile().dynamics!.development[0]],
      }))})};
    }, "test", () => {});
  assert.equal(calls, 2);
  assert.ok(profiles.every(profile => profile.dynamics));
});

