import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {AiResponse} from '../src/ai/provider.js';
import type {FallReviewFixture} from '../src/ai/engine/measure-fall-review.js';
import {parallelBeatRequests,generateParallelBeatScene} from '../src/ai/engine/parallel-beat-scene.js';
const {contract}:FallReviewFixture=JSON.parse(fs.readFileSync(new URL('./fixtures/fall-review.json',import.meta.url),'utf8'));
const reply=(text:string):AiResponse=>({status:'completed',output_text:JSON.stringify({text})});
test('single-beat requests isolate actions and include only planned entry/exit states without character backstory',()=>{
 const snapshot=JSON.stringify(contract);
 const requests=parallelBeatRequests(contract,'test');
 assert.deepEqual(requests.map(r=>r.beatIndex),[3,4,5,6]);
 for(const {beatIndex,request} of requests){
  const input=JSON.parse(request.input);
  assert.deepEqual(Object.keys(input).sort(),['transition']);
  assert.equal(input.viewpoint_character,undefined);
  assert.equal(input.transition.action,contract.beats[beatIndex]!.action);
  assert.equal(input.transition.desired_resulting_state,contract.beats[beatIndex]!.resultingState);
  if(beatIndex>3)assert.equal(input.transition.start_state,contract.beats[beatIndex-1]!.resultingState);
  assert.equal(request.max_output_tokens,1600);
  assert.equal(request.reasoning!.effort,'low');
  assert.doesNotMatch(request.input,/ordered_execution|selected_choice|next_decision|story_so_far/);
 }
 assert.ok(!requests[0]!.request.input.includes(contract.beats[5]!.action));
 assert.ok(!requests[0]!.request.input.includes(contract.beats[6]!.action));
 assert.equal(JSON.stringify(contract),snapshot);
});
test('all four calls start before any completes; reversed completion still assembles source order',async()=>{
 const resolvers=new Map<number,(r:AiResponse)=>void>();
 const pending=generateParallelBeatScene(contract,'test','low',(index)=>new Promise(resolve=>resolvers.set(index,resolve)));
 assert.deepEqual([...resolvers.keys()],[3,4,5,6]);
 for(const i of [6,5,4,3])resolvers.get(i)!(reply(`Text for ${i}.`));
 const result=await pending;
 assert.deepEqual(result.failures,[]);
 assert.equal(result.scene!.text,'Text for 3.\n\nText for 4.\n\nText for 5.\n\nText for 6.');
});
test('failed beat does not cancel successful outputs, silently disappear, or retry',async()=>{
 const calls:number[]=[];
 const result=await generateParallelBeatScene(contract,'test','low',async index=>{calls.push(index);return index===4?{status:'incomplete',output_text:''}:reply(`Text for ${index}.`);});
 assert.deepEqual(calls,[3,4,5,6]);
 assert.equal(result.scene,null);
 assert.deepEqual(result.blocks.map(b=>b.beatIndex),[3,5,6]);
 assert.equal(result.failures[0]!.beatIndex,4);
 assert.match(result.failures[0]!.error,/Incomplete/);
});

test('max-output-token incomplete beat retries with an expanded output budget',async()=>{
 const budgets:number[]=[];
 const result=await generateParallelBeatScene(contract,'test','low',async(index,request)=>{
  if(index===4){
   budgets.push(request.max_output_tokens??0);
   if(budgets.length<3)return {status:'incomplete',output_text:'',incomplete_details:{reason:'max_output_tokens'}};
  }
  return reply(`Text for ${index}.`);
 });
 assert.deepEqual(budgets,[1600,3200,6400]);
 assert.deepEqual(result.failures,[]);
 assert.ok(result.scene);
});

test('bare writer excludes stylistic character context and keeps actor/action allocation explicit',()=>{
 const context=JSON.parse(contract.contextJson);
 context.character_runtime={player:{name:'Dorothy',aliases:[],development:{traits:['UNRELATED_STYLE'],state_summary:'UNRELATED_HISTORY'}},characters:[]};
 const requests=parallelBeatRequests({...contract,contextJson:JSON.stringify(context)},'test');
 for(const {request} of requests){
  assert.doesNotMatch(request.input,/UNRELATED_STYLE|UNRELATED_HISTORY|character_context/);
  assert.match(request.instructions!,/plain factual prose/);
  assert.match(request.instructions!,/No atmosphere, metaphors/);
  assert.match(request.instructions!,/do not transfer a task or object to another actor/);
  assert.match(request.instructions!,/Explicitly describe every part of action/);
 }
});

test('factual writer has no viewpoint instruction and uses entry state only as prior context',()=>{
 const {request}=parallelBeatRequests(contract,'test')[0]!;
 assert.match(request.instructions!,/names consistently in third person/);
 assert.match(request.instructions!,/start_state only as prior context/);
 assert.match(request.instructions!,/Never return to an earlier state after the action has changed it/);
 assert.match(request.instructions!,/omit unknown locations rather than guessing alternatives/);
 assert.doesNotMatch(request.instructions!,/Use I|first-person/);
});


test('each beat reports only its own scope delta and the server reduces them in beat order',async()=>{
 const scope={currentLocation:'Farmhouse room',peoplePresent:['Dorothy','Toto','Aunt Em'],peopleWithinSpeakingDistance:['Dorothy','Toto','Aunt Em']};
 const requests=parallelBeatRequests(contract,'test','low',8,{playerName:'Dorothy',sceneScope:scope});
 assert.equal(requests.length,4);
 for(const {request} of requests){
  const input=JSON.parse(request.input);
  assert.deepEqual(input.scope_context.initial_scope,scope);
  assert.equal(input.scope_context.player_identity,'Dorothy');
  assert.equal(input.scope_context.ordered_transitions,undefined);
  assert.match(request.instructions!,/THIS transition/);
 }
 const result=await generateParallelBeatScene(contract,'test','low',async(index,request)=>{
  const input=JSON.parse(request.input);
  const scopeDelta=index===4
   ? {addPresent:[],removePresent:['Aunt Em'],addSpeaking:[],removeSpeaking:['Aunt Em']}
   : {addPresent:[],removePresent:[],addSpeaking:[],removeSpeaking:[]};
  return {status:'completed',output_text:JSON.stringify({text:`Text for ${index}.`,scopeDelta})};
 },{scopeContext:{playerName:'Dorothy',sceneScope:scope}});
 assert.deepEqual(result.scopeDeltas.map(item=>item.beatIndex),[3,4,5,6]);
 assert.deepEqual(result.finalScope,{peoplePresent:['Dorothy','Toto'],peopleWithinSpeakingDistance:['Dorothy','Toto']});
 assert.equal(result.scene!.blocks.length,4);
});
