import {STORY_EVENT_CATEGORY_POLICY} from '../../shared/story-event-category.js';
import { SOURCE_TRANSITION_POLICY } from "../../shared/source-transition-policy.js";
import { PLAYER_ACTION_ACTOR_POLICY, PLAYER_ACTION_GROUP_POLICY } from "./player-action-actor-policy.js";
import { reviewPlayerActionGroups, PlayerActionReviewRejection } from "./player-action-review.js";
import { repairPlayerActions, sourceWithoutPlayerActions, type PlayerActionRepairCache } from "./player-action-repair.js";
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
  isRecord,
  requireOutputText,
  parseChapterSourceIndexes,
  chapterSourceOutputTokenLimit,
} from "./output.js";

export const CHAPTER_SOURCE_INDEX_INSTRUCTIONS = [
  PLAYER_ACTION_ACTOR_POLICY,
  PLAYER_ACTION_GROUP_POLICY,
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
  STORY_EVENT_CATEGORY_POLICY,
  "Record every significant story event separately in significantEvents, in source order. Include irreversible changes, deaths, attacks, discoveries, revelations, departures, arrivals, investigations, betrayals, major decisions, and other events required to understand why a later event can occur.",
  "Decompose every significant event into one or more atomic beats. Each beat records one concrete action, reaction, involuntary experience, or environmental occurrence; do not combine different actors or different agency into one beat.",
  ...SOURCE_TRANSITION_POLICY,
  "INDEXING ORDER: first identify the complete ordered sequence of atomic actions within this SOURCE_ID, including later actions and interruptions. Then derive each resultingState from the source state and the prefix ending at that beat. Looking ahead determines where to stop; it never makes a later action already performed.",
  "For every beat, also write resultingState: a concise, concrete snapshot of the relevant world and character state immediately after that beat has completed and before the next beat starts.",
  "A resultingState must not smuggle in another actor's new voluntary action. If the source describes an intervening action (for example Dorothy begins trying to retrieve Toto after Toto hides), index it as its own beat with its own actor, agency and stakes; do not hide it inside Toto's postcondition. Postconditions describe outcomes of their own beat and persistent facts, not extra events.",
  "LOOKAHEAD COMPATIBILITY: use the next and later source-backed actions to check that each resultingState preserves the facts and possibilities they will need. Preserve relevant reachability, locations, possessions and open paths when supported by the source; do not accidentally make a later source action impossible. This is a consistency check, never permission to execute the later act, invent a prerequisite or alter what the current beat actually does.",
  "A prerequisite for a later beat may be established by an intervening beat; it need not already hold now. Evaluate the ordered chain of state changes rather than making every future action immediately executable. For example, Toto hiding leaves him under the bed and not in Dorothy's arms; a later retrieval remains possible without pretending she has already reached for or caught him. If a later action conflicts with a proposed state, revisit the source and beat boundaries instead of silently manufacturing a bridge.",
  "POSTCONDITION AUDIT: before returning the index, compare every resultingState with its own action, all earlier beats and the next beat. Every newly changed fact must follow from the current action or its direct involuntary consequence. Another character may be affected by this action, but must not independently start reaching, moving, speaking, deciding or helping inside this postcondition; give that source-backed act a separate beat.",
  "Preserve already-established facts about other characters when relevant; do not erase them merely because they are not the current actor. If a newly changed fact requires an unindexed action, repair the beat sequence first and recompute subsequent states. Never invent the missing act from book familiarity, and never delete a real source action simply to make a postcondition fit.",
  "Boundary example: 'Toto jumps from Dorothy’s arms and hides under the bed; Dorothy starts trying to retrieve him; Aunt Em descends; Dorothy catches Toto' contains four separate actor/action moments. Toto's hiding beat ends with 'Toto is under the bed; Dorothy is no longer holding him.' Dorothy starting retrieval is the next intentional beat, not part of Toto's state. Catching Toto later is distinct from starting retrieval earlier.",
  "resultingState must preserve source-backed physical boundaries and unfinished movement when they matter for what can happen next: who is where, who holds or carries whom, which doors or passages are open, and whether a destination has or has not yet been reached. Never advance the state into the next beat or infer a future outcome.",
  "Keep each beat action source-bounded. Describe the furthest concrete point reached before the next ordered beat begins, including source-backed position, possession, posture, or interaction state when those details constrain the next beat.",
  "Never let a beat wording imply that a destination, transition, rescue, attack, conversation, or other process finishes when the cited source interrupts it first. Preserve the intermediate endpoint instead.",
  "DECISION SPLIT: catching Toto and starting to follow Aunt Em are separate atomic beats even if they share one sentence. The catch ends with Toto held, before movement toward the cellar. The following beat ends where the source interrupts the crossing. Overlapping source references are allowed; never invent a pause or extra event.",
  "GROUP CONSISTENCY AUDIT: derive choiceText and completion from the whole group's selected beats and endpoint, never from an unperformed later goal. Ordinary NPC interleaving is not an interruption of an unchanged player goal. In the sequence start retrieving, NPC descends, catch, follow: separate catch from follow as atomic beats, group start and catch across the automatic descent, and leave follow for the next choice. Apply the same goal-boundary rule to every actor and action category. Do not mark an unchanged goal as a new decision merely because another actor acted in between.",
  "PLAYER ACTION STRUCTURE: attach playerAction only to a beat with a non-null actor, agency=intentional and stakes=significant or critical. Set it to null on routine, involuntary, external or ambiguous beats. Number indexes from zero independently in EACH event (not chapter-wide, not source line numbers). playerBeatIndexes starts with the index of the annotated beat, is strictly increasing and lists only this actor's intentional significant/critical beats. Include every such beat within the window; other actors and automatic/routine beats can occur inside the window but must not be listed. endBeatIndex is at least the last listed index and smaller than this event's beat count. Never cross a decisionBoundaryBefore for this actor. Check these constraints after assembling each event.",
  "PLAYER ACTIONS, SECOND PASS: after establishing the full atomic timeline, identify coherent player goals throughout every supplied source section, for every actor and every type of intentional meaningful action. Include physical help/rescue, retrieval, travel, investigation, practical tasks, social acts, questions and their NPC answers, and any other source-backed goal. This is not a retrieval-only feature. Annotate playerAction at each goal's first meaningful beat; use null on continuations/automatic acts or when the relationship is uncertain. Single-player-beat goals may include automatic consequences or an NPC reply.",
  "playerAction has kind player_action; choiceText expresses the complete selected goal in first-person/imperative wording without guaranteeing success. playerBeatIndexes lists every meaningful intentional act by this actor in the group, as absolute zero-based indexes in this event. endBeatIndex is the final included beat, which may be an NPC answer or automatic consequence. completion is the source-backed endpoint. boundaryReason explains why this action ends there. preconditions are established knowledge, capability and access requirements. interruptWhen lists concrete changes requiring fresh input, not events to invent.",
  "DECISION BOUNDARIES: set decisionBoundaryBefore on a meaningful player beat that starts a new goal, accepts a commitment, chooses a materially different method/risk/cost, or responds to relevant new information. Use null on continuations of the same selected goal. A question authorizes its answer, never an information-dependent next question, agreement or betrayal. Travelling to a chosen destination may include ordinary movement and arrival, never deciding what to do there. Oiling and freeing a companion may complete one rescue; agreeing to travel together is separate. Retrieving Toto may include Aunt Em descending and the catch, but following Aunt Em is a new goal. Resolve the bounded whole goal, not merely its first verb; do not group whole conversations, journeys with new decisions, or entire significant events by default.",
  "Use actor, target, goal, means, costs and information to judge continuity, not word overlap or adjacency. A target can legitimately change between constituent steps of one explicit goal (take the oil can, then oil the companion); such a change alone neither grants nor denies consent. Keep groups within one source event and source section; choose event boundaries after inspecting the local action chain, so NPC interleaving alone does not fragment an otherwise coherent action. Never merge/reorder atomic evidence. At ambiguity retain a conservative decision boundary.",
  "A beat must also describe one contiguous moment in the source. Never combine two actions from the same actor into one beat when another beat, another actor's action, dialogue, or a distinct intervening occurrence happens between them. Split the earlier and later actions into separate beats even when their actor, agency, stakes, or purpose are the same.",
  "A beat description must not pull a later action backward merely because it belongs to the same actor or causal episode. For example, if Aunt Em drops her work, then orders Dorothy to the cellar, Toto hides, and only afterward Aunt Em opens the trapdoor, 'drops her work' and 'opens the trapdoor' are separate beats with the intervening actions ordered between them.",
  "Order beats strictly by when they happen in the narrative present and by causal dependency. A prerequisite or cause must appear before the reaction, discovery, decision, or consequence that depends on it. Never put an earlier world event after a later character reaction merely because the character reaction is more important to gameplay.",
  "When chronology and causal grouping compete, preserve the observable source chronology. Never reorder a later physical action ahead of intervening source actions merely to keep one character's related actions adjacent.",
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
  "Split events at a genuinely new goal or commitment after an independently complete occurrence. An intervening NPC act alone is not a new decision when the same clearly source-backed player goal continues; retain those separate atomic beats in one event for the player-action second pass. An interruption introducing a meaningful new choice still ends the event.",
  "Do not omit a causally necessary event merely because it also appears in actions or the summary.",
  "Record explicit or strongly evidenced relationships between two indexed characters. Describe the relationship in neutral third-person language.",
  "Every beat actor, beat target, action actor, action target, and relationship participant must exactly match a name or alias in the same SOURCE_ID's characters array.",
  "Attach one or more exact line ranges from LINE_NUMBERED_TEXT to every significant event, event beat, character, action, and relationship. The event-level references must collectively cover its beats. Reuse only visible line numbers and never invent or widen evidence.",
  "For each individual beat, use the narrowest contiguous line range that supports that beat itself. Do not copy a broad event-level range onto every beat when it also contains later or intervening beats. Separate beats may reference the same source line only when that one line genuinely contains both atomic moments.",
  "The ordering of beat source references must agree with the beat array: excluding genuinely simultaneous actions, a later beat must not be supported only by text that occurs before an earlier beat, and one beat must not span across the source evidence for intervening beats.",
  "Preserve chronology and distinguish story events from introductions, notes, and other front or back matter.",
  "For non-story material, briefly identify its contents and return empty significant event, character, action, and relationship arrays.",
  "Do not infer unsupported identities, actions, relationships, or source references.",
  "Do not reproduce long passages or distinctive prose from the source.",
] as const;

