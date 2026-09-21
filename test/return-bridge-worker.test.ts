import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import type {GameState, ImportedBook} from '../src/shared/contracts.js';
import {SOURCE_ANCHOR_CHOICE_ID} from '../src/shared/contracts.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookrpg-worker-'));
process.env.BOOKRPG_DATA_DIR = dir;
process.env.BOOKRPG_FAKE_AI = '1';
const {getGame, saveGame, changeReturnPlanning} = await import('../src/games/repository.js');
const {saveBook} = await import('../src/books/repository.js');
const {runReturnPlanningJob} = await import('../src/games/bridge-planner.js');
const {digest, rulesVersion} = await import('../src/games/return-bridges.js');
const {makeChoice, say, undoLastChoice} = await import('../src/games/service.js');
const {gameEngine} = await import('../src/games/service/engine-access.js');
after(() => fs.rm(dir, {recursive: true, force: true}));
const book: ImportedBook = {bookId: 'worker_book', title: 'Test', importedAt: '', sourceSha256: '', chapters: [{index: 0, title: 'Forest', text: 'A forest.'}]};
await saveBook(book);
function state(id: string): GameState {
  return {gameId: id, book: {bookId: book.bookId, title: book.title}, playerName: 'Alex',
    gameProfile: {category: 'adventure', endingMode: 'completion', description: ''}, objective: '', victoryCondition: '',
    selectedText: 'FORBIDDEN_SOURCE', status: 'active', narrativeMode: 'free', confirmedDeadCharacters: [],
    sourceCursor: {chapterPosition: 0, textOffset: 0}, history: [], createdAt: '', updatedAt: '',
    scene: {title: 'Forest', text: 'I wait with Mary.', sceneScope: {currentLocation: 'forest', peoplePresent: ['Alex','Mary'], peopleWithinSpeakingDistance: ['Alex','Mary']},
      choices: [{id: 'walk', type: 'action', text: 'Walk.'}, {id: 'talk', type: 'talk', text: 'Talk to Mary', character: 'Mary'}]}};
}
function plan(g: GameState) {
  return [{id: 'prepared', departureLocation:g.scene.sceneScope!.currentLocation, selectionReason:'Nearest useful target.', eventId: 'future', targetBeatIndex:0, target:{action:'Listen.',resultingState:'Alex hears the sound.',requiredSituation:'Alex is in the forest.'},
    leadIn:'The forest grows quiet before a repeated noise carries from deeper among the trees.',
    setup: 'A noise.', choiceText: 'Listen.', locationTerms: ['forest'], presentCharacters: [], availableCharacters: [],
    originCursor: digest(g.sourceCursor), indexVersion: '', rulesVersion: rulesVersion(g), createdAt: Date.now(), expiresAt: Date.now()+60000, status: 'ready' as const}];
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => {resolve = r;}); return {promise, resolve}; }
function forbidSourceCalls() {
  const engine = gameEngine();
  const keys = ['selectSourceCandidate', 'selectSourceEvent', 'identifyLatestVisibleStoryEvent'] as const;
  const original = keys.map(key => engine[key]);
  for (const key of keys) (engine as any)[key] = async () => {throw new Error(`Unexpected source call: ${key}`);};
  return () => keys.forEach((key, i) => {(engine as any)[key] = original[i];});
}
test('free choice completes while a durable worker is blocked; duplicate claim and stale publication are rejected', async () => {
  const game = state('worker_stale'); await saveGame(game);
  const entered = deferred(); const release = deferred();
  const worker = runReturnPlanningJob(game.gameId, async g => {entered.resolve(); await release.promise; return plan(g);}, Date.now()+2000);
  await entered.promise;
  const restore = forbidSourceCalls();
  try {
    assert.equal(await runReturnPlanningJob(game.gameId, async () => {throw new Error('Duplicate planner');}, Date.now()+2000), false);
    await makeChoice(game.gameId, {choiceId: 'walk'});
    const foreground = (await getGame(game.gameId))!;
    assert.deepEqual(foreground.sourceCursor, game.sourceCursor);
    release.resolve(); await worker;
    const after = (await getGame(game.gameId))!;
    assert.deepEqual(after.scene, foreground.scene); assert.deepEqual(after.turnHistory, foreground.turnHistory);
    assert.equal(after.gameRevision, foreground.gameRevision);
    assert.equal(after.returnPlanning!.bridges.length, 0); assert.ok(after.returnPlanning!.job);
  } finally {release.resolve(); await worker; restore();}
});
test('valid background publication changes planning only; next free scene can offer the cached anchor', async () => {
  const game = state('worker_publish'); await saveGame(game);
  const before = (await getGame(game.gameId))!;
  await runReturnPlanningJob(game.gameId, async g => plan(g), Date.now()+2000);
  const published = (await getGame(game.gameId))!;
  assert.equal(published.gameRevision, before.gameRevision); assert.deepEqual(published.scene, before.scene);
  assert.equal(published.returnPlanning?.bridges.length, 1);
  const restore = forbidSourceCalls();
  try {
    await makeChoice(game.gameId, {choiceId: 'walk'});
    const next = (await getGame(game.gameId))!;
    assert.equal(next.scene.choices[0]?.id, SOURCE_ANCHOR_CHOICE_ID);
    assert.equal(next.scene.choices[0]?.bridgeId, 'prepared');
    assert.deepEqual(next.sourceCursor, before.sourceCursor);
  } finally {restore();}
});
test('non-anchor conversation start and reply perform no source discovery or alignment', async () => {
  const game = state('worker_talk'); await saveGame(game); const restore = forbidSourceCalls();
  try {
    const response = await makeChoice(game.gameId, {choiceId: 'talk'});
    assert.ok('suggestions' in response);
    await say(game.gameId, {text: 'How are you?'});
    const next = (await getGame(game.gameId))!;
    assert.equal(next.narrativeMode, 'free'); assert.deepEqual(next.sourceCursor, game.sourceCursor);
    assert.equal(next.turnHistory?.at(-1)?.kind, 'dialogue'); assert.ok(next.returnPlanning?.job);
  } finally {restore();}
});
test('undo invalidates an in-flight worker without overwriting the restored scene', async () => {
  const game = state('worker_undo'); await saveGame(game); await makeChoice(game.gameId, {choiceId: 'walk'});
  const entered = deferred(); const release = deferred();
  const worker = runReturnPlanningJob(game.gameId, async g => {entered.resolve(); await release.promise; return plan(g);}, Date.now()+2000);
  await entered.promise;
  try {
    await undoLastChoice(game.gameId); const restored = (await getGame(game.gameId))!;
    release.resolve(); await worker;
    const after = (await getGame(game.gameId))!;
    assert.deepEqual(after.scene, restored.scene); assert.equal(after.returnPlanning!.bridges.length, 0);
    assert.equal(after.gameRevision, restored.gameRevision);
  } finally {release.resolve(); await worker;}
});
test('transient failure persists a retry and an expired lease can be reclaimed', async () => {
  const game = state('worker_retry'); await saveGame(game);
  await changeReturnPlanning(game.gameId, g => {g.returnPlanning!.job!.token = 'dead-worker'; g.returnPlanning!.job!.leaseUntil = 1; return true;});
  await runReturnPlanningJob(game.gameId, async () => {throw new Error('Simulated timeout');}, Date.now()+2000);
  const failed = (await getGame(game.gameId))!;
  assert.equal(failed.returnPlanning!.failures, 1); assert.ok(failed.returnPlanning!.job);
  assert.equal(await runReturnPlanningJob(game.gameId, async g => plan(g)), false);
  await runReturnPlanningJob(game.gameId, async g => plan(g), failed.returnPlanning!.job!.dueAt+1);
  assert.equal((await getGame(game.gameId))!.returnPlanning!.bridges.length, 1);
});
test('a restored menu with a missing bridge falls back to free play without book searching', async () => {
  const game = state('worker_missing');
  game.scene.choices[0] = {id: SOURCE_ANCHOR_CHOICE_ID, type: 'action', text: 'Listen.', bridgeId: 'missing', sourceEventId: 'future', sourceAnchorRoute: 'transition'};
  await saveGame(game); const restore = forbidSourceCalls();
  try {await makeChoice(game.gameId, {choiceId: SOURCE_ANCHOR_CHOICE_ID}); assert.equal((await getGame(game.gameId))!.narrativeMode, 'free');}
  finally {restore();}
});

