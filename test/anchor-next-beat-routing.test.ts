import assert from "node:assert/strict";
import test from "node:test";
import type { AiClient, AiResponseRequest } from "../src/ai/provider.js";
import { ProviderGameEngine } from "../src/ai/engine/provider-game-engine.js";
import type { GeneratedScene, SourceContinuationCandidate } from "../src/ai/engine/core.js";
import type { GameState, StoryEventBeat } from "../src/shared/contracts.js";

// Exercise public continue(): capture the handoff to generation without making
// any live model calls or coupling the test to generated narrative wording.
class RoutingEngine extends ProviderGameEngine {
  requiredBeat = false;
  protected override async scene(
    _instruction: string, state: GameState, _action?: string,
    _candidates?: readonly SourceContinuationCandidate[], _attempts?: number,
    _mode?: "interactive_turn" | "observed_scene_progression" | "opening",
    requiredSourceEvent = false,
  ): Promise<GeneratedScene> {
    this.requiredBeat = requiredSourceEvent;
    return state.scene;
  }
}

const beats: StoryEventBeat[] = [
  { actor: "Scarecrow", action: "Winks and nods at Dorothy.", agency: "intentional", stakes: "significant", targets: ["Dorothy"], sourceReferences: [] },
  { actor: "Dorothy", action: "Steps closer to the pole.", agency: "intentional", stakes: "routine", targets: ["Scarecrow"], sourceReferences: [] },
  { actor: "Scarecrow", action: "Asks Dorothy to remove the pole.", agency: "intentional", stakes: "significant", targets: ["Dorothy"], sourceReferences: [] },
];
const event = { sequence: 1, eventId: "free-scarecrow", description: "Dorothy meets and frees the Scarecrow.", chapterPosition: 1, beats };
const candidate = {
  chapterPosition: 1, excerpt: "Dorothy stops by the pole.",
  requiredEvent: event.description, requiredEventId: event.eventId,
  storyEvents: [event],
} as SourceContinuationCandidate;
const state = {
  book: { bookId: "oz" }, playerName: "Scarecrow", characterProfiles: [],
  scene: { title: "The pole", text: "I am on the pole; Dorothy watches me.", choices: [],
    sceneScope: { currentLocation: "Cornfield", peoplePresent: ["Dorothy"], peopleWithinSpeakingDistance: ["Dorothy"] } },
} as unknown as GameState;

for (const completed of [[], [0], [0, 1]]) {
  test(`anchor route reviews only next beat after [${completed}] even for a stored transition`, async () => {
    const requests: AiResponseRequest[] = [];
    const client: AiClient = {
      provider: "openai", model: "test",
      async createResponse(request) {
        requests.push(request);
        return { status: "completed", output_text: JSON.stringify({ sourceAnchorRoute: "event", reason: "The next beat is immediately enabled." }) };
      },
    };
    const engine = new RoutingEngine(client, "minimal");
    await engine.continue({ ...state, sourceEventProgress: { eventId: event.eventId, completedBeatIndexes: completed } },
      completed.length === 1 ? "Wait for Dorothy to approach" : beats[completed.length]!.action,
      [candidate], { anchorDirected: true, sourceEventId: event.eventId, sourceAnchorRoute: "transition" });
    assert.equal(requests.length, 1);
    const input = JSON.parse(requests[0]!.input as string);
    assert.deepEqual(input.next_significant_event.beats, [beats[completed.length]]);
    assert.deepEqual(input.source_event_beat_progress.completedBeatIndexes, completed);
    assert.equal(input.required_player_choice_beats.length, completed.length === 1 ? 0 : 1);
    assert.equal(engine.requiredBeat, true);
  });
}

test("an unmet prerequisite can still leave an ordered anchor on the transition route", async () => {
  const engine = new RoutingEngine({ provider: "openai", model: "test", async createResponse() {
    return { status: "completed", output_text: JSON.stringify({ sourceAnchorRoute: "transition", reason: "Dorothy cannot see the player yet." }) };
  } }, "minimal");
  await engine.continue(state, "Call for someone on the distant road", [candidate], { anchorDirected: true, sourceAnchorRoute: "transition" });
  assert.equal(engine.requiredBeat, false);
});

test("legacy transitions without ordered beats do not gain forced event completion", async () => {
  const engine = new RoutingEngine({ provider: "openai", model: "test", async createResponse() { throw new Error("Unexpected review"); } }, "minimal");
  await engine.continue(state, "Approach the road", [{ ...candidate, storyEvents: [{ ...event, beats: [] }] }],
    { anchorDirected: true, sourceAnchorRoute: "transition" });
  assert.equal(engine.requiredBeat, false);
});
