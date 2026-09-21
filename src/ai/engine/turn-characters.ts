import type { TurnContract } from "./turn-contract.js";

/** Provider-facing projection only. Full profiles stay available to server-side
 * capability validation; appearing here never establishes physical presence. */
export function turnCharacters(contract: TurnContract) {
  const context = JSON.parse(contract.contextJson);
  const runtime = context.character_runtime;
  const normalize = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase();
  const scope = context.current_scene?.sceneScope;
  const names = new Set<string>([contract.player, ...contract.playerAliases,
    ...(scope?.peoplePresent ?? []), ...(scope?.peopleWithinSpeakingDistance ?? []),
    ...[...contract.allowedPlayerBeatIndexes, ...contract.requiredAutomaticBeatIndexes].flatMap(i => {
      const beat = contract.beats[i];
      return beat ? [beat.actor, ...(beat.targets ?? [])].filter((name): name is string => typeof name === "string") : [];
    }),
  ].map(normalize));
  const compact = (profile: any) => profile ? {
    name: profile.name, aliases: profile.aliases ?? [],
    speech: {mode: profile.speech?.mode ?? "unknown", communicationModes: profile.speech?.communicationModes ?? []},
    development: profile.development ? {
      valid_after_event_sequence: profile.development.valid_after_event_sequence,
      state_summary: profile.development.state_summary,
      traits: profile.development.traits, goals: profile.development.goals,
      fears: profile.development.fears, beliefs: profile.development.beliefs,
      known_facts: profile.development.known_facts, relationships: profile.development.relationships,
    } : null,
  } : null;
  const player = runtime?.player;
  const playerNames = new Set([contract.player, ...contract.playerAliases, ...(player?.aliases ?? []), ...(player ? [player.name] : [])].map(normalize));
  return {
    current_event_sequence: runtime?.current_event_sequence ?? null,
    player: compact(player),
    characters: (runtime?.characters ?? []).filter((profile: any) => profile
      && ![profile.name, ...(profile.aliases ?? [])].some((name: string) => playerNames.has(normalize(name)))
      && [profile.name, ...(profile.aliases ?? [])].some((name: string) => names.has(normalize(name)))).map(compact),
  };
}
