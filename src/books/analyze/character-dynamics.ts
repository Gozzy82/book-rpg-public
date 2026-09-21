import type {
  CharacterProfile,
  ImportedBook,
  WorldBible,
} from "../../shared/contracts.js";
import {
  CHARACTER_DYNAMICS_VERSION,
  allProfilesHaveCharacterDynamics,
} from "../../shared/character-dynamics.js";
import type {
  CharacterDevelopmentState,
  CharacterDynamics,
  CharacterSpeechMode,
} from "../../shared/character-dynamics.js";
import type { CreateAnalysisResponse } from "./batching.js";
import { requireOutputText } from "./output.js";

const MAX_CHARACTER_DYNAMICS_ATTEMPTS = 3;
const MAX_DEVELOPMENT_STATES_PER_CHARACTER = 12;

type StoryEvent = NonNullable<ImportedBook["storyEvents"]>[number];

const developmentRelationshipSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    character: { type: "string" },
    description: { type: "string" },
  },
  required: ["character", "description"],
} as const;

const developmentStateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    afterEventId: { type: ["string", "null"] },
    chapterPosition: { type: "integer", minimum: 0 },
    stateSummary: { type: "string" },
    traits: { type: "array", items: { type: "string" } },
    goals: { type: "array", items: { type: "string" } },
    fears: { type: "array", items: { type: "string" } },
    beliefs: { type: "array", items: { type: "string" } },
    knownFacts: { type: "array", items: { type: "string" } },
    relationships: { type: "array", items: developmentRelationshipSchema },
  },
  required: [
    "afterEventId",
    "chapterPosition",
    "stateSummary",
    "traits",
    "goals",
    "fears",
    "beliefs",
    "knownFacts",
    "relationships",
  ],
} as const;

const characterDynamicsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    characterDynamics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          capabilities: {
            type: "object",
            additionalProperties: false,
            properties: {
              speech: {
                type: "object",
                additionalProperties: false,
                properties: {
                  mode: { type: "string", enum: ["verbal", "nonverbal", "unknown"] },
                  communicationModes: { type: "array", items: { type: "string" } },
                  evidenceEventIds: { type: "array", items: { type: "string" } },
                },
                required: ["mode", "communicationModes", "evidenceEventIds"],
              },
            },
            required: ["speech"],
          },
          development: {
            type: "array",
            minItems: 1,
            maxItems: MAX_DEVELOPMENT_STATES_PER_CHARACTER,
            items: developmentStateSchema,
          },
        },
        required: ["name", "capabilities", "development"],
      },
    },
  },
  required: ["characterDynamics"],
} as const;

function normalizedIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function profileIdentities(profile: CharacterProfile): Set<string> {
  return new Set([profile.name, ...profile.aliases].map(normalizedIdentity));
}

function eventInvolvesProfile(event: StoryEvent, profile: CharacterProfile): boolean {
  const identities = profileIdentities(profile);
  return [
    ...event.actors,
    ...event.targets,
    ...(event.beats ?? []).flatMap((beat) => [beat.actor ?? "", ...beat.targets]),
  ].some((identity) => identities.has(normalizedIdentity(identity)));
}

