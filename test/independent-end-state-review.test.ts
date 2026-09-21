import {endStateSentences} from '../src/ai/engine/observe-end-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {AiResponseRequest} from '../src/ai/provider.js';
import type {FallReviewFixture} from '../src/ai/engine/measure-fall-review.js';
import {TurnPipelineGameEngine} from '../src/ai/engine/turn-pipeline-engine.js';
import {reviewIndependentEndState} from '../src/ai/engine/independent-end-state-review.js';
import {reducePresenceReview} from '../src/ai/engine/turn-validator.js';
const f:FallReviewFixture=JSON.parse(fs.readFileSync(new URL('./fixtures/fall-review.json',import.meta.url),'utf8'));
const reply=(value:unknown)=>({status:'completed',output_text:JSON.stringify(value)});
class Probe extends TurnPipelineGameEngine {send(r:AiResponseRequest){return this.createResponse('scene presence review','test',r);}}
for(const matches of [true,false])test(`production applies independent final verdict ${matches} without leaking expected state`,async()=>{
 const seen:AiResponseRequest[]=[];
 const text=f.cases[matches?1:2]!.text;
 const engine=new Probe({provider:'openai',model:'test',async createResponse(r){
  seen.push(r);const name=r.text?.format.name;
  if(name==='observed_end_state'){
   assert.deepEqual(JSON.parse(r.input),{viewpoint_character:'Dorothy',scene_sentences:endStateSentences(text)});
   assert.doesNotMatch(r.instructions!,/resulting_state|story_so_far|TURN CONTRACT/);
   return reply({location:matches?'room':'cellar',posture:matches?'seated':'standing',possessions:'Toto',finalState:matches?'Seated upstairs holding Toto.':'Standing in the cellar holding Toto.',evidenceSentenceIds:[1]});
  }
  if(name==='end_state_comparison'){
   assert.equal(JSON.parse(r.input).viewpoint_character,'Dorothy');
   assert.equal(JSON.parse(r.input).expected_resulting_state,f.contract.beats[6]!.resultingState);
   return reply({matches,reason:matches?'Compatible.':'Standing in cellar contradicts seated upstairs.'});
  }
  assert.equal((r.text!.format.schema as any).properties.final_checkpoint,undefined);
  const checkpoint={observed_state:'Intermediate state',matches:true,reason:'',evidence_sentence_ids:[1]};
  return reply({peoplePresent:['Dorothy','Toto'],peopleWithinSpeakingDistance:['Dorothy','Toto'],latestVisibleSourceEventId:null,futureActionSetupRequired:false,futureActionSetupSupported:true,
   player_action_resolution:{status:'completed',beforeBeatIndex:null,reason:'Retrieval completed',causeEstablished:false,evidence_sentence_ids:[1]},
   beat_observations:Object.fromEntries([3,4,5,6].map(i=>[`beat_${i}`,{status:'completed',evidence_sentence_ids:[1]}])),
   checkpoint_observations:Object.fromEntries([3,4,5,6].map(i=>[`beat_${i}`,checkpoint]))});
 }});
 const result=JSON.parse((await engine.send({model:'test',turnContract:f.contract,input:JSON.stringify({...f.baseInput,candidate_scene:{text}}),text:{format:{type:'json_schema',name:'presence',strict:true,schema:{type:'object',properties:{},required:[]}}}})).output_text);
 assert.equal(seen.length,3);
 assert.equal(result.turnValidation.status,matches?'accepted':'repair_scene');
 assert.deepEqual(result.completedSourceEventBeatIndexes,[0,1,2,3,4,5,6]);
 assert.equal(result.independent_end_state.comparison.matches,matches);
});
const raw={completedSourceEventBeatIndexes:[3,4,5,6],partiallyPerformedSourceEventBeatIndexes:[],checkpointFindings:[],futureActionSetupRequired:false,futureActionSetupSupported:true,
 player_action_resolution:{status:'completed',beforeBeatIndex:null,reason:'Done',causeEstablished:false}};
test('missing selected beat is rejected before extra calls; matching state cannot replace beat evidence',async()=>{
 const missing=reply({...raw,completedSourceEventBeatIndexes:[]});
 const result=await reviewIndependentEndState(f.contract,missing,'text','test',async()=>{throw Error('Must not call');});
 assert.equal(JSON.parse(reducePresenceReview(f.contract,result).output_text).turnValidation.status,'repair_scene');
});
test('incomplete observation fails closed without comparison or retry',async()=>{
 let calls=0;
 const result=await reviewIndependentEndState(f.contract,reply(raw),'text','test',async()=>{calls++;return {status:'incomplete',output_text:''};});
 assert.equal(JSON.parse(reducePresenceReview(f.contract,result).output_text).turnValidation.status,'repair_scene');
 assert.equal(calls,1);
});
test('optional source route and grounded interruptions do not force canonical success state',async()=>{
 const noCall=async()=>{throw Error('Must not call');};
 assert.equal((await reviewIndependentEndState({...f.contract,sourceProgression:'optional'},reply(raw),'text','test',noCall)).output_text,reply(raw).output_text);
 const stopped=reply({...raw,completedSourceEventBeatIndexes:[3],player_action_resolution:{status:'interrupted',beforeBeatIndex:4,reason:'Established obstacle',causeEstablished:true,quote:'An obstacle blocks us.'}});
 assert.equal(JSON.parse(reducePresenceReview(f.contract,stopped).output_text).turnValidation.actionOutcome,'interrupted');
 assert.equal((await reviewIndependentEndState(f.contract,stopped,'text','test',noCall)).output_text,stopped.output_text);
});

test('invalid comparison produces repair, but transport and budget failures still propagate',async()=>{
 let calls=0;
 const observation=reply({location:'room',posture:'seated',possessions:'Toto',finalState:'Seated holding Toto.',evidenceSentenceIds:[1]});
 const result=await reviewIndependentEndState(f.contract,reply(raw),'I sit with Toto.','test',async()=>++calls===1?observation:reply({matches:'yes'}));
 assert.equal(calls,2);
 assert.equal(JSON.parse(reducePresenceReview(f.contract,result).output_text).turnValidation.status,'repair_scene');
 const transport=new Error('Network unavailable');
 await assert.rejects(reviewIndependentEndState(f.contract,reply(raw),'I sit with Toto.','test',async()=>{throw transport;}),error=>error===transport);
});
