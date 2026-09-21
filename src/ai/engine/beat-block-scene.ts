import type {AiResponse, AiResponseRequest} from '../provider.js';
import type {TurnContract} from './turn-contract.js';
import {endStateObservationRequest,decodeEndStateObservation,endStateComparisonRequest,decodeEndStateComparison} from './observe-end-state.js';
import {buildTurnScript} from './turn-script.js';

function executionIndexes(contract:TurnContract):number[] {
 if(contract.sourceProgression!=='required')throw new Error('Beat-block pilot requires a canonical source window');
 const indexes=[...new Set([...contract.allowedPlayerBeatIndexes,...contract.requiredAutomaticBeatIndexes])].sort((a,b)=>a-b);
 if(!indexes.length||indexes.some(i=>!contract.beats[i]||contract.completedBeatIndexes.includes(i)))throw new Error('Missing or invalid authorized beats');
 return indexes;
}
/** One generation call; block identity/order is owned by code, prose remains reviewable evidence. */
export function beatBlockSceneRequest(contract:TurnContract,model:string,effort:'low'|'medium'='low'):AiResponseRequest {
 const indexes=executionIndexes(contract);
 const script=buildTurnScript(contract);
 const blockPlan=Object.fromEntries(indexes.map((i,position)=>{
  const previous=position>0?indexes[position-1]!:null;
  return [`beat_${i}`,{
   beat_index:i,
   start_state:previous===null?script.source_start_state:contract.beats[previous]!.resultingState??null,
   start_state_after_beat_index:previous,
   actor:contract.beats[i]!.actor,
   action:contract.beats[i]!.action,
   desired_resulting_state:contract.beats[i]!.resultingState??null,
  }];
 }));
 return {model,reasoning:{effort},max_output_tokens:4000,
  instructions:[
   'Write one continuous first-person scene as the player, using only the supplied turn script. Treat the story as unfamiliar; do not fill gaps from knowledge of the book.',
   'Return one prose block for EACH ordered_execution beat, in its keyed field. Read the whole authorized window first so the blocks connect naturally. Each block is the next paragraph in the SAME scene, not a separate scene or summary.',
   'Each output field has its own block_writing_plan: start_state -> action -> desired_resulting_state. Start from those already-established facts, narrate only this actor action, and make its consequences produce that endpoint. The next block begins there. States are partial: retain other established facts unless this action changes them; null means unspecified, never permission to invent.',
   'The desired_resulting_state must be true because of the prose you wrote, not because you append it as an assertion. Never write an incompatible action and then paste the expected state after it. Remove the incompatible action instead. A later success cannot happen early even if you subsequently claim the earlier state still holds.',
   'In each block visibly perform that exact actor action and reach its resulting_state before the following block. Beginning or trying is complete when the attempt visibly begins; do not perform a later catch in a starts-trying block. Carry the earlier posture, possession and location forward until an authorized action changes them.',
   'Use I/me/my for the player and names/pronouns for other actors. Include necessary NPC actions and dialogue from the player perspective. Do not repeat an earlier block or reopen an already completed action. Do not narrate actions from already_completed_beat_indexes.',
   'No later beat, recovery, arrival or new decision may occur early or after the final block. next_decision is not authorized. The final block must leave the player in its indexed resulting state.',
   'At the end of each block, make the relevant physical facts in resulting_state unambiguous in natural prose: location, posture, possession and other actors where specified. Preserve concrete progress markers such as halfway across a room. Do not merely restate an intention instead of reaching that checkpoint.',
   'Use literal spatial descriptions where movement or location matters. Metaphors must not imply arrival, descent, transfer or recovery that did not happen. Finish every block as complete sentences with normal punctuation; the final sentence must clearly preserve the final authorized state.',
   'Use concise natural prose, usually one to three sentences per block, with only enough atmosphere to connect the actions. No block headings, beat numbers, choices or internal field names in prose. The title has no turn number.',
   'Code will join the blocks with a blank line; there is no second rewrite. Make the blocks themselves read as a flowing scene. Return only the requested JSON.',
  ].join('\n'),
  input:JSON.stringify({turn_script:script,block_writing_plan:blockPlan}),
  text:{format:{type:'json_schema',name:'bookrpg_beat_block_scene',strict:true,schema:{
   type:'object',additionalProperties:false,properties:{title:{type:'string'},blocks:{type:'object',additionalProperties:false,
    properties:Object.fromEntries(indexes.map(i=>[`beat_${i}`,{type:'string',description:`Write only this transition: ${JSON.stringify(blockPlan[`beat_${i}`])}. The prose itself must produce the desired_resulting_state; do not append a contradictory state assertion.`}])),required:indexes.map(i=>`beat_${i}`)}},required:['title','blocks'],
  }}},
 };
}
export function assembleBeatBlockScene(contract:TurnContract,response:AiResponse) {
 if(response.status!=='completed')throw new Error(`Incomplete beat-block scene: ${JSON.stringify(response.incomplete_details)}`);
 const value=JSON.parse(response.output_text);
 const indexes=executionIndexes(contract),keys=indexes.map(i=>`beat_${i}`);
 if(!value||typeof value.title!=='string'||!value.title.trim()||!value.blocks||typeof value.blocks!=='object'||Array.isArray(value.blocks)
   ||Object.keys(value).some(k=>!['title','blocks'].includes(k))||Object.keys(value.blocks).length!==keys.length
   ||Object.keys(value.blocks).some(k=>!keys.includes(k))||keys.some(k=>typeof value.blocks[k]!=='string'||!value.blocks[k].trim()))
  throw new Error('Missing, empty or unauthorized scene blocks');
 const blocks=indexes.map(beatIndex=>({beatIndex,text:value.blocks[`beat_${beatIndex}`].trim()}));
 return {title:value.title.trim(),text:blocks.map(b=>b.text).join('\n\n'),blocks};
}

/** Review only final physical state; beat content/order still needs separate review. */
export async function reviewBeatBlockEnding(contract:TurnContract,text:string,model:string,effort:'low'|'medium',
 call:(stage:string,request:AiResponseRequest)=>Promise<AiResponse>) {
 const last=executionIndexes(contract).at(-1)!;
 const expected=contract.beats[last]!.resultingState;
 if(!expected)throw new Error('Missing final indexed resultingState');
 const observed=decodeEndStateObservation(await call('observe',endStateObservationRequest(text,contract.player,model,effort)),text);
 const comparison=decodeEndStateComparison(await call('compare',endStateComparisonRequest(observed,expected,contract.player,model,effort)));
 return {beatIndex:last,expected,observed,comparison};
}
