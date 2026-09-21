import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {GameState, ImportedBook} from '../src/shared/contracts.js';
import type {AiClient, AiResponseRequest} from '../src/ai/provider.js';
import {SOURCE_ANCHOR_CHOICE_ID, SOURCE_CONTINUATION_CHOICE_ID} from '../src/shared/contracts.js';
import {sourceIndexFingerprint} from '../src/books/source-index/game-version.js';

// Isolate repository singletons even though most cases use the in-memory service.
const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookrpg-world-event-anchor-'));
process.env.BOOKRPG_DATA_DIR = testDir;
const {applyFreeWorldTurn} = await import('../src/games/service/free-world.js');
after(() => fs.rm(testDir, {recursive:true, force:true}));

const names = ['Dorothy', 'Aunt Em', 'Toto'];
const profiles = names.map(name => ({name, aliases:[], role:'character', description:'', traits:[], relationships:[], storyArc:''}));
const book: ImportedBook = {
  bookId:'world-event-anchor', title:'Oz', sourceSha256:'test', importedAt:'2026-09-20',
  chapters:[{index:0,title:'Kansas',text:'Dorothy stands beside Aunt Em. Dorothy offers her coat to Aunt Em.'}],
  worldBible:{summary:'A farm in Kansas.',characters:names,characterProfiles:profiles,locations:[]},
  storyEvents:[
    {eventId:'arrival',sequence:0,description:'Dorothy joins Aunt Em.',category:'other',chapterPosition:0,
      actors:['Dorothy'],targets:['Aunt Em'],sourceReferences:[]},
    {eventId:'coat',sequence:1,description:'Dorothy offers her coat to Aunt Em.',category:'other',chapterPosition:0,
      actors:['Dorothy','Aunt Em'],targets:[],sourceReferences:[],beats:[
        {actor:'Dorothy',action:'Offers her coat to Aunt Em.',agency:'intentional',stakes:'significant',
          targets:['Aunt Em'],sourceReferences:[],resultingState:'Dorothy has offered her coat.'},
        {actor:'Aunt Em',action:'Accepts the coat.',agency:'intentional',stakes:'significant',
          targets:[],sourceReferences:[],resultingState:'Aunt Em has the coat.'},
      ]},
  ],
};
function game(): GameState {
  return {
    gameId:'world-event-anchor-game',book:{bookId:book.bookId,title:book.title},
    sourceIndexFingerprint:sourceIndexFingerprint(book),playerName:'Dorothy',characterProfiles:profiles,
    narrativeMode:'canonical',status:'active',selectedText:'FORBIDDEN_SOURCE_PASSAGE',
    objective:'',victoryCondition:'',gameProfile:{category:'exploration',endingMode:'open_ended',description:''},
    createdAt:'2026-09-20',updatedAt:'2026-09-20',turnNumber:2,confirmedDeadCharacters:[],
    sourceCursor:{chapterPosition:0,textOffset:32,eventId:'arrival'},
    sourceEventProgress:{eventId:'coat',completedBeatIndexes:[]},sourceIntroducedCharacters:[...names],
    history:[{kind:'scene',text:'I stand beside Aunt Em with my coat over my arm. Toto rests beside the door.'}],
    storyMemory:{summary:'I am at home.',canonFacts:[],openThreads:[]},
    scene:{title:'The farmhouse',text:'I stand beside Aunt Em with my coat over my arm. Toto rests beside the door.',
      sceneScope:{currentLocation:'the farmhouse',peoplePresent:[...names],peopleWithinSpeakingDistance:[...names]},
      choices:[
        {id:SOURCE_ANCHOR_CHOICE_ID,type:'action',text:'Offer my coat to Aunt Em',sourceEventId:'coat',
          sourceAnchorRoute:'event',requiredPresentCharacters:['Aunt Em'],
          sourceBeatSelection:{eventId:'coat',beatIndex:0,endBeatIndex:0,kind:'beat'}},
        {id:'look',type:'action',text:'Look out of the window'},
      ],outcome:'active'},
  };
}
function candidate(text: string, killed: string[] = [], outcome: 'active' | 'lost' = 'active') {
  const living = names.filter(name => name === 'Dorothy' || !killed.includes(name));
  return {title:'A changed farmhouse',text,development:text,outcome,outcomeReason:outcome === 'lost' ? 'Dorothy died.' : '',
    peopleKilledInScene:killed,
    sceneScope:{currentLocation:'the farmhouse',peoplePresent:living,peopleWithinSpeakingDistance:living},
    storyMemory:{summary:text,canonFacts:[text],openThreads:[]},
    choices:outcome === 'active' ? [
      {type:'action',text:'Inspect the window.',character:null,followsBridge:false,advancesBridge:false},
      {type:'action',text:'Look at the door.',character:null,followsBridge:false,advancesBridge:false},
    ] : []};
}
function review(text: string, resolution: 'pass' | 'fail' | 'uncertain' = 'pass') {
  return {accepted:true,reason:'Reviewed against the requested external event.',eventEvidence:text,
    eventChecks:{
      eventResolution:{status:resolution,reason:resolution === 'pass' ? 'All stated effects occur.' : 'The requested world event has not happened.'},
      continuity:{status:'pass',reason:'Earlier played facts are preserved.'},
      playerAgency:{status:'pass',reason:'No voluntary player action is performed.'},
      deathConsistency:{status:'pass',reason:'Prose, death metadata and living scope agree.'},
    }};
}
function client(outputs: unknown[], calls: AiResponseRequest[]): AiClient {
  return {provider:'openai',model:'scripted-event-test',async createResponse(request) {
    calls.push(request);
    assert.ok(outputs.length, `Unexpected model call: ${request.text?.format.name}`);
    return {status:'completed',output_text:JSON.stringify(outputs.shift())};
  }};
}
function sourceState(g: GameState) {
  return structuredClone({cursor:g.sourceCursor,progress:g.sourceEventProgress,introduced:g.sourceIntroducedCharacters});
}

