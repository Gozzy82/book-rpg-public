import assert from "node:assert/strict";
import test from "node:test";
import { sourceReferenceKey } from "../src/books/source-index/chapter-index.js";
import { ProviderGameEngine } from "../src/ai/engine/provider-game-engine.js";
import {
  withSourceScopeCharacterProfiles,
} from "../src/ai/engine/provider-turn-engine.js";
import { filterSceneScope } from "../src/ai/engine/scene-validation.js";
import type {
  GeneratedScene,
  SourceContinuationCandidate,
} from "../src/ai/engine/core.js";
import type { AiClient, AiResponseRequest } from "../src/ai/provider.js";
import type {
  CharacterProfile,
  GameState,
  StoryEventBeat,
} from "../src/shared/contracts.js";

class RoutingCaptureEngine extends ProviderGameEngine {
  protected override async scene(
    _instruction: string,
    state: GameState,
  ): Promise<GeneratedScene> {
    return state.scene;
  }
}

function profile(name: string): CharacterProfile {
  return {
    name,
    aliases: [],
    role: "",
    description: "",
    traits: [],
    relationships: [],
    storyArc: "",
  };
}

test("source-indexed actor without a full profile survives reviewed scene scope filtering", () => {
  const beat: StoryEventBeat = {
    actor: "Witch of the North",
    action: "Explains that the Wicked Witch enslaved the Munchkins and is dead.",
    targets: ["Dorothy"],
    agency: "intentional",
    stakes: "critical",
    sourceReferences: [],
  };
  const event = {
    eventId: "munchkins-freed",
    sequence: 3,
    description: "Dorothy learns that the Munchkins are free.",
    chapterPosition: 4,
    actors: ["Witch of the North", "Dorothy"],
    targets: ["Dorothy", "Wicked Witch of the East"],
    beats: [beat],
  };
  const candidate = {
    chapterPosition: 4,
    excerpt: "The little old woman continues her explanation.",
    requiredEvent: event.description,
    requiredEventId: event.eventId,
    storyEvents: [event],
  } as SourceContinuationCandidate;
  const state = {
    playerName: "Dorothy",
    characterProfiles: [profile("Dorothy"), profile("Toto")],
  } as unknown as GameState;

  const augmented = withSourceScopeCharacterProfiles(state, [candidate]);
  assert.notEqual(augmented, state);
  assert.deepEqual(state.characterProfiles.map((item) => item.name), ["Dorothy", "Toto"]);
  assert.ok(
    augmented.characterProfiles.some((item) => item.name === "Witch of the North"),
  );

  const reviewedScope = filterSceneScope(
    {
      currentLocation: "Oz, flowering land",
      peoplePresent: ["Dorothy", "Toto", "Witch of the North"],
      peopleWithinSpeakingDistance: ["Dorothy", "Witch of the North", "Toto"],
    },
    {
      playerName: "Dorothy",
      knownCharacterProfiles: augmented.characterProfiles,
    },
  );
  assert.deepEqual(
    reviewedScope.peoplePresent,
    ["Dorothy", "Toto", "Witch of the North"],
  );
  assert.deepEqual(
    reviewedScope.peopleWithinSpeakingDistance,
    ["Dorothy", "Witch of the North", "Toto"],
  );
});

test("anchor route review receives the next beat's exact source excerpt and preserves established remains", async () => {
  const reference = {
    chapterPosition: 4,
    chapterIndex: 4,
    lineStart: 62,
    lineEnd: 74,
  };
  const beat: StoryEventBeat = {
    actor: "Witch of the North",
    action: "Explains that the Wicked Witch enslaved the Munchkins and is dead.",
    targets: ["Dorothy"],
    agency: "intentional",
    stakes: "critical",
    sourceReferences: [reference],
  };
  const event = {
    eventId: "munchkins-freed",
    sequence: 3,
    description: "Dorothy learns that the Munchkins are free.",
    chapterPosition: 4,
    actors: ["Witch of the North", "Dorothy"],
    targets: ["Dorothy", "Wicked Witch of the East"],
    beats: [beat],
  };
  const exactExcerpt =
    "The Witch of the North explains that the Wicked Witch kept the Munchkins in bondage and that her death has set them free.";
  const candidate = {
    chapterPosition: 4,
    excerpt: "Earlier bounded material that stops before the explanation.",
    requiredEvent: event.description,
    requiredEventId: event.eventId,
    storyEvents: [event],
    sourceReferenceExcerpts: {
      [sourceReferenceKey(reference)]: exactExcerpt,
    },
  } as SourceContinuationCandidate;
  const requests: AiResponseRequest[] = [];
  const client: AiClient = {
    provider: "openai",
    model: "test",
    async createResponse(request) {
      requests.push(request);
      return {
        status: "completed",
        output_text: JSON.stringify({
          sourceAnchorRoute: "event",
          reason: "The established remains can be handled and the NPC explanation can follow immediately.",
        }),
      };
    },
  };
  const state = {
    book: { bookId: "oz" },
    playerName: "Dorothy",
    characterProfiles: [profile("Dorothy"), profile("Toto")],
    sourceEventProgress: {
      eventId: event.eventId,
      completedBeatIndexes: [],
    },
    scene: {
      title: "Feet Beneath the House",
      text: "The dead Wicked Witch of the East lies beneath the house; her silver-shod feet visibly protrude under the beam.",
      choices: [],
      sceneScope: {
        currentLocation: "Oz, flowering land",
        peoplePresent: ["Dorothy", "Toto"],
        peopleWithinSpeakingDistance: ["Dorothy"],
      },
    },
  } as unknown as GameState;

  const engine = new RoutingCaptureEngine(client, "minimal");
  await engine.continue(
    state,
    "Gently free the Witch's feet from under the beam",
    [candidate],
    {
      anchorDirected: true,
      sourceEventId: event.eventId,
      sourceAnchorRoute: "event",
    },
  );

  assert.equal(requests.length, 1);
  const input = JSON.parse(requests[0]!.input as string);
  assert.equal(input.next_required_beat_source_excerpt, exactExcerpt);
  assert.equal(input.source_excerpt, candidate.excerpt);
  assert.match(requests[0]!.instructions ?? "", /corpse, remains/i);
  assert.match(requests[0]!.instructions ?? "", /dead character.*peoplePresent/i);
});
