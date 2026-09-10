import assert from "node:assert/strict";
import test from "node:test";
import type { AiResponse, AiResponseRequest } from "../src/ai/provider.js";
import {
  correctSceneChoiceReviewBeatOrder,
  correctScenePresenceBeatOrder,
} from "../src/ai/engine/provider-engine-base.js";

const navigationMarker = "\n\nCHOICE NAVIGATION EVENT:\n\n";
const currentMarker = "\n\nCURRENT SIGNIFICANT EVENT:\n\n";
const progressMarker = "\n\nSOURCE EVENT BEAT PROGRESS:\n\n";
const requiredMarker = "\n\nREQUIRED PLAYER CHOICE BEATS:\n\n";
const upcomingMarker = "\n\nUPCOMING SOURCE ANCHOR MATERIAL:\n\n";

function choiceReviewRequest(choices: Array<{ type: string; text: string }>): AiResponseRequest {
  return {
    model: "test",
    input: [
      JSON.stringify({
        candidate_scene: {
          choices,
          sceneScope: { peopleWithinSpeakingDistance: ["Aunt Em"] },
        },
      }),
      "CHOICE NAVIGATION EVENT:",
      JSON.stringify({ eventId: "cyclone" }),
      "CURRENT SIGNIFICANT EVENT:",
      "null",
      "SOURCE EVENT BEAT PROGRESS:",
      JSON.stringify({
        eventId: "cyclone",
        completedBeatIndexes: [],
        nextRequiredBeat: { action: "Uncle Henry warns Aunt Em." },
        remainingBeats: [{ action: "Uncle Henry warns Aunt Em." }],
      }),
      "REQUIRED PLAYER CHOICE BEATS:",
      JSON.stringify([
        { action: "Catches Toto and starts toward the cellar." },
        { action: "Pulls Toto back into the room and closes the trapdoor." },
        { action: "Decides to wait calmly for what will happen." },
      ]),
      "UPCOMING SOURCE ANCHOR MATERIAL:",
      JSON.stringify({ chapterPosition: 3 }),
    ].join("\n\n"),
  };
}

function completedResponse(body: Record<string, unknown>): AiResponse {
  return {
    status: "completed",
    output_text: JSON.stringify(body),
  };
}

test("choice review cannot promote a later player beat ahead of the earliest unresolved beat", () => {
  const request = choiceReviewRequest([
    { type: "action", text: "Pull Toto back into the room and close the trapdoor" },
    { type: "talk", text: "Talk to Aunt Em" },
  ]);
  assert.equal(request.input.includes(navigationMarker), true);
  assert.equal(request.input.includes(currentMarker), true);
  assert.equal(request.input.includes(progressMarker), true);
  assert.equal(request.input.includes(requiredMarker), true);
  assert.equal(request.input.includes(upcomingMarker), true);

  const corrected = correctSceneChoiceReviewBeatOrder(
    request,
    completedResponse({
      anchorChoiceIndex: 0,
      unusableChoiceIndexes: [],
      unusableChoicesReason: "",
      reason: "The later Toto beat advances the story.",
    }),
  );
  const review = JSON.parse(corrected.output_text) as { anchorChoiceIndex: number | null };
  assert.equal(review.anchorChoiceIndex, null);
});

test("choice review promotes an available earliest player beat instead of a later one", () => {
  const request = choiceReviewRequest([
    { type: "action", text: "Pull Toto back into the room and close the trapdoor" },
    { type: "action", text: "Catch Toto and start toward the cellar" },
    { type: "talk", text: "Talk to Aunt Em" },
  ]);
  const corrected = correctSceneChoiceReviewBeatOrder(
    request,
    completedResponse({
      anchorChoiceIndex: 0,
      unusableChoiceIndexes: [],
      unusableChoicesReason: "",
      reason: "Choice 0 is the anchor.",
    }),
  );
  const review = JSON.parse(corrected.output_text) as { anchorChoiceIndex: number | null };
  assert.equal(review.anchorChoiceIndex, 1);
});

test("choice review preserves a transition anchor that is not itself a later player beat", () => {
  const request = choiceReviewRequest([
    { type: "action", text: "Move closer to Toto while the storm worsens" },
    { type: "talk", text: "Talk to Aunt Em" },
  ]);
  const response = completedResponse({
    anchorChoiceIndex: 0,
    unusableChoiceIndexes: [],
    unusableChoicesReason: "",
    reason: "Choice 0 establishes a prerequisite.",
  });
  assert.equal(
    correctSceneChoiceReviewBeatOrder(request, response).output_text,
    response.output_text,
  );
});

test("presence review cannot fill missing source beats from a later reported beat", () => {
  const request: AiResponseRequest = {
    model: "test",
    input: JSON.stringify({
      event_review_target: {
        eventId: "cyclone",
        beats: Array.from({ length: 6 }, (_value, index) => ({ action: `Beat ${index}` })),
      },
      previous_completed_source_event_beat_indexes: [0, 1],
      future_player_actions: [],
    }),
  };
  const corrected = correctScenePresenceBeatOrder(
    request,
    completedResponse({
      latestVisibleSourceEventId: "cyclone",
      completedSourceEventBeatIndexes: [2, 5],
      futureActionSetupRequired: false,
      futureActionSetupSupported: true,
      futureActionSetupReason: "",
      reason: "The model saw a later beat too.",
    }),
  );
  const review = JSON.parse(corrected.output_text) as {
    latestVisibleSourceEventId: string | null;
    completedSourceEventBeatIndexes: number[];
  };
  assert.deepEqual(review.completedSourceEventBeatIndexes, [2]);
  assert.equal(review.latestVisibleSourceEventId, null);
});
