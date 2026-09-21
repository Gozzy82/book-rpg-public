import test from 'node:test';
import assert from 'node:assert/strict';
import {endStateSentences,endStateObservationRequest,decodeEndStateObservation,endStateComparisonRequest,decodeEndStateComparison} from '../src/ai/engine/observe-end-state.js';
const text='I sit on the floor. Then I stand up and enter the cellar with Toto.';
const observed={location:'cellar',posture:'standing',possessions:'Toto',finalState:'Standing in the cellar with Toto.',evidenceQuotes:['Then I stand up and enter the cellar with Toto.']};
test('observation sees only prose and viewpoint, with no expected-state or shared-story instructions',()=>{
 const request=endStateObservationRequest(text,'Dorothy','test');
 assert.deepEqual(JSON.parse(request.input),{viewpoint_character:'Dorothy',scene_sentences:endStateSentences(text)});
 assert.equal(request.turnContract,undefined);
 assert.match(request.instructions!,/never supplement it with knowledge of a book/);
 assert.match(request.instructions!,/Later actual movement overrides earlier/);
 assert.equal(request.max_output_tokens,1400);
});
test('comparison receives the independent observation unchanged and no original scene',()=>{
 const request=endStateComparisonRequest(observed,'Seated upstairs holding Toto.','Dorothy','test');
 assert.deepEqual(JSON.parse(request.input),{viewpoint_character:'Dorothy',observed_final_state:observed,expected_resulting_state:'Seated upstairs holding Toto.'});
 assert.equal(request.input.includes('I sit on the floor.'),false);
 assert.equal(request.max_output_tokens,1800);
});
test('invalid, incomplete and fabricated evidence cannot be passed to comparison',()=>{
 const response={status:'completed',output_text:JSON.stringify({...observed,evidenceSentenceIds:[2]})};
 assert.deepEqual(decodeEndStateObservation(response,text),observed);
 assert.throws(()=>decodeEndStateObservation({...response,status:'incomplete'},text),/Incomplete/);
 assert.throws(()=>decodeEndStateObservation({...response,output_text:JSON.stringify({...observed,evidenceSentenceIds:[999]})},text),/ungrounded/);
 assert.throws(()=>decodeEndStateObservation({...response,output_text:JSON.stringify({...observed,evidenceSentenceIds:[]})},text),/ungrounded/);
 assert.deepEqual(decodeEndStateComparison({status:'completed',output_text:'{"matches":false,"reason":"Cellar contradicts upstairs."}'}),{matches:false,reason:'Cellar contradicts upstairs.'});
 assert.throws(()=>decodeEndStateComparison({status:'incomplete',output_text:''}),/Incomplete/);
 assert.throws(()=>decodeEndStateComparison({status:'completed',output_text:'{"matches":"true","reason":"ok"}'}),/Invalid/);
});

test('first-person observation retains game-supplied identity in comparison for any player',()=>{
 const firstPerson={...observed,location:'in the room',posture:'sitting on the floor',finalState:'I remain seated there holding Toto; we have not reached the cellar.'};
 for(const player of ['Dorothy','Scarecrow']){
  const request=endStateComparisonRequest(firstPerson,`${player} is seated holding Toto.`,player,'test');
  const input=JSON.parse(request.input);
  assert.equal(input.viewpoint_character,player);
  assert.deepEqual(input.observed_final_state,firstPerson);
  assert.match(request.instructions!,/First-person narration .* refers to that character/);
  assert.match(request.instructions!,/does not change the speaker of quoted dialogue/);
 }
});

test('cellar evidence is reconstructed verbatim instead of requiring the model to copy capitalization',()=>{
 const scene='I press toward the open trapdoor with a new weight in my arms, the lamp-adorned ceiling folding away into the cool dark of the cellar. I stumble, slump to the floor, Toto tucked in my arms.';
 const response={status:'completed',output_text:JSON.stringify({...observed,evidenceSentenceIds:[1,2],evidenceQuotes:['The lamp-adorned ceiling folding away into the cool dark of the cellar.']})};
 const decoded=decodeEndStateObservation(response,scene);
 assert.deepEqual(decoded.evidenceQuotes,endStateSentences(scene).map(s=>s.text));
 assert.equal(decoded.location,'cellar');
 assert.doesNotMatch(decoded.evidenceQuotes[0]!,/^The lamp/);
});

test('present-state comparison distinguishes omitted history from missing physical evidence',()=>{
 const state={...observed,finalState:'The rescued figure can move all joints freely.'};
 const request=endStateComparisonRequest(state,'The figure can move all joints and is freed from year-long immobilization.','Dorothy','test');
 assert.deepEqual(JSON.parse(request.input).observed_final_state,state);
 assert.match(request.instructions!,/duration need not be restated/);
 assert.match(request.instructions!,/Never infer missing present mobility, location, posture or possessions/);
 assert.match(request.instructions!,/explicit contradiction of the historical background still fails/);
 const observation=endStateObservationRequest('His joints move freely. I smile with relief.','Dorothy','test');
 assert.match(observation.instructions!,/other participants affected by the scene/);
 assert.match(observation.instructions!,/not let a vague closing reflection replace them/);
});
