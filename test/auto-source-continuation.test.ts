import { automaticSourceWindowFitsBudget } from "../src/server/auto-source-continuation.js";
import { TurnBudget } from "../src/ai/engine/turn-contract.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  isStaleSourceContinuationRequest,
  nextPendingSourceBeat,
  nextSourceBeatIsPlayerDecision,
  normalizeSourceBoundaryChoices,
} from "../src/server/auto-source-continuation.js";

const book = {
  worldBible: {
    characterProfiles: [
      { name: "Toto", aliases: [] },
    ],
  },
  storyEvents: [
    {
      eventId: "event_1",
      sequence: 1,
      beats: [
        { actor: "Dorothy", action: "Acts", agency: "intentional" },
        { actor: "Toto", action: "Chooses to bark", agency: "intentional" },
      ],
    },
    {
      eventId: "event_2",
      sequence: 2,
      beats: [
        { actor: "Toto", action: "Chooses a path", agency: "ambiguous" },
      ],
    },
  ],
} as any;

test("automatic source continuation stops at the next incomplete player decision inside an event", () => {
  const game = {
    playerName: "Toto",
    sourceEventProgress: {
      eventId: "event_1",
      completedBeatIndexes: [0],
    },
  } as any;
  assert.equal(nextSourceBeatIsPlayerDecision(game, book), true);
});

test("automatic source continuation keeps going when the next incomplete beat is an NPC beat", () => {
  const game = {
    playerName: "Toto",
    sourceEventProgress: {
      eventId: "event_1",
      completedBeatIndexes: [],
    },
  } as any;
  assert.equal(nextSourceBeatIsPlayerDecision(game, book), false);
});

test("automatic source continuation stops when the next event opens on a player decision", () => {
  const game = {
    playerName: "Toto",
    sourceCursor: {
      chapterPosition: 0,
      textOffset: 0,
      eventId: "event_1",
    },
  } as any;
  assert.equal(nextSourceBeatIsPlayerDecision(game, book), true);
});

test("completed event exposes the first beat of the next event as the pending source beat", () => {
  const crossEventBook = {
    worldBible: { characterProfiles: [{ name: "Dorothy", aliases: [] }] },
    storyEvents: [
      {
        eventId: "cyclone",
        sequence: 1,
        beats: [
          { actor: "Dorothy", action: "Falls asleep", agency: "intentional" },
        ],
      },
      {
        eventId: "landing",
        sequence: 2,
        beats: [
          { actor: null, action: "The house lands in Oz", agency: "external" },
          { actor: "Dorothy", action: "Wakes from the shock", agency: "involuntary" },
          { actor: "Dorothy", action: "Runs to the door and opens it", agency: "intentional" },
        ],
      },
    ],
  } as any;
  const game = {
    playerName: "Dorothy",
    sourceCursor: { chapterPosition: 3, textOffset: 0, eventId: "cyclone" },
    sourceEventProgress: { eventId: "cyclone", completedBeatIndexes: [0] },
  } as any;

  assert.equal(nextPendingSourceBeat(game, crossEventBook)?.action, "The house lands in Oz");
  assert.equal(nextSourceBeatIsPlayerDecision(game, crossEventBook), false);
});

