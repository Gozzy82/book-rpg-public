import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {BookStoryEvent} from '../src/shared/contracts.js';
import {oilBeatPilotContract} from '../src/ai/engine/oil-beat-pilot.js';
import {parallelBeatRequests,generateParallelBeatScene} from '../src/ai/engine/parallel-beat-scene.js';
const event:BookStoryEvent=JSON.parse(fs.readFileSync(new URL('./fixtures/import-goals/existing-character-events.json',import.meta.url),'utf8'))[1];
test('oil pilot preserves the existing index and plans the full five-beat rescue from Dorothy',()=>{
 const before=JSON.stringify(event);
 const contract=oilBeatPilotContract(event);
 assert.equal(contract.player,'Dorothy');
 assert.deepEqual(contract.allowedPlayerBeatIndexes,[7,8,9,11]);
 assert.deepEqual(contract.requiredAutomaticBeatIndexes,[10]);
 assert.equal(contract.nextPlayerDecision,null);
 const requests=parallelBeatRequests(contract,'test');
 assert.deepEqual(requests.map(r=>r.beatIndex),[7,8,9,10,11]);
 for(const {beatIndex,request} of requests){
  const t=JSON.parse(request.input).transition;
  assert.equal(t.action,event.beats![beatIndex]!.action);
  assert.equal(t.start_state,event.beats![beatIndex-1]!.resultingState);
  assert.equal(t.desired_resulting_state,event.beats![beatIndex]!.resultingState);
 }
 assert.match(JSON.parse(requests[1]!.request.input).transition.desired_resulting_state,/arms and legs remain rusted/);
 assert.match(JSON.parse(requests[3]!.request.input).transition.desired_resulting_state,/legs remain rusted/);
 assert.equal(JSON.stringify(event),before);
});
test('oil pilot makes exactly five generation calls and joins all five paragraphs',async()=>{
 const calls:number[]=[];
 const result=await generateParallelBeatScene(oilBeatPilotContract(event),'test','low',async i=>{calls.push(i);return {status:'completed',output_text:JSON.stringify({text:`Paragraph ${i}.`})};});
 assert.deepEqual(calls,[7,8,9,10,11]);
 assert.equal(result.scene!.blocks.length,5);
 assert.deepEqual(result.failures,[]);
});