test('world event executes before the same canonical decision is restored, without bridge or source generation', async () => {
  const g = game(), before = sourceState(g), anchor = structuredClone(g.scene.choices[0]);
  const text = 'Rain suddenly pours through the open window. I feel droplets on my sleeve while Aunt Em flinches.';
  const calls: AiResponseRequest[] = [];
  await applyFreeWorldTurn(g, 'Rain suddenly pours through the open window.', 'event', book,
    {client:client([candidate(text),review(text)],calls)});
  assert.equal(g.scene.text,text);
  assert.equal(g.narrativeMode,'canonical');
  assert.deepEqual(sourceState(g),before);
  assert.equal(g.scene.choices[0]?.id,SOURCE_ANCHOR_CHOICE_ID);
  assert.deepEqual(g.scene.choices[0]?.sourceBeatSelection,anchor?.sourceBeatSelection);
  assert.equal(g.turnNumber,3);
  assert.equal(calls.length,2);
  for (const call of calls) {
    const input = JSON.parse(call.input);
    assert.equal(input.inputKind,'event');
    assert.equal(input.preparedOpportunity ?? null,null);
    assert.doesNotMatch(call.input,/FORBIDDEN_SOURCE_PASSAGE/);
  }
});

test('two consecutive external events do not consume the pending beat or repeat its NPC follow-up', async () => {
  const g = game(), before = sourceState(g), selection = structuredClone(g.scene.choices[0]?.sourceBeatSelection);
  for (const text of ['A loud thunderclap shakes the farmhouse.', 'The window slams shut in a sudden gust.']) {
    const calls: AiResponseRequest[] = [];
    g.history.push({kind:'event',text});
    await applyFreeWorldTurn(g,text,'event',book,{client:client([candidate(text),review(text)],calls)});
    g.history.push({kind:'scene',text:g.scene.text});
    assert.equal(g.scene.text,text);
    assert.deepEqual(g.scene.choices[0]?.sourceBeatSelection,selection);
    assert.deepEqual(sourceState(g),before);
    assert.equal(calls.length,2);
  }
  assert.equal(g.turnNumber,4);
});

test('a missing event is regenerated even when the aggregate review says accepted', async () => {
  const g = game(), before = sourceState(g), calls: AiResponseRequest[] = [];
  const missing = 'I watch the quiet window while Aunt Em hums.';
  const resolved = 'The window shatters and glass scatters across the empty floor.';
  await applyFreeWorldTurn(g,'The window shatters.','event',book,
    {client:client([candidate(missing),review(missing,'fail'),candidate(resolved),review(resolved)],calls)});
  assert.equal(g.scene.text,resolved);
  assert.equal(g.scene.choices[0]?.id,SOURCE_ANCHOR_CHOICE_ID);
  assert.deepEqual(sourceState(g),before);
  assert.equal(calls.length,4);
  assert.match(JSON.parse(calls[2]!.input).repairFeedback,/world event has not happened/);
});

