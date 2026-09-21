import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {FallReviewFixture} from '../src/ai/engine/measure-fall-review.js';
import {beatBlockReviewRequest,decodeBeatBlockReview} from '../src/ai/engine/beat-block-review.js';
const {contract}:FallReviewFixture=JSON.parse(fs.readFileSync(new URL('./fixtures/fall-review.json',import.meta.url),'utf8'));
const scene={title:'Storm (Turn 1)',text:'',blocks:[{beatIndex:3,text:'I reach under the bed.'},{beatIndex:4,text:'Em descends.'},{beatIndex:5,text:'Dorothy catches Toto as I turn.'},{beatIndex:6,text:'I sit with Toto.'}]};
const verdict=()=>({blocks:Object.fromEntries(scene.blocks.map(b=>[`beat_${b.beatIndex}`,{observedState:'Observed state',...Object.fromEntries(['perspective','action','order','resultingState'].map(k=>[k,{status:'pass',reason:'Supported.'}]))}])),titleIssues:['Title includes a turn number.'],proseNotes:[]});
const reply=(v:unknown)=>({status:'completed',output_text:JSON.stringify(v)});
test('one request maps every block to its action and endpoint, without rewriting or expected verdicts',()=>{
 const r=beatBlockReviewRequest(contract,scene,'test');
 const input=JSON.parse(r.input);
 assert.equal(input.viewpoint_character,'Dorothy');
 assert.equal(input.blocks[2].text,scene.blocks[2]!.text);
 assert.equal(input.blocks[2].desired_resulting_state,contract.beats[5]!.resultingState);
 assert.equal(input.blocks[2].start_state,contract.beats[4]!.resultingState);
 assert.match(r.instructions!,/Do not rewrite/);
 assert.doesNotMatch(r.input,/expectedAccepted|expectFall|perspective.*fail/);
 assert.equal(r.max_output_tokens,3200);
});
test('each failed or uncertain dimension is retained independently of other positive checks',()=>{
 for(const dimension of ['perspective','action','order','resultingState'])for(const status of ['fail','uncertain']){
  const value=verdict();(value.blocks.beat_5 as any)[dimension]={status,reason:'Concrete defect.'};
  const result=decodeBeatBlockReview(scene,reply(value));
  assert.equal(result.beatChecksPassed,false);
  assert.deepEqual(result.findings,[{beatIndex:5,dimension,status,reason:'Concrete defect.'}]);
 }
 const result=decodeBeatBlockReview(scene,reply(verdict()));
 assert.equal(result.beatChecksPassed,true);
 assert.equal(result.titleIssues.length,1);
});
test('missing block, missing dimension and incomplete reviews cannot count as a pass',()=>{
 const missing=verdict();delete missing.blocks.beat_5;
 assert.throws(()=>decodeBeatBlockReview(scene,reply(missing)),/Invalid/);
 const dimension=verdict();delete (dimension.blocks.beat_5 as any).order;
 assert.throws(()=>decodeBeatBlockReview(scene,reply(dimension)),/Invalid/);
 assert.throws(()=>decodeBeatBlockReview(scene,{status:'incomplete',output_text:''}),/Incomplete/);
});
