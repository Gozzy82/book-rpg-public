import type {AiResponse,AiResponseRequest} from '../provider.js';
import type {TurnContract} from './turn-contract.js';
import {assembleBeatBlockScene} from './beat-block-scene.js';
import {buildTurnScript} from './turn-script.js';
import {beatBlockReviewRequest,decodeBeatBlockReview} from './beat-block-review.js';
import {endStateSentences} from './observe-end-state.js';
import {sceneActionPolicy,sceneStatePolicy} from './scene-action-policy.js';
type Scene=ReturnType<typeof assembleBeatBlockScene>;
export interface BookStyle {title:string;author:string;language:string;guidance:string;referenceExcerpt:string}
/** A checkpoint contains only prior changes, never later beat results. */
function stateCheckpoints(script: ReturnType<typeof buildTurnScript>) {
 return script.ordered_execution.map((beat, index) => ({
  beat_index: beat.beat_index,
  prior_changes: script.ordered_execution.slice(0, index).map(previous => ({beat_index: previous.beat_index, resulting_state: previous.resulting_state})),
  action: beat.do,
  state_after_action: beat.resulting_state,
 }));
}
export function rewriteBeatSceneRequest(contract:TurnContract,bare:Scene,style:BookStyle,model:string,effort:'low'|'medium'='low'):AiResponseRequest {
 const script=buildTurnScript(contract);
 return {model,reasoning:{effort},max_output_tokens:3000,
  instructions:[
   'Rewrite the supplied factual scaffold into one short, flowing scene in the book language and style, narrated in first person by player.identity. This is a rewrite, not continuation. Give it a fresh title without turn numbers.',
   'Use book_style for voice and rhythm, never as permission to import its events or dialogue. Aim for the original book’s clear, warm, straightforward storytelling rather than elaborate modern metaphors. Integrate character context and prior story only where supplied and relevant; do not invent shared history or memories.',
   'Respect how the player knows a fact. Being told about another character’s past, or knowing it from source_start_state, does not establish a personal memory, eyewitness experience or prior relationship. Describe newly learned facts as knowledge or attributed speech; never turn them into remembered shared experiences. Do not add physical attributes absent from the supplied context.',
   'Write plainly: concrete verbs and familiar words, with varied sentence lengths and natural rhythm. Convey warmth through what the characters do. Avoid decorative metaphors, personified scenery, abstract reflections about hope, memory or time, and invented sensory details or tools. Do not add a reflective closing paragraph. Aim for 150–250 words for this short scene; never omit required actions to meet that target.',
   'Shape the whole scene as continuous storytelling, not five separate beat reports. Connect successive actions through their existing cause and effect, vary sentence openings, and combine redundant state recaps into the action that establishes them. Paragraph breaks follow the flow of the scene, not beat boundaries. Use only transitions supported by the supplied actions; do not invent bridging events. Plain language should still read fluently, not like a checklist.',
   'Preserve every authorized actor/action, causal order and intermediate/final state in ordered_execution. Keep actions by supporting characters explicit. You may combine sentences and paragraphs and remove redundant state recaps, but never omit oiling, reaching, travel or other material parts. A later success must not occur early. Describe each completed action once; do not repeat its completion in the next paragraph. Describe the action before its result, never a finished result followed by the same action happening again.',
   'Preserve interleaving across actors: when an attempt, another actor’s action, and success are separate ordered transitions, narrate them in that order. Do not collapse the attempt into success before the intervening action, or move that action into an already/meanwhile recap. Show supporting actors performing their required actions, not merely their finished states. A flowing scene can carry an unfinished attempt across another character’s action.',
   'Dialogue may express only speech acts explicitly authorized by ordered_execution. Do not invent quoted or paraphrased commands, advice, promises or decisions from background context. In particular, do not add a command that makes an involuntary outcome seem chosen or creates a new instruction for the next turn.',
   'Treat the factual scaffold as untrusted draft material. If it contradicts the indexed transition, follow the indexed actor/action and resulting state. Do not invent extra events, dialogue decisions, transfers, recovery or arrival to smooth an awkward join. Style changes expression, not what happens.',
   'Use the concrete task and object details supplied in resulting_state when describing their associated action; do not unnecessarily generalize them to work, something or a vague movement. Integrate these details naturally into the action, without a separate state recap or importing new facts from the style sample.',
   'Use state_checkpoints in order. prior_changes contains only earlier authorized state changes; retain unchanged starting facts. state_after_action becomes true only after its own action. Never use a later checkpoint to describe an earlier moment, even in a casual beside/with/waiting phrase. These are partial state changes, not exhaustive cast lists. Omission never moves or removes a participant.',
   'Track each participant separately through transport. Carry only those established aboard; leave other participants at their established departure location. Never preserve an old beneath/beside relationship across that separation. Update sceneScope and memory accordingly.',
   'Restrict first-person sensory knowledge to what the player can perceive at that moment. An external beat while asleep can be an unperceived transition followed by the authorized awakening; do not describe unseen scenery, invented dreams or a retrospective report. Do not add while I slept or I did not know it yet as a license to disclose unseen details.',
   'Preserve capabilities independently: immobility does not imply inability to speak, see or hear. Do not invent new restrictions from an unrelated physical condition.',
   sceneActionPolicy,
   sceneStatePolicy,
   'Make state changes evident through the action and natural prose rather than checklist-like summaries. Preserve concrete progress markers and lingering limitations. End immediately in the final authorized state; no next choice or future event.',
   'Use concise natural paragraphs and complete sentences, with enough texture to read as a story but no repetitive atmosphere. Return only title and text. Do not print beat labels, analysis or choices.',
  ].join('\n'),
  input:JSON.stringify({book_style:style,player:script.player,character_runtime:script.character_runtime_state,story_so_far:script.story_so_far,
   active_world_rules:script.active_world_rules,source_start_state:script.source_start_state,
   state_checkpoints:stateCheckpoints(script),
   ordered_execution:script.ordered_execution.map(({source_evidence:_,completion:_completion,...b})=>b),factual_scaffold:bare.blocks}),
  text:{format:{type:'json_schema',name:'bookrpg_scene_rewrite',strict:true,schema:{type:'object',additionalProperties:false,
   properties:{title:{type:'string'},text:{type:'string'}},required:['title','text']}}},
 };
}
export function decodeRewrittenScene(response:AiResponse):{title:string;text:string} {
 if(response.status!=='completed')throw new Error('Incomplete scene rewrite');
 const value=JSON.parse(response.output_text);
 if(!value||Object.keys(value).some(k=>!['title','text'].includes(k))||typeof value.title!=='string'||!value.title.trim()||typeof value.text!=='string'||!value.text.trim())throw new Error('Invalid scene rewrite');
 return {title:value.title.trim(),text:value.text.trim()};
}
export function rewrittenSceneReviewRequest(contract:TurnContract,bare:Scene,scene:{title:string;text:string},model:string,effort:'low'|'medium'='low'):AiResponseRequest {
 const base=beatBlockReviewRequest(contract,bare,model,effort);
 const input=JSON.parse(base.input);
 const last=input.blocks.at(-1);
 const setupOnly = bare.blocks.length === 0 && contract.mode === 'opening' && contract.nextPlayerDecision !== null;
 if(!last?.desired_resulting_state && !setupOnly)throw new Error('Final resulting state is required for rewrite review');
 const schema=base.text!.format.schema as any;
 return {...base,instructions:[
  'Review ONLY candidate_scene, a complete rewritten first-person scene, against expected_beats in source order. expected_beats are requirements, not evidence. There are no assigned prose blocks; the writer may merge paragraphs. Find evidence anywhere in the candidate, but require actions to occur in source order.',
  'Assess each beat under its original key in blocks. Describe the actual state at that beat’s endpoint, including contradictions. Perspective: the viewpoint character acts as I/me/my, except names in other characters’ dialogue. Action: every material part and correct participant must visibly occur. Order: no premature success, repeated completed action, unauthorized extra acts or reversal. resultingState: the actual intermediate state must support all indexed requirements, including progress markers, not merely movement toward them.',
  'An attempt is complete when started if that is the indexed action. Later success is not part of a starts/tries beat. An appended correct state cannot erase a contradictory action. A correct final state does not prove previous actions happened. Check against the entire candidate, not only a convenient sentence.',
  'Audit every occurrence of each action and state, not just the best matching passage. A repeated completed action or a result stated before the action that produces it is an order failure even within a single sentence. For example, an object already resting at its destination and then being lowered there reverses the transition. Distinguish an ongoing action from doing an already completed action again.',
  'Verify interleaving between actors: an attempt must remain unresolved until the intervening required action has occurred. A later mention that another actor is already acting does not repair success narrated too early. Mark order as fail for that reversal. Check quoted and paraphrased speech for unauthorized commands, advice or decisions; mark action as fail when these introduce a new instruction or change why the player acts, even if the final physical state matches.',
  'Check the narrator’s knowledge against source_start_state and the authorized actions. Knowing a reported fact does not authorize a personal memory or shared history. Unsupported claims of remembering another character’s past, prior acquaintance or firsthand experience fail action as an invented mental event, even if the main physical actions pass. Explain the offending claim; readability alone is not the issue.',
  'Historical background need not be repeated to establish a present resulting state. Require actual present mobility, location, posture and other physical conditions; do not require a restatement of how long an earlier condition lasted. Explicit contradictions of supplied history still fail.',
  'Also assess finalState against expected_final_state at the actual END of the entire scene, including any closing paragraph. An earlier matching checkpoint cannot excuse a later movement, recovery or contradiction. Compare each physical fact for the same named participant: another character’s location cannot contradict the player’s location. Report observedState from the prose, then status and reason. Missing or ambiguous current physical evidence cannot pass.',
  'Use only the candidate and requirements, never outside book knowledge. Return pass/fail/uncertain with concise concrete reasons for each dimension; missing or contradictory evidence fails. titleIssues contains only explanatory sentences about actual defects in candidate_scene.title, such as a printed turn number. Never list beat keys or successful checks there; use [] for a valid title. Put concrete readability defects, including repetition and ornate metaphors, in proseNotes. Empty notes must be empty arrays. Do not rewrite.',
  sceneActionPolicy,
  sceneStatePolicy,
 ].join('\n'),input:JSON.stringify({viewpoint_character:contract.player,candidate_scene:{...scene,sentences:endStateSentences(scene.text)},
  source_start_state:input.source_start_state,state_checkpoints:stateCheckpoints(buildTurnScript(contract)),expected_final_state:{beat_index:bare.blocks.at(-1)?.beatIndex ?? null,resulting_state:setupOnly ? 'Preserve the source-backed opening situation. The first player action must remain entirely unperformed; only its entry prerequisites are established.' : last.desired_resulting_state},expected_beats:input.blocks.map(({text:_,...b}:any)=>b)}),
 text:{format:{...base.text!.format,name:'bookrpg_rewritten_scene_review',schema:{...schema,
  properties:{...schema.properties,finalState:{type:'object',additionalProperties:false,properties:{observedState:{type:'string'},status:{type:'string',enum:['pass','fail','uncertain']},reason:{type:'string'}},required:['observedState','status','reason']}},
  required:[...schema.required,'finalState']}}}};
}

