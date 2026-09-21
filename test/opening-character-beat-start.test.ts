// These regression cases explicitly exercise the optional reviewed route.
process.env.BOOKRPG_SCENE_CONTENT_REVIEW = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {GameState, ImportedBook, BookStoryEvent} from '../src/shared/contracts.js';
import {canonicalGameStartContext, openingPlayerBeatIndex} from '../src/games/service/game-start.js';
import {planTurn} from '../src/ai/engine/turn-contract.js';
import {validateTurnEvidence} from '../src/ai/engine/turn-validator.js';
import {buildTurnScript} from '../src/ai/engine/turn-script.js';
import {buildSourceEventBeatProgressContext} from '../src/ai/engine/source-navigation.js';
import {contiguousReportedSourceBeatIndexes} from '../src/ai/engine/provider-scene-reviewer.js';
import {TurnPipelineGameEngine} from '../src/ai/engine/turn-pipeline-engine.js';
import {applyGeneratedScene} from '../src/games/service/game-state.js';
import {bindSourceAnchorSelection} from '../src/games/source-anchor-selection.js';
import {buildSourceContextCandidates, buildCanonicalNextEventCandidate, selectGroundedSourceCandidates} from '../src/games/service/source-candidates.js';
import {sourceIndexFingerprint} from '../src/books/source-index/game-version.js';
const events=JSON.parse(fs.readFileSync(new URL('./fixtures/import-goals/existing-character-events.json',import.meta.url),'utf8'));
const event:BookStoryEvent=structuredClone(events[1]);
event.chapterPosition=0;
for(const ref of [...event.sourceReferences,...event.beats!.flatMap(b=>b.sourceReferences)]){ref.chapterPosition=0;ref.chapterIndex=0;}
const profile=(name:string,lineStart:number)=>({name,aliases:name==='Tin Woodman'?['Woodman']:[],sourceReferences:[{chapterPosition:0,chapterIndex:0,lineStart,lineEnd:65}],significantEvents:[event],traits:[],relationships:[],actions:[],description:'',role:'protagonist'});
const book={bookId:'start-test',sourceSha256:'fixture',title:'Opening',author:'Fixture',chapters:[{index:0,title:'Chapter One',text:Array.from({length:70},(_,i)=>`Source line ${i+1}.`).join('\n')}],storyEvents:[event],worldBible:{characterProfiles:[profile('Tin Woodman',31),profile('Dorothy',1),profile('Scarecrow',1),profile('Toto',1)]}} as unknown as ImportedBook;
function state():GameState{
 const start=canonicalGameStartContext(book,'Tin Woodman');
 return {book:{bookId:book.bookId,title:book.title,author:book.author},gameId:'test',playerName:'Tin Woodman',playerActionVersion:2,characterProfiles:book.worldBible!.characterProfiles,
 sourceIndexFingerprint:sourceIndexFingerprint(book),sourceEventProgress:start.sourceEventProgress,sourceCursor:start.sourceCursor,selectedText:start.selectedText,
 parameters:[],status:'active',objective:'Explore',victoryCondition:'Explore',gameProfile:{category:'exploration',endingMode:'open_ended',description:'Explore'},history:[],createdAt:'now',updatedAt:'now',turnNumber:1,
 scene:{title:'Starting',text:'',choices:[]}};
}
test('index roles and source references choose original Tin Woodman beat 4, preserving the event',()=>{
 const before=JSON.stringify(book);
 for(const name of ['Tin Woodman','Woodman']){
  const start=canonicalGameStartContext(book,name);
  assert.deepEqual(start.sourceEventProgress,{eventId:event.eventId,startBeatIndex:4,completedBeatIndexes:[]});
  assert.equal(start.candidate.currentStoryEvent?.beats?.length,event.beats!.length);
  assert.match(start.candidate.excerpt,/^Source line 26\./);
  assert.doesNotMatch(start.candidate.excerpt,/Source line 5\./);
 }
 assert.equal(openingPlayerBeatIndex(book,event,'Dorothy'),0);
 assert.equal(openingPlayerBeatIndex({...book,worldBible:undefined},event,'Unknown'),0);
 assert.equal(JSON.stringify(book),before);
});
test('opening plans only discovery and Toto; no offscreen prefix is credited or fed to the writer',()=>{
 const game=state(),contract=planTurn({state:game,event,mode:'opening'});
 assert.equal(contract.startBeatIndex,4);
 assert.deepEqual(contract.completedBeatIndexes,[]);
 assert.deepEqual(contract.requiredAutomaticBeatIndexes,[4,5]);
 assert.equal(contract.nextPlayerDecision,6);
 const script=buildTurnScript(contract);
 assert.deepEqual(script.ordered_execution.map(b=>b.beat_index),[4,5]);
 assert.equal(script.source_start_state,null);
 const accepted=validateTurnEvidence(contract,{completedSourceEventBeatIndexes:[4,5]});
 assert.equal(accepted.status,'accepted');assert.deepEqual(accepted.authorizedCompletedBeatIndexes,[4,5]);
 assert.notEqual(validateTurnEvidence(contract,{completedSourceEventBeatIndexes:[5]}).status,'accepted');
 assert.notEqual(validateTurnEvidence(contract,{completedSourceEventBeatIndexes:[4,5,6]}).status,'accepted');
 assert.deepEqual(contiguousReportedSourceBeatIndexes([], [5], event.beats!.length,4),[]);
 assert.deepEqual(contiguousReportedSourceBeatIndexes([4], [5], event.beats!.length,4),[4,5]);
});
class OpeningEngine extends TurnPipelineGameEngine{
 open(game:GameState){return this.scene('Open',game,undefined,[canonicalGameStartContext(book,game.playerName).candidate],1,'opening',true);}
 advance(game:GameState){const choice=game.scene.choices[0]!;return this.scene('Continue',game,choice.text,buildSourceContextCandidates(book,game.sourceCursor!,game.playerName,{sourceEventProgress:game.sourceEventProgress,irreversiblyUnavailableCharacterIdentities:[]}),1,'interactive_turn',true,undefined,choice.sourceBeatSelection);}
 protected override async sceneChoices(){return [{id:'alternative',type:'action' as const,text:'Wait for help'},{id:'alternative2',type:'action' as const,text:'Look around the clearing'}];}
 protected override async reviewSceneChoices(){return {anchorChoiceIndex:0,unusableChoiceIndexes:[],unusableChoicesReason:'',reason:'Checked'};}
}
test('real opening persists [4,5], binds option 1 to 6, and resumes after reload without replay',async()=>{
 const calls:string[]=[],bareIndexes:number[]=[];
 const engine=new OpeningEngine({provider:'openai',model:'gpt-5-nano',async createResponse(request){
  const input=JSON.parse(request.input),name=request.text!.format.name;calls.push(name);
  const scope={currentLocation:'Beside the tree',peoplePresent:['Tin Woodman','Dorothy','Scarecrow','Toto'],peopleWithinSpeakingDistance:['Tin Woodman','Dorothy','Scarecrow']};
  const pass={status:'pass',reason:'Shown in the scene'};
  let value:unknown;
  if(name==='bookrpg_opening_source_context')value={facts:[],unresolved:[]};
  else if(name==='bookrpg_single_beat_scene'){bareIndexes.push(input.transition.beat_index);value={text:input.transition.action};}
  else if(name==='bookrpg_canonical_rewrite')value={title:'Found',text:'Dorothy finds me beside the tree, my axe raised and my joints rusted still. Toto barks and snaps at my legs, hurting his teeth.',sceneScope:scope,outcome:'active',outcomeReason:'',storyMemory:{summary:'Dorothy has found me.',openThreads:[],canonFacts:[]}};
  else if(name==='bookrpg_canonical_scene_review')value={resolvedSceneScope:scope,blocks:Object.fromEntries(input.expected_beats.map((b:any)=>[b.key,{observedState:'Shown',perspective:pass,action:pass,order:pass,resultingState:pass}])),titleIssues:[],proseNotes:[],finalState:{...pass,observedState:'Motionless beside the tree'},productionChecks:Object.fromEntries(['continuity','authorization','worldRules','sceneScope','storyMemory','outcome','nextDecisionSetup'].map(k=>[k,pass]))};
  else throw Error(`Unexpected call ${name}`);
  return {status:'completed',output_text:JSON.stringify(value)};
 }});
 const game=state();const scene=await engine.open(game);
 assert.deepEqual(bareIndexes,[4,5]);assert.equal(calls.length,5);
 assert.deepEqual(scene.sourceEventProgress,{eventId:event.eventId,startBeatIndex:4,completedBeatIndexes:[4,5]});
 applyGeneratedScene(game,scene);
 const reloaded=JSON.parse(JSON.stringify(game)) as GameState;
 bindSourceAnchorSelection(reloaded,book);
 assert.equal(reloaded.scene.choices[0]?.sourceBeatSelection?.beatIndex,6);
 const next=planTurn({state:reloaded,event,mode:'action',selectedIntent:reloaded.scene.choices[0]!.text,sourceBeatSelection:reloaded.scene.choices[0]!.sourceBeatSelection});
 assert.deepEqual(next.allowedPlayerBeatIndexes,[6]);
 assert.deepEqual(next.requiredAutomaticBeatIndexes,[7,8,9]);
 assert.deepEqual(validateTurnEvidence(next,{completedSourceEventBeatIndexes:[6,7,8,9]}).authorizedCompletedBeatIndexes,[4,5,6,7,8,9]);
 const progress=buildSourceEventBeatProgressContext(event,reloaded.sourceEventProgress)!;
 assert.equal(progress.nextRequiredBeat,event.beats![6]);assert.deepEqual(progress.completedBeatIndexes,[4,5]);
 const second=await engine.advance(reloaded);
 assert.deepEqual(second.sourceEventProgress,{eventId:event.eventId,startBeatIndex:4,completedBeatIndexes:[4,5,6,7,8,9]});
 applyGeneratedScene(reloaded,second);bindSourceAnchorSelection(reloaded,book);
 assert.equal(reloaded.scene.choices[0]?.sourceBeatSelection?.beatIndex,10);
 const third=await engine.advance(reloaded);
 assert.equal(third.sourceEventProgress,null);
 assert.equal(third.sourceProgress?.eventId,event.eventId);
 assert.deepEqual(bareIndexes,[4,5,6,7,8,9,10,11]);

});