test('observing a new free scene can offer the same still-relevant opportunity again', async () => {
  const game = state('worker_observe');
  const b = plan(game)[0]!;
  game.returnPlanning = {bridges: [{...b, status: 'offered'}], generation: 1};
  game.scene.choices[0] = {id: SOURCE_ANCHOR_CHOICE_ID, type: 'action', text: 'Listen.', bridgeId: b.id, sourceEventId: b.eventId, sourceAnchorRoute: 'transition'};
  await saveGame(game);
  const {continueScene} = await import('../src/games/service.js');
  await continueScene(game.gameId);
  const next = (await getGame(game.gameId))!;
  assert.equal(next.returnPlanning!.bridges[0]!.status, 'offered');
  assert.equal(next.scene.choices.some(c => c.bridgeId === b.id), true);
});

test('background planning writes a game trace including model calls and published plans',async()=>{
 const {readAiJson,jsonRequest}=await import('../src/ai/free-world.js');
 const game=state('worker_trace');await saveGame(game);
 await runReturnPlanningJob(game.gameId,async g=>{
   const client={provider:'openai' as const,model:'test',async createResponse(){return {status:'completed',output_text:'{"eventIds":[]}'}}};
   await readAiJson(client,jsonRequest(client,'bookrpg_return_bridge_targets','Select targets',{marker:'PLANNER_INPUT'},{}));
   return plan(g);
 },Date.now()+2000);
 const log=await fs.readFile(path.join(dir,'logs','games',`${game.gameId}.log`),'utf8');
 assert.match(log,/"operation": "returnPlanning"/);
 assert.match(log,/"event": "ai.request"/);assert.match(log,/"event": "ai.response"/);
 assert.match(log,/PLANNER_INPUT/);assert.match(log,/bridge_planning.published/);
});

