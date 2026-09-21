import test from 'node:test';
import assert from 'node:assert/strict';
import type {GameState} from '../src/shared/contracts.js';
import type {TurnContract} from '../src/ai/engine/turn-contract.js';
import {generateCanonicalBeatScene} from '../src/ai/engine/canonical-beat-scene.js';

const missingText='Dorothy slaps my nose. I stand in the road, confronting Dorothy and Toto, about to answer her accusation.';
const fixedText='Dorothy slaps my nose. "Do not bite Toto! You should be ashamed of attacking a little dog," she cries.';
const reply=(value:unknown)=>({status:'completed',output_text:JSON.stringify(value)});
function fixture() {
  const state:GameState={gameId:'lion-cause',book:{bookId:'oz',title:'Oz'},playerName:'Cowardly Lion',
    gameProfile:{category:'adventure',endingMode:'open_ended',description:''},objective:'',victoryCondition:'',
    status:'active',history:[],createdAt:'',updatedAt:'',selectedText:'',turnNumber:1,characterProfiles:[],
    sourceCursor:{chapterPosition:0,textOffset:0},sourceEventProgress:{eventId:'attack',completedBeatIndexes:[]},
    scene:{title:'The road',text:'Toto barks at me as Dorothy rushes forward.',choices:[],
      sceneScope:{currentLocation:'the road',peoplePresent:['Cowardly Lion','Dorothy','Toto'],peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy','Toto']}}};
  const contract:TurnContract={version:1,mode:'source_continue',turnNumber:1,player:state.playerName,playerAliases:[state.playerName],
    selectedIntent:null,worldRules:[],sourceProgression:'required',eventId:'attack',sourceEvidence:{},
    contextJson:JSON.stringify({current_scene:state.scene,recent_history:[],story_memory:null,character_runtime:{characters:[]}}),
    completedBeatIndexes:[],allowedPlayerBeatIndexes:[],requiredAutomaticBeatIndexes:[0],nextPlayerDecision:1,
    beats:[
      {actor:'Dorothy',action:'Slaps the Lion on the nose.',agency:'intentional',stakes:'critical',targets:['Cowardly Lion'],sourceReferences:[],resultingState:'Dorothy has stopped the Lion from biting Toto.'},
      {actor:'Cowardly Lion',action:'Denies having bitten Toto.',agency:'intentional',stakes:'significant',targets:['Dorothy'],sourceReferences:[],
        decisionBoundaryBefore:'The Lion answers Dorothy’s accusation.',resultingState:'The Lion has denied biting Toto.',
        automaticPreludeSourceExcerpt:'Dorothy slaps the Lion and cries: Do not bite Toto! You should be ashamed of attacking a little dog.',
        automaticPreludeEndState:'Dorothy has rebuked the attempted attack.'},
    ]} as TurnContract;
  return {state,contract};
}
const verdict=(good:boolean)=>({status:good?'pass':'fail',reason:good?'Dorothy visibly rebukes the attempted attack.':'The prose refers to an accusation but never supplies its substance.',
  causeStatus:good?'present':'missing',cause:'Dorothy accuses the Lion of trying to bite Toto.',nextActionUnperformed:true,
  evidence:good?[{source:'candidate_scene',sceneIndex:null,quote:fixedText}]:[]});

for(const repair of [true,false])test(`fast canonical route requires visible cause before returning scene/progress (repair=${repair})`,async()=>{
  const {state,contract}=fixture(),before=structuredClone(state);const calls:string[]=[];let writes=0;
  const run=()=>generateCanonicalBeatScene(state,contract,[],{beat:'test',rewrite:'test',review:false},async(label,request)=>{
    calls.push(label);const input=JSON.parse(request.input);
    if(label.startsWith('scene beat'))return reply({text:'Dorothy slaps the Lion on the nose.'});
    if(label==='scene next decision setup'){
      assert.match(request.instructions!,/Circular readiness summaries/);
      assert.equal(input.pending_decision.entry_action.action,'Denies having bitten Toto.');
      return reply({text:'The Lion is confronting Dorothy and ready to answer her accusation.'});
    }
    if(label==='scene rewrite'||label==='scene rewrite repair'){
      writes++;assert.match(request.instructions!,/substance/);
      if(writes>1)assert.match(JSON.stringify(input.repair.failures),/missing visible cause/);
      return reply({title:'The Lion in the Road',text:repair&&writes>1?fixedText:missingText,
        sceneScope:state.scene.sceneScope,peopleKilledInScene:[],outcome:'active',outcomeReason:'',
        storyMemory:{summary:'Dorothy stopped the attack.',canonFacts:[],openThreads:[]}});
    }
    if(label==='scene next decision readiness review')return reply(verdict(repair&&writes>1));
    throw Error(`Unexpected call ${label}`);
  });
  if(repair){const result=await run();assert.equal(result.scene.text,fixedText);assert.deepEqual(result.completedBeatIndexes,[0]);}
  else await assert.rejects(run,/missing visible cause/);
  assert.equal(calls.filter(label=>label.startsWith('scene beat')).length,1);
  assert.equal(calls.filter(label=>label==='scene next decision setup').length,1);
  assert.equal(calls.filter(label=>label==='scene next decision readiness review').length,repair?2:3);
  assert.equal(calls.includes('scene content review'),false);
  assert.deepEqual(state,before);assert.equal(contract.nextPlayerDecision,1);
});

test('full content review remains one review and checks the same explicit-cause policy',async()=>{
  const {state,contract}=fixture();let narrowCalls=0,fullCalls=0;
  const result=await generateCanonicalBeatScene(state,contract,[],{beat:'test',rewrite:'test',review:true},async(label,request)=>{
    const input=JSON.parse(request.input);
    if(label.startsWith('scene beat'))return reply({text:'Dorothy slaps the Lion on the nose.'});
    if(label==='scene next decision setup')return reply({text:'Dorothy rebukes the Lion for attacking a little dog.'});
    if(label==='scene rewrite')return reply({title:'The road',text:fixedText,sceneScope:state.scene.sceneScope,
      peopleKilledInScene:[],outcome:'active',outcomeReason:'',storyMemory:{summary:'Dorothy rebuked the attack.',openThreads:[],canonFacts:[]}});
    if(label==='scene next decision readiness review'){narrowCalls++;throw Error('Duplicate readiness review');}
    if(label==='scene content review'){
      fullCalls++;assert.match(request.instructions!,/Circular readiness summaries/);
      assert.match(request.instructions!,/productionChecks.nextDecisionSetup, separately assess/);
      assert.equal(input.production.pending_decision.entry_action.action,'Denies having bitten Toto.');
      const pass={status:'pass',reason:'The visible slap and concrete rebuke support the current endpoint and future denial.'};
      return reply({resolvedSceneScope:state.scene.sceneScope,
        blocks:Object.fromEntries(input.expected_beats.map((b:{key:string})=>[b.key,{observedState:'Dorothy has slapped the Lion.',perspective:pass,action:pass,order:pass,resultingState:pass}])),
        titleIssues:[],proseNotes:[],finalState:{...pass,observedState:'Dorothy has stopped the attack.'},
        productionChecks:Object.fromEntries(['continuity','authorization','worldRules','sceneScope','storyMemory','outcome','nextDecisionSetup'].map(k=>[k,pass]))});
    }
    throw Error(`Unexpected call ${label}`);
  });
  assert.equal(result.scene.text,fixedText);assert.equal(fullCalls,1);assert.equal(narrowCalls,0);
});