test('exhausted event reviews reject without changing scene, memory, mode, source or bridges', async () => {
  const g = game(), before = structuredClone(g), calls: AiResponseRequest[] = [];
  const text = 'I watch the quiet window.';
  const outputs = Array.from({length:3},() => [candidate(text),review(text,'fail')]).flat();
  await assert.rejects(applyFreeWorldTurn(g,'The window shatters.','event',book,
    {client:client(outputs,calls)}));
  assert.deepEqual(g,before);
  assert.equal(calls.length,6);
});

test('a required participant death persists and invalidates the anchor without crediting source completion', async () => {
  const g = game(), before = sourceState(g), calls: AiResponseRequest[] = [];
  const text = 'A falling beam kills Aunt Em instantly. I am left beside her still body with Toto.';
  await applyFreeWorldTurn(g,'A falling beam kills Aunt Em.','event',book,
    {client:client([candidate(text,['Aunt Em']),review(text)],calls)});
  assert.equal(g.scene.text,text);
  assert.deepEqual(g.confirmedDeadCharacters,['Aunt Em']);
  assert.equal(g.scene.choices.some(choice => choice.id === SOURCE_ANCHOR_CHOICE_ID),false);
  assert.equal(g.scene.choices[0]?.id,SOURCE_CONTINUATION_CHOICE_ID);
  assert.equal(g.returnPlanning?.invalidatedTargets?.[0]?.eventId,'coat');
  assert.equal(g.returnPlanning?.invalidatedTargets?.[0]?.beatIndex,0);
  assert.deepEqual(sourceState(g),before);
  assert.match(JSON.stringify(g.storyMemory),/kills Aunt Em/);
  assert.equal(g.scene.sceneScope?.peopleWithinSpeakingDistance.includes('Aunt Em'),false);
});

test('an unrelated death does not invalidate the still-executable canonical decision', async () => {
  const g = game(), selection = structuredClone(g.scene.choices[0]?.sourceBeatSelection);
  const text = 'A falling beam kills Toto. Aunt Em and I remain beside the door, unharmed.';
  await applyFreeWorldTurn(g,'A falling beam kills Toto.','event',book,
    {client:client([candidate(text,['Toto']),review(text)],[])});
  assert.deepEqual(g.confirmedDeadCharacters,['Toto']);
  assert.deepEqual(g.scene.choices[0]?.sourceBeatSelection,selection);
  assert.equal(g.returnPlanning?.invalidatedTargets?.length ?? 0,0);
});

test('a terminal external event cannot restore an active source menu', async () => {
  const g = game();
  const text = 'The roof collapses on me, and I die beneath it.';
  await applyFreeWorldTurn(g,'The roof collapses and kills Dorothy.','event',book,
    {client:client([candidate(text,['Dorothy'],'lost'),review(text)],[])});
  assert.equal(g.scene.outcome,'lost');
  assert.deepEqual(g.scene.choices,[]);
  assert.deepEqual(g.confirmedDeadCharacters,['Dorothy']);
});

test('the real event endpoint saves the restored anchor and undo restores the pre-event source state', async () => {
  const oldFake = process.env.BOOKRPG_FAKE_AI;
  process.env.BOOKRPG_FAKE_AI = '1';
  const {saveBook} = await import('../src/books/repository.js');
  const {saveGame,getGame} = await import('../src/games/repository.js');
  const {initiateEvent,undoLastChoice} = await import('../src/games/service/operations.js');
  try {
    await saveBook(book);
    const g = game();
    await saveGame(g);
    const savedBefore = (await getGame(g.gameId))!;
    const result = await initiateEvent(g.gameId,{text:'A loud thunderclap shakes the farmhouse.'});
    const saved = (await getGame(g.gameId))!;
    assert.deepEqual(result.scene.choices[0]?.sourceBeatSelection,savedBefore.scene.choices[0]?.sourceBeatSelection);
    assert.deepEqual(saved.scene.choices[0]?.sourceBeatSelection,savedBefore.scene.choices[0]?.sourceBeatSelection);
    assert.equal(saved.narrativeMode,'canonical');
    assert.deepEqual(sourceState(saved),sourceState(savedBefore));
    assert.equal(saved.turnHistory?.at(-1)?.kind,'event');
    await undoLastChoice(g.gameId);
    const undone = (await getGame(g.gameId))!;
    assert.deepEqual(undone.scene,savedBefore.scene);
    assert.deepEqual(sourceState(undone),sourceState(savedBefore));
    assert.deepEqual(undone.history,savedBefore.history);
  } finally {
    if (oldFake === undefined) delete process.env.BOOKRPG_FAKE_AI;
    else process.env.BOOKRPG_FAKE_AI = oldFake;
  }
});
