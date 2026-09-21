import {sourceReferenceKey} from '../../books/source-index/chapter-index.js';
import type {AiResponse, AiResponseRequest} from '../provider.js';
import type {SourceContinuationCandidate} from './core.js';
import type {TurnContract} from './turn-contract.js';

/** Match source wording across EPUB line wrapping; return the original source span.
 * Never normalize words, case, punctuation, omissions or passage boundaries.
 */
function originalSourceQuote(quote: string, passages: readonly string[]): string | undefined {
  const words = quote.trim().split(/\s+/u);
  if (!quote.trim()) return undefined;
  const pattern = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'u');
  for (const passage of passages) {
    const match = pattern.exec(passage);
    if (match) return match[0];
  }
  return undefined;
}

/** Only an opening may establish initial circumstances from book evidence. */
export async function openingSourceFacts(contract: TurnContract, candidates: readonly SourceContinuationCandidate[],
  model: string, call: (label: string, request: AiResponseRequest) => Promise<AiResponse>) {
  if (contract.mode !== 'opening') return null;
  const candidate = candidates.find(c => c.requiredEventId === contract.eventId || c.currentStoryEvent?.eventId === contract.eventId);
  if (!candidate) return null;
  const indexes = [...new Set([...contract.allowedPlayerBeatIndexes, ...contract.requiredAutomaticBeatIndexes,
    ...(contract.nextPlayerDecision === null ? [] : [contract.nextPlayerDecision])])].sort((a,b) => a-b);
  const passages = [...new Set(indexes.flatMap(i => {
    const beat = contract.beats[i];
    const prelude = (beat as typeof beat & {automaticPreludeSourceExcerpt?: string})?.automaticPreludeSourceExcerpt;
    return [...(prelude?.trim() ? [prelude] : []), ...(beat?.sourceReferences ?? [])
      .flatMap(ref => candidate.sourceReferenceExcerpts?.[sourceReferenceKey(ref)] ? [candidate.sourceReferenceExcerpts[sourceReferenceKey(ref)]!] : [])];
  }))];
  if (!passages.length) return null;
  const string = {type: 'string'};
  const response = await call('opening source context', {model, reasoning: {effort: 'low'}, max_output_tokens: 1800,
    instructions: [
      'Extract only pre-existing physical circumstances needed to stage the opening immediately BEFORE the authorized window: locations, participants and available objects. Return zero to twelve short facts, each with a verbatim quote from exactly one supplied passage.',
      'Source passages may contain future actions. Those actions and their resulting states are NOT starting facts. Never execute a pending decision or infer availability from a later arrival, retrieval, acquisition or transfer. Distinguish an ongoing state (holding an object already) from an action that establishes it (picking it up).',
      'Use only explicit source evidence. Character biography, action requirements and common knowledge cannot fill a gap. Do not invent where the viewpoint character stands. A static fact is not a movement, perception, decision or completion credit. Omit unsupported facts rather than guessing.',
      'Keep named participants distinct. Return missing requirements in unresolved, never a conditional fact such as if the target is available. No scene prose or plot continuation.',
    ].join('\n'),
    input: JSON.stringify({player: contract.player, priorContext: JSON.parse(contract.contextJson),
      authorizedWindow: indexes.filter(i => i !== contract.nextPlayerDecision).map(i => ({actor: contract.beats[i]?.actor, action: contract.beats[i]?.action})),
      pendingDecision: contract.nextPlayerDecision === null ? null : contract.beats[contract.nextPlayerDecision], passages}),
    text: {format: {type: 'json_schema', name: 'bookrpg_opening_source_context', strict: true, schema: {
      type: 'object', additionalProperties: false, properties: {
        facts: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {fact: string, quote: string}, required: ['fact','quote']}},
        unresolved: {type: 'array', items: string},
      }, required: ['facts','unresolved']} }},
  });
  if (response.status !== 'completed') throw new Error('Incomplete opening source context');
  const value = JSON.parse(response.output_text);
  if (!Array.isArray(value?.facts) || value.facts.length > 12 || !Array.isArray(value.unresolved)
    || !value.unresolved.every((x: unknown) => typeof x === 'string')
    || !value.facts.every((f: any) => f && typeof f.fact === 'string' && f.fact.trim() && typeof f.quote === 'string'
      && f.quote.trim())) throw new Error('Opening context contains invalid or ungrounded evidence');
  const facts = value.facts.map((f: {fact: string; quote: string}, index: number) => {
    const quote = originalSourceQuote(f.quote, passages);
    if (quote === undefined) throw new Error(`Opening context fact ${index + 1} has an ungrounded quotation (wording differs from supplied passages)`);
    return {fact: f.fact, quote};
  });
  // Review receives the same evidence: an exact quote alone does not certify its interpretation.
  return {facts: facts as Array<{fact: string; quote: string}>, unresolved: value.unresolved as string[], passages};
}

export const ACTOR_OBSERVATION_POLICY = 'ACTOR EVIDENCE: distinguish observing another actor from performing that actor\'s action. "I see Morgan watching the sky" attributes watching the sky to Morgan; it does not by itself perform the player\'s pending deliberate sky observation. Evaluate the whole sentence and its grammatical actor, not matching verbs or objects. To reject an unselected action, quote a complete exact sentence from candidate_scene.text, identify who performs which action, and relate it to the pending decision. Never elide an intervening actor in a quote. Directly narrating the player beginning a pending deliberate observation, movement, speech or decision still violates the boundary. Do not infer that every first-person perception is a deliberate indexed action.';

export const PLAYED_HISTORY_POLICY = "STATE PRECEDENCE: played scenes and established game history supersede outdated character-profile descriptions of relationships, encounters, possessions and development. A biography saying two characters have not met cannot invalidate their meeting already established in play. Preserve stable character capabilities and world rules; history precedence is not permission to invent events or discard those rules.";
