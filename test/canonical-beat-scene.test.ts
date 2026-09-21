// These regression cases explicitly exercise the optional reviewed route.
process.env.BOOKRPG_SCENE_CONTENT_REVIEW = 'true';
import test from 'node:test';
import {ACTION_ENTRY_PHASE_POLICY} from '../src/shared/source-transition-policy.js';
import {CONVERSATIONAL_REACH_POLICY} from '../src/shared/conversational-reach-policy.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {GameState, StoryEventBeat} from '../src/shared/contracts.js';
import type {AiResponseRequest} from '../src/ai/provider.js';
import {TurnPipelineGameEngine} from '../src/ai/engine/turn-pipeline-engine.js';
import {currentTurnExecution, planTurn, runWithTurnBudget, TurnBudget} from '../src/ai/engine/turn-contract.js';
import {canonicalBeatSceneEligible, generateCanonicalBeatScene} from '../src/ai/engine/canonical-beat-scene.js';
import {generateParallelBeatScene} from '../src/ai/engine/parallel-beat-scene.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/fall-review.json',import.meta.url),'utf8'));
const beats:StoryEventBeat[]=structuredClone(fixture.contract.beats);
beats.push({actor:'Dorothy',action:'Look through the window',agency:'intentional',stakes:'significant',targets:[],sourceReferences:[],resultingState:'Dorothy sees the sky through the window.'});
const event={eventId:fixture.contract.eventId,description:'The family reacts to the storm.',chapterPosition:3,sequence:1,beats};
const candidates=[{chapterPosition:3,chapterTitle:'Storm',summary:'FUTURE_SUMMARY',excerpt:'SOURCE_STYLE',nextTextOffset:100,
 requiredEvent:event.description,requiredEventId:event.eventId,requiredEventBeats:beats,storyEvents:[event],currentStoryEvent:event,
 sourceReferenceExcerpts:{}}];
const state:GameState={book:{bookId:'test',title:'A different book',author:'Another author'},gameId:'game',playerName:'Dorothy',playerActionVersion:2,
 characterProfiles:[],parameters:[],status:'active',objective:'Survive',victoryCondition:'Find safety',gameProfile:{category:'adventure',endingMode:'open_ended',description:'Adventure'},
 selectedText:'SOURCE_STYLE',history:[],createdAt:'now',updatedAt:'now',turnNumber:2,sourceCursor:{chapterPosition:3,textOffset:4},
 sourceEventProgress:{eventId:event.eventId,completedBeatIndexes:[0,1,2]},scene:{title:'Storm',text:'Toto is under the bed. I am in the room.',choices:[],
 sceneScope:{currentLocation:'Farmhouse',peoplePresent:['Dorothy','Toto','Aunt Em'],peopleWithinSpeakingDistance:['Dorothy','Toto','Aunt Em']}}};
const reply=(v:unknown)=>({status:'completed',output_text:JSON.stringify(v)});
const check=(status='pass')=>({status,reason:'Checked against candidate prose.'});
function verdict(request:AiResponseRequest,fail?:string){
 const input=JSON.parse(request.input);
 return {resolvedSceneScope: fail==='missingScope'?undefined:fail==='malformedScope'?{currentLocation:42}:fail==='speakingMissingPresent'
   ? {currentLocation:'Farmhouse',peoplePresent:['Dorothy','Toto'],peopleWithinSpeakingDistance:['Dorothy','Toto','Uncle Henry']}
   : {currentLocation:'Farmhouse',peoplePresent:['Dorothy','Toto'],peopleWithinSpeakingDistance:['Dorothy','Toto']},blocks:Object.fromEntries(input.expected_beats.map((b:any)=>[b.key,{observedState:'Visible checkpoint',
  ...Object.fromEntries(['perspective','action','order','resultingState'].map(k=>[k,check(fail==='beat'&&k==='action'?'fail':'pass')]))}])),
  titleIssues:[],proseNotes:[],finalState:{...check(fail==='ending'?'fail':'pass'),observedState:'Seated holding Toto outside cellar.'},
  productionChecks:Object.fromEntries(['continuity','authorization','worldRules','sceneScope','storyMemory','outcome','nextDecisionSetup'].map(k=>[k,check(k===fail?'fail':'pass')]))};
}
class Probe extends TurnPipelineGameEngine {
 menuProgress: number[]=[];
 reviewQueue: Array<{anchorChoiceIndex:number|null;unusableChoiceIndexes:number[];unusableChoicesReason:string;reason:string}>=[];
 openingFor(s:GameState, cs= candidates){return this.scene('Open',s,undefined,cs,1,'opening',true);}

