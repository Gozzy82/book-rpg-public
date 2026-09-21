import {cleanChoiceText} from '../shared/choice-text.js';
import {traceEvent} from '../util/flow-trace.js';
import {buildCharacterRuntimeState, CHARACTER_RUNTIME_RULES} from './engine/character-runtime.js';
import {randomUUID} from 'node:crypto';
import {createAiClient, type AiClient, type AiResponseRequest} from './provider.js';
import {SOURCE_ANCHOR_CHOICE_ID} from '../shared/contracts.js';
import type {GameState, GameChoice} from '../shared/contracts.js';
import {worldRulesForGame} from '../shared/world-rules.js';
import {PLAYER_PERSPECTIVE_POLICY, PRESENCE_POLICY, FREE_CHOICE_CREATIVITY_POLICY} from './engine/shared-policy.js';
import {SceneGenerationError} from './engine/core.js';
import type {GeneratedScene} from './engine/core.js';
import type {ReturnBridge} from '../games/return-bridges.js';
import {bridgeStillPossible, bridgeBeatSelection} from '../games/return-bridges.js';
import {SCENE_DEATH_POLICY, normalizeSceneDeaths} from '../shared/scene-deaths.js';
import {PLAYED_HISTORY_POLICY} from './engine/opening-frame.js';
import {findCharacterProfile, spokenDialogueCapabilityFailure} from '../shared/character-dynamics.js';
import {sceneLeaksInternalMetadata} from './engine/scene-text.js';
import {choiceParaphrasesConsumedAction} from './engine/scene-validation.js';

export const FREE_WORLD_POLICY = [
  ...PLAYER_PERSPECTIVE_POLICY, ...PRESENCE_POLICY,
  ...FREE_CHOICE_CREATIVITY_POLICY, ...CHARACTER_RUNTIME_RULES, PLAYED_HISTORY_POLICY, SCENE_DEATH_POLICY,
  'A custom action is not limited to the previous menu. It may change direction, ignore every prepared bridge, or stay in the same situation without advancing a plot or decision boundary. Judge its actual consequences and continuity, never its usefulness to the canonical route.',
  'Interpret selectedInput according to inputKind: action selects a player action, dialogue selects their utterance, observe advances the immediate situation, and event introduces an external world event. Resolve only that input and its immediate consequences. Player attempts may fail. Never perform an unchosen meaningful player action.',
  'Maintain the established history, abilities, physical constraints, deaths and current world rules. Newer world rules take precedence.',
  'Respond to the chosen input and its immediate consequences without replaying prior narration; plot advancement is not required. Offer two to four distinct, immediately executable choices in an active scene.',
  'When selectedInput directly speaks to, tells, asks, confides in, or otherwise addresses a living character who is present and able to communicate, resolve that interaction with a concrete immediate response from that character. The response may be spoken words, a specific purposeful action, an explicit refusal, or deliberate silence when grounded in character/state, but it must visibly acknowledge the substance of what the player said. Vague narration such as "their voice drifted", "they seemed to listen", or a generic nod without an actual substantive response is not enough.',
  'Use existing openThreads as optional continuity: develop or close them when the chosen action makes that natural. Never force a thread. Update storyMemory using only accepted past facts and what this candidate actually establishes; future plans are not facts.',
  'This is FREE WORLD play: the selectedInput remains authoritative and must be resolved honestly. When no preparedOpportunity exists there is no canonical obligation. When a preparedOpportunity DOES exist, returning to the story is the preferred NEXT menu route after selectedInput has been resolved; it remains optional because the player must still receive free alternatives.',
  'General free-scene acceptance is independent of return routing: no canonical event or source beat is required. Validate the selected input, continuity, agency, capabilities, world rules, presence and executable choices; bridge linkage is reviewed separately.',
  'A prepared bridge is preferred future material, not an event that has happened. After resolving selectedInput and its immediate consequences, make a strong best effort to weave the compatible part of preparedOpportunity.leadIn into the scene so a bridge choice can be offered as choices[0]. Do not distort, undo or refuse selectedInput merely to force the bridge. Omit the bridge only when it is obsolete, physically incompatible, or no honest executable bridge step can yet be offered. Never judge a bridge by whether it matches the topic or intent of selectedInput.',
  'preparedOpportunity.leadIn is a source-grounded causal mini-story. Use only the compatible portion; do not paste it mechanically or replay details already established in currentScene or preparedOpportunity.steps. It is guidance, not played history until actually narrated.',
  'When preparedOpportunity.canonicalPrelude exists, every listed source beat is RESERVED for canonical re-entry after a voluntary bridge step. Do not narrate, imply, complete or assume any listed action/result in free-world prose. End before the first reserved beat. In that case do not expose target.action as followsBridge yet; only an executable advancesBridge step may lead into the reserved prelude.',
  'Mark at most one action choice as followsBridge ONLY when there is no pending canonicalPrelude and preparedOpportunity.target.requiredSituation is already established at the end of this scene, and the choice directly performs target.action with its source-grounded location and resultingState. A shared event, storm or theme is insufficient. Travel to the required location, gathering participants or acquiring required objects remains a free intermediate choice with followsBridge false. Never perform unchosen travel to unlock an anchor. If unused, every choice has followsBridge false.',
  'Set advancesBridge true on at most one action choice that takes a concrete free intermediate step toward the prepared route. When canonicalPrelude exists, that step may reach only a handoff BEFORE its first reserved beat; it must not establish target.requiredSituation by assuming a reserved outcome. Without a canonicalPrelude, it may move toward target.requiredSituation normally. This is NOT an anchor: followsBridge must be false. When useful, weave preparedOpportunity.leadIn into the prose to make that step arise as a natural story development, ending before the player takes the step. Never replay an active bridge step or force further movement. Offer alternatives and allow abandoning it. If no suitable step exists, set advancesBridge false.',
  'Choice text must contain only the action or utterance, without a numbered prefix; the interface supplies numbering. Never print internal IDs, control fields or a Choices menu in prose. Dialogue belongs to physically available speakers with the established ability to speak.',
  'Never append selectedInput, preparedOpportunity.choiceText, or any menu option as a standalone final line or second-person recap after the narrative. The prose must SHOW the selected action and its consequences, not repeat its label.'
];
const str = {type: 'string'};
const names = {type: 'array', items: str};
const sceneSchema = {type: 'object', additionalProperties: false, properties: {
  title: str, text: str, development: str, outcome: {type: 'string', enum: ['active', 'won', 'lost']}, outcomeReason: str,
  sceneScope: {type: 'object', additionalProperties: false, properties: {
    currentLocation: str, peoplePresent: names, peopleWithinSpeakingDistance: names,
  }, required: ['currentLocation', 'peoplePresent', 'peopleWithinSpeakingDistance']},
  peopleKilledInScene: names,
  storyMemory: {type: 'object', additionalProperties: false, properties: {summary: str, openThreads: names, canonFacts: names},
    required: ['summary', 'openThreads', 'canonFacts']},
  choices: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {
    text: str, type: {type: 'string', enum: ['action', 'talk']}, character: {type: ['string', 'null']}, followsBridge: {type: 'boolean'}, advancesBridge: {type: 'boolean'},
  }, required: ['text', 'type', 'character', 'followsBridge', 'advancesBridge']}},
}, required: ['title', 'text', 'development', 'outcome', 'outcomeReason', 'sceneScope', 'peopleKilledInScene', 'storyMemory', 'choices']};
const bridgeReviewSchema = {type: 'object', additionalProperties: false, properties: {
  accepted: {type: 'boolean'}, reason: str,
  targetStatus: {type:'string',enum:['ready','pending','obsolete']},
  targetEvidence: names,
  targetAlreadyPerformed: {type:'boolean'},
  targetPerformedEvidence: names,
  bridgeEvidence: {type: ['string', 'null']},
  bridgeStepEvidence: {type:['string','null']},
  bridgeStepChoiceIndex: {type:['integer','null'], minimum:0, maximum:3},
  bridgeStepText: {type:['string','null']},
  preludeReady: {type:['boolean','null']},
  preludeEvidence: names,
  bridgeReadiness: {anyOf: [{type: 'null'}, {type: 'object', additionalProperties: false, properties: {
    ready: {type: 'boolean'}, actionMatches: {type: 'boolean'}, reason: str, evidence: names,
  }, required: ['ready', 'actionMatches', 'reason', 'evidence']}]},
}, required: ['accepted', 'reason', 'targetStatus', 'targetEvidence', 'targetAlreadyPerformed', 'targetPerformedEvidence',
  'bridgeEvidence', 'bridgeReadiness', 'bridgeStepEvidence', 'bridgeStepChoiceIndex', 'bridgeStepText', 'preludeReady', 'preludeEvidence']};
