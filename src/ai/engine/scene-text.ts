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

export function extractLeakedExternalDevelopment(text: string): string | undefined {
  return LEAKED_EXTERNAL_DEVELOPMENT.exec(text)?.[1]?.trim() || undefined;
}

export function stripLeakedSceneMetadata(text: string): string {
  return text
    .replace(LEAKED_EXTERNAL_DEVELOPMENT_LINE, "")
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
    || /\bexternal developments?\s+(?:condense|summary|context)\s*:/i.test(text)
    || /\bestablishedEvent\s*:/i.test(text)
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

export function textNarratesCharacterArrival(
  text: string,
  character: string,
  characterProfiles: readonly CharacterProfile[] = [],
): boolean {
  const normalizedText = normalizeComparableChoiceText(text);
  const normalizedCharacter = normalizeComparableChoiceText(character);
  const profile = characterProfiles.find((candidate) =>
    [candidate.name, ...candidate.aliases].some(
      (identity) => normalizeComparableChoiceText(identity) === normalizedCharacter,
    )
  );
  const fallbackFirstName = !profile && character.trim().includes(" ")
    ? character.trim().split(/\s+/u)[0]
    : undefined;
  const identities = [
    character,
    profile?.name,
    ...(profile?.aliases ?? []),
    fallbackFirstName,
  ]
    .filter((identity): identity is string => Boolean(identity?.trim()))
    .map(normalizeComparableChoiceText);

  return identities.some((identity) => {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `\\b${escaped}\\b(?: \\p{L}+){0,6} \\b(?:arrives|returns|enters|appears|comes (?:in|inside|home)|steps (?:in|inside|through)|is (?:here|back|home|present))\\b`,
      "iu",
    ).test(normalizedText);
  });
}

export function sceneDirectlyInteractsWithCharacter(
  text: string,
  character: string,
  characterProfiles: readonly CharacterProfile[],
): boolean {
  if (!textMentionsCharacter(text, character, characterProfiles)) return false;
  if (textNarratesCharacterArrival(text, character, characterProfiles)) return true;

  const normalizedText = normalizeComparableChoiceText(text);
  const profile = characterProfiles.find((candidate) =>
    [candidate.name, ...candidate.aliases].some((identity) =>
      normalizeComparableChoiceText(identity) === normalizeComparableChoiceText(character)
    )
  );
  const interactionVerb =
    "(?:answers|asks|calls|enters|greets|hands|joins|kisses|nods|questions|replies|responds|returns|says|speaks|talks|tells|touches|waves)";
  return [character, profile?.name, ...(profile?.aliases ?? [])]
    .filter((identity): identity is string => Boolean(identity?.trim()))
    .some((identity) => {
      const escapedIdentity = normalizeComparableChoiceText(identity)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `(?:\\b${escapedIdentity}\\b(?: \\p{L}+){0,8} \\b${interactionVerb}\\b|`
        + `\\b${interactionVerb}\\b(?: \\p{L}+){0,8} \\b${escapedIdentity}\\b)`,
        "iu",
      ).test(normalizedText);
    });
}