test("automatic prefix of a next event replaces a source anchor with continuation", () => {
  const crossEventBook = {
    worldBible: { characterProfiles: [{ name: "Dorothy", aliases: [] }] },
    storyEvents: [
      {
        eventId: "cyclone",
        sequence: 1,
        beats: [
          { actor: "Dorothy", action: "Falls asleep", agency: "intentional" },
        ],
      },
      {
        eventId: "landing",
        sequence: 2,
        beats: [
          { actor: null, action: "The house lands in Oz", agency: "external" },
          { actor: "Dorothy", action: "Wakes from the shock", agency: "involuntary" },
          { actor: "Dorothy", action: "Runs to the door and opens it", agency: "intentional" },
        ],
      },
    ],
  } as any;
  const game = {
    playerName: "Dorothy",
    sourceCursor: { chapterPosition: 3, textOffset: 0, eventId: "cyclone" },
    sourceEventProgress: { eventId: "cyclone", completedBeatIndexes: [0] },
    turnHistory: [],
  } as any;
  const response = {
    gameId: "game_test",
    status: "active",
    scene: {
      title: "Asleep in the airborne farmhouse",
      text: "I fall asleep with Toto beside me.",
      choices: [
        { id: "__bookrpg_source_anchor__", type: "action", text: "Run to the door" },
        { id: "choice_2", type: "action", text: "Listen" },
        { id: "choice_3", type: "action", text: "Peek outside" },
      ],
    },
  } as any;

  const normalized = normalizeSourceBoundaryChoices(response, game, crossEventBook);
  assert.deepEqual(
    normalized.scene.choices.map((choice: any) => choice.id),
    ["__bookrpg_source_continuation__"],
  );
});

test("passive canonical perception auto-advances before exposing the rescue decision", () => {
  const rescueGroup = {
    kind: "player_action" as const,
    id: "character_action_rescue_after_observation",
    endBeatIndex: 3,
    playerBeatIndexes: [2, 3],
    choiceText: "Rescue Toto through the trapdoor",
    boundaryReason: "The rescue ends after Toto is safely back and the opening is secured.",
    completion: "Toto is back in the room and the trapdoor is closed.",
    preconditions: [],
    interruptWhen: [],
  };
  const rescueBook = {
    worldBible: { characterProfiles: [{ name: "Dorothy", aliases: [] }] },
    storyEvents: [{
      eventId: "trapdoor-v17",
      sequence: 1,
      beats: [
        { actor: "Toto", action: "Falls through the open trapdoor.", agency: "involuntary", stakes: "critical" },
        { actor: "Dorothy", action: "Sees one of Toto's ears sticking up through the trapdoor opening.", agency: "involuntary", stakes: "critical" },
        { actor: "Dorothy", action: "Creeps to the opening and drags Toto back into the room.", agency: "intentional", stakes: "critical", characterActionGroup: rescueGroup },
        { actor: "Dorothy", action: "Closes the trapdoor.", agency: "intentional", stakes: "significant" },
      ],
    }],
  } as any;
  const response = {
    gameId: "game_trapdoor_v17",
    status: "active",
    scene: {
      title: "Toto Below the Floor",
      text: "Toto is caught below the opening.",
      choices: [
        { id: "__bookrpg_source_anchor__", type: "action", text: "Rescue Toto through the trapdoor" },
        { id: "choice_2", type: "action", text: "Call Toto" },
      ],
    },
  } as any;

  const beforeObservation = normalizeSourceBoundaryChoices(response, {
    playerName: "Dorothy",
    sourceEventProgress: { eventId: "trapdoor-v17", completedBeatIndexes: [0] },
    turnHistory: [],
  } as any, rescueBook);
  assert.deepEqual(beforeObservation.scene.choices.map((choice: any) => choice.id), [
    "__bookrpg_source_continuation__",
  ]);

  const afterObservation = normalizeSourceBoundaryChoices(response, {
    playerName: "Dorothy",
    sourceEventProgress: { eventId: "trapdoor-v17", completedBeatIndexes: [0, 1] },
    turnHistory: [],
  } as any, rescueBook);
  assert.equal(afterObservation.scene.choices[0]?.text, "Rescue Toto through the trapdoor");
});

