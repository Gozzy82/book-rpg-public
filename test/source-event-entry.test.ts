import {acceptedCanonicalReview} from "./helpers/canonical-review.js";
import test from 'node:test';
import {CONVERSATIONAL_REACH_POLICY} from '../src/shared/conversational-reach-policy.js';
import assert from 'node:assert/strict';
import type {GameState, ImportedBook, BookStoryEvent} from '../src/shared/contracts.js';
import type {SourceContinuationCandidate} from '../src/ai/engine/core.js';
import {sourceEventEntryEvidence} from '../src/games/service/source-event-entry-evidence.js';
import {establishSourceEventEntry as actualEventEntry, establishSourceBeatEntry as actualBeatEntry} from '../src/ai/engine/source-event-entry.js';
import {TurnPipelineGameEngine} from '../src/ai/engine/turn-pipeline-engine.js';

// Existing transition/repair tests explicitly exercise the not-ready branch.
// Separate preflight tests below exercise the real initial acceptance gate.
const needsSetup = () => reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'entryReady', ...(k === 'visibleCause' ? {causeStatus:'not_required'} : {}), reason: 'Missing setup fixture.', ...(k === 'entryReady' ? {repairTarget: 'none'} : {})}])));
function withMissingSetup(call: Parameters<typeof actualEventEntry>[5]): typeof call {
  return (label, request) => label.endsWith(' preflight review') ? Promise.resolve(needsSetup()) : call(label, request);
}
const establishSourceEventEntry: typeof actualEventEntry = (state, scene, candidate, completed, model, call) => actualEventEntry(state, scene, candidate, completed, model, withMissingSetup(call));
const establishSourceBeatEntry: typeof actualBeatEntry = (state, scene, candidate, event, completed, start, model, call) => actualBeatEntry(state, scene, candidate, event, completed, start, model, withMissingSetup(call));

const ref = (lineStart: number, lineEnd = lineStart) => ({chapterPosition: 0, chapterIndex: 1, lineStart, lineEnd});
const event = (eventId: string, sequence: number, line: number) => ({eventId, sequence, chapterPosition: 0, description: eventId,
  sourceReferences: [ref(line)], beats: [{actor: 'Tin Woodman', action: eventId, targets: [], agency: 'intentional', stakes: 'significant', sourceReferences: [ref(line)]}]}) as BookStoryEvent;
const book = {chapters: [{index: 1, text: 'The Lion carries us across the first gulf.\nAfter resting, we travel on.\nAnother, wider gulf blocks us; a tree stands beside it.\nI chop nearly through the tree.\nThe Lion pushes it over.'}],
  storyEvents: [event('first', 1, 1), event('tree', 2, 4)]} as Pick<ImportedBook, 'chapters' | 'storyEvents'>;
test('entry evidence contains only the gap, excluding resolved and future actions', () => {
  assert.deepEqual(sourceEventEntryEvidence(book), {tree: {fromEventId: 'first', excerpt: 'After resting, we travel on.\nAnother, wider gulf blocks us; a tree stands beside it.', entryExcerpt: 'I chop nearly through the tree.'}});
});
test('overlapping or invalid references do not license invented setup', () => {
  assert.deepEqual(sourceEventEntryEvidence({...book, storyEvents: [event('first', 1, 4), event('tree', 2, 4)]}), {});
  assert.deepEqual(sourceEventEntryEvidence({...book, storyEvents: [event('first', 1, 1), event('tree', 2, 50)]}), {});
});
test('an intervening indexed event cannot be skipped by a gap', () => {
  const entries = sourceEventEntryEvidence({...book, storyEvents: [event('first', 1, 1), event('decision', 2, 2), event('tree', 3, 4)]});
  assert.equal(entries.tree?.fromEventId, 'decision');
  assert.equal(entries.tree?.excerpt, 'Another, wider gulf blocks us; a tree stands beside it.');
});

const scope = {currentLocation: 'Far side of the first gulf', peoplePresent: ['Tin Woodman', 'Cowardly Lion'], peopleWithinSpeakingDistance: ['Tin Woodman', 'Cowardly Lion']};
const memory = {summary: 'We crossed the first gulf.', openThreads: [], canonFacts: ['The first gulf is behind us.']};
const scene = {title: 'Across the First Gulf', text: 'The Lion carried me over the first gulf and rested.', choices: [], sceneScope: scope, storyMemory: memory};
const state = {playerName: 'Tin Woodman', parameters: [], characterProfiles: [], scene} as unknown as GameState;
const candidate = {storyEvents: book.storyEvents, sourceEventEntries: sourceEventEntryEvidence(book)} as SourceContinuationCandidate;
const draft = {text: 'After resting we went on, until a wider gulf barred the way. A tall tree stood beside it.',
  sceneScope: {...scope, currentLocation: 'Beside the second gulf and its tree'}, storyMemory: {...memory, summary: 'We reached the second gulf.'}};
const checks = ['sourceSupport', 'continuity', 'playerAgency', 'nextEventUnperformed', 'entryReady', 'visibleCause', 'sceneScope', 'storyMemory', 'repetition'];
const reply = (v: unknown) => ({status: 'completed', output_text: JSON.stringify(v)});
test('reviewed setup appends after completion, updates scope and never credits future beats', async () => {
  const calls: string[] = [], before = structuredClone(scene);
  const output = await establishSourceEventEntry(state, scene, candidate, 'first', 'test', async (label, request) => {
    calls.push(label);
    assert.doesNotMatch(JSON.parse(request.input).entry_source, /chop|pushes/);
    assert.match(request.instructions!, /meaningful player decision/);
    return label === 'source event entry' ? reply(draft) : reply(Object.fromEntries(checks.map(k => [k, {supported: true, reason: 'Grounded in the gap and prose.'}])));
  });
  assert.deepEqual(calls, ['source event entry', 'source event entry review']);
  assert.equal(output.text, scene.text + '\n\n' + draft.text);
  assert.equal(output.sceneScope?.currentLocation, draft.sceneScope.currentLocation);
  assert.equal('sourceProgress' in output, false); assert.equal('sourceEventProgress' in output, false);
  assert.deepEqual(scene, before);
});
test('unreviewed, premature or unsupported transition cannot replace the existing scene', async () => {
  for (const rejected of checks) {
    const before = structuredClone(scene);
    await assert.rejects(() => establishSourceEventEntry(state, scene, candidate, 'first', 'test', async (label, request) => label === 'source event entry'
      ? reply(draft) : label.endsWith('presentation repair') ? reply(Object.fromEntries(JSON.parse(request.input).repair_fields.map((k: keyof typeof draft) => [k, draft[k]]))) : reply(Object.fromEntries(checks.map(k => [k, {supported: k !== rejected, reason: 'Evidence check.'}])))), /Source event entry/);
    assert.deepEqual(scene, before);
  }
});
test('missing source gap, wrong predecessor or no following event makes no extra calls', async () => {
  for (const [c, id] of [[{...candidate, sourceEventEntries: {}}, 'first'], [candidate, 'other'], [candidate, 'tree']] as const) {
    assert.equal(await establishSourceEventEntry(state, scene, c, id, 'test', async () => {throw Error('Unexpected call');}), scene);
  }
});

test('production canonical route establishes the second gulf before generating its menu', async () => {
  const first = {...book.storyEvents![0]!, beats: [{...book.storyEvents![0]!.beats![0]!, actor: 'Cowardly Lion',
    action: 'Carries the Tin Woodman across the first gulf and rests.', resultingState: 'Everyone is beyond the first gulf.'}]};
  const tree = {...book.storyEvents![1]!, beats: [{...book.storyEvents![1]!.beats![0]!,
    action: 'Chops nearly through the tree.', resultingState: 'The tree is nearly severed.'}]};
  const cs = [{...candidate, chapterPosition: 0, chapterTitle: 'The gulf', summary: 'Cross the gulf', excerpt: '', nextTextOffset: 50,
    requiredEvent: first.description, requiredEventId: first.eventId, requiredEventBeats: first.beats, currentStoryEvent: first, storyEvents: [first, tree]}];
  const fullState = {...state, gameId: 'entry-test', book: {bookId: 'oz', title: 'Oz', author: 'Baum'},
    gameProfile: {category: 'adventure', endingMode: 'open_ended', description: 'Journey'}, objective: 'Find Oz', victoryCondition: 'Reach Oz',
    status: 'active', selectedText: '', history: [], createdAt: 'now', updatedAt: 'now', turnNumber: 1,
    scene: {...scene, text: 'We wait at the first gulf.'}} as GameState;
  for (const rejectEntry of [false, true]) {
    const names: string[] = [];
    class Probe extends TurnPipelineGameEngine {
      menus: string[] = [];
      generate() { return this.scene('Continue', fullState, undefined, cs, 1, 'observed_scene_progression', true); }
      protected override async sceneChoices(...args: Parameters<TurnPipelineGameEngine['sceneChoices']>) {
        this.menus.push(args[0].sceneScope!.currentLocation);
        assert.match(args[0].text, /wider gulf/);
        assert.equal(args[1].storyMemory?.summary, draft.storyMemory.summary);
        return [{id: 'chop', type: 'action' as const, text: 'Chop nearly through the tree'}, {id: 'look', type: 'action' as const, text: 'Examine the bank'}];
      }
      protected override async reviewSceneChoices() { return {anchorChoiceIndex: 0, unusableChoiceIndexes: [], unusableChoicesReason: '', reason: 'Tree is in reach.'}; }
    }
    const probe = new Probe({provider: 'openai', model: 'test', async createResponse(request) {
      if (request.text?.format.name === "bookrpg_canonical_scene_review") return acceptedCanonicalReview(request);
        if (JSON.parse(request.input).review_mode?.startsWith('Check the unchanged')) return needsSetup();
      const name = request.text!.format.name; names.push(name);
      if (name === 'bookrpg_single_beat_scene') return reply({text: scene.text});
      if (name === 'bookrpg_canonical_rewrite') return reply({...scene, choices: undefined, outcome: 'active', outcomeReason: 'The journey continues.'});
      if (name === 'bookrpg_source_event_entry') return reply(draft);
      if (name === 'bookrpg_source_event_entry_review') return reply(Object.fromEntries(checks.map(k => [k, {supported: !(rejectEntry && k === 'nextEventUnperformed'), reason: 'Evidence check.'}])));
      throw Error('Unexpected call: ' + name);
    }});
    const before = structuredClone(fullState), previousReview = process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
    process.env.BOOKRPG_SCENE_CONTENT_REVIEW = 'false';
    try {
      if (rejectEntry) {
        await assert.rejects(() => probe.generate(), /nextEventUnperformed/);
        assert.deepEqual(probe.menus, []);
      } else {
        const output = await probe.generate();
        assert.deepEqual(probe.menus, [draft.sceneScope.currentLocation]);
        assert.equal(output.sourceProgress?.eventId, 'first');
        assert.equal(output.sourceEventProgress, null);
        assert.equal(output.choices[0]?.sourceEventId, 'tree');
      }
      assert.deepEqual(fullState, before);
      assert.equal(names.filter(n => n === 'bookrpg_source_event_entry_review').length, 1);
    } finally {
      if (previousReview === undefined) delete process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
      else process.env.BOOKRPG_SCENE_CONTENT_REVIEW = previousReview;
    }
  }
});

