import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {oilBeatPilotContract} from '../src/ai/engine/oil-beat-pilot.js';
import {rewriteBeatSceneRequest,rewrittenSceneReviewRequest,decodeRewrittenScene,decodeRewrittenSceneReview,rewriteAndReviewBeatScene} from '../src/ai/engine/rewrite-beat-scene.js';
import {decodeBeatBlockReview} from '../src/ai/engine/beat-block-review.js';
import {sceneActionPolicy,sceneStatePolicy} from '../src/ai/engine/scene-action-policy.js';
const event=JSON.parse(fs.readFileSync(new URL('./fixtures/import-goals/existing-character-events.json',import.meta.url),'utf8'))[1];
const contract=oilBeatPilotContract(event);
const bare={title:'Bare',text:'OLD_DRAFT',blocks:[7,8,9,10,11].map(beatIndex=>({beatIndex,text:`OLD_DRAFT_${beatIndex}`}))};
const style={title:'The Wonderful Wizard of Oz',author:'L. Frank Baum',language:'English',guidance:'Plain warm narration',referenceExcerpt:'STYLE_ONLY'};
test('continuous scene review distinguishes delayed context from delayed actions and departed cast from present people',()=>{
 const scene={title:'The Warning at the Door',text:'Henry ran toward the sheds. Toto sprang from my arms and hid under the bed. I stood at the doorway, no longer holding Toto.',
  sceneScope:{currentLocation:'the farmhouse',peoplePresent:['Dorothy','Aunt Em','Toto'],peopleWithinSpeakingDistance:['Dorothy','Aunt Em','Toto']}};
 const writer=rewriteBeatSceneRequest(contract,bare,style,'test');
 const reviewer=rewrittenSceneReviewRequest(contract,bare,scene,'test');
 for(const request of [writer,reviewer])assert.ok(request.instructions!.includes(sceneStatePolicy));
 assert.deepEqual(JSON.parse(reviewer.input).candidate_scene.sceneScope,scene.sceneScope);
 assert.match(sceneStatePolicy,/no intervening transition or contradiction/);
 assert.match(sceneStatePolicy,/cannot be projected backward/);
 assert.match(sceneStatePolicy,/final state alone never proves an earlier required action/);
 assert.match(sceneStatePolicy,/correctly absent from peoplePresent/);
});
test('writer and reviewer share incidental-motion permission and material-action boundaries',()=>{
 const writer=rewriteBeatSceneRequest(contract,bare,style,'test');
 const reviewer=rewrittenSceneReviewRequest(contract,bare,{title:'Rescue',text:'I step closer to oil the joints.'},'test');
 for(const request of [writer,reviewer])assert.ok(request.instructions!.includes(sceneActionPolicy));
 assert.match(sceneActionPolicy,/standing before running/);
 assert.match(sceneActionPolicy,/stepping closer to bite/);
 assert.match(sceneActionPolicy,/successful completion of an attempt/);
 assert.match(sceneActionPolicy,/any part of nextDecision/);
});
test('Tin Woodman viewpoint keeps Dorothy as the actor of waking in both requests',()=>{
 const opening={...contract,player:'Tin Woodman',allowedPlayerBeatIndexes:[],requiredAutomaticBeatIndexes:[0],completedBeatIndexes:[],
  beats:[{...contract.beats[0]!,actor:'Dorothy',action:'Wakes, leaves the cottage with the Scarecrow, and searches for water.',resultingState:'Dorothy and the Scarecrow are outside searching for water.'}]};
 const scaffold={title:'Water',text:'Dorothy wakes.',blocks:[{beatIndex:0,text:'Dorothy wakes and leaves the cottage to search for water.'}]};
 const writer=rewriteBeatSceneRequest(opening,scaffold,style,'test');
 const wrong={title:'Water',text:'When I came to myself, Dorothy had left the cottage.'};
 const reviewer=rewrittenSceneReviewRequest(opening,scaffold,wrong,'test');
 assert.equal(JSON.parse(writer.input).player.identity,'Tin Woodman');
 assert.equal(JSON.parse(writer.input).ordered_execution[0].actor,'Dorothy');
 assert.equal(JSON.parse(reviewer.input).viewpoint_character,'Tin Woodman');
 assert.equal(JSON.parse(reviewer.input).expected_beats[0].actor,'Dorothy');
 assert.equal(JSON.parse(reviewer.input).expected_beats[0].action,opening.beats[0]!.action);
 assert.match(writer.instructions!,/Do not transfer waking/);
 const assessment={observedState:'Dorothy has left; the narrator wakes.',...Object.fromEntries(['perspective','action','order','resultingState'].map(k=>[k,{status:k==='action'?'fail':'pass',reason:'Waking was transferred to the narrator.'}]))};
 const review=decodeRewrittenSceneReview(scaffold,{status:'completed',output_text:JSON.stringify({blocks:{beat_0:assessment},titleIssues:[],proseNotes:[],finalState:{status:'pass',observedState:opening.beats[0]!.resultingState,reason:'Search established.'}})});
 assert.equal(review.checksPassed,false);
});
test('rewrite receives the factual scaffold, authorized transitions and style, without next decisions',()=>{
 const r=rewriteBeatSceneRequest(contract,bare,style,'test');const input=JSON.parse(r.input);
 assert.deepEqual(input.factual_scaffold,bare.blocks);
 assert.equal(input.player.identity,'Dorothy');
 assert.deepEqual(input.ordered_execution.map((b:any)=>b.beat_index),[7,8,9,10,11]);
 assert.doesNotMatch(r.input,/next_decision/);
 assert.match(r.instructions!,/voice and rhythm, never as permission/);
 assert.equal(r.reasoning!.effort,'low');
});
test('fidelity sees rewritten text only: old prose and style sample cannot become review evidence',()=>{
 const r=rewrittenSceneReviewRequest(contract,bare,{title:'New',text:'I oil the arms.'},'test');
 const input=JSON.parse(r.input);
 assert.equal(input.candidate_scene.text,'I oil the arms.');
 assert.doesNotMatch(r.input,/OLD_DRAFT|STYLE_ONLY/);
 assert.equal(input.expected_beats[2].action,event.beats[9].action);
 assert.match(r.instructions!,/There are no assigned prose blocks/);
});
test('empty optional notes are discarded without erasing a beat rejection',()=>{
 const assessments=Object.fromEntries(bare.blocks.map(b=>[`beat_${b.beatIndex}`,{observedState:'Arms remain stiff',...Object.fromEntries(['perspective','action','order','resultingState'].map(k=>[k,{status:k==='action'?'fail':'pass',reason:'Required oiling not shown.'}]))}]));
 const result=decodeBeatBlockReview(bare,{status:'completed',output_text:JSON.stringify({blocks:assessments,titleIssues:[''],proseNotes:['  ']})});
 assert.equal(result.beatChecksPassed,false);assert.equal(result.findings.length,5);assert.deepEqual(result.proseNotes,[]);
});
test('malformed/incomplete rewrites are not treated as a usable scene',()=>{
 assert.throws(()=>decodeRewrittenScene({status:'incomplete',output_text:''}),/Incomplete/);
 assert.throws(()=>decodeRewrittenScene({status:'completed',output_text:'{"title":"x","text":""}'}),/Invalid/);
 assert.deepEqual(decodeRewrittenScene({status:'completed',output_text:'{"title":"x","text":"I oil the legs."}'}),{title:'x',text:'I oil the legs.'});
});