/** Provider-side constraints prevent mistyped IDs and cross-character links. */
export function characterDynamicsSchemaForProfiles(profiles: CharacterProfile[], events: StoryEvent[]) {
  const row = characterDynamicsSchema.properties.characterDynamics.items;
  return {...characterDynamicsSchema, properties: {characterDynamics: {
    ...characterDynamicsSchema.properties.characterDynamics,
    minItems: profiles.length, maxItems: profiles.length,
    items: {anyOf: profiles.map(profile => {
      const ids = events.filter(event => eventInvolvesProfile(event, profile)).map(event => event.eventId);
      const capabilities = row.properties.capabilities;
      const speech = capabilities.properties.speech;
      return {...row, properties: {...row.properties,
        name: {type: "string", enum: [profile.name]},
        capabilities: {...capabilities, properties: {speech: {...speech, properties: {...speech.properties,
          evidenceEventIds: {type: "array", ...(ids.length
            ? {items: {type: "string", enum: ids}}
            : {items: {type: "string"}, maxItems: 0})},
        }}}},
        development: {...row.properties.development, items: {...developmentStateSchema,
          properties: {...developmentStateSchema.properties, afterEventId: {type: ["string", "null"], enum: [null, ...ids]}},
        }},
      }};
    })},
  }}};
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Character dynamics returned invalid ${field}`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function parseRelationships(value: unknown, profile: CharacterProfile) {
  if (!Array.isArray(value)) {
    throw new Error(`Character dynamics returned invalid relationships for ${profile.name}`);
  }
  return value.map((relationship) => {
    if (!relationship || typeof relationship !== "object" || Array.isArray(relationship)) {
      throw new Error(`Character dynamics returned invalid relationship for ${profile.name}`);
    }
    const item = relationship as Record<string, unknown>;
    if (
      typeof item.character !== "string" || !item.character.trim()
      || typeof item.description !== "string" || !item.description.trim()
    ) {
      throw new Error(`Character dynamics returned invalid relationship for ${profile.name}`);
    }
    return { character: item.character.trim(), description: item.description.trim() };
  });
}

function parseDevelopmentState(
  value: unknown,
  profile: CharacterProfile,
  eventsById: Map<string, StoryEvent>,
  previousSequence: number,
  index: number,
  earliestEvent: StoryEvent | undefined,
): { state: CharacterDevelopmentState; sequence: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid development state ${index + 1} for ${profile.name}`);
  }
  const record = value as Record<string, unknown>;
  const afterEventId = record.afterEventId;
  if (!(afterEventId === null || typeof afterEventId === "string")) {
    throw new Error(`Invalid afterEventId in development state for ${profile.name}`);
  }
  if (!Number.isInteger(record.chapterPosition) || (record.chapterPosition as number) < 0) {
    throw new Error(`Invalid chapterPosition in development state for ${profile.name}`);
  }
  if (typeof record.stateSummary !== "string" || !record.stateSummary.trim()) {
    throw new Error(`Missing stateSummary in development state for ${profile.name}`);
  }

  let sequence = -1;
  let afterEventSequence: number | null = null;
  if (index === 0) {
    if (afterEventId !== null) {
      throw new Error(`The first development state for ${profile.name} must be the initial state`);
    }
    if (earliestEvent && record.chapterPosition !== earliestEvent.chapterPosition) {
      throw new Error(`Initial development chapter does not match first event for ${profile.name}`);
    }
  } else {
    if (!afterEventId) {
      throw new Error(`Only the first development state for ${profile.name} may omit an event`);
    }
    const event = eventsById.get(afterEventId);
    if (!event) throw new Error(`Unknown development event ${afterEventId} for ${profile.name}`);
    if (!eventInvolvesProfile(event, profile)) {
      throw new Error(`Development event ${afterEventId} does not involve ${profile.name}`);
    }
    if (record.chapterPosition !== event.chapterPosition) {
      throw new Error(`Development chapter does not match ${afterEventId} for ${profile.name}`);
    }
    sequence = event.sequence;
    afterEventSequence = event.sequence;
    if (sequence <= previousSequence) {
      throw new Error(`Development states are not chronological for ${profile.name}`);
    }
  }

  return {
    state: {
      afterEventId,
      afterEventSequence,
      chapterPosition: record.chapterPosition as number,
      stateSummary: record.stateSummary.trim(),
      traits: parseStringArray(record.traits, `traits for ${profile.name}`),
      goals: parseStringArray(record.goals, `goals for ${profile.name}`),
      fears: parseStringArray(record.fears, `fears for ${profile.name}`),
      beliefs: parseStringArray(record.beliefs, `beliefs for ${profile.name}`),
      knownFacts: parseStringArray(record.knownFacts, `knownFacts for ${profile.name}`),
      relationships: parseRelationships(record.relationships, profile),
    },
    sequence,
  };
}

