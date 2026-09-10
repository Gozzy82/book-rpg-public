import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderGameEngine } from '../src/ai/engine/provider-game-engine.js';
import { correctStaleScenePresenceSetup } from '../src/ai/engine/provider-engine-base.js';
import type { AiClient } from '../src/ai/provider.js';
import type { GameState, StoryEventBeat } from '../src/shared/contracts.js';
import type { SourceContinuationCandidate } from '../src/ai/engine/core.js';

class Engine extends ProviderGameEngine {
  run(state: GameState, candidate: SourceContinuationCandidate) {
    return this.scene('Resolve the selected request.', state, 'Ask Dorothy to travel together', [candidate], 1);
  }
}
const beat = (actor: string, action: string): StoryEventBeat => ({
  actor, action, agency: 'intentional', stakes: 'significant', targets: [], sourceReferences: [],
});

for (const [npcTailOnly, claimsCompletion] of [[false, true], [true, true], [true, false]]) {
  test(`partial option-one progress survives a premature completion claim (NPC tail: ${npcTailOnly}, claim: ${claimsCompletion})`, async () => {
    const action = 'Ask Dorothy to travel together';
    const event = {
      eventId: 'join', sequence: 2, chapterPosition: 1,
      description: 'The Tin Woodman joins Dorothy and clears the road.',
      beats: [beat('Tin Woodman', 'Asks Dorothy to travel together.'),
        beat('Dorothy', 'Welcomes the Tin Woodman.'),
        beat(npcTailOnly ? 'Dorothy' : 'Tin Woodman', 'Clears the fallen branch from the road.')],
    };
    const scope = { currentLocation: 'Forest road', peoplePresent: ['Dorothy'], peopleWithinSpeakingDistance: ['Dorothy'] };
    const state: GameState = {
      gameId: 'test', book: { bookId: 'oz', title: 'Oz' }, playerName: 'Tin Woodman',
      gameProfile: { category: 'adventure', endingMode: 'open_ended', description: 'A journey through Oz.' },
      objective: 'Reach Oz', victoryCondition: 'Reach Oz', status: 'active', selectedText: '',
      scene: { title: 'Free at last', text: 'My joints move freely. Dorothy stands beside me.', choices: [], sceneScope: scope },
      history: [{ kind: 'scene', text: 'My joints move freely. Dorothy stands beside me.' }, { kind: 'choice', text: action }],
      createdAt: '', updatedAt: '',
    };
    const client: AiClient = {
      provider: 'openai', model: 'test', async createResponse(request) {
        const format = request.text?.format.name;
        let result: unknown;
        if (format === 'bookrpg_scene_repetition_review') {
          result = { repeatsPriorScene: false, latestInputResolvedFaithfully: true, preservesPlayerPerspective: true,
            latestInputFailureType: 'none', preservesPlayerAgency: true, staysWithinTurnScope: true,
            requiredEventOccurred: claimsCompletion, reason: 'The request has been resolved.' };
        } else if (format === 'bookrpg_scene_presence_review') {
          result = { ...scope, latestVisibleSourceEventId: null, completedSourceEventBeatIndexes: [0, 1],
            futureActionSetupRequired: false, futureActionSetupSupported: true, reason: 'The fallen branch remains.' };
        } else if (format === 'bookrpg_scene_choices') {
          assert.match(request.input, /Clears the fallen branch/);
          result = { choices: [
            { id: 'clear', type: 'action', text: npcTailOnly ? 'Watch Dorothy approach the fallen branch' : 'Lift the fallen branch off the path', stakes: 'significant' },
            { id: 'talk', type: 'talk', text: 'Talk to Dorothy', character: 'Dorothy', stakes: 'routine' },
          ] };
        } else if (format === 'bookrpg_scene_choice_review') {
          result = { anchorChoiceIndex: npcTailOnly ? null : 0, unusableChoiceIndexes: [], unusableChoicesReason: '', reason: 'Executable choices.' };
        } else {
          result = { title: 'A welcome', text: 'Dorothy smiles at my request. “Come with us,” she says. A fallen branch blocks the road beside my axe.',
            playerAction: action, actionOutcome: 'succeeded', actionResult: 'Dorothy welcomes me.',
            externalDevelopment: 'Dorothy welcomes me as a companion.', sourceChapterPosition: claimsCompletion ? 1 : null,
            sceneScope: scope, outcome: 'active', outcomeReason: 'The road is blocked.' };
        }
        return { output_text: JSON.stringify(result), status: 'completed' };
      },
    };
    const result = await new Engine(client, 'minimal').run(state, {
      chapterPosition: 1, chapterTitle: 'Forest', summary: event.description, excerpt: event.description,
      nextTextOffset: 100, requiredEventId: event.eventId, requiredEvent: event.description,
      requiredEventBeats: event.beats, storyEvents: [event],
    });
    assert.deepEqual(result.sourceEventProgress, { eventId: 'join', completedBeatIndexes: [0, 1] });
    assert.equal(result.sourceProgress, undefined, 'partial progress must not advance the completed-event cursor');
    assert.ok(result.choices.length >= 2);
    assert.doesNotMatch(result.choices[0]!.text, /Ask Dorothy to travel together/i);
  });
}

test('completing one player beat must not suppress missing setup for the next player beat', () => {
  const response = { output_text: JSON.stringify({
    completedSourceEventBeatIndexes: [0], latestVisibleSourceEventId: null,
    futureActionSetupRequired: true, futureActionSetupSupported: false,
    futureActionSetupReason: 'The next catch requires a banana flying toward the pond.',
  }) };
  const result = correctStaleScenePresenceSetup({ model: 'test', input: JSON.stringify({
    event_review_target: { eventId: 'banana' },
    future_player_actions: [{ beatIndex: 0, action: 'Calls for a banana.' }, { beatIndex: 2, action: 'Catches the banana above the pond.' }],
  }) }, response);
  assert.equal(JSON.parse(result.output_text).futureActionSetupSupported, false);
});
