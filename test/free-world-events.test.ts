import test from 'node:test';
import assert from 'node:assert/strict';
import {freeWorldContext, generateFreeWorldScene, parseFreeScene} from '../src/ai/free-world.js';
import {applyGeneratedScene} from '../src/games/service/game-state.js';
import type {AiClient, AiResponseRequest} from '../src/ai/provider.js';
import type {CharacterProfile, GameState} from '../src/shared/contracts.js';

const wolf = 'A wolf came down from heaven and bit Toto\'s head off';
const frogs = 'the heavens open up and it starts raining frogs';
function state(): GameState {
  return {gameId:'events', book:{bookId:'oz',title:'Oz'}, playerName:'Cowardly Lion',
    status:'active', narrativeMode:'free', selectedText:'FORBIDDEN_SOURCE_PASSAGE', objective:'', victoryCondition:'',
    gameProfile:{category:'adventure',endingMode:'open_ended',description:''}, createdAt:'',updatedAt:'',
    sourceCursor:{chapterPosition:0,textOffset:42,eventId:'confrontation'},
    sourceEventProgress:{eventId:'confrontation',completedBeatIndexes:[0,1]},
    characterProfiles:['Cowardly Lion','Dorothy','Toto'].map(name=>({name,aliases:name==='Toto'?['the terrier']:[],role:'character',description:'',traits:[],relationships:[],actions:[],significantEvents:[],storyArc:''})),
    confirmedDeadCharacters:[],history:[{kind:'scene',text:'Dorothy has already rebuked my attack on Toto.'}],
    scene:{title:'Road',text:'Dorothy has already rebuked my attack on Toto.',choices:[],sceneScope:{currentLocation:'road',peoplePresent:['Cowardly Lion','Dorothy','Toto'],peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy','Toto']}}};
}
function draft(text:string, killed:string[]=[]){
  return {title:'Changed road',text,development:text,outcome:'active',outcomeReason:'',peopleKilledInScene:killed,
    sceneScope:{currentLocation:'road',peoplePresent:['Cowardly Lion','Dorothy'],peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy']},
    storyMemory:{summary:text,canonFacts:['Toto is dead.'],openThreads:['Find shelter.']},
    choices:[{text:'Seek shelter.',type:'action',character:null,followsBridge:false},{text:'Inspect the road.',type:'action',character:null,followsBridge:false}]};
}
function verdict(text:string){
  return {accepted:true,reason:'Reviewed',bridgeEvidence:null,eventEvidence:text,
    eventChecks:{eventResolution:{status:'pass',reason:'New event is central.'},continuity:{status:'pass',reason:'Played consequences persist.'},
      playerAgency:{status:'pass',reason:'No voluntary player action.'},deathConsistency:{status:'pass',reason:'Victims and metadata agree.'}}};
}
function client(outputs:unknown[],calls:AiResponseRequest[]):AiClient{
  return {provider:'openai',model:'test',async createResponse(request){calls.push(request);assert.ok(outputs.length,'Unexpected call');return {status:'completed',output_text:JSON.stringify(outputs.shift())};}};
}

test('consecutive world events persist the first death and pass it to the next writer and reviewer without source progress',async()=>{
  const game=state();const cursor=structuredClone(game.sourceCursor);const progress=structuredClone(game.sourceEventProgress);
  const calls:AiResponseRequest[]=[];
  const first=draft('I see a wolf descend from heaven and bite Toto\'s head off. Dorothy cries out beside his body.',['the terrier']);
  game.history.push({kind:'event',text:wolf});
  const firstScene=await generateFreeWorldScene(game,wolf,'event',undefined,client([first,verdict(first.text)],calls));
  applyGeneratedScene(game,firstScene);
  game.history.push({kind:'scene',text:game.scene.text},{kind:'event',text:frogs});
  assert.deepEqual(game.confirmedDeadCharacters,['Toto']);
  const next=draft('Frogs rain from the opened sky onto my mane and the road. Dorothy shields her face beside Toto\'s still body.');
  const second=await generateFreeWorldScene(game,frogs,'event',undefined,client([next,verdict(next.text)],calls));
  applyGeneratedScene(game,second);
  assert.equal(calls.length,4);
  for(const request of calls.slice(2)){
    const input=JSON.parse(request.input);
    assert.equal(input.inputKind,'event');assert.equal(input.selectedInput,frogs);
    assert.deepEqual(input.deadCharacters,['Toto']);assert.equal(input.currentScene.text,first.text);
    assert.match(request.instructions!,/externally initiated occurrence/);
    assert.doesNotMatch(request.input,/FORBIDDEN_SOURCE_PASSAGE|confrontation/);
  }
  assert.deepEqual(game.confirmedDeadCharacters,['Toto']);assert.deepEqual(game.sourceCursor,cursor);assert.deepEqual(game.sourceEventProgress,progress);
});

test('dead NPCs cannot return as living participants under their names or aliases even before model review',()=>{
  const game=state();game.confirmedDeadCharacters=['Toto'];
  for(const name of ['Toto','the terrier']){
    const candidate=draft('Frogs fall onto the road.');candidate.sceneScope.peoplePresent.push(name);
    assert.throws(()=>parseFreeScene(candidate,game),/Dead NPC/);
  }
  const candidate=draft('The wolf kills Toto.',['Toto']);candidate.sceneScope.peopleWithinSpeakingDistance.push('Toto');candidate.sceneScope.peoplePresent.push('Toto');
  assert.throws(()=>parseFreeScene(candidate,state()),/Dead NPC/);
  assert.doesNotThrow(()=>parseFreeScene(draft('Frogs fall beside Toto\'s body.'),game));
});

test('a general accepted verdict cannot override a failed event continuity check; repair reaches writer and reviewer',async()=>{
  const game=state();game.confirmedDeadCharacters=['Toto'];const calls:AiResponseRequest[]=[];
  const bad=draft('Frogs fall. Dorothy repeats her earlier rebuke of my attack.');const review=verdict(bad.text);
  review.eventChecks.continuity={status:'fail',reason:'Replays the already completed confrontation.'};
  const fixed=draft('Frogs rain onto the road beside Toto\'s body. Dorothy shields her face.');
  const result=await generateFreeWorldScene(game,frogs,'event',undefined,client([bad,review,fixed,verdict(fixed.text)],calls));
  assert.equal(result.text,fixed.text);assert.equal(calls.length,4);
  for(const request of calls.slice(2))assert.match(JSON.parse(request.input).repairFeedback,/already completed confrontation/);
});

test('missing death metadata flagged by the event review triggers repair before persistence',async()=>{
  const game=state();const calls:AiResponseRequest[]=[];
  const missing=draft('I see the wolf descend and kill Toto.');const review=verdict(missing.text);
  review.eventChecks.deathConsistency={status:'fail',reason:'Toto is killed in prose but missing from peopleKilledInScene.'};
  const fixed={...missing,peopleKilledInScene:['Toto']};
  const result=await generateFreeWorldScene(game,wolf,'event',undefined,client([missing,review,fixed,verdict(fixed.text)],calls));
  applyGeneratedScene(game,result);assert.deepEqual(game.confirmedDeadCharacters,['Toto']);
  assert.match(calls[2]!.input,/missing from peopleKilledInScene/);
});

test('world events require complete review checks and an actual scene quotation',async()=>{
  for(const invalid of [{accepted:true,reason:'Fine',bridgeEvidence:null},{...verdict('Invented quotation')},
    {...verdict('Frogs fall.'),eventChecks:{...verdict('').eventChecks,eventResolution:{status:'uncertain',reason:'Event is only decorative.'}}}]){
    const calls:AiResponseRequest[]=[];const candidate=draft('Frogs fall.');
    await assert.rejects(generateFreeWorldScene(state(),frogs,'event',undefined,client([candidate,invalid,candidate,invalid,candidate,invalid],calls)));
    assert.equal(calls.length,6);
  }
});

test('free context uses baseline character traits and actual history rather than cursor-selected book development',()=>{
  const game=state();const initial={afterEventId:null,afterEventSequence:null,chapterPosition:0,stateSummary:'Initially fearful.',traits:['fearful'],goals:[],fears:[],beliefs:[],knownFacts:[],relationships:[]};
  const profile=game.characterProfiles![0]!;
  profile.dynamics={version:1,capabilities:{speech:{mode:'verbal',communicationModes:['speech'],evidenceEventIds:[]}},development:[initial,{...initial,afterEventId:'confrontation',afterEventSequence:10,stateSummary:'UNPLAYED_BOOK_DEVELOPMENT'}]};
  profile.significantEvents=[{eventId:'confrontation',sequence:10} as CharacterProfile['significantEvents'][number]];
  const context=freeWorldContext(game);
  assert.match(JSON.stringify(context),/Initially fearful/);assert.doesNotMatch(JSON.stringify(context),/UNPLAYED_BOOK_DEVELOPMENT|confrontation/);
  assert.match(JSON.stringify(context),/already rebuked/);
});
