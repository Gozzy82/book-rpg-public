import type {
  CharacterProfile,
} from "../../shared/contracts.js";
import {
  PLAYER_EMBODIMENT_RULES,
} from "./rules.js";

export function findPlayerCharacterProfile(
  playerName: string,
  profiles: readonly CharacterProfile[] | undefined,
): CharacterProfile | undefined {
  const normalizedPlayerName = playerName.trim().toLocaleLowerCase();
  return profiles?.find((profile) =>
    profile.name.trim().toLocaleLowerCase() === normalizedPlayerName
    || profile.aliases.some(
      (alias) => alias.trim().toLocaleLowerCase() === normalizedPlayerName,
    )
  );
}

export function buildPlayerPerspective(
  playerName: string,
  playerProfile?: CharacterProfile,
  spoilerSafe = false,
): string {
  const profileSummary = playerProfile
    ? {
        name: playerProfile.name,
        aliases: playerProfile.aliases,
        ...(!spoilerSafe
          ? {
              role: playerProfile.role,
              description: playerProfile.description,
              traits: playerProfile.traits,
              storyArc: playerProfile.storyArc,
            }
          : {}),
      }
    : null;
  return [
    `The user controls exactly this player identity: ${JSON.stringify(playerName)}.`,
    `The canonical profile for this player identity is: ${JSON.stringify(profileSummary)}.`,
    "Narrate player-facing scene prose in first-person singular from that identity's perspective, using I, me, and my for the player.",
    "Do not address the player as you in narration or refer to the player by name or third-person pronouns. Non-player dialogue may address the player as you.",
    "The source passage establishes the situation only; its narrator, viewpoint character, actions, and private knowledge do not define the player.",
    "Never switch the player to another character because that character dominates the source passage.",
    ...(spoilerSafe
      ? [
          "This is an opening scene with no selected player action yet. Establish the immediate situation and stop at the first meaningful player decision; do not invent a consequential voluntary action, promise, goal, departure, speech, or decision for the player.",
        ]
      : []),
    "Only give the player actions and knowledge appropriate to the chosen identity at this point in the story.",
    "Preserve the player's established self-beliefs, perceived limitations, motives, and unmet goals from the canonical profile. Do not make the player confidently claim to already possess a capability, quality, knowledge, or condition that the profile says they believe they lack or are currently seeking to gain.",
    ...PLAYER_EMBODIMENT_RULES,
  ].join("\n");
}