export async function requestChapterSourceIndexes(
  createResponse: CreateAnalysisResponse,
  model: string,
  book: ImportedBook,
  parts: ChapterAnalysisPart[],
  batchNumber: number,
  attempt: number,
  previousValidationErrors: Map<string, string>,
  repairCache: PlayerActionRepairCache = new Map(),
  log: (message: string) => void = () => {},
  sourceRetryCache: Map<string, Record<string, unknown>> = new Map(),
): Promise<{
  indexes: Map<string, ChapterPartSourceIndex>;
  invalidParts: ChapterAnalysisPart[];
  validationErrors: Map<string, string>;
}> {
  const validationFeedback = [...previousValidationErrors]
    .map(([sourceId, message]) => `${sourceId}: ${message}`)
    .join("; ");
  const generationParts = parts.filter(part => !repairCache.has(part.sourceId));
  const previousCandidates = Object.fromEntries(generationParts.flatMap(part => {
    const previous = sourceRetryCache.get(part.sourceId);
    return previous ? [[part.sourceId, previous]] : [];
  }));
  const response = generationParts.length ? await createResponse({
    model,
    reasoning: { effort: "low" },
    instructions: [
      ...CHAPTER_SOURCE_INDEX_INSTRUCTIONS,
      ...(Object.keys(previousCandidates).length ? ["SOURCE REPAIR: a previous unvalidated candidate is included below. Correct the reported source errors against LINE_NUMBERED_TEXT and return the complete corrected sections. Preserve all other source-backed evidence and chronology; do not regenerate unrelated events. Previous candidates are not evidence: verify all changes against the source. For a rejected character name, use the actual locally attested name or stable identifying description and update its references consistently. Do not invent an alias or add an adaptation/book-familiarity name just to satisfy validation."] : []),
      `Use the main language of the supplied book and keep each summary under ${MAX_CHAPTER_SUMMARY_WORDS} words.`,
      validationFeedback
        ? `The previous result failed validation. Correct these errors: ${validationFeedback}`
        : "",
    ].filter(Boolean).join("\n"),
    input: [
      `BOOK: ${book.title}`,
      book.author ? `AUTHOR: ${book.author}` : "",
      "",
      ...generationParts.map(formatAnalysisPart),
      ...(Object.keys(previousCandidates).length ? [`PREVIOUS UNVALIDATED CANDIDATES:\n${JSON.stringify(previousCandidates)}`] : []),
    ].filter(Boolean).join("\n\n"),
    text: {
      format: {
        type: "json_schema",
        name: "bookrpg_chapter_source_index",
        strict: true,
        schema: chapterSourceIndexSchema(generationParts),
      },
    },
    max_output_tokens: chapterSourceOutputTokenLimit(generationParts, attempt),
  }) : undefined;

  const raw: unknown = response ? JSON.parse(requireOutputText(response, `chapter source index batch ${batchNumber}`)) : {};
  if (!isRecord(raw)) throw new Error("OpenAI returned an invalid chapter source index object");
  // Check generated IDs before adding cached sections.
  parseChapterSourceIndexes(JSON.stringify(raw), generationParts, batchNumber);
  for (const part of parts) {
    const cached = repairCache.get(part.sourceId);
    if (cached) raw[part.sourceId] = cached.raw;
  }
  const result = parseChapterSourceIndexes(JSON.stringify(raw), parts, batchNumber);
  // Semantically rejected metadata can be structurally valid. Route it through the
  // same immutable-source repair path without asking for a new chapter candidate.
  for (const part of parts) {
    if (repairCache.get(part.sourceId)?.eventsToRepair?.size && result.indexes.delete(part.sourceId)) {
      result.invalidParts.push(part);
    }
  }
  for (const part of [...result.invalidParts]) {
    const candidate = raw[part.sourceId];
    if (!isRecord(candidate)) continue;
    const sourceCheck = sourceWithoutPlayerActions(candidate, part);
    if (!sourceCheck.index) {
      // A grouping error may have masked a later source error in the first parser pass.
      // Feed the actual source blocker to the next attempt, along with this candidate.
      repairCache.delete(part.sourceId);
      result.validationErrors.set(part.sourceId, `Source validation failed before action repair: ${sourceCheck.error}`);
      sourceRetryCache.set(part.sourceId, candidate);
      continue;
    }
    const base = sourceCheck.index;
    sourceRetryCache.delete(part.sourceId);
    const cachedRepair = repairCache.get(part.sourceId) ?? {raw: candidate};
    repairCache.set(part.sourceId, cachedRepair);
    log(`Repairing player actions for ${part.sourceId}; validated source beats are preserved...`);
    try {
      await repairPlayerActions(createResponse, model, part, candidate, base,
        CHAPTER_SOURCE_INDEX_INSTRUCTIONS, previousValidationErrors.get(part.sourceId) ?? result.validationErrors.get(part.sourceId) ?? "Invalid grouping", cachedRepair.eventsToRepair);
      const checked = parseChapterSourceIndexes(JSON.stringify({[part.sourceId]: candidate}), [part], batchNumber);
      const repaired = checked.indexes.get(part.sourceId);
      if (!repaired) throw new Error(checked.validationErrors.get(part.sourceId));
      result.indexes.set(part.sourceId, repaired);
      result.invalidParts = result.invalidParts.filter(p => p.sourceId !== part.sourceId);
      result.validationErrors.delete(part.sourceId);
      repairCache.delete(part.sourceId);
    } catch (error) {
      result.validationErrors.set(part.sourceId, `Source beats preserved (${previousValidationErrors.get(part.sourceId) ?? result.validationErrors.get(part.sourceId) ?? "Invalid grouping"}); action repair failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [id, index] of result.indexes) {
    sourceRetryCache.delete(id);
    if (index.significantEvents.some(event => event.beats.some(beat => !beat.resultingState?.trim()))) {
      result.indexes.delete(id);
      const part = parts.find(part => part.sourceId === id)!;
      result.invalidParts.push(part);
      result.validationErrors.set(id, "Every generated beat requires a non-empty source-backed resultingState.");
      if (isRecord(raw[id])) sourceRetryCache.set(id, raw[id]);
      continue;
    }
    try {
      log(`Reviewing player action groups for ${id}...`);
      await reviewPlayerActionGroups(createResponse, model, parts.find(p => p.sourceId === id)!, index);
    } catch (error) {
      result.indexes.delete(id);
      result.invalidParts.push(parts.find(p => p.sourceId === id)!);
      result.validationErrors.set(id, error instanceof Error ? error.message : String(error));
      if (isRecord(raw[id])) {
        if (error instanceof PlayerActionReviewRejection && error.issues.some(issue => issue.repairTarget === "source")) {
          repairCache.delete(id);
          sourceRetryCache.set(id, raw[id]);
        } else {
          // Malformed/unavailable verdicts retry the review, never regenerate good evidence.
          repairCache.set(id, {raw: raw[id], eventsToRepair: new Set(error instanceof PlayerActionReviewRejection
            ? error.issues.map(issue => issue.eventIndex) : [])});
        }
      }
    }
    if (result.indexes.has(id)) repairCache.delete(id);
  }
  return result;
}