test('clicking a reviewed bridge pins the exact target and passes canonical lookahead after leaving its trigger location',async()=>{
 const sourceRef={chapterPosition:0,chapterIndex:0,lineStart:1,lineEnd:1};
 const indexed={...book,bookId:'worker_pinned',storyEvents:[
  {eventId:'future',sequence:0,category:'discovery',description:'Hear the sound',actors:['Alex'],targets:[],chapterPosition:0,
   beats:[{actor:'Alex',agency:'intentional' as const,stakes:'significant' as const,action:'Listen.',resultingState:'Alex hears it.',targets:[],sourceReferences:[sourceRef]}],
   sourceReferences:[sourceRef]},
  {eventId:'warning',sequence:1,category:'discovery',description:'Mary warns Alex',actors:['Mary'],targets:['Alex'],chapterPosition:0,
   beats:[{actor:'Mary',agency:'intentional' as const,stakes:'significant' as const,action:'Warns Alex.',resultingState:'Alex has been warned.',targets:['Alex'],sourceReferences:[sourceRef]}],
   sourceReferences:[sourceRef]},
  {eventId:'next',sequence:2,category:'discovery',description:'Alex chooses what to do next',actors:['Alex'],targets:[],chapterPosition:0,
   beats:[{actor:'Alex',agency:'intentional' as const,stakes:'significant' as const,action:'Acts next.',resultingState:'Alex has acted.',targets:[],sourceReferences:[sourceRef]}],
   sourceReferences:[sourceRef]}
 ]};
 await saveBook(indexed);
 const game=state('worker_pin');game.book.bookId=indexed.bookId;
 const b=plan(game)[0]!;b.status='offered' as any;b.locationTerms=['old departure place'];
 (b as typeof b & {reentryStartBeatIndex:number}).reentryStartBeatIndex=0;
 game.returnPlanning={bridges:[b],generation:1};
 game.scene.choices[0]={id:SOURCE_ANCHOR_CHOICE_ID,type:'action',text:'Listen.',bridgeId:b.id,sourceEventId:b.eventId,sourceAnchorRoute:'transition'};
 await saveGame(game);
 const engine=gameEngine(),original=engine.continue;let selection:unknown;let eventIds:string[]=[];
 engine.continue=async(_game,_action,_candidates,options)=>{
   assert.deepEqual(_game.sourceEventProgress,{eventId:'future',startBeatIndex:0,completedBeatIndexes:[]});
   selection=options?.sourceBeatSelection;
   eventIds=_candidates[0]?.storyEvents?.map(event=>event.eventId) ?? [];
   throw new Error('Captured canonical request');
 };
 try {
   await assert.rejects(makeChoice(game.gameId,{choiceId:SOURCE_ANCHOR_CHOICE_ID}),/Captured canonical request/);
   assert.deepEqual(selection,{kind:'beat',eventId:'future',beatIndex:0,endBeatIndex:0});
   assert.deepEqual(eventIds,['future','warning','next']);
   assert.equal((await getGame(game.gameId))!.sourceEventProgress,undefined);
 }finally{engine.continue=original;}
});

