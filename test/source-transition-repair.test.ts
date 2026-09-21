import {acceptedCanonicalReview} from "./helpers/canonical-review.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {repairSourceTransitions,type TransitionRepair} from '../src/books/source-index/repair-transitions.js';
import {sourceIndexFingerprint,assertGameSourceVersion} from '../src/books/source-index/game-version.js';
import {planTurn} from '../src/ai/engine/turn-contract.js';
import {buildTurnScript} from '../src/ai/engine/turn-script.js';
import {generateCanonicalBeatScene} from '../src/ai/engine/canonical-beat-scene.js';
import {SOURCE_TRANSITION_POLICY} from '../src/shared/source-transition-policy.js';
import {CHAPTER_SOURCE_INDEX_INSTRUCTIONS} from '../src/books/analyze/requests.js';
import type {ImportedBook,GameState} from '../src/shared/contracts.js';
const original:ImportedBook=JSON.parse(fs.readFileSync(new URL('./fixtures/oz-transition-source.json',import.meta.url),'utf8'));
const patchFixture=new URL('./fixtures/repairs/wizard-oz-transitions.json',import.meta.url);
const patch:TransitionRepair=JSON.parse(fs.readFileSync(patchFixture,'utf8'));
const repaired=repairSourceTransitions(original,patch);
const landing=repaired.storyEvents!.find(e=>e.sequence===4)!;
const state:GameState={book:{bookId:original.bookId,title:original.title,author:original.author},gameId:'test',playerName:'Dorothy',playerActionVersion:2,
 characterProfiles:[],parameters:[],status:'active',objective:'Explore',victoryCondition:'None',gameProfile:{category:'exploration',endingMode:'open_ended',description:'Explore'},
 selectedText:'FUTURE_SCENERY_MUST_NOT_LEAK',history:[],createdAt:'now',updatedAt:'now',turnNumber:7,
 sourceCursor:{chapterPosition:3,textOffset:0},storyMemory:{summary:'Dorothy is asleep.',openThreads:[],canonFacts:['Dorothy is asleep.']},
 scene:{title:'Sleep',text:'I fell asleep with Toto beside me.',choices:[],sceneScope:{currentLocation:'the house',peoplePresent:['Dorothy','Toto'],peopleWithinSpeakingDistance:[]}}};

test('source-checked repair preserves other events and rebuilds character preludes',()=>{
 const before=JSON.stringify(original);
 const out=repairSourceTransitions(original,patch);
 assert.equal(JSON.stringify(original),before);
 assert.deepEqual(out.chapters,original.chapters); // Source extraction checkpoints are not regenerated.
 const lift=out.storyEvents!.find(e=>e.sequence===2)!;
 assert.match(lift.beats![0]!.resultingState!,/Aunt Em remains.*Kansas/);
 assert.deepEqual(lift.beats![1]!.playerAction,original.worldBible!.characterProfiles![0]!.significantEvents![0]!.beats![1]!.playerAction);
 const dorothy=out.worldBible!.characterProfiles!.find(p=>p.name==='Dorothy')!;
 const door=dorothy.significantEvents!.find(e=>e.sequence===4)!.beats![4]!;
 assert.match(door.automaticPreludeEndState!,/awake and sitting up/);
 assert.doesNotMatch(door.automaticPreludeSourceExcerpt ?? '',/fruit|brook|flowers/i);
 assert.equal(door.playerAction!.endBeatIndex,5);
 assert.notEqual(sourceIndexFingerprint(out),sourceIndexFingerprint(original));
 assert.throws(()=>assertGameSourceVersion({...state,sourceIndexFingerprint:sourceIndexFingerprint(original)},out),/Start a new game/);
});

test('repair rejects changed input, bad evidence, invalid references and ambiguous event copies',()=>{
 assert.throws(()=>repairSourceTransitions({...original,sourceSha256:'other'},patch),/fingerprint/);
 const evidence=structuredClone(patch);evidence.evidence[0]!.text='not in this source';
 assert.throws(()=>repairSourceTransitions(original,evidence),/evidence/);
 const changed=structuredClone(patch);changed.events[1]!.expectedActions[0]='different';
 assert.throws(()=>repairSourceTransitions(original,changed),/target changed/);
 const refs=structuredClone(patch);refs.events[1]!.replacementBeats![0]!.sourceReferences[0]!.lineEnd=99999;
 assert.throws(()=>repairSourceTransitions(original,refs),/outside the source/);
 const copies=structuredClone(original);copies.worldBible!.characterProfiles![1]!.significantEvents![0]!.beats![0]!.action='different';
 assert.throws(()=>repairSourceTransitions(copies,patch),/Conflicting event copies/);
});