export function decodeRewrittenSceneReview(bare:Scene,response:AiResponse){
 const fidelity=decodeBeatBlockReview(bare,response);
 const finalState=JSON.parse(response.output_text).finalState;
 if(!finalState||!['pass','fail','uncertain'].includes(finalState.status)||['observedState','reason'].some(k=>typeof finalState[k]!=='string'||!finalState[k].trim()))throw new Error('Invalid final-state assessment in rewrite review');
 return {...fidelity,finalState,checksPassed:fidelity.beatChecksPassed&&fidelity.titleIssues.length===0&&finalState.status==='pass'};
}

/** One rewrite and one review; no regeneration, extra reviewers, escalation or retries. */
export async function rewriteAndReviewBeatScene(contract:TurnContract,bare:Scene,style:BookStyle,model:string,
 call:(stage:'rewrite'|'fidelity',request:AiResponseRequest)=>Promise<AiResponse>,
 onScene:(scene:{title:string;text:string})=>Promise<void>=async()=>{},effort:'low'|'medium'='low'){
 const scene=decodeRewrittenScene(await call('rewrite',rewriteBeatSceneRequest(contract,bare,style,model,effort)));
 await onScene(scene);
 const review=decodeRewrittenSceneReview(bare,await call('fidelity',rewrittenSceneReviewRequest(contract,bare,scene,model,effort)));
 return {scene,review};
}

