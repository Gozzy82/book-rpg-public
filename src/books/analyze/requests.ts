import type {
  ImportedBook,
} from "../../shared/contracts.js";
import type {
  ChapterPartSourceIndex,
} from "../source-index.js";
import {
  MAX_CHAPTER_SUMMARY_WORDS,
  sourceId,
  formatAnalysisPart,
  chapterSourceIndexSchema,
} from "./batching.js";
import type {
  CreateAnalysisResponse,
  ChapterAnalysisPart,
} from "./batching.js";
import {
  requireOutputText,
  parseChapterSourceIndexes,
  chapterSourceOutputTokenLimit,
} from "./output.js";

export async function requestChapterSourceIndexes(
  createResponse: CreateAnalysisResponse,
  model: string,
  book: ImportedBook,
  parts: ChapterAnalysisPart[],
  batchNumber: number,
  attempt: number,
  previousValidationErrors: Map<string, string>,
): Promise<{
  indexes: Map<string, ChapterPartSourceIndex>;
  invalidParts: ChapterAnalysisPart[];
  validationErrors: Map<string, string>;
}> {
  const validationFeedback = [...previousValidationErrors]
    .map(([sourceId, message]) => `${sourceId}: ${message}`)
    .join("; ");
  const response = await createResponse({
    model,
    reasoning: { effort: "low" },
    instructions: [
      "Create a separate source-backed story index for every labeled SOURCE_ID.",
      "Never merge source sections or omit a SOURCE_ID; the JSON property names identify the required sections.",
      "Each source is either one complete EPUB chapter/section or one consecutive part of an oversized chapter.",
      "Write a non-empty summary and index every named or consistently identifiable story character who is explicitly present or discussed.",
      "Use a character's most complete name available in this source as name. Put only genuine alternative names or stable name-like identity labels in aliases.",
      "Do not omit a source-backed shortened name merely because the canonical name is longer. When the source itself repeatedly or conventionally uses a shorter name-like form for the same character, include that shorter form in aliases. A shortened form may drop an adjective, epithet, honorific, or other qualifier, but it must still function in the source as a standalone identifier for that character.",
      "An alias must be safe to substitute for the character during identity matching. A title, honorific, occupation, role, species or kind, relationship term, description, epithet, or form of address is not an alias merely because it refers to that character in one passage. Include such a label only when the source clearly uses it as a stable name-like identifier for that character.",
      "Use only this book’s source evidence for identities. Do not import names or merge roles from adaptations, films, sequels, or general familiarity. Similar titles, benevolence, or narrative functions do not establish that two characters are the same person; require explicit source evidence linking their identities.",
      "Never turn another character's mistaken belief, assumption, praise, insult, or temporary description into an alias. Never use pronouns as aliases. When uncertain, omit the alias.",
      "Record concrete story actions with their actor, a concise description, and only person targets. Objects and locations are not targets.",
      "Record every significant story event separately in significantEvents, in source order. Include irreversible changes, deaths, attacks, discoveries, revelations, departures, arrivals, investigations, betrayals, major decisions, and other events required to understand why a later event can occur.",
      "Decompose every significant event into one or more atomic beats. Each beat records one concrete action, reaction, involuntary experience, or environmental occurrence; do not combine different actors or different agency into one beat.",
      "Order beats strictly by when they happen in the narrative present and by causal dependency. A prerequisite or cause must appear before the reaction, discovery, decision, or consequence that depends on it. Never put an earlier world event after a later character reaction merely because the character reaction is more important to gameplay.",
      "If a character can only perform a beat because an external/NPC beat already happened, put that external/NPC beat first or split the character beat into the next significant event when it forms a meaningful decision boundary.",
      "Example: if a cyclone deposits Dorothy's house and Dorothy then awakens, discovers the house has stopped, and goes outside, the deposit/landing must be earlier in the ordered beats (or its own preceding event). Never order Dorothy going outside before the landing that makes it possible.",
      "Treat the narrative present of the supplied source as the event chronology. Dialogue, memories, dreams, visions, letters, books, or other embedded accounts of earlier events do not move the current story back to those events.",
      "When a present-time character recounts or otherwise communicates an embedded past event, keep the framing action explicit in the event description and in every beat. For example, use Scarecrow: Recounts attempting to follow the farmer, not Scarecrow: Attempts to follow the farmer.",
      "Do not switch from a framing beat such as recounts, remembers, reads, or dreams into unframed beats that make the embedded actors perform those historical actions in the narrative present. Preserve important embedded details as separate framed beats when needed.",
      "Preserve the information status of dialogue and exposition. Distinguish a genuinely new revelation from information that is already known, merely referenced, repeated, clarified, explained, challenged, or used as reasoning. Never rewrite already-known information as though one character newly tells, reveals, discovers, or teaches it to another.",
      "When one statement serves as the reason for another, preserve that relationship in the beat instead of flattening both statements into separate revelations. For example, if Dorothy explains why she wants to return home and says Scarecrow's already-known lack of brains is why he cannot understand that attachment, describe Dorothy as explaining her attachment to home by referring to his lack of brains; do not describe her as newly telling Scarecrow that he lacks brains.",
      "Use verbs such as tells, reveals, learns, discovers, realizes, informs, or explains-that only when the cited source establishes that the information is new to the relevant character at that moment. Otherwise use wording such as refers to, reminds, repeats, argues, clarifies, explains why, or uses X as a reason, as supported by the source.",
      "For a beat initiated or experienced by a character, set actor to that character's exact indexed name. Use actor null and agency external only when no character initiates or experiences the beat, such as weather, a collapsing structure, or another actorless world change.",
      "Classify agency from the cited source rather than grammatical subject. Use intentional only for a purposeful character act; involuntary for accidents, reflexes, coercively caused movement, being struck, falling, losing consciousness, or another occurrence the actor does not choose; external for actorless world changes; and ambiguous only when the source does not establish control.",
      "A word alone never determines agency: deliberate falling can be intentional, while accidentally shooting someone can be involuntary. Do not infer intent that the cited lines do not support.",
      "Classify each beat's stakes by its consequence: routine for minor readily reversible activity, significant for a material change or meaningful decision, and critical for death, irreversible harm, betrayal, surrender, or a comparably decisive consequence.",
      "Write the event description in active voice when the source identifies an actor. For example, if a witch directs Dorothy to travel, the witch is the actor of that beat and Dorothy is its target; Dorothy is not an actor merely because the instruction concerns her future journey.",
      "Use an empty targets array when a beat has no person target. Do not put objects or locations in targets.",
      "Keep causally distinct events separate even when they occur close together: an attack, the resulting death, discovery of the body, and contacting authorities are separate events when the source depicts them separately.",
      "Also split at a meaningful decision boundary: when a significant or critical intentional character beat follows an arrival, accident, NPC act, or other independently complete beat, record that intentional beat as the next event rather than combining both sides of the decision.",
      "Do not omit a causally necessary event merely because it also appears in actions or the summary.",
      "Record explicit or strongly evidenced relationships between two indexed characters. Describe the relationship in neutral third-person language.",
      "Every beat actor, beat target, action actor, action target, and relationship participant must exactly match a name or alias in the same SOURCE_ID's characters array.",
      "Attach one or more exact line ranges from LINE_NUMBERED_TEXT to every significant event, event beat, character, action, and relationship. The event-level references must collectively cover its beats. Reuse only visible line numbers and never invent or widen evidence.",
      "Preserve chronology and distinguish story events from introductions, notes, and other front or back matter.",
      "For non-story material, briefly identify its contents and return empty significant event, character, action, and relationship arrays.",
      "Do not infer unsupported identities, actions, relationships, or source references.",
      "Do not reproduce long passages or distinctive prose from the source.",
      `Use the main language of the supplied book and keep each summary under ${MAX_CHAPTER_SUMMARY_WORDS} words.`,
      validationFeedback
        ? `The previous result failed validation. Correct these errors: ${validationFeedback}`
        : "",
    ].filter(Boolean).join("\n"),
    input: [
      `BOOK: ${book.title}`,
      book.author ? `AUTHOR: ${book.author}` : "",
      "",
      ...parts.map(formatAnalysisPart),
    ].filter(Boolean).join("\n\n"),
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_chapter_source_index",
        strict: true,
        schema: chapterSourceIndexSchema(parts),
      },
    },
    max_output_tokens: chapterSourceOutputTokenLimit(parts, attempt),
  });

  return parseChapterSourceIndexes(
    requireOutputText(response, `chapter source index batch ${batchNumber}`),
    parts,
    batchNumber,
  );
}
