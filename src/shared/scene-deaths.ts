import type {CharacterProfile} from './contracts.js';

export const SCENE_DEATH_POLICY = 'peopleKilledInScene lists exact known character names whose death is actually established by this scene, including a confirmed death discovered or reliably reported here. Return [] when none. Read the full meaning: conditions (unless she killed the Witch), demands, plans, threats, wishes, hypothetical outcomes, negated deaths, uncertain reports, apparent death, sleep and unconsciousness are NOT completed deaths. Do not infer death from the canonical future, a death-related event title, or nonInteractableCharacters. Identify the victim, never the killer, bystander or owner of a victim. Already confirmed deaths may be retained, but never invent an event to justify this field.';

export const peopleKilledInSceneSchema = {
  type: 'array', items: {type: 'string'}, maxItems: 32,
  description: SCENE_DEATH_POLICY,
} as const;

/** Validate identities only. The AI assesses death; this code never reads prose. */
export function normalizeSceneDeaths(value: unknown, profiles: readonly CharacterProfile[] = []): string[] {
  if (value === undefined) return []; // Legacy saved scenes/providers.
  if (!Array.isArray(value) || value.length > 32 || value.some(n => typeof n !== 'string' || !n.trim())) {
    throw new Error('Invalid peopleKilledInScene metadata.');
  }
  return [...new Set(value.map((name: string) => {
    const identity = name.trim().toLocaleLowerCase('en-US');
    const profile = profiles.find(p => [p.name, ...p.aliases].some(n => n.trim().toLocaleLowerCase('en-US') === identity));
    if (!profile) throw new Error('peopleKilledInScene contains an unknown character.');
    return profile.name;
  }))];
}
