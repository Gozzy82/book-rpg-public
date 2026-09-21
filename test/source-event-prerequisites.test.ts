import assert from "node:assert/strict";
import test from "node:test";
import { missingPresentSourceEventCharacters } from "../src/games/service.js";
import type { GameState, ImportedBook } from "../src/shared/contracts.js";
import type { SourceContinuationCandidate } from "../src/ai/engine.js";

const characterProfiles = [
  {
    name: "Mary Maloney",
    aliases: ["Mary"],
    role: "Player",
    description: "Mary.",
    traits: [],
    relationships: [],
    storyArc: "",
  },
  {
    name: "Patrick Maloney",
    aliases: ["Patrick"],
    role: "Husband",
    description: "Patrick.",
    traits: [],
    relationships: [],
    storyArc: "",
  },
];

const book = {
  chapters: [],
  worldBible: {
    summary: "",
    characters: ["Mary Maloney", "Patrick Maloney"],
    characterProfiles,
    locations: [],
  },
} as unknown as ImportedBook;

function gameWithPresentCharacters(peoplePresent: string[]) {
  return {
    playerName: "Mary Maloney",
    scene: {
      title: "Waiting",
      text: "Mary waits at home.",
      choices: [],
      sceneScope: {
        currentLocation: "Home",
        peoplePresent,
        peopleWithinSpeakingDistance: peoplePresent,
      },
    },
  } satisfies Pick<GameState, "playerName" | "scene">;
}

const greetingEvent = {
  chapterPosition: 0,
  chapterTitle: "Story",
  summary: "Mary welcomes Patrick.",
  excerpt: "Patrick comes home and Mary welcomes him.",
  nextTextOffset: 100,
  requiredEvent: "Mary welcomes Patrick.",
  requiredEventId: "welcome-patrick",
  requiredEventCategory: "other",
  requiredEventActors: ["Mary Maloney"],
  requiredEventTargets: ["Patrick Maloney"],
} satisfies SourceContinuationCandidate;

test("player source event is blocked until a required NPC participant is present", () => {
  assert.deepEqual(
    missingPresentSourceEventCharacters(
      gameWithPresentCharacters([]),
      book,
      greetingEvent,
    ),
    ["Patrick Maloney"],
  );
});

test("player source event becomes executable once the required NPC is present", () => {
  assert.deepEqual(
    missingPresentSourceEventCharacters(
      gameWithPresentCharacters(["Patrick Maloney"]),
      book,
      greetingEvent,
    ),
    [],
  );
});

test("NPC-only source events are not blocked by the player-action preflight", () => {
  const npcEvent = {
    ...greetingEvent,
    requiredEvent: "Patrick arrives home.",
    requiredEventId: "patrick-arrives",
    requiredEventCategory: "arrival" as const,
    requiredEventActors: ["Patrick Maloney"],
    requiredEventTargets: [],
  };

  assert.deepEqual(
    missingPresentSourceEventCharacters(
      gameWithPresentCharacters([]),
      book,
      npcEvent,
    ),
    [],
  );
});


test("completed co-actors cannot divert an ordered automatic continuation into prerequisite recovery", () => {
  const candidate: SourceContinuationCandidate = {...greetingEvent,
    requiredEventActors: ["Mary Maloney", "Patrick Maloney"],
    requiredEventBeats: [
      {actor: "Patrick Maloney", action: "Leaves the room", agency: "intentional", stakes: "significant", targets: [], sourceReferences: []},
      {actor: null, action: "The lights go out", agency: "involuntary", stakes: "significant", targets: [], sourceReferences: []},
      {actor: "Mary Maloney", action: "Opens the window", agency: "intentional", stakes: "significant", targets: [], sourceReferences: []},
    ]};
  const game = {...gameWithPresentCharacters(["Mary Maloney"]),
    sourceEventProgress: {eventId: greetingEvent.requiredEventId, completedBeatIndexes: [0]}};
  assert.deepEqual(missingPresentSourceEventCharacters(game, book, candidate), []);
  assert.deepEqual(missingPresentSourceEventCharacters({...game,
    sourceEventProgress: {...game.sourceEventProgress, completedBeatIndexes: [0, 1]}}, book, candidate), []);
  const needsPatrick = {...candidate, requiredEventBeats: [
    ...candidate.requiredEventBeats!.slice(0, 2),
    {...candidate.requiredEventBeats![2]!, action: "Hands Patrick a glass", targets: ["Patrick Maloney"]},
  ]};
  assert.deepEqual(missingPresentSourceEventCharacters({...game,
    sourceEventProgress: {...game.sourceEventProgress, completedBeatIndexes: [0, 1]}}, book, needsPatrick), ["Patrick Maloney"]);
});


test("automatic player discovery establishes an absent target before the intentional interaction", () => {
 const candidate: SourceContinuationCandidate={...greetingEvent,requiredEventBeats:[
  {actor:'Mary Maloney',action:'Notices Patrick at the gate',agency:'intentional',stakes:'routine',targets:['Patrick Maloney'],sourceReferences:[],resultingState:'Mary sees Patrick at the gate.'},
  {actor:'Mary Maloney',action:'Greets Patrick',agency:'intentional',stakes:'significant',targets:['Patrick Maloney'],sourceReferences:[]},
 ]};
 const game=gameWithPresentCharacters(['Mary Maloney']);
 assert.deepEqual(missingPresentSourceEventCharacters(game,book,candidate),[]);
 assert.deepEqual(missingPresentSourceEventCharacters({...game,sourceEventProgress:{eventId:greetingEvent.requiredEventId,completedBeatIndexes:[0]}},book,candidate),['Patrick Maloney']);
});