test('bare beat identifiers cannot masquerade as title defects or a passing review',()=>{
 const blocks=Object.fromEntries(bare.blocks.map(b=>[`beat_${b.beatIndex}`,{observedState:'Completed',...Object.fromEntries(['perspective','action','order','resultingState'].map(k=>[k,{status:'pass',reason:'Shown.'}]))}]));
 const response=(titleIssues:string[])=>({status:'completed',output_text:JSON.stringify({blocks,titleIssues,proseNotes:[]})});
 assert.throws(()=>decodeBeatBlockReview(bare,response(['beat_7','beat_8'])),/Invalid title review/);
 const valid=decodeBeatBlockReview(bare,response(['Title contains an unwanted turn number.']));
 assert.deepEqual(valid.titleIssues,['Title contains an unwanted turn number.']);
 assert.equal(valid.beatChecksPassed,true);
 assert.deepEqual(decodeBeatBlockReview(bare,response([])).titleIssues,[]);
});
test('rewrite and fidelity distinguish flowing prose from repeated or reversed actions',()=>{
 const writer=rewriteBeatSceneRequest(contract,bare,style,'test');
 assert.match(writer.instructions!,/continuous storytelling, not five separate beat reports/);
 assert.match(writer.instructions!,/varied sentence lengths/);
 assert.match(writer.instructions!,/Do not add a reflective closing paragraph/);
 const review=rewrittenSceneReviewRequest(contract,bare,{title:'Freedom',text:'The axe rested against the tree, and he lowered it there.'},'test');
 assert.match(review.instructions!,/even within a single sentence/);
 assert.match(review.instructions!,/Explicit contradictions of supplied history still fail/);
 assert.match(review.instructions!,/Never list beat keys/);
});