 generate(s=state,opening=false,complete=false){
  const cs=complete?[{...candidates[0]!,requiredEventBeats:beats.slice(0,7),storyEvents:[{...event,beats:beats.slice(0,7)}],currentStoryEvent:{...event,beats:beats.slice(0,7)}}]:candidates;
  return this.scene('Continue',s,opening?undefined:'Retrieve Toto and get toward the cellar',cs,4,opening?'opening':'interactive_turn',true,undefined,opening?undefined:fixture.contract.sourceBeatSelection);
 }
 protected override async sceneChoices(...args:Parameters<TurnPipelineGameEngine['sceneChoices']>){
  this.menuProgress=[...(args[1].sourceEventProgress?.completedBeatIndexes??[])];
  return [{id:'alt1',type:'action' as const,text:'Look through the window'},{id:'alt2',type:'action' as const,text:'Check the room for damage'}];
 }
 protected override async reviewSceneChoices(){return this.reviewQueue.shift() ?? {anchorChoiceIndex:0,unusableChoiceIndexes:[],unusableChoicesReason:'',reason:'Choices checked.'};}
}
function engine(fail?:string, repairOnce=false){
 let reviewCalls=0;
 const seen:AiResponseRequest[]=[];
 const probe=new Probe({provider:'openai',model:'gpt-5-nano',async createResponse(request){
  seen.push(request);const input=JSON.parse(request.input),name=request.text?.format.name;
  if(name==='bookrpg_opening_source_context')return reply({facts:[],unresolved:[]});
  if(name==='bookrpg_single_beat_scene'){
   assert.ok(Object.keys(input).every(key=>['transition','scope_context'].includes(key)));assert.ok(input.transition);assert.doesNotMatch(request.instructions!,/TURN CONTRACT|ORDERED TURN SCRIPT/);
   if(fail==='generation'&&input.transition.beat_index===4)return {status:'incomplete',output_text:''};
   return reply({text:input.transition.action});
  }
  if(name==='bookrpg_next_decision_setup'){
   assert.ok(input.next_decision);
   assert.equal(typeof input.source_excerpt,'string');
   return reply({text: input.indexed_end_state || 'The next decision is visibly ready to begin.'});
  }
  assert.equal(request.model,'gpt-5.6-luna');
  assert.doesNotMatch(request.input,/FUTURE_SUMMARY/);
  if(name==='bookrpg_canonical_rewrite'){
   assert.ok(request.instructions!.includes(CONVERSATIONAL_REACH_POLICY));
   assert.ok(request.instructions!.includes(ACTION_ENTRY_PHASE_POLICY));
   assert.equal(input.book_style.title,'A different book');assert.equal(input.book_style.referenceExcerpt,'');assert.doesNotMatch(request.input,/SOURCE_STYLE/);
   assert.equal(input.production.nextDecision?.beat_index??null,currentTurnExecution()?.contract.nextPlayerDecision);
   const body=[input.ordered_execution.map((b:any)=>b.do).join(' '),input.next_decision_setup_scaffold].filter(Boolean).join(' ');
   return reply({...(fail==='falseDeath'?{peopleKilledInScene:['Toto']}:{}),title:'Storm',text:body || 'I am beside the road. The travelers are nearby.',
    sceneScope:{currentLocation:fail==='scopeCorrection'?'Unsupported bedroom':'Farmhouse',peoplePresent:['Dorothy','Toto'],peopleWithinSpeakingDistance:['Dorothy','Toto']},
    outcome:'active',outcomeReason:'',storyMemory:{summary:'The storm continues.',openThreads:[],canonFacts:[]}});
  }
  if(name==='bookrpg_next_decision_readiness'){
   assert.ok(input.pending_decision.entry_action);
   return reply({status:'pass',reason:'Fixture action is spontaneous and can begin without a new external stimulus.',
    causeStatus:'not_required',cause:'No external question or accusation is needed for this fixture action.',nextActionUnperformed:true,evidence:[]});
  }
  if(name==='bookrpg_canonical_scene_review'){
   assert.ok(request.instructions!.includes(CONVERSATIONAL_REACH_POLICY));
   assert.ok(request.instructions!.includes(ACTION_ENTRY_PHASE_POLICY));
   assert.equal(input.production.worldRules.length,0);
   if(fail==='incomplete')return {status:'incomplete',output_text:''};
   if(fail==='cascade'){
    reviewCalls++;
    if(reviewCalls===1)return reply(verdict(request,'beat'));
    if(reviewCalls===2){
     const value=verdict(request);
     value.productionChecks.storyMemory={status:'uncertain',reason:'A newly noticed open-thread issue remains.'};
     return reply(value);
    }
    return reply(verdict(request));
   }
   return reply(verdict(request,repairOnce && reviewCalls++ > 0 ? undefined : fail==='falseDeath'?'continuity':fail));
  }
  throw Error(`Unexpected legacy/model call ${name}`);
 }});
 return {probe,seen};
}
test('real canonical scene entry uses four bare calls, one rewrite and one review; menu sees only reviewed progress',async()=>{
 const {probe,seen}=engine();const before=structuredClone(state);
 const output=await probe.generate();
 assert.deepEqual(seen.map(r=>r.text?.format.name),[...Array(4).fill('bookrpg_single_beat_scene'),'bookrpg_canonical_rewrite','bookrpg_canonical_scene_review']);
 assert.deepEqual(output.sourceEventProgress,{eventId:event.eventId,completedBeatIndexes:[0,1,2,3,4,5,6]});
 assert.deepEqual(probe.menuProgress,[0,1,2,3,4,5,6]);
 assert.equal(output.choices[0]?.text,'Look through the window');
 assert.equal(output.sourceProgress,undefined);assert.deepEqual(state,before);
});
test('opening uses automatic prefix only and leaves first player action for the anchor',async()=>{
 const {probe,seen}=engine();
 const output=await probe.generate({...state,sourceEventProgress:undefined},true);
 assert.deepEqual(seen.filter(r=>r.text?.format.name==='bookrpg_single_beat_scene').map(r=>JSON.parse(r.input).transition.beat_index),[0,1,2]);
 assert.deepEqual(output.sourceEventProgress?.completedBeatIndexes,[0,1,2]);
 assert.match(output.choices[0]!.text,/Retrieve Toto/);
 const review=seen.find(r=>r.text?.format.name==='bookrpg_canonical_scene_review')!;
 assert.match(review.instructions!,/apply the shared meaningful-action policy/);
 assert.doesNotMatch(review.instructions!,/no extra selected or unselected actions/);
 assert.match(review.instructions!,/standing before running/);
 const writer=seen.find(r=>r.text?.format.name==='bookrpg_canonical_rewrite')!;
 const schema=writer.text!.format.schema as any;
 assert.match(schema.properties.sceneScope.properties.peoplePresent.description,/including animals and nonhuman characters/);
 assert.match(schema.properties.sceneScope.properties.peoplePresent.description,/beyond immediate physical reach/);
 for(const request of [writer,review]){
  assert.match(request.instructions!,/Do not equate presence with being touchable or verbal/);
  assert.match(request.instructions!,/Established proximity persists/);
  assert.match(request.instructions!,/Shared building alone.*is not enough/);
  assert.match(request.instructions!,/clearly stopping that same work establishes cessation/);
  assert.match(request.instructions!,/does not allow replacing a required specific operation/);
  assert.match(request.instructions!,/openThreads.*characterRuntime.*(?:goal|fear)/);
 }
});
test('canonical review keeps a speaking-distance NPC present when reviewer omits them from peoplePresent',async()=>{
 const noScopeState={...state,scene:{...state.scene,sceneScope:undefined}};
 const {probe,seen}=engine('speakingMissingPresent');
 const output=await probe.generate(noScopeState,true);
 assert.ok(output.sceneScope?.peoplePresent.includes('Uncle Henry'));
 assert.ok(output.sceneScope?.peopleWithinSpeakingDistance.includes('Uncle Henry'));
 const review=seen.find(r=>r.text?.format.name==='bookrpg_canonical_scene_review')!;
 assert.match(review.instructions!,/speaking distance logically implies physical presence/i);
});

