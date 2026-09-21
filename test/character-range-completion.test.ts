import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {applyCharacterChoiceRanges,groupExistingCharacterEvent} from '../src/books/analyze/character-action-groups.js';
const f=JSON.parse(fs.readFileSync(new URL('./fixtures/import-goals/anchor-completion-owner.json',import.meta.url),'utf8'));
const character={name:'Dorothy',aliases:[],characterId:'dorothy'};
const completion='Dorothy has decided to return to Oz for his promise, and her companions have affirmed that commitment.';
test('NPC endpoint does not replace player completion or require shortening the captured range',async()=>{
  const original=structuredClone(f.event);
  const groups=f.checkpoint.rejectedCandidate.map((r:any,i:number)=>({...r,completion:i===0?completion:f.event.beats[4].resultingState}));
  const result=await groupExistingCharacterEvent(async request=>{
    const schema:any=request.text!.format.schema;
    assert.ok(schema.properties.groups.items.required.includes('completion'));
    return {status:'completed',output_text:JSON.stringify({groups})};
  },'test',f.event,character,{source:{},previousEvents:[],candidate:f.checkpoint.rejectedCandidate,feedback:f.checkpoint.error});
  const action=result.event.beats![0]!.characterActionGroup!;
  assert.equal(action.completion,completion);
  assert.equal(action.endBeatIndex,3);
  assert.deepEqual(action.playerBeatIndexes,[0]);
  assert.deepEqual(f.event,original);
  assert.equal(applyCharacterChoiceRanges(f.event,character,JSON.parse(JSON.stringify(result.ranges))).beats![0]!.characterActionGroup!.completion,completion);
});
test('legacy approved ranges remain readable; explicitly blank completions are rejected',()=>{
  assert.doesNotThrow(()=>applyCharacterChoiceRanges(f.event,character,f.checkpoint.rejectedCandidate));
  assert.throws(()=>applyCharacterChoiceRanges(f.event,character,f.checkpoint.rejectedCandidate.map((r:any)=>({...r,completion:' '}))),/Invalid character choice range/);
});
