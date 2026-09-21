import type {
  CharacterProfile,
} from "./contracts.js";

export const CHARACTER_DYNAMICS_VERSION = 1;

export type CharacterSpeechMode = "verbal" | "nonverbal" | "unknown";

export interface CharacterSpeechCapability {
  mode: CharacterSpeechMode;
  /** Concrete source-backed ways this character communicates, e.g. speech, barking, gesture. */
  communicationModes: string[];
  /** Canonical story-event ids that support this classification. */
  evidenceEventIds: string[];
}

export interface CharacterCapabilities {
  speech: CharacterSpeechCapability;
}

export interface CharacterDevelopmentRelationship {
  character: string;
  description: string;
}

/**
 * A source-grounded snapshot that becomes valid only after afterEventId.
 * The first snapshot uses null event metadata and describes the character at
 * their earliest indexed appearance, before later growth or revelations.
 */
export interface CharacterDevelopmentState {
  afterEventId: string | null;
  afterEventSequence: number | null;
  chapterPosition: number;
  stateSummary: string;
  traits: string[];
  goals: string[];
  fears: string[];
  beliefs: string[];
  knownFacts: string[];
  relationships: CharacterDevelopmentRelationship[];
}

export interface CharacterDynamics {
  version: typeof CHARACTER_DYNAMICS_VERSION;
  capabilities: CharacterCapabilities;
  development: CharacterDevelopmentState[];
}

export function hasCharacterDynamics(
  profile: CharacterProfile,
): profile is CharacterProfile & { dynamics: CharacterDynamics } {
  return profile.dynamics?.version === CHARACTER_DYNAMICS_VERSION
    && Array.isArray(profile.dynamics.development)
    && profile.dynamics.development.length > 0
    && profile.dynamics.development[0]?.afterEventId === null
    && ["verbal", "nonverbal", "unknown"].includes(profile.dynamics.capabilities?.speech?.mode)
    && Array.isArray(profile.dynamics.capabilities?.speech?.communicationModes)
    && Array.isArray(profile.dynamics.capabilities?.speech?.evidenceEventIds)
    && (profile.dynamics.capabilities.speech.mode !== "nonverbal" || profile.dynamics.capabilities.speech.evidenceEventIds.length > 0);
}

export function allProfilesHaveCharacterDynamics(
  profiles: readonly CharacterProfile[] | undefined,
): boolean {
  return Boolean(profiles?.length) && profiles!.every(hasCharacterDynamics);
}

export function findCharacterProfile(
  identity: string,
  profiles: readonly CharacterProfile[] | undefined,
): CharacterProfile | undefined {
  const normalized = identity.normalize("NFKC").trim().toLocaleLowerCase();
  return profiles?.find((profile) =>
    [profile.name, ...profile.aliases].some(
      (candidate) => candidate.normalize("NFKC").trim().toLocaleLowerCase() === normalized,
    )
  );
}

export function characterSpeechMode(
  identity: string,
  profiles: readonly CharacterProfile[] | undefined,
): CharacterSpeechMode {
  const profile = findCharacterProfile(identity, profiles);
  return profile && hasCharacterDynamics(profile) ? profile.dynamics.capabilities.speech.mode : "unknown";
}

export function characterSupportsSpokenDialogue(
  identity: string,
  profiles: readonly CharacterProfile[] | undefined,
): boolean {
  return characterSpeechMode(identity, profiles) !== "nonverbal";
}

export function spokenDialogueCapabilityFailure(
  playerIdentity: string,
  targetIdentity: string,
  profiles: readonly CharacterProfile[] | undefined,
): string | undefined {
  if (!characterSupportsSpokenDialogue(playerIdentity, profiles)) {
    return `${playerIdentity} is source-indexed as nonverbal and cannot use spoken dialogue choices.`;
  }
  if (!characterSupportsSpokenDialogue(targetIdentity, profiles)) {
    return `${targetIdentity} is source-indexed as nonverbal and cannot provide a spoken dialogue response.`;
  }
  return undefined;
}

export function resolveCharacterDevelopmentStateAtSequence(
  profile: CharacterProfile,
  currentEventSequence: number | null | undefined,
): CharacterDevelopmentState | undefined {
  const development = profile.dynamics?.development;
  if (!development?.length) return undefined;
  let resolved = development[0];
  if (currentEventSequence === null || currentEventSequence === undefined) {
    return resolved;
  }

  for (const state of development.slice(1)) {
    if (
      state.afterEventSequence === null
      || state.afterEventSequence > currentEventSequence
    ) {
      break;
    }
    resolved = state;
  }
  return resolved;
}