test('knowledge of a reported past does not authorize invented firsthand memories',()=>{
 const writer=rewriteBeatSceneRequest(contract,bare,style,'test');
 assert.match(JSON.parse(writer.input).source_start_state,/Dorothy knows/);
 assert.match(writer.instructions!,/does not establish a personal memory/);
 assert.match(writer.instructions!,/Do not add physical attributes absent/);
 const review=rewrittenSceneReviewRequest(contract,bare,{title:'Rescue',text:'I remembered watching him stand here for a year.'},'test');
 assert.match(review.instructions!,/fail action as an invented mental event/);
 assert.equal(JSON.parse(review.input).candidate_scene.text,'I remembered watching him stand here for a year.');
});

test('Toto rewrite preserves attempt, Em descent, catch and fall without invented instructions',()=>{
 const toto=JSON.parse(fs.readFileSync(new URL('./fixtures/fall-review.json',import.meta.url),'utf8')).contract;
 const draft={title:'Toto',text:'Bare',blocks:[3,4,5,6].map(beatIndex=>({beatIndex,text:`Bare ${beatIndex}`}))};
 const writer=rewriteBeatSceneRequest(toto,draft,style,'test');
 const input=JSON.parse(writer.input);
 assert.deepEqual(input.ordered_execution.map((b:any)=>[b.beat_index,b.actor]),[[3,'Dorothy'],[4,'Aunt Em'],[5,'Dorothy'],[6,'Dorothy']]);
 assert.match(input.ordered_execution[0].resulting_state,/Toto remains under the bed/);
 assert.match(input.ordered_execution[3].resulting_state,/has not reached the cellar/);
 assert.match(writer.instructions!,/Do not collapse the attempt into success before the intervening action/);
 assert.match(writer.instructions!,/quoted or paraphrased commands/);
 const review=rewrittenSceneReviewRequest(toto,draft,{title:'Toto',text:'I catch Toto. Em is already descending. She tells me to stay put.'},'test');
 assert.match(review.instructions!,/does not repair success narrated too early/);
 assert.match(review.instructions!,/even if the final physical state matches/);
});