test('entry prompts distinguish source-backed axe possession from performing the next chopping action', async () => {
  const axeCandidate = structuredClone(candidate);
  axeCandidate.sourceEventEntries!.tree!.entryExcerpt =
    'Here is a great tree, standing close to the ditch. If the Tin Woodman can chop it down, we can walk across it. '
    + 'The Woodman set to work at once, and so sharp was his axe that the tree was soon chopped nearly through.';
  axeCandidate.storyEvents![1]!.beats![0]!.playerAction = {
    preconditions: ['A suitable tree stands beside the gulf.', 'The axe is available.'],
  } as NonNullable<NonNullable<BookStoryEvent['beats']>[number]['playerAction']>;
  const before = structuredClone(scene);
  const labels: string[] = [];
  const output = await establishSourceEventEntry({...state, playerName: 'Cowardly Lion'}, scene, axeCandidate, 'first', 'test', async (label, request) => {
    labels.push(label);
    const context = JSON.parse(request.input);
    assert.deepEqual(context.next_event.entry_preconditions, ['A suitable tree stands beside the gulf.', 'The axe is available.']);
    assert.match(context.entry_action_source, /his axe/);
    assert.match(request.instructions!, /already has the axe/);
    assert.match(request.instructions!, /does not authorize chopping/);
    assert.match(request.instructions!, /later acquisition, retrieval, repair, transfer or action result does NOT establish availability/);
    if (label === 'source event entry') return reply(draft);
    // The logged failure omitted the axe from the appended prose. Review must
    // consider static source evidence too, without requiring chopping to occur.
    assert.doesNotMatch(context.candidate_transition.text, /axe|chop/);
    assert.match(request.instructions!, /combined accepted_scene_history, current_scene, candidate_transition \(including memory\), entry_source and static starting facts in entry_action_source/);
    assert.match(request.instructions!, /need not be restated in candidate_transition/);
    return reply(Object.fromEntries(checks.map(k => [k, {supported: true, reason: 'Static axe possession is supported; chopping remains future.'}])));
  });
  assert.deepEqual(labels, ['source event entry', 'source event entry review']);
  assert.equal(output.text, scene.text + '\n\n' + draft.text);
  assert.deepEqual(scene, before);
});

test('source-backed possession cannot override an established missing axe', async () => {
  const withoutAxe = {...scene, storyMemory: {...memory, canonFacts: [...memory.canonFacts, 'The axe was lost in the first gulf.']}};
  const before = structuredClone(withoutAxe);
  await assert.rejects(() => establishSourceEventEntry(state, withoutAxe, candidate, 'first', 'test', async (label, request) => {
    assert.match(JSON.parse(request.input).current_scene.storyMemory.canonFacts.join(' '), /axe was lost/);
    assert.match(request.instructions!, /Never restore an object that current state says is lost, destroyed or inaccessible/);
    return label === 'source event entry' ? reply(draft) : reply(Object.fromEntries(checks.map(k => [k, {
      supported: k !== 'entryReady', ...(k === 'visibleCause' ? {causeStatus:'not_required'} : {}), reason: k === 'entryReady' ? 'The axe is lost; it cannot be assumed available.' : 'Supported.',
    }])));
  }), /entryReady.*axe is lost/);
  assert.deepEqual(withoutAxe, before);
});

test('production folds the next beat prelude into the canonical rewrite before its menu', async () => {
  const crossing = {...book.storyEvents![0]!, eventId: 'bridge', beats: [
    {actor: 'Dorothy', action: 'Crosses the tree with Toto.', resultingState: 'Dorothy and Toto are across; Lion remains on the original bank.', agency: 'intentional', stakes: 'critical', targets: ['Toto'], sourceReferences: []},
    {actor: 'Cowardly Lion', action: 'Roars at the approaching Kalidahs and crosses the bridge.', resultingState: 'Lion is across.', agency: 'intentional', stakes: 'critical', targets: ['Kalidahs'], sourceReferences: [],
      automaticPreludeSourceExcerpt: 'The tree fell across the gulf. As Dorothy crossed with Toto, a growl made them look up. Two Kalidahs ran toward the bridge.',
      automaticPreludeEndState: 'Dorothy is across.',
    },
  ]};
  const cs = [{chapterPosition: 0, chapterTitle: 'Bridge', summary: 'Crossing', excerpt: '', nextTextOffset: 50,
    requiredEvent: crossing.description, requiredEventId: 'bridge', requiredEventBeats: crossing.beats,
    currentStoryEvent: crossing, storyEvents: [crossing]}] as unknown as SourceContinuationCandidate[];
  const fullState = {...state, playerName: 'Cowardly Lion', gameId: 'beat-entry', book: {bookId: 'oz', title: 'Oz'},
    gameProfile: {category: 'adventure', endingMode: 'open_ended', description: 'Journey'}, objective: 'Find Oz', victoryCondition: 'Reach Oz',
    status: 'active', selectedText: '', history: [], createdAt: 'now', updatedAt: 'now', turnNumber: 1,
    scene: {...scene, text: 'A tree lies across the gulf.'}} as GameState;
  const afterCrossing = {...scene, text: 'Dorothy has crossed. I wait on the original bank.'};
  const setupText = 'A growl makes me turn. Two Kalidahs are running toward our bank.';
  const setupScope = {...scope, peoplePresent: [...scope.peoplePresent, 'Kalidahs']};
  const setupMemory = {...memory, summary: 'The Kalidahs approach Lion on the original bank.'};
  const labels: string[] = [];
  class Probe extends TurnPipelineGameEngine {
    menus = 0;
    generate() { return this.scene('Continue', fullState, undefined, cs, 1, 'observed_scene_progression', true); }
    protected override async sceneChoices(...args: Parameters<TurnPipelineGameEngine['sceneChoices']>) {
      this.menus++;
      assert.equal(labels.at(-1), 'bookrpg_next_decision_readiness');
      assert.match(args[0].text, /Two Kalidahs/);
      assert.equal(args[1].storyMemory?.summary, setupMemory.summary);
      assert.deepEqual(args[1].sourceEventProgress?.completedBeatIndexes, [0]);
      return [{id: 'roar', type: 'action' as const, text: 'Roar at the Kalidahs'}, {id: 'look', type: 'action' as const, text: 'Look at the bridge'}];
    }
    protected override async reviewSceneChoices() { throw Error('Canonical choice review must not run'); }
  }
  const probe = new Probe({provider: 'openai', model: 'test', async createResponse(request) {
    const name = request.text!.format.name; labels.push(name);
    const input = JSON.parse(request.input);
    if (name === 'bookrpg_single_beat_scene') return reply({text: afterCrossing.text});
    if (name === 'bookrpg_next_decision_setup') {
      assert.match(input.source_excerpt, /Two Kalidahs/);
      assert.match(input.next_decision.action, /Roars at the approaching Kalidahs/);
      assert.deepEqual(input.completed_actions.map((b: {beat_index: number}) => b.beat_index), [0]);
      return reply({text: setupText});
    }
    if (name === 'bookrpg_canonical_rewrite') {
      assert.equal(input.next_decision_setup_scaffold, setupText);
      assert.match(request.instructions!, /MUST appear/);
      return reply({...afterCrossing, text: afterCrossing.text + '\n\n' + setupText,
        sceneScope: setupScope, storyMemory: setupMemory, choices: undefined, outcome: 'active', outcomeReason: 'Journey continues.'});
    }
    if (name === 'bookrpg_next_decision_readiness') {
      assert.equal(probe.menus, 0);
      assert.equal(input.pending_decision.entry_action.action, crossing.beats[1]!.action);
      assert.equal(input.pending_decision.source_beat_index, 1);
      assert.equal(input.candidate_scene.text, afterCrossing.text + '\n\n' + setupText);
      const quote = 'Two Kalidahs are running toward our bank.';
      assert.ok(input.candidate_scene.text.includes(quote));
      return reply({status: 'pass', reason: 'The visible approaching Kalidahs motivate the still-unperformed roar.',
        causeStatus: 'present', cause: 'Two Kalidahs are running toward the Lion on the original bank.',
        nextActionUnperformed: true, evidence: [{source: 'candidate_scene', sceneIndex: null, quote}]});
    }
    throw Error('Unexpected call ' + name);
  }});
  const oldReview = process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
  process.env.BOOKRPG_SCENE_CONTENT_REVIEW = 'false';
  try {
    const result = await probe.generate();
    assert.equal(probe.menus, 1);
    assert.deepEqual(result.sourceEventProgress?.completedBeatIndexes, [0]);
    assert.equal(result.sourceProgress, undefined);
    assert.match(result.text, /Two Kalidahs/);
    assert.deepEqual(labels.sort(), ['bookrpg_canonical_rewrite','bookrpg_next_decision_setup','bookrpg_single_beat_scene','bookrpg_next_decision_readiness'].sort());
  } finally {
    if (oldReview === undefined) delete process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
    else process.env.BOOKRPG_SCENE_CONTENT_REVIEW = oldReview;
  }
});

