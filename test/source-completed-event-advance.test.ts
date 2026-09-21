import assert from "node:assert/strict";
import test from "node:test";
import { advanceCompletedSourceEventCandidates } from "../src/ai/engine/provider-paced-bookrpg-engine.js";

const cycloneEvent = {
  eventId: "cyclone-shelter",
  description: "A cyclone approaches the farmhouse, prompting the family to seek shelter.",
  chapterPosition: 3,
  beats: Array.from({ length: 9 }, (_value, index) => ({
    actor: index === 8 ? "Dorothy" : "Aunt Em",
    action: `Shelter beat ${index}`,
    targets: [],
    agency: index === 8 ? "involuntary" : "intentional",
    stakes: "significant",
    sourceReferences: [],
  })),
};

const airborneEvent = {
  eventId: "house-airborne",
  description: "The cyclone lifts and carries Dorothy's house away.",
  chapterPosition: 3,
  category: "danger",
  actors: ["Dorothy"],
  targets: [],
  beats: [
    {
      actor: null,
      action: "The house whirls around and rises through the air",
      targets: ["Dorothy"],
      agency: "external",
      stakes: "critical",
      sourceReferences: [],
    },
  ],
};

const candidate = {
  chapterPosition: 3,
  chapterTitle: "The Wonderful Wizard of Oz",
  excerpt: "cyclone excerpt",
  nextTextOffset: 100,
  summary: "Cyclone sequence",
  requiredEventId: cycloneEvent.eventId,
  requiredEvent: cycloneEvent.description,
  requiredEventBeats: cycloneEvent.beats,
  storyEvents: [cycloneEvent, airborneEvent],
} as any;

function stateWithProgress(completedBeatIndexes: number[]) {
  return {
    sourceEventProgress: {
      eventId: cycloneEvent.eventId,
      completedBeatIndexes,
    },
  } as any;
}

test("completed source event advances direct continuation to the next story event", () => {
  const [advanced] = advanceCompletedSourceEventCandidates(
    stateWithProgress([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    [candidate],
  );

  assert.equal(advanced.requiredEventId, airborneEvent.eventId);
  assert.equal(advanced.requiredEvent, airborneEvent.description);
  assert.deepEqual(advanced.requiredEventBeats, airborneEvent.beats);
});

test("partial source event progress does not advance past unfinished beats", () => {
  const [unchanged] = advanceCompletedSourceEventCandidates(
    stateWithProgress([0, 1, 2, 3, 4, 5, 6, 7]),
    [candidate],
  );

  assert.equal(unchanged.requiredEventId, cycloneEvent.eventId);
  assert.equal(unchanged.requiredEvent, cycloneEvent.description);
});