test("source-boundary normalization keeps the indexed player-action group label", () => {
  const rescueGroup = {
    kind: "player_action" as const,
    id: "character_action_rescue_toto",
    endBeatIndex: 3,
    playerBeatIndexes: [1, 2, 3],
    choiceText: "Rescue Toto through the trapdoor",
    boundaryReason: "The rescue ends after Toto is safely back and the opening is secured.",
    completion: "Toto is back in the room and the trapdoor is closed.",
    preconditions: [],
    interruptWhen: [],
  };
  const rescueBook = {
    worldBible: { characterProfiles: [{ name: "Dorothy", aliases: [] }] },
    storyEvents: [{
      eventId: "trapdoor",
      sequence: 1,
      beats: [
        { actor: "Toto", action: "Falls through the open trapdoor.", agency: "involuntary", stakes: "critical" },
        { actor: "Dorothy", action: "Sees one of Toto's ears sticking up through the trapdoor opening.", agency: "intentional", stakes: "critical", characterActionGroup: rescueGroup },
        { actor: "Dorothy", action: "Creeps to the opening and drags Toto back into the room.", agency: "intentional", stakes: "critical" },
        { actor: "Dorothy", action: "Closes the trapdoor.", agency: "intentional", stakes: "significant" },
      ],
    }],
  } as any;
  const game = {
    playerName: "Dorothy",
    sourceEventProgress: { eventId: "trapdoor", completedBeatIndexes: [0] },
    turnHistory: [],
  } as any;
  const response = {
    gameId: "game_trapdoor",
    status: "active",
    scene: {
      title: "The Ear Beneath the Trapdoor",
      text: "One of Toto's ears sticks up through the opening.",
      choices: [
        { id: "__bookrpg_source_anchor__", type: "action", text: "See one of Toto's ears sticking up through the trapdoor opening" },
        { id: "choice_2", type: "action", text: "Call Toto" },
      ],
    },
  } as any;

  const normalized = normalizeSourceBoundaryChoices(response, game, rescueBook);

  assert.equal(normalized.scene.choices[0]?.text, "Rescue Toto through the trapdoor");
  assert.notEqual(normalized.scene.choices[0]?.text, "See one of Toto's ears sticking up through the trapdoor opening");
});

test("a reserved continuation request is stale once auto-advance has replaced it with a real choice", () => {
  assert.equal(
    isStaleSourceContinuationRequest(
      "__bookrpg_source_continuation__",
      [{ id: "__bookrpg_source_anchor__" }, { id: "choice_2" }],
    ),
    true,
  );
  assert.equal(
    isStaleSourceContinuationRequest(
      "__bookrpg_source_continuation__",
      [{ id: "__bookrpg_source_continuation__" }],
    ),
    false,
  );
  assert.equal(
    isStaleSourceContinuationRequest(
      "choice_2",
      [{ id: "__bookrpg_source_anchor__" }],
    ),
    false,
  );
});

test("a pending canonical automatic beat does not force a local choice menu onto the source route", () => {
  const game = {playerName: "Dorothy", sourceEventProgress: {eventId: "event_1", completedBeatIndexes: []}} as any;
  const book = {worldBible: {characterProfiles: []}, storyEvents: [{eventId: "event_1", sequence: 1, beats: [{actor: null, action: "Wind rises", agency: "external"}]}]} as any;
  const response = {gameId: "test", status: "active", scene: {choices: [{id: "local", type: "action", text: "Inspect the table"}]}} as any;
  assert.equal(normalizeSourceBoundaryChoices(response, game, book), response);
});


test("automatic chain yields before a long window exhausts the shared request budget", () => {
 const chainBook={...book,storyEvents:[book.storyEvents[0],{eventId:'long',sequence:2,beats:Array.from({length:16},()=>({actor:'Dorothy',agency:'intentional',stakes:'significant'}))}]} as any;
 const game={playerName:'Toto',sourceCursor:{eventId:'event_1'}} as any;
 const budget=new TurnBudget();
 for(let i=0;i<34;i++)budget.reserve(1600);
 assert.equal(automaticSourceWindowFitsBudget(game,chainBook,budget),false);
 assert.equal(budget.calls,34); // Planning the next hop spends nothing.
 assert.equal(automaticSourceWindowFitsBudget(game,chainBook,new TurnBudget()),true);
 const tokenBudget=new TurnBudget(48,1000);
 assert.equal(automaticSourceWindowFitsBudget(game,chainBook,tokenBudget),false);
 assert.equal(automaticSourceWindowFitsBudget(game,chainBook,new TurnBudget(48,120000,0)),false);
});
