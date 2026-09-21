import {NEXT_DECISION_READINESS_POLICY, pendingDecisionContext, reviewNextDecisionReadiness} from './next-decision-readiness.js';
import {acceptedEntryHistory, ACCEPTED_ENTRY_HISTORY_POLICY} from './accepted-entry-history.js';
import {openingSourceFacts, ACTOR_OBSERVATION_POLICY, PLAYED_HISTORY_POLICY} from './opening-frame.js';
import {normalizeSceneDeaths, SCENE_DEATH_POLICY} from '../../shared/scene-deaths.js';
import type { GameState, Scene, StoryMemory } from '../../shared/contracts.js';
import type { AiResponse, AiResponseRequest } from '../provider.js';
import { sceneJsonSchema } from '../schema.js';
import type { SourceContinuationCandidate } from './core.js';
import { SceneGenerationError } from './core.js';
import { generateParallelBeatScene } from './parallel-beat-scene.js';
import { rewriteBeatSceneRequest, rewrittenSceneReviewRequest, decodeRewrittenSceneReview } from './rewrite-beat-scene.js';
import { buildTurnScript } from './turn-script.js';
import type { TurnContract } from './turn-contract.js';
import { validateTurnEvidence } from './turn-validator.js';
import { sceneLeaksInternalMetadata } from './scene-text.js';
import { filterSceneScope, sceneScopeFailures, playerScopeAliases, sceneNonInteractableCharacters } from './scene-validation.js';

export function canonicalBeatSceneEligible(contract: TurnContract): boolean {
  const indexes = [...contract.allowedPlayerBeatIndexes, ...contract.requiredAutomaticBeatIndexes];
  // The staged route executes a saved canonical value or a purely automatic turn.
  // Free-text/dialogue goal resolution keeps the existing grounded-interruption route.
  const pinned = Boolean(contract.sourceBeatSelection) || contract.mode === 'opening' || contract.mode === 'observe' || contract.mode === 'source_continue';
  return pinned && contract.sourceProgression === 'required' && Boolean(contract.eventId) && (indexes.length > 0 || (contract.mode === 'opening' && Number.isInteger(contract.nextPlayerDecision)))
    && indexes.every(i => Boolean(contract.beats[i]?.resultingState?.trim()));
}

type Draft = Pick<Scene, 'title' | 'text' | 'sceneScope' | 'outcome' | 'outcomeReason' | 'peopleKilledInScene'> & {storyMemory: StoryMemory};
const metadataFields = ['peopleKilledInScene', 'sceneScope', 'outcome', 'outcomeReason', 'storyMemory'] as const;
const productionChecks = ['continuity', 'authorization', 'worldRules', 'sceneScope', 'storyMemory', 'outcome', 'nextDecisionSetup'] as const;
const checkSchema = {type: 'object', additionalProperties: false,
  properties: {status: {type: 'string', enum: ['pass', 'fail', 'uncertain']}, reason: {type: 'string'}}, required: ['status', 'reason']};
const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
function decodeDecisionSetup(response: AiResponse): string {
  if (response.status !== 'completed') {
    throw new Error(`Incomplete next-decision setup: ${JSON.stringify(response.incomplete_details)}`);
  }
  const value = JSON.parse(response.output_text);
  if (!value || Object.keys(value).length !== 1 || typeof value.text !== 'string' || !value.text.trim()) {
    throw new Error('Invalid next-decision setup');
  }
  return value.text.trim();
}

