import test from 'node:test';
import assert from 'node:assert/strict';
import type {CharacterProfile, GameState} from '../src/shared/contracts.js';
import {normalizeSceneDeaths} from '../src/shared/scene-deaths.js';
import {sceneJsonSchema, scenePresenceReviewJsonSchema} from '../src/ai/schema.js';
import {TurnPipelineGameEngine} from '../src/ai/engine/turn-pipeline-engine.js';

const profiles = [{name:'Wicked Witch of the West',aliases:['West Witch']} as CharacterProfile];
const state = {
  book:{bookId:'oz'},characterProfiles:profiles,history:[],
  scene:{text:'Oz would not send her home unless she first killed the Wicked Witch of the West.'},
  storyMemory:{summary:'The task remains unfinished.',canonFacts:[],openThreads:[]},
} as unknown as GameState;

test('death schemas ask the AI to distinguish actual death from conditions and identify victims',()=>{
  for(const schema of [sceneJsonSchema,scenePresenceReviewJsonSchema]){
    assert.ok(schema.required.includes('peopleKilledInScene'));
    assert.match(schema.properties.peopleKilledInScene.description,/conditions/);
    assert.match(schema.properties.peopleKilledInScene.description,/victim, never the killer/);
  }
});

test('death identity validation canonicalizes aliases without interpreting any prose',()=>{
  assert.deepEqual(normalizeSceneDeaths(['West Witch','Wicked Witch of the West'],profiles),['Wicked Witch of the West']);
  assert.deepEqual(normalizeSceneDeaths([],profiles),[]);
  assert.throws(()=>normalizeSceneDeaths(['Oz'],profiles),/unknown character/);
  assert.throws(()=>normalizeSceneDeaths('The Witch died.',profiles),/Invalid/);
});

test('legacy death assessment trusts the structured AI verdict, never the conditional death wording',async()=>{
  const before=structuredClone(state);
  let calls=0;
  const engine=new TurnPipelineGameEngine({provider:'openai',model:'test',async createResponse(request){
    calls++;
    assert.equal(request.text?.format.name,'bookrpg_saved_deaths');
    assert.match(request.instructions!,/conditions/);
    const input=JSON.parse(request.input);
    assert.equal(input.scene,state.scene.text);
    assert.equal(input.future_events,undefined);
    return {status:'completed',output_text:JSON.stringify({peopleKilledInScene:[]})};
  }});
  assert.deepEqual(await engine.assessEstablishedDeaths(state),[]);
  assert.equal(calls,1);
  assert.deepEqual(state,before);
});

test('legacy assessment accepts confirmed victims but rejects incomplete or malformed assessments',async()=>{
  for(const response of [
    {status:'completed',output_text:JSON.stringify({peopleKilledInScene:['West Witch']})},
    {status:'incomplete',output_text:''},
    {status:'completed',output_text:JSON.stringify({peopleKilledInScene:['Unknown']})},
    {status:'completed',output_text:'{}'},
  ]){
    const engine=new TurnPipelineGameEngine({provider:'openai',model:'test',async createResponse(){return response;}});
    const actual={...state,scene:{...state.scene,text:'The Witch died when Dorothy threw water over her.'}};
    if(response.output_text.includes('West Witch')) assert.deepEqual(await engine.assessEstablishedDeaths(actual),['Wicked Witch of the West']);
    else await assert.rejects(engine.assessEstablishedDeaths(actual));
  }
});