test('a newly exposed review issue gets one extra bounded repair after the original failure is fixed',async()=>{
 const {probe,seen}=engine('cascade');
 const output=await probe.generate();
 assert.ok(output.sceneScope);
 assert.equal(seen.filter(r=>r.text?.format.name==='bookrpg_canonical_rewrite').length,3);
 assert.equal(seen.filter(r=>r.text?.format.name==='bookrpg_canonical_scene_review').length,3);
 const rewrites=seen.filter(r=>r.text?.format.name==='bookrpg_canonical_rewrite');
 assert.match(rewrites[1]!.input,/Beat .* action/);
 assert.match(rewrites[2]!.input,/newly noticed open-thread issue/i);
});

test('all completed beats advance the event cursor only after the single review passes',async()=>{
 const {probe}=engine();const output=await probe.generate(state,false,true);
 assert.equal(output.sourceEventProgress,null);assert.equal(output.sourceProgress?.eventId,event.eventId);
});
for(const failure of ['missingScope','malformedScope','beat','ending','authorization','worldRules','sceneScope','storyMemory','outcome','nextDecisionSetup','incomplete','generation'])test(`rejected ${failure} leaves input state and menu untouched after bounded repair`,async()=>{
 const {probe,seen}=engine(failure);const before=structuredClone(state);
 await assert.rejects(()=>probe.generate());
 assert.deepEqual(state,before);assert.deepEqual(probe.menuProgress,[]);
 assert.equal(seen.filter(r=>r.text?.format.name==='bookrpg_canonical_scene_review').length,failure==='generation'?0:['missingScope','malformedScope','incomplete'].includes(failure)?1:2);
});
test('isolated calls share the production call budget',async()=>{
 const {probe,seen}=engine();await assert.rejects(()=>runWithTurnBudget(()=>probe.generate(),new TurnBudget(4)),/budget/i);
 assert.equal(seen.length,4);
});
test('staged canonical eligibility excludes optional routes and invalid indexed states',()=>{
 assert.equal(canonicalBeatSceneEligible({...fixture.contract,sourceProgression:'optional'}),false);
 assert.equal(canonicalBeatSceneEligible({...fixture.contract,beats:fixture.contract.beats.map((b:any)=>({...b,resultingState:null}))}),false);
});
test('long windows use bounded concurrency and keep original order',async()=>{
 const count=10;const contract={...fixture.contract,completedBeatIndexes:[],allowedPlayerBeatIndexes:[],requiredAutomaticBeatIndexes:Array.from({length:count},(_,i)=>i),
  beats:Array.from({length:count},(_,i)=>({...beats[6],action:`World movement ${i}`}))};
 let active=0,peak=0;
 const output=await generateParallelBeatScene(contract,'test','low',async index=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return reply({text:`Movement ${index}`});},{maxBeats:32,concurrency:4});
 assert.equal(peak,4);assert.deepEqual(output.scene?.blocks.map(b=>b.beatIndex),Array.from({length:count},(_,i)=>i));
});

