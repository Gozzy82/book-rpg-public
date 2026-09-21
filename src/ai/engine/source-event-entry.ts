import {acceptedEntryHistory, ACCEPTED_ENTRY_HISTORY_POLICY} from './accepted-entry-history.js';
import {normalizeSceneDeaths, peopleKilledInSceneSchema, SCENE_DEATH_POLICY} from '../../shared/scene-deaths.js';
import {repairEntrySpeakingDistance} from './repair-entry-speaking-distance.js';
import {ACTION_ENTRY_PHASE_POLICY} from '../../shared/source-transition-policy.js';
import { CONVERSATIONAL_REACH_POLICY } from "../../shared/conversational-reach-policy.js";
import type { GameState, Scene, StoryMemory, StoryEventBeat } from '../../shared/contracts.js';
import type { SourceChoiceNavigationEvent } from './source-navigation.js';
import type { AiResponse, AiResponseRequest } from '../provider.js';
import { sceneJsonSchema } from '../schema.js';
import { SceneGenerationError, type SourceContinuationCandidate } from './core.js';
import { sceneLeaksInternalMetadata } from './scene-text.js';
import { sceneScopeFailures, playerScopeAliases } from './scene-validation.js';
import { buildCharacterRuntimeState } from './character-runtime.js';
import { playerControlsBeat } from '../../shared/turn-policy.js';
import { worldRulesForGame } from '../../shared/world-rules.js';

