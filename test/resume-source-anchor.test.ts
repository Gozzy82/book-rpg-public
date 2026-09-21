import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {GameState, ImportedBook, GameChoice, SceneScope} from '../src/shared/contracts.js';
import {SOURCE_ANCHOR_CHOICE_ID, SOURCE_CONTINUATION_CHOICE_ID} from '../src/shared/contracts.js';
import {sourceIndexFingerprint} from '../src/books/source-index/game-version.js';
import {reviewResumeAnchor} from '../src/ai/engine/resume-anchor-review.js';
// Set storage before importing the service/repository singletons.
const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookrpg-resume-isolated-'));
process.env.BOOKRPG_DATA_DIR = testDir;
const {restoreSideTurnSourceAnchor, restoreResumeSourceAnchor} = await import('../src/games/service/resume-source-anchor.js');
const {sanitizeStoredScene, resumeGame} = await import('../src/games/service/game-state.js');
after(() => fs.rm(testDir, {recursive: true, force: true}));

const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/oz-resume-anchor.json',import.meta.url),'utf8'));
const profiles=['Cowardly Lion','Dorothy','Scarecrow','Tin Woodman'].map(name=>({name,aliases:[],role:'character',description:'',traits:[],relationships:[],storyArc:''}));
const nextId=fixture.before.choices[0].sourceEventId;
const book:ImportedBook={bookId:'resume-anchor-book',title:'Oz',sourceSha256:'test',importedAt:'2026-09-17',
  chapters:Array.from({length:14},(_,index)=>({index,title:'Chapter',text:'The companions discuss travelling west.'})),
  worldBible:{summary:'',characters:profiles.map(p=>p.name),characterProfiles:profiles,locations:[]},
  storyEvents:[
    {eventId:fixture.sourceCursor.eventId,sequence:1,description:'The Lion reports to the others.',category:'other',chapterPosition:13,
      actors:profiles.map(p=>p.name),targets:[],sourceReferences:[]},
    {eventId:nextId,sequence:2,description:'The companions prepare to travel west.',category:'other',chapterPosition:13,
      actors:profiles.map(p=>p.name),targets:[],sourceReferences:[],beats:[
        {actor:'Cowardly Lion',action:'Proposes traveling to the Winkie country to find and destroy the Wicked Witch.',
          agency:'intentional',stakes:'critical',targets:['Dorothy','Scarecrow','Tin Woodman'],sourceReferences:[],resultingState:'The Lion proposed the journey.'},
        {actor:'Dorothy',action:'Agrees that the group must try.',agency:'intentional',stakes:'critical',targets:[],sourceReferences:[],resultingState:'Dorothy agreed.'},
        {actor:'Cowardly Lion',action:'Agrees to go with Dorothy but says he is too cowardly to kill the Witch.',
          agency:'intentional',stakes:'significant',targets:['Dorothy'],sourceReferences:[],resultingState:'The Lion agreed.'},
      ]},
  ]};
function game(damaged=false):GameState{
  const selected={id:SOURCE_ANCHOR_CHOICE_ID,type:'action' as const,text:'Leave the Throne Room and report my interview to the others',sourceAnchorRoute:'event' as const};
  return {gameId:'resume-anchor',book:{bookId:book.bookId,title:'Oz'},sourceIndexFingerprint:sourceIndexFingerprint(book),
    characterProfiles:profiles,playerName:'Cowardly Lion',status:'active',selectedText:'',history:[],
    gameProfile:{category:'exploration',endingMode:'open_ended',description:''},objective:'',victoryCondition:'',
    scene:structuredClone(damaged?fixture.after:fixture.before),sourceCursor:structuredClone(fixture.sourceCursor),
    confirmedDeadCharacters:[],turnNumber:23,
    storyMemory:{summary:'Oz gave the party a task.',canonFacts:[],openThreads:[]},
    turnHistory:[{turnNumber:23,kind:'choice',action:selected.text,scene:{title:'Report',text:'Reported.'},completedAt:'2026-09-17'}],
    undoSnapshot:{scene:{title:'Before report',text:'Waiting.',choices:[selected]},history:[],status:'active',selectedText:''},
    createdAt:'2026-09-17',updatedAt:'2026-09-17'};
}
const corrected=(g:GameState):SceneScope=>({...g.scene.sceneScope!,peoplePresent:[...g.scene.sceneScope!.peoplePresent,'Dorothy'],
  peopleWithinSpeakingDistance:[...g.scene.sceneScope!.peopleWithinSpeakingDistance,'Dorothy']});
const approve=async(g:GameState,_a:GameChoice)=>corrected(g);

