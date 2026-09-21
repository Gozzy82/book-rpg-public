import type {GameState, Scene} from '../../shared/contracts.js';
import type {AiResponse, AiResponseRequest} from '../provider.js';
import type {TurnContract} from './turn-contract.js';
import {acceptedEntryHistory, ACCEPTED_ENTRY_HISTORY_POLICY} from './accepted-entry-history.js';

/** Shared by setup, rewrite and review. A menu label is never its own prerequisite. */
export const NEXT_DECISION_READINESS_POLICY = [
  'NEXT DECISION VISIBLE CAUSE: distinguish physical ability to act from the information or stimulus needed to understand the immediate entry action. An answer needs the substance of the question; a response to an accusation needs what the other person actually accused the player of. This applies even when the choice label is broad or indexed preconditions are empty.',
  'Circular readiness summaries such as "I was about to answer her accusation", "her words hung in the air", "we were confronting each other" or "the next decision is ready" do NOT show the substance of a question or accusation. A slap, mere presence or a character feeling ashamed is not a spoken accusation. Show concrete source-supported words or a substantive indirect paraphrase; exact book wording is unnecessary.',
  'Only candidate_scene.text, current_scene.text and accepted_scene_history scene prose prove a player-visible cause. Hidden memory, titles, choices, source excerpts, resulting-state summaries and setup scaffolds are NOT proof of what the player has seen. A scaffold can itself omit the necessary stimulus; copying its vague conclusion does not fix that omission.',
  'Judge pending_decision.entry_action first, not the eventual completion of its action group. A group label may cover denial followed by admission: only the cause of the FIRST unperformed act is required now. Do not pull a later accusation or answer forward past an unchosen player reply. Later prerequisites may arise during the chosen action. No future player action may be performed to make its own choice available.',
  'A spontaneous action does not need an invented question, invitation, declared intention or deliberation. Mark its cause not_required with an explanation when the visible situation already permits choosing it. Do not require every source remark or gesture. An earlier still-relevant visible cause carries forward without being repeated; a superseded, answered or unrelated earlier question does not.',
  'When writing setup, preserve only source-supported, still-relevant circumstances before the entry action. Necessary immediate NPC speech may supply the missing stimulus, but never invent an accusation from the menu label, perform an unselected player reply, repeat a completed act or import later dialogue. If the source omits the required cause, report missing grounding rather than inventing one.',
  'When reviewing nextDecisionSetup, pass only if the first action is understandable and can begin with its necessary visible cause already established, and the next action remains unperformed. Identify the actual substance and where it appears; not merely that an accusation/question exists. Missing or uncertain cause requires scene repair before a menu can be exposed.',
].join('\n');

export function pendingDecisionContext(contract: TurnContract) {
  const index = contract.nextPlayerDecision;
  if (contract.sourceProgression !== 'required' || index === null) return null;
  const beat = contract.beats[index] as (typeof contract.beats[number] & {automaticPreludeSourceExcerpt?: string}) | undefined;
  if (!beat) throw new Error('Pending decision has no indexed entry action');
  const origin = contract.nextPlayerDecisionOrigin ?? contract.beatOrigins?.[index];
  return {
    event_id: origin?.eventId ?? contract.eventId,
    source_beat_index: origin?.beatIndex ?? index,
    beat_index: index,
    entry_action: {actor: beat.actor, action: beat.action, targets: beat.targets,
      decision_boundary_before: beat.decisionBoundaryBefore ?? null},
    choice_label: contract.nextPlayerAction?.choiceText ?? beat.action,
    goal: contract.nextPlayerAction ? {completion: contract.nextPlayerAction.completion,
      boundary_reason: contract.nextPlayerAction.boundaryReason,
      indexed_preconditions: contract.nextPlayerAction.preconditions} : null,
    source_setup: {excerpt: beat.automaticPreludeSourceExcerpt ?? '',
      indexed_end_state: beat.automaticPreludeEndState ?? null},
  };
}

const text = {type: 'string', minLength: 1};
export const nextDecisionReadinessSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: {type: 'string', enum: ['pass', 'fail', 'uncertain']}, reason: text,
    causeStatus: {type: 'string', enum: ['present', 'not_required', 'missing']}, cause: text,
    nextActionUnperformed: {type: 'boolean'},
    evidence: {type: 'array', maxItems: 6, items: {
      type: 'object', additionalProperties: false,
      properties: {source: {type: 'string', enum: ['candidate_scene', 'current_scene', 'accepted_scene_history']},
        sceneIndex: {type: ['integer', 'null'], minimum: 0}, quote: text},
      required: ['source', 'sceneIndex', 'quote'],
    }},
  },
  required: ['status', 'reason', 'causeStatus', 'cause', 'nextActionUnperformed', 'evidence'],
};

