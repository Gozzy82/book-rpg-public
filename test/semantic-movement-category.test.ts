import {parseChapterPartSourceIndex, mergeChapterPartSourceIndexes} from '../src/books/source-index/chapter-index.js';
import {chapterSourceIndexSchema} from '../src/books/analyze/batching.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {GameState, Scene, ImportedBook} from '../src/shared/contracts.js';
import {ProviderGameEngine} from '../src/ai/engine/provider-game-engine.js';
import {removeChoicesWithUnintroducedCharacters} from '../src/ai/engine/scene-validation.js';
import {buildBookStoryEvents} from '../src/books/source-index/story-events.js';
import {parseStoryEventCategory, mergedStoryEventCategory, storyEventCategorySchema} from '../src/shared/story-event-category.js';

class MovementReview extends ProviderGameEngine {
  review(state: GameState, scene: Scene) { return this.reviewSceneChoices(state, scene); }
}
for (const sample of [
  {text: 'I cannot move; rust has locked my joints.', blocked: [0]},
  {text: 'I thought I could not move, but Dorothy oiled my joints. Now I can walk.', blocked: []},
]) test(`movement uses the semantic menu verdict: ${sample.text}`, async () => {
  const scene: Scene = {title: 'By the tree', text: sample.text,
    sceneScope: {currentLocation: 'Forest', peoplePresent: ['Tin Woodman', 'Dorothy'], peopleWithinSpeakingDistance: ['Tin Woodman', 'Dorothy']},
    choices: [
      {id: 'move', type: 'action', text: 'Walk over to Dorothy'},
      {id: 'attempt', type: 'action', text: 'Attempt to flex one finger'},
      {id: 'ask', type: 'action', text: 'Ask Dorothy to fetch the oil-can', requiredPresentCharacters: ['Dorothy']},
    ]};
  const state = {playerName: 'Tin Woodman', scene, history: [], characterProfiles: [],
    objective: 'Travel', selectedText: '', book: {bookId: 'oz'}} as unknown as GameState;
  // Local cleanup must not second-guess prose before or after the semantic review.
  assert.equal(removeChoicesWithUnintroducedCharacters(scene, state).choices.length, 3);
  let calls = 0;
  const engine = new MovementReview({provider: 'openai', model: 'test', async createResponse(request) {
    calls++;
    assert.equal(request.text?.format.name, 'bookrpg_scene_choice_review');
    assert.match(request.instructions!, /limitations already resolved in this scene/);
    assert.match(request.instructions!, /attempt to move may remain executable/);
    assert.ok(request.input.includes(sample.text));
    return {status: 'completed', output_text: JSON.stringify({anchorChoiceIndex: 2,
      unusableChoiceIndexes: sample.blocked, unusableChoicesReason: sample.blocked.length ? 'Walking requires restored joints.' : '',
      reason: 'Asking for help is executable.'})};
  }});
  const review = await engine.review(state, scene);
  assert.deepEqual(review.unusableChoiceIndexes, sample.blocked);
  assert.equal(calls, 1);
});

test('book event categories preserve AI metadata and never classify words in descriptions', () => {
  const events = [
    {description: 'Decides to kill the Witch.', category: 'decision'},
    {description: 'Discovers the dead Witch.', category: 'discovery'},
    {description: 'The Witch dies.', category: 'death'},
    {description: 'Waits for the Lion to arrive.', category: 'other'},
    {description: 'The Witch dies.'},
  ];
  const book = {bookId: 'oz', chapters: [{index: 0, text: 'Source', sourceIndex: {
    significantEvents: events.map(event => ({...event, sourceReferences: [{chapterPosition: 0, chapterIndex: 0, lineStart: 1, lineEnd: 1}]})), actions: [],
  }}]} as unknown as ImportedBook;
  assert.deepEqual(buildBookStoryEvents(book).map(e => e.category), ['decision', 'discovery', 'death', 'other', 'other']);
  assert.equal(parseStoryEventCategory(undefined), 'other');
  assert.throws(() => parseStoryEventCategory('murder'), /Invalid/);
  assert.throws(() => parseStoryEventCategory(null), /Invalid/);
  assert.match(storyEventCategorySchema.description, /not a threat, plan, condition/);
});

test('merged events preserve a shared category and leave mixed events unclassified', () => {
  assert.equal(mergedStoryEventCategory([{category: 'decision'}, {category: 'decision'}]), 'decision');
  assert.equal(mergedStoryEventCategory([{category: 'death'}, {category: 'arrival'}]), 'other');
  assert.equal(mergedStoryEventCategory([{category: 'death'}, {}]), 'other');
});


test('AI event category survives parsing and chapter/book assembly; schema requires it', () => {
  const references = [{lineStart: 1, lineEnd: 1}];
  const description = 'Lion decides to kill the Witch.';
  const raw = {summary: description, characters: [{name: 'Lion', aliases: [], references}], actions: [], relationships: [],
    significantEvents: [{description, category: 'decision', references, beats: [{actor: 'Lion',
      action: description, targets: [], agency: 'intentional', stakes: 'significant', references}]}]};
  const bounds = {sourceId: 'part', chapterIndex: 0, lineStart: 1, lineEnd: 1, sourceText: description};
  const part = parseChapterPartSourceIndex(raw, bounds);
  const chapter = mergeChapterPartSourceIndexes(0, 0, description, [part]);
  const book = {bookId: 'oz', chapters: [{index: 0, title: 'Decision', text: description, sourceIndex: chapter}]};
  assert.equal(part.significantEvents[0]!.category, 'decision');
  assert.equal(chapter.significantEvents![0]!.category, 'decision');
  assert.equal(buildBookStoryEvents(book)[0]!.category, 'decision');
  raw.significantEvents[0]!.category = 'invented';
  assert.throws(() => parseChapterPartSourceIndex(raw, bounds), /Invalid story event category/);
  const schema = chapterSourceIndexSchema([{...bounds, chapterPosition: 0, chapterTitle: 'Decision', partIndex: 0, partCount: 1, text: description}]) as any;
  assert.ok(schema.properties.part.properties.significantEvents.items.required.includes('category'));
});