function nextDecisionSetupRequest(
  script: ReturnType<typeof buildTurnScript>,
  evidence: {sourceExcerpt: string; endState: string},
  model: string,
  pendingDecision: ReturnType<typeof pendingDecisionContext>,
  visibleHistory: ReturnType<typeof acceptedEntryHistory>,
): AiResponseRequest {
  const last = script.ordered_execution.at(-1);
  return {
    model,
    reasoning: {effort: 'low'},
    max_output_tokens: 1200,
    instructions: [
      NEXT_DECISION_READINESS_POLICY,
      'Produce one compact factual setup block immediately BEFORE the pending next player decision.',
      'Use only source_excerpt, indexed_end_state, ordered_end_state and next_decision. The excerpt may overlap completed actions: never replay or restate their execution.',
      'Extract only the still-relevant visible circumstance, stimulus, arrival, threat, question, accusation, object availability or spatial fact needed to make next_decision understandable and ready to begin.',
      'Do not perform, begin, answer or paraphrase next_decision itself. Do not add later source events, choices, intentions, memories, atmosphere or dialogue beyond a source-attested stimulus that must already be visible.',
      'When all source actions in the excerpt are already complete, state the resulting current circumstance rather than narrating those actions again.',
      'Return one to three plain third-person factual sentences. A nonempty block is required whenever setup evidence exists.',
    ].join('\n'),
    input: JSON.stringify({
      ordered_end_state: last?.resulting_state ?? script.source_start_state,
      completed_actions: script.ordered_execution.map(beat => ({
        beat_index: beat.beat_index,
        actor: beat.actor,
        action: beat.do,
        resulting_state: beat.resulting_state,
      })),
      next_decision: script.next_decision,
      pending_decision: pendingDecision,
      current_scene: script.story_so_far.current_scene,
      accepted_scene_history: visibleHistory,
      source_excerpt: evidence.sourceExcerpt,
      indexed_end_state: evidence.endState,
    }),
    text: {format: {type: 'json_schema', name: 'bookrpg_next_decision_setup', strict: true, schema: {
      type: 'object', additionalProperties: false,
      properties: {text: {type: 'string', minLength: 1}},
      required: ['text'],
    }}},
  };
}

function decodeDraft(response: AiResponse): Draft {
  if (response.status !== 'completed') throw new Error(`Incomplete canonical rewrite: ${JSON.stringify(response.incomplete_details)}`);
  const v = JSON.parse(response.output_text);
  if (!v || Object.keys(v).some(k => !['title', 'text', ...metadataFields].includes(k))
    || ['title', 'text'].some(k => typeof v[k] !== 'string' || !v[k].trim())
    || !v.sceneScope || typeof v.sceneScope.currentLocation !== 'string' || !v.sceneScope.currentLocation.trim()
    || !stringArray(v.sceneScope.peoplePresent) || !stringArray(v.sceneScope.peopleWithinSpeakingDistance)
    || !['active', 'won', 'completed', 'lost'].includes(v.outcome) || typeof v.outcomeReason !== 'string'
    || !v.storyMemory || typeof v.storyMemory.summary !== 'string' || v.storyMemory.summary.length > 900
    || !stringArray(v.storyMemory.openThreads) || v.storyMemory.openThreads.length > 6
    || !stringArray(v.storyMemory.canonFacts) || v.storyMemory.canonFacts.length > 12) throw new Error('Invalid canonical scene metadata');
  return v;
}