test('resume retains or restores the logged Lion anchor without executing a turn',async()=>{
  for(const damaged of [false,true]){
    const g=game(damaged), before=structuredClone(g), old=g.scene.choices.find(c=>c.id===SOURCE_ANCHOR_CHOICE_ID);
    sanitizeStoredScene(g);
    if(!damaged) assert.equal(g.scene.choices[0]?.id,SOURCE_CONTINUATION_CHOICE_ID);
    assert.equal(await restoreResumeSourceAnchor(g,book,old,approve),true);
    assert.equal(g.scene.choices[0]?.id,SOURCE_ANCHOR_CHOICE_ID);
    assert.deepEqual(g.scene.choices[0]?.sourceBeatSelection,{eventId:nextId,beatIndex:0,endBeatIndex:0,kind:'beat'});
    assert.match(g.scene.choices[0]!.text,/Propose/);
    assert.ok(g.scene.choices[0]?.requiredPresentCharacters?.includes('Dorothy'));
    assert.deepEqual(g.scene.sceneScope,corrected(before));
    assert.equal(g.scene.text,before.scene.text);
    for(const key of ['turnNumber','sourceCursor','sourceEventProgress','storyMemory','history','turnHistory','undoSnapshot'] as const)
      assert.deepEqual(g[key],before[key]);
    assert.equal(await restoreResumeSourceAnchor(g,book,g.scene.choices[0],async()=>{throw Error('Unnecessary repeat review');}),false);
  }
});