function unifiedResponse(finalStatus='pass',beatStatus='pass'){
 return {status:'completed',output_text:JSON.stringify({blocks:Object.fromEntries(bare.blocks.map(b=>[`beat_${b.beatIndex}`,{observedState:'Required action shown',...Object.fromEntries(['perspective','action','order','resultingState'].map(k=>[k,{status:k==='action'?beatStatus:'pass',reason:'Checked prose.'}]))}])),titleIssues:[],proseNotes:[],finalState:{status:finalStatus,observedState:'All joints free.',reason:'Actual closing state checked.'}})};
}
test('single review rejects a bad ending despite passed beats, and bad beats despite a matching ending',()=>{
 assert.equal(decodeRewrittenSceneReview(bare,unifiedResponse()).checksPassed,true);
 for(const status of ['fail','uncertain'])assert.equal(decodeRewrittenSceneReview(bare,unifiedResponse(status)).checksPassed,false);
 assert.equal(decodeRewrittenSceneReview(bare,unifiedResponse('pass','fail')).checksPassed,false);
 const malformed=JSON.parse(unifiedResponse().output_text);delete malformed.finalState;
 assert.throws(()=>decodeRewrittenSceneReview(bare,{status:'completed',output_text:JSON.stringify(malformed)}),/Invalid final-state/);
});
test('rewrite orchestration makes exactly two calls, preserving prose before the single review',async()=>{
 for(const reviewStatus of ['pass','fail']){
  const stages:string[]=[];
  const result=await rewriteAndReviewBeatScene(contract,bare,style,'test',async(stage,request)=>{
   stages.push(stage);
   if(stage==='rewrite')return {status:'completed',output_text:JSON.stringify({title:'Rescue',text:'I oil the joints.'})};
   const input=JSON.parse(request.input);
   assert.equal(input.expected_final_state.beat_index,11);
   assert.equal(input.candidate_scene.text,'I oil the joints.');
   assert.match(request.instructions!,/actual END of the entire scene/);
   return unifiedResponse(reviewStatus);
  },async()=>{stages.push('saved');});
  assert.deepEqual(stages,['rewrite','saved','fidelity']);
  assert.equal(result.review.checksPassed,reviewStatus==='pass');
 }
});
test('incomplete single review preserves saved prose and never retries',async()=>{
 const stages:string[]=[];
 await assert.rejects(()=>rewriteAndReviewBeatScene(contract,bare,style,'test',async stage=>{
  stages.push(stage);return stage==='rewrite'?{status:'completed',output_text:'{"title":"Rescue","text":"I oil the joints."}'}:{status:'incomplete',output_text:''};
 },async()=>{stages.push('saved');}),/Incomplete block review/);
 assert.deepEqual(stages,['rewrite','saved','fidelity']);
});


test('serial crossing checkpoints never place later passengers in earlier states',()=>{
 const crossing={...contract,player:'Cowardly Lion',allowedPlayerBeatIndexes:[0],requiredAutomaticBeatIndexes:[1],completedBeatIndexes:[],
  beats:[
   {...contract.beats[0]!,actor:'Cowardly Lion',action:'Carry the Scarecrow across and return.',resultingState:'Scarecrow is on the far bank; Lion is back on the original bank.'},
   {...contract.beats[0]!,actor:'Dorothy',action:'Ride across with Toto.',resultingState:'Dorothy and Toto are on the far bank.'},
  ]};
 const scaffold={title:'Crossing',text:'',blocks:[{beatIndex:0,text:'The Lion carries the Scarecrow across and returns.'},{beatIndex:1,text:'Dorothy rides across with Toto.'}]};
 const wrong={title:'Crossing',text:'I left the Scarecrow waiting with Dorothy and Toto on the far bank. Then I carried Dorothy and Toto across.'};
 const writer=rewriteBeatSceneRequest(crossing,scaffold,style,'test');
 const reviewer=rewrittenSceneReviewRequest(crossing,scaffold,wrong,'test');
 const checkpoints=JSON.parse(writer.input).state_checkpoints;
 assert.deepEqual(checkpoints[0].prior_changes,[]);
 assert.deepEqual(checkpoints[1].prior_changes,[{beat_index:0,resulting_state:crossing.beats[0]!.resultingState}]);
 assert.doesNotMatch(JSON.stringify(checkpoints[0]),/Dorothy|Toto/);
 assert.deepEqual(JSON.parse(reviewer.input).state_checkpoints,checkpoints);
 for(const r of [writer,reviewer])assert.match(r.instructions!,/waiting with A and B asserts co-location/);
 const verdict=decodeRewrittenSceneReview(scaffold,{status:'completed',output_text:JSON.stringify({blocks:Object.fromEntries([0,1].map(i=>[`beat_${i}`,{observedState:i===0?'Dorothy and Toto already on far bank.':'They cross afterwards.',...Object.fromEntries(['perspective','action','order','resultingState'].map(k=>[k,{status:k==='order'?'fail':'pass',reason:'Later passengers appear before their crossing.'}]))}])),titleIssues:[],proseNotes:[],finalState:{status:'pass',observedState:'Everyone except Woodman is across.',reason:'Final location matches.'}})});
 assert.equal(verdict.checksPassed,false);
});