const reviewSchema = {type:'object',additionalProperties:false,properties:{accepted:{type:'boolean'},reason:str},required:['accepted','reason']};
export const WORLD_EVENT_POLICY = [
  'WORLD EVENT: selectedInput is an externally initiated occurrence, not a player attempt or optional suggestion. Make all its stated material effects happen now, including an explicitly stated death. Do not soften a completed event into a threat, near miss, dream, metaphor or possibility.',
  "The world event is this turn's single major development. Focus the scene on its immediate observable consequences and reactions; a passing mention followed by an old confrontation or a long generic character monologue is insufficient. Stop before a new independent major event or voluntary player decision.",
  'previous scene and history are already played. Start from their final state, preserve deaths, injuries, relationships and positions unless this event explicitly changes them. Never replay an earlier attack, warning or speech to restore the book plot. New reactions to the changed situation are allowed.',
  'Book profiles and prepared opportunities cannot overrule the latest event or prior played consequences. An unusual event is valid even if absent from the book. An optional bridge may appear only as a compatible immediate consequence; it must not distract from or undo the event.',
  'Record actual known-character deaths in peopleKilledInScene and the updated storyMemory. Keep dead NPCs out of living presence, conversational reach and talk choices. A corpse may remain in the prose; it cannot bark, speak or act alive.',
];
const eventCheckNames = ['eventResolution', 'continuity', 'playerAgency', 'deathConsistency'] as const;
const eventCheckSchema = {type: 'object', additionalProperties: false, properties: {
  status: {type: 'string', enum: ['pass', 'fail', 'uncertain']}, reason: str,
}, required: ['status', 'reason']};
const eventReviewSchema = {...reviewSchema, properties: {...reviewSchema.properties,
  eventEvidence: {type: ['string', 'null']},
  eventChecks: {type: 'object', additionalProperties: false,
    properties: Object.fromEntries(eventCheckNames.map(name => [name, eventCheckSchema])), required: [...eventCheckNames]},
}, required: [...reviewSchema.required, 'eventEvidence', 'eventChecks']};
export function freeWorldContext(game: GameState) {
  // Baseline identity/capabilities only; acquired state comes from actual play.
  // A free turn must not select book development from the canonical cursor.
  const runtime = buildCharacterRuntimeState(game, null);
  return {player: game.playerName, profiles: game.characterProfiles?.map(p => ({name: p.name, aliases: p.aliases,
    role: p.role, ...(p.dynamics ? {} : {description: p.description, traits: p.traits, relationships: p.relationships})})),
    characterState: runtime, worldRules: worldRulesForGame(game),
    history: game.history.slice(-12), storyMemory: game.storyMemory,
    currentScene: {title: game.scene.title, text: game.scene.text, sceneScope: game.scene.sceneScope},
    deadCharacters: game.confirmedDeadCharacters ?? []};
}
export function jsonRequest(client: AiClient, name: string, instructions: string, input: unknown,
  schema: Record<string, unknown>, tokens = 3000): AiResponseRequest {
  return {model: client.model, reasoning: {effort: 'low'}, instructions, input: JSON.stringify(input),
    max_output_tokens: tokens, text: {format: {type: 'json_schema', name, strict: true, schema}}};
}
export async function readAiJson(client: AiClient, request: AiResponseRequest): Promise<any> {
  const call = {callId: randomUUID(), label: request.text?.format.name, provider: client.provider, model: request.model};
  traceEvent('ai.request', {...call, request});
  let result;
  try { result = await client.createResponse(request); }
  catch (error) { traceEvent('ai.error', {...call, error}); throw error; }
  traceEvent('ai.response', {...call, response: result});
  if (result.status && result.status !== 'completed') throw new Error(`Incomplete ${request.text?.format.name}`);
  return JSON.parse(result.output_text);
}
class FreeConversationError extends Error {}