test('anchor selection cancels a claimed return-planning job before canonical generation',async()=>{
 const indexed={...book,bookId:'worker_anchor_cancel',storyEvents:[{eventId:'future',sequence:0,category:'discovery',description:'Hear the sound',actors:[],targets:[],chapterPosition:0,
   beats:[{actor:'Alex',agency:'intentional' as const,stakes:'significant' as const,action:'Listen.',resultingState:'Alex hears it.',targets:[],sourceReferences:[]}],
   sourceReferences:[{chapterPosition:0,chapterIndex:0,lineStart:1,lineEnd:1}]}]};
 await saveBook(indexed);
 const game=state('worker_anchor_cancel');game.book.bookId=indexed.bookId;
 const b=plan(game)[0]!;b.status='offered' as any;
 game.returnPlanning={bridges:[b],generation:1};
 game.scene.choices[0]={id:SOURCE_ANCHOR_CHOICE_ID,type:'action',text:'Listen.',bridgeId:b.id,sourceEventId:b.eventId,sourceAnchorRoute:'transition'};
 await saveGame(game);
 const saved=(await getGame(game.gameId))!;
 assert.ok(saved.returnPlanning?.job,'one cached bridge should have queued a refill');

 const plannerEntered=deferred(),releasePlanner=deferred();
 const worker=runReturnPlanningJob(game.gameId,async g=>{plannerEntered.resolve();await releasePlanner.promise;return plan(g);},Date.now()+2000);
 await plannerEntered.promise;

 const engine=gameEngine(),original=engine.continue;
 const canonicalEntered=deferred(),releaseCanonical=deferred();
 engine.continue=async()=>{
   const during=(await getGame(game.gameId))!;
   assert.equal(during.returnPlanning?.job,undefined,'anchor selection should invalidate the claimed planner lease before the model call');
   canonicalEntered.resolve();await releaseCanonical.promise;
   throw new Error('Stop canonical generation');
 };
 const choice=makeChoice(game.gameId,{choiceId:SOURCE_ANCHOR_CHOICE_ID});
 try {
   await canonicalEntered.promise;
   releasePlanner.resolve();await worker;
   const during=(await getGame(game.gameId))!;
   assert.equal(during.returnPlanning?.generation,1,'cancelled worker must not publish a new bridge generation');
   assert.equal(during.returnPlanning?.bridges.length,1,'cancelled worker must not add newly generated bridges');
   releaseCanonical.resolve();
   await assert.rejects(choice,/Stop canonical generation/);
 }finally{
   releasePlanner.resolve();releaseCanonical.resolve();
   await worker.catch(()=>{});
   await choice.catch(()=>{});
   engine.continue=original;
 }
});

