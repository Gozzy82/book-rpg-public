import test from 'node:test';
import assert from 'node:assert/strict';
import type {GameState} from '../src/shared/contracts.js';
import type {TurnContract} from '../src/ai/engine/turn-contract.js';
import {NEXT_DECISION_READINESS_POLICY, pendingDecisionContext, nextDecisionReadinessFailures,
  reviewNextDecisionReadiness} from '../src/ai/engine/next-decision-readiness.js';

const bad = 'Dorothy slapped my nose. I stood confronting Dorothy and Toto, about to answer her accusation.';
const good = 'Dorothy slapped my nose. "Do not bite Toto! You should be ashamed to attack such a little dog," she said.';
function game(): GameState {
  return {gameId:'cause',book:{bookId:'oz',title:'Oz'},playerName:'Cowardly Lion',status:'active',
    objective:'',victoryCondition:'',selectedText:'',createdAt:'',updatedAt:'',turnNumber:1,
    gameProfile:{category:'adventure',endingMode:'open_ended',description:''},history:[],
    sourceCursor:{chapterPosition:0,textOffset:10},sourceEventProgress:{eventId:'attack',completedBeatIndexes:[]},
    scene:{title:'The road',text:'I face Dorothy in the road.',choices:[]}};
}
function contract(): TurnContract {
  return {version:1,turnNumber:1,mode:'source_continue',player:'Cowardly Lion',playerAliases:['Cowardly Lion'],
    selectedIntent:null,worldRules:[],sourceProgression:'required',contextJson:'{}',sourceEvidence:{},
    eventId:'attack',completedBeatIndexes:[],allowedPlayerBeatIndexes:[],requiredAutomaticBeatIndexes:[0],nextPlayerDecision:1,
    beats:[
      {actor:'Dorothy',action:'Slaps the Lion to protect Toto.',resultingState:'Toto is not bitten.',agency:'intentional',stakes:'critical',targets:['Cowardly Lion'],sourceReferences:[]},
      {actor:'Cowardly Lion',action:'Denies having bitten Toto.',decisionBoundaryBefore:'The Lion responds to Dorothy accusing him of trying to bite Toto.',
        resultingState:'The Lion denies biting Toto.',agency:'intentional',stakes:'significant',targets:['Dorothy'],sourceReferences:[],
        automaticPreludeSourceExcerpt:'Dorothy cries: Do not bite Toto! You should be ashamed to attack such a little dog.',
        automaticPreludeEndState:'Dorothy has rebuked the Lion.'},
    ],
  } as TurnContract;
}
const scene = (text:string) => ({title:'The Lion in the Road',text,outcome:'active' as const});
const present = (quote = good) => ({status:'pass',reason:'The visible warning supplies the accusation being answered.',
  causeStatus:'present',cause:'Dorothy rebukes the attempted attack on Toto.',nextActionUnperformed:true,
  evidence:[{source:'candidate_scene',sceneIndex:null,quote}]});
const missing = () => ({...present(),status:'fail',causeStatus:'missing',
  reason:'Only a slap and a circular reference to an accusation are visible; her actual accusation is absent.',evidence:[]});
const spontaneous = () => ({status:'pass',reason:'This first step is spontaneous and remains unperformed.',
  causeStatus:'not_required',cause:'No external question or accusation is needed.',nextActionUnperformed:true,evidence:[]});

test('the pasted Lion scene requires the substantive accusation, not merely presence or a slap',async()=>{
  const g=game(),before=structuredClone(g),c=contract();let calls=0;
  const failures=await reviewNextDecisionReadiness(g,c,scene(bad),'test',async(label,request)=>{
    calls++;assert.equal(label,'scene next decision readiness review');
    const input=JSON.parse(request.input);
    assert.equal(input.pending_decision.entry_action.action,'Denies having bitten Toto.');
    assert.match(input.pending_decision.source_setup.excerpt,/Do not bite Toto/);
    assert.equal(input.candidate_scene.text,bad);
    assert.match(request.instructions!,/Circular readiness summaries/);
    assert.match(request.instructions!,/A slap, mere presence/);
    return {status:'completed',output_text:JSON.stringify(missing())};
  });
  assert.equal(calls,1);assert.ok(failures.some(f=>f.includes('missing visible cause')));
  assert.deepEqual(g,before);assert.deepEqual(c,contract());
});

test('a concrete paraphrase passes without demanding exact source dialogue',()=>{
  assert.deepEqual(nextDecisionReadinessFailures(present(),game(),scene(good)),[]);
  assert.deepEqual(nextDecisionReadinessFailures(present(good.replace('Dorothy slapped', 'Dorothy\n slapped')),game(),scene(good)),[]);
});

test('source-only or menu-only evidence cannot prove a visible accusation',()=>{
  const g=game();g.scene.title=good;g.scene.choices=[{id:'anchor',type:'action',text:good}];
  g.storyMemory={summary:good,canonFacts:[good],openThreads:[]};
  assert.ok(nextDecisionReadinessFailures(present(),g,scene(bad)).some(f=>f.includes('absent')));
  assert.ok(nextDecisionReadinessFailures({...present(),evidence:[{source:'source_setup',sceneIndex:null,quote:good}]},g,scene(bad)).length);
});

