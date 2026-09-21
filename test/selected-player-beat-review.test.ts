import assert from "node:assert/strict";
import test from "node:test";
import { withCanonicalSelectedPlayerBeatReview } from "../src/ai/engine/provider-paced-bookrpg-engine.js";

function requestFor(playerAction: string) {
  return {
    model: "gpt-5-nano",
    input: JSON.stringify({
      player_identity: "Tin Woodman",
      character_profiles: [
        { name: "Tin Woodman", aliases: ["Woodman"] },
        { name: "Dorothy", aliases: [] },
        { name: "Scarecrow", aliases: [] },
        { name: "Oz", aliases: [] },
      ],
      candidate_scene: {
        player_action: playerAction,
      },
      next_required_source_event_beat: {
        index: 1,
        actor: "Tin Woodman",
        action: "Asks whether Oz could give him a heart",
        agency: "intentional",
        stakes: "significant",
      },
    }),
  } as any;
}

test("presence review canonicalizes an addressed selected question to the source beat", () => {
  const transformed = withCanonicalSelectedPlayerBeatReview(
    "scene presence review",
    requestFor("Ask Dorothy and Scarecrow whether Oz could give me a heart"),
  );
  const input = JSON.parse(transformed.input);
  assert.equal(
    input.candidate_scene.player_action,
    "Asks whether Oz could give him a heart",
  );
});

test("presence review does not canonicalize a materially different selected question", () => {
  const original = requestFor("Ask Dorothy and Scarecrow whether Oz could give me an axe");
  const transformed = withCanonicalSelectedPlayerBeatReview(
    "scene presence review",
    original,
  );
  assert.equal(transformed.input, original.input);
});
