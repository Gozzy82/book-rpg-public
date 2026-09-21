import assert from 'node:assert/strict';
import test from 'node:test';
import type {GameState, ImportedBook} from '../src/shared/contracts.js';
import {SOURCE_ANCHOR_CHOICE_ID} from '../src/shared/contracts.js';
import type {AiClient, AiResponseRequest} from '../src/ai/provider.js';
import {bridgeSituation, bridgeStock, digest, exportStoryTrace, matchesBridge, rulesVersion, storyCode, takeMatchingBridge, updateReturnPlanning, type ReturnBridge} from '../src/games/return-bridges.js';
import {freeWorldContext, generateFreeWorldScene, parseFreeScene, stripTrailingChoiceEcho, startFreeWorldTalk, isConversationUtterance} from '../src/ai/free-world.js';
import {planReturnBridges} from '../src/games/bridge-planner.js';
import {prepareGameplaySave} from '../src/games/repository.js';

function state(): GameState {
  return {gameId: 'game_test', book: {bookId: 'oz', title: 'Oz'}, playerName: 'Dorothy', gameProfile: {category: 'adventure', endingMode: 'completion', description: ''},
    objective: 'FUTURE_SOURCE_OBJECTIVE', victoryCondition: 'SOURCE_VICTORY', status: 'active', selectedText: 'SOURCE_EXCERPT',
    confirmedDeadCharacters: [], sourceCursor: {chapterPosition: 0, textOffset: 0},
    narrativeMode: 'free', gameRevision: 1, history: [{kind: 'scene', text: 'I reached the forest edge.'}],
    storyMemory: {summary: 'I left the road.', openThreads: ['Find a place to rest.'], canonFacts: []},
    scene: {title: 'Forest', text: 'I stand at the forest edge.', choices: [], sceneScope: {currentLocation: 'The forest edge', peoplePresent: ['Dorothy'], peopleWithinSpeakingDistance: ['Dorothy']}},
    createdAt: '2026-09-17', updatedAt: '2026-09-17'};
}
function bridge(game = state(), id = 'b1'): ReturnBridge {
  return {id, departureLocation:game.scene.sceneScope!.currentLocation, selectionReason:'Nearest useful target.', eventId: 'tin', targetBeatIndex: 0, target: {action:'Investigate the groaning.', resultingState:'At the trees.', requiredSituation:'At the forest edge, hearing a groan.'},
    leadIn: 'The forest goes still. A faint metallic groan comes from the trees, pauses, and comes again from the same direction.',
    setup: 'Groaning comes from the trees.', choiceText: 'Investigate the groaning.',
    locationTerms: ['forest'], presentCharacters: [], availableCharacters: ['Tin Woodman'],
    originCursor: digest(game.sourceCursor), indexVersion: '', rulesVersion: rulesVersion(game), createdAt: Date.now(), expiresAt: Date.now()+60_000, status: 'ready'};
}
function scene() {
  return {title: 'A sound', text: 'I hear a faint groan from the trees.', development: 'A sound offers a new opportunity.', outcome: 'active', outcomeReason: '',
    sceneScope: state().scene.sceneScope, peopleKilledInScene: [], storyMemory: state().storyMemory,
    choices: [{type: 'action', text: 'Rest beneath a tree.', character: null, followsBridge: false},
      {type: 'action', text: 'Investigate the groaning.', character: null, followsBridge: true}]};
}
function client(outputs: unknown[], calls: AiResponseRequest[] = []): AiClient {
  return {provider: 'xai', model: 'test', async createResponse(request) {
    calls.push(request); assert.ok(outputs.length, 'Unexpected extra AI call');
    // Legacy planner cases explicitly keep the nearest candidate; selection-specific cases supply their own response.
    if (request.text?.format.name === 'bookrpg_return_bridge_target' && (outputs[0] as any)?.bridges) {
      const target=JSON.parse(request.input).targets[0];
      return {status:'completed',output_text:JSON.stringify({eventId:target.eventId,beatIndex:target.beatIndex,reason:'Nearest target fits.'})};
    }
    return {status: 'completed', output_text: JSON.stringify(outputs.shift())};
  }};
}

test('bridge matching runs only for dependency changes or newly published plans, not every turn', () => {
  const game = state(); game.returnPlanning = {bridges: [bridge(game)], generation: 1};
  assert.equal(takeMatchingBridge(game)?.id, 'b1');
  assert.equal(takeMatchingBridge(game), undefined);
  game.history.push({kind: 'dialogue', text: 'We continue talking.'}); game.turnNumber = 4;
  assert.equal(takeMatchingBridge(game), undefined);
  game.scene.sceneScope!.peoplePresent.push('Toto');
  assert.equal(takeMatchingBridge(game)?.id, 'b1');
  game.returnPlanning.generation++;
  assert.equal(takeMatchingBridge(game)?.id, 'b1');
  game.scene.sceneScope!.currentLocation = 'A village';
  assert.equal(takeMatchingBridge(game), undefined);
});
test('dead actors, rule changes and canonical progress invalidate a stored bridge', () => {
  const game = state(); const b = bridge(game);
  assert.ok(matchesBridge(b, game));
  game.confirmedDeadCharacters = ['Tin Woodman']; assert.equal(matchesBridge(b, game), false);
  game.confirmedDeadCharacters = []; game.worldRules = ['No sounds']; assert.equal(matchesBridge(b, game), false);
  game.worldRules = []; game.sourceCursor!.eventId = 'other'; assert.equal(matchesBridge(b, game), false);
});
test('three/two dormant bridges do not refill; one queues one job, preserving a live lease', () => {
  const game = state(); game.scene.sceneScope!.currentLocation = 'Village';
  game.returnPlanning = {bridges: [bridge(game,'a'),bridge(game,'b'),bridge(game,'c')], generation: 1};
  updateReturnPlanning(game); assert.equal(game.returnPlanning.job, undefined);
  game.returnPlanning.bridges.pop(); updateReturnPlanning(game); assert.equal(game.returnPlanning.job, undefined);
  game.returnPlanning.bridges.pop(); updateReturnPlanning(game); assert.ok(game.returnPlanning.job);
  game.returnPlanning.job.token = 'worker'; game.returnPlanning.job.leaseUntil = Date.now()+5000;
  game.gameRevision = 2; updateReturnPlanning(game);
  assert.equal(game.returnPlanning.job.token, 'worker'); assert.equal(game.returnPlanning.job.revision, 2);
});
test('unchanged negative search is not retried every turn after the cooldown', () => {
  const game = state(); game.returnPlanning = {bridges: [], generation: 1, retryAfter: 1, lastAttemptSituation: bridgeSituation(game), lastAttemptStock: bridgeStock(game)};
  updateReturnPlanning(game); assert.equal(game.returnPlanning.job, undefined);
  game.scene.sceneScope!.currentLocation = 'Village'; updateReturnPlanning(game); assert.ok(game.returnPlanning.job);
});
test('free scene inputs contain history, open threads and character data but no source route', () => {
  const game = state(); game.characterProfiles = [{name: 'Dorothy', aliases: [], role: 'player', description: 'A girl', traits: [], relationships: [],
    storyArc: 'SECRET_ENDING', actions: [], significantEvents: [{eventId: 'SECRET_EVENT', sequence: 9, category: 'arrival', description: 'SECRET_TARGET', actors: [], targets: [], chapterPosition: 2, sourceReferences: []}]}];
  const payload = JSON.stringify(freeWorldContext(game));
  for (const secret of ['FUTURE_SOURCE_OBJECTIVE', 'SOURCE_EXCERPT', 'SOURCE_VICTORY', 'SECRET_ENDING', 'SECRET_TARGET', 'SECRET_EVENT']) assert.equal(payload.includes(secret), false, secret);
  assert.match(payload, /Find a place to rest/); assert.match(payload, /forest edge/); assert.match(payload, /Dorothy/);
});
test('one free writer plus one review: prepared opportunity becomes option 1 without discovery', async () => {
  const game = state(); const calls: AiResponseRequest[] = [];
  const output = await generateFreeWorldScene(game, 'Look around.', 'action', bridge(game), client([scene(), {accepted:true,reason:'Scene is coherent'}, {accepted: true, reason: 'Grounded', bridgeEvidence: 'I hear a faint groan from the trees.', bridgeReadiness: {ready:true, actionMatches:true, reason:'The groan is audible here and the choice investigates it.', evidence:['I hear a faint groan from the trees.']}}], calls));
  assert.deepEqual(calls.map(c => c.text!.format.name), ['bookrpg_free_scene', 'bookrpg_free_scene_review', 'bookrpg_free_bridge_review']);
  assert.equal(output.choices[0]?.id, SOURCE_ANCHOR_CHOICE_ID);
  assert.equal(output.choices[0]?.bridgeId, 'b1'); assert.equal(output.choices[0]?.sourceEventId, 'tin');
  assert.deepEqual(output.choices[0]?.sourceBeatSelection,{kind:'beat',eventId:'tin',beatIndex:0,endBeatIndex:0});
  assert.equal(output.sourceProgress, undefined); assert.equal(output.sourceEventProgress, undefined);
  assert.equal(calls[0]!.input.includes('"eventId":"tin"'), false);
  assert.match(calls[0]!.input, /faint metallic groan/);
  assert.equal(JSON.parse(calls[0]!.input).preparedOpportunity.leadIn, bridge(game).leadIn);
  assert.equal(output.text.includes('b1'), false);
});
test('free-world generation retries serialized scene-object leakage instead of showing it', async () => {
  const leaked = scene();
  leaked.text = "I keep Toto close.','development':'Wrong metadata tail.','outcome':'active','sceneScope':{'currentLocation':'farmhouse'}";
  leaked.choices[1]!.followsBridge = false;
  const clean = scene(); clean.choices[1]!.followsBridge = false;
  const calls: AiResponseRequest[] = [];
  const result = await generateFreeWorldScene(state(), 'Stay with Toto.', 'action', undefined,
    client([leaked, clean, {accepted:true,reason:'Clean scene.'}], calls));
  assert.equal(result.text, clean.text);
  assert.deepEqual(calls.map(c => c.text!.format.name),
    ['bookrpg_free_scene','bookrpg_free_scene','bookrpg_free_scene_review']);
});