test('beat entry skips terminal scenes, absent evidence and automatic beats without jumping ahead', async () => {
  const lionState = {...state, playerName: 'Cowardly Lion'};
  const playerBeat = {actor: 'Cowardly Lion', action: 'Roar', agency: 'intentional', stakes: 'critical', targets: [], sourceReferences: [], automaticPreludeSourceExcerpt: 'Two beasts approach.'} as const;
  const cases = [
    {scene: {...scene, outcome: 'completed' as const}, beats: [playerBeat]},
    {scene, beats: [{...playerBeat, automaticPreludeSourceExcerpt: ''}]},
    {scene, beats: [{...playerBeat, actor: 'Dorothy'}, playerBeat]},
  ];
  for (const c of cases) {
    const output = await establishSourceBeatEntry(lionState, c.scene, candidate,
      {...book.storyEvents![0]!, beats: c.beats} as unknown as BookStoryEvent, [], 0, 'test', async () => {throw Error('Unexpected entry call');});
    assert.equal(output, c.scene);
  }
});

test('silent shame remains compatible with an unperformed admission; actual confession is still rejected', async () => {
  const lionState = {...state, playerName: 'Cowardly Lion'};
  const confession = {...book.storyEvents![0]!, beats: [{
    actor: 'Cowardly Lion', action: 'Admits that he is a coward and ashamed of threatening Toto.',
    agency: 'intentional', stakes: 'significant', targets: ['Dorothy'], sourceReferences: [],
    automaticPreludeSourceExcerpt: 'Dorothy rebuked the Lion. He stood ashamed and silent before her.',
  }]} as unknown as BookStoryEvent;
  const before = {...scene, text: 'Dorothy stopped my attack.', storyMemory: {
    summary: 'Dorothy rebuked Lion.', openThreads: [], canonFacts: ['Lion has not yet expressed his shame.'],
  }};
  for (const spoken of [false, true]) {
    const transition = {...draft,
      text: spoken ? 'I told Dorothy that I was a coward and ashamed of threatening Toto.' : 'I stood ashamed and silent before Dorothy.',
      storyMemory: before.storyMemory,
    };
    const labels: string[] = [];
    const run = () => establishSourceBeatEntry(lionState, before, candidate, confession, [], 0, 'test', async (label, request) => {
      labels.push(label);
      assert.match(request.instructions!, /Feeling afraid or ashamed.*does not by itself perform an admission/);
      assert.match(request.instructions!, /feeling shame and not yet expressing shame are compatible facts/);
      assert.match(request.instructions!, /First-person narration of a feeling is not automatically in-world speech/);
      assert.match(request.instructions!, /Explicit dialogue or narration.*does count as execution/);
      assert.match(request.instructions!, /pending beat is itself an inner realization or decision/);
      assert.match(request.instructions!, /Inner states still require source or established-state support/);
      if (label === 'source beat entry') return reply(transition);
      const context = JSON.parse(request.input);
      assert.equal(context.candidate_transition.text, transition.text);
      assert.deepEqual(context.candidate_transition.storyMemory.canonFacts, ['Lion has not yet expressed his shame.']);
      return reply(Object.fromEntries(checks.map(k => [k, {
        supported: !(spoken && ['playerAgency', 'nextEventUnperformed', 'storyMemory'].includes(k)),
        reason: spoken ? 'Lion explicitly told Dorothy; the confession was performed.' : 'Silent emotion is not an expressed admission.',
      }])));
    });
    if (spoken) await assert.rejects(run, /confession was performed/);
    else {
      const output = await run();
      assert.equal(output.text, before.text + '\n\n' + transition.text);
      assert.deepEqual(output.storyMemory, before.storyMemory);
      assert.equal('sourceEventProgress' in output, false);
    }
    assert.deepEqual(labels, ['source beat entry', 'source beat entry review']);
  }
});

for (const failed of [['sceneScope'], ['repetition'], ['sceneScope', 'repetition']]) {
  test(`repair ${failed.join('+')} preserves pending admission memory exactly`, async () => {
    const frozen = {summary: 'Lion has not confessed.', openThreads: ['Whether Lion will admit cowardice'], canonFacts: ['Lion has not yet admitted cowardice.']};
    const prior = {...scene, storyMemory: frozen};
    const transition = {...draft, storyMemory: frozen};
    let reviews = 0, repairs = 0;
    const output = await establishSourceEventEntry(state, prior, candidate, 'first', 'test', async (label, request) => {
      if (label === 'source event entry') return reply(transition);
      const context = JSON.parse(request.input);
      assert.deepEqual(context.candidate_transition.storyMemory, frozen);
      if (label.endsWith('presentation repair')) {
        repairs++;
        assert.deepEqual(context.repair_fields, failed.map(k => k === 'sceneScope' ? 'sceneScope' : 'text'));
        const properties = (request.text!.format.schema as any).properties;
        assert.equal(properties.storyMemory, undefined);
        return reply(Object.fromEntries(context.repair_fields.map((k: string) => [k, k === 'text' ? '' : scope])));
      }
      reviews++;
      return reply(Object.fromEntries(checks.map(k => [k, {supported: reviews > 1 || !failed.includes(k), reason: 'Check exact field.'}])));
    });
    assert.deepEqual(output.storyMemory, frozen);
    assert.deepEqual(prior.storyMemory, frozen);
    assert.equal(output.text, failed.includes('repetition') ? prior.text : prior.text + '\n\n' + transition.text);
    assert.deepEqual(output.sceneScope, failed.includes('sceneScope') ? scope : transition.sceneScope);
    assert.equal(repairs, 1); assert.equal(reviews, 2);
  });
}

test('a true memory error is reported without automatic memory rewriting', async () => {
  const labels: string[] = [];
  await assert.rejects(() => establishSourceEventEntry(state, scene, candidate, 'first', 'test', async label => {
    labels.push(label);
    if (label === 'source event entry') return reply(draft);
    return reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'storyMemory', reason: 'Pending admission was marked completed.'}])));
  }), /storyMemory: Pending admission was marked completed/);
  assert.deepEqual(labels, ['source event entry', 'source event entry review']);
});

test('presentation repair cannot smuggle in a memory update', async () => {
  const before = structuredClone(scene);
  await assert.rejects(() => establishSourceEventEntry(state, scene, candidate, 'first', 'test', async label => {
    if (label === 'source event entry') return reply(draft);
    if (label.endsWith('presentation repair')) return reply({sceneScope: scope, storyMemory: {summary: 'Lion confessed.', openThreads: [], canonFacts: []}});
    return reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'sceneScope', reason: 'Tin Woodman is missing from speaking distance.'}])));
  }), /Invalid source entry presentation repair/);
  assert.deepEqual(scene, before);
});

const aidScope = {currentLocation: 'the road', peoplePresent: ['Cowardly Lion', 'Dorothy', 'Scarecrow', 'Tin Woodman', 'Toto'],
  peopleWithinSpeakingDistance: ['Cowardly Lion', 'Dorothy', 'Scarecrow', 'Tin Woodman', 'Toto']};
const aidMemory = {summary: 'The Lion admitted his cowardice. The travelers remain on the road.', openThreads: [],
  canonFacts: ['The Scarecrow lies at the roadside.', 'The Tin Woodman lies on the road.', 'Dorothy stands before the Lion.']};
const aidScene = {title: 'The Lion Speaks Plainly', text: 'I stood before Dorothy and admitted my cowardice. The Scarecrow lay at the roadside, and the Tin Woodman lay on the road.',
  choices: [], sceneScope: aidScope, storyMemory: aidMemory};
const aidState = {...state, playerName: 'Cowardly Lion', scene: aidScene};
const aidGroup = {kind: 'player_action' as const, choiceText: 'Help the fallen companions.', completion: 'Both companions are standing.',
  boundaryReason: 'One recovery goal.', playerBeatIndexes: [0], endBeatIndex: 0,
  preconditions: ['The Scarecrow and Tin Woodman are within reach.'], interruptWhen: ['A companion cannot be approached.']};
const aidEvent = {...event('aid', 2, 48), beats: [{actor: 'Dorothy', action: 'Picks up the Scarecrow, pats him into shape, and helps the Tin Woodman up.',
  targets: ['Scarecrow', 'Tin Woodman'], agency: 'intentional' as const, stakes: 'significant' as const, sourceReferences: [ref(48, 57)], playerAction: aidGroup}]};
const aidCandidate = {storyEvents: [aidEvent], sourceEventEntries: {aid: {fromEventId: 'confession', excerpt: 'Dorothy rebuked the Lion for striking the stuffed man.',
  entryExcerpt: 'Dorothy picked up the Scarecrow and set him on his feet. Then she helped the Woodman up.'}}} as SourceContinuationCandidate;

test('logged Lion transition assesses Dorothy starting aid, without asserting simultaneous touch distance', async () => {
  const before = structuredClone(aidScene), labels: string[] = [];
  const output = await establishSourceEventEntry(aidState, aidScene, aidCandidate, 'confession', 'test', async (label, request) => {
    labels.push(label);
    const input = JSON.parse(request.input), entry = input.next_event.entry_action;
    assert.equal(input.player, 'Cowardly Lion'); assert.equal(entry.actor, 'Dorothy');
    assert.equal(entry.requiresPlayerDecision, false);
    assert.equal(entry.readiness, 'begin_first_step');
    assert.deepEqual(entry.targets, ['Scarecrow', 'Tin Woodman']);
    assert.deepEqual(entry.goal.playerBeatIndexes, [0]);
    assert.deepEqual(input.next_event.entry_preconditions, aidGroup.preconditions);
    assert.match(request.instructions!, /not necessarily the actor/);
    assert.match(request.instructions!, /do not require all targets to be simultaneously within hand reach/);
    assert.match(request.instructions!, /do not perform it in this transition/);
    assert.match(request.instructions!, /memory-only assertion cannot establish movement/);
    if (label === 'source event entry') return reply({text: '', sceneScope: aidScope, storyMemory: aidMemory});
    assert.deepEqual(input.candidate_transition.storyMemory, aidMemory);
    return reply(Object.fromEntries(checks.map(k => [k, {supported: true, reason: 'Dorothy can begin local aid; nobody is lifted or asserted to be at touch distance yet.'}])));
  });
  assert.deepEqual(output, before); assert.deepEqual(aidScene, before);
  assert.deepEqual(labels, ['source event entry', 'source event entry review']);
});

