import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {FallReviewFixture} from '../src/ai/engine/measure-fall-review.js';
import {beatBlockSceneRequest,assembleBeatBlockScene,reviewBeatBlockEnding} from '../src/ai/engine/beat-block-scene.js';
const fixture:FallReviewFixture=JSON.parse(fs.readFileSync(new URL('./fixtures/fall-review.json',import.meta.url),'utf8'));
const contract=fixture.contract;
const value={title:'The trapdoor',blocks:{beat_6:'I lose my footing and sit hard, holding Toto.',beat_5:'I catch Toto and start toward the trapdoor.',beat_4:'Aunt Em opens the trapdoor and climbs down.',beat_3:'I reach under the bed for Toto.'}};
const response=(v:unknown)=>({status:'completed',output_text:JSON.stringify(v)});
test('request exposes only authorized block keys, including automatic interleaving and the fall',()=>{
 const r=beatBlockSceneRequest(contract,'test');
 const schema=r.text!.format.schema as any;
 assert.deepEqual(schema.properties.blocks.required,['beat_3','beat_4','beat_5','beat_6']);
 const script=JSON.parse(r.input).turn_script;
 assert.deepEqual(script.ordered_execution.map((b:any)=>b.beat_index),[3,4,5,6]);
 assert.equal(script.ordered_execution[3].resulting_state,contract.beats[6]!.resultingState);
 assert.doesNotMatch(r.input,/expectedAccepted|expectFall|expectFinalMatch|correct-seated-ending/);
 assert.equal(r.reasoning!.effort,'low');
 assert.equal(r.max_output_tokens,4000);
});
test('assembly preserves all prose verbatim and uses canonical order, regardless of JSON key order',()=>{
 const result=assembleBeatBlockScene(contract,response(value));
 assert.equal(result.text,[value.blocks.beat_3,value.blocks.beat_4,value.blocks.beat_5,value.blocks.beat_6].join('\n\n'));
 assert.deepEqual(result.blocks.map(b=>b.beatIndex),[3,4,5,6]);
 // Assembly does not claim semantic correctness: wrong content is kept visible for review.
 const bad={...value,blocks:{...value.blocks,beat_6:'I walk into the cellar.'}};
 assert.match(assembleBeatBlockScene(contract,response(bad)).text,/walk into the cellar/);
});
test('missing, extra, empty and incomplete blocks are rejected rather than silently joined',()=>{
 const {beat_6,...missing}=value.blocks;
 for(const blocks of [missing,{...value.blocks,beat_7:'Later action'},{...value.blocks,beat_6:'  '}])
  assert.throws(()=>assembleBeatBlockScene(contract,response({...value,blocks})),/scene blocks/);
 assert.throws(()=>assembleBeatBlockScene(contract,{status:'incomplete',output_text:JSON.stringify(value)}),/Incomplete/);
 assert.throws(()=>beatBlockSceneRequest({...contract,sourceProgression:'optional'},'test'),/canonical/);
});

test('writer requires literal physical checkpoints and complete sentences',()=>{
 const request=beatBlockSceneRequest(contract,'test');
 assert.match(request.instructions!,/halfway across a room/);
 assert.match(request.instructions!,/Metaphors must not imply arrival/);
 assert.match(request.instructions!,/complete sentences with normal punctuation/);
});

for(const matches of [true,false])test(`assembled scene receives independent final comparison: ${matches}`,async()=>{
 const scene=assembleBeatBlockScene(contract,response(value));
 const stages:string[]=[];
 const result=await reviewBeatBlockEnding(contract,scene.text,'test','low',async(stage,request)=>{
  stages.push(stage);const input=JSON.parse(request.input);
  assert.equal(input.viewpoint_character,'Dorothy');
  if(stage==='observe'){
   assert.deepEqual(Object.keys(input).sort(),['scene_sentences','viewpoint_character']);
   assert.equal(input.scene_sentences.map((s:any)=>s.text).join('\n\n'),scene.text);
   return response({location:'room',posture:'seated',possessions:'Toto',finalState:'Seated holding Toto.',evidenceSentenceIds:[4]});
  }
  assert.equal(input.expected_resulting_state,contract.beats[6]!.resultingState);
  assert.equal(input.observed_final_state.finalState,'Seated holding Toto.');
  return response({matches,reason:matches?'State matches.':'State contradicts expected location.'});
 });
 assert.deepEqual(stages,['observe','compare']);
 assert.equal(result.comparison.matches,matches);
});
test('unusable observation stops review without another call or retry',async()=>{
 let calls=0;
 await assert.rejects(reviewBeatBlockEnding(contract,'I sit.','test','low',async()=>{calls++;return {status:'incomplete',output_text:''};}),/Incomplete/);
 assert.equal(calls,1);
});

test('each output field directly binds its own entry state, actor/action and endpoint',()=>{
 const before=JSON.stringify(contract);
 const request=beatBlockSceneRequest(contract,'test');
 const input=JSON.parse(request.input);
 const fields=(request.text!.format.schema as any).properties.blocks.properties;
 for(const [position,index] of [3,4,5,6].entries()){
  const plan=input.block_writing_plan[`beat_${index}`];
  assert.equal(plan.start_state,position===0?input.turn_script.source_start_state:contract.beats[index-1]!.resultingState);
  assert.equal(plan.actor,contract.beats[index]!.actor);
  assert.equal(plan.action,contract.beats[index]!.action);
  assert.equal(plan.desired_resulting_state,contract.beats[index]!.resultingState);
  assert.ok(fields[`beat_${index}`].description.includes(JSON.stringify(plan)));
 }
 assert.match(input.block_writing_plan.beat_3.desired_resulting_state,/Toto remains under the bed/);
 assert.match(input.block_writing_plan.beat_4.start_state,/Toto remains under the bed/);
 assert.match(input.block_writing_plan.beat_6.start_state,/halfway across the room/);
 assert.match(request.instructions!,/not because you append it as an assertion/);
 assert.equal(JSON.stringify(contract),before);
});
