import test from 'node:test';
import assert from 'node:assert/strict';
import {joinAutomaticContinuations} from '../src/games/service/automatic-continuation.js';
import {SOURCE_CONTINUATION_CHOICE_ID, type GameState} from '../src/shared/contracts.js';
import {SceneGenerationError} from '../src/ai/engine/core.js';
const continuation = {id:SOURCE_CONTINUATION_CHOICE_ID,type:'action' as const,text:'Continue'};
function state(): GameState { return {narrativeMode:'canonical',turnNumber:2,
 sourceCursor:{chapterPosition:0,textOffset:1,eventId:'first'},scene:{title:'Storm',text:'The wind rises.',choices:[continuation]},history:[],
} as unknown as GameState; }
test('automatic segments cross event boundaries in one turn and stop at a player choice',async()=>{
 const game=state();let calls=0;
 await joinAutomaticContinuations(game,async draft=>{
  calls++;draft.sourceCursor!.eventId=`event${calls}`;
  draft.scene.text=calls===1?'The guardian warns us.':'The dog hides.';
  draft.scene.choices=calls===1?[continuation]:[{id:'player',type:'action',text:'Retrieve the dog'}];
  return true;
 });
 assert.equal(calls,2);assert.equal(game.turnNumber,2);assert.deepEqual(game.history,[]);
 assert.equal(game.scene.text,'The wind rises.\n\nThe guardian warns us.\n\nThe dog hides.');
 assert.equal(game.scene.choices[0]!.id,'player');assert.equal(game.sourceCursor!.eventId,'event2');
});
test('free scenes, endings and real choices never trigger automatic chaining',async()=>{
 for(const game of [{...state(),narrativeMode:'free' as const},{...state(),scene:{...state().scene,outcome:'lost' as const}},
  {...state(),scene:{...state().scene,choices:[continuation,{id:'other',type:'action' as const,text:'Leave'}]}}]){
  await joinAutomaticContinuations(game,async()=>{throw new Error('Must not continue');});
 }
});
test('failed automatic segments are discarded and bounded chains keep their continuation menu',async()=>{
 const game=state();const before=structuredClone(game);
 await joinAutomaticContinuations(game,async draft=>{draft.scene.text='Rejected';draft.sourceCursor!.eventId='bad';throw new SceneGenerationError(['Rejected'],1);});
 assert.deepEqual(game,before);
 let calls=0;
 await joinAutomaticContinuations(game,async draft=>{calls++;draft.sourceCursor!.eventId=`next${calls}`;draft.scene.text='A new beat.';return true;},2);
 assert.equal(calls,2);assert.equal(game.scene.choices[0]!.id,SOURCE_CONTINUATION_CHOICE_ID);
});
test('no-progress results cannot add repeated prose; preflight can expose a player menu',async()=>{
 const game=state();
 await joinAutomaticContinuations(game,async draft=>{draft.scene.text='Must not append';draft.scene.choices=[{id:'player',type:'action',text:'Choose'}];return true;});
 assert.equal(game.scene.text,'The wind rises.');assert.equal(game.scene.choices[0]!.id,'player');
});