const policy = [
  SCENE_DEATH_POLICY,
  ACCEPTED_ENTRY_HISTORY_POLICY,
  CONVERSATIONAL_REACH_POLICY,
  ACTION_ENTRY_PHASE_POLICY,
  'Runtime entry assessment does not edit the index. Use entry_action.goal.boundaryReason to distinguish preparation within the pending goal from prerequisites of choosing it. Keep that preparation unperformed until selection; reject actual unavailable passengers, refusal or blocked access.',
  'MINIMUM NECESSARY SETUP: make the next choice understandable from what the player has seen. entry_source supplies evidence for missing setup, not a checklist of dialogue or gestures to narrate. Omit optional intervening remarks when the current scene already makes the first action understandable and executable. An empty transition is valid in that case. Do not demand a bridge merely because a source passage exists.',
  'VISIBLE CAUSE: a choice framed as replying to an accusation, answering a question, reacting to a threat or using newly learned information requires that motivating fact to be visible first. Supply a short source-supported setup if missing. A paraphrase or an already established equivalent confrontation suffices; exact source wording and every conversational turn are not required. Hidden memory or future source text alone cannot replace a missing player-visible cause. Judge only prerequisites of the immediate first action, not later dialogue in the event.',
  'CAUSAL EVIDENCE IS DISTINCT FROM ABILITY: inspect entry_source for the immediate stimulus to the pending action, even when the action label does not explicitly say reply or answer and indexedPreconditions is empty. If a source confession responds to an accusation, merely standing before the accuser or feeling ashamed is not an equivalent visible accusation. Show the substance of the accusation first. A character being able to speak does not satisfy this requirement. Do not invent a stimulus when the source action is spontaneous.',
  'SETUP SCOPE: keep the transition short and relevant to the immediate situation. missing_setup identifies gaps, not permission to retell the entire source. Source-supported connective player dialogue is allowed: warnings, observations and explanations may accompany travel or setup when consistent with the character’s established knowledge and capabilities. Such dialogue must not introduce a new decision, promise, commitment, command that changes the plan, attack, rescue, route choice, or perform a pending indexed action. Do not make harmless connective dialogue mandatory. A newly arriving threat needed for the next choice must still be visibly established; merely knowing its name is insufficient.',
  'CONNECTIVE DIALOGUE AND MEMORY: for example, during source-supported travel the verbal Lion may warn his companions that Kalidahs live in this forest, and the summary/canonFacts may remember that visibly spoken warning. It does not mean Kalidahs have arrived. The same warning is not automatic if warning them is itself the pending chosen action. A source-backed casual expression of fear is not automatically the pending confession of cowardice; compare the actual speech act and its consequences. Reject unsupported knowledge or meaningful new commitments even when phrased casually. Do not invent speech for nonverbal or unconscious characters.',
  'SPONTANEOUS REQUESTS: distinguish an external cause from the player formulating a possible request. When companions have visibly explained that they are traveling to seek help, that opportunity can motivate asking to join or seek help too. Do not require the player to first ask aloud whether help is possible, narrate deliberation, express an intention, or receive an invitation solely because the source includes that conversational lead-in. Such a self-authored question is not an external prerequisite to a spontaneous request. An explicit answer to someone else’s question or accusation still requires that question or accusation to be visible. Material new knowledge, permission or access required by the action must still be established.',
  'MEMORY PROVENANCE: preserve established memory and add only facts established in the visible transition. Pending action descriptions are navigation constraints, not evidence of character knowledge, intentions or future requests. This applies equally to summary, canonFacts and openThreads. Do not add an open thread merely because it appears in the source or a pending action.',
  'PROPORTIONATE GROUNDING: ordinary connective wording and minor expressive gestures consistent with the scene need not each have a literal source quotation. Reject material contradictions, invented consequential events, unsupported knowledge, commitments, meaningful unselected actions or changed access/positions. Do not turn harmless stylistic variation into a new indexed action or an obligatory source detail. Nearby companions waiting for a reply during an established conversation is ordinary connective wording, unless it contradicts established distraction, unconsciousness or departure; it does not itself imply consent, agreement or a commitment.',
  'Bridge only the gap between the completed event and the next indexed event, using entry_source as the sole authority for new events.',
  'entry_action_source is separate evidence for static entry facts (such as a suitable tree beside the next gulf). It may contain the first action or later clauses: none of those actions are authorized. Use only the starting location, objects and participants supported before that first action. Preconditions alone do not establish facts.',
  'Static entry facts include existing possession or availability of an object explicitly identified in the first action source. For example, a woodman immediately chopping with his axe supports that he already has the axe; it does not authorize chopping or imply the tree is already cut. A later acquisition, retrieval, repair, transfer or action result does NOT establish availability before that action. Never restore an object that current state says is lost, destroyed or inaccessible.',
  'ACTOR-RELATIVE ENTRY: next_event.entry_action identifies the actor who must be able to begin. The player is the viewpoint, not necessarily the actor. Evaluate reach, tools and capabilities relative to that actor and the first step of the indexed goal. Do not require the player to be within reach of an NPC action target.',
  'OFFSCREEN NPC READINESS: when next_event.entry_action.requiresPlayerDecision is false, an automatic supporting-character action may begin outside the player viewpoint. Evaluate that actor and target using established story state and source-supported starting circumstances; the player sceneScope describes only the player location and is not a map of all possible NPC actions. Do not require the player to witness the NPC approaching or fetching someone in another room. If fetching is the first step, coming to collect the target is execution, not a prerequisite to pre-perform. Keep the pending action unperformed in this entry transition. A source-supported scheduled morning can require a short passage of time, but not a narrated visit before the visit starts. Existing locked access, refusal, absent targets and material contradictions remain blockers; absence from the player scope alone is not such a blocker.',
  'VIEWPOINT AND KNOWLEDGE: offscreen readiness evidence does not grant the player knowledge of remote events. Preserve the player location, presence and speaking-distance lists. Do not append unseen NPC preparations, conversations or intentions to first-person prose or memory merely because they would plausibly accompany the next action. For example, the Lion may sleep and wait in his Palace room without asserting that the others are preparing for their visits. No scene cut or invented report is required to prove the Green Girl can begin fetching Dorothy. The visible-cause requirement remains mandatory for a player response or choice: a remote source-only accusation or approaching threat is not a stimulus the player has perceived.',
  'BEGINNING VERSUS COMPLETION: a source-supported local action may BEGIN with an ordinary approach to an established nearby target in the same accessible space. Immediate hand contact is not required before beginning that approach. For sequential aid to multiple nearby targets, do not require all targets to be simultaneously within hand reach. Such positioning belongs to executing the pending action; do not perform it in this transition merely to pass entryReady. Indexed preconditions are claims to interpret against the source and first executable step, not facts to copy into memory or simultaneous end-state requirements.',
  'Ground a possible local approach in the current scene and source: presence or speaking distance alone does not prove touch distance or an unobstructed path. Existing barriers, separate banks, locked access, restraints, injury or inaccessible targets remain blockers. Never invent a crossing, unlock a door, restore a missing tool, move a target or bypass a risky/meaningful decision as routine positioning.',
  'Do not add a claim that targets are within reach merely because the next action involves them. If the first step can begin from established positions, return no added reachability fact and preserve scope and memory. If setup really changes position, it needs independent source authorization and visible prose; a memory-only assertion cannot establish movement. Unsupported reachability still fails sourceSupport, continuity and storyMemory.',
  'Make newly established source-supported prerequisites clear in the transition or its memory, including relevant object availability. Established facts carry forward unless contradicted; do not require every unchanged possession to be repeated in the appended prose.',
  'The prior scene has already happened. Preserve it; return only a short appended transition in the same language and first-person viewpoint. Return empty text if the entry is already established.',
  'Source-supported routine travel, passage of time, environmental setup, connective dialogue and automatic supporting-character actions may occur. A meaningful player decision, commitment, attack, rescue or risky action must remain unperformed; speech is not forbidden merely because the player says it. If such a decision is required, the transition is not safe to supply.',
  'Distinguish a source-supported inner state from performing an action that communicates it. Feeling afraid or ashamed, wanting help, or remaining silent does not by itself perform an admission, confession, request, promise or decision. For example, the Lion silently feeling ashamed does not perform the future action of admitting his cowardice and shame aloud. This distinction applies to playerAgency, nextEventUnperformed, entryReady and storyMemory: feeling shame and not yet expressing shame are compatible facts.',
  'To reject premature execution, identify the actual unselected act in the prose, with its actor and whether it is thought, speech or behavior. First-person narration of a feeling is not automatically in-world speech to another character. Explicit dialogue or narration that performs the pending admission, confession or request, or makes a new promise or decision, does count as execution. A warning or explanation that only connects established source events is not by itself an agency violation; name the actual decision, commitment or pending action it would execute when rejecting it. If the pending beat is itself an inner realization or decision, do not perform that mental action early. Inner states still require source or established-state support; do not invent them or treat them as facts known by other characters.',
  'Stop before EVERY next_event action, including automatic actions. Never chop the tree, cross the next gulf, or resolve the next obstacle merely to establish its location. Distinguish a new obstacle from the one already resolved.',
  'Do not invent bridging events from a desired precondition, book familiarity or a character profile. Do not skip indexed events. Existing injuries, deaths, barriers, possessions and world rules override source expectations.',
  'Current character capabilities include speech restrictions. No human dialogue for a nonverbal character. Preserve all established participants unless the source actually changes their location.',
  'Preserve each established person in peoplePresent and peopleWithinSpeakingDistance unless the transition explicitly supports a change. Being motionless alone does not remove someone from speaking distance. Append no text when the current prose already supplies the needed setup; a source excerpt is evidence, not a requirement to retell it.',
  'Update scope and memory only to the supported ending. Retain durable facts; replace superseded locations. No future actions or invented shared memories.',
].join('\n');
const checks = ['sourceSupport', 'continuity', 'playerAgency', 'nextEventUnperformed', 'entryReady', 'visibleCause', 'sceneScope', 'storyMemory', 'repetition'] as const;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');