test('truncated canonical beat gets three bounded attempts with increasing output budget',async()=>{
 const contract={...fixture.contract,completedBeatIndexes:[],allowedPlayerBeatIndexes:[],requiredAutomaticBeatIndexes:[0],
  beats:[{...beats[6],action:'A long but factual world transition.'}]};
 const budgets:number[]=[];
 let calls=0;
 const output=await generateParallelBeatScene(contract,'test','low',async(_index,request)=>{
  budgets.push(request.max_output_tokens??0);calls++;
  if(calls<3)return {status:'incomplete',output_text:'',incomplete_details:{reason:'max_output_tokens'}} as any;
  return reply({text:'The world transition completes.'});
 },{maxBeats:32,concurrency:4});
 assert.equal(calls,3);
 assert.deepEqual(budgets,[1600,3200,6400]);
 assert.equal(output.failures.length,0);
 assert.equal(output.scene?.blocks[0]?.text,'The world transition completes.');
});

test('truncated canonical beat still fails after the third bounded attempt',async()=>{
 const contract={...fixture.contract,completedBeatIndexes:[],allowedPlayerBeatIndexes:[],requiredAutomaticBeatIndexes:[0],
  beats:[{...beats[6],action:'A world transition.'}]};
 const budgets:number[]=[];
 const output=await generateParallelBeatScene(contract,'test','low',async(_index,request)=>{
  budgets.push(request.max_output_tokens??0);
  return {status:'incomplete',output_text:'',incomplete_details:{reason:'max_output_tokens'}} as any;
 },{maxBeats:32,concurrency:4});
 assert.deepEqual(budgets,[1600,3200,6400]);
 assert.equal(output.scene,null);
 assert.match(output.failures[0]!.error,/max_output_tokens/);
});