test('local approach never bypasses an established gulf, restraint or locked access', async () => {
  for (const obstacle of ['A gulf separates Dorothy from the Scarecrow.', 'Dorothy is bound and cannot move.', 'The Woodman is behind a locked gate.']) {
    const blocked = {...aidScene, storyMemory: {...aidMemory, canonFacts: [...aidMemory.canonFacts, obstacle]}};
    const before = structuredClone(blocked); let calls = 0;
    await assert.rejects(establishSourceEventEntry(aidState, blocked, aidCandidate, 'confession', 'test', async (label, request) => {
      calls++;
      assert.match(request.instructions!, /Existing barriers, separate banks, locked access, restraints/);
      assert.ok(JSON.parse(request.input).current_scene.storyMemory.canonFacts.includes(obstacle));
      if (label === 'source event entry') return reply({text: '', sceneScope: aidScope, storyMemory: blocked.storyMemory});
      return reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'entryReady', ...(k === 'visibleCause' ? {causeStatus:'not_required'} : {}), reason: obstacle}])));
    }), /entryReady/);
    assert.equal(calls, 2); assert.deepEqual(blocked, before);
  }
});

test('possible local approach does not excuse the logged unsupported reachability memory addition', async () => {
  const before = structuredClone(aidScene); let calls = 0;
  await assert.rejects(establishSourceEventEntry(aidState, aidScene, aidCandidate, 'confession', 'test', async (label, request) => {
    calls++;
    if (label === 'source event entry') return reply({text: '', sceneScope: aidScope, storyMemory: {...aidMemory, canonFacts: [...aidMemory.canonFacts, 'Both companions are within reach.']}});
    assert.match(request.instructions!, /Never approve an invented memory fact/);
    return reply(Object.fromEntries(checks.map(k => [k, {supported: !['sourceSupport', 'continuity', 'storyMemory'].includes(k), reason: 'Touch distance was invented in memory.'}])));
  }), /Touch distance was invented/);
  assert.equal(calls, 2); assert.deepEqual(aidScene, before);
});

test('same-event entry uses the pending actor and active character group conditions', async () => {
  const lionBeat = {...aidEvent.beats[0]!, actor: 'Cowardly Lion', action: 'Offers to help the Scarecrow.',
    automaticPreludeSourceExcerpt: 'Dorothy asks whether the Lion will help.',
    characterActionGroup: {...aidGroup, preconditions: ['Dorothy has asked for help.']}};
  const sameEvent = {...aidEvent, beats: [lionBeat]}; let calls = 0;
  await establishSourceBeatEntry(aidState, aidScene, aidCandidate, sameEvent, [], 0, 'test', async (label, request) => {
    calls++;
    const input = JSON.parse(request.input);
    assert.equal(input.next_event.entry_action.actor, 'Cowardly Lion');
    assert.equal(input.next_event.entry_action.requiresPlayerDecision, true);
    assert.deepEqual(input.next_event.entry_preconditions, ['Dorothy has asked for help.']);
    if (label === 'source beat entry') return reply({text: 'Dorothy asked whether I would help.', sceneScope: aidScope, storyMemory: aidMemory});
    return reply(Object.fromEntries(checks.map(k => [k, {supported: true, reason: 'The question is visible; the offer remains unperformed.'}])));
  });
  assert.equal(calls, 2);
});

const admissionScene = {...aidScene, text: 'Dorothy faces me after stopping my attack. I have not yet answered her.',
  storyMemory: {...aidMemory, summary: 'Dorothy stopped the attack. The Lion has not answered her.'}};
const admissionEvent = {...aidEvent, beats: [{...aidEvent.beats[0]!, actor: 'Cowardly Lion', action: 'Admits his cowardice.',
  automaticPreludeSourceExcerpt: 'Dorothy confronted the Lion after stopping him.', playerAction: {...aidGroup, choiceText: 'Admit cowardice.', preconditions: ['Dorothy is confronting the Lion.']}}]};
const unsupportedGesture = {text: 'I lowered my head beneath Dorothy’s gaze.', sceneScope: aidScope,
  storyMemory: {...aidMemory, summary: 'The Lion faces Dorothy, ready to speak.'}};
const gestureVerdict = Object.fromEntries(checks.map(k => [k, {supported: !['sourceSupport', 'continuity'].includes(k), reason: 'The head-lowering gesture is unsupported; the admission can already begin.'}]));

test('unsupported embellishment can be discarded only after all checks approve the unchanged scene', async () => {
  const prior = structuredClone(admissionScene), calls: string[] = [];
  const result = await establishSourceBeatEntry(aidState, prior, aidCandidate, admissionEvent, [], 0, 'test', async (label, request) => {
    calls.push(label);
    if (label === 'source beat entry') return reply(unsupportedGesture);
    if (label === 'source beat entry review') return reply(gestureVerdict);
    assert.equal(label, 'source beat entry unchanged scene review');
    const input = JSON.parse(request.input);
    assert.deepEqual(input.candidate_transition, {text: '', sceneScope: prior.sceneScope, storyMemory: prior.storyMemory});
    assert.match(input.review_mode, /without any part of the rejected transition/);
    assert.deepEqual(Object.keys((request.text!.format.schema as any).properties), checks);
    return reply(Object.fromEntries(checks.map(k => [k, {supported: true, reason: 'The original scene is already ready; no gesture or new memory is needed.'}])));
  });
  assert.equal(result, prior);
  assert.deepEqual(prior, admissionScene);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(result.text, /lowered my head/);
  assert.deepEqual(result.storyMemory, admissionScene.storyMemory);
});

test('discarding a gesture cannot discard necessary setup without a fresh rejection', async () => {
  let calls = 0;
  await assert.rejects(establishSourceBeatEntry(aidState, admissionScene, aidCandidate, admissionEvent, [], 0, 'test', async (label, request) => {
    calls++;
    if (label === 'source beat entry') return reply(unsupportedGesture);
    if (label === 'source beat entry review') return reply(gestureVerdict);
    assert.equal(JSON.parse(request.input).candidate_transition.text, '');
    return reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'entryReady', ...(k === 'visibleCause' ? {causeStatus:'not_required'} : {}), reason: 'A required question is still missing from the original scene.'}])));
  }), /unchanged scene entryReady.*required question/);
  assert.equal(calls, 3);
});

test('memory, agency and unfinished-setup rejections cannot trigger the unchanged-scene fallback', async () => {
  for (const failure of ['storyMemory', 'playerAgency', 'nextEventUnperformed', 'entryReady']) {
    let calls = 0;
    await assert.rejects(establishSourceBeatEntry(aidState, admissionScene, aidCandidate, admissionEvent, [], 0, 'test', async label => {
      calls++;
      if (label === 'source beat entry') return reply(unsupportedGesture);
      return reply({...gestureVerdict, [failure]: {supported: false, reason: 'A substantive failure remains.'}});
    }), /A substantive failure remains/);
    assert.equal(calls, 2);
  }
});

test('scope-classified readiness failure reconciles speaking distance, preserving question and memory', async () => {
  const staleScope = {...aidScope, peopleWithinSpeakingDistance: ['Cowardly Lion', 'Dorothy', 'Toto']};
  const prior = {...aidScene, text: 'The Scarecrow and Woodman stand next to Dorothy before me.', sceneScope: staleScope};
  const transition = {text: 'Dorothy asks why I am a coward.', sceneScope: staleScope, storyMemory: aidMemory};
  let reviews = 0, repairs = 0;
  const output = await establishSourceBeatEntry(aidState, prior, aidCandidate, admissionEvent, [], 0, 'test', async (label, request) => {
    if (label === 'source beat entry') return reply(transition);
    const input = JSON.parse(request.input);
    if (label.endsWith('presentation repair')) {
      repairs++;
      assert.deepEqual(input.repair_fields, ['sceneScope']);
      assert.match(request.instructions!, /Change ONLY peopleWithinSpeakingDistance/);
      assert.deepEqual(input.candidate_transition.storyMemory, aidMemory);
      return reply({sceneScope: aidScope});
    }
    reviews++;
    assert.match(request.instructions!, /Speaking distance is not proof of attention/);
    assert.ok(request.instructions!.includes(CONVERSATIONAL_REACH_POLICY));
    return reply(Object.fromEntries(checks.map(k => [k, {supported: reviews > 1 || k !== 'entryReady', reason: 'Prose supports conversational proximity; scope list omits the companions.', ...(k === 'entryReady' ? {repairTarget: reviews > 1 ? 'none' : 'sceneScope'} : {})}])));
  });
  assert.equal(reviews, 2); assert.equal(repairs, 1);
  assert.equal(output.text, prior.text + '\n\n' + transition.text);
  assert.deepEqual(output.storyMemory, aidMemory);
  assert.deepEqual(output.sceneScope, aidScope);
  assert.deepEqual(prior.sceneScope, staleScope);
});

test('scope reconciliation cannot silently relocate characters to satisfy readiness', async () => {
  await assert.rejects(establishSourceBeatEntry(aidState, aidScene, aidCandidate, admissionEvent, [], 0, 'test', async label => {
    if (label === 'source beat entry') return reply({text: '', sceneScope: aidScope, storyMemory: aidMemory});
    if (label.endsWith('presentation repair')) return reply({sceneScope: {...aidScope, currentLocation: 'across the gulf'}});
    return reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'entryReady', ...(k === 'visibleCause' ? {causeStatus:'not_required'} : {}), reason: 'Missing conversational access.', ...(k === 'entryReady' ? {repairTarget: 'sceneScope'} : {})}])));
  }), /changed location or presence/);
});

