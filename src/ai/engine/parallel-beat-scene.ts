import type {AiResponse,AiResponseRequest} from '../provider.js';
import type {TurnContract} from './turn-contract.js';
import type {SceneScope} from '../../shared/contracts.js';
import {buildTurnScript} from './turn-script.js';
import {assembleBeatBlockScene} from './beat-block-scene.js';

/** Each writer sees only its own transition; neighbouring prose is never assumed to be validated. */
export interface BeatScopeContext {
 playerName:string;
 sceneScope:SceneScope;
}
export interface BeatScopeDelta {
 addPresent:string[];
 removePresent:string[];
 addSpeaking:string[];
 removeSpeaking:string[];
}
export interface BeatFinalScope {
 peoplePresent:string[];
 peopleWithinSpeakingDistance:string[];
}

const cleanNames=(values:unknown):string[]=>Array.isArray(values)
 ? [...new Set(values.filter((value):value is string=>typeof value==='string').map(value=>value.trim()).filter(Boolean))]
 : [];

export function parallelBeatRequests(contract:TurnContract,model:string,effort:'low'|'medium'='low',maxBeats=8,scopeContext?:BeatScopeContext) {
 if(contract.sourceProgression!=='required')throw new Error('Parallel pilot requires a canonical source window');
 const script=buildTurnScript(contract);
 const beats=script.ordered_execution;
 if(!Number.isInteger(maxBeats)||maxBeats<1||maxBeats>32)throw new Error('Invalid beat window limit');
 if(!beats.length||beats.length>maxBeats||new Set(beats.map(b=>b.beat_index)).size!==beats.length||beats.some(b=>contract.completedBeatIndexes.includes(b.beat_index)))throw new Error(`Parallel scene requires 1–${maxBeats} distinct unperformed beats`);
 const trackedCharacters=[...new Set([
  ...(scopeContext?.sceneScope.peoplePresent??[]),
  ...(scopeContext?.sceneScope.peopleWithinSpeakingDistance??[]),
  ...(scopeContext?[scopeContext.playerName]:[]),
  ...beats.flatMap(item=>[...(item.actor?[item.actor]:[]),...(item.targets??[])]),
 ].map(name=>name?.trim()).filter((name):name is string=>Boolean(name)))];
 return beats.map((beat,position)=>{
  const includeScopeDelta=Boolean(scopeContext&&trackedCharacters.length);
  const input={
   transition:{beat_index:beat.beat_index,actor:beat.actor,action:beat.do,
    start_state:position===0?script.source_start_state:beats[position-1]!.resulting_state,
    desired_resulting_state:beat.resulting_state,source_semantics:beat.source_semantics},
   ...(includeScopeDelta?{scope_context:{
    player_identity:scopeContext!.playerName,
    initial_scope:scopeContext!.sceneScope,
    tracked_characters:trackedCharacters,
   }}:{}),
  };
  const scopeInstructions=includeScopeDelta?[
   'SCOPE DELTA: also report only the spatial changes caused by THIS transition relative to the player. This is bookkeeping for peoplePresent/peopleWithinSpeakingDistance, not extra prose.',
   'addPresent: tracked characters newly established at the player’s location by this transition. removePresent: tracked characters this transition establishes are no longer at the player’s location. addSpeaking/removeSpeaking likewise record immediate nearby conversational reach.',
   'If this transition moves the player or a carrier containing the player to a new location, remove tracked characters established as remaining at the old/stationary location unless this transition explicitly carries or moves them with the player. A cellar, foundation, ground, dock, shore or bank does not travel with a departing carrier.',
   'If this transition explicitly moves another character away from the player (for example into a cellar while the player remains in the room), put that character in removePresent immediately on this beat. Do not wait for a later transport beat.',
   'Hiding within the same room does not by itself remove presence. Silence/nonverbal status does not remove presence. A partial resulting state that merely omits a character is not a departure.',
   'Use only exact names from tracked_characters. Do not add or remove the player identity; the server keeps the player present.',
  ]:[];
  const properties:any={text:{type:'string'}};
  const required=['text'];
  if(includeScopeDelta){
   const nameArray={type:'array',items:{type:'string',enum:trackedCharacters},maxItems:trackedCharacters.length};
   properties.scopeDelta={type:'object',additionalProperties:false,properties:{
    addPresent:nameArray,removePresent:nameArray,addSpeaking:nameArray,removeSpeaking:nameArray,
   },required:['addPresent','removePresent','addSpeaking','removeSpeaking']};
   required.push('scopeDelta');
  }
  const request:AiResponseRequest={model,reasoning:{effort},max_output_tokens:1600,
   instructions:[
    'Describe only the supplied transition in plain factual prose, usually one or two short sentences. Use explicit character names consistently in third person. This is factual intermediate material, not player-facing narration. No atmosphere, metaphors, emotions, memories, invented dialogue or extra actions. Use only the supplied facts, not knowledge of a book.',
    'Treat start_state only as prior context, not a sentence to copy into the output. Start the output with the action. Explicitly describe every part of action with the assigned participants and objects; do not transfer a task or object to another actor unless action says so. A resulting state does not replace the action that produces it.',
    'Describe action first, then only its new resulting state. Never return to an earlier state after the action has changed it: a limitation removed by this action must not be described as still present afterward. Retain only limitations that remain in desired_resulting_state. Preserve the stated location, posture, possession, remaining limitations and progress markers. Starting an attempt does not authorize completing its goal. Do not append a state assertion that contradicts what you described.',
    'Keep other facts unchanged or unspecified; omit unknown locations rather than guessing alternatives. Source semantics may distinguish telling from doing; do not reenact narrated history. Stop at this endpoint.',
    ...scopeInstructions,
    'Return only the requested structured fields, with complete factual sentences in text and no heading.',
   ].join('\n'),input:JSON.stringify(input),
   text:{format:{type:'json_schema',name:'bookrpg_single_beat_scene',strict:true,schema:{type:'object',additionalProperties:false,properties,required}}},
  };
  return {beatIndex:beat.beat_index,request,includeScopeDelta};
 });
}