test('side conversation keeps the same beat in slot one and removes a duplicate local action',()=>{
  const g=game(true);
  g.narrativeMode='canonical';
  g.scene={
    title:'Conversation aftermath',
    text:'I remain with Dorothy, Scarecrow, and Tin Woodman after a short discussion.',
    sceneScope:{currentLocation:'the throne room',peoplePresent:['Cowardly Lion','Dorothy','Scarecrow','Tin Woodman'],
      peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy','Scarecrow','Tin Woodman']},
    choices:[
      {id:'local-route',type:'action',text:'Propose traveling to the Winkie country to destroy the Wicked Witch'},
      {id:'other',type:'action',text:'Ask Dorothy what she thinks about the road west'},
    ],
    outcome:'active',
  };
  const previous:GameChoice={id:SOURCE_ANCHOR_CHOICE_ID,type:'action',
    text:'Propose traveling to the Winkie country to find and destroy the Wicked Witch',
    sourceEventId:nextId,sourceAnchorRoute:'event',
    sourceBeatSelection:{eventId:nextId,beatIndex:0,endBeatIndex:0,kind:'beat'}};
  const beforeProgress=structuredClone(g.sourceEventProgress);
  const result=restoreSideTurnSourceAnchor(g,book,previous);
  assert.deepEqual(result,{restored:true,invalidated:false});
  assert.equal(g.scene.choices[0]?.id,SOURCE_ANCHOR_CHOICE_ID);
  assert.equal(g.scene.choices[0]?.text,'Propose traveling to the Winkie country to find and destroy the Wicked Witch');
  assert.deepEqual(g.scene.choices[0]?.sourceBeatSelection,previous.sourceBeatSelection);
  assert.equal(g.scene.choices.some(choice=>choice.id==='local-route'),false);
  assert.deepEqual(g.sourceEventProgress,beforeProgress);
});


test('confirmed death of a required anchor participant invalidates the target for return planning',()=>{
  const g=game(true);
  g.narrativeMode='canonical';
  g.confirmedDeadCharacters=['Dorothy'];
  g.scene={
    title:'After the loss',text:'Dorothy is dead and the others remain in the room.',
    sceneScope:{currentLocation:'the throne room',peoplePresent:['Cowardly Lion','Scarecrow','Tin Woodman'],
      peopleWithinSpeakingDistance:['Cowardly Lion','Scarecrow','Tin Woodman']},
    choices:[{id:'other',type:'action',text:'Wait with the others'}],outcome:'active',
  };
  const previous:GameChoice={id:SOURCE_ANCHOR_CHOICE_ID,type:'action',
    text:'Propose traveling to the Winkie country to find and destroy the Wicked Witch',
    requiredPresentCharacters:['Dorothy'],sourceEventId:nextId,sourceAnchorRoute:'event',
    sourceBeatSelection:{eventId:nextId,beatIndex:0,endBeatIndex:0,kind:'beat'}};
  const result=restoreSideTurnSourceAnchor(g,book,previous);
  assert.equal(result.restored,false);
  assert.equal(result.invalidated,true);
  assert.equal(g.returnPlanning?.invalidatedTargets?.[0]?.eventId,nextId);
  assert.equal(g.returnPlanning?.invalidatedTargets?.[0]?.beatIndex,0);
  assert.match(g.returnPlanning?.invalidatedTargets?.[0]?.evidence.join(' ') ?? '',/Dorothy/);
});

test('failed review or changed index does not mutate the damaged save',async()=>{
  for(const mismatch of [false,true]){
    const g=game(true);
    if(mismatch)g.sourceIndexFingerprint='different';
    const before=structuredClone(g);
    await assert.rejects(restoreResumeSourceAnchor(g,book,undefined,async()=>{throw Error('Dorothy is actually absent.');}),mismatch?/index changed/:/actually absent/);
    assert.deepEqual(g,before);
  }
});

test('a deliberately noncanonical last choice is not replaced on resume',async()=>{
  const g=game(true);g.turnHistory![0]!.action='Explore another path.';
  const before=structuredClone(g);
  assert.equal(await restoreResumeSourceAnchor(g,book,undefined,async()=>{throw Error('Must not review');}),false);
  assert.deepEqual(g,before);
});

test('restoration respects partial beat progress and never skips an automatic prefix',async()=>{
  const g=game(true);g.sourceEventProgress={eventId:nextId,completedBeatIndexes:[0,1]};
  assert.equal(await restoreResumeSourceAnchor(g,book,undefined,approve),true);
  assert.equal(g.scene.choices[0]?.sourceBeatSelection?.beatIndex,2);
  const auto=game(true);auto.sourceEventProgress={eventId:nextId,completedBeatIndexes:[0]};
  const before=structuredClone(auto);
  assert.equal(await restoreResumeSourceAnchor(auto,book,undefined,async()=>{throw Error('Cannot skip Dorothy');}),false);
  assert.deepEqual(auto,before);
});

test('resume anchor reviewer receives current prose only and cannot invent presence or edit prose',async()=>{
  for(const bad of ['none','absent','extra','remove','dead'] as const){
    const g=game(true),before=structuredClone(g);
    if(bad==='dead')g.confirmedDeadCharacters=['Dorothy'];
    const run=()=>reviewResumeAnchor(g,fixture.before.choices[0],'test',async request=>{
      const input=JSON.parse(request.input);
      assert.equal(input.scene_text,g.scene.text);
      assert.equal(input.entry_source,undefined);
      assert.match(request.instructions!,/NOT evidence of presence/);
      const scope=corrected(g);
      const v={supported:bad!=='absent',reason:bad==='absent'?'Dorothy is elsewhere.':'Dorothy is visibly listening.',
        peoplePresent:scope.peoplePresent,peopleWithinSpeakingDistance:scope.peopleWithinSpeakingDistance,
        ...(bad==='extra'?{text:'Dorothy arrived.'}:{})};
      if(bad==='remove')v.peoplePresent=['Cowardly Lion','Dorothy'];
      return {status:'completed',output_text:JSON.stringify(v)};
    });
    if(bad==='none')assert.deepEqual(await run(),corrected(g));
    else await assert.rejects(run());
    assert.deepEqual(g.scene,before.scene);
  }
});

test('real resume persists the repaired scope and pinned anchor and is idempotent',async()=>{
  const fake=process.env.BOOKRPG_FAKE_AI;
  process.env.BOOKRPG_FAKE_AI='1';
  const {gameEngine}=await import('../src/games/service/engine-access.js');
  const engine=gameEngine(), original=engine.reviewResumeAnchor;
  const {saveBook}=await import('../src/books/repository.js');
  const {saveGame,getGame}=await import('../src/games/repository.js');
  let calls=0;
  engine.reviewResumeAnchor=async g=>{calls++;return corrected(g);};
  try{
    await saveBook(book);
    const g=game(true);
    await saveGame(g);
    await resumeGame(g.gameId);
    const restored=(await getGame(g.gameId))!;
    assert.equal(restored.scene.choices[0]?.sourceBeatSelection?.beatIndex,0);
    assert.ok(restored.scene.sceneScope?.peoplePresent.includes('Dorothy'));
    assert.equal(restored.turnNumber,23);
    assert.deepEqual(restored.sourceCursor,g.sourceCursor);
    assert.deepEqual(restored.storyMemory,g.storyMemory);
    await resumeGame(g.gameId);
    assert.equal(calls,1);
    const failed=game(false);failed.gameId='resume-anchor-rejected';
    await saveGame(failed);
    const savedBefore=await getGame(failed.gameId);
    engine.reviewResumeAnchor=async()=>{throw Error('Missing visible setup.');};
    await assert.rejects(resumeGame(failed.gameId),/Missing visible setup/);
    assert.deepEqual(await getGame(failed.gameId),savedBefore);

  }finally{
    engine.reviewResumeAnchor=original;
    if(fake===undefined)delete process.env.BOOKRPG_FAKE_AI;else process.env.BOOKRPG_FAKE_AI=fake;
  }
});