test('an existing visible cause may be cited without replaying it in the new scene',()=>{
  const g=game();g.history=[{kind:'scene',text:good},{kind:'choice',text:'UNSAVED_CHOICES_ARE_NOT_VISIBLE_SCENES'}];
  const verdict={...present(),evidence:[{source:'accepted_scene_history',sceneIndex:0,quote:good}]};
  assert.deepEqual(nextDecisionReadinessFailures(verdict,g,scene('I remain in the road, my nose stinging.')),[]);
  assert.ok(nextDecisionReadinessFailures({...verdict,evidence:[{source:'accepted_scene_history',sceneIndex:1,quote:'UNSAVED_CHOICES_ARE_NOT_VISIBLE_SCENES'}]},g,scene(bad)).length);
});

test('current-scene prose is admissible evidence but fabricated history indexes are not',()=>{
  const g=game();g.scene.text=good;
  assert.deepEqual(nextDecisionReadinessFailures({...present(),evidence:[{source:'current_scene',sceneIndex:null,quote:good}]},g,scene('My nose stings.')),[]);
  assert.ok(nextDecisionReadinessFailures({...present(),evidence:[{source:'accepted_scene_history',sceneIndex:999,quote:good}]},g,scene(good)).length);
});

test('malformed, uncertain, missing-cause or prematurely executed decisions cannot pass',()=>{
  const values=[null,{}, {status:'pass',reason:'All fine.'}, {...present(),status:'uncertain'},
    {...present(),causeStatus:'missing'}, {...present(),nextActionUnperformed:false},
    {...present(),evidence:[]}, {...spontaneous(),evidence:present().evidence},
    {...present(),evidence:[{source:'candidate_scene',quote:good}]}, {...present(),extra:true}];
  for(const value of values)assert.ok(nextDecisionReadinessFailures(value,game(),scene(good)).length,JSON.stringify(value));
});

test('spontaneous actions do not acquire an invented external prerequisite',async()=>{
  const original=contract();
  const c={...original,beats:original.beats.map((beat,i)=>i===1 ? {...beat,action:'Ask to join the travelers.',decisionBoundaryBefore:'The Lion chooses to ask for company.',automaticPreludeSourceExcerpt:''} : beat)};
  const result=await reviewNextDecisionReadiness(game(),c,scene('The travelers stand beside me.'),'test',async()=>({status:'completed',output_text:JSON.stringify(spontaneous())}));
  assert.deepEqual(result,[]);
});

test('a broad group label keeps the entry beat distinct from later completion prerequisites',()=>{
  const c={...contract(),nextPlayerAction:{kind:'player_action',id:'dialogue',choiceText:'Confront Dorothy’s accusation',completion:'Deny biting Toto, then admit cowardice.',
    playerBeatIndexes:[1,3],endBeatIndex:3,preconditions:['Dorothy has rebuked the attempted attack.'],interruptWhen:[],boundaryReason:'One bounded exchange.'}} as TurnContract;
  const context=pendingDecisionContext(c)!;
  assert.equal(context.choice_label,'Confront Dorothy’s accusation');
  assert.equal(context.entry_action.action,'Denies having bitten Toto.');
  assert.deepEqual(context.goal?.indexed_preconditions,['Dorothy has rebuked the attempted attack.']);
  assert.match(NEXT_DECISION_READINESS_POLICY,/FIRST unperformed act/);
  assert.match(NEXT_DECISION_READINESS_POLICY,/later accusation.*unchosen player reply/);
});

test('cross-event origin is preserved for the immediate next decision',()=>{
  const c={...contract(),nextPlayerDecisionOrigin:{eventId:'reply',beatIndex:0}};
  const context=pendingDecisionContext(c)!;
  assert.equal(context.event_id,'reply');assert.equal(context.source_beat_index,0);assert.equal(context.beat_index,1);
});

test('missing prelude does not bypass readiness and repair feedback reaches the reviewer',async()=>{
  const original=contract();
  const c={...original,beats:original.beats.map((beat,i)=>i===1 ? {...beat,automaticPreludeSourceExcerpt:undefined,automaticPreludeEndState:undefined} : beat)};
  let called=false;
  const result=await reviewNextDecisionReadiness(game(),c,scene(bad),'test',async(_label,request)=>{
    called=true;const input=JSON.parse(request.input);
    assert.equal(input.pending_decision.source_setup.excerpt,'');
    assert.deepEqual(input.previous_failures,['Missing accusation.']);
    return {status:'completed',output_text:JSON.stringify(missing())};
  },['Missing accusation.']);
  assert.equal(called,true);assert.ok(result.length);
});

test('terminal, optional and no-next-decision scenes need no readiness call',async()=>{
  const call=async()=>{throw Error('Unexpected call');};
  assert.deepEqual(await reviewNextDecisionReadiness(game(),{...contract(),nextPlayerDecision:null},scene(bad),'test',call),[]);
  assert.deepEqual(await reviewNextDecisionReadiness(game(),{...contract(),sourceProgression:'optional'},scene(bad),'test',call),[]);
  assert.deepEqual(await reviewNextDecisionReadiness(game(),contract(),{...scene(bad),outcome:'lost'},'test',call),[]);
});

test('incomplete and invalid JSON reviewer responses fail closed',async()=>{
  for(const response of [{status:'incomplete',output_text:''},{status:'completed',output_text:'not JSON'}]){
    assert.ok((await reviewNextDecisionReadiness(game(),contract(),scene(bad),'test',async()=>response)).length);
  }
});