test('service candidate selection retains the unfinished event despite a cursor inside it',async()=>{
 const game=state();game.sourceEventProgress={eventId:event.eventId,startBeatIndex:4,completedBeatIndexes:[4,5]};
 const next={...event,eventId:'next-event',sequence:event.sequence+1,sourceReferences:[{chapterPosition:0,chapterIndex:0,lineStart:66,lineEnd:70}]};
 const indexedBook={...book,storyEvents:[event,next]};
 const world={sourceEventProgress:game.sourceEventProgress,irreversiblyUnavailableCharacterIdentities:[]};
 const candidates=buildSourceContextCandidates(indexedBook,game.sourceCursor!,game.playerName,world);
 assert.equal(candidates[0]?.requiredEventId,event.eventId);
 // An exact saved event value is returned directly, without an AI event-selection call.
 assert.equal((await selectGroundedSourceCandidates(game,indexedBook,game.sourceCursor!,candidates,event.eventId))[0],candidates[0]);
 const completed={...world,sourceEventProgress:{...game.sourceEventProgress,completedBeatIndexes:Array.from({length:event.beats!.length-4},(_,i)=>i+4)}};
 assert.equal(buildCanonicalNextEventCandidate(indexedBook,game.sourceCursor!,game.playerName,completed)?.requiredEventId,next.eventId);
 // Existing zero-based partially played events receive the same protection.
 assert.equal(buildCanonicalNextEventCandidate(indexedBook,game.sourceCursor!,game.playerName,{...world,sourceEventProgress:{eventId:event.eventId,completedBeatIndexes:[0,1]}})?.requiredEventId,event.eventId);
});