function visibleContext(state: GameState, scene: Pick<Scene, 'title' | 'text' | 'sceneScope'>) {
  return {
    accepted_scene_history: acceptedEntryHistory(state),
    current_scene: {text: state.scene.text, sceneScope: state.scene.sceneScope},
    candidate_scene: {text: scene.text, sceneScope: scene.sceneScope},
  };
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim();

/** Checks response structure/provenance; semantic sufficiency is assessed by the reviewer. */
export function nextDecisionReadinessFailures(value: unknown, state: GameState,
  scene: Pick<Scene, 'title' | 'text' | 'sceneScope'>): string[] {
  const prefix = 'Next decision readiness: ';
  if (!record(value) || Object.keys(value).some(key => !nextDecisionReadinessSchema.required.includes(key))
    || !['pass', 'fail', 'uncertain'].includes(String(value.status))
    || !['present', 'not_required', 'missing'].includes(String(value.causeStatus))
    || !nonempty(value.reason) || !nonempty(value.cause)
    || typeof value.nextActionUnperformed !== 'boolean' || !Array.isArray(value.evidence)
    || value.evidence.length > 6) return [prefix + 'missing or malformed review; a general acceptance is not sufficient.'];
  const context = visibleContext(state, scene);
  const failures: string[] = [];
  for (const item of value.evidence) {
    if (!record(item) || Object.keys(item).some(key => !['source', 'sceneIndex', 'quote'].includes(key))
      || !nonempty(item.quote)) return [prefix + 'malformed visible-cause evidence.'];
    let source: string | undefined;
    if (item.source === 'accepted_scene_history' && Number.isInteger(item.sceneIndex) && Number(item.sceneIndex) >= 0)
      source = context.accepted_scene_history.scenes[Number(item.sceneIndex)]?.text;
    else if (item.sceneIndex === null && (item.source === 'current_scene' || item.source === 'candidate_scene'))
      source = context[item.source].text;
    if (!source || !normalized(source).includes(normalized(item.quote)))
      failures.push(prefix + 'the cited cause is absent from the identified visible scene; source/menu/memory text cannot prove it.');
  }
  if (value.causeStatus === 'present' && value.evidence.length === 0)
    failures.push(prefix + 'a present cause requires a grounded quotation showing its substance.');
  if (value.causeStatus === 'not_required' && value.evidence.length !== 0)
    failures.push(prefix + 'not_required must explain a spontaneous action, not supply contradictory cause evidence.');
  if (value.causeStatus === 'missing') failures.push(prefix + `missing visible cause: ${value.cause}. ${value.reason}`);
  if (!value.nextActionUnperformed) failures.push(prefix + `the next player action was performed before selection. ${value.reason}`);
  if (value.status !== 'pass') failures.push(prefix + `${value.status}: ${value.reason}`);
  return [...new Set(failures)];
}

/** Always used at a live decision boundary when the optional full content review is off. */
export async function reviewNextDecisionReadiness(
  state: GameState, contract: TurnContract, scene: Pick<Scene, 'title' | 'text' | 'sceneScope' | 'outcome'>,
  model: string, call: (label: string, request: AiResponseRequest) => Promise<AiResponse>,
  previousFailures: readonly string[] = [],
): Promise<string[]> {
  if ((scene.outcome ?? 'active') !== 'active') return [];
  const pending = pendingDecisionContext(contract);
  if (!pending) return [];
  const response = await call('scene next decision readiness review', {
    model, reasoning: {effort: 'low'}, max_output_tokens: 1800,
    instructions: [NEXT_DECISION_READINESS_POLICY, ACCEPTED_ENTRY_HISTORY_POLICY,
      'Review ONLY the readiness of pending_decision.entry_action and whether it remains unperformed. No style review, source progress accounting, rewriting, menu generation or world-state edits.',
      'Set causeStatus=present only when concrete visible prose gives the substance of the necessary stimulus. Quote exact contiguous prose in evidence, using null sceneIndex for candidate_scene/current_scene and a zero-based sceneIndex for accepted_scene_history. Whitespace differences are allowed. Explain the semantic match; a circular reference to an accusation is not the accusation itself.',
      'Use not_required with evidence=[] for an action that needs no external cause; explain why from its actual first step, not merely its broad menu label. missing or uncertainty cannot pass. Missing source setup does not waive the check or authorize inventing a stimulus.',
      'status=pass requires an understandable and executable first step, with a present or unnecessary cause and nextActionUnperformed=true. Do not require success or later group prerequisites. Reassess the replacement scene against previous_failures; earlier rejected prose is not accepted history.',
    ].join('\n'),
    input: JSON.stringify({player: contract.player, pending_decision: pending,
      ...visibleContext(state, scene), world_rules: contract.worldRules, previous_failures: previousFailures}),
    text: {format: {type: 'json_schema', name: 'bookrpg_next_decision_readiness', strict: true,
      schema: nextDecisionReadinessSchema}},
  });
  if (response.status !== 'completed') return ['Next decision readiness: incomplete review; do not expose the anchor.'];
  let verdict: unknown;
  try { verdict = JSON.parse(response.output_text); }
  catch { return ['Next decision readiness: invalid review JSON; do not expose the anchor.']; }
  return nextDecisionReadinessFailures(verdict, state, scene);
}
