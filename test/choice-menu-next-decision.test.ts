import assert from "node:assert/strict";
import test from "node:test";
import { ProviderGameEngine } from "../src/ai/engine/provider-game-engine.js";
import type { SourceContinuationCandidate } from "../src/ai/engine/core.js";
import type { AiClient, AiResponseRequest } from "../src/ai/provider.js";
import type { GameState, StoryEventBeat } from "../src/shared/contracts.js";

class MenuEngine extends ProviderGameEngine {
  menu(state: GameState, candidate: SourceContinuationCandidate) {
    return this.sceneChoices(state.scene, state, [candidate]);
  }
  review(state: GameState, candidate: SourceContinuationCandidate) {
    return this.reviewSceneChoices(state, state.scene, candidate);
  }
}

const beats: StoryEventBeat[] = [
  { actor: "Scarecrow", action: "Signals and speaks to Dorothy while stuck on his pole.", targets: ["Dorothy"], agency: "intentional", stakes: "significant", sourceReferences: [] },
  { actor: "Dorothy", action: "Lifts the Scarecrow off the pole and sets him on the ground.", targets: ["Scarecrow"], agency: "intentional", stakes: "significant", sourceReferences: [] },
  { actor: "Scarecrow", action: "Asks to accompany Dorothy to Oz in hopes of receiving brains.", targets: ["Dorothy"], agency: "intentional", stakes: "significant", sourceReferences: [] },
];
const event = {
  eventId: "scarecrow", sequence: 1, description: "Dorothy frees the Scarecrow, who asks to join her.",
  chapterPosition: 5, actors: ["Scarecrow", "Dorothy"], targets: [], beats,
};
const candidate: SourceContinuationCandidate = {
  chapterPosition: 5, chapterTitle: "Scarecrow", summary: event.description,
  excerpt: "Dorothy lifts him down. He asks to accompany her to Oz to seek brains.",
  nextTextOffset: 100, requiredEvent: event.description, requiredEventId: event.eventId,
  storyEvents: [event],
};

for (const completed of [[0], [0, 1]]) {
  test(`menu and review use the next decision after completed beats ${completed}`, async () => {
    const playerIsNext = completed.length === 2;
    const choices = [
      { id: "one", type: "action" as const, text: playerIsNext
        ? "Ask to accompany Dorothy to Oz in hopes of receiving brains"
        : "Hold still while Dorothy lifts me off the pole", requiredPresentCharacters: ["Dorothy"], requiredAbsentCharacters: [], stakes: "significant" as const, sourceAnchorRoute: "event" as const },
      { id: "two", type: "talk" as const, text: "Talk to Dorothy", character: "Dorothy", requiredPresentCharacters: ["Dorothy"], requiredAbsentCharacters: [], stakes: "routine" as const },
    ];
    const state = {
      book: { bookId: "oz", title: "Oz" }, playerName: "Scarecrow", history: [],
      objective: "Continue", selectedText: "A cornfield.",
      characterProfiles: ["Scarecrow", "Dorothy"].map(name => ({ name, aliases: [], role: "", description: "", traits: [], relationships: [], storyArc: "" })),
      sourceIntroducedCharacters: ["Scarecrow", "Dorothy"],
      sourceEventProgress: { eventId: event.eventId, completedBeatIndexes: completed },
      scene: {
        title: "Cornfield", text: playerIsNext ? "Dorothy lifts me down. I stand on the ground beside her." : "I greet Dorothy from my pole. She reaches up to lift me down.",
        choices, sceneScope: { currentLocation: "Cornfield", peoplePresent: ["Scarecrow", "Dorothy"], peopleWithinSpeakingDistance: ["Scarecrow", "Dorothy"] },
      },
    } as unknown as GameState;
    const requests: AiResponseRequest[] = [];
    const client: AiClient = {
      provider: "openai", model: "test",
      async createResponse(request) {
        requests.push(request);
        return { status: "completed", output_text: JSON.stringify(
          request.text?.format.name === "bookrpg_scene_choice_review"
            ? { anchorChoiceIndex: 0, unusableChoiceIndexes: [], unusableChoicesReason: "", reason: "Immediate next beat." }
            : { choices },
        ) };
      },
    };
    const engine = new MenuEngine(client, "minimal");
    const menu = await engine.menu(state, candidate);
    assert.equal(menu[0]!.text, choices[0]!.text);
    const menuInput = JSON.parse(requests[0]!.input);
    assert.equal(menuInput.next_significant_event.requiresExplicitPlayerChoice, playerIsNext);
    assert.equal(menuInput.next_significant_event.beats[0].actor, playerIsNext ? "Scarecrow" : "Dorothy");
    assert.deepEqual(menuInput.required_player_choice_beats, playerIsNext ? [beats[2]] : []);

    await engine.review(state, candidate);
    const reviewInput = requests.at(-1)!.input;
    const navigation = JSON.parse(reviewInput.split("CHOICE NAVIGATION EVENT:\n\n")[1]!.split("\n\nCURRENT SIGNIFICANT EVENT:")[0]!);
    const required = JSON.parse(reviewInput.split("REQUIRED PLAYER CHOICE BEATS:\n\n")[1]!.split("\n\nUPCOMING SOURCE ANCHOR MATERIAL:")[0]!);
    assert.equal(navigation.requiresExplicitPlayerChoice, playerIsNext);
    assert.deepEqual(required, playerIsNext ? [beats[2]] : []);
  });
}