function evidenceQuote(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let quote = value.trim();
  if (!quote) return null;
  const pairs: Array<[string,string]> = [['"','"'], ["'","'"], ['“','”'], ['‘','’']];
  for (const [open, close] of pairs) {
    if (quote.startsWith(open) && quote.endsWith(close) && quote.length > open.length + close.length) {
      quote = quote.slice(open.length, quote.length - close.length).trim();
      break;
    }
  }
  return quote || null;
}
function evidenceGrounded(text: string, value: unknown): boolean {
  const quote = evidenceQuote(value);
  return Boolean(quote && text.includes(quote));
}
function groundedEvidence(text: string, values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const quote = evidenceQuote(value);
    return quote && text.includes(quote) ? [quote] : [];
  });
}
class BridgeTargetLeakError extends Error {}
function echoKey(value: string): string {
  return cleanChoiceText(value).normalize('NFKC').trim().toLocaleLowerCase()
    .replace(/^you\s+/, '').replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
}
export function stripTrailingChoiceEcho(text: string, labels: readonly string[]): string {
  const parts = text.trimEnd().split(/\n\s*\n/);
  if (parts.length < 2) return text.trimEnd();
  const last = parts.at(-1)?.trim() ?? '';
  const key = echoKey(last);
  if (!key || !labels.some(label => echoKey(label) === key)) return text.trimEnd();
  parts.pop();
  return parts.join('\n\n').trimEnd();
}

function conversationTarget(choice: any, value: any, game: GameState): {target?: string; reason?: string} {
  if (choice?.type !== 'talk') return {};
  const key = (name: string) => (findCharacterProfile(name, game.characterProfiles)?.name ?? name).normalize('NFKC').trim().toLocaleLowerCase();
  const name = choice.character;
  if (typeof name !== 'string' || !name.trim()) return {reason:'talk choice has no character'};
  if (key(name) === key(game.playerName)) return {reason:`${name} is the player, not a conversation partner`};
  if ([...(game.confirmedDeadCharacters ?? []), ...(value.peopleKilledInScene ?? [])].some(n => key(n) === key(name))) return {reason:`${name} is dead`};
  const target = value.sceneScope?.peopleWithinSpeakingDistance?.find((n: string) => key(n) === key(name));
  if (!target) return {reason:`${name} is not within speaking distance; available: ${(value.sceneScope?.peopleWithinSpeakingDistance ?? []).join(', ')}`};
  const failure = spokenDialogueCapabilityFailure(game.playerName, target, game.characterProfiles);
  return failure ? {reason:failure} : {target};
}