test('addressed custom speech requires a concrete NPC response before review accepts the scene', async () => {
  const game = state();
  game.characterProfiles = [
    {name:'Dorothy',aliases:[],role:'Player',description:'',traits:[],relationships:[],storyArc:''} as any,
    {name:'Aunt Em',aliases:[],role:'Guardian',description:'',traits:[],relationships:[],storyArc:''} as any,
  ];
  game.scene.sceneScope = {
    currentLocation:'Farmhouse doorway',
    peoplePresent:['Dorothy','Aunt Em'],
    peopleWithinSpeakingDistance:['Dorothy','Aunt Em'],
  };
  const vague = scene();
  vague.sceneScope = structuredClone(game.scene.sceneScope);
  vague.text = 'I tell Aunt Em I am worried about the storm. Aunt Em pauses and her voice sounds steady, but the wind keeps rising.';
  vague.choices[1]!.followsBridge = false;
  const concrete = structuredClone(vague);
  concrete.text = 'I tell Aunt Em I am worried about the storm. Aunt Em turns to me and says, "Then stay close to me and keep Toto with you. We will go inside together if the wind worsens."';

  const calls:AiResponseRequest[] = [];
  const result = await generateFreeWorldScene(
    game,
    'Tell Aunt Em I am worried about the storm.',
    'action',
    undefined,
    client([
      vague,
      {accepted:false,reason:'Aunt Em is addressed but gives no concrete response to what Dorothy said.'},
      concrete,
      {accepted:true,reason:'Aunt Em directly acknowledges Dorothy\'s concern and gives a concrete response.'},
    ], calls),
  );

  assert.equal(result.text, concrete.text);
  assert.deepEqual(
    calls.map(call => call.text?.format.name),
    ['bookrpg_free_scene','bookrpg_free_scene_review','bookrpg_free_scene','bookrpg_free_scene_review'],
  );
  assert.match(calls[1]!.instructions!, /concrete immediate response/i);
  assert.match(calls[2]!.input, /gives no concrete response/i);
});

test('free-world talk exposes only literal spoken replies and retries an action menu', async () => {
  const game=state();
  game.scene.sceneScope!.peoplePresent.push('Uncle Henry');
  game.scene.sceneScope!.peopleWithinSpeakingDistance.push('Uncle Henry');
  const calls:AiResponseRequest[]=[];
  const invalid={suggestions:[
    'Talk to Uncle Henry about getting everyone into the cellar.',
    'Step back into the house to call Aunt Em.',
    'Ask Uncle Henry to secure Toto and check the animals.',
  ]};
  const valid={suggestions:[
    'Should we get everyone into the cellar?',
    'I’m frightened. How close is the storm?',
    'Can you help Aunt Em while I hold Toto?',
  ]};
  const talk=await startFreeWorldTalk(game,'Uncle Henry',client([invalid,valid],calls));
  assert.equal(talk.prompt,'Dorothy, what do you say to Uncle Henry?');
  assert.deepEqual(talk.suggestions,valid.suggestions);
  assert.equal(calls.length,2);
  assert.deepEqual(Object.keys((calls[0]!.text!.format.schema as any).properties),['suggestions']);
  assert.match(calls[1]!.input,/repairFeedback/);
  for(const suggestion of talk.suggestions) assert.equal(isConversationUtterance(suggestion,'Uncle Henry'),true);
  assert.equal(isConversationUtterance('Take Toto and edge closer to the door.','Uncle Henry'),false);
  assert.equal(isConversationUtterance('Ask Uncle Henry to secure Toto.','Uncle Henry'),false);
});