function validMemory(memory: any): memory is StoryMemory {
  return Boolean(memory && typeof memory.summary === 'string' && memory.summary.length <= 900
    && strings(memory.openThreads) && memory.openThreads.length <= 6
    && strings(memory.canonFacts) && memory.canonFacts.length <= 12);
}

function entryActionContext(state: GameState, beat: StoryEventBeat | undefined, index: number) {
  if (!beat) return null;
  const group = beat.characterActionGroup !== undefined ? beat.characterActionGroup : beat.playerAction;
  return {beatIndex: index, actor: beat.actor, action: beat.action, targets: beat.targets,
    requiresPlayerDecision: playerControlsBeat(beat, [state.playerName, ...playerScopeAliases(state.playerName, state.characterProfiles)]),
    readiness: 'begin_first_step',
    goal: group ? {choiceText: group.choiceText, completion: group.completion, boundaryReason: group.boundaryReason,
      playerBeatIndexes: group.playerBeatIndexes, endBeatIndex: group.endBeatIndex} : null,
    indexedPreconditions: group?.preconditions ?? []};
}

export async function establishSourceEventEntry(
  state: GameState, scene: Scene & {storyMemory?: StoryMemory}, candidate: SourceContinuationCandidate,
  completedEventId: string, model: string,
  call: (label: string, request: AiResponseRequest) => Promise<AiResponse>,
): Promise<Scene & {storyMemory?: StoryMemory}> {
  const next = candidate.storyEvents?.find(event => candidate.sourceEventEntries?.[event.eventId]?.fromEventId === completedEventId);
  const entry = next && candidate.sourceEventEntries?.[next.eventId];
  if (!next || !entry) return scene;
  const entryAction = entryActionContext(state, next.beats?.[0], 0);
  const context = {player: state.playerName, current_scene: scene, entry_source: entry.excerpt, entry_action_source: entry.entryExcerpt,
    character_runtime: buildCharacterRuntimeState(state, next.sequence - 1), world_rules: worldRulesForGame(state),
    next_event: {eventId: next.eventId, actions: next.beats?.slice(0, 1).map(b => ({actor: b.actor, action: b.action})),
      entry_action: entryAction, entry_preconditions: entryAction?.indexedPreconditions ?? []}};
  return establishEntry(state, scene, candidate, context, model, call, policy, 'source event entry');
}