/** Independently validates structure even if a provider ignores the schema. */
export function parseFreeScene(value: any, game: GameState, bridge?: ReturnBridge): GeneratedScene {
  const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every(v => typeof v === 'string' && v.trim());
  if (!value || !['active', 'won', 'lost'].includes(value.outcome)
    || !['title', 'text', 'development', 'outcomeReason'].every(k => typeof value[k] === 'string')
    || !value.text.trim() || !value.title.trim() || !value.sceneScope?.currentLocation?.trim()
    || !strings(value.sceneScope.peoplePresent) || !strings(value.sceneScope.peopleWithinSpeakingDistance)
    || !strings(value.peopleKilledInScene) || typeof value.storyMemory?.summary !== 'string'
    || !strings(value.storyMemory?.openThreads) || !strings(value.storyMemory?.canonFacts) || !Array.isArray(value.choices)
    || (value.outcome === 'active' ? value.choices.length < 2 || value.choices.length > 4 : value.choices.length !== 0)) {
    throw new Error('Malformed free-world scene');
  }
  if (!value.sceneScope.peoplePresent.includes(game.playerName)
    || !value.sceneScope.peopleWithinSpeakingDistance.includes(game.playerName)
    || value.sceneScope.peopleWithinSpeakingDistance.some((n: string) => !value.sceneScope.peoplePresent.includes(n))) throw new Error('Invalid scene scope');
  if ([value.title, value.text, ...value.choices.map((c: any) => c.text)].some(t => typeof t !== 'string' || /#brpg_|__bookrpg_|followsBridge/.test(t))
    || sceneLeaksInternalMetadata(value.title, value.text, ...value.choices.map((c:any)=>c.text)))
    throw new Error('Internal metadata leaked');
  const deaths = normalizeSceneDeaths(value.peopleKilledInScene, game.characterProfiles);
  const identity = (name: string) => (findCharacterProfile(name, game.characterProfiles)?.name ?? name).normalize('NFKC').trim().toLocaleLowerCase();
  const dead = new Set([...(game.confirmedDeadCharacters ?? []), ...deaths].map(identity));
  const isDeadNpc = (name: string) => identity(name) !== identity(game.playerName) && dead.has(identity(name));
  if ([...value.sceneScope.peoplePresent, ...value.sceneScope.peopleWithinSpeakingDistance].some(isDeadNpc))
    throw new Error('Dead NPC listed as a living scene participant');
  let bridgeChoices = 0;
  let bridgeSteps = 0;
  const choices: GameChoice[] = value.choices.map((choice: any) => {
    if (!['action', 'talk'].includes(choice.type) || typeof choice.text !== 'string' || !choice.text.trim()
      || typeof choice.followsBridge !== 'boolean'
      || (choice.advancesBridge !== undefined && typeof choice.advancesBridge !== 'boolean')
      || !(choice.character === null || typeof choice.character === 'string')) throw new Error('Malformed choice');
    const conversation = conversationTarget(choice, value, game);
    if (conversation.reason) throw new FreeConversationError(`Unavailable conversation: ${conversation.reason}. Choice: ${choice.text}`);
    if (choice.advancesBridge && (!bridge || choice.type !== 'action' || choice.followsBridge || ++bridgeSteps > 1
      || !bridgeStillPossible(bridge, game))) throw new Error('Invalid intermediate bridge choice');
    if (choice.followsBridge && (!bridge || choice.type !== 'action' || ++bridgeChoices > 1)) throw new Error('Invalid bridge choice');
    if (choice.followsBridge && !bridgeStillPossible(bridge!, {...game,
      confirmedDeadCharacters: [...(game.confirmedDeadCharacters ?? []), ...value.peopleKilledInScene],
      scene: {...game.scene, sceneScope: value.sceneScope}})) throw new Error('Bridge no longer fits the resulting situation');
    return {id: choice.followsBridge ? SOURCE_ANCHOR_CHOICE_ID : `choice_${randomUUID()}`, text: cleanChoiceText(choice.text), type: choice.type,
      ...(choice.character ? {character: conversation.target ?? choice.character} : {}),
      ...(choice.advancesBridge ? {bridgeStepId: bridge!.id} : {}),
      ...(choice.followsBridge ? {sourceBeatSelection: bridgeBeatSelection(bridge!), bridgeId: bridge!.id, sourceEventId: bridge!.eventId, sourceAnchorRoute: 'transition' as const} : {})};
  });
  return {title: value.title, text: value.text, development: value.development,
    sceneScope: value.sceneScope, peopleKilledInScene: deaths, storyMemory: value.storyMemory,
    choices: [...choices.filter(c => c.bridgeId), ...choices.filter(c => !c.bridgeId)], outcome: value.outcome, ...(value.outcomeReason ? {outcomeReason: value.outcomeReason} : {})};
}
export async function generateFreeWorldScene(game: GameState, selectedInput: string,
  kind: 'action' | 'observe' | 'event' | 'dialogue', bridge?: ReturnBridge, suppliedClient?: AiClient):
  Promise<GeneratedScene & {obsoleteBridgeEvidence?: string[]; canonicalPreludeReady?: boolean}> {
  if (!suppliedClient && process.env.BOOKRPG_FAKE_AI === '1') {
    return {title: 'A new possibility', text: `I consider my surroundings. ${selectedInput}${bridge ? ` ${bridge.leadIn ?? bridge.setup}` : ''}`,
      development: selectedInput, sceneScope: game.scene.sceneScope, choices: [
        {id: bridge ? SOURCE_ANCHOR_CHOICE_ID : `choice_${randomUUID()}`, type: 'action', text: bridge?.choiceText ?? 'Explore the surroundings.', ...(bridge ? {bridgeId: bridge.id, sourceEventId: bridge.eventId, sourceAnchorRoute: 'transition' as const} : {})},
        {id: `choice_${randomUUID()}`, type: 'action', text: 'Take a different path.'}], outcome: 'active',
      ...(bridge?.canonicalPrelude?.beats.length && game.returnPlanning?.activeBridgeId === bridge.id ? {canonicalPreludeReady:true} : {})};
  }
  const client = suppliedClient ?? createAiClient();
  const context = { ...freeWorldContext(game), selectedInput, inputKind: kind,
    preparedOpportunity: bridge ? {leadIn: bridge.leadIn ?? bridge.setup, setup: bridge.setup, choiceText: bridge.choiceText, target: bridge.target,
      departureLocation: bridge.departureLocation, steps: bridge.steps ?? [], canonicalPrelude: bridge.canonicalPrelude ?? null,
      active: game.returnPlanning?.activeBridgeId === bridge.id} : null};
  const policy = [...FREE_WORLD_POLICY, ...(kind === 'event' ? WORLD_EVENT_POLICY : [])];
  const failures: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let raw = await readAiJson(client, jsonRequest(client, 'bookrpg_free_scene',
        policy.join('\n'), {...context, repairFeedback: failures.at(-1) ?? null}, sceneSchema));
      raw = {...raw, text: stripTrailingChoiceEcho(raw.text, [selectedInput, ...(bridge ? [bridge.choiceText] : [])])};
      if (kind === 'action' && Array.isArray(raw.choices)) {
        raw = {...raw, choices: raw.choices.filter((choice:any) =>
          choice?.type !== 'action' || !choiceParaphrasesConsumedAction(choice.text ?? '', selectedInput))};
      }
      if (bridge?.canonicalPrelude?.beats.length && Array.isArray(raw.choices)) {
        // A reserved canonical prelude means the target action is not yet an
        // executable anchor. Preserve any intermediate step but strip a model's
        // premature followsBridge flag deterministically.
        raw = {...raw, choices:raw.choices.map((choice:any)=>({...choice,followsBridge:false}))};
      }
      const unlinked = (value: any) => ({...value, choices: Array.isArray(value?.choices) ? value.choices.map((c:any)=>({...c,followsBridge:false,advancesBridge:false})) : value?.choices});
      let scene: GeneratedScene;
      if (raw.outcome === 'active' && Array.isArray(raw.choices) && raw.choices.length < 2) {
        const repaired = await readAiJson(client, jsonRequest(client, 'bookrpg_free_menu_repair',
          [...policy,
            'Repair ONLY the choices for this unchanged candidate scene. Return two to four executable choices grounded in its final state.',
            'Do not repeat or paraphrase selectedInput: that action has just been consumed and is already past.',
            'Preserve the scene exactly; do not add bridge metadata merely to satisfy this repair.'].join('\n'),
          {...context, candidate:{...raw,choices:[]}, repairFeedback:'The generated menu repeated the just-consumed selectedInput.'},
          {type:'object',additionalProperties:false,properties:{choices:sceneSchema.properties.choices},required:['choices']}, 1600));
        raw = {...raw, choices:(repaired?.choices ?? []).filter((choice:any) =>
          choice?.type !== 'action' || !choiceParaphrasesConsumedAction(choice.text ?? '', selectedInput))};
      }
      try { scene = parseFreeScene(unlinked(raw), game); }
      catch (error) {
        if (!(error instanceof FreeConversationError)) throw error;
        traceEvent('free_world.menu_repair', {reason: error.message, choices: raw.choices});
        const validChoices = raw.choices.filter((c: any) => !conversationTarget(c, raw, game).reason);
        if (validChoices.length >= 2) raw = {...raw, choices: validChoices};
        else {
          const repaired = await readAiJson(client, jsonRequest(client, 'bookrpg_free_menu_repair',
            [...policy, 'Repair ONLY the choices for this unchanged candidate scene. Return two to four executable choices grounded in its final state. Preserve usable choices where possible. Never add a character to scope or change the scene to make a conversation possible. If speech is unavailable, offer action choices appropriate to the player capabilities.'].join('\n'),
            {...context, candidate: raw, validChoices, repairFeedback: error.message},
            {type:'object',additionalProperties:false,properties:{choices:sceneSchema.properties.choices},required:['choices']}, 1600));
          raw = {...raw, choices: repaired?.choices};
        }
        scene = parseFreeScene(unlinked(raw), game);
      }
      const reviewPolicy = policy.filter(rule => !/preparedOpportunity|followsBridge|advancesBridge|prepared bridge/i.test(rule));
      const activePrelude = bridge && game.returnPlanning?.activeBridgeId === bridge.id ? bridge.canonicalPrelude ?? null : null;
      const review = await readAiJson(client, jsonRequest(client, 'bookrpg_free_scene_review',
        [...reviewPolicy, 'Review only the response to selectedInput, continuity, agency, capabilities, world rules, novelty, presence, actual deaths and choice executability. A custom action need not match the previous menu or move toward any plot, destination or decision boundary. No prepared route is part of this review. Require concrete evidence for a failure.',
          'If selectedInput directly addresses a present character, accept only when candidate.text contains a concrete immediate response that acknowledges the substance of the player\'s speech. A vague mention that the character listens, speaks indistinctly, nods, or sounds reassuring without showing what they actually communicate is insufficient. A grounded explicit refusal or deliberate silence may count when the scene makes that reaction concrete.',
          ...(bridge?.target?.action ? ['reservedBridgeTargetAction is an UNCHOSEN future player action. Reject candidate prose if the player visibly performs or begins that action merely because a return bridge exists. It may be motivated and offered in the menu, but must remain future until selected. Do not require the scene to move toward it.'] : []),
          ...(activePrelude ? ['reservedCanonicalPrelude lists source actions that must remain wholly future during this selected bridge step. Reject the scene if candidate prose performs, completes, assumes the resulting state of, or skips across any listed reserved action. Ordinary movement that merely reaches the point where the first reserved action can happen is allowed.'] : []),
          ...(kind === 'event' ? ['For eventChecks, separately verify eventResolution (all stated material effects occur as the central development), continuity (no replay or reversal of played facts), playerAgency (no unchosen voluntary player action), and deathConsistency (actual victims, death metadata, memory, living scope and choices agree). Pass every check before accepting. Quote the exact contiguous passage establishing the new world event in eventEvidence; a title, menu or vague reference is insufficient. Return null if absent. Semantic sufficiency still requires eventResolution to pass. On repair, reassess repairFeedback against the new candidate.'] : []),
        ].join('\n'),
        {...freeWorldContext(game), selectedInput, inputKind:kind, candidate:unlinked(raw),
          ...(bridge?.target?.action ? {reservedBridgeTargetAction:bridge.target.action} : {}),
          ...(activePrelude ? {reservedCanonicalPrelude:activePrelude} : {}), repairFeedback:failures.at(-1) ?? null},
        kind === 'event' ? eventReviewSchema : reviewSchema, 2400));
      if (kind === 'event') {
        for (const name of eventCheckNames) {
          const check = review?.eventChecks?.[name];
          if (check?.status !== 'pass' || typeof check.reason !== 'string' || !check.reason.trim())
            throw new Error(`World event ${name}: ${check?.reason || 'missing or uncertain review'}`);
        }
        if (typeof review.eventEvidence !== 'string' || !review.eventEvidence.trim() || !scene.text.includes(review.eventEvidence))
          throw new Error('World event lacks reviewed evidence in the scene text');
      }
      if (review?.accepted !== true || typeof review.reason !== 'string') throw new Error(review?.reason || 'Review unavailable');
      // Optional metadata must never reject an otherwise accepted free turn.
      if (bridge && scene.outcome === 'active') {
        try {
          let linked: GeneratedScene;
          const linkReview = await readAiJson(client, jsonRequest(client, 'bookrpg_free_bridge_review',
            ['FIELD ROLES ARE STRICT: selectedInput is the player action that has ALREADY been resolved by candidate.text. It is never the bridge target. preparedOpportunity.target.action and proposedAnchor.text are the ONLY action to assess as the bridge target. Never describe, classify or reject selectedInput as though it were proposedAnchor.',
          'The prepared bridge has priority as the next optional menu route. Do not reject it for being off-topic, surprising, stylistically awkward, or unrelated to selectedInput. Player desirability is irrelevant. Assess only whether it is obsolete, whether its concrete prerequisites hold, and whether a claimed bridge step/anchor is executable and grounded.',
          'Assess the cached target independently of writer flags. targetStatus is obsolete ONLY after an irreversible accepted world change makes this exact player action impossible or nonsensical: for example a required living participant died, a required object was destroyed beyond recovery, or the target resultingState has already been permanently established. Merely taking other actions, talking, waiting, moving elsewhere, changing topic, lacking a temporary prerequisite, or the story feeling past the moment NEVER makes the target obsolete; those cases are pending. ready means the exact preparedOpportunity.target.action can begin now from the accepted scene. Never require thematic relevance or plot progress. Quote exact contiguous candidate.text passages in targetEvidence for ready or obsolete; menu text and planned events are not evidence.',
          'Separately set targetAlreadyPerformed=true when candidate.text visibly shows the PLAYER beginning or completing preparedOpportunity.target.action, or already establishes its resultingState as the consequence of that player action. This is not readiness: the reserved voluntary target must remain unperformed until selected. Quote the exact candidate.text sentence(s) in targetPerformedEvidence. Static prerequisites alone are not performance. If the action remains wholly future, set targetAlreadyPerformed=false and targetPerformedEvidence=[].',
          'When preparedOpportunity.canonicalPrelude is non-null, its beats are reserved and have NOT happened: targetStatus must remain pending unless the target is obsolete. Never use free-world prose to credit those beats or expose proposedAnchor yet. Assess only a claimed advancesBridge step that reaches a plausible handoff before the first reserved beat.',
          'For a canonicalPrelude, set preludeReady true only when candidate.text and final scene state have reached a stable handoff where the FIRST reserved beat can happen next without another meaningful player decision, while NONE of the reserved beats or their resulting states have happened yet. Quote exact candidate.text support in preludeEvidence. If another free-world step is still needed, set preludeReady false. Without canonicalPrelude return preludeReady null and preludeEvidence [].',
          'Otherwise, when ready, assess proposedAnchor as the anchor even if the writer omitted or misclassified it. Return bridgeReadiness and bridgeEvidence for that proposed action. Do not perform it: only offer it. Existing scene circumstances can establish the opportunity; a new stimulus is not required. When obsolete, do not approve any link.',
          'When targetStatus is pending, the prepared return route has menu priority. Inspect candidate.choices as zero-based choices. If one existing ACTION is an honest executable next step toward the missing prerequisite or toward the handoff before canonicalPrelude, return its index in bridgeStepChoiceIndex. If none does, but a single immediate voluntary step can be safely offered from the visible scene, write that direct selectable action in bridgeStepText. Never synthesize the target action itself while it is pending, never perform a reserved canonicalPrelude beat, never assume an absent character participates, and never hide another meaningful decision inside the step. Use null for the index/text when no honest return step exists yet.',
          'Assess ONLY optional bridge metadata on this already accepted scene. selectedInput has already happened and does not have to follow the bridge. Its subject matter, danger, wisdom, morality or relationship to canon is NOT a reason to mark the prepared target pending. preparedOpportunity.leadIn is planning material, never evidence by itself: judge only what candidate.text actually narrated. If the prose used the lead-in, it must remain causally compatible with played history and must stop before any unchosen player action or target action. Do not reject the scene or require progress. Reject only an unsupported claimed link.',
          'accepted describes whether the claimed bridge metadata is grounded. A merely pending target is not itself a rejection. If targetStatus is ready and bridgeReadiness/evidence prove the proposedAnchor, accepted should be true. If bridgeStepChoiceIndex or bridgeStepText identifies a grounded intermediate step, accepted should be true. Explain concrete missing prerequisites, never preference or topic mismatch.',
          'For an intermediate bridge step, bridgeStepEvidence must quote candidate.text establishing the visible circumstance that makes that step executable or motivated. The choice text itself is not evidence. Use bridgeStepChoiceIndex for an existing candidate action; use bridgeStepText only when no candidate action serves. Return bridgeStepEvidence null when neither is supplied. It never credits a canonical beat.',
          'For a followsBridge choice, separately assess bridgeReadiness: ready requires all target.requiredSituation prerequisites, including the required location, to hold in candidate final state. A looser requiredSituation must never override the source-required destination in target.resultingState; actionMatches requires the choice to execute target.action, not merely approach its location or follow its theme. Supply exact candidate.text quotations in evidence establishing readiness, plus a reason comparing the choice with target.action and resultingState. Fail or uncertainty means no anchor. If targetStatus is not ready and no choice followsBridge, return bridgeReadiness null.',
          'bridgeEvidence is supplemental compatibility evidence, not a second mandatory proof channel. When targetStatus is ready and grounded targetEvidence plus grounded bridgeReadiness.evidence already prove proposedAnchor, bridgeEvidence MAY be null. If bridgeEvidence is supplied, it must quote an exact candidate.text passage and must be grounded. When no anchor is used, bridgeEvidence must be null.'].join('\n'), {...context,candidate:raw,proposedAnchor:{text:bridge.choiceText,type:'action'}}, bridgeReviewSchema,2000));
          const targetEvidence = linkReview?.targetEvidence;
          const groundedTargetEvidence = groundedEvidence(scene.text, targetEvidence);
          const performedEvidence = groundedEvidence(scene.text, linkReview?.targetPerformedEvidence);
          if (linkReview?.targetAlreadyPerformed === true) {
            throw new BridgeTargetLeakError(performedEvidence.length
              ? 'Free scene performed the reserved bridge target before selection'
              : 'Bridge reviewer reports reserved target performance without grounded evidence');
          }
          const reviewedTargetStatus = bridge.canonicalPrelude?.beats.length && linkReview?.targetStatus === 'ready'
            ? 'pending' : linkReview?.targetStatus;
          const groundedTarget = groundedTargetEvidence.length > 0;
          traceEvent('free_world.bridge_target_status', {bridgeId:bridge.id,status:reviewedTargetStatus,reason:linkReview?.reason,
            evidence:targetEvidence,groundedEvidence:groundedTargetEvidence});
          if (reviewedTargetStatus === 'obsolete') {
            if (!groundedTarget) throw new Error('Obsolete bridge lacks scene evidence');
            return {...scene,obsoleteBridgeEvidence:groundedTargetEvidence};
          }
          if (reviewedTargetStatus === 'ready') {
            if (!groundedTarget) throw new Error('Ready bridge lacks scene evidence');
            const alternatives = unlinked(raw).choices.filter((c:any)=>cleanChoiceText(c.text) !== cleanChoiceText(bridge.choiceText));
            raw = {...raw,choices:[{text:bridge.choiceText,type:'action',character:null,followsBridge:true,advancesBridge:false},...alternatives.slice(0,3)]};
          } else if (reviewedTargetStatus === 'pending') {
            const choices = Array.isArray(raw.choices) ? raw.choices : [];
            const reviewedIndex = Number.isInteger(linkReview.bridgeStepChoiceIndex)
              && linkReview.bridgeStepChoiceIndex >= 0
              && linkReview.bridgeStepChoiceIndex < choices.length
              && choices[linkReview.bridgeStepChoiceIndex]?.type === 'action'
                ? linkReview.bridgeStepChoiceIndex : null;
            const reviewedText = typeof linkReview.bridgeStepText === 'string' && linkReview.bridgeStepText.trim()
              ? cleanChoiceText(linkReview.bridgeStepText) : null;
            if ((reviewedIndex !== null || reviewedText)
              && !evidenceGrounded(scene.text, linkReview.bridgeStepEvidence))
              throw new Error('Intermediate bridge step lacks reviewed evidence');

            const reset = choices.map((choice:any)=>({...choice,followsBridge:false,advancesBridge:false}));
            if (reviewedIndex !== null) {
              reset[reviewedIndex] = {...reset[reviewedIndex],advancesBridge:true};
              raw = {...raw,choices:reset};
            } else if (reviewedText) {
              const alternatives = reset.filter((choice:any)=>cleanChoiceText(choice.text) !== reviewedText);
              raw = {...raw,choices:[
                {text:reviewedText,type:'action',character:null,followsBridge:false,advancesBridge:true},
                ...alternatives.slice(0,3),
              ]};
            } else {
              raw = {...raw,choices:reset};
            }
          }
          linked = parseFreeScene(raw, game, bridge);
          const linkedStep = linked.choices.some(c => c.bridgeStepId);
          let canonicalPreludeReady = false;
          if (bridge.canonicalPrelude?.beats.length) {
            if (linkReview.preludeReady === true) {
              if (!Array.isArray(linkReview.preludeEvidence) || !linkReview.preludeEvidence.length
                || !linkReview.preludeEvidence.every((quote:unknown)=>evidenceGrounded(linked.text, quote)))
                throw new Error('Canonical bridge prelude lacks reviewed handoff evidence');
              canonicalPreludeReady = true;
            } else if (linkReview.preludeEvidence?.length) {
              throw new Error('Canonical bridge prelude evidence supplied without readiness');
            }
          }
          const linkedAnchor = linked.choices.some(c => c.bridgeId);
          if (linkedAnchor) {
            const readiness = linkReview.bridgeReadiness;
            const groundedReadinessEvidence = groundedEvidence(linked.text, readiness?.evidence);
            traceEvent('free_world.bridge_readiness', {bridgeId:bridge?.id, target:bridge?.target, review:readiness ?? null,
              groundedEvidence:groundedReadinessEvidence});
            if (!bridge?.target || readiness?.ready !== true || readiness?.actionMatches !== true
              || typeof readiness.reason !== 'string' || !readiness.reason.trim()
              || groundedReadinessEvidence.length === 0)
              throw new Error('Bridge target is not ready or choice does not perform the target player beat');
            if (linkReview.bridgeEvidence !== null
              && !evidenceGrounded(linked.text, linkReview.bridgeEvidence))
              throw new Error('Bridge choice supplied ungrounded supplemental evidence');
          } else if (!bridge.canonicalPrelude?.beats.length && linkReview.bridgeEvidence !== null)
            throw new Error('Unused bridge must have null evidence');

          // Specific grounded link checks outrank the review's generic accepted bit.
          // This prevents an otherwise valid return route from being dropped merely
          // because the reviewer disliked or confused the already-played selectedInput.
          if (linkReview?.accepted !== true && !linkedAnchor && !linkedStep && !canonicalPreludeReady)
            throw new Error(linkReview?.reason || 'Optional link not accepted');

          const priorityChoices = [
            ...linked.choices.filter(c => c.bridgeId || c.bridgeStepId),
            ...linked.choices.filter(c => !c.bridgeId && !c.bridgeStepId),
          ];
          linked = {...linked, choices:priorityChoices};
          return canonicalPreludeReady ? {...linked, canonicalPreludeReady:true} : linked;
        } catch (error) {
          if (error instanceof BridgeTargetLeakError) throw error;
          traceEvent('free_world.bridge_omitted', {bridgeId:bridge.id, reason:error instanceof Error ? error.message : String(error)});
        }
      }
      return scene;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      traceEvent('free_world.rejection', {attempt: attempt + 1, reason});
      failures.push(reason);
    }
  }
  throw new SceneGenerationError(failures, 3);
}