test('legacy bridge plans without leadIn fall back to setup as story material', async () => {
  const legacy = bridge(); delete legacy.leadIn;
  const raw = scene(); raw.choices[1]!.followsBridge = false;
  const calls: AiResponseRequest[] = [];
  await generateFreeWorldScene(state(), 'Rest.', 'action', legacy,
    client([raw, {accepted:true, reason:'Scene is coherent'}, {accepted:false,reason:'No optional link.',targetStatus:'pending',targetEvidence:[],bridgeReadiness:null,bridgeEvidence:null,bridgeStepEvidence:null}], calls));
  const prepared = JSON.parse(calls[0]!.input).preparedOpportunity;
  assert.equal(prepared.leadIn, legacy.setup);
  assert.equal(prepared.setup, legacy.setup);
});
test('free scenes can ignore a bridge and reviewers receive no event completion requirement', async () => {
  const draft = scene(); draft.choices[1]!.followsBridge = false;
  const calls: AiResponseRequest[] = [];
  const output = await generateFreeWorldScene(state(), 'Rest.', 'action', bridge(), client([draft, {accepted: true, reason: 'Valid divergence', bridgeEvidence: null}], calls));
  assert.ok(output.choices.every(c => !c.bridgeId && c.id !== SOURCE_ANCHOR_CHOICE_ID));
  assert.match(calls[1]!.instructions!, /no canonical event or source beat is required/);
});
test('trigger location is only an entry filter; target readiness is reviewed at the destination', () => {
  const draft = scene(); draft.sceneScope = {...draft.sceneScope!, currentLocation: 'A distant village'};
  assert.equal(parseFreeScene(draft, state(), bridge()).choices[0]?.bridgeId, 'b1');
});
test('review rejection prevents accepting unchosen actions, then repairs within a bounded budget', async () => {
  const draft = scene(); draft.choices[1]!.followsBridge = false;
  const calls: AiResponseRequest[] = [];
  await generateFreeWorldScene(state(), 'Listen.', 'action', undefined,
    client([draft, {accepted: false, reason: 'Unchosen investigation'}, draft, {accepted: true, reason: 'Only listening', bridgeEvidence: null}], calls));
  assert.match(calls[2]!.input, /Unchosen investigation/); assert.equal(calls.length, 4);
});
test('background planning receives the full summary and exact evidence for one target', async () => {
  const game = state(); const book: ImportedBook = {bookId: 'oz', title: 'Oz', sourceSha256: 'x', importedAt: '',
    worldBible: {summary: 'COMPLETE_SUMMARY', characters: [], locations: [], characterProfiles: []},
    chapters: [{index: 0, title: 'Forest', text: 'SOURCE_EVIDENCE'}], storyEvents: [{eventId: 'tin', sequence: 1, description: 'Discover the Tin Woodman', category: 'discovery', chapterPosition: 0, actors: [], targets: [],
      beats:[{actor:'Dorothy',action:'Investigate.',agency:'intentional',stakes:'significant',targets:[],sourceReferences:[],resultingState:'Near the trees.'}],
      sourceReferences: [{chapterPosition: 0, chapterIndex: 0, lineStart: 1, lineEnd: 1}]}]};
  const calls: AiResponseRequest[] = [];
  const result = await planReturnBridges(game, book, client([{incompatibleReason: null, bridges: [{eventId: 'tin',
    leadIn: 'The trail narrows beside the trees until a faint metallic groan repeats ahead, creating a natural opening to investigate without performing that action.',
    setup: 'A groan from the trees.', choiceText: 'Investigate.', requiredSituation:'Near the trees.', locationTerms: ['forest'], presentCharacters: [], availableCharacters: []}]}], calls));
  assert.match(calls[0]!.input, /COMPLETE_SUMMARY/); assert.match(calls[0]!.input, /SOURCE_EVIDENCE/); assert.equal(calls.length, 1);
  assert.equal(result[0]?.eventId, 'tin'); assert.match(result[0]!.id, /^#brpg_bridge_/);
  assert.match(result[0]!.leadIn ?? '', /natural opening/);
});
test('foreground saves keep newly published plans and reject stale gameplay writes', () => {
  const before = state(); before.returnPlanning = {bridges: [], generation: 0};
  const worker = structuredClone(before); worker.returnPlanning = {bridges: [bridge(worker)], generation: 1};
  const saved = prepareGameplaySave(worker, before, false);
  assert.equal(saved.returnPlanning?.bridges[0]?.id, 'b1'); assert.equal(saved.gameRevision, 2);
  assert.throws(() => prepareGameplaySave(saved, before, false), /game changed/);
});
test('trace IDs survive export without adding markers to narrative and label canonical lookup as reference', () => {
  const game = state(); const code = storyCode('scene', 'unique');
  game.turnHistory = [{storyCode: code, bridgeId: 'b1', sourceEventId: 'tin', turnNumber: 1, kind: 'choice', action: 'Look.', completedAt: '', scene: {title: 'Forest', text: 'I listen.'}}];
  const trace = exportStoryTrace(game, {bookId: 'oz', title: 'Oz', sourceSha256: '', chapters: [], importedAt: ''});
  assert.ok(trace.includes(code)); assert.match(trace, /BRIDGE b1/); assert.match(trace, /NOT automatically completed/);
  assert.equal(game.turnHistory[0]!.scene.text, 'I listen.');
});

test('consumed or expired stock schedules durable refill during cooldown without a location change', () => {
  for (const expired of [false, true]) {
    const game = state();
    game.returnPlanning = {bridges: [bridge(game,'a'), bridge(game,'b')], generation: 1, retryAfter: Date.now()+60_000};
    game.returnPlanning.lastAttemptSituation = bridgeSituation(game);
    game.returnPlanning.lastAttemptStock = bridgeStock(game);
    if (expired) game.returnPlanning.bridges[0]!.expiresAt = 1;
    else game.returnPlanning.bridges[0]!.status = 'retired';
    updateReturnPlanning(game);
    assert.equal(game.returnPlanning.job?.dueAt, game.returnPlanning.retryAfter);
  }
});

test('an accepted reviewer verdict cannot attach an anchor without evidence from the actual scene', async () => {
  const draft = scene(); const repaired = scene(); repaired.choices[1]!.followsBridge = false;
  const calls: AiResponseRequest[] = [];
  const result = await generateFreeWorldScene(state(), 'Listen.', 'action', bridge(),
    client([draft, {accepted:true,reason:'Scene is coherent'}, {accepted: true, reason: 'Location matches', bridgeEvidence: 'Investigate the groaning.', bridgeReadiness:{ready:true,actionMatches:true,reason:'Test',evidence:['I hear a faint groan from the trees.']}},
      repaired, {accepted: true, reason: 'Free choice only', bridgeEvidence: null}], calls));
  assert.equal(result.choices.some(c => c.bridgeId), false);
  assert.equal(calls.length,3);assert.equal(result.text,draft.text);
  assert.equal(JSON.parse(calls[1]!.input).preparedOpportunity,undefined);
});

test('conversation aliases resolve to the available scope name without inventing presence',()=>{
 const game=state();game.characterProfiles=[{name:'Uncle Henry',aliases:['Henry']} as any];
 const draft=scene();draft.choices[1]!.followsBridge=false;
 draft.sceneScope!.peoplePresent.push('Uncle Henry');draft.sceneScope!.peopleWithinSpeakingDistance.push('Uncle Henry');
 draft.choices[1]={type:'talk',text:'Ask Henry about the storm.',character:'Henry',followsBridge:false} as any;
 assert.equal(parseFreeScene(draft,game).choices[1]!.character,'Uncle Henry');
 draft.sceneScope!.peopleWithinSpeakingDistance=['Dorothy'];
 assert.throws(()=>parseFreeScene(draft,game),/Henry is not within speaking distance/);
});
test('bad conversation is removed when two usable options remain; reviewer sees the actual retained menu',async()=>{
 const game=state();const raw=scene();raw.choices[1]!.followsBridge=false;
 raw.choices.push({type:'talk',text:'Talk to myself.',character:'Dorothy',followsBridge:false} as any);
 const calls:AiResponseRequest[]=[];
 const result=await generateFreeWorldScene(game,'Listen.','action',undefined,client([raw,{accepted:true,reason:'Valid',bridgeEvidence:null}],calls));
 assert.equal(result.choices.length,2);assert.equal(calls.length,2);
 assert.equal(JSON.parse(calls[1]!.input).candidate.choices.length,2);
});
test('conversation failure repairs only the menu and then reviews the unchanged scene',async()=>{
 const game=state();const raw=scene();raw.choices[1]={type:'talk',text:'Talk to myself.',character:'Dorothy',followsBridge:false} as any;
 const fixed=[raw.choices[0],{type:'action',text:'Watch the trees.',character:null,followsBridge:false}];
 const calls:AiResponseRequest[]=[];
 const result=await generateFreeWorldScene(game,'Listen.','action',undefined,client([raw,{choices:fixed},{accepted:true,reason:'Valid',bridgeEvidence:null}],calls));
 assert.deepEqual(calls.map(c=>c.text?.format.name),['bookrpg_free_scene','bookrpg_free_menu_repair','bookrpg_free_scene_review']);
 assert.equal(result.text,raw.text);assert.match(calls[1]!.input,/Dorothy is the player/);
 assert.equal(JSON.parse(calls[2]!.input).candidate.text,raw.text);
});

function nearbyFixture() {
 const game=state();game.sourceCursor!.eventId='previous';game.sourceEventProgress={eventId:'current',completedBeatIndexes:[0]};
 const beat=(actor:string,action:string)=>({actor,action,agency:'intentional' as const,stakes:'significant' as const,targets:[],sourceReferences:[],resultingState:action});
 const event=(eventId:string,sequence:number,beats:any[])=>({eventId,sequence,description:eventId,category:'discovery',chapterPosition:0,actors:[],targets:[],sourceReferences:[],beats});
 const book:ImportedBook={bookId:'oz',title:'Oz',sourceSha256:'',importedAt:'',chapters:[{index:0,title:'Start',text:'Evidence'}],storyEvents:[
  event('previous',0,[]),event('current',1,[beat('Dorothy','Already done'),beat('Uncle Henry','Warn'),beat('Dorothy','Take shelter')]),event('distant',9,[beat('Dorothy','Return home')])]};
 return {game,book};
}
const proposal=(setup='A sound.')=>({eventId:'current',leadIn:'The weather changes enough to make the nearby shelter route worth considering.',setup,choiceText:'Take shelter.',requiredSituation:'The shelter is within reach.',locationTerms:['forest'],presentCharacters:['Dorothy'],availableCharacters:[]});
test('three distinct bridges can target the same pending beat; distant events are excluded',async()=>{
 const {game,book}=nearbyFixture();const calls:AiResponseRequest[]=[];
 const plans=await planReturnBridges(game,book,client([{incompatibleReason:null,bridges:[proposal('Wind rises.'),proposal('A branch cracks.'),proposal('Rain starts.')]}],calls));
 assert.equal(calls.length,1);assert.equal(plans.length,3);
 const detail=JSON.parse(calls[0]!.input);
 assert.deepEqual(detail.events.map((e:any)=>e.eventId),['current']);
 assert.equal(detail.focus.nextIntentionalPlayerBeat.beatIndex,2);
 assert.deepEqual(detail.events[0].completedBeatIndexes,[0]);
 assert.ok(plans.every(b=>b.eventId==='current'&&b.targetBeatIndex===2));
 assert.deepEqual(plans[0]!.canonicalPrelude?.beats,[{eventId:'current',beatIndex:1,actor:'Uncle Henry',action:'Warn'}]);
 assert.equal(plans[0]!.canonicalPrelude?.startBeatIndex,1);
 assert.equal(new Set(plans.map(b=>b.id)).size,3);
 game.returnPlanning={bridges:[plans[0]!],generation:1};
 const refill:AiResponseRequest[]=[];
 const extra=await planReturnBridges(game,book,client([{incompatibleReason:null,bridges:[proposal('A new sound.')]}],refill));
 assert.equal(extra[0]?.eventId,'current');assert.equal(JSON.parse(refill[0]!.input).slots,2);
});
test('earliest pending anchor stays sticky until explicit invalidation, then planning moves to the next beat',async()=>{
 const {invalidateSourceTarget}=await import('../src/games/return-bridges.js');
 const {game,book}=nearbyFixture();const firstCalls:AiResponseRequest[]=[];
 const first=await planReturnBridges(game,book,client([
  {incompatibleReason:null,bridges:[proposal()]}
 ],firstCalls));
 assert.equal(first[0]!.eventId,'current');
 assert.equal(first[0]!.targetBeatIndex,2);
 assert.equal(first[0]!.reentryStartBeatIndex,undefined);
 assert.equal(JSON.parse(firstCalls[0]!.input).focus.nextIntentionalPlayerBeat.beatIndex,2);

 invalidateSourceTarget(game,{kind:'beat',eventId:'current',beatIndex:2,endBeatIndex:2},['Shelter action became irreversibly obsolete.']);
 const nextCalls:AiResponseRequest[]=[];
 const next=await planReturnBridges(game,book,client([
  {incompatibleReason:null,bridges:[{...proposal(),eventId:'distant',choiceText:'Return home.'}]}
 ],nextCalls));
 assert.equal(next[0]!.eventId,'distant');
 assert.equal(next[0]!.targetBeatIndex,0);
 assert.equal(next[0]!.reentryStartBeatIndex,0);
 assert.deepEqual(JSON.parse(nextCalls[0]!.input).events.map((e:any)=>e.eventId),['distant']);
 assert.equal(game.sourceEventProgress!.eventId,'current');
});
test('completed current event advances planning; changing beat progress invalidates old alternatives',async()=>{
 const {game,book}=nearbyFixture();game.sourceCursor!.eventId='current';
 const plans=await planReturnBridges(game,book,client([{incompatibleReason:null,bridges:[proposal()]}]));
 assert.equal(matchesBridge(plans[0]!,game),true);
 game.sourceEventProgress!.completedBeatIndexes.push(2);
 assert.equal(matchesBridge(plans[0]!,game),false);
 game.sourceEventProgress!.completedBeatIndexes=[0,1,2];
 const calls:AiResponseRequest[]=[];
 await planReturnBridges(game,book,client([{incompatibleReason:null,bridges:[]}],calls));
 assert.equal(JSON.parse(calls[0]!.input).focus.preferredEventId,'distant');
});

test('approaching the required house cannot be accepted as the target sky-watching action',async()=>{
 const game=state();const b=bridge(game);
 b.target={action:'Look at the sky holding Toto.',resultingState:'Dorothy stands in the farmhouse doorway holding Toto and watching the sky.',requiredSituation:'Dorothy is at the farmhouse doorway and Toto is within reach.'};
 const raw=scene();raw.text='I stand by the shed and hear Henry calling from the farmhouse.';
 raw.choices[1]!.text='Walk back to the farmhouse.';
 const repaired=structuredClone(raw);repaired.choices[1]!.followsBridge=false;
 const calls:AiResponseRequest[]=[];
 const output=await generateFreeWorldScene(game,'Listen.','action',b,client([
 raw,{accepted:true,reason:'Scene is coherent'},{accepted:true,reason:'Valid prose',bridgeEvidence:raw.text,bridgeReadiness:{ready:false,actionMatches:false,reason:'Dorothy is still at the shed; walking is a prerequisite, not looking at the sky.',evidence:[raw.text]}},
 repaired,{accepted:true,reason:'Free intermediate action',bridgeEvidence:null,bridgeReadiness:null}],calls));
 assert.equal(output.choices.some(c=>c.bridgeId),false);
 assert.equal(output.choices.some(c=>c.text==='Walk back to the farmhouse.'),true);
 assert.equal(calls.length,3);assert.equal(output.text,raw.text);
 assert.deepEqual(JSON.parse(calls[0]!.input).preparedOpportunity.target,b.target);
});
test('ready location alone cannot authorize an unrelated anchor action',async()=>{
 const raw=scene();const fixed=structuredClone(raw);fixed.choices[1]!.followsBridge=false;
 const output=await generateFreeWorldScene(state(),'Listen.','action',bridge(),client([
 raw,{accepted:true,reason:'Scene is coherent'},{accepted:true,reason:'Same location',bridgeEvidence:raw.text,bridgeReadiness:{ready:true,actionMatches:false,reason:'Choice does not execute the target.',evidence:[raw.text]}},
 fixed,{accepted:true,reason:'Free',bridgeEvidence:null,bridgeReadiness:null}]));
 assert.equal(output.choices.some(c=>c.bridgeId),false);
});
test('legacy plans without target conditions are retired and replenished',()=>{
 const game=state(),b=bridge(game);delete b.target;
 game.returnPlanning={bridges:[b],generation:1};
 updateReturnPlanning(game);
 assert.equal(b.status,'retired');assert.ok(game.returnPlanning.job);
});

test('a free intermediate step can reconsider a bridge without a location change or a source call',()=>{
 const game=state();game.returnPlanning={bridges:[bridge(game)],generation:1};
 assert.ok(takeMatchingBridge(game));assert.equal(takeMatchingBridge(game),undefined);
 game.scene.text='I pick up Toto while remaining by the trees.';
 assert.ok(takeMatchingBridge(game));
});

test('an indexed action group keeps its full server-owned selection and preconditions',async()=>{
 const {game,book}=nearbyFixture();game.playerActionVersion=2;
 const beat=book.storyEvents![1]!.beats![2]!;
 beat.playerAction={id:'shelter',kind:'player_action',endBeatIndex:2,playerBeatIndexes:[2],boundaryReason:'Wait for shelter',choiceText:'Take shelter.',completion:'Dorothy reaches shelter.',preconditions:['The shelter is open.'],interruptWhen:[]};
 const plans=await planReturnBridges(game,book,client([{incompatibleReason:null,bridges:[proposal()]}]));
 assert.deepEqual(plans[0]!.sourceBeatSelection,{eventId:'current',beatIndex:2,endBeatIndex:2,kind:'player_action',actionId:'shelter',playerBeatIndexes:[2]});
 assert.match(plans[0]!.target!.requiredSituation,/The shelter is open/);
});

test('reserved canonical prelude needs a reviewed handoff before free play can return to canon',async()=>{
 const game=state(),b=bridge(game),raw=scene();
 b.canonicalPrelude={eventId:'warning',startBeatIndex:0,targetEventId:b.eventId,targetBeatIndex:0,
   beats:[{eventId:'warning',beatIndex:0,actor:'Uncle Henry',action:'Warns that the storm is close.'}]};
 game.returnPlanning={bridges:[b],generation:1,activeBridgeId:b.id};
 raw.text='I move back beside the farmhouse door with Toto close.';
 raw.choices[1]={type:'action',text:'Stay beside the doorway.',character:null,followsBridge:false,advancesBridge:true} as any;
 const ready=await generateFreeWorldScene(game,'Move back beside the farmhouse door.','action',b,client([
   raw,{accepted:true,reason:'Coherent.'},
   {accepted:true,reason:'The handoff is ready.',targetStatus:'pending',targetEvidence:[],bridgeEvidence:null,bridgeReadiness:null,
    bridgeStepEvidence:raw.text,preludeReady:true,preludeEvidence:[`"${raw.text}"`]}
 ]));
 assert.equal(ready.canonicalPreludeReady,true);
 assert.ok(ready.choices.every(c=>!c.bridgeId));
 const pending=await generateFreeWorldScene(game,'Move closer.','action',b,client([
   raw,{accepted:true,reason:'Coherent.'},
   {accepted:true,reason:'Another free step remains.',targetStatus:'pending',targetEvidence:[],bridgeEvidence:null,bridgeReadiness:null,
    bridgeStepEvidence:raw.text,preludeReady:false,preludeEvidence:[]}
 ]));
 assert.equal(pending.canonicalPreludeReady,undefined);
});

test('a reviewed intermediate choice carries only a bridge step, never canonical authorization',async()=>{
 const game=state(),b=bridge(game),raw=scene();
 b.target={action:'Watch the sky holding Toto.',resultingState:'At the farmhouse doorway.',requiredSituation:'Dorothy is at the farmhouse doorway.'};
 raw.text='I hear Henry calling from the farmhouse doorway.';
 raw.choices[1]={type:'action',text:'Walk back to the farmhouse.',character:null,followsBridge:false,advancesBridge:true} as any;
 const output=await generateFreeWorldScene(game,'Listen.','action',b,client([raw,{accepted:true,reason:'Scene is coherent'},{accepted:true,reason:'A voluntary step toward the house',bridgeEvidence:null,bridgeReadiness:null,bridgeStepEvidence:raw.text}]));
 const step=output.choices.find(c=>c.bridgeStepId)!;
 assert.equal(step.bridgeStepId,b.id);assert.notEqual(step.id,SOURCE_ANCHOR_CHOICE_ID);
 assert.equal(step.bridgeId,undefined);assert.equal(step.sourceEventId,undefined);assert.equal(step.sourceBeatSelection,undefined);
});
test('an active bridge survives travel and concurrent publication; an unselected departure plan retires',()=>{
 const original=state(),active=bridge(original,'active'),other=bridge(original,'other');
 original.returnPlanning={bridges:[active,other],generation:1};
 const incoming=structuredClone(original);
 incoming.returnPlanning!.activeBridgeId=active.id;
 incoming.returnPlanning!.bridges[0]!.steps=[{action:'Walk upstairs.',location:'House doorway',scene:'I reach the doorway.'}];
 incoming.scene.sceneScope!.currentLocation='House doorway';incoming.scene.text='I reach the doorway.';
 const published=structuredClone(original);published.returnPlanning!.generation++;
 const saved=prepareGameplaySave(published,incoming,false);
 assert.equal(saved.returnPlanning!.activeBridgeId,active.id);
 assert.equal(saved.returnPlanning!.bridges[0]!.steps?.[0]?.location,'House doorway');
 assert.equal(takeMatchingBridge(saved)?.id,active.id);
 assert.equal(saved.returnPlanning!.bridges[1]!.status,'retired');
 assert.equal(saved.returnPlanning!.job,undefined);
 assert.deepEqual(saved.sourceCursor,original.sourceCursor);
});
test('moving away without following a bridge schedules plans from the new departure location',()=>{
 const game=state();game.returnPlanning={bridges:[bridge(game,'a'),bridge(game,'b')],generation:1};
 game.scene.sceneScope!.currentLocation='Cellar';updateReturnPlanning(game);
 assert.ok(game.returnPlanning.bridges.every(b=>b.status==='retired'));
 assert.ok(game.returnPlanning.job);
});

test('invalidating one player beat permits a later same-event anchor without crediting the skipped beat',async()=>{
 const {applyBridgeEntry,invalidateSourceTarget}=await import('../src/games/return-bridges.js');
 const {game,book}=nearbyFixture();
 const event=book.storyEvents![1]!;
 event.beats!.push({...event.beats![2]!,action:'Return upstairs.'});
 invalidateSourceTarget(game,{kind:'beat',eventId:'current',beatIndex:2,endBeatIndex:2},['Shelter route is permanently unavailable.']);
 const calls:AiResponseRequest[]=[];
 const plans=await planReturnBridges(game,book,client([{incompatibleReason:null,bridges:[{
   ...proposal(),choiceText:'Return upstairs.',requiredSituation:'The upstairs route is reachable.'
 }]}],calls));
 assert.equal(plans[0]!.targetBeatIndex,3);assert.equal(plans[0]!.reentryStartBeatIndex,3);
 assert.deepEqual(game.sourceEventProgress!.completedBeatIndexes,[0]);
 const draft=structuredClone(game);applyBridgeEntry(draft,plans[0]!);
 assert.deepEqual(draft.sourceEventProgress,{eventId:'current',startBeatIndex:3,completedBeatIndexes:[0]});
 assert.deepEqual(game.sourceEventProgress,{eventId:'current',completedBeatIndexes:[0]});
 const {planTurn}=await import('../src/ai/engine/turn-contract.js');
 const contract=planTurn({state:draft,mode:'action',selectedIntent:'Return upstairs.',sourceProgression:'required',event,sourceBeatSelection:plans[0]!.sourceBeatSelection});
 assert.deepEqual(contract.allowedPlayerBeatIndexes,[3]);
 assert.deepEqual(contract.requiredAutomaticBeatIndexes,[]);
 assert.deepEqual(contract.completedBeatIndexes,[0]);
});

test('many later actions cannot displace the earliest pending player anchor',async()=>{
 const {game,book}=nearbyFixture();const event=book.storyEvents![1]!;
 for(let i=0;i<5;i++) event.beats!.push({...event.beats![2]!,action:`Later action ${i}`});
 for(let i=0;i<3;i++) book.storyEvents!.push({...book.storyEvents![2]!,eventId:`later_${i}`,sequence:10+i});
 const calls:AiResponseRequest[]=[];
 const plans=await planReturnBridges(game,book,client([{incompatibleReason:null,bridges:[proposal()]}],calls));
 const detail=JSON.parse(calls[0]!.input);
 assert.equal(detail.focus.preferredEventId,'current');
 assert.equal(detail.focus.nextIntentionalPlayerBeat.beatIndex,2);
 assert.deepEqual(detail.events.map((e:any)=>e.eventId),['current']);
 assert.equal(plans[0]!.targetBeatIndex,2);
});

test('old nearest-only plans retire so an existing save can choose a later useful beat',()=>{
 const game=state(),b=bridge(game);delete b.selectionReason;
 game.returnPlanning={bridges:[b],generation:1};updateReturnPlanning(game);
 assert.equal(b.status,'retired');assert.ok(game.returnPlanning.job);
});

test('a custom pig ride ignores a prepared route; missing bridge evidence never retries the scene',async()=>{
 const game=state(),b=bridge(game),raw=scene();
 raw.text='I sit on the pig as it trots around the yard, snorting in protest.';
 raw.choices[1]={type:'action',text:'Climb off the pig.',character:null,followsBridge:false,advancesBridge:true} as any;
 const calls:AiResponseRequest[]=[];
 const output=await generateFreeWorldScene(game,'Walk outside and sit on a pig.','action',b,client([
 raw,{accepted:true,reason:'The free action is coherent.'},
 {accepted:false,reason:'No grounded return step is available from the pig ride.',targetStatus:'pending',targetEvidence:[],
  bridgeEvidence:null,bridgeReadiness:null,bridgeStepEvidence:null,
  bridgeStepChoiceIndex:null,bridgeStepText:null,preludeReady:null,preludeEvidence:[]}],calls));
 assert.equal(output.text,raw.text);assert.ok(output.choices.every(c=>!c.bridgeId&&!c.bridgeStepId));
 assert.deepEqual(calls.map(c=>c.text!.format.name),['bookrpg_free_scene','bookrpg_free_scene_review','bookrpg_free_bridge_review']);
 const general=JSON.parse(calls[1]!.input);
 assert.equal(general.preparedOpportunity,undefined);
 assert.ok(general.candidate.choices.every((c:any)=>!c.followsBridge&&!c.advancesBridge));
 assert.match(calls[1]!.instructions!,/need not match the previous menu/);
});
test('trailing selected or bridge labels are removed from free-world prose',async()=>{
 const raw=scene();raw.text='I gather Toto close and move toward the cellar.\n\nYou continue toward the cellar with Toto and Uncle Henry following.';raw.choices[1]!.followsBridge=false;
 const selected='Continue toward the cellar with Toto and Uncle Henry following';
 const calls:AiResponseRequest[]=[];
 const result=await generateFreeWorldScene(state(),selected,'action',undefined,client([raw,{accepted:true,reason:'Coherent.'}],calls));
 assert.equal(result.text,'I gather Toto close and move toward the cellar.');
 assert.equal(JSON.parse(calls[1]!.input).candidate.text,'I gather Toto close and move toward the cellar.');
 assert.equal(stripTrailingChoiceEcho('Story.\n\nRetrieve Toto and head for the cellar',['Retrieve Toto and head for the cellar']),'Story.');
});

test('a free scene without a matching bridge needs no bridge review',async()=>{
 const raw=scene();raw.choices[1]!.followsBridge=false;const calls:AiResponseRequest[]=[];
 await generateFreeWorldScene(state(),'Wait and do nothing.','action',undefined,client([raw,{accepted:true,reason:'Waiting is allowed.'}],calls));
 assert.equal(calls.length,2);assert.equal(JSON.parse(calls[1]!.input).preparedOpportunity,undefined);
});


test('after explicit invalidation, automatic-only events become the canonical prelude to the next player anchor',async()=>{
 const {invalidateSourceTarget}=await import('../src/games/return-bridges.js');
 const {game,book}=nearbyFixture();const current=book.storyEvents![1]!;
 const automatic={...current.beats![1]!,agency:'involuntary' as const};
 book.storyEvents!.splice(2,0,...Array.from({length:6},(_,i)=>({...current,eventId:`automatic_${i}`,sequence:2+i,beats:[automatic]})));
 game.scene.sceneScope!.currentLocation='Inside the farmhouse';
 invalidateSourceTarget(game,{kind:'beat',eventId:'current',beatIndex:2,endBeatIndex:2},['Shelter action is permanently unavailable.']);
 const calls:AiResponseRequest[]=[];
 const plans=await planReturnBridges(game,book,client([
  {incompatibleReason:null,bridges:[{...proposal(),eventId:'distant',choiceText:'Return home.'}]}
 ],calls));
 assert.equal(plans[0]!.eventId,'distant');
 assert.equal(plans[0]!.reentryStartBeatIndex,undefined);
 assert.equal(plans[0]!.canonicalPrelude?.eventId,'automatic_0');
 assert.equal(plans[0]!.canonicalPrelude?.startBeatIndex,0);
 assert.equal(plans[0]!.canonicalPrelude?.targetEventId,'distant');
 assert.equal(plans[0]!.canonicalPrelude?.beats.length,6);
 assert.deepEqual(game.sourceEventProgress,{eventId:'current',completedBeatIndexes:[0]});
 assert.deepEqual(JSON.parse(calls[0]!.input).events.map((e:any)=>e.eventId),['distant']);
});


test('ready cached target is offered even when the scene writer omitted every bridge flag',async()=>{
 const game=state(),b=bridge(game),raw=scene();
 raw.choices[1].text='Wait and listen.';raw.choices[1].followsBridge=false;
 const calls:AiResponseRequest[]=[];
 const result=await generateFreeWorldScene(game,'Listen.','action',b,client([
 raw,{accepted:true,reason:'Coherent.'},
 {accepted:true,reason:'The exact action is available.',targetStatus:'ready',targetEvidence:[`"${raw.text}"`],
 bridgeReadiness:{ready:true,actionMatches:true,reason:'Investigating the audible groan is available.',evidence:[`"${raw.text}"`]},
 bridgeEvidence:null,bridgeStepEvidence:null,bridgeStepChoiceIndex:null,bridgeStepText:null,preludeReady:null,preludeEvidence:[]}
 ],calls));
 assert.equal(result.choices[0]!.bridgeId,b.id);
 assert.equal(result.choices[0]!.text,b.choiceText);
 assert.equal(result.choices.length,3);
 assert.equal(result.text,raw.text);
 assert.equal(JSON.parse(calls[1]!.input).preparedOpportunity,undefined);
 const bridgeReview=calls.find(c=>c.text?.format.name==='bookrpg_free_bridge_review')!;
 assert.match(bridgeReview.instructions!,/bridgeEvidence is supplemental compatibility evidence/i);
 assert.match(bridgeReview.instructions!,/MAY be null/i);
});

test('ready bridge accepts the grounded subset when reviewer includes one invented extra quote',async()=>{
 const game=state(),b=bridge(game),raw=scene();
 raw.choices[1].text='Wait and listen.';raw.choices[1].followsBridge=false;
 const result=await generateFreeWorldScene(game,'Listen.','action',b,client([
  raw,{accepted:true,reason:'Coherent.'},
  {accepted:true,reason:'Ready.',targetStatus:'ready',targetEvidence:[raw.text,'Invented extra evidence'],
   targetAlreadyPerformed:false,targetPerformedEvidence:[],
   bridgeReadiness:{ready:true,actionMatches:true,reason:'The groan can be investigated.',evidence:[raw.text,'Another invented quote']},
   bridgeEvidence:null,bridgeStepEvidence:null,bridgeStepChoiceIndex:null,bridgeStepText:null,preludeReady:null,preludeEvidence:[]}
 ]));
 assert.equal(result.choices[0]!.bridgeId,b.id);
 assert.equal(result.choices[0]!.text,b.choiceText);
});

test('the just-consumed free action is removed from the next menu before saving',async()=>{
 const raw=scene();
 const selected='Call Toto to come closer and stand with me at the gate.';
 raw.choices=[
  {type:'action',text:'Call Toto to come closer and stand with me at the gate',character:null,followsBridge:false,advancesBridge:false},
  {type:'action',text:'Step back inside with Toto to safety.',character:null,followsBridge:false,advancesBridge:false},
  {type:'action',text:'Warn Uncle Henry about the wind.',character:null,followsBridge:false,advancesBridge:false},
 ];
 const result=await generateFreeWorldScene(state(),selected,'action',undefined,client([
  raw,{accepted:true,reason:'Coherent.'}
 ]));
 assert.equal(result.choices.length,2);
 assert.ok(result.choices.every(choice=>!/call toto to come closer/i.test(choice.text)));
});

test('a free scene that performs the reserved bridge target is regenerated instead of publishing or dropping it',async()=>{
 const game=state(),b=bridge(game);
 const leaked=scene();
 leaked.text='I hear the groan and step into the trees to investigate it.';
 leaked.choices=[
  {type:'action',text:'Wait here.',character:null,followsBridge:false,advancesBridge:false},
  {type:'action',text:'Walk back to the road.',character:null,followsBridge:false,advancesBridge:false},
 ];
 const safe=scene();
 safe.text='I hear a faint groan from the trees and stop at the edge of the path.';
 safe.choices=[
  {type:'action',text:'Wait here.',character:null,followsBridge:false,advancesBridge:false},
  {type:'action',text:'Look toward the trees.',character:null,followsBridge:false,advancesBridge:false},
 ];
 const calls:AiResponseRequest[]=[];
 const result=await generateFreeWorldScene(game,'Finish my unrelated action.','action',b,client([
  leaked,{accepted:true,reason:'Selected action resolved.'},
  {accepted:true,reason:'Target was already performed.',targetStatus:'ready',targetEvidence:[leaked.text],
   targetAlreadyPerformed:true,targetPerformedEvidence:[leaked.text],
   bridgeReadiness:{ready:true,actionMatches:true,reason:'Too late.',evidence:[leaked.text]},
   bridgeEvidence:null,bridgeStepEvidence:null,bridgeStepChoiceIndex:null,bridgeStepText:null,preludeReady:null,preludeEvidence:[]},
  safe,{accepted:true,reason:'Selected action resolved without taking the target.'},
  {accepted:true,reason:'Target remains available.',targetStatus:'ready',targetEvidence:[safe.text],
   targetAlreadyPerformed:false,targetPerformedEvidence:[],
   bridgeReadiness:{ready:true,actionMatches:true,reason:'The groan is audible and investigation can begin.',evidence:[safe.text]},
   bridgeEvidence:null,bridgeStepEvidence:null,bridgeStepChoiceIndex:null,bridgeStepText:null,preludeReady:null,preludeEvidence:[]}
 ],calls));
 assert.equal(calls.filter(call=>call.text?.format.name==='bookrpg_free_scene').length,2);
 assert.equal(result.text,safe.text);
 assert.equal(result.choices[0]!.bridgeId,b.id);
 const bridgeReviews=calls.filter(call=>call.text?.format.name==='bookrpg_free_bridge_review');
 assert.equal(bridgeReviews.length,2);
 assert.match(bridgeReviews[0]!.instructions!,/targetAlreadyPerformed=true/i);
});

test('a ready bridge stays priority even when the selected free input is unrelated and generic review rejects it',async()=>{
 const game=state(),b=bridge(game),raw=scene();
 raw.choices=[
   {type:'action',text:'Keep talking about an unrelated dream.',character:null,followsBridge:false,advancesBridge:false},
   {type:'action',text:'Wait and listen.',character:null,followsBridge:false,advancesBridge:false},
 ];
 const calls:AiResponseRequest[]=[];
 const result=await generateFreeWorldScene(game,'Tell Uncle Henry about an unrelated impossible invention.','action',b,client([
   raw,{accepted:true,reason:'The selected free action is coherent.'},
   {accepted:false,reason:'The selectedInput is unrelated.',targetStatus:'ready',targetEvidence:[raw.text],
    bridgeReadiness:{ready:true,actionMatches:true,reason:'The groan is audible and can be investigated now.',evidence:[raw.text]},
    bridgeEvidence:raw.text,bridgeStepEvidence:null,preludeReady:null,preludeEvidence:[]}
 ],calls));
 assert.equal(result.choices[0]!.bridgeId,b.id);
 assert.equal(result.choices[0]!.text,b.choiceText);
 const bridgeReview=calls.find(c=>c.text?.format.name==='bookrpg_free_bridge_review')!;
 assert.match(bridgeReview.instructions!,/selectedInput is the player action that has ALREADY been resolved/i);
 assert.match(bridgeReview.instructions!,/preparedOpportunity\.target\.action and proposedAnchor\.text are the ONLY action/i);
 assert.match(bridgeReview.instructions!,/priority as the next optional menu route/i);
});

test('a grounded intermediate bridge step is promoted to option one',async()=>{
 const game=state(),b=bridge(game),raw=scene();
 b.target!.requiredSituation='Inside the trees beside the groaning.';
 raw.text='I hear the groan again and see a narrow path into the trees.';
 raw.choices=[
   {type:'action',text:'Rest here.',character:null,followsBridge:false,advancesBridge:false},
   {type:'action',text:'Follow the narrow path toward the groaning.',character:null,followsBridge:false,advancesBridge:true},
   {type:'action',text:'Walk away.',character:null,followsBridge:false,advancesBridge:false},
 ];
 const result=await generateFreeWorldScene(game,'Finish my unrelated conversation.','action',b,client([
   raw,{accepted:true,reason:'Coherent.'},
   {accepted:true,reason:'The path is a grounded intermediate step.',targetStatus:'pending',targetEvidence:[],
    bridgeReadiness:null,bridgeEvidence:null,bridgeStepEvidence:raw.text,
    bridgeStepChoiceIndex:1,bridgeStepText:null,preludeReady:null,preludeEvidence:[]}
 ]));
 assert.equal(result.choices[0]!.bridgeStepId,b.id);
 assert.equal(result.choices[0]!.text,'Follow the narrow path toward the groaning.');
});

test('bridge reviewer can promote an unflagged existing action to RETURN TO STORY option one',async()=>{
 const game=state(),b=bridge(game),raw=scene();
 b.target!.requiredSituation='Inside the trees beside the groaning.';
 raw.text='A narrow path leads from here into the trees where the groaning continues.';
 raw.choices=[
   {type:'action',text:'Rest here.',character:null,followsBridge:false,advancesBridge:false},
   {type:'action',text:'Follow the narrow path toward the groaning.',character:null,followsBridge:false,advancesBridge:false},
   {type:'action',text:'Walk away.',character:null,followsBridge:false,advancesBridge:false},
 ];
 const result=await generateFreeWorldScene(game,'Finish my unrelated thought.','action',b,client([
   raw,{accepted:true,reason:'Coherent.'},
   {accepted:true,reason:'The path is the closest return step.',targetStatus:'pending',targetEvidence:[],
    bridgeReadiness:null,bridgeEvidence:null,bridgeStepEvidence:raw.text,
    bridgeStepChoiceIndex:1,bridgeStepText:null,preludeReady:null,preludeEvidence:[]}
 ]));
 assert.equal(result.choices[0]!.bridgeStepId,b.id);
 assert.equal(result.choices[0]!.text,'Follow the narrow path toward the groaning.');
});

test('bridge reviewer can synthesize a grounded RETURN TO STORY step when the writer omitted one',async()=>{
 const game=state(),b=bridge(game),raw=scene();
 b.target!.requiredSituation='At the farmhouse doorway with Toto.';
 raw.text='I stand beside the shed with Toto while the farmhouse doorway remains visible across the yard.';
 raw.choices=[
   {type:'action',text:'Check the shed latch.',character:null,followsBridge:false,advancesBridge:false},
   {type:'action',text:'Stay beside the shed.',character:null,followsBridge:false,advancesBridge:false},
 ];
 const result=await generateFreeWorldScene(game,'Look around the shed.','action',b,client([
   raw,{accepted:true,reason:'Coherent.'},
   {accepted:true,reason:'Returning to the doorway is an executable immediate handoff step.',targetStatus:'pending',targetEvidence:[],
    bridgeReadiness:null,bridgeEvidence:null,bridgeStepEvidence:raw.text,
    bridgeStepChoiceIndex:null,bridgeStepText:'Return to the farmhouse doorway with Toto.',
    preludeReady:null,preludeEvidence:[]}
 ]));
 assert.equal(result.choices[0]!.bridgeStepId,b.id);
 assert.equal(result.choices[0]!.text,'Return to the farmhouse doorway with Toto.');
 assert.equal(result.choices.length,3);
});

test('general free-scene review is told not to perform the unchosen prepared bridge target in prose',async()=>{
 const game=state(),b=bridge(game),raw=scene();raw.choices[1]!.followsBridge=false;
 const calls:AiResponseRequest[]=[];
 await generateFreeWorldScene(game,'Talk about something unrelated.','action',b,client([
   raw,{accepted:true,reason:'Coherent.'},
   {accepted:false,reason:'No honest step yet.',targetStatus:'pending',targetEvidence:[],
    bridgeReadiness:null,bridgeEvidence:null,bridgeStepEvidence:null,
    bridgeStepChoiceIndex:null,bridgeStepText:null,preludeReady:null,preludeEvidence:[]}
 ],calls));
 const review=calls.find(c=>c.text?.format.name==='bookrpg_free_scene_review')!;
 assert.match(review.instructions!,/reservedBridgeTargetAction is an UNCHOSEN future player action/);
 assert.equal(JSON.parse(review.input).reservedBridgeTargetAction,b.target!.action);
});

test('achieved target retires every alternative, queues refill and is excluded without crediting beats',async()=>{
 const {retireObsoleteBridge}=await import('../src/games/return-bridges.js');
 const {game,book}=nearbyFixture();const raw=scene();
 raw.text='I am already safely inside the shelter.';raw.choices[1].followsBridge=false;
 const plans=await planReturnBridges(game,book,client([{incompatibleReason:null,bridges:[proposal(),proposal('Another route.')]}]));
 game.returnPlanning={bridges:plans,generation:1,activeBridgeId:plans[0]!.id};
 const result=await generateFreeWorldScene(game,'Stay here.','action',plans[0],client([
 raw,{accepted:true,reason:'Coherent.'},
 {accepted:false,reason:'Shelter already reached.',targetStatus:'obsolete',targetEvidence:[raw.text],bridgeReadiness:null,bridgeEvidence:null,bridgeStepEvidence:null}
 ]));
 assert.deepEqual(result.obsoleteBridgeEvidence,[raw.text]);
 assert.ok(result.choices.every(c=>!c.bridgeId&&!c.bridgeStepId));
 retireObsoleteBridge(game,plans[0]!,result.obsoleteBridgeEvidence!);
 assert.ok(plans.every(b=>b.status==='retired'));
 assert.equal(game.returnPlanning.activeBridgeId,undefined);
 updateReturnPlanning(game);assert.ok(game.returnPlanning.job);
 const calls:AiResponseRequest[]=[];
 const next=await planReturnBridges(game,book,client([{incompatibleReason:null,bridges:[{...proposal(),eventId:'distant'}]}],calls));
 assert.deepEqual(JSON.parse(calls[0]!.input).events.map((e:any)=>e.eventId),['distant']);
 assert.equal(game.returnPlanning.invalidatedTargets?.[0]?.eventId,'current');
 assert.equal(game.returnPlanning.invalidatedTargets?.[0]?.beatIndex,2);
 assert.equal(next[0]!.reentryStartBeatIndex,0);
 assert.deepEqual(game.sourceEventProgress,{eventId:'current',completedBeatIndexes:[0]});
});

test('declining an offered bridge allows it to be offered again on a later scene',async()=>{
 const {retirePreviousBridgeMenu}=await import('../src/games/service/free-world.js');
 const game=state(),b=bridge(game);b.status='offered';
 game.returnPlanning={bridges:[b],generation:1};
 retirePreviousBridgeMenu(game);
 assert.equal(b.status,'ready');
 assert.equal(takeMatchingBridge(game)?.id,b.id);
 b.status='offered';retirePreviousBridgeMenu(game,b.id);
 assert.equal(b.status,'offered');
});

test('ungrounded obsolete evidence cannot retire a bridge or reject the free scene',async()=>{
 const raw=scene();raw.choices[1].followsBridge=false;
 const result=await generateFreeWorldScene(state(),'Wait.','action',bridge(),client([
 raw,{accepted:true,reason:'Coherent.'},
 {accepted:false,reason:'Done.',targetStatus:'obsolete',targetEvidence:['Invented evidence'],bridgeReadiness:null,bridgeEvidence:null,bridgeStepEvidence:null}
 ]));
 assert.equal(result.obsoleteBridgeEvidence,undefined);assert.equal(result.text,raw.text);
});


test('gameplay merge preserves a reusable offer and retires concurrently published obsolete alternatives',()=>{
 const game=state(),b=bridge(game);b.status='offered';
 game.returnPlanning={bridges:[b],generation:1};
 const incoming=structuredClone(game);incoming.returnPlanning!.bridges[0]!.status='ready';
 assert.equal(prepareGameplaySave(game,incoming,false).returnPlanning!.bridges[0]!.status,'ready');
 const current=structuredClone(game);current.returnPlanning!.generation=2;
 current.returnPlanning!.bridges.push({...bridge(game,'new'),status:'ready'});
 incoming.returnPlanning!.bridges[0]!.status='retired';
 incoming.returnPlanning!.bridges[0]!.obsoleteEvidence=['I am free.'];
 const saved=prepareGameplaySave(current,incoming,false);
 assert.ok(saved.returnPlanning!.bridges.every(b=>b.status==='retired'&&b.obsoleteEvidence?.[0]==='I am free.'));
 assert.ok(saved.returnPlanning!.job);
});
