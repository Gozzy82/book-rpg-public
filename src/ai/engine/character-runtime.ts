import type { GameState, CharacterProfile } from "../../shared/contracts.js";
import { findCharacterProfile, resolveCharacterDevelopmentStateAtSequence } from "../../shared/character-dynamics.js";
import type { AiResponseRequest } from "../provider.js";
export function buildCharacterRuntimeState(
  state: Pick<GameState, "playerName" | "characterProfiles">,
  currentEventSequence: number | null,
) {
  const profiles = state.characterProfiles ?? [];
  return {
    current_event_sequence: currentEventSequence,
    player: buildRuntimeProfile(state.playerName, profiles, currentEventSequence),
    characters: profiles.map((profile) => buildRuntimeProfile(
      profile.name,
      profiles,
      currentEventSequence,
    )),
  };
}

function buildRuntimeProfile(
  identity: string,
  profiles: readonly CharacterProfile[],
  currentEventSequence: number | null,
) {
  const profile = findCharacterProfile(identity, profiles);
  if (!profile) return null;
  const development = resolveCharacterDevelopmentStateAtSequence(
    profile,
    currentEventSequence,
  );
  return {
    name: profile.name,
    aliases: profile.aliases,
    speech: profile.dynamics?.capabilities.speech ?? {
      mode: "unknown",
      communicationModes: [],
      evidenceEventIds: [],
    },
    development: development
      ? {
          valid_after_event_id: development.afterEventId,
          valid_after_event_sequence: development.afterEventSequence,
          chapter_position: development.chapterPosition,
          state_summary: development.stateSummary,
          traits: development.traits,
          goals: development.goals,
          fears: development.fears,
          beliefs: development.beliefs,
          known_facts: development.knownFacts,
          relationships: development.relationships,
        }
      : null,
  };
}

export function withCharacterRuntimeContext(
  request: AiResponseRequest,
  state: Pick<GameState, "playerName" | "characterProfiles">,
  currentEventSequence: number | null,
): AiResponseRequest {
  const runtime = buildCharacterRuntimeState(state, currentEventSequence);
  return {
    ...request,
    instructions: [request.instructions ?? "", ...CHARACTER_RUNTIME_RULES].join("\n"),
    input: boundCharacterProfilePayload(request.input, runtime)
      + "\n\nCHARACTER RUNTIME STATE:\n" + JSON.stringify(runtime, null, 2),
  };
}

export const CHARACTER_RUNTIME_RULES = [
  "CHARACTER RUNTIME STATE defines source-backed speech capabilities and development valid only after confirmed event completion. Final-book traits, relationships and knowledge must not leak into an earlier state.",
  "When development is null, only identity and indexed speech capability are supplied. Use the visible scene and actual history for current facts; do not reconstruct a missing profile from book familiarity.",
  "Unknown or absent speech capability, empty communication modes and missing development mean no indexed restriction; never infer nonverbal from them.",
  "Capabilities are hard constraints for both player and NPCs. Nonverbal characters cannot speak human-like dialogue or use spoken talk choices; use their supported nonverbal communication modes.",
  "Actual interactive history and acquired knowledge take precedence over incompatible canonical development. Never reset a character or import unobserved canonical growth after a divergence.",
];

/** currentStoryEvent can still be in progress. Reaching it is not completing it. */
export function completedCharacterEventSequence(
  state: Pick<GameState, "sourceEventProgress" | "sourceCursor">,
  candidates: readonly import("./core.js").SourceContinuationCandidate[],
  opening = false,
): number | null {
  if (opening) return null;
  const event = candidates[0]?.currentStoryEvent;
  if (!event) return null;
  const progress = state.sourceEventProgress;
  if (progress?.eventId === event.eventId) {
    const complete = Boolean(event.beats?.length) && event.beats!.every((_, i) => progress.completedBeatIndexes.includes(i));
    return complete ? event.sequence : event.sequence - 1;
  }
  return state.sourceCursor?.eventId === event.eventId ? event.sequence : null;
}

/** Replace full-book profile projections even when older renderers omit dynamics. */
export function boundCharacterProfilePayload(text: string, runtime: ReturnType<typeof buildCharacterRuntimeState>): string {
  const identity = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase();
  const profiles = new Map(runtime.characters.flatMap(p => p ? [p.name, ...p.aliases].map(name => [identity(name), p] as const) : []));
  const project = (value: any): any => {
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== "object") return value;
    const profile = typeof value.name === "string" ? profiles.get(identity(value.name)) : undefined;
    const isProfile = typeof value.name === "string" && [
      "characterId", "storyArc", "traits", "dynamics", "significantEvents", "actions", "description", "relationships",
    ].some(key => key in value);
    if (isProfile) {
      // Whitelist runtime fields even without a snapshot or a runtime match.
      // Full-book summaries/relationships are not necessarily valid now; event
      // indexes and source excerpts belong to the bounded turn plan, never here.
      const development = profile?.development ?? null;
      return {name: profile?.name ?? value.name,
        aliases: profile?.aliases ?? (Array.isArray(value.aliases) ? value.aliases.filter((alias: unknown) => typeof alias === "string") : []),
        speech: profile?.speech ?? {mode: "unknown", communicationModes: [], evidenceEventIds: []},
        development,
        ...(development ? {description: development.state_summary, traits: development.traits,
          relationships: development.relationships} : {}),
      };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, project(entry)]));
  };
  // Older builders embed JSON after headings. Preserve their surrounding prose.
  let result = "", cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("{", cursor);
    if (start < 0) return result + text.slice(cursor);
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) {if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue;}
      if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {end = i + 1; break;}
    }
    if (end < 0) return result + text.slice(cursor);
    result += text.slice(cursor, start);
    try {result += JSON.stringify(project(JSON.parse(text.slice(start, end))));}
    catch {result += text.slice(start, end);}
    cursor = end;
  }
  return result;
}