test('non-token incomplete canonical beat still fails without retry',async()=>{
 const contract={...fixture.contract,completedBeatIndexes:[],allowedPlayerBeatIndexes:[],requiredAutomaticBeatIndexes:[0],
  beats:[{...beats[6],action:'A world transition.'}]};
 let calls=0;
 const output=await generateParallelBeatScene(contract,'test','low',async()=>{
  calls++;
  return {status:'incomplete',output_text:'',incomplete_details:{reason:'content_filter'}} as any;
 },{maxBeats:32,concurrency:4});
 assert.equal(calls,1);
 assert.equal(output.scene,null);
 assert.match(output.failures[0]!.error,/Incomplete beat 0/);
});

test('content review corrects metadata without rewriting prose or adding calls',async()=>{
 const {probe,seen}=engine('scopeCorrection');
 const result=await probe.generate();
 const request=seen.find(r=>r.text?.format.name==='bookrpg_canonical_scene_review')!;
 const input=JSON.parse(request.input);
 assert.equal(input.candidate_scene.sceneScope.currentLocation,'Unsupported bedroom');
 assert.equal(result.sceneScope?.currentLocation,'Farmhouse');
 assert.equal(result.text,input.candidate_scene.text);
 assert.match(request.instructions!,/mismatch in candidate metadata alone is repairable/);
 assert.match(request.instructions!,/ambiguity or contradictions in the actual prose remain fail/);
 assert.equal(seen.length,6);
});

test('automatic beats skip content review but retain the next-decision readiness gate',async()=>{
 const previous=process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
 delete process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
 try {
  const {probe,seen}=engine();
  const output=await probe.generate();
  assert.equal(seen.filter(r=>r.text?.format.name==='bookrpg_canonical_rewrite').length,1);
  assert.equal(seen.filter(r=>r.text?.format.name==='bookrpg_canonical_scene_review').length,0);
  assert.deepEqual(output.sourceEventProgress?.completedBeatIndexes,[0,1,2,3,4,5,6]);
  assert.equal(seen.filter(r=>r.text?.format.name==='bookrpg_next_decision_readiness').length,1);
  assert.equal(seen.length,6);
  const broken=engine('generation');
  await assert.rejects(()=>broken.probe.generate());
  assert.deepEqual(broken.probe.menuProgress,[]);
 } finally {process.env.BOOKRPG_SCENE_CONTENT_REVIEW=previous;}
});