function parseDynamicsOutput(
  output: string,
  profiles: CharacterProfile[],
  events: StoryEvent[],
): Map<string, CharacterDynamics> {
  const parsed: unknown = JSON.parse(output);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Character dynamics response is not an object");
  }
  const rows = (parsed as Record<string, unknown>).characterDynamics;
  if (!Array.isArray(rows)) {
    throw new Error("Character dynamics response has no characterDynamics list");
  }

  const profilesByName = new Map(profiles.map((profile) => [normalizedIdentity(profile.name), profile]));
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  const result = new Map<string, CharacterDynamics>();

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Character dynamics response contains an invalid entry");
    }
    const record = row as Record<string, unknown>;
    if (typeof record.name !== "string") throw new Error("Character dynamics entry has no name");
    const profile = profilesByName.get(normalizedIdentity(record.name));
    if (!profile) throw new Error(`Character dynamics returned unknown character ${record.name}`);
    const key = normalizedIdentity(profile.name);
    if (result.has(key)) throw new Error(`Character dynamics returned ${profile.name} more than once`);

    const capabilities = record.capabilities;
    const speech = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
      ? (capabilities as Record<string, unknown>).speech
      : undefined;
    if (!speech || typeof speech !== "object" || Array.isArray(speech)) {
      throw new Error(`Character dynamics returned invalid speech capability for ${profile.name}`);
    }
    const speechRecord = speech as Record<string, unknown>;
    const mode = speechRecord.mode;
    if (!(["verbal", "nonverbal", "unknown"] as unknown[]).includes(mode)) {
      throw new Error(`Character dynamics returned invalid speech mode for ${profile.name}`);
    }
    const evidenceEventIds = parseStringArray(speechRecord.evidenceEventIds, `speech evidence for ${profile.name}`);
    for (const eventId of evidenceEventIds) {
      const event = eventsById.get(eventId);
      if (!event || !eventInvolvesProfile(event, profile)) {
        throw new Error(`Invalid speech evidence event ${eventId} for ${profile.name}`);
      }
    }
    if (mode === "nonverbal" && evidenceEventIds.length === 0) {
      throw new Error(`Nonverbal classification for ${profile.name} requires source evidence`);
    }

    if (!Array.isArray(record.development) || record.development.length === 0 || record.development.length > MAX_DEVELOPMENT_STATES_PER_CHARACTER) {
      throw new Error(`Character dynamics returned no development states for ${profile.name}`);
    }
    const profileEvents = events.filter((event) => eventInvolvesProfile(event, profile)).sort((a, b) => a.sequence - b.sequence);
    let previousSequence = -1;
    // Each snapshot explicitly names its boundary. Canonical sequence, not model
    // array order, determines chronology. Duplicate/unknown boundaries still fail.
    const laterStates = record.development.slice(1).sort((a, b) =>
      (eventsById.get(a?.afterEventId)?.sequence ?? Number.MAX_SAFE_INTEGER)
      - (eventsById.get(b?.afterEventId)?.sequence ?? Number.MAX_SAFE_INTEGER));
    const development = [record.development[0], ...laterStates].map((value, index) => {
      const parsedState = parseDevelopmentState(
        value,
        profile,
        eventsById,
        previousSequence,
        index,
        profileEvents[0],
      );
      previousSequence = parsedState.sequence;
      return parsedState.state;
    });

    result.set(key, {
      version: CHARACTER_DYNAMICS_VERSION,
      capabilities: {
        speech: {
          mode: mode as CharacterSpeechMode,
          communicationModes: parseStringArray(speechRecord.communicationModes, `communication modes for ${profile.name}`),
          evidenceEventIds,
        },
      },
      development,
    });
  }

  const missing = profiles.filter((profile) => !result.has(normalizedIdentity(profile.name)));
  if (missing.length) {
    throw new Error(`Character dynamics omitted: ${missing.map((profile) => profile.name).join(", ")}`);
  }
  if (result.size !== profiles.length) {
    throw new Error("Character dynamics response has an unexpected character count");
  }
  return result;
}

function dynamicsInput(book: ImportedBook, profiles: CharacterProfile[]): string {
  return [
    `BOOK: ${book.title}`,
    book.author ? `AUTHOR: ${book.author}` : "",
    "",
    "CHARACTER PROFILES:",
    JSON.stringify(profiles.map((profile) => ({
      name: profile.name,
      aliases: profile.aliases,
      role: profile.role,
      description: profile.description,
      traits: profile.traits,
      storyArc: profile.storyArc,
      allowedEventIds: (book.storyEvents ?? []).filter(event => eventInvolvesProfile(event, profile)).map(event => event.eventId),
    })), null, 2),
    "",
    "CHAPTER SUMMARIES:",
    JSON.stringify(book.chapters.map((chapter, chapterPosition) => ({
      chapterPosition,
      title: chapter.title,
      summary: chapter.sourceIndex?.summary ?? chapter.summary ?? "",
    })), null, 2),
    "",
    "CANONICAL STORY EVENTS:",
    JSON.stringify((book.storyEvents ?? []).filter(event => profiles.some(profile => eventInvolvesProfile(event, profile))).map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      chapterPosition: event.chapterPosition,
      description: event.description,
      actors: event.actors,
      targets: event.targets,
      beats: event.beats?.map((beat) => ({
        actor: beat.actor,
        action: beat.action,
        targets: beat.targets,
        agency: beat.agency,
      })) ?? [],
    })), null, 2),
  ].filter(Boolean).join("\n");
}

export function hasCompleteCharacterDynamics(worldBible: WorldBible | undefined): boolean {
  return allProfilesHaveCharacterDynamics(worldBible?.characterProfiles);
}

