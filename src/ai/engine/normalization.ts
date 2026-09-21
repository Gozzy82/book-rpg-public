import type {
  EstablishedEvent,
  EstablishedEventCategory,
} from "../../shared/contracts.js";
import type {
  PlayerAvailability,
} from "./core.js";

export const EMBEDDED_CHOICE_MENU_HEADING =
  /^\s*(?:#{1,6}\s*)?(?:(?:(?:available|your)\s+)?(?:choices?|options?)(?:\s+ahead)?\s*:?|what\s+(?:do|will|would)\s+you\s+do(?:\s+next)?\s*\?)\s*$/i;
export const EMBEDDED_CHOICE_MENU_ITEM =
  /^\s*(?:\d{1,2}[.)]|[a-z][.)]|[-*]|\u2022)\s+\S/i;
export const EMBEDDED_CHOICE_MENU_LEAD_IN =
  /\b(?:choices?|options?|paths?|courses?)\b.*\b(?:ahead|await|forward|next|open|remain|unfold)\b/i;
export const EMBEDDED_INLINE_CHOICE_MENU_HEADING =
  /(?:^|\s)(?:#{1,6}\s*)?(?:(?:(?:available|your)\s+)?(?:choices?|options?)(?:\s+ahead)?\s*:|what\s+(?:do|will|would)\s+you\s+do(?:\s+next)?\s*\?)\s*(?=\d{1,2}[.)]\s+\S)/i;
export const EMBEDDED_INLINE_CHOICE_MENU_ITEM =
  /(?:^|\s)\d{1,2}[.)]\s+\S/gi;

// Models sometimes leak the decision point as natural prose instead of a numbered
// menu, e.g. "Choice set before me: stay here, or follow Dorothy." Keep this
// separate from the normal menu regexes so ordinary narrative uses of "choice"
// are not stripped unless they clearly present a decision-point prompt.
export const EMBEDDED_PROSE_CHOICE_PROMPT =
  /^\s*(?:(?:the\s+)?choice\s+set\s+before\s+(?:me|us)|choices?\s+before\s+(?:me|us)|options?\s+before\s+(?:me|us))\s*:\s*.+\bor\b.+$/i;

export function embeddedChoiceMenuRun(
  lines: readonly string[],
  start: number,
): { itemCount: number; menuEnd: number } {
  let cursor = start;
  let itemCount = 0;
  let menuEnd = cursor;
  while (cursor < lines.length) {
    if (EMBEDDED_CHOICE_MENU_ITEM.test(lines[cursor]!)) {
      itemCount += 1;
      cursor += 1;
      menuEnd = cursor;
      continue;
    }

    if (lines[cursor]!.trim()) break;
    let nextItem = cursor + 1;
    while (nextItem < lines.length && !lines[nextItem]!.trim()) nextItem += 1;
    if (
      nextItem >= lines.length
      || !EMBEDDED_CHOICE_MENU_ITEM.test(lines[nextItem]!)
    ) {
      break;
    }
    cursor = nextItem;
  }
  return { itemCount, menuEnd };
}

export function removeEmbeddedChoiceLeadIn(lines: string[]): void {
  while (lines.length > 0 && !lines.at(-1)!.trim()) lines.pop();
  const lastLine = lines.at(-1);
  if (!lastLine) return;

  const sentenceBoundaries = [". ", "! ", "? "]
    .map((separator) => lastLine.lastIndexOf(separator))
    .filter((index) => index >= 0);
  const sentenceStart = sentenceBoundaries.length > 0
    ? Math.max(...sentenceBoundaries) + 2
    : 0;
  const possibleLeadIn = lastLine.slice(sentenceStart).trim();
  if (!EMBEDDED_CHOICE_MENU_LEAD_IN.test(possibleLeadIn)) return;

  const precedingText = lastLine.slice(0, sentenceStart).trimEnd();
  if (precedingText) {
    lines[lines.length - 1] = precedingText;
  } else {
    lines.pop();
  }
}