test('a chosen bridge step plays its reserved canonical prelude and stops at the target player anchor',async()=>{
 const indexed:ImportedBook={...book,bookId:'worker_prelude',chapters:[{index:0,title:'House',text:'Mary opens the cellar path. Alex listens.'}],storyEvents:[
  {eventId:'prelude',sequence:0,category:'discovery',description:'Mary opens the way',actors:['Mary'],targets:[],chapterPosition:0,
   beats:[{actor:'Mary',agency:'intentional' as const,stakes:'significant' as const,action:'Opens the cellar path.',resultingState:'The cellar path is open.',targets:[],sourceReferences:[{chapterPosition:0,chapterIndex:0,lineStart:1,lineEnd:1}]}],
   sourceReferences:[{chapterPosition:0,chapterIndex:0,lineStart:1,lineEnd:1}]},
  {eventId:'target',sequence:1,category:'discovery',description:'Alex listens',actors:['Alex'],targets:[],chapterPosition:0,
   beats:[{actor:'Alex',agency:'intentional' as const,stakes:'significant' as const,action:'Listens.',resultingState:'Alex hears the sound.',targets:[],sourceReferences:[{chapterPosition:0,chapterIndex:0,lineStart:1,lineEnd:1}]}],
   sourceReferences:[{chapterPosition:0,chapterIndex:0,lineStart:1,lineEnd:1}]}
 ]};
 await saveBook(indexed);
 const game=state('worker_prelude_step');game.book.bookId=indexed.bookId;
 const b=plan(game)[0]!;b.eventId='target';b.targetBeatIndex=0;b.target={action:'Listen.',resultingState:'Alex hears the sound.',requiredSituation:'The automatic warning has finished.'};
 b.sourceBeatSelection={kind:'beat',eventId:'target',beatIndex:0,endBeatIndex:0};
 b.canonicalPrelude={eventId:'prelude',startBeatIndex:0,targetEventId:'target',targetBeatIndex:0,
   beats:[{eventId:'prelude',beatIndex:0,actor:'Mary',action:'Opens the cellar path.'}]};
 game.returnPlanning={bridges:[b],generation:1};
 game.scene.choices[0]={id:'toward',type:'action',text:'Move toward the safer part of the house.',bridgeStepId:b.id};
 await saveGame(game);
 const engine=gameEngine(),original=engine.continueFromSource;
 engine.continueFromSource=async(current,candidates)=>{
   assert.equal(candidates[0]?.requiredEventId,'prelude');
   assert.deepEqual(current.sourceEventProgress,{eventId:'prelude',startBeatIndex:0,completedBeatIndexes:[]});
   return {scene:{title:'The Cellar Path',text:'Mary opens the cellar path as the storm presses closer.',development:'',outcome:'active',outcomeReason:'',
     sceneScope:{currentLocation:'forest',peoplePresent:['Alex','Mary'],peopleWithinSpeakingDistance:['Alex','Mary']},peopleKilledInScene:[],
     storyMemory:{summary:'Mary has opened the cellar path.',openThreads:[],canonFacts:['The cellar path is open.']},
     choices:[{id:SOURCE_ANCHOR_CHOICE_ID,type:'action',text:'Listen.',sourceEventId:'target',sourceAnchorRoute:'event'}],
     sourceEventProgress:{eventId:'prelude',completedBeatIndexes:[0]}},chapterPosition:0,nextTextOffset:1,eventId:'prelude'} as any;
 };
 try{
   await makeChoice(game.gameId,{choiceId:'toward'});
   const next=(await getGame(game.gameId))!;
   assert.equal(next.narrativeMode,'canonical');
   assert.equal(next.returnPlanning?.activeBridgeId,undefined);
   assert.equal(next.returnPlanning?.bridges.find(x=>x.id===b.id)?.status,'used');
   assert.match(next.scene.text,/Mary opens the cellar path/);
   assert.equal(next.scene.choices[0]?.id,SOURCE_ANCHOR_CHOICE_ID);
 }finally{engine.continueFromSource=original;}
});

test('selecting an intermediate bridge activates free progress without any source discovery',async()=>{
 const game=state('worker_step'),b=plan(game)[0]!;
 game.returnPlanning={bridges:[b],generation:1};
 game.scene.choices[0]={id:'upstairs',type:'action',text:'Walk upstairs.',bridgeStepId:b.id};
 await saveGame(game);const restore=forbidSourceCalls();
 try {
   await makeChoice(game.gameId,{choiceId:'upstairs'});
   const next=(await getGame(game.gameId))!;
   assert.equal(next.narrativeMode,'free');assert.equal(next.returnPlanning!.activeBridgeId,b.id);
   assert.equal(next.returnPlanning!.bridges[0]!.steps?.[0]?.action,'Walk upstairs.');
   assert.deepEqual(next.sourceCursor,game.sourceCursor);assert.deepEqual(next.sourceEventProgress,game.sourceEventProgress);
   const alternative=next.scene.choices.find(c=>!c.bridgeId&&!c.bridgeStepId)!;
   await makeChoice(game.gameId,{choiceId:alternative.id});
   assert.equal((await getGame(game.gameId))!.returnPlanning!.activeBridgeId,undefined);
 }finally{restore();}
});