test('landing and waking precede the door choice; landscape follows only after selection',async()=>{
 const contract={...planTurn({state,event:landing,mode:'source_continue',sourceProgression:'required'}),sourceEvidence:{0:'FUTURE_SCENERY_MUST_NOT_LEAK'}};
 assert.deepEqual(contract.requiredAutomaticBeatIndexes,[0,1,2,3]);
 assert.deepEqual(contract.allowedPlayerBeatIndexes,[]);
 assert.equal(contract.nextPlayerDecision,4);
 const script=buildTurnScript(contract);
 assert.doesNotMatch(JSON.stringify(script.ordered_execution.map(b=>[b.do,b.resulting_state])),/fruit|brook|flowers|colorful/i);
 const seen:string[]=[];
 const result=await generateCanonicalBeatScene(state,contract,[],{beat:'test',rewrite:'test',review:false},async(label,request)=>{
  seen.push(label);const input=JSON.parse(request.input);
  if(label === "scene content review") return acceptedCanonicalReview(request);
  if(label === 'scene next decision readiness review'){
   assert.equal(input.pending_decision.source_beat_index,4);
   return {status:'completed',output_text:JSON.stringify({status:'pass',reason:'The door is available; opening it is spontaneous.',
    causeStatus:'not_required',cause:'No new external stimulus is required to open the door.',nextActionUnperformed:true,evidence:[]})};
  }
  assert.doesNotMatch(request.input,/FUTURE_SCENERY_MUST_NOT_LEAK/);
  if(label.startsWith('scene beat'))return {status:'completed',output_text:JSON.stringify({text:input.transition.action})};
  if(label === 'scene next decision setup'){
   assert.doesNotMatch(input.source_excerpt,/fruit|brook|flowers|colorful/i);
   assert.equal(input.next_decision.beat_index,4);
   return {status:'completed',output_text:JSON.stringify({text:input.indexed_end_state || 'The house is still and the door remains closed.'})};
  }
  assert.equal(input.book_style.referenceExcerpt,'');
  assert.equal(input.production.nextDecision.beat_index,4);
  assert.equal(input.production.nextDecision.must_remain_unperformed,true);
  assert.match(request.instructions!,/Replace superseded position/);
  return {status:'completed',output_text:JSON.stringify({title:'Awake',text:'A jolt woke me. Toto whined beside me. I sat up; the house was still and sunlight filled the room.',
   sceneScope:{currentLocation:'the house',peoplePresent:['Dorothy','Toto'],peopleWithinSpeakingDistance:['Dorothy']},outcome:'active',outcomeReason:'The door is closed.',
   storyMemory:{summary:'Dorothy is awake inside the stationary house.',openThreads:[],canonFacts:['Dorothy is awake.','The door is closed.','Aunt Em remains in Kansas.']}})};
 });
 assert.deepEqual(result.completedBeatIndexes,[0,1,2,3]);
 // This test plans from the shared repaired story event. Derived character
 // preludes live on the character projection, so no next-decision setup call
 // belongs in this direct shared-event generation path.
 assert.equal(seen.filter(label=>label.startsWith('scene beat')).length,4);
 assert.equal(seen.filter(label=>label==='scene next decision setup').length,0);
 assert.equal(seen.filter(label=>label==='scene rewrite').length,1);
 assert.equal(seen.filter(label=>label==='scene next decision readiness review').length,1);
 assert.equal(seen.length,6);
 const next=planTurn({state:{...state,sourceEventProgress:{eventId:landing.eventId,completedBeatIndexes:result.completedBeatIndexes}},event:landing,mode:'action',sourceProgression:'required',
  sourceBeatSelection:{eventId:landing.eventId,beatIndex:4,endBeatIndex:5,kind:'player_action'},selectedIntent:'Open the door and look outside.'});
 assert.deepEqual(next.allowedPlayerBeatIndexes,[4]);
 assert.deepEqual(next.requiredAutomaticBeatIndexes,[5]);
 assert.match(buildTurnScript(next).ordered_execution[1]!.do,/brook/);
});

test('future indexing includes shared transport, awareness and viewpoint rules',()=>{
 for(const instruction of SOURCE_TRANSITION_POLICY)assert.ok(CHAPTER_SOURCE_INDEX_INSTRUCTIONS.includes(instruction));
});

test('repair CLI backs up the exact book and saves synchronized events without model calls',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bookrpg-transition-repair-'));
 try {
  fs.mkdirSync(path.join(directory,'books'));
  const filename=path.join(directory,'books',`${original.bookId}.json`);
  fs.writeFileSync(filename,JSON.stringify(original));
  const args=['--import','tsx','src/books/repair-source-transitions-cli.ts','--book',original.bookId,'--patch',fileURLToPath(patchFixture)];
  const env={...process.env,BOOKRPG_DATA_DIR:directory,BOOKRPG_STORAGE_MODE:'local'};
  execFileSync(process.execPath,args,{env,stdio:'pipe'});
  assert.deepEqual(JSON.parse(fs.readFileSync(filename,'utf8')),original);
  execFileSync(process.execPath,[...args,'--apply'],{env,stdio:'pipe'});
  const saved=JSON.parse(fs.readFileSync(filename,'utf8'));
  assert.deepEqual(saved,repaired);
  const backupDirectory=path.join(directory,'source-transition-repairs',fs.readdirSync(path.join(directory,'source-transition-repairs'))[0]!);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backupDirectory,'original-book.json'),'utf8')),original);
  assert.throws(()=>execFileSync(process.execPath,[...args,'--apply'],{env,stdio:'pipe'}));
  assert.deepEqual(JSON.parse(fs.readFileSync(filename,'utf8')),saved);
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

