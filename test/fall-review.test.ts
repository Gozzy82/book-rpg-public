import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fallReviewRequest,scoreFallReview,type FallReviewFixture} from '../src/ai/engine/measure-fall-review.js';
const fixture:FallReviewFixture=JSON.parse(fs.readFileSync(new URL('./fixtures/fall-review.json',import.meta.url),'utf8'));
const reply=(fall:boolean,final:boolean)=>{
 const checkpoint={observed_state:'Visible state',matches:true,reason:'',evidence_sentence_ids:[1]};
 return {status:'completed',output_text:JSON.stringify({
  peoplePresent:['Dorothy','Toto'],peopleWithinSpeakingDistance:['Dorothy','Toto'],latestVisibleSourceEventId:null,
  futureActionSetupRequired:false,futureActionSetupSupported:true,
  player_action_resolution:{status:'completed',beforeBeatIndex:null,reason:'Retrieval completed',causeEstablished:false,evidence_sentence_ids:[1]},
  beat_observations:Object.fromEntries([3,4,5,6].map(i=>[`beat_${i}`,{status:i===6&&!fall?'absent':'completed',evidence_sentence_ids:i===6&&!fall?[]:[1]}])),
  checkpoint_observations:Object.fromEntries([3,4,5,6].map(i=>[`beat_${i}`,{...checkpoint,matches:i===6?fall:true,reason:i===6&&!fall?'No fall in prose':''}])),
  final_checkpoint:{...checkpoint,matches:final,reason:final?'':'Scene ends standing or walking'},
 })};
};
test('measurement uses production review transforms, fixed candidate and low reasoning without expected answer leakage',()=>{
 for(let i=0;i<3;i++){
  const r=fallReviewRequest(fixture,i,'test');
  assert.equal(JSON.parse(r.input).candidate_scene.text,fixture.cases[i]!.text);
  assert.equal(r.reasoning!.effort,'low');assert.equal(r.max_output_tokens,3200);
  assert.doesNotMatch(r.input+r.instructions,/expectedAccepted|expectFall|expectFinalMatch|captured-missing-fall/);
  assert.match(r.instructions!,/BEAT CHECKPOINT VALIDATION/);
 }
});
test('scoring requires the right fall assessment, not merely rejecting a bad scene for some unrelated reason',()=>{
 assert.equal(scoreFallReview(fixture,0,fallReviewRequest(fixture,0,'test'),reply(false,false)).passed,true);
 assert.equal(scoreFallReview(fixture,0,fallReviewRequest(fixture,0,'test'),reply(true,false)).passed,false);
 assert.equal(scoreFallReview(fixture,1,fallReviewRequest(fixture,1,'test'),reply(true,true)).passed,true);
 assert.equal(scoreFallReview(fixture,2,fallReviewRequest(fixture,2,'test'),reply(true,false)).passed,true);
 assert.equal(scoreFallReview(fixture,2,fallReviewRequest(fixture,2,'test'),reply(true,true)).passed,false);
 assert.throws(()=>scoreFallReview(fixture,0,fallReviewRequest(fixture,0,'test'),{status:'incomplete',output_text:''}),/Incomplete/);
});