/** Establish only the unperformed setup before the immediate next player decision. */
export async function establishSourceBeatEntry(
  state: GameState, scene: Scene & {storyMemory?: StoryMemory}, candidate: SourceContinuationCandidate,
  event: SourceChoiceNavigationEvent, completed: readonly number[], startBeatIndex: number, model: string,
  call: (label: string, request: AiResponseRequest) => Promise<AiResponse>,
): Promise<Scene & {storyMemory?: StoryMemory}> {
  if ((scene.outcome ?? 'active') !== 'active') return scene;
  const index = (event.beats ?? []).findIndex((_beat, i) => i >= startBeatIndex && !completed.includes(i));
  const beat = event.beats?.[index] as (StoryEventBeat & {automaticPreludeSourceExcerpt?: string}) | undefined;
  const aliases = playerScopeAliases(state.playerName, state.characterProfiles);
  if (!beat || !playerControlsBeat(beat, [state.playerName, ...aliases])
    || !beat.automaticPreludeSourceExcerpt?.trim()) return scene;
  const beatPolicy = policy.replace(
    'Bridge only the gap between the completed event and the next indexed event, using entry_source as the sole authority for new events.',
    'Establish the immediate next player decision within the SAME event, using entry_source as the sole authority for missing setup. The excerpt may overlap already completed beats: never replay them. Append only still-missing setup before the next action.',
  ) + '\nThe next_event actions here contain only the immediate UNPERFORMED action of the current event. Later actions are deliberately withheld: they are not knowledge, goals or open threads. None may be performed. Completed beats are immutable history. A prelude end-state summary may omit arrivals or threats explicitly present in the source excerpt; do not discard those source facts. Any new threat, arrival, location change or discovery that motivates the choice must be visible in the prose before the choice, not merely in hidden memory or source context. Knowing a creature exists does not establish its arrival. Keep transport within reach when boarding is still the next unperformed action; do not invent its departure. Preserve the player viewpoint and do not grant an unconscious player direct observations.';
  const entryAction = entryActionContext(state, beat, index);
  const context = {player: state.playerName, current_scene: scene,
    entry_source: beat.automaticPreludeSourceExcerpt, entry_action_source: '',
    completed_beats: completed.map(i => ({index: i, action: event.beats?.[i]?.action})),
    next_player_beat_index: index,
    character_runtime: buildCharacterRuntimeState(state, event.sequence === undefined ? null : event.sequence - 1), world_rules: worldRulesForGame(state),
    next_event: {eventId: event.eventId, actions: event.beats!.slice(index, index + 1).map(b => ({actor: b.actor, action: b.action})),
      entry_action: entryAction, entry_preconditions: entryAction?.indexedPreconditions ?? []}};
  return establishEntry(state, scene, candidate, context, model, call, beatPolicy, 'source beat entry');
}