test('unsuccessful scope reconciliation still fails full review and does not loop', async () => {
  let calls = 0;
  await assert.rejects(establishSourceBeatEntry(aidState, aidScene, aidCandidate, admissionEvent, [], 0, 'test', async label => {
    calls++;
    if (label === 'source beat entry') return reply({text: '', sceneScope: aidScope, storyMemory: aidMemory});
    if (label.endsWith('presentation repair')) return reply({sceneScope: aidScope});
    return reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'entryReady', ...(k === 'visibleCause' ? {causeStatus:'not_required'} : {}), reason: 'The audience cannot hear the speaker.', ...(k === 'entryReady' ? {repairTarget: 'sceneScope'} : {})}])));
  }), /entryReady.*cannot hear/);
  assert.equal(calls, 4);
});

test('optional source reply is not a required bridge when Dorothy can already begin helping', async () => {
  const before = structuredClone(aidScene); let calls = 0;
  const output = await establishSourceEventEntry(aidState, aidScene, aidCandidate, 'confession', 'test', async (label, request) => {
    calls++;
    assert.match(request.instructions!, /not a checklist of dialogue/);
    assert.match(request.instructions!, /exact source wording and every conversational turn are not required/);
    if (label === 'source event entry') return reply({text: '', sceneScope: aidScope, storyMemory: aidMemory});
    assert.match(request.instructions!, /NOT whether the entire source passage was narrated/);
    const schema = (request.text!.format.schema as any).properties;
    assert.match(schema.sourceSupport.description, /Optional omitted dialogue is not a failure/);
    assert.match(schema.entryReady.description, /necessary visible cause/);
    return reply(Object.fromEntries(checks.map(k => [k, {supported: true, reason: 'Dorothy can begin helping without another remark; no facts have been added.', ...(k === 'entryReady' ? {repairTarget: 'none'} : {})}])));
  });
  assert.equal(calls, 2); assert.deepEqual(output, before); assert.deepEqual(aidScene, before);
});

test('minimum setup still blocks replying to an unseen question or accusation', async () => {
  const questionEvent = {...admissionEvent, beats: [{...admissionEvent.beats[0]!,
    action: 'Answers Dorothy’s question about why he is a coward.',
    automaticPreludeSourceExcerpt: 'Dorothy asks what makes the Lion a coward.',
    playerAction: {...aidGroup, choiceText: 'Answer Dorothy’s question about your fear.', preconditions: ['Dorothy has asked why the Lion is a coward.']}}]};
  let calls = 0;
  await assert.rejects(establishSourceBeatEntry(aidState, admissionScene, aidCandidate, questionEvent, [], 0, 'test', async (label, request) => {
    calls++;
    assert.match(request.instructions!, /VISIBLE CAUSE/);
    assert.match(request.instructions!, /Hidden memory or future source text alone cannot replace/);
    if (label === 'source beat entry') return reply({text: '', sceneScope: aidScope, storyMemory: admissionScene.storyMemory});
    return reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'entryReady', ...(k === 'visibleCause' ? {causeStatus:'not_required'} : {}), reason: 'The choice explicitly answers a question that the player has not seen.', ...(k === 'entryReady' ? {repairTarget: 'none'} : {})}])));
  }), /entryReady.*question that the player has not seen/);
  assert.equal(calls, 2);
});

test('both original Dorothy/Lion causes are extracted and shown before the production menu', async () => {
  const fs = await import('node:fs/promises');
  const {sourcePreludeEvidence} = await import('../src/books/source-index/story-events.js');
  const fixture: ImportedBook = JSON.parse(await fs.readFile(new URL('./fixtures/oz-lion-visible-causes.json', import.meta.url), 'utf8'));
  for (const [eventIndex, pendingIndex, line, cause, answer, prose] of [
    [0, 3, 44, /You are nothing but a\s+big coward/, /I know it/, 'Dorothy faced me and called me a big coward.'],
    [1, 1, 69, /What makes you a coward/, /It’s a mystery/, 'Dorothy asked me what made me a coward.'],
  ] as const) {
    const fullEvent = structuredClone(fixture.storyEvents![eventIndex]!);
    const sourceLine = fixture.chapters[0]!.text.trim().split('\n')[line - 1]!;
    const old = sourcePreludeEvidence(fixture, fullEvent.beats!, pendingIndex);
    assert.doesNotMatch(old.excerpt ?? '', cause);
    fullEvent.beats![pendingIndex]!.sourceActionStart = {chapterPosition: 0, chapterIndex: 8, line, column: 0, quote: sourceLine};
    const evidence = sourcePreludeEvidence(fixture, fullEvent.beats!, pendingIndex);
    assert.match(evidence.excerpt!, cause);
    assert.doesNotMatch(evidence.excerpt!, answer);
    // Exercise the real canonical pipeline across this adjacent pair, with model
    // responses prescribed. This proves ordering, not live semantic reliability.
    const pair = {...fullEvent, beats: fullEvent.beats!.slice(pendingIndex - 1, pendingIndex + 1).map(b => ({...b,
      playerAction: undefined, characterActionGroup: undefined}))};
    Object.assign(pair.beats[1]!, {automaticPreludeSourceExcerpt: evidence.excerpt});
    const lionScope = {currentLocation: 'the road', peoplePresent: ['The Cowardly Lion', 'Dorothy', 'Toto', 'The Scarecrow', 'Tin Woodman'],
      peopleWithinSpeakingDistance: ['The Cowardly Lion', 'Dorothy', 'Toto', 'The Scarecrow', 'Tin Woodman']};
    const beforeScene = {...scene, text: 'Dorothy stood before me on the road.', sceneScope: lionScope,
      storyMemory: {summary: 'The travelers are on the road.', openThreads: [], canonFacts: []}};
    const cs = [{chapterPosition: 0, chapterTitle: 'Lion', summary: 'Conversation', excerpt: '', nextTextOffset: 50,
      requiredEvent: pair.description, requiredEventId: pair.eventId, requiredEventBeats: pair.beats,
      currentStoryEvent: pair, storyEvents: [pair]}] as SourceContinuationCandidate[];
    const fullState = {...state, playerName: 'The Cowardly Lion', gameId: 'visible-cause', book: {bookId: 'oz', title: 'Oz'},
      gameProfile: {category: 'adventure', endingMode: 'open_ended', description: 'Journey'}, objective: 'Find Oz', victoryCondition: 'Reach Oz',
      status: 'active', selectedText: '', history: [], createdAt: 'now', updatedAt: 'now', turnNumber: 1, scene: beforeScene} as GameState;
    for (const omitCause of [false, true]) {
      const labels: string[] = [];
      class Probe extends TurnPipelineGameEngine {
        menus = 0;
        generate() { return this.scene('Continue', fullState, undefined, cs, 1, 'observed_scene_progression', true); }
        protected override async sceneChoices(...args: Parameters<TurnPipelineGameEngine['sceneChoices']>) {
          this.menus++;
          assert.equal(labels.at(-1), 'bookrpg_next_decision_readiness');
          assert.ok(args[0].text.includes(prose));
          assert.doesNotMatch(args[0].text, answer);
          assert.deepEqual(args[1].sourceEventProgress?.completedBeatIndexes, [0]);
          return [{id: 'answer', type: 'action' as const, text: pair.beats[1]!.action},
            {id: 'wait', type: 'action' as const, text: 'Wait quietly.'}];
        }
        protected override async reviewSceneChoices() { throw Error('Canonical choice review must not run'); }
      }
      const probe = new Probe({provider: 'openai', model: 'test', async createResponse(request) {
        const name = request.text!.format.name; labels.push(name);
        const input = JSON.parse(request.input);
        if (name === 'bookrpg_single_beat_scene') return reply({text: beforeScene.text});
        if (name === 'bookrpg_next_decision_setup') {
          assert.match(input.source_excerpt, cause);
          assert.doesNotMatch(input.source_excerpt, answer);
          return reply({text: omitCause ? '' : prose});
        }
        if (name === 'bookrpg_canonical_rewrite') {
          assert.equal(input.next_decision_setup_scaffold, prose);
          return reply({...beforeScene, text: beforeScene.text + '\n\n' + prose,
            choices: undefined, outcome: 'active', outcomeReason: 'Continue.'});
        }
        if (name === 'bookrpg_next_decision_readiness') {
          assert.equal(omitCause, false);
          assert.equal(probe.menus, 0);
          assert.equal(input.pending_decision.entry_action.action, pair.beats[1]!.action);
          assert.equal(input.pending_decision.source_beat_index, 1);
          assert.match(input.pending_decision.source_setup.excerpt, cause);
          assert.doesNotMatch(input.pending_decision.source_setup.excerpt, answer);
          assert.ok(input.candidate_scene.text.includes(prose));
          assert.doesNotMatch(input.candidate_scene.text, answer);
          return reply({status: 'pass', reason: 'The substantive accusation or question is visible; the Lion has not answered.',
            causeStatus: 'present', cause: prose, nextActionUnperformed: true,
            evidence: [{source: 'candidate_scene', sceneIndex: null, quote: prose}]});
        }
        throw Error('Unexpected call: ' + name);
      }});
      const oldReview = process.env.BOOKRPG_SCENE_CONTENT_REVIEW, frozen = structuredClone(fullState);
      process.env.BOOKRPG_SCENE_CONTENT_REVIEW = 'false';
      try {
        if (omitCause) {
          await assert.rejects(probe.generate(), /Invalid next-decision setup/);
          assert.equal(probe.menus, 0);
        } else {
          const result = await probe.generate();
          assert.equal(probe.menus, 1);
          assert.deepEqual(result.sourceEventProgress?.completedBeatIndexes, [0]);
        }
        assert.equal(labels.filter(name => name === 'bookrpg_next_decision_readiness').length, omitCause ? 0 : 1);
        assert.deepEqual(fullState, frozen);
      } finally {
        if (oldReview === undefined) delete process.env.BOOKRPG_SCENE_CONTENT_REVIEW;
        else process.env.BOOKRPG_SCENE_CONTENT_REVIEW = oldReview;
      }
    }
  }
});

