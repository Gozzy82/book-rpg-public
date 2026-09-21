import test from "node:test";
import assert from "node:assert/strict";

import { stripEmbeddedChoiceMenu } from "../src/ai/engine/normalization.js";
import { openingCharacterContinuityFailures } from "../src/ai/engine/turn.js";

test("opening continuity does not parse player-name mentions with verb heuristics", () => {
  const failures = openingCharacterContinuityFailures(
    "Dorothy scrambles for the cellar while Toto slips free and braces against the wind.",
    {
      playerName: "Toto",
      characterProfiles: [
        {
          name: "Toto",
          aliases: [],
        },
        {
          name: "Dorothy",
          aliases: [],
        },
      ],
      sourceIntroducedCharacters: ["Dorothy", "Toto"],
    } as any,
    [],
  );

  assert.equal(
    failures.some((failure) => /player identity as a separate third-person character/i.test(failure)),
    false,
  );
});

test("opening continuity allows an NPC to address the player by name in dialogue", () => {
  const failures = openingCharacterContinuityFailures(
    "Dorothy reaches for me. “Toto, come here!” she cries as I brace against the wind.",
    {
      playerName: "Toto",
      characterProfiles: [
        {
          name: "Toto",
          aliases: [],
        },
        {
          name: "Dorothy",
          aliases: [],
        },
      ],
      sourceIntroducedCharacters: ["Dorothy", "Toto"],
    } as any,
    [],
  );

  assert.equal(
    failures.some((failure) => /player identity as a separate third-person character/i.test(failure)),
    false,
  );
});

test("opening continuity does not confuse a player name with a place name", () => {
  const failures = openingCharacterContinuityFailures(
    "I stand behind the curtain while distant roads cross the Land of Oz beyond the palace walls.",
    {
      playerName: "Oz",
      characterProfiles: [
        {
          name: "Oz",
          aliases: ["Wizard of Oz"],
        },
      ],
      sourceIntroducedCharacters: ["Oz"],
    } as any,
    [],
  );

  assert.equal(
    failures.some((failure) => /player identity as a separate third-person character/i.test(failure)),
    false,
  );
});

test("opening continuity still rejects source-unintroduced NPC interaction", () => {
  const failures = openingCharacterContinuityFailures(
    "I wait beside Dorothy while Glinda steps forward and takes my hand.",
    {
      playerName: "Dorothy",
      characterProfiles: [
        {
          name: "Dorothy",
          aliases: [],
        },
        {
          name: "Glinda",
          aliases: [],
        },
      ],
      sourceIntroducedCharacters: ["Dorothy"],
    } as any,
    [],
    { currentLocation: "Road", peoplePresent: ["Dorothy", "Glinda"], peopleWithinSpeakingDistance: ["Dorothy", "Glinda"] },
  );

  assert.ok(
    failures.some((failure) => /Glinda.*before the source introduces/i.test(failure)),
  );
});

test("scene normalization strips prose-style embedded choice prompts", () => {
  const text = [
    "The cyclone's roar closes around the farmhouse, and I brace beside Dorothy.",
    "",
    "Choice set before me: stay and cling to the earth as the storm nears, or follow Dorothy toward the cellar's shadowed mouth.",
  ].join("\n");

  assert.equal(
    stripEmbeddedChoiceMenu(text),
    "The cyclone's roar closes around the farmhouse, and I brace beside Dorothy.",
  );
});

