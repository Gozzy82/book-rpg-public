import test from 'node:test';
import assert from 'node:assert/strict';
import type {GameState, Scene} from '../src/shared/contracts.js';
import {ProviderGameEngine} from '../src/ai/engine/provider-game-engine.js';
import {filterSceneScopeForState, removeChoicesWithUnintroducedCharacters} from '../src/ai/engine/scene-validation.js';

class ReviewEngine extends ProviderGameEngine {
  presence(state: GameState, scene: Scene) { return this.reviewScenePresence(state, scene, [], []); }
}
const profiles = ['Cowardly Lion', 'Dorothy'].map(name => ({
  name, aliases: [], role: 'Traveler', description: '', traits: [], relationships: [], storyArc: '',
}));

for (const sample of [
  {text: 'Dorothy sits beside me. We discuss Dorothy returning home.', present: true},
  {text: 'Dorothy is not here. I wonder when Dorothy returns.', present: false},
  {text: 'The door opens. A familiar pair of silver shoes stops beside me. Dorothy smiles.', present: true},
]) test(`AI presence survives filtering: ${sample.text}`, async () => {
  const people = ['Cowardly Lion', ...(sample.present ? ['Dorothy'] : [])];
  const scene: Scene = {
    title: 'At the palace', text: sample.text,
    sceneScope: {currentLocation: 'Palace room', peoplePresent: ['Cowardly Lion'], peopleWithinSpeakingDistance: ['Cowardly Lion']},
    choices: [{id: 'talk', type: 'talk', text: 'Talk to Dorothy', character: 'Dorothy'},
      {id: 'wait', type: 'action', text: 'Wait quietly'}],
  };
  const state = {
    playerName: 'Cowardly Lion', book: {bookId: 'oz'}, scene: {...scene, text: 'Dorothy has left.'},
    characterProfiles: profiles, sourceIntroducedCharacters: ['Dorothy'], history: [], confirmedDeadCharacters: [],
    gameProfile: {category: 'exploration', endingMode: 'open_ended', description: ''},
  } as unknown as GameState;
  let calls = 0;
  const engine = new ReviewEngine({provider: 'openai', model: 'test', async createResponse(request) {
    calls++;
    assert.equal(request.text?.format.name, 'bookrpg_scene_presence_review');
    assert.equal(JSON.parse(request.input).candidate_scene.text, sample.text);
    assert.match(request.instructions!, /plans to return home do not change presence/);
    return {status: 'completed', output_text: JSON.stringify({peoplePresent: people,
      peopleWithinSpeakingDistance: people, peopleKilledInScene: [], latestVisibleSourceEventId: null,
      completedSourceEventBeatIndexes: [], futureActionSetupRequired: false, futureActionSetupSupported: true,
      futureActionSetupReason: 'No pending action.', reason: 'Reviewed scene end state.'})};
  }});
  const review = await engine.presence(state, scene);
  scene.sceneScope = filterSceneScopeForState({...scene.sceneScope!, peoplePresent: review.peoplePresent,
    peopleWithinSpeakingDistance: review.peopleWithinSpeakingDistance}, state, scene);
  assert.deepEqual(scene.sceneScope.peoplePresent, people);
  assert.deepEqual(removeChoicesWithUnintroducedCharacters(scene, state).choices.map(c => c.id),
    sample.present ? ['talk', 'wait'] : ['wait']);
  assert.equal(calls, 1);
  // Even a positive presence verdict cannot undo the confirmed death ledger.
  const deadScope = filterSceneScopeForState(scene.sceneScope, {...state, confirmedDeadCharacters: ['Dorothy']}, scene);
  assert.ok(!deadScope.peoplePresent.includes('Dorothy'));
});

test('choice filters preserve AI prerequisites instead of silently reclassifying wording', () => {
  const scope = {currentLocation: 'Palace', peoplePresent: ['Cowardly Lion', 'Dorothy'], peopleWithinSpeakingDistance: ['Cowardly Lion', 'Dorothy']};
  const scene: Scene = {title: 'Palace', text: 'Dorothy stands beside me.', sceneScope: scope,
    choices: [{id: 'listen', type: 'action', text: 'Listen for Dorothy and ask her about home',
      character: 'Dorothy', requiredPresentCharacters: ['Dorothy'], requiredAbsentCharacters: []}]};
  const state = {playerName: 'Cowardly Lion', characterProfiles: profiles, scene, history: [], sourceIntroducedCharacters: ['Dorothy']};
  assert.deepEqual(removeChoicesWithUnintroducedCharacters(scene, state).choices, scene.choices);
});