test('automatic source option enters staged generation and stops before the next player beat',async()=>{
 const previous=process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
 process.env.BOOKRPG_SCENE_CONTENT_REVIEW='false';
 try {
  const liftBeats:StoryEventBeat[]=[
   {actor:null,action:'The house rises and is carried away by the cyclone.',agency:'external',stakes:'critical',targets:[],sourceReferences:[],resultingState:'The house is airborne with Dorothy and Toto inside.'},
   {actor:'Dorothy',action:'Wait inside the airborne house.',agency:'intentional',stakes:'significant',targets:[],sourceReferences:[],resultingState:'Dorothy waits seated inside the house.', automaticPreludeSourceExcerpt:'The airborne house rocks gently while Toto moves around the room.', automaticPreludeEndState:'Dorothy is seated inside the rocking airborne house with Toto nearby.'} as StoryEventBeat,
  ];
  const lift={...event,eventId:'cyclone-lift',beats:liftBeats,description:'The cyclone lifts the house.'};
  const candidate={...candidates[0]!,requiredEventId:lift.eventId,requiredEvent:lift.description,requiredEventBeats:liftBeats,currentStoryEvent:lift,storyEvents:[lift]};
  const game={...state,sourceEventProgress:undefined};
  const {probe,seen}=engine();
  const output=await probe.continueFromSource(game,[candidate]);
  assert.ok(output);
  assert.deepEqual(seen.map(r=>r.text?.format.name).sort(),['bookrpg_canonical_rewrite','bookrpg_next_decision_setup','bookrpg_single_beat_scene','bookrpg_next_decision_readiness'].sort());
  const beatRequest=seen.find(r=>r.text?.format.name==='bookrpg_single_beat_scene')!;
  assert.equal(JSON.parse(beatRequest.input).transition.beat_index,0);
  const setupRequest=seen.find(r=>r.text?.format.name==='bookrpg_next_decision_setup')!;
  assert.match(JSON.parse(setupRequest.input).source_excerpt,/rocks gently while Toto moves/i);
  const rewriteRequest=seen.find(r=>r.text?.format.name==='bookrpg_canonical_rewrite')!;
  const rewrite=JSON.parse(rewriteRequest.input);
  assert.deepEqual(rewrite.ordered_execution.map((b:any)=>b.beat_index),[0]);
  assert.equal(rewrite.production.nextDecision.beat_index,1);
  assert.equal(rewrite.production.nextDecision.must_remain_unperformed,true);
  assert.deepEqual(rewrite.production.nextDecisionSetupEvidence,{sourceExcerpt:'The airborne house rocks gently while Toto moves around the room.',endState:'Dorothy is seated inside the rocking airborne house with Toto nearby.'});
  assert.match(rewrite.next_decision_setup_scaffold,/seated inside the rocking airborne house/i);
  assert.match(rewriteRequest.instructions!,/NEXT DECISION SETUP/);
  assert.deepEqual(output.scene.sourceEventProgress,{eventId:lift.eventId,completedBeatIndexes:[0]});
  assert.match(output.scene.choices[0]!.text,/Wait inside/i);
 } finally {process.env.BOOKRPG_SCENE_CONTENT_REVIEW=previous;}
});

for (const review of ['false','true']) test(`opening on a player decision uses static setup and credits no beat (review=${review})`,async()=>{
 const previous=process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
 process.env.BOOKRPG_SCENE_CONTENT_REVIEW=review;
 try {
  const openingBeats=[{...beats[3]!,action:'Run into the road and strike the travelers',resultingState:'The travelers have been struck.'}];
  const openingEvent={...event,beats:openingBeats};
  const cs=[{...candidates[0]!,requiredEventBeats:openingBeats,currentStoryEvent:openingEvent,storyEvents:[openingEvent]}];
  const {probe,seen}=engine();
  const output=await probe.openingFor({...state,sourceEventProgress:undefined,scene:{title:'Starting',text:'',choices:[]}},cs);
  assert.deepEqual(seen.map(r=>r.text?.format.name),['bookrpg_opening_source_context','bookrpg_canonical_rewrite',...(review==='true'?['bookrpg_canonical_scene_review']:['bookrpg_next_decision_readiness'])]);
  const request=seen.find(r=>r.text?.format.name==='bookrpg_canonical_rewrite')!;const input=JSON.parse(request.input);
  assert.match(request.instructions!,/SETUP-ONLY OPENING/);
  assert.deepEqual(input.production.openingFrame.targets,openingBeats[0]!.targets);
  assert.equal(input.production.openingFrame.entryAction.beat_index,0);
  assert.match(input.production.openingFrame.instruction,/relationships, not physical absence/);
  assert.deepEqual(input.ordered_execution,[]);
  assert.deepEqual(input.factual_scaffold,[]);
  assert.equal(input.production.nextDecision.beat_index,0);
  assert.equal(input.production.nextDecision.must_remain_unperformed,true);
  assert.deepEqual(output.sourceEventProgress,{eventId:event.eventId,completedBeatIndexes:[]});
  assert.equal(output.sourceProgress,undefined);
  assert.match(output.choices[0]!.text,/Run into the road/);
 } finally {process.env.BOOKRPG_SCENE_CONTENT_REVIEW=previous;}
});