export async function enrichCharacterProfilesWithDynamics(
  book: ImportedBook,
  worldBible: WorldBible,
  createResponse: CreateAnalysisResponse,
  model: string,
  log: (message: string) => void = console.error,
): Promise<WorldBible> {
  const profiles = worldBible.characterProfiles ?? [];
  const events = book.storyEvents ?? [];
  if (profiles.length === 0 || events.length === 0) return worldBible;

  // Keep per-character event enums and output bounded; a later batch failure
  // does not regenerate characters whose batch already validated in this call.
  const batches: CharacterProfile[][] = [];
  let batch: CharacterProfile[] = [], enumValues = 0;
  for (const profile of profiles) {
    const cost = 2 * events.filter(event => eventInvolvesProfile(event, profile)).length + 2;
    if (batch.length && (batch.length >= 4 || enumValues + cost > 900)) {
      batches.push(batch); batch = []; enumValues = 0;
    }
    batch.push(profile); enumValues += cost;
  }
  if (batch.length) batches.push(batch);
  if (batches.length > 1) {
    for (const [index, group] of batches.entries()) {
      log(`Character dynamics batch ${index + 1}/${batches.length}: ${group.map(profile => profile.name).join(", ")}`);
      await enrichCharacterProfilesWithDynamics(book, {...worldBible, characterProfiles: group}, createResponse, model, log);
    }
    return worldBible;
  }

  let lastFailure = "";
  for (let attempt = 1; attempt <= MAX_CHARACTER_DYNAMICS_ATTEMPTS; attempt += 1) {
    log(attempt === 1
      ? "Creating source-grounded character capabilities and development timeline..."
      : `Retrying character dynamics (attempt ${attempt}/${MAX_CHARACTER_DYNAMICS_ATTEMPTS})...`);
    const response = await createResponse({
      model,
      reasoning: { effort: "low" },
      instructions: [
        "Create source-grounded runtime character dynamics for every supplied CHARACTER PROFILE.",
        "Return exactly one characterDynamics entry per canonical profile name and do not rename, merge, add, or omit characters.",
        "Speech capability is a HARD runtime constraint. Use mode 'nonverbal' only when supplied source evidence establishes that the character does not use human-like spoken language and communicates through modes such as barking, whining, gesture, signs, or other nonverbal behavior. Mere absence of quoted dialogue is not sufficient. If the source is ambiguous, use 'unknown'.",
        "For a nonverbal character, include at least one evidenceEventId that actually involves the character and supports the classification. Never infer capabilities from adaptations or outside knowledge.",
        "communicationModes must list only source-supported communication modes; examples include speech, barking, whining, growling, gesture, writing, or sign language.",
        "Development is a sparse sequence of CHARACTER STATE SNAPSHOTS, not a chapter-by-chapter recap. The initial snapshot must describe the character BEFORE their earliest event happens; it must not include relationships, goals or knowledge first acquired during that event. Include an initial snapshot with afterEventId=null, then add a snapshot only after a canonical story event that materially changes goals, fears, beliefs, self-image, knowledge, relationships, or expressed traits.",
        "Each later snapshot becomes valid only AFTER its afterEventId has happened. Never put knowledge of later events into an earlier snapshot.",
        "Keep states cumulative enough to portray the character correctly at that point in the story. In particular, preserve evolving self-perception: a character who still believes they are cowardly must not be described as confidently courageous merely because their final story arc proves otherwise.",
        "knownFacts contains only facts the character personally knows by that point; do not include narrator-only or future knowledge.",
        "relationships describes only relationships established by that point, not their final-book state.",
        `Use at most ${MAX_DEVELOPMENT_STATES_PER_CHARACTER} snapshots per character and prefer fewer meaningful milestones.`,
        "Each character has allowedEventIds. Select development and speech evidence IDs only from that character's list; never copy an ID from another character or add punctuation. Supply snapshots in chronological order; the application derives their stored sequence from the selected event IDs.",
        "Use eventId values exactly as supplied. chapterPosition is zero-based and must equal the boundary event's chapterPosition; for the initial snapshot use the chapterPosition of the character's earliest supplied event.",
        "Do not reproduce long passages or distinctive prose from the book.",
        lastFailure ? `The previous result failed validation: ${lastFailure}. Correct it.` : "",
      ].filter(Boolean).join("\n"),
      input: dynamicsInput(book, profiles),
      text: {
        format: {
          type: "json_schema",
          name: "bookrpg_character_dynamics",
          strict: true,
          schema: characterDynamicsSchemaForProfiles(profiles, events),
        },
      },
      max_output_tokens: Math.min(48_000, Math.max(6_000, profiles.length * 2_500)),
    });

    try {
      const dynamics = parseDynamicsOutput(
        requireOutputText(response, "character dynamics"),
        profiles,
        events,
      );
      for (const profile of profiles) {
        profile.dynamics = dynamics.get(normalizedIdentity(profile.name));
      }
      return worldBible;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      log(`Character dynamics validation failed: ${lastFailure}`);
    }
  }

  throw new Error(
    `OpenAI returned invalid character dynamics after ${MAX_CHARACTER_DYNAMICS_ATTEMPTS} attempts: ${lastFailure}`,
  );
}