test('physical readiness cannot override missing visible cause for an ungrouped confession', async () => {
  const pending = {...admissionEvent, beats: [{...admissionEvent.beats[0]!,
    action: 'Admits that he is a coward.', playerAction: undefined, characterActionGroup: undefined,
    automaticPreludeSourceExcerpt: 'Dorothy said, “You are nothing but a big coward.”'}]};
  const before = structuredClone(admissionScene);
  await assert.rejects(establishSourceBeatEntry(aidState, admissionScene, aidCandidate, pending, [], 0, 'test', async (label, request) => {
    assert.deepEqual(JSON.parse(request.input).next_event.entry_action.indexedPreconditions, []);
    if (label === 'source beat entry') return reply({text: '', sceneScope: aidScope, storyMemory: admissionScene.storyMemory});
    assert.ok((request.text!.format.schema as any).required.includes('visibleCause'));
    assert.match(request.instructions!, /even when entryReady passes/);
    return reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'visibleCause',
      reason: k === 'visibleCause' ? 'The accusation is absent from visible prose.' : 'The Lion can speak; state remains unchanged.',
      ...(k === 'entryReady' ? {repairTarget: 'none'} : {})}])));
  }), /visibleCause.*absent from visible prose/);
  assert.deepEqual(admissionScene, before);
});

test('entry withholds later requests and still rejects future knowledge in open threads', async () => {
  const pending = {...admissionEvent, beats: [{...admissionEvent.beats[0]!,
    action: 'Explains why he fears danger.', automaticPreludeSourceExcerpt: 'Dorothy asked what made him a coward.'},
    {...admissionEvent.beats[0]!, actor: 'Dorothy', action: 'Requests that Oz send her home.'}]};
  await assert.rejects(establishSourceBeatEntry(aidState, admissionScene, aidCandidate, pending, [], 0, 'test', async (label, request) => {
    assert.deepEqual(JSON.parse(request.input).next_event.actions, [{actor: pending.beats[0]!.actor, action: 'Explains why he fears danger.'}]);
    assert.match(request.instructions!, /summary, canonFacts and openThreads/);
    assert.match(request.instructions!, /waiting for a reply.*ordinary connective wording/);
    if (label === 'source beat entry') return reply({text: 'Dorothy asked what made me a coward. The companions waited for my answer.',
      sceneScope: aidScope, storyMemory: {...admissionScene.storyMemory, openThreads: ['Dorothy will ask Oz to send her home.']}});
    return reply(Object.fromEntries(checks.map(k => [k, {supported: k !== 'storyMemory',
      reason: k === 'storyMemory' ? 'The future request is not established.' : 'Supported conversational setup.',
      ...(k === 'entryReady' ? {repairTarget: 'none'} : {})}])));
  }), /storyMemory.*new open thread/);
});

test('logged join opportunity skips generation and preserves scene and memory exactly', async () => {
  const fs = await import('node:fs/promises');
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/oz-lion-join-entry.json', import.meta.url), 'utf8'));
  const current = fixture.current_scene;
  const pending = {...admissionEvent, beats: [{...admissionEvent.beats[0]!, action: fixture.next_event.entry_action.action,
    automaticPreludeSourceExcerpt: fixture.entry_source}]};
  const before = structuredClone(current);
  let calls = 0;
  const result = await actualBeatEntry(aidState, current, aidCandidate, pending, [], 0, 'test', async (label, request) => {
    calls++;
    assert.equal(label, 'source beat entry preflight review');
    assert.match(request.instructions!, /SPONTANEOUS REQUESTS/);
    assert.match(request.instructions!, /Such a self-authored question is not an external prerequisite/);
    assert.match(request.instructions!, /someone else’s question or accusation still requires/);
    const context = JSON.parse(request.input);
    assert.equal(context.candidate_transition.text, '');
    assert.deepEqual(context.candidate_transition.storyMemory, before.storyMemory);
    assert.match(context.current_scene.text, /ask Oz/);
    return reply(Object.fromEntries(checks.map(k => [k, {supported: true, ...(k === 'visibleCause' ? {causeStatus:'present'} : {}), reason: 'The travelers have visibly stated their wishes; the Lion can ask to join without invented deliberation.', ...(k === 'entryReady' ? {repairTarget: 'none'} : {})}])));
  });
  assert.equal(calls, 1);
  assert.strictEqual(result, current);
  assert.deepEqual(current, before);
});

test('missing accusation in preflight generates setup and still requires full review', async () => {
  for (const omit of [false, true]) {
    const pending = {...admissionEvent, beats: [{...admissionEvent.beats[0]!,
      automaticPreludeSourceExcerpt: 'Dorothy called the Lion a coward.'}]};
    const calls: string[] = [];
    const generate = () => actualBeatEntry(aidState, admissionScene, aidCandidate, pending, [], 0, 'test', async (label, request) => {
      calls.push(label);
      if (label === 'source beat entry') {
        assert.match(JSON.parse(request.input).missing_setup.visibleCause, /accusation/);
        return reply({text: omit ? '' : 'Dorothy called me a coward.', sceneScope: aidScope, storyMemory: admissionScene.storyMemory});
      }
      const missing = label.endsWith('preflight review') || omit;
      return reply(Object.fromEntries(checks.map(k => [k, {supported: !(missing && k === 'visibleCause'), ...(k === 'visibleCause' ? {causeStatus:missing?'missing':'present'} : {}),
        reason: missing ? 'The accusation is not visible.' : 'The accusation is visible; admission remains unperformed.',
        ...(k === 'entryReady' ? {repairTarget: 'none'} : {})}])));
    });
    if (omit) await assert.rejects(generate(), /visibleCause/);
    else assert.match((await generate()).text, /Dorothy called me a coward/);
    assert.deepEqual(calls, ['source beat entry preflight review', 'source beat entry', 'source beat entry review']);
  }
});

test('second gulf setup accepts optional source-supported Lion warning and its memory', async () => {
  const fs = await import('node:fs/promises');
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/oz-second-gulf-entry.json', import.meta.url), 'utf8'));
  const c = {...candidate, sourceEventEntries: {tree: {fromEventId:'first', excerpt:fixture.entry_source, entryExcerpt:fixture.entry_action_source}}};
  const s = {...state, playerName:'Cowardly Lion', scene:fixture.current_scene};
  for (const includeWarning of [false,true]) {
    const draft = includeWarning ? {...fixture.rejected_transition, storyMemory:{...fixture.rejected_transition.storyMemory,openThreads:fixture.current_scene.storyMemory.openThreads}} : {
      text:'After resting, we followed the road through the dark forest to a second gulf, too broad to leap. The Scarecrow pointed out a tree beside it and proposed using it as a bridge. The Tin Woodman stood nearby with his axe.',
      sceneScope:fixture.rejected_transition.sceneScope,
      storyMemory:{...fixture.current_scene.storyMemory, summary:'The company reached the second gulf. The Scarecrow proposed a tree bridge. The Woodman has his axe.',canonFacts:['The first gulf has been crossed.','A second gulf blocks the road; a tree stands beside it.','The Woodman has his axe.']},
    };
    const before = structuredClone(fixture.current_scene);
    const run = () => establishSourceEventEntry(s, fixture.current_scene, c, 'first','test',async(label,request)=>{
      assert.match(request.instructions!,/Source-supported connective player dialogue is allowed/);
      assert.match(request.instructions!,/summary\/canonFacts may remember that visibly spoken warning/);
      if(label==='source event entry') return reply(draft);
      return reply(Object.fromEntries(checks.map(k=>[k,{supported:true,reason:includeWarning?'Source-supported connective warning; no new decision or pending action performed.':'Travel and tree setup only; dialogue is optional.',...(k==='entryReady'?{repairTarget:'none'}:{})}])));
    });
    const output=await run();
    assert.match(output.text, /gulf/);
    if(includeWarning) {assert.ok(output.text.endsWith(draft.text));assert.match(JSON.stringify(output.storyMemory),/warned/);assert.deepEqual(output.storyMemory,draft.storyMemory);}
    else assert.doesNotMatch(JSON.stringify(output.storyMemory),/warned|admitted my fear/);
    assert.deepEqual(fixture.current_scene,before);
  }
});

test('patched first-gulf goal exposes boarding as execution, not entry, to runtime review', async () => {
  const fs = await import('node:fs/promises');
  const {applyEventPatch} = await import('../src/books/source-index/event-patch.js');
  const {rebuildSourcePreludes} = await import('../src/books/source-index/rebuild-preludes.js');
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/oz-gulf-action-phases.json', import.meta.url), 'utf8'));
  const patch = JSON.parse(await fs.readFile(new URL('./fixtures/repairs/oz-first-gulf.json', import.meta.url), 'utf8'));
  const repaired = rebuildSourcePreludes(applyEventPatch(fixture, patch, patch.eventId).book, patch.eventId).book;
  const event = repaired.storyEvents![0]!;
  const {sourcePreludeEvidence} = await import('../src/books/source-index/story-events.js');
  Object.assign(event.beats![1]!, {automaticPreludeSourceExcerpt: sourcePreludeEvidence(repaired, event.beats!, 1).excerpt});
  const scene = {...admissionScene, text:'The Scarecrow proposed crossing on my back. All of us stood on the original side. No one had boarded or crossed.',
    storyMemory:{summary:'The party is at the gulf; the Scarecrow has proposed crossing on the Lion.',openThreads:[],canonFacts:[]}};
  const frozen = structuredClone(scene);
  const calls: string[] = [];
  const result = await actualBeatEntry({...aidState, playerName:'The Cowardly Lion'}, scene, aidCandidate, event, [0], 1, 'test', async (label,request) => {
    calls.push(label);
    const c = JSON.parse(request.input);
    assert.match(request.instructions!, /passenger must be aboard before the jump, but need not be aboard before the player chooses/);
    assert.match(c.next_event.entry_action.goal.boundaryReason, /boarding/);
    assert.doesNotMatch(c.next_event.entry_action.indexedPreconditions.join(), /has mounted/);
    assert.match(c.next_event.entry_action.indexedPreconditions.join(), /available on the original side/);
    assert.equal(c.candidate_transition.text, '');
    return reply(Object.fromEntries(checks.map(k => [k,{supported:true,...(k==='visibleCause'?{causeStatus:'present'}:{}),reason:'The available passenger can board during the selected goal; the proposal is visible and boarding remains unperformed.',...(k==='entryReady'?{repairTarget:'none'}:{})}])));
  });
  assert.deepEqual(calls,['source beat entry preflight review']);
  assert.strictEqual(result,scene);
  assert.deepEqual(scene,frozen);
});

