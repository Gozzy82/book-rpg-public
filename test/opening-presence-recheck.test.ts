import assert from "node:assert/strict";
import test from "node:test";
import { ProviderSceneReviewer } from "../src/ai/engine/provider-scene-reviewer.js";
import type { AiClient, AiResponseRequest } from "../src/ai/provider.js";

class PresenceReviewEngine extends ProviderSceneReviewer {
  async selectSourceCandidate(
    _state: any,
    candidates: readonly any[],
  ): Promise<any> {
    return candidates[0];
  }

  async selectSourceEvent(
    _state: any,
    candidate: any,
  ): Promise<any> {
    return candidate;
  }

  async reviewOpening(
    state: any,
    candidate: any,
    sourceCandidate: any,
  ) {
    return this.reviewScenePresence(
      state,
      candidate,
      [],
      [sourceCandidate],
      sourceCandidate.currentStoryEvent.eventId,
      true,
    );
  }
}

function presenceResponse(completedSourceEventBeatIndexes: number[]) {
  return {
    status: "completed" as const,
    output_text: JSON.stringify({
      peoplePresent: ["Scarecrow", "Dorothy"],
      peopleWithinSpeakingDistance: ["Scarecrow", "Dorothy"],
      latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes,
      futureActionSetupRequired: true,
      futureActionSetupSupported: true,
      futureActionSetupReason: "Dorothy can see the Scarecrow.",
      reason: "The Scarecrow's wink remains the next player decision.",
    }),
    incomplete_details: null,
  };
}

test("opening presence review rechecks an omitted prelude beat before regenerating", async () => {
  const requests: AiResponseRequest[] = [];
  const responses = [presenceResponse([]), presenceResponse([0])];
  const client: AiClient = {
    provider: "openai",
    model: "test-model",
    async createResponse(request) {
      requests.push(request);
      return responses.shift() ?? presenceResponse([0]);
    },
  };
  const engine = new PresenceReviewEngine(client, "minimal");
  const event = {
    eventId: "dorothy-finds-scarecrow",
    description: "Dorothy finds and examines the Scarecrow beside the road.",
    chapterPosition: 1,
    category: "encounter",
    actors: ["Dorothy", "Scarecrow"],
    targets: ["Scarecrow"],
    beats: [
      {
        actor: "Dorothy",
        action: "Finds a Scarecrow beside the road and examines it.",
        targets: ["Scarecrow"],
        agency: "intentional",
        stakes: "significant",
      },
      {
        actor: "Scarecrow",
        action: "Winks and nods to Dorothy.",
        targets: ["Dorothy"],
        agency: "intentional",
        stakes: "significant",
      },
    ],
  };
  const sourceCandidate = {
    chapterPosition: 1,
    excerpt: "Dorothy looked closely at the painted face of the Scarecrow.",
    summary: "Dorothy encounters the Scarecrow.",
    currentStoryEvent: event,
    storyEvents: [event],
  };
  const review = await engine.reviewOpening(
    {
      book: { bookId: "book" },
      playerName: "Scarecrow",
      characterProfiles: [
        { name: "Scarecrow", aliases: [] },
        { name: "Dorothy", aliases: [] },
      ],
      sourceEventProgress: undefined,
      establishedEvent: undefined,
      scene: {
        title: "Before",
        text: "",
        sceneScope: {
          currentLocation: "Cornfield beside the yellow road",
          peoplePresent: ["Scarecrow"],
          peopleWithinSpeakingDistance: [],
        },
      },
    },
    {
      title: "A Girl on the Road",
      text: "A girl stops beside my pole and studies my painted face closely while I remain still.",
      sceneScope: {
        currentLocation: "Cornfield beside the yellow road",
        peoplePresent: ["Scarecrow", "Dorothy"],
        peopleWithinSpeakingDistance: ["Scarecrow", "Dorothy"],
      },
      playerAction: "",
    },
    sourceCandidate,
  );

  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[0].instructions ?? "", /OPENING PROGRESS RECHECK/);
  assert.match(requests[1].instructions ?? "", /OPENING PROGRESS RECHECK/);
  assert.match(requests[1].instructions ?? "", /prelude beats 0-0/);
  assert.deepEqual(review.completedSourceEventBeatIndexes, [0]);
});