test('canonical menu keeps the server-owned anchor without semantic choice review',async()=>{
 const {probe}=engine();
 probe.reviewQueue=[
  {anchorChoiceIndex:0,unusableChoiceIndexes:[1,2],unusableChoicesReason:'Must not be called',reason:'Must not be called'},
 ];
 const output=await probe.generate({...state,sourceEventProgress:undefined},true);
 assert.equal(output.choices.length,3);
 assert.match(output.choices[0]!.text,/Retrieve Toto/);
 assert.equal(output.choices[1]!.text,'Look through the window');
 assert.equal(output.choices[2]!.text,'Check the room for damage');
 assert.equal(probe.reviewQueue.length,1);
});
test('canonical menu still applies deterministic filtering without semantic review',async()=>{
 const {probe}=engine();
 probe.reviewQueue=[
  {anchorChoiceIndex:0,unusableChoiceIndexes:[1],unusableChoicesReason:'Must not be called',reason:'Must not be called'},
 ];
 const output=await probe.generate({...state,sourceEventProgress:undefined},true);
 assert.match(output.choices[0]!.text,/Retrieve Toto/);
 assert.equal(new Set(output.choices.map(choice=>choice.text)).size,output.choices.length);
 assert.equal(probe.reviewQueue.length,1);
});

test('per-beat presence removes Aunt Em on her cellar beat before the later house transport without a review call',async()=>{
 const transportBeats:StoryEventBeat[]=[
  {actor:'Aunt Em',action:'Climbs down into the ground cellar beneath the room.',agency:'intentional',stakes:'critical',targets:[],sourceReferences:[],resultingState:'Aunt Em is in the ground cellar below the farmhouse room.'},
  {actor:null,action:'The farmhouse lifts into the air and moves away.',agency:'external',stakes:'critical',targets:[],sourceReferences:[],resultingState:'The farmhouse is airborne and moving away; Dorothy and Toto remain inside it.'},
 ];
 const transportEvent={eventId:'transport',description:'The farmhouse leaves the cellar behind.',chapterPosition:3,sequence:3,beats:transportBeats};
 const transportState={...state,sourceEventProgress:undefined,scene:{...state.scene,
  text:'I am inside the farmhouse with Toto and Aunt Em nearby.',
  sceneScope:{currentLocation:'Farmhouse room',peoplePresent:['Dorothy','Toto','Aunt Em'],peopleWithinSpeakingDistance:['Dorothy','Toto','Aunt Em']}}};
 const contract=planTurn({state:transportState,event:transportEvent,mode:'source_continue',sourceProgression:'required'});
 assert.deepEqual(contract.requiredAutomaticBeatIndexes,[0,1]);
 const seen:string[]=[];
 const result=await generateCanonicalBeatScene(transportState,contract,[],{beat:'test',rewrite:'test',review:false},async(label,request)=>{
  seen.push(label);
  const input=JSON.parse(request.input);
  if(label.startsWith('scene beat')){
   assert.deepEqual(input.scope_context.initial_scope.peoplePresent,['Dorothy','Toto','Aunt Em']);
   const scopeDelta=input.transition.beat_index===0
    ? {addPresent:[],removePresent:['Aunt Em'],addSpeaking:[],removeSpeaking:['Aunt Em']}
    : {addPresent:[],removePresent:[],addSpeaking:[],removeSpeaking:[]};
   if(input.transition.beat_index===0)assert.match(request.instructions!,/move.*another character away|another character.*away/i);
   return reply({text:input.transition.action,scopeDelta});
  }
  if(label==='scene rewrite'){
   assert.deepEqual(input.beat_scope_deltas,[
    {beatIndex:0,scopeDelta:{addPresent:[],removePresent:['Aunt Em'],addSpeaking:[],removeSpeaking:['Aunt Em']}},
    {beatIndex:1,scopeDelta:{addPresent:[],removePresent:[],addSpeaking:[],removeSpeaking:[]}},
   ]);
   assert.deepEqual(input.beat_final_scope,{peoplePresent:['Dorothy','Toto'],peopleWithinSpeakingDistance:['Dorothy','Toto']});
   assert.match(request.instructions!,/per-beat spatial changes/);
   return reply({title:'Lifted',text:'Aunt Em climbed into the ground cellar. The farmhouse then lifted away with Toto and me inside.',
    peopleKilledInScene:[],sceneScope:{currentLocation:'inside the airborne farmhouse',peoplePresent:['Dorothy','Toto','Aunt Em'],peopleWithinSpeakingDistance:['Dorothy','Aunt Em']},
    outcome:'active',outcomeReason:'',storyMemory:{summary:'The farmhouse lifted away with Dorothy and Toto.',openThreads:[],canonFacts:['Aunt Em remained in the ground cellar.']}});
  }
  throw Error('Unexpected call '+label);
 });
 assert.deepEqual(result.scene.sceneScope?.peoplePresent,['Dorothy','Toto']);
 assert.deepEqual(result.scene.sceneScope?.peopleWithinSpeakingDistance,['Dorothy','Toto']);
 assert.ok(!result.scene.sceneScope?.peoplePresent.includes('Aunt Em'));
 assert.equal(seen.filter(label=>label==='scene content review').length,0);
});