test('scope-only preflight adds nearby Toto without reopening approved narrative checks', async () => {
  const fs = await import('node:fs/promises');
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/oz-lion-join-entry.json', import.meta.url), 'utf8'));
  const current = fixture.current_scene;
  current.sceneScope.peopleWithinSpeakingDistance = current.sceneScope.peopleWithinSpeakingDistance.filter((n:string)=>n!=='Toto');
  const before = structuredClone(current);
  const pending = {...admissionEvent, beats:[{...admissionEvent.beats[0]!,action:fixture.next_event.entry_action.action,automaticPreludeSourceExcerpt:fixture.entry_source}]};
  const calls:string[]=[];
  const output=await actualBeatEntry(aidState,current,aidCandidate,pending,[],0,'test',async(label,request)=>{
    calls.push(label);
    if(label.endsWith('preflight review'))return reply(Object.fromEntries(checks.map(k=>[k,{supported:k!=='sceneScope',...(k==='visibleCause'?{causeStatus:'present'}:{}),reason:k==='sceneScope'?'Toto is visibly near Dorothy but omitted from speaking distance.':'The spontaneous joining request is ready.',...(k==='entryReady'?{repairTarget:'none'}:{})}])));
    const c=JSON.parse(request.input);
    assert.equal(c.next_event,undefined);
    assert.equal(c.entry_source,undefined);
    assert.equal(c.scene_text,before.text);
    if(label.endsWith('speaking distance repair'))return reply({peoplePresent:before.sceneScope.peoplePresent,peopleWithinSpeakingDistance:[...before.sceneScope.peopleWithinSpeakingDistance,'Toto']});
    assert.equal(label,'source beat entry speaking distance review');
    assert.deepEqual(c.proposed_scope.peoplePresent,before.sceneScope.peoplePresent);
    return reply({supported:true,reason:'Toto is beside Dorothy in the visible conversation.'});
  });
  assert.deepEqual(calls,['source beat entry preflight review','source beat entry speaking distance repair','source beat entry speaking distance review']);
  assert.equal(output.text,before.text);
  assert.deepEqual(output.storyMemory,before.storyMemory);
  assert.deepEqual(output.sceneScope?.peoplePresent,before.sceneScope.peoplePresent);
  assert.ok(output.sceneScope?.peopleWithinSpeakingDistance.includes('Toto'));
  assert.deepEqual(current,before);
});