const TALK_ACTION_PREFIX =
  /^(?:talk\s+to|step|move|take|go|walk|run|edge|head|enter|leave|return|approach|follow|inspect|search|wait|watch|look|listen|grab|hold|carry|open|close)\b/i;

export function isConversationUtterance(value: unknown, character: string): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > 180 || text.split(/\s+/).length > 24 || TALK_ACTION_PREFIX.test(text)) return false;
  const target = character.trim().replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
  // "Ask Uncle Henry..." / "Tell Uncle Henry..." describe a UI action; exact
  // speech addressed to him would use "you" or direct address instead.
  return !new RegExp(`^(?:ask|tell|say\\s+to|speak\\s+to)\\s+${target}\\b`, 'i').test(text);
}

/** Conversation suggestions use free-play history/capabilities, never source navigation or scene-choice policy. */
export async function startFreeWorldTalk(game: GameState, character: string, suppliedClient?: AiClient): Promise<import('../shared/contracts.js').TalkResponse> {
  const failure = spokenDialogueCapabilityFailure(game.playerName, character, game.characterProfiles);
  if (failure) throw new Error(failure);
  if (game.scene.sceneScope && !game.scene.sceneScope.peopleWithinSpeakingDistance.includes(character)) throw new Error('Character is not within speaking distance');
  const prompt = `${game.playerName}, what do you say to ${character}?`;
  if (process.env.BOOKRPG_FAKE_AI === '1') return {character, prompt, suggestions: ['What is happening?', 'Are you all right?', 'What should we do?']};

  const client = suppliedClient ?? createAiClient();
  const talkPolicy = [
    ...PLAYER_PERSPECTIVE_POLICY,
    ...CHARACTER_RUNTIME_RULES,
    PLAYED_HISTORY_POLICY,
    'Generate exactly three short, distinct things the player could SAY aloud to the target character right now.',
    'Every suggestion is the player\'s exact spoken words, ready to send unchanged as PLAYER\'S UTTERANCE. It is not an action label, narration, stage direction, plan description, or instruction about what to say.',
    'Use first-person wording for the player when needed (I/me/my) and address the target as you or by direct name. Never refer to the player as a separate named character.',
    'Examples: return "Should we get inside?" rather than "Ask Uncle Henry if we should get inside"; return "I’m scared of this storm." rather than "Talk to Uncle Henry about being scared".',
    'Do not begin suggestions with movement or menu-action verbs such as Talk to, Step, Move, Take, Go, Walk, Run, Watch, Look, Wait, Inspect, Search, or Follow.',
    'Do not make the target answer yet. Opening this conversation does not advance time, move anyone, perform an action, or alter the current scene.',
    'Use only currentScene, played history, current character state and active worldRules. There is no required canonical topic and no source-navigation goal.',
    'Keep each utterance concise (normally under 12 words; hard maximum 24 words).',
  ].join('\n');
  const schema = {type:'object',additionalProperties:false,properties:{
    suggestions:{type:'array',minItems:3,maxItems:3,items:{type:'string',minLength:1,maxLength:180}},
  },required:['suggestions']};

  const failures: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await readAiJson(client, jsonRequest(client, 'bookrpg_free_talk', talkPolicy,
      {...freeWorldContext(game), character, ...(failures.length ? {repairFeedback:failures} : {})}, schema, 500));
    const suggestions = Array.isArray(result?.suggestions)
      ? result.suggestions.map((value:unknown)=>typeof value === 'string' ? value.trim() : value)
      : [];
    const invalid = suggestions.filter((value:unknown)=>!isConversationUtterance(value, character));
    if (suggestions.length === 3 && invalid.length === 0
      && new Set(suggestions.map((x:string)=>x.toLocaleLowerCase())).size === 3)
      return {character, prompt, suggestions};
    failures.push(`Suggestions must be three distinct exact spoken utterances; invalid: ${JSON.stringify(invalid.length ? invalid : suggestions)}`);
    traceEvent('free_world.talk_rejection',{attempt:attempt+1,reason:failures.at(-1)});
  }
  throw new Error('Invalid conversation suggestions');
}
