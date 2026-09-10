import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourceEventBeatProgressContext,
  nextSignificantEventForCandidate,
  normalizeCompletedSourceEventBeatIndexes,
  sourceSceneBeatReviewTargetId,
} from "../src/ai/engine/source-navigation.js";
import type { SourceContinuationCandidate } from "../src/ai/engine/core.js";

const event = {
  eventId: "scarecrow-freed",
  sequence: 1,
  description: "Dorothy discovers that the Scarecrow is alive and frees him.",
  chapterPosition: 3,
  beats: [
    { actor: "Scarecrow", action: "Winks and nods at Dorothy from his pole." },
    { actor: "Scarecrow", action: "Asks Dorothy to remove the pole from his back." },
    { actor: "Dorothy", action: "Lifts the Scarecrow off the pole." },
  ].map((beat) => ({
    ...beat,
    targets: [],
    agency: "intentional" as const,
    stakes: "significant" as const,
    sourceReferences: [],
  })),
};
const candidate: SourceContinuationCandidate = {
  chapterPosition: 3,
  chapterTitle: "The Scarecrow",
  summary: event.description,
  excerpt: "Dorothy sees the Scarecrow wink and nod.",
  nextTextOffset: 100,
  storyEvents: [event],
};

test("transition without requiredEventId reviews the event used by scene generation", () => {
  const navigationEvent = nextSignificantEventForCandidate(candidate);
  assert.equal(candidate.requiredEventId, undefined);
  const targetId = sourceSceneBeatReviewTargetId(navigationEvent);
  assert.equal(targetId, event.eventId);

  // A presence review confirming only the selected wink advances the next
  // choice without prematurely completing the freeing event.
  const progress = buildSourceEventBeatProgressContext(navigationEvent, {
    eventId: targetId!,
    completedBeatIndexes: normalizeCompletedSourceEventBeatIndexes([0], event.beats.length),
  });
  assert.deepEqual(progress?.completedBeatIndexes, [0]);
  assert.equal(progress?.nextRequiredBeat?.action, event.beats[1]!.action);
  assert.equal(progress?.remainingBeats.length, 2);
});

test("stale progress cannot redirect a transition away from its navigation event", () => {
  const navigationEvent = nextSignificantEventForCandidate(candidate);
  const staleProgress = { eventId: "older-event", completedBeatIndexes: [0, 1] };
  assert.equal(sourceSceneBeatReviewTargetId(navigationEvent), event.eventId);
  assert.deepEqual(
    buildSourceEventBeatProgressContext(navigationEvent, staleProgress)?.completedBeatIndexes,
    [],
  );
});

test("required event selection and opening targets retain their exact identity", () => {
  const laterEvent = { ...event, eventId: "later-event", sequence: 2 };
  const selected = nextSignificantEventForCandidate({
    ...candidate,
    storyEvents: [event, laterEvent],
    requiredEventId: laterEvent.eventId,
  });
  assert.equal(sourceSceneBeatReviewTargetId(selected), laterEvent.eventId);
  assert.equal(sourceSceneBeatReviewTargetId(event), event.eventId);
  assert.equal(sourceSceneBeatReviewTargetId(null), undefined);
  assert.equal(sourceSceneBeatReviewTargetId(null, "claimed-event"), "claimed-event");
});
