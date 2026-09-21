import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {planTurn} from '../src/ai/engine/turn-contract.js';
import {openingSourceFacts} from '../src/ai/engine/opening-frame.js';
import {generateCanonicalBeatScene} from '../src/ai/engine/canonical-beat-scene.js';
import {sourceReferenceKey} from '../src/books/source-index/chapter-index.js';
import type {GameState, StoryEventBeat} from '../src/shared/contracts.js';
import type {AiResponseRequest} from '../src/ai/provider.js';
import {acceptedCanonicalReview} from './helpers/canonical-review.js';
const ref = {chapterPosition:0,chapterIndex:0,lineStart:1,lineEnd:2};
const futureRef = {...ref,lineStart:20,lineEnd:21};
// Synthetic source for plumbing tests; not a quotation from the uploaded book index.
const source = 'Morgan stood outside. Alex was at the doorway with Pip in their arms. Morgan watched the sky. Alex then looked up.';
const beats: StoryEventBeat[] = [
  {actor:'Morgan',action:'Watches the sky.',resultingState:'Morgan watches from outside.',targets:[],agency:'intentional',stakes:'significant',sourceReferences:[ref]},
  {actor:'Alex',action:'Looks at the sky while holding Pip.',resultingState:'Alex has examined the sky.',targets:['Pip'],agency:'intentional',stakes:'significant',sourceReferences:[ref]},
  {actor:'Pip',action:'Runs into the cellar.',resultingState:'Pip is in the cellar.',targets:[],agency:'intentional',stakes:'significant',sourceReferences:[futureRef]},
];
const state:GameState={gameId:'opening_test',book:{bookId:'book',title:'Test'},playerName:'Alex',status:'active',selectedText:'',history:[],createdAt:'',updatedAt:'',
  objective:'',victoryCondition:'',gameProfile:{category:'adventure',endingMode:'open_ended',description:''},
  scene:{title:'Starting',text:'',choices:[]}};
const candidate={chapterPosition:0,chapterTitle:'Start',summary:'',excerpt:'UNBOUNDED_FUTURE',nextTextOffset:1,requiredEventId:'event',requiredEventBeats:beats,
  sourceReferenceExcerpts:{[sourceReferenceKey(ref)]:source,[sourceReferenceKey(futureRef)]:'FORBIDDEN_FUTURE_PASSAGE'}};
const contract=()=>planTurn({state,mode:'opening',event:{eventId:'event',beats}});
const reply=(v:unknown)=>({status:'completed',output_text:JSON.stringify(v)});
const facts={facts:[{fact:'Alex is at the doorway holding Pip.',quote:'Alex was at the doorway with Pip in their arms.'}],unresolved:[]};

test('opening with an automatic prefix receives static source evidence without future event excerpts',async()=>{
 const c=contract();assert.deepEqual(c.requiredAutomaticBeatIndexes,[0]);
 const result=await openingSourceFacts(c,[candidate],'model',async(_label,r)=>{
   assert.doesNotMatch(r.input,/FORBIDDEN_FUTURE_PASSAGE|UNBOUNDED_FUTURE/);
   assert.match(r.instructions!,/later arrival, retrieval/);
   return reply(facts);
 });
 assert.deepEqual(result?.facts,facts.facts);
});
test('opening context rejects invented quotes and never runs during an ordinary turn',async()=>{
 await assert.rejects(openingSourceFacts(contract(),[candidate],'model',async()=>reply({facts:[{fact:'Pip is here',quote:'Invented quotation'}],unresolved:[]})),/ungrounded/);
 const later={...contract(),mode:'observe' as const};
 assert.equal(await openingSourceFacts(later,[candidate],'model',async()=>{throw Error('Unexpected call');}),null);
});
test('repair reuses opening evidence and gives the reviewer the original missing-target failure',async()=>{
 const calls:Array<{label:string;request:AiResponseRequest}>=[];let reviews=0;
 const draft={title:'Outside',text:'I am at the doorway with Pip in my arms. I see Morgan watching the sky outside.',peopleKilledInScene:[],
  sceneScope:{currentLocation:'doorway',peoplePresent:['Alex','Pip'],peopleWithinSpeakingDistance:['Alex','Pip']},outcome:'active',outcomeReason:'',storyMemory:{summary:'Morgan watches the sky.',openThreads:[],canonFacts:[]}};
 const result=await generateCanonicalBeatScene(state,contract(),[candidate],{beat:'model',rewrite:'model'},async(label,request)=>{
  calls.push({label,request});
  if(label.startsWith('scene rewrite') || label==='scene content review')assert.match(request.instructions!,/played scenes and established game history supersede outdated character-profile/);
  const input=JSON.parse(request.input);
  if(label==='opening source context')return reply(facts);
  if(label==='scene beat 0')return reply({text:'Morgan watches the sky outside.'});
  if(label.startsWith('scene rewrite')){
   assert.deepEqual(input.production.openingFrame.evidence.facts,facts.facts);
   if(label.endsWith('repair'))assert.match(request.instructions!,/conditional statement/);
   return reply(draft);
  }
  const response=acceptedCanonicalReview(request);const v=JSON.parse(response.output_text);
  if(reviews++===0)v.productionChecks.nextDecisionSetup={status:'uncertain',reason:'Target availability has not been established.'};
  else {assert.match(JSON.stringify(input.previous_review_failures),/Target availability/);assert.match(request.instructions!,/Never elide an intervening actor/);}
  return reply(v);
 });
 assert.deepEqual(result.completedBeatIndexes,[0]);
 assert.equal(calls.filter(c=>c.label==='opening source context').length,1);
 assert.equal(calls.filter(c=>c.label==='scene content review').length,2);
});