test('a reported death forces content review even when optional review is disabled',async()=>{
 const previous=process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
 process.env.BOOKRPG_SCENE_CONTENT_REVIEW='false';
 try {
  const {probe,seen}=engine('falseDeath');
  const game={...state,characterProfiles:[{name:'Toto',aliases:[],role:'Dog',description:'',traits:[],relationships:[],storyArc:''}]};
  await assert.rejects(()=>probe.generate(game),/continuity/);
  const review=seen.find(r=>r.text?.format.name==='bookrpg_canonical_scene_review')!;
  assert.ok(review);
  assert.match(review.instructions!,/reject unsupported deaths/);
  assert.deepEqual(JSON.parse(review.input).candidate_scene.peopleKilledInScene,['Toto']);
  assert.deepEqual(probe.menuProgress,[]);
 } finally {process.env.BOOKRPG_SCENE_CONTENT_REVIEW=previous;}
});

for (const failure of ['authorization','storyMemory']) test(`semantic ${failure} repair reuses scaffold and reviews replacement before menu`,async()=>{
 const {probe,seen}=engine(failure,true);
 const before=structuredClone(state);
 await probe.generate();
 assert.equal(seen.filter(r=>r.text?.format.name==='bookrpg_single_beat_scene').length,4);
 const rewrites=seen.filter(r=>r.text?.format.name==='bookrpg_canonical_rewrite');
 assert.equal(rewrites.length,2);
 const repair=JSON.parse(rewrites[1]!.input).repair;
 assert.ok(repair.failures.some((f:string)=>f.includes(failure)));
 assert.ok(repair.rejectedScene);
 assert.equal(seen.filter(r=>r.text?.format.name==='bookrpg_canonical_scene_review').length,2);
 assert.deepEqual(state,before);
 assert.deepEqual(probe.menuProgress,[0,1,2,3,4,5,6]);
});

test('canonical review separates prior memory from the proposed replacement and checks carrier occupants',async()=>{
 const {probe,seen}=engine();
 const prior={summary:'Old snapshot',openThreads:[],canonFacts:['The trapdoor is open.','Dorothy is not holding Toto.']};
 await probe.generate({...state,storyMemory:prior});
 const review=seen.find(r=>r.text?.format.name==='bookrpg_canonical_scene_review')!;
 const payload=JSON.parse(review.input);
 assert.deepEqual(payload.production.priorStoryMemory,prior);
 assert.equal(payload.production.storyMemory,undefined);
 assert.deepEqual(payload.candidate_scene.storyMemory.canonFacts,[]);
 assert.match(review.instructions!,/complete proposed AFTER replacement/);
 assert.match(review.instructions!,/quote an offending fact from candidate_scene.storyMemory/);
 assert.match(review.instructions!,/excavated cellar, foundation, ground or dock/);
});