test('speaking-distance repair cannot change narrative, remove approved reach, add absent people or bypass failed evidence',async()=>{
  const {repairEntrySpeakingDistance}=await import('../src/ai/engine/repair-entry-speaking-distance.js');
  const current={...admissionScene,text:'Dorothy is beside me. Toto is behind a closed door.',sceneScope:{...aidScope,peoplePresent:['Cowardly Lion','Dorothy','Toto'],peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy']}};
  for(const patch of [
    {peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy','Toto'],text:'Oz appeared.'},
    {peopleWithinSpeakingDistance:['Cowardly Lion']},
    {peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy','Oz']},
    {peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy','Toto']},
  ]){
    const before=structuredClone(current);
    await assert.rejects(repairEntrySpeakingDistance(current,'Toto missing.','test',async label=>{
      if(label.endsWith('repair'))return reply({peoplePresent:current.sceneScope.peoplePresent,...patch});
      return reply({supported:false,reason:'The closed door prevents established conversational reach.'});
    },'source beat entry'),/protected state|absent character|closed door/);
    assert.deepEqual(current,before);
  }
});

test('missing Kalidah setup and malformed cause assessments cannot skip generation', async () => {
  const current={...admissionScene,text:'Dorothy and Toto crossed the bridge. The others remained beside me.',storyMemory:{summary:'We are at the bridge.',openThreads:[],canonFacts:[]}};
  const pending={...admissionEvent,beats:[{...admissionEvent.beats[0]!,action:'Roar at the approaching Kalidahs.',automaticPreludeSourceExcerpt:'Two Kalidahs ran toward the bridge.'}]};
  for(const cause of [
    {supported:false,causeStatus:'missing',reason:'The approaching Kalidahs appear only in the source, not the scene.'},
    {supported:true,causeStatus:'missing',reason:'The approaching Kalidahs are absent.'},
    {supported:true,reason:'An imagined transition shows approaching Kalidahs.'},
    {supported:true,causeStatus:'unknown',reason:'Unclassified cause.'},
  ]){
    let generated=false;
    const result=await actualBeatEntry(aidState,current,aidCandidate,pending,[],0,'test',async(label,request)=>{
      if(label.endsWith('preflight review')) {
        assert.match(request.instructions!,/Never treat entry_source, hidden memory or an imagined addition/);
        assert.equal(JSON.parse(request.input).candidate_transition.text,'');
        return reply(Object.fromEntries(checks.map(k=>[k,k==='visibleCause'?cause:{supported:true,reason:'Other requirements satisfied.',...(k==='entryReady'?{repairTarget:'none'}:{})}])));
      }
      if(label==='source beat entry'){
        generated=true;
        assert.match(JSON.parse(request.input).missing_setup.visibleCause,/only in the source|semantic cause assessment/);
        return reply({text:'Two Kalidahs ran toward the bridge.',sceneScope:current.sceneScope,storyMemory:current.storyMemory});
      }
      return reply(Object.fromEntries(checks.map(k=>[k,{supported:true,reason:'The appended arrival is now visible; roar remains unperformed.',...(k==='entryReady'?{repairTarget:'none'}:{})}])));
    });
    assert.equal(generated,true);
    assert.match(result.text,/Two Kalidahs ran/);
  }
});

test('semantic preflight accepts a paraphrased accusation and an escort needing no new stimulus',async()=>{
  for(const scenario of [
    {text:'Dorothy rebuked me for picking on a little dog and called my behaviour cowardly.',action:'Admit that I am a coward.',causeStatus:'present',reason:'Dorothy has challenged the Lion’s courage; his admission responds to her rebuke.'},
    {text:'The Guardian opened the inner gate and our company followed him into the city.',action:'Continue following the Guardian to the Palace.',causeStatus:'not_required',reason:'The escort is already established; continuing it requires no new invitation or remark.'},
  ]){
    const current={...admissionScene,text:scenario.text};
    const before=structuredClone(current);
    const pending={...admissionEvent,beats:[{...admissionEvent.beats[0]!,action:scenario.action,automaticPreludeSourceExcerpt:'The company stood together.'}]};
    let calls=0;
    const output=await actualBeatEntry(aidState,current,aidCandidate,pending,[],0,'test',async(label,request)=>{
      calls++;
      assert.equal(label,'source beat entry preflight review');
      assert.match(request.instructions!,/No literal quotation or exact wording is required/);
      const schema=request.text!.format.schema as any;
      assert.deepEqual(schema.properties.visibleCause.properties.causeStatus.enum,['present','not_required','missing']);
      assert.equal(schema.properties.visibleCause.properties.evidenceQuotes,undefined);
      return reply(Object.fromEntries(checks.map(k=>[k,{supported:true,reason:scenario.reason,...(k==='visibleCause'?{causeStatus:scenario.causeStatus}:{}),...(k==='entryReady'?{repairTarget:'none'}:{})}])));
    });
    assert.equal(calls,1);
    assert.strictEqual(output,current);
    assert.deepEqual(current,before);
  }
});

test('setup schema excludes future farmhouse requests from openThreads',async()=>{
  const current={...admissionScene,storyMemory:{summary:'Travelers on the road.',canonFacts:[],openThreads:['Reach the Emerald City.']}};
  await assert.rejects(establishSourceEventEntry(aidState,current,candidate,'first','test',async(label,request)=>{
    assert.equal(label,'source event entry');
    const schema=request.text!.format.schema as any;
    assert.deepEqual(schema.properties.storyMemory.properties.openThreads.items.enum,['Reach the Emerald City.']);
    return reply({text:'A farmhouse stood beside the road.',sceneScope:current.sceneScope,storyMemory:{...current.storyMemory,openThreads:['Dorothy may ask for shelter.']}});
  }),/new open thread/);
});

test('connective dialogue permission still rejects a pending warning, confession or new commitment', async () => {
  for (const [action, text] of [
    ['Warn the travelers about the Kalidahs.', 'I warned the travelers about the Kalidahs.'],
    ['Admit cowardice to Dorothy.', 'I told Dorothy that I was a coward.'],
    ['Consider the route ahead.', 'I promised to protect everyone and chose the dangerous northern route.'],
  ]) {
    const pending = {...admissionEvent, beats:[{...admissionEvent.beats[0]!,action,
      automaticPreludeSourceExcerpt:'The company stood together on the road through the forest.'}]};
    const before = structuredClone(admissionScene);
    await assert.rejects(establishSourceBeatEntry(aidState,admissionScene,aidCandidate,pending,[],0,'test',async(label,request)=>{
      assert.match(request.instructions!,/same warning is not automatic if warning them is itself the pending chosen action/);
      assert.match(request.instructions!,/Do not invent speech for nonverbal or unconscious characters/);
      if(label==='source beat entry')return reply({text,sceneScope:aidScope,storyMemory:admissionScene.storyMemory});
      const schema=request.text!.format.schema as any;
      assert.match(schema.properties.playerAgency.description,/not speech merely because the player speaks/);
      return reply(Object.fromEntries(checks.map(k=>[k,{supported:k!=='playerAgency',reason:'The transition performs the pending speech or a new commitment, not connective dialogue.',...(k==='entryReady'?{repairTarget:'none'}:{})}])));
    }),/playerAgency/);
    assert.deepEqual(admissionScene,before);
  }
});

test('Palace NPC entry preserves the Lion viewpoint while allowing source-backed offscreen readiness', async () => {
  const fs = await import('node:fs/promises');
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/oz-palace-offscreen-entry.json', import.meta.url), 'utf8'));
  const next = {...event(fixture.next_event.eventId, 2, 2), beats: [{
    actor:'Green Girl', action:fixture.next_event.entry_action.action, targets:['Dorothy'],
    agency:'intentional', stakes:'significant', sourceReferences:[ref(2)],
  }]};
  const c = {...candidate, storyEvents:[next], sourceEventEntries:{
    [next.eventId]:{fromEventId:'previous',excerpt:fixture.entry_source,entryExcerpt:fixture.entry_action_source},
  }};
  for (const mode of ['morning-ready','needs-night','blocked-access','invented-knowledge']) {
    const current = structuredClone(fixture.current_scene);
    if (mode === 'blocked-access') current.text += '\nThe Soldier told me Dorothy’s door was locked and the Green Girl could not enter.';
    if (mode === 'morning-ready') current.text += '\nBy morning I was still waiting in my room.';
    const before = structuredClone(current);
    const calls:string[]=[];
    const run = () => actualEventEntry({...state,playerName:'Cowardly Lion'},current,c,'previous','test',async(label,request)=>{
      calls.push(label);
      assert.match(request.instructions!,/OFFSCREEN NPC READINESS/);
      assert.match(request.instructions!,/coming to collect the target is execution, not a prerequisite/);
      assert.match(request.instructions!,/Do not append unseen NPC preparations/);
      assert.match(request.instructions!,/Existing locked access, refusal, absent targets and material contradictions remain blockers/);
      const input = JSON.parse(request.input);
      assert.equal(input.next_event.entry_action.requiresPlayerDecision,false);
      if(label === 'source event entry') {
        const extra = mode === 'invented-knowledge' ? ' The others were already preparing for their visits.' : '';
        return reply({text:'I slept in my room. By morning, I was still waiting.'+extra,
          sceneScope:current.sceneScope,
          storyMemory:{...current.storyMemory,summary:'The Lion slept in his room and waited the next morning.'+extra}});
      }
      const preflight = label.endsWith('preflight review');
      const failures = preflight && mode !== 'morning-ready' ? ['entryReady']
        : mode === 'blocked-access' ? ['entryReady']
        : mode === 'invented-knowledge' ? ['storyMemory'] : [];
      const verdict = Object.fromEntries(checks.map(k=>[k,{
        supported:!failures.includes(k),
        reason:failures.includes(k)
          ? mode==='blocked-access' ? 'Established locked access prevents fetching Dorothy.'
            : mode==='invented-knowledge' && !preflight ? 'Unseen preparations cannot become the Lion’s knowledge.'
            : 'The passage to morning is not yet established.'
          : 'The scheduled NPC fetching may begin offscreen; no visit has been performed and nothing is replayed.',
        ...(k==='visibleCause' && preflight ? {causeStatus:'not_required'}:{}),
        ...(k==='entryReady'?{repairTarget:'none'}:{}),
      }]));
      const schema = request.text!.format.schema as any;
      assert.match(schema.properties.repetition.description,/does not replay completed actions passes/);
      return reply(verdict);
    });
    if(mode==='blocked-access' || mode==='invented-knowledge') {
      await assert.rejects(run(),mode==='blocked-access'?/entryReady/:/storyMemory/);
    } else {
      const result=await run();
      assert.deepEqual(result.sceneScope,before.sceneScope);
      assert.doesNotMatch(result.text,/Green Girl came|others were already preparing/);
      if(mode==='morning-ready') {
        assert.strictEqual(result,current);
        assert.deepEqual(calls,['source event entry preflight review']);
      } else {
        assert.match(result.text,/By morning/);
        assert.deepEqual(calls,['source event entry preflight review','source event entry','source event entry review']);
      }
    }
    assert.deepEqual(current,before);
  }
});

test('logged Dorothy omission is repaired in both scope lists without changing the scene', async () => {
  const fs = await import('node:fs/promises');
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/oz-dorothy-presence-repair.json', import.meta.url), 'utf8'));
  const current = {...admissionScene,text:fixture.scene_text,sceneScope:fixture.original_scope};
  const before = structuredClone(current);
  const pending = {...admissionEvent,beats:[{...admissionEvent.beats[0]!,
    action:'Agree to accompany Dorothy while stating that I am too cowardly to kill the Witch.',
    automaticPreludeSourceExcerpt:'Dorothy said that at least they must try.'}]};
  const calls:string[]=[];
  const result=await actualBeatEntry(aidState,current,aidCandidate,pending,[],0,'test',async(label,request)=>{
    calls.push(label);
    if(label.endsWith('preflight review')) return reply(Object.fromEntries(checks.map(k=>[k,{
      supported:k!=='sceneScope',reason:k==='sceneScope'?fixture.rejection:'Already ready.',
      ...(k==='visibleCause'?{causeStatus:'present'}:{}),...(k==='entryReady'?{repairTarget:'none'}:{})}])));
    const input=JSON.parse(request.input);
    assert.equal(input.entry_source,undefined);
    assert.equal(input.next_event,undefined);
    assert.equal(input.scene_text,before.text);
    if(label.endsWith('speaking distance repair')){
      const schema=request.text!.format.schema as any;
      assert.deepEqual(schema.required,['peoplePresent','peopleWithinSpeakingDistance']);
      return reply({peoplePresent:[...before.sceneScope.peoplePresent,'Dorothy'],
        peopleWithinSpeakingDistance:[...before.sceneScope.peopleWithinSpeakingDistance,'Dorothy']});
    }
    assert.equal(label,'source beat entry speaking distance review');
    assert.ok(input.proposed_scope.peoplePresent.includes('Dorothy'));
    assert.ok(input.proposed_scope.peopleWithinSpeakingDistance.includes('Dorothy'));
    return reply({supported:true,reason:'Dorothy is visibly speaking with the group; both omissions are corrected.'});
  });
  assert.deepEqual(calls,['source beat entry preflight review','source beat entry speaking distance repair','source beat entry speaking distance review']);
  assert.deepEqual(result,{...before,sceneScope:{...before.sceneScope,
    peoplePresent:[...before.sceneScope.peoplePresent,'Dorothy'],
    peopleWithinSpeakingDistance:[...before.sceneScope.peopleWithinSpeakingDistance,'Dorothy']}});
  assert.deepEqual(current,before);
});

test('joint scope repair preserves existing presence and requires prose support for added people',async()=>{
  const {repairEntrySpeakingDistance}=await import('../src/ai/engine/repair-entry-speaking-distance.js');
  const current={...admissionScene,text:'Dorothy and I discussed Oz, who remained in his distant chamber.',
    sceneScope:{...aidScope,peoplePresent:['Cowardly Lion','Dorothy'],peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy']}};
  for(const patch of [
    {peoplePresent:['Cowardly Lion'],peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy']},
    {peoplePresent:['Cowardly Lion','Dorothy','Dorothy'],peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy']},
    {peoplePresent:['Cowardly Lion','Dorothy','Oz'],peopleWithinSpeakingDistance:['Cowardly Lion','Dorothy','Oz']},
  ]){
    const before=structuredClone(current);
    await assert.rejects(repairEntrySpeakingDistance(current,'Missing Oz.','test',async(label,request)=>{
      if(label.endsWith('repair'))return reply(patch);
      assert.match(request.instructions!,/not merely mentioned, remembered, expected or acting offscreen/);
      return reply({supported:false,reason:'Oz is mentioned but remains elsewhere, not present in this scene.'});
    },'source beat entry'),/protected state|remains elsewhere/);
    assert.deepEqual(current,before);
  }
});

test('cottage visibility repairs correlated scope failures once without changing prose or memory', async () => {
  for (const stillUnsupported of [false, true]) {
    const before = structuredClone(scene);
    const proposal = {
      text: 'Through the trees I saw the outline of a small cottage to the right of the road.',
      sceneScope: {...scope, currentLocation: 'The forest road beside a small cottage'},
      storyMemory: {...memory, summary: 'The cottage is visible to the right; we have not reached it.'},
    };
    const fixedScope = {...scope, currentLocation: 'The forest road, with a cottage visible through the trees'};
    let reviews = 0, repairs = 0;
    const run = () => establishSourceEventEntry(state, scene, candidate, 'first', 'test', async (label, request) => {
      if (label === 'source event entry') return reply(proposal);
      const input = JSON.parse(request.input);
      if (label.endsWith('presentation repair')) {
        repairs++;
        assert.deepEqual(input.repair_fields, ['sceneScope']);
        assert.deepEqual(input.candidate_transition.storyMemory, proposal.storyMemory);
        return reply({sceneScope: fixedScope});
      }
      reviews++;
      if (reviews === 2) {
        assert.equal(input.candidate_transition.text, proposal.text);
        assert.deepEqual(input.candidate_transition.storyMemory, proposal.storyMemory);
        assert.deepEqual(input.candidate_transition.sceneScope, fixedScope);
      }
      const rejected = reviews === 1 ? ['sourceSupport', 'continuity', 'sceneScope']
        : stillUnsupported ? ['sourceSupport'] : [];
      return reply(Object.fromEntries(checks.map(k => [k, {
        supported: !rejected.includes(k),
        reason: rejected.includes(k) ? 'The position is unsupported by visible prose.' : 'The setup is supported; the next action remains unperformed.',
      }])));
    });
    if (stillUnsupported) await assert.rejects(run(), /sourceSupport/);
    else {
      const result = await run();
      assert.equal(result.text, scene.text + '\n\n' + proposal.text);
      assert.deepEqual(result.sceneScope, fixedScope);
      assert.deepEqual(result.storyMemory, proposal.storyMemory);
    }
    assert.equal(repairs, 1);
    assert.equal(reviews, 2);
    assert.deepEqual(scene, before);
  }
});

test('correlated scope repair cannot bypass a memory or pending-action failure', async () => {
  for (const extra of ['storyMemory', 'playerAgency', 'nextEventUnperformed', 'visibleCause']) {
    await assert.rejects(establishSourceEventEntry(state, scene, candidate, 'first', 'test', async label => {
      if (label === 'source event entry') return reply(draft);
      assert.equal(label, 'source event entry review');
      return reply(Object.fromEntries(checks.map(k => [k, {
        supported: !['sourceSupport', 'continuity', 'sceneScope', extra].includes(k),
        reason: 'Unresolved substantive error.',
      }])));
    }), new RegExp(extra));
  }
});