// Captured source passages and model outputs from the four reported game logs.
// This replays the real failed provenance check, not a fabricated successful verdict.
const reportedOpenings = JSON.parse(readFileSync(new URL('./fixtures/opening-source-quotes.json', import.meta.url), 'utf8')) as Array<{
 player: string; passages: string[]; response: {facts: Array<{fact:string;quote:string}>;unresolved:string[]};
}>;
function evidenceInput(passages: string[]) {
 const c=structuredClone(contract());const references=passages.map((_,i)=>({...ref,lineStart:i+1,lineEnd:i+1}));
 c.beats=c.beats.map((beat,i)=>({...beat,sourceReferences:i===0?references:[]}));
 return {c, candidate:{...candidate,sourceReferenceExcerpts:Object.fromEntries(references.map((r,i)=>[sourceReferenceKey(r),passages[i]!]))}};
}
for (const fixture of reportedOpenings) test(`reported ${fixture.player} opening accepts wrapped source quotes and preserves exact provenance`,async()=>{
 const {c,candidate:sourceCandidate}=evidenceInput(fixture.passages);
 if(fixture.player!=='Cowardly Lion')assert.ok(fixture.response.facts.some(f=>!fixture.passages.some(p=>p.includes(f.quote))), 'Must reproduce the old strict-match failure');
 let calls=0;
 const result=await openingSourceFacts(c,[sourceCandidate],'model',async()=>{calls++;return reply(fixture.response);});
 assert.equal(calls,1);assert.equal(result!.facts.length,fixture.response.facts.length);
 assert.deepEqual(result!.facts.map(f=>f.fact),fixture.response.facts.map(f=>f.fact));
 assert.deepEqual(result!.unresolved,fixture.response.unresolved);
 for(const fact of result!.facts)assert.ok(fixture.passages.some(p=>p.includes(fact.quote)),'Returned quote must be an exact original source substring');
});
test('quote matching ignores only whitespace, never word changes, omissions, punctuation or passage boundaries',async()=>{
 const {c,candidate:sourceCandidate}=evidenceInput(['Alex\nwas\t not beside Pip (yet).','Morgan held Pip.']);
 const extract=(quote:string)=>openingSourceFacts(c,[sourceCandidate],'model',async()=>reply({facts:[{fact:'A supported circumstance.',quote}],unresolved:[]}));
 const result=await extract('Alex was not beside Pip (yet).');
 assert.equal(result!.facts[0]!.quote,'Alex\nwas\t not beside Pip (yet).');
 for(const quote of ['Alex was beside Pip (yet).','alex was not beside Pip (yet).','Alex was not beside Pip [yet].','Alex ... Pip (yet).','Pip (yet). Morgan held Pip.'])
   await assert.rejects(extract(quote),/ungrounded quotation/);
});