/** Production writer: content review is optional; readiness of the next decision is not. */
export async function generateCanonicalBeatScene(
  state: GameState, contract: TurnContract, candidates: readonly SourceContinuationCandidate[],
  models: {beat: string; rewrite: string; review?: boolean}, call: (label: string, request: AiResponseRequest) => Promise<AiResponse>,
) {
  if (!canonicalBeatSceneEligible(contract)) throw new Error('Canonical beat scene requires indexed resulting states');
  const script = buildTurnScript(contract);
  const pendingDecision = pendingDecisionContext(contract);
  const visibleHistory = acceptedEntryHistory(state);
  const openingEvidence = await openingSourceFacts(contract, candidates, models.rewrite, call);
  const nextDecisionSetupEvidence = contract.nextPlayerDecision === null ? null : (() => {
    const beat = contract.beats[contract.nextPlayerDecision] as typeof contract.beats[number] & {
      automaticPreludeSourceExcerpt?: string;
      automaticPreludeEndState?: string;
    };
    const sourceExcerpt = beat?.automaticPreludeSourceExcerpt?.trim();
    const endState = beat?.automaticPreludeEndState?.trim();
    return sourceExcerpt || endState
      ? {sourceExcerpt: sourceExcerpt ?? "", endState: endState ?? ""}
      : null;
  })();
  const constraints = {
    book: state.book, gameProfile: state.gameProfile, objective: state.objective, victoryCondition: state.victoryCondition,
    currentScene: script.story_so_far.current_scene, priorStoryMemory: state.storyMemory ?? null,
    establishedEvent: state.establishedEvent ?? null,
    characterRuntime: script.character_runtime_state, worldRules: script.active_world_rules,
    nextDecision: script.next_decision,
    pending_decision: pendingDecision,
    accepted_scene_history: visibleHistory,
    nextDecisionSetupEvidence,
    openingFrame: contract.mode === 'opening' && script.next_decision ? {
      evidence: openingEvidence,
      entryAction: script.next_decision.entry_action,
      targets: script.next_decision.targets,
      priorState: script.source_start_state,
      instruction: 'Set the scene immediately BEFORE this indexed action: establish its source-supported starting location and the relevant targets so it can begin. Targets of direct physical interaction must be visible and reachable by the action, without already performing it. A character being not yet acquainted or connected describes relationships, not physical absence. Do not substitute biography, an Unknown location, or waiting for a choice. Do not narrate approach, attack, dialogue, contact or success that belongs to entryAction.',
    } : null,
    unavailableCharacters: candidates.flatMap(c => c.unavailableCharacters ?? []),
  };
  // Line references can include future clauses. They are evidence for indexing,
  // not a safe prose/style sample: production rewriting receives semantic beats only.
  const style = {title: state.book.title, author: state.book.author ?? '',
    language: 'Keep the language of the current scene; for an opening use the book language.',
    guidance: 'First-person narration with the book’s tone and rhythm. Clear, concrete prose, natural dialogue, restrained imagery and varied sentences. Style supplies expression only, never plot, character knowledge or future events.',
    referenceExcerpt: ''};
  const setupOnly = script.ordered_execution.length === 0;
  const generatedPromise = setupOnly
    ? Promise.resolve({scene: {title: 'Opening', text: '', blocks: []}, failures: [], finalScope: undefined, scopeDeltas: []})
    : generateParallelBeatScene(contract, models.beat, 'low',
      (index, request) => call(`scene beat ${index}`, request), {
        maxBeats: 32,
        concurrency: 4,
        ...(state.scene.sceneScope
          ? {scopeContext: {playerName: state.playerName, sceneScope: state.scene.sceneScope}}
          : {}),
      });
  const nextDecisionSetupPromise = !setupOnly && nextDecisionSetupEvidence
    ? call('scene next decision setup', nextDecisionSetupRequest(script, nextDecisionSetupEvidence, models.beat, pendingDecision, visibleHistory))
      .then(decodeDecisionSetup)
    : Promise.resolve<string | null>(null);
  const [generated, nextDecisionSetupScaffold] = await Promise.all([generatedPromise, nextDecisionSetupPromise]);
  if (!generated.scene) throw new Error(generated.failures.map(f => f.error).join('; '));
  const bare = generated.scene;
  const request = rewriteBeatSceneRequest(contract, bare, style, models.rewrite);
  const schema = request.text!.format.schema as any;
  const rewriteRequest: AiResponseRequest = {...request, max_output_tokens: 4800,
    instructions: `${SCENE_DEATH_POLICY}\n${ACTOR_OBSERVATION_POLICY}\n${PLAYED_HISTORY_POLICY}\nMEMORY SNAPSHOTS: production.priorStoryMemory is the BEFORE state and may contain stale contradictions from older saves. candidate_scene.storyMemory is the complete proposed AFTER replacement. Judge the replacement against the actual scene and latest played history; do not require it to retain superseded positions, possessions or open/closed states. A storyMemory rejection must quote an offending fact from candidate_scene.storyMemory, not from priorStoryMemory. Preserve unchanged durable facts in the replacement.\nTRANSPORT: distinguish the moving carrier, its occupants, and the stationary origin. An excavated cellar, foundation, ground or dock is not part of a departing carrier merely because it was below or beside it. People sheltered there remain at the origin unless an authorized transition explicitly transports them. Check this in prose, sceneScope and memory together; use the ordered transitions and established physical setting, never future book events.\nOpening evidence may establish only pre-existing static circumstances, never future actions. Keep those circumstances until authorized transitions change them. Make necessary supported target availability visible in the scene; do not replace it with a conditional memory or infer it from a profile. Source quotations are evidence to interpret, not prose to copy.\n${request.instructions}${setupOnly ? "\nSETUP-ONLY OPENING: there are no authorized actions yet. Establish only the source-backed starting situation and relevant targets so the player can BEGIN nextDecision. Use a short static first-person opening, usually 60–120 words. Do not perform or start nextDecision, invent dialogue, attack, approach, or claim its resulting state. An empty execution window is intentional; no beat is completed." : ""}\nFor a short automatic window, one to three sentences may suffice; there is no minimum word count. Do not pad with repeated prior actions, distant character status or future observations. Physical transport moves only supported occupants, not every character previously nearby; update relative locations consistently across prose and metadata.\nProduction metadata: return sceneScope, outcome, outcomeReason and storyMemory along with title and text. These describe only what the scene and prior established state support. Use exact known names. Include the player in scope, remove departed/dead characters, and never infer presence from a profile. Do not add plot events to justify metadata. beat_scope_deltas records per-beat spatial changes and beat_final_scope is the server-reduced result after applying those deltas in ordered beat order. When beat_final_scope is non-null, copy its peoplePresent and peopleWithinSpeakingDistance membership into sceneScope exactly (canonical naming aside). Do not restore a character removed by an earlier beat merely because a later resulting state omits that departure or mentions a nearby connected place. storyMemory may retain where a separated character went, but must not describe them as colocated with the player.\nPreserve established game facts and world rules; a canonical index cannot override an existing injury, death or physical obstacle. Never invent success by erasing such a fact.\nnextDecision is a STOP boundary: keep it unperformed, but leave the conditions needed to begin its entry action visible. Do not require success or later group steps before selection.\nNEXT DECISION SETUP: next_decision_setup_scaffold is factual intermediate material extracted from production.nextDecisionSetupEvidence. When non-null, its concrete visible setup facts MUST appear in the rewritten scene after the ordered execution state and before the stop boundary. Integrate them naturally without replaying completed actions. Never perform nextDecision itself. production.nextDecisionSetupEvidence is grounding context only; do not retell the entire excerpt or import later clauses.\nUse gameProfile.endingMode, objective and victoryCondition to determine outcome; active unless an authorized event actually establishes a terminal outcome. storyMemory describes the CURRENT state. Replace superseded position, posture, possession, presence and open/closed facts after authorized changes; do not append incompatible snapshots as simultaneous canonFacts. Historical actions may remain explicitly past, but cannot recreate an obsolete current state. A transport departure changes relative locations: people left behind stay at the departure location, never beneath a vehicle at its new location. storyMemory: summary at most 900 characters, at most 6 openThreads and 12 canonFacts, retain established durable facts, no future actions.`,
    input: JSON.stringify({...JSON.parse(request.input),
      next_decision_setup_scaffold: nextDecisionSetupScaffold,
      beat_scope_deltas: generated.scopeDeltas ?? [],
      beat_final_scope: generated.finalScope ?? null,
      production: constraints}),
    text: {format: {...request.text!.format, name: 'bookrpg_canonical_rewrite', schema: {...schema,
      properties: {...schema.properties, ...Object.fromEntries(metadataFields.map(k => [k, sceneJsonSchema.properties[k]]))},
      required: [...schema.required, ...metadataFields]}}}};
  const rewriteRequestWithPolicies: AiResponseRequest = {...rewriteRequest,
    instructions: rewriteRequest.instructions
      + "\n" + NEXT_DECISION_READINESS_POLICY + "\n" + ACCEPTED_ENTRY_HISTORY_POLICY
      + "\nMEMORY OPEN THREADS: openThreads are unresolved concerns/goals, not canonFacts. They may retain an explicitly supplied current characterRuntime goal or fear, or a prior openThread, without the scene restating it word-for-word, provided played history does not contradict it and it does not reveal a future canonical event. summary and canonFacts remain grounded in played history and the candidate scene."};
  let draft!: ReturnType<typeof decodeDraft>;
  let review: ReturnType<typeof decodeRewrittenSceneReview> | null = null;
  let resolvedSceneScope: NonNullable<ReturnType<typeof decodeDraft>['sceneScope']>;
  let repairFeedback: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptRequest = attempt === 0 ? rewriteRequestWithPolicies : {...rewriteRequestWithPolicies,
      input: JSON.stringify({...JSON.parse(rewriteRequestWithPolicies.input), repair: {failures: repairFeedback, rejectedScene: draft}}),
      instructions: rewriteRequestWithPolicies.instructions + "\nREPAIR: explicitly resolve every listed failure in the visible prose and consistent metadata. A conditional statement or removal of a memory claim does not establish missing physical setup. Use openingFrame evidence for missing starting circumstances; never invent them. Replace the rejected scene and all metadata using the listed review failures. The rejected draft is not established history. Preserve the authorized window; do not advance the cursor or complete the next decision. Remove unsupported co-travel and superseded relative locations from prose, scope and memory together. Do not repeat already-completed scenes to fill space."};
    draft = decodeDraft(await call(attempt ? 'scene rewrite repair' : 'scene rewrite', attemptRequest));
    draft.peopleKilledInScene = normalizeSceneDeaths(draft.peopleKilledInScene, state.characterProfiles);
    if (sceneLeaksInternalMetadata(draft.title, draft.text)) throw new Error('Canonical scene exposed internal metadata');
    resolvedSceneScope = draft.sceneScope!;
    if (models.review !== false || draft.peopleKilledInScene.length > 0) {
      const baseReview = rewrittenSceneReviewRequest(contract, bare, draft, models.rewrite);
      const reviewSchema = baseReview.text!.format.schema as any;
      let reviewRequest: AiResponseRequest = {...baseReview, max_output_tokens: Math.max(4800, bare.blocks.length * 500 + 1600),
        instructions: `${SCENE_DEATH_POLICY}\n${ACTOR_OBSERVATION_POLICY}\n${PLAYED_HISTORY_POLICY}\nMEMORY SNAPSHOTS: production.priorStoryMemory is the BEFORE state and may contain stale contradictions from older saves. candidate_scene.storyMemory is the complete proposed AFTER replacement. Judge the replacement against the actual scene and latest played history; do not require it to retain superseded positions, possessions or open/closed states. A storyMemory rejection must quote an offending fact from candidate_scene.storyMemory, not from priorStoryMemory. Preserve unchanged durable facts in the replacement.\nTRANSPORT: distinguish the moving carrier, its occupants, and the stationary origin. An excavated cellar, foundation, ground or dock is not part of a departing carrier merely because it was below or beside it. People sheltered there remain at the origin unless an authorized transition explicitly transports them. Check this in prose, sceneScope and memory together; use the ordered transitions and established physical setting, never future book events.\nReview the interpretation of openingFrame evidence against its passages: only pre-existing static circumstances may supplement the authorized actions. Reject future results disguised as initial facts. On repair, reassess each previous_review_failure explicitly in the corresponding productionChecks reason. Missing target availability is not resolved by if available or deleting it from memory. Earlier verdicts are not authoritative; explain any changed assessment using the complete actual sentence and actor.\nReview peopleKilledInScene under continuity: reject unsupported deaths or omitted actual deaths.\n${baseReview.instructions}\nAlso assess every productionChecks field using candidate_scene as evidence and production as constraints. continuity: preserve established state and avoid replaying prior completed actions. authorization: apply the shared meaningful-action policy above; distinguish incidental realization from material extra actions. Never authorize nextDecision or invented commands. This includes the first physical or observational step of a future anchor, even when it looks routine (sitting up, looking, noticing). Automatic waking does not authorize a separate indexed voluntary movement or observation. Do not demand that future action as setup for itself. Keep necessary involuntary effects and incidental posture physically caused by an authorized action valid. worldRules: obey supplied rules and character capabilities (including speech); canonical completion cannot excuse a violation. sceneScope: derive resolvedSceneScope from the actual prose and established context, correcting candidate metadata when needed. Use the least specific supported location, never invent a room from an object such as a bed. Include every confirmed present character and established conversational reach. A mismatch in candidate metadata alone is repairable and is not a scene rejection. Return pass only if resolvedSceneScope is grounded; ambiguity or contradictions in the actual prose remain fail/uncertain. Do not change the prose, infer an arrival/departure, or use metadata correction to excuse failed beats or states. storyMemory: only supported facts, retain durable facts, no invented history. At a transport or location transition, distinguish occupants of the moving carrier from people at the stationary origin. Prior relative proximity does not prove co-travel. Check currentLocation, peoplePresent, summary, openThreads and canonFacts against the visible transition together; reject stale relative locations or unsupported co-travel in prose or memory, even when copied from prior turns. Do not invent remote activity or current knowledge of offscreen characters. outcome: supported by the actual scene and endingMode/objective/victoryCondition. nextDecisionSetup: when present, the entry action must be possible from the final state without already being performed; do not require its future completion. When absent return pass. Missing or ambiguous evidence cannot pass. No rewrite, no choice generation.`,
        input: JSON.stringify({...JSON.parse(baseReview.input), candidate_scene: {...draft, sentences: JSON.parse(baseReview.input).candidate_scene.sentences}, production: constraints, previous_review_failures: repairFeedback}),
        text: {format: {...baseReview.text!.format, name: 'bookrpg_canonical_scene_review', schema: {...reviewSchema,
          properties: {...reviewSchema.properties, resolvedSceneScope: sceneJsonSchema.properties.sceneScope, productionChecks: {type: 'object', additionalProperties: false,
            properties: Object.fromEntries(productionChecks.map(k => [k, checkSchema])), required: productionChecks}},
          required: [...reviewSchema.required, 'productionChecks', 'resolvedSceneScope']}}}};
      reviewRequest = {...reviewRequest, instructions: reviewRequest.instructions
        + "\n" + NEXT_DECISION_READINESS_POLICY + "\n" + ACCEPTED_ENTRY_HISTORY_POLICY
        + "\nFor productionChecks.nextDecisionSetup, separately assess the source-backed visible cause of production.pending_decision.entry_action, using production.accepted_scene_history, production.currentScene and candidate_scene.text. A pass reason must identify the substance of the stimulus and quote or paraphrase its visible occurrence, or explicitly explain why this is a spontaneous action needing no external cause. A circular summary cannot pass. The broad choice label and later group completion do not redefine the immediate prerequisite."
        + "\nMEMORY OPEN THREADS: summary and canonFacts use only supported played facts, retain durable facts, and contain no invented history. openThreads may preserve explicitly supplied current characterRuntime goals/fears and prior openThreads without requiring them to be restated in candidate prose; reject them only when contradicted, falsely presented as completed/current physical facts, or when they leak unplayed future canon."
        + "\nSCENE SCOPE INVARIANT: every person in resolvedSceneScope.peopleWithinSpeakingDistance MUST also appear in resolvedSceneScope.peoplePresent; speaking distance logically implies physical presence."};
      const response = await call('scene content review', reviewRequest);
      review = decodeRewrittenSceneReview(bare, response);
      const parsedReview = JSON.parse(response.output_text);
      const checks = parsedReview.productionChecks;
      resolvedSceneScope = parsedReview.resolvedSceneScope;
      if (!resolvedSceneScope || typeof resolvedSceneScope.currentLocation !== 'string' || !resolvedSceneScope.currentLocation.trim()
        || !stringArray(resolvedSceneScope.peoplePresent) || !stringArray(resolvedSceneScope.peopleWithinSpeakingDistance)
        || resolvedSceneScope.peoplePresent.length > 16 || resolvedSceneScope.peopleWithinSpeakingDistance.length > 16
        || Object.keys(resolvedSceneScope).some(k => !['currentLocation', 'peoplePresent', 'peopleWithinSpeakingDistance'].includes(k)))
        throw new Error('Invalid resolved scene scope');
      // A reviewed conversational-reach claim is stronger than an accidental
      // omission from the reviewer's presence list. Normal filtering below
      // still removes unknown, dead or otherwise non-interactable characters.
      resolvedSceneScope = {
        ...resolvedSceneScope,
        peoplePresent: [
          ...resolvedSceneScope.peoplePresent,
          ...resolvedSceneScope.peopleWithinSpeakingDistance,
        ],
      };
      const failures = review.findings.map(f => `Beat ${f.beatIndex} ${f.dimension}: ${f.reason}`);
      if (review.finalState.status !== 'pass') failures.push(`Final state: ${review.finalState.reason}`);
      failures.push(...review.titleIssues);
      for (const field of productionChecks) {
        const check = checks?.[field];
        if (!check || !['pass', 'fail', 'uncertain'].includes(check.status) || typeof check.reason !== 'string' || !check.reason.trim()) throw new Error(`Invalid production review: ${field}`);
        if (check.status !== 'pass') failures.push(`${field}: ${check.reason}`);
      }
      if (failures.length) {
        if (attempt === 0) { repairFeedback = failures; continue; }
        const previousFailures = new Set(repairFeedback);
        const introducedNewFailure = failures.some(failure => !previousFailures.has(failure));
        const retainedOldFailure = failures.some(failure => previousFailures.has(failure));
        if (attempt === 1 && introducedNewFailure && !retainedOldFailure) {
          repairFeedback = failures;
          continue;
        }
        throw new SceneGenerationError(failures, attempt + 1);
      }
    } else {
      // The old fast path treated next-decision readiness as true without any
      // semantic check. Keep the content-review opt-out, not a causal-gate opt-out.
      // Reviewed mode already checks nextDecisionSetup above, so do not duplicate it.
      const failures = await reviewNextDecisionReadiness(
        state, contract, draft, models.rewrite, call, repairFeedback,
      );
      if (failures.length) {
        if (attempt < 2) { repairFeedback = failures; continue; }
        throw new SceneGenerationError(failures, attempt + 1);
      }
    }
    break;
  }
  const unavailable = sceneNonInteractableCharacters(state, draft, [...constraints.unavailableCharacters, ...(draft.peopleKilledInScene ?? [])]);
  const scopeOptions = {playerName: state.playerName, playerAliases: playerScopeAliases(state.playerName, state.characterProfiles),
    knownCharacterProfiles: state.characterProfiles, nonInteractableCharacters: unavailable};
  const beatResolvedSceneScope = generated.finalScope
    ? {
      currentLocation: resolvedSceneScope!.currentLocation,
      peoplePresent: generated.finalScope.peoplePresent,
      peopleWithinSpeakingDistance: generated.finalScope.peopleWithinSpeakingDistance,
    }
    : resolvedSceneScope!;
  const sceneScope = filterSceneScope(beatResolvedSceneScope, scopeOptions);
  const scopeFailures = sceneScopeFailures(sceneScope, scopeOptions);
  if (scopeFailures.length) throw new SceneGenerationError(scopeFailures, 1);
  const indexes = bare.blocks.map(b => b.beatIndex);
  const decision = validateTurnEvidence(contract, {completedSourceEventBeatIndexes: indexes,
    futureActionSetupRequired: contract.nextPlayerDecision !== null, futureActionSetupSupported: true,
    ...(contract.selectedPlayerAction ? {player_action_resolution: {status: 'completed', beforeBeatIndex: null, reason: review ? 'All authorized beats passed review.' : 'Authorized generated beat window accepted with content review disabled.', causeEstablished: false}} : {})});
  if (decision.status !== 'accepted') throw new SceneGenerationError(decision.findings.map(f => f.message), 1);
  return {scene: {...draft, sceneScope, choices: []} as Scene & {storyMemory: StoryMemory},
    completedBeatIndexes: [...decision.authorizedCompletedBeatIndexes], review, unavailable};
}

