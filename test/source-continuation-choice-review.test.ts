import assert from "node:assert/strict";
import test from "node:test";
import { ProviderGameEngine } from "../src/ai/engine/provider-game-engine.js";
import type { AiClient, AiResponseRequest } from "../src/ai/provider.js";
import { SOURCE_CONTINUATION_CHOICE_ID, SOURCE_CONTINUATION_CHOICE_TEXT } from "../src/shared/contracts.js";
import type { GameState, Scene } from "../src/shared/contracts.js";

class MenuEngine extends ProviderGameEngine {
  review(state: GameState) {
    return this.reviewSceneChoices(state, state.scene);
  }
}
const continuation = { id: SOURCE_CONTINUATION_CHOICE_ID, type: "action" as const, text: SOURCE_CONTINUATION_CHOICE_TEXT };
const action = (id: string, text: string) => ({ id, type: "action" as const, text });
function state(choices: Scene["choices"]): GameState {
  return {
    book: { bookId: "oz", title: "Oz" }, playerName: "Cowardly Lion",
    history: [], characterProfiles: [], objective: "Continue", selectedText: "The deadly poppy field.",
    scene: {
      title: "The Edge of the Poppy Field", outcome: "active",
      text: "I fall asleep among the poppies. Dorothy and Toto are carried to safety, but I remain unconscious.",
      choices, sceneScope: { currentLocation: "Poppy field", peoplePresent: ["Cowardly Lion"], peopleWithinSpeakingDistance: ["Cowardly Lion"] },
    },
  } as unknown as GameState;
}
function engine(requests: AiResponseRequest[], anchorChoiceIndex: number | null, unusableChoiceIndexes: number[]) {
  const client: AiClient = {
    provider: "openai", model: "test",
    async createResponse(request) {
      requests.push(request);
      return { status: "completed", output_text: JSON.stringify({ anchorChoiceIndex, unusableChoiceIndexes, unusableChoicesReason: "Lion is unconscious.", reason: "Review player actions." }) };
    },
  };
  return new MenuEngine(client, "minimal");
}

test("unconscious Lion can retain automatic source continuation without a voluntary-action review", async () => {
  const requests: AiResponseRequest[] = [];
  const review = await engine(requests, null, [0]).review(state([continuation]));
  assert.equal(requests.length, 0);
  assert.equal(review.anchorChoiceIndex, null);
  assert.deepEqual(review.unusableChoiceIndexes, []);
});

for (const position of [0, 1, 2]) {
  test(`mixed menu excludes continuation at index ${position} and maps review indexes back`, async () => {
    const requests: AiResponseRequest[] = [];
    const choices = [action("run", "Run out of the flowers"), action("roar", "Roar for help")];
    choices.splice(position, 0, continuation);
    const review = await engine(requests, 1, [0, 1, 1]).review(state(choices));
    const context = JSON.parse(requests[0]!.input.split("\n\nCHOICE NAVIGATION EVENT:")[0]!);
    assert.deepEqual(context.candidate_scene.choices.map((choice: { text: string }) => choice.text), ["Run out of the flowers", "Roar for help"]);
    assert.equal(review.anchorChoiceIndex, choices.findIndex(choice => choice.id === "roar"));
    assert.deepEqual(review.unusableChoiceIndexes, choices.flatMap((choice, index) => choice.id === SOURCE_CONTINUATION_CHOICE_ID ? [] : [index]));
  });
}

test("continuation wording alone does not exempt a real player action from review", async () => {
  const requests: AiResponseRequest[] = [];
  const review = await engine(requests, null, [0]).review(state([action("ordinary", SOURCE_CONTINUATION_CHOICE_TEXT)]));
  assert.equal(requests.length, 1);
  assert.deepEqual(review.unusableChoiceIndexes, [0]);
});