export function stripEmbeddedChoiceMenu(text: string): string {
  const lines = text.split(/\r?\n/);
  const cleaned: string[] = [];
  let changed = false;

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (/^\s*Choice:\s+\S.*$/u.test(line) && lines.slice(index + 1).every(line => !line.trim())) {
      changed = true;
      while (cleaned.length > 0 && !cleaned.at(-1)!.trim()) cleaned.pop();
      break;
    }
    if (EMBEDDED_PROSE_CHOICE_PROMPT.test(line)) {
      changed = true;
      while (cleaned.length > 0 && !cleaned.at(-1)!.trim()) cleaned.pop();
      index += 1;
      continue;
    }
    const inlineHeading = EMBEDDED_INLINE_CHOICE_MENU_HEADING.exec(line);
    if (inlineHeading?.index !== undefined) {
      const menuText = line.slice(inlineHeading.index + inlineHeading[0].length);
      const itemCount = menuText.match(EMBEDDED_INLINE_CHOICE_MENU_ITEM)?.length ?? 0;
      if (itemCount >= 2) {
        changed = true;
        const narrativePrefix = line.slice(0, inlineHeading.index).trimEnd();
        if (narrativePrefix) cleaned.push(narrativePrefix);
        index += 1;
        continue;
      }
    }
    if (!EMBEDDED_CHOICE_MENU_HEADING.test(line)) {
      if (EMBEDDED_CHOICE_MENU_ITEM.test(line)) {
        const { itemCount, menuEnd } = embeddedChoiceMenuRun(lines, index);
        if (itemCount >= 2) {
          changed = true;
          removeEmbeddedChoiceLeadIn(cleaned);
          let nextLine = menuEnd;
          while (nextLine < lines.length && !lines[nextLine]!.trim()) nextLine += 1;
          if (cleaned.length > 0 && nextLine < lines.length) cleaned.push("");
          index = nextLine;
          continue;
        }
      }
      cleaned.push(line);
      index += 1;
      continue;
    }

    let cursor = index + 1;
    while (cursor < lines.length && !lines[cursor]!.trim()) cursor += 1;

    const { itemCount, menuEnd } = embeddedChoiceMenuRun(lines, cursor);

    if (itemCount < 2) {
      cleaned.push(line);
      index += 1;
      continue;
    }

    changed = true;
    while (cleaned.length > 0 && !cleaned.at(-1)!.trim()) cleaned.pop();

    let nextLine = menuEnd;
    while (nextLine < lines.length && !lines[nextLine]!.trim()) nextLine += 1;
    if (cleaned.length > 0 && nextLine < lines.length) cleaned.push("");
    index = nextLine;
  }

  return changed ? cleaned.join("\n").trim() : text;
}

export function normalizePlayerAvailability(value: unknown): PlayerAvailability {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenAI returned invalid player availability details");
  }

  const playable = Reflect.get(value, "playable");
  const reasonValue = Reflect.get(value, "reason");
  const objectiveValue = Reflect.get(value, "objective");
  const victoryConditionValue = Reflect.get(value, "victoryCondition");
  if (typeof playable !== "boolean") {
    throw new Error("OpenAI returned player availability without a playable decision");
  }

  const reason = typeof reasonValue === "string" ? reasonValue.trim() : "";
  const objective = typeof objectiveValue === "string" ? objectiveValue.trim() : "";
  const victoryCondition = typeof victoryConditionValue === "string"
    ? victoryConditionValue.trim()
    : "";

  if (!playable) {
    if (!reason) {
      throw new Error("OpenAI returned an unavailable player without a reason");
    }
    return { playable, reason, objective: "", victoryCondition: "" };
  }
  if (!objective || !victoryCondition) {
    throw new Error("OpenAI returned a playable player without complete game goals");
  }
  return { playable, reason, objective, victoryCondition };
}

export const ESTABLISHED_EVENT_CATEGORIES = new Set<EstablishedEventCategory>([
  "death",
  "violence",
  "betrayal",
  "disaster",
  "abduction",
  "accident",
  "other",
]);

export function normalizeEstablishedEvent(value: unknown): EstablishedEvent | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenAI returned an invalid established event");
  }

  const category = Reflect.get(value, "category");
  const actor = Reflect.get(value, "actor");
  const action = Reflect.get(value, "action");
  const target = Reflect.get(value, "target");
  const means = Reflect.get(value, "means");
  const consequences = Reflect.get(value, "immediateConsequences");
  const sourceBacked = Reflect.get(value, "sourceBacked");
  const narrative = Reflect.get(value, "narrative");
  if (
    typeof category !== "string"
    || !ESTABLISHED_EVENT_CATEGORIES.has(category as EstablishedEventCategory)
    || typeof actor !== "string"
    || typeof action !== "string"
    || typeof target !== "string"
    || typeof means !== "string"
    || !Array.isArray(consequences)
    || consequences.length === 0
    || consequences.some((item) => typeof item !== "string" || !item.trim())
    || sourceBacked !== true
    || typeof narrative !== "string"
    || !action.trim()
    || !target.trim()
    || !narrative.trim()
  ) {
    throw new Error("OpenAI returned an incomplete or ungrounded established event");
  }

  return {
    category: category as EstablishedEventCategory,
    actor: actor.trim(),
    action: action.trim(),
    target: target.trim(),
    means: means.trim(),
    immediateConsequences: consequences.map((item) => item.trim()),
    sourceBacked: true,
    narrative: narrative.trim(),
  };
}

export function normalizeEstablishedEventAssessment(
  value: unknown,
): EstablishedEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenAI returned an invalid established event assessment");
  }
  const established = Reflect.get(value, "established");
  const eventValue = Reflect.get(value, "event");
  if (typeof established !== "boolean") {
    throw new Error("OpenAI returned an established event assessment without a decision");
  }
  if (!established) {
    if (eventValue !== null) {
      throw new Error("OpenAI returned an event for a negative established event assessment");
    }
    return undefined;
  }
  const event = normalizeEstablishedEvent(eventValue);
  if (!event) {
    throw new Error("OpenAI omitted the positively identified established event");
  }
  return event;
}