async function establishEntry(
  state: GameState, scene: Scene & {storyMemory?: StoryMemory}, candidate: SourceContinuationCandidate,
  context: object, model: string, call: (label: string, request: AiResponseRequest) => Promise<AiResponse>,
  instructions: string, label: string,
): Promise<Scene & {storyMemory?: StoryMemory}> {
  context = {...context, accepted_scene_history: acceptedEntryHistory(state)};
  // This is new progression, not a cosmetic rewrite. Its review is always required,
  // independently of the optional canonical content-review setting.
  const reviewDraft = async (transition: {text: string; sceneScope: unknown; storyMemory: unknown}, unchangedScene = false, preflight = false) => {
    const review = await call(`${label}${preflight ? ' preflight' : unchangedScene ? ' unchanged scene' : ''} review`, {model, reasoning: {effort: 'low'}, max_output_tokens: 2400,
      instructions: instructions + (preflight ? '\nSEMANTIC CAUSE ASSESSMENT: Set visibleCause.causeStatus to present, not_required or missing. present means the necessary stimulus or opportunity is clear in accepted_scene_history scenes or current_scene.text, including paraphrases: explain briefly what visible situation makes the immediate action understandable. not_required means the immediate action needs no new stimulus: explain why, for example continuing an already established escort by the Guardian. missing means a material stimulus is absent: name it and set supported=false. present and not_required require supported=true. No literal quotation or exact wording is required. Never treat entry_source, hidden memory or an imagined addition as something the player has seen. The candidate transition is EMPTY; do not describe an appended arrival or changed scope as if it exists.' : '') + '\nReview candidate_transition against the prior scene and entry_source. All checks must pass for materially required facts. Do not reject solely because optional source dialogue or a harmless detail was omitted. sourceSupport checks whether added claims are grounded and compatible, NOT whether the entire source passage was narrated. A candidate with empty text can pass sourceSupport if its scope and memory add no unsupported facts. Evaluate a missing player-visible stimulus under visibleCause, independently of physical readiness. In visibleCause.reason identify the immediate source stimulus and quote or paraphrase its occurrence in accepted_scene_history scenes, current_scene.text or candidate_transition.text; if absent reject even when entryReady passes. Source text and hidden memory are evidence of what to show, never proof that the player saw it. For a spontaneous action with no necessary stimulus explain why none is needed. Evaluate other genuinely missing necessary setup under entryReady and name the immediate action it prevents or leaves unintelligible. Do not treat omission alone as a continuity contradiction. entryReady means the first next_event action can BEGIN, not that it has succeeded. Use next_event.entry_action.actor and its first executable step. Distinguish a supported ability to approach locally from an unsupported claim of existing touch distance. State the actual blocked first step and source/current-state obstacle when rejecting readiness; later steps or simultaneous reach of sequential targets are not entry requirements. Never approve an invented memory fact merely because the action could begin without it. Evaluate readiness from the combined accepted_scene_history, current_scene, candidate_transition (including memory), entry_source and static starting facts in entry_action_source. An unchanged possession directly supported there need not be restated in candidate_transition. Distinguish presupposed possession from obtaining or using an object; never demand execution of an action as proof of its prerequisite. Check all next_event actions remain unperformed. For offscreen automatic NPC actions, apply OFFSCREEN NPC READINESS: no player-visible arrival is required before the actor begins approaching or fetching. No correction, generation or inference of missing actions. Evaluate sceneScope only for location/presence/reach, storyMemory only for remembered facts/goals and their temporal status, and repetition only for replay of already narrated actions. A missing source detail is not a replay merely because it belongs to an indexed completed beat. For entryReady, set repairTarget=sceneScope only if existing prose/source already supports the required conversational proximity and the sole blocker is an inconsistent scope list; otherwise set repairTarget=none. Speaking distance is not proof of attention or willingness to listen. Missing arrival, unanswered setup, blocked access, or absent evidence cannot be corrected by editing lists. If ready, use repairTarget=none. Report a pure presence-list mismatch under sceneScope, and a pure replay under repetition; do not misclassify either as a memory error. Unsupported new events and real contradictions still fail sourceSupport/continuity.',
      input: JSON.stringify({...context, candidate_transition: transition, ...(preflight ? {review_mode: 'Check the unchanged current scene BEFORE generating any transition. All checks must pass to skip generation. A visible opportunity to ask for help suffices; do not require a narrated intention or deliberation before the player chooses. Do not require optional connective prose. Missing accusations, questions, arrivals and material access prerequisites still fail.'} : {}), ...(unchangedScene ? {review_mode: 'Keep the current scene exactly unchanged. Recheck every requirement, especially whether required setup is already visible without any part of the rejected transition.'} : {})}),
      text: {format: {type: 'json_schema', name: 'bookrpg_source_event_entry_review', strict: true, schema: {
        type: 'object', additionalProperties: false, properties: Object.fromEntries(checks.map(k => [k, {
          type: 'object', additionalProperties: false,
          ...(k === 'playerAgency' ? {description: 'Allow source-supported connective warnings, observations and explanations consistent with character knowledge. Reject new decisions/commitments and execution of pending actions, not speech merely because the player speaks. Name the material boundary crossed.'} : {}),
          ...(k === 'repetition' ? {description: 'supported=true means there is NO prohibited replay. A transition that does not replay completed actions passes; absence of replay is never a rejection reason.'} : {}),
          ...(k === 'sourceSupport' ? {description: 'Grounding of added claims, not completeness of source retelling. Optional omitted dialogue is not a failure; check metadata changes even when text is empty.'} : {}),
          ...(k === 'visibleCause' ? {description: 'Separate causal check: identify the immediate source-backed stimulus and its visible occurrence in scene/transition prose. Ability to speak, mere confrontation, source-only dialogue or hidden memory cannot substitute for an accusation or question. A spontaneous request may follow a visible opportunity; do not require a prior player-authored question or declared intention merely because it appears in the source. Explain when no further stimulus is required.'} : {}),
          ...(k === 'entryReady' ? {description: 'Immediate action has the necessary visible cause and can begin. Name a material missing prerequisite; do not require optional source remarks, exact wording or setup for later actions.'} : {}),
          properties: {supported: {type: 'boolean'}, reason: {type: 'string'}, ...(preflight && k === 'visibleCause' ? {causeStatus: {type:'string', enum:['present', 'not_required', 'missing']}} : {}), ...(k === 'entryReady' ? {repairTarget: {type: 'string', enum: ['none', 'sceneScope']}} : {})}, required: ['supported', 'reason', ...(preflight && k === 'visibleCause' ? ['causeStatus'] : []), ...(k === 'entryReady' ? ['repairTarget'] : [])],
        }])), required: [...checks],
      }}}});
    if (review.status !== 'completed') throw new SceneGenerationError(['Incomplete source event entry review.'], 1);
    const verdict = JSON.parse(review.output_text);
    if (preflight && verdict?.visibleCause) {
      const cause = verdict.visibleCause;
      const validStatus = ['present', 'not_required', 'missing'].includes(cause.causeStatus);
      const consistent = cause.supported === (cause.causeStatus !== 'missing');
      if (!validStatus || !consistent) {
        verdict.visibleCause = {...cause, supported: false,
          reason: 'The semantic cause assessment is missing or inconsistent. Explain whether the necessary cause is visible, not required, or missing; source-only facts are not visible setup.'};
      }
    }
    return {verdict, rejected: checks.filter(k => verdict?.[k]?.supported !== true || typeof verdict[k]?.reason !== 'string' || !verdict[k].reason.trim())};
  };
  // Review the identity transition first: when already ready there is nothing
  // to generate, remember, or repair. This uses the same full acceptance gate.
  if (scene.sceneScope && validMemory(scene.storyMemory)) {
    const unchanged = {text: '', sceneScope: structuredClone(scene.sceneScope), storyMemory: structuredClone(scene.storyMemory)};
    const preflight = await reviewDraft(unchanged, false, true);
    if (!preflight.rejected.length) {
      const scopeErrors = sceneScopeFailures(scene.sceneScope, {playerName: state.playerName,
        playerAliases: playerScopeAliases(state.playerName, state.characterProfiles), knownCharacterProfiles: state.characterProfiles,
        nonInteractableCharacters: candidate.unavailableCharacters ?? []});
      if (scopeErrors.length) throw new SceneGenerationError(scopeErrors, 1);
      return scene;
    }
    if (preflight.rejected.length === 1 && preflight.rejected[0] === 'sceneScope') {
      const repaired = await repairEntrySpeakingDistance(scene, preflight.verdict.sceneScope.reason, model, call, label);
      const failures = sceneScopeFailures(repaired.sceneScope!, {playerName: state.playerName,
        playerAliases: playerScopeAliases(state.playerName, state.characterProfiles), knownCharacterProfiles: state.characterProfiles,
        nonInteractableCharacters: candidate.unavailableCharacters ?? []});
      if (failures.length) throw new SceneGenerationError(failures, 1);
      return repaired;
    }
    context = {...context, missing_setup: Object.fromEntries(preflight.rejected.map(k => [k, preflight.verdict?.[k]?.reason ?? 'missing review']))};
  }
  const retainedThreads = scene.storyMemory?.openThreads ?? [];
  const memorySchema = sceneJsonSchema.properties.storyMemory;
  const entryMemorySchema = {...memorySchema, properties:{...memorySchema.properties,
    openThreads:{type:'array', maxItems:6, items:retainedThreads.length ? {type:'string', enum:[...new Set(retainedThreads)]} : {type:'string'}, ...(retainedThreads.length ? {} : {maxItems:0})}}};
  const request: AiResponseRequest = {model, reasoning: {effort: 'low'}, max_output_tokens: 3200,
    instructions: instructions + '\nFor this setup-only transition, openThreads may only retain existing entries verbatim or remove resolved entries. Do not create or rephrase threads from pending actions. Record newly visible setup in summary/canonFacts instead, without predicting choices.', input: JSON.stringify(context),
    text: {format: {type: 'json_schema', name: 'bookrpg_source_event_entry', strict: true, schema: {
      type: 'object', additionalProperties: false,
      properties: {peopleKilledInScene: peopleKilledInSceneSchema, text: {type: 'string'}, sceneScope: sceneJsonSchema.properties.sceneScope, storyMemory: entryMemorySchema},
      required: ['text', 'sceneScope', 'storyMemory', 'peopleKilledInScene'],
    }}}};
  const response = await call(label, request);
  if (response.status !== 'completed') throw new SceneGenerationError(['Incomplete source event entry.'], 1);
  const draft = JSON.parse(response.output_text);
  const scope = draft?.sceneScope;
  const memory = draft?.storyMemory;
  if (!draft || Object.keys(draft).some(k => !['text', 'sceneScope', 'storyMemory', 'peopleKilledInScene'].includes(k))
    || typeof draft.text !== 'string' || sceneLeaksInternalMetadata(draft.text)
    || !scope || typeof scope.currentLocation !== 'string' || !scope.currentLocation.trim()
    || !strings(scope.peoplePresent) || !strings(scope.peopleWithinSpeakingDistance)
    || !validMemory(memory)) throw new SceneGenerationError(['Invalid source event entry metadata.'], 1);
  if (memory.openThreads.some((thread: string) => !retainedThreads.includes(thread))) throw new SceneGenerationError(['Source event entry storyMemory: setup added a new open thread instead of retaining established threads.'], 1);
  const failures = sceneScopeFailures(scope, {playerName: state.playerName,
    playerAliases: playerScopeAliases(state.playerName, state.characterProfiles), knownCharacterProfiles: state.characterProfiles,
    nonInteractableCharacters: candidate.unavailableCharacters ?? []});
  if (failures.length) throw new SceneGenerationError(failures, 1);
  let {verdict, rejected} = await reviewDraft(draft);
  // A gratuitous embellishment must not force progression or memory repair.
  // Discard the entire unsaved proposal and independently review the original
  // scene. Readiness of the discarded candidate alone never authorizes this.
  if (draft.text.trim() && rejected.length > 0
    && rejected.every(k => k === 'sourceSupport' || k === 'continuity')
    && scene.sceneScope && validMemory(scene.storyMemory)) {
    const unchanged = {text: '', sceneScope: structuredClone(scene.sceneScope), storyMemory: structuredClone(scene.storyMemory)};
    const fallback = await reviewDraft(unchanged, true);
    if (!fallback.rejected.length) return scene;
    throw new SceneGenerationError(fallback.rejected.map(k =>
      `Source event entry unchanged scene ${k}: ${fallback.verdict?.[k]?.reason ?? 'missing review'}`), 1);
  }
  // Repair only the rejected presentation fields. Never regenerate memory here:
  // a scope or replay issue must not turn a pending action into a remembered fact.
  const scopeOnlyReadinessRepair = rejected.length === 1 && rejected[0] === 'entryReady'
    && verdict.entryReady.repairTarget === 'sceneScope';
  // A single scope error can also fail sourceSupport and continuity. Offer
  // one scope-only correction, then rerun EVERY check; this is not acceptance
  // of those failures and cannot repair unsupported prose or memory.
  const correlatedScopeRepair = rejected.includes('sceneScope')
    && rejected.every(k => k === 'sceneScope' || k === 'sourceSupport' || k === 'continuity');
  if (scopeOnlyReadinessRepair || correlatedScopeRepair || (rejected.length > 0 && rejected.every(k => k === 'sceneScope' || k === 'repetition'))) {
    const fields: string[] = (scopeOnlyReadinessRepair || correlatedScopeRepair) ? ['sceneScope'] : rejected.map(k => k === 'sceneScope' ? 'sceneScope' : 'text');
    const repaired = await call(`${label} presentation repair`, {model, reasoning: {effort: 'low'}, max_output_tokens: 1600,
      instructions: instructions + '\nRepair ONLY the requested fields. For repetition remove already narrated setup, returning empty text if nothing is missing. For sceneScope preserve established presence and speaking distance unless the transition supports a change. The supplied storyMemory is frozen and cannot be rewritten or contradicted. Do not perform any pending action, add a new event, or erase already established facts. Return exactly repair_fields. A visible destination is not the current location: seeing a cottage through trees does not establish arrival beside it. Correct metadata to the established prose, never move characters to satisfy the metadata.' + (scopeOnlyReadinessRepair ? '\nThis is a speaking-distance metadata reconciliation. Change ONLY peopleWithinSpeakingDistance, using already established prose/source evidence of proximity. Keep currentLocation and peoplePresent exactly unchanged. Do not equate mere presence with conversational distance, or distance with attention. Do not invent approach, movement, listening, consent, arrival or any other setup. If evidence is insufficient, return the original scope unchanged; the readiness failure must remain.' : ''),
      input: JSON.stringify({...context, candidate_transition: draft, repair_fields: fields,
        rejections: Object.fromEntries(rejected.map(k => [k, verdict[k].reason]))}),
      text: {format: {type: 'json_schema', name: 'bookrpg_source_entry_presentation_repair', strict: true, schema: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(fields.map(k => [k, k === 'text' ? {type: 'string'} : sceneJsonSchema.properties.sceneScope])),
        required: fields,
      }}},
    });
    if (repaired.status !== 'completed') throw new SceneGenerationError(['Incomplete source entry presentation repair.'], 1);
    const patch = JSON.parse(repaired.output_text);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).length !== fields.length || Object.keys(patch).some(k => !fields.includes(k))
      || (fields.includes('text') && (typeof patch.text !== 'string' || sceneLeaksInternalMetadata(patch.text)))) {
      throw new SceneGenerationError(['Invalid source entry presentation repair.'], 1);
    }
    if (fields.includes('sceneScope')) {
      const repairedScope = patch.sceneScope;
      if (!repairedScope || typeof repairedScope.currentLocation !== 'string' || !repairedScope.currentLocation.trim()
        || !strings(repairedScope.peoplePresent) || !strings(repairedScope.peopleWithinSpeakingDistance)) {
        throw new SceneGenerationError(['Invalid source entry repaired scope.'], 1);
      }
      if (scopeOnlyReadinessRepair && (repairedScope.currentLocation !== draft.sceneScope.currentLocation
        || JSON.stringify(repairedScope.peoplePresent) !== JSON.stringify(draft.sceneScope.peoplePresent))) {
        throw new SceneGenerationError(['Speaking-distance reconciliation changed location or presence.'], 1);
      }
      const scopeErrors = sceneScopeFailures(repairedScope, {playerName: state.playerName,
        playerAliases: playerScopeAliases(state.playerName, state.characterProfiles), knownCharacterProfiles: state.characterProfiles,
        nonInteractableCharacters: candidate.unavailableCharacters ?? []});
      if (scopeErrors.length) throw new SceneGenerationError(scopeErrors, 1);
    }
    Object.assign(draft, patch);
    ({verdict, rejected} = await reviewDraft(draft));
  }
  if (rejected.length) throw new SceneGenerationError(rejected.map(k => `Source event entry ${k}: ${verdict?.[k]?.reason ?? 'missing review'}`), 1);
  const deaths = normalizeSceneDeaths(draft.peopleKilledInScene, state.characterProfiles);
  return {...scene, ...(deaths.length ? {peopleKilledInScene: [...new Set([...(scene.peopleKilledInScene ?? []), ...deaths])]} : {}), text: [scene.text, draft.text.trim()].filter(Boolean).join('\n\n'), sceneScope: draft.sceneScope, storyMemory: memory};
}
