import type {
  CharacterProfile,
} from "../../shared/contracts.js";

export function normalizeComparableChoiceText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function comparableChoiceTokens(text: string): Set<string> {
  return new Set(
    normalizeComparableChoiceText(text)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
}

export function choiceTextsAreSimilar(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableChoiceText(left);
  const normalizedRight = normalizeComparableChoiceText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const leftTokens = comparableChoiceTokens(left);
  const rightTokens = comparableChoiceTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return shared / union >= 0.6;
}

export function normalizedScopeIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export const EXTERNAL_DEVELOPMENT_LABEL = String.raw`external[\s_-]*developments?`;

export const LEAKED_EXTERNAL_DEVELOPMENT = new RegExp(
  String.raw`^\s*${EXTERNAL_DEVELOPMENT_LABEL}\s*:\s*(.+?)\s*$`,
  "im",
);

export const LEAKED_EXTERNAL_DEVELOPMENT_LINE = new RegExp(
  String.raw`^\s*${EXTERNAL_DEVELOPMENT_LABEL}\s*:.*(?:\r?\n|$)`,
  "gim",
);

export const LEAKED_EXTERNAL_DEVELOPMENT_SENTENCE = new RegExp(
  String.raw`(?:^|\s+)${EXTERNAL_DEVELOPMENT_LABEL}\b(?:\s*:|\s+(?:indicates?|shows?|states?|reports?|means?|is)\b)[^.!?\r\n]*(?:[.!?](?=\s|$)|$)`,
  "gim",
);

export const LEAKED_EXTERNAL_DEVELOPMENT_REFERENCE = new RegExp(
  String.raw`\b${EXTERNAL_DEVELOPMENT_LABEL}\b(?:\s*:|\s+(?:indicates?|shows?|states?|reports?|means?|is)\b)`,
  "i",
);

export const LEAKED_OPENING_CONTROL_LINE =
  /^\s*(?:OPENING PRELUDE|PRELUDE BEAT\s+\d+|STOP BEFORE PLAYER BEAT\s+\d+|PENDING PLAYER BEAT\s*[—-]\s*DO NOT PERFORM)\b.*(?:\r?\n|$)/gim;

export const LEAKED_OPENING_CONTROL_REFERENCE =
  /\b(?:OPENING PRELUDE|PRELUDE BEAT\s+\d+|STOP BEFORE PLAYER BEAT\s+\d+|PENDING PLAYER BEAT\s*[—-]\s*DO NOT PERFORM)\b/i;

/** A model can occasionally serialize the remainder of its structured scene object
 * into the prose value itself. Match only object-like quoted field syntax so
 * ordinary narration containing words such as "development" is unaffected. */
export const LEAKED_SCENE_OBJECT_TAIL =
  /(?:^|[,{}]\s*)['"](?:development|outcome|outcomeReason|sceneScope|peopleKilledInScene|storyMemory|choices)['"]\s*:/i;

export const LEAKED_SCENE_OBJECT_TAIL_START =
  /(?:\s*['"]?\s*,\s*)?['"](?:development|outcome|outcomeReason|sceneScope|peopleKilledInScene|storyMemory|choices)['"]\s*:/i;

export function extractLeakedExternalDevelopment(text: string): string | undefined {
  return LEAKED_EXTERNAL_DEVELOPMENT.exec(text)?.[1]?.trim() || undefined;
}

export function stripLeakedSceneMetadata(text: string): string {
  const objectTail = LEAKED_SCENE_OBJECT_TAIL_START.exec(text);
  const narrative = objectTail ? text.slice(0, objectTail.index) : text;
  return narrative
    .replace(LEAKED_EXTERNAL_DEVELOPMENT_LINE, "")
    .replace(LEAKED_OPENING_CONTROL_LINE, "")
    .replace(/^\s*external developments?\s+(?:condense|summary|context)\s*:.*(?:\r?\n|$)/gim, "")
    .replace(/^\s*establishedEvent\s*:.*(?:\r?\n|$)/gim, "")
    .replace(LEAKED_EXTERNAL_DEVELOPMENT_SENTENCE, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function sceneLeaksInternalMetadata(...texts: string[]): boolean {
  return texts.some((text) =>
    LEAKED_EXTERNAL_DEVELOPMENT_REFERENCE.test(text)
    || LEAKED_OPENING_CONTROL_REFERENCE.test(text)
    || /\bexternal developments?\s+(?:condense|summary|context)\s*:/i.test(text)
    || /\bestablishedEvent\s*:/i.test(text)
    || LEAKED_SCENE_OBJECT_TAIL.test(text)
  );
}

export function textMentionsCharacter(
  text: string,
  character: string,
  characterProfiles: readonly CharacterProfile[] = [],
): boolean {
  const normalizedCharacter = normalizeComparableChoiceText(character);
  const profile = characterProfiles.find((candidate) =>
    [candidate.name, ...candidate.aliases].some(
      (identity) => normalizeComparableChoiceText(identity) === normalizedCharacter,
    )
  );
  const identities = [character, profile?.name, ...(profile?.aliases ?? [])]
    .filter((identity): identity is string => Boolean(identity?.trim()));

  return identities.some((identity) => {
    const escaped = identity.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu")
      .test(text);
  });
}