function applyScopeDeltas(initial:SceneScope,playerName:string,blocks:readonly {scopeDelta?:BeatScopeDelta}[]):BeatFinalScope {
 const present=new Set(cleanNames(initial.peoplePresent));
 const speaking=new Set(cleanNames(initial.peopleWithinSpeakingDistance));
 present.add(playerName);
 speaking.add(playerName);
 for(const block of blocks){
  const delta=block.scopeDelta;
  if(!delta)continue;
  for(const name of delta.removePresent)if(name!==playerName)present.delete(name);
  for(const name of delta.addPresent)present.add(name);
  for(const name of delta.removeSpeaking)if(name!==playerName)speaking.delete(name);
  for(const name of delta.addSpeaking)if(present.has(name))speaking.add(name);
  for(const name of [...speaking])if(!present.has(name))speaking.delete(name);
 }
 present.add(playerName);
 speaking.add(playerName);
 return {peoplePresent:[...present],peopleWithinSpeakingDistance:[...speaking]};
}

function incompleteReason(response:AiResponse):string|undefined {
 const details=response.incomplete_details;
 if(!details||typeof details!=='object'||!('reason' in details))return undefined;
 const reason=(details as {reason?:unknown}).reason;
 return typeof reason==='string'?reason:undefined;
}

export async function generateParallelBeatScene(contract:TurnContract,model:string,effort:'low'|'medium',
 call:(beatIndex:number,request:AiResponseRequest)=>Promise<AiResponse>,options:{maxBeats?:number;concurrency?:number;scopeContext?:BeatScopeContext}={}) {
 const requests=parallelBeatRequests(contract,model,effort,options.maxBeats??8,options.scopeContext);
 const concurrency=options.concurrency??8;
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('Invalid beat concurrency');
 const results:Array<PromiseSettledResult<{beatIndex:number;text:string;scopeDelta?:BeatScopeDelta}>>=new Array(requests.length);
 let next=0;
 const generate=async({beatIndex,request,includeScopeDelta}:typeof requests[number])=>{
  let attemptRequest=request;
  let response!:AiResponse;
  for(let attempt=0;attempt<3;attempt++){
    response=await call(beatIndex,attemptRequest);
    if(response.status==='completed')break;
    if(incompleteReason(response)!=='max_output_tokens'||attempt===2)break;
    attemptRequest={
      ...attemptRequest,
      max_output_tokens:Math.min(6400,Math.max(1,attemptRequest.max_output_tokens??1600)*2),
    };
  }
  if(response.status!=='completed')throw new Error(`Incomplete beat ${beatIndex}: ${JSON.stringify(response.incomplete_details)}`);
  const value=JSON.parse(response.output_text);
  if(!value||typeof value.text!=='string'||!value.text.trim())throw new Error(`Invalid text for beat ${beatIndex}`);
  let scopeDelta:BeatScopeDelta|undefined;
  if(includeScopeDelta&&value.scopeDelta!==undefined){
   const delta=value.scopeDelta;
   if(!delta||!['addPresent','removePresent','addSpeaking','removeSpeaking'].every(key=>Array.isArray(delta[key]))){
    throw new Error(`Invalid scope delta for beat ${beatIndex}`);
   }
   scopeDelta={
    addPresent:cleanNames(delta.addPresent),
    removePresent:cleanNames(delta.removePresent),
    addSpeaking:cleanNames(delta.addSpeaking),
    removeSpeaking:cleanNames(delta.removeSpeaking),
   };
  }
  return {beatIndex,text:value.text.trim(),...(scopeDelta?{scopeDelta}:{})};
 };
 await Promise.all(Array.from({length:Math.min(concurrency,requests.length)},async()=>{
  while(next<requests.length){const i=next++;try{results[i]={status:'fulfilled',value:await generate(requests[i]!)};}catch(reason){results[i]={status:'rejected',reason};}}
 }));
 const blocks:Array<{beatIndex:number;text:string;scopeDelta?:BeatScopeDelta}>=[],failures:Array<{beatIndex:number;error:string}>=[];
 results.forEach((r,i)=>{if(r.status==='fulfilled')blocks.push(r.value);else failures.push({beatIndex:requests[i]!.beatIndex,error:String(r.reason)});});
 const scene=failures.length?null:assembleBeatBlockScene(contract,{status:'completed',output_text:JSON.stringify({title:'Parallel beat pilot',blocks:Object.fromEntries(blocks.map(b=>[`beat_${b.beatIndex}`,b.text]))})});
 const hasCompleteScopeDeltas=Boolean(options.scopeContext)&&blocks.length>0&&blocks.every(block=>Boolean(block.scopeDelta));
 const finalScope=hasCompleteScopeDeltas
  ? applyScopeDeltas(options.scopeContext!.sceneScope,options.scopeContext!.playerName,blocks)
  : undefined;
 return {blocks,failures,scene,finalScope,scopeDeltas:blocks.map(block=>({beatIndex:block.beatIndex,scopeDelta:block.scopeDelta??null}))};
}
