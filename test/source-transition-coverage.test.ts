import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type {ImportedBook} from '../src/shared/contracts.js';
import type {AiResponseRequest} from '../src/ai/provider.js';
import {requestStagedChapterIndexes} from '../src/books/analyze/staged-index.js';
import {applySourceEventRepair} from '../src/books/analyze/source-event-repair.js';
const captured = JSON.parse(await fs.readFile(new URL('./fixtures/oz-second-gulf-index.json', import.meta.url), 'utf8'));
const reply = (v: unknown) => ({status: 'completed', output_text: JSON.stringify(v && typeof v === "object" && Object.keys(v).some(k => k.startsWith("field_")) ? {scopeCheck: {matchesDefect: true, reason: "Fixture targets match the defect."}, ...v} : v)});
const ok = () => reply({valid: true, issues: []});
function fixture() {
  const old = captured.storyEvents[0];
  const refs = [{lineStart: 86, lineEnd: 124}];
  const semantics = {mode: 'present', narratedContent: null, intentionalRole: 'meaningful', jointAction: null};
  const beats = old.beats.map((b: any) => ({actor: b.actor, action: b.action, resultingState: b.resultingState,
    agency: b.agency, stakes: b.stakes, targets: b.targets,
    sourceSemantics: {...semantics}, references: b.sourceReferences.map(({lineStart, lineEnd}: any) => ({lineStart, lineEnd}))}));
  const names = [...new Set<string>(beats.flatMap((b: any) => [b.actor, ...b.targets]).filter(Boolean))];
  const event = {description: old.description, category: 'other', beats, references: refs};
  const timeline = {summary: old.description, significantEvents: [event],
    characters: names.map(name => ({name, aliases: [], references: refs})), actions: [], relationships: []};
  const text = captured.chapters[9].text.trim().split(/\r?\n/).slice(85, 124).join('\n');
  const part = {sourceId: 'gulf', chapterPosition: 0, chapterIndex: 9, chapterTitle: 'Forest', partIndex: 0, partCount: 1, lineStart: 86, lineEnd: 124, text};
  const book: ImportedBook = {bookId: 'coverage', title: 'Oz', importedAt: 'now', chapters: [{index: 9, title: 'Forest', text}]};
  // A model response to source re-extraction: not an event-patch input.
  const crossing = (actor: string, action: string, state: string, line: number) => ({actor, action, resultingState: state,
    agency: 'intentional', stakes: 'critical', targets: [], sourceSemantics: {...semantics}, references: [{lineStart: line, lineEnd: 107}]});
  const fixed = structuredClone(event);
  fixed.beats.splice(3, 0,
    crossing('The Tin Woodman', 'Follows Dorothy across the bridge.', 'The Woodman is across; Scarecrow and Lion remain behind.', 106),
    crossing('The Scarecrow', 'Crosses after the Tin Woodman.', 'The Scarecrow joins Dorothy and the Woodman across the gulf; the Lion faces the beasts.', 107));
  fixed.beats.splice(2, 0, {actor: null, action: 'As the travelers start crossing, a growl alerts them to two approaching Kalidahs.',
    resultingState: 'Crossing has begun, but the group is not safely across; the Kalidahs are visibly approaching.', agency: 'external', stakes: 'critical', targets: [],
    sourceSemantics: {...semantics, intentionalRole: 'other'}, references: [{lineStart: 100, lineEnd: 102}]});
  fixed.beats[7].resultingState = 'The Scarecrow has requested that the Woodman cut the end of the tree on their destination bank; the Woodman has not yet acted.';
  return {book, part, timeline, fixed};
}

for (const split of [false, true]) test(`production index repairs gulf transitions ${split ? 'across events' : 'within one event'} before rebuilding groups`, async () => {
  const {book, part, timeline, fixed} = fixture();
  if (split) {
    const whole = timeline.significantEvents[0]!;
    timeline.significantEvents = [{...whole, beats: whole.beats.slice(0, 3)}, {...whole, beats: whole.beats.slice(3)}];
  }
  const replacements = split ? {event_0: {...fixed, beats: fixed.beats.slice(0, 4)}, event_1: {...fixed, beats: fixed.beats.slice(4)}} : {event_0: fixed};
  const calls: string[] = [];
  let reviews = 0, plannedBeats: any[] = [];
  let plans: any[] = [];
  const provider = async (request: AiResponseRequest) => {
    const name = request.text!.format.name; calls.push(name);
    if (name === 'bookrpg_source_timeline') {
      assert.match(request.instructions!, /Every material change in location/);
      assert.match(request.instructions!, /NARRATOR VERSUS CHARACTER KNOWLEDGE/);
      assert.match(request.instructions!, /MEANING-PRESERVING PARAPHRASES/);
      assert.match(request.instructions!, /Perceiving a reachable target does not require knowing the mechanism/);
      return reply({gulf: timeline});
    }
    if (name === 'bookrpg_source_timeline_review') {
      assert.match(request.instructions!, /across event containers/);
      assert.match(request.instructions!, /Ordinary practical inferences from visible circumstances are allowed/);
      assert.match(request.instructions!, /future promise or conditional statement do not establish that anyone has died/);
      assert.match(request.instructions!, /Carried travel can be represented by the carrier/);
      const flows = JSON.parse(request.input.split('CHARACTER FLOW CHECKLIST:\n')[1]!.split('\nCOMPILED TIMELINE')[0]!);
      for (const name of ['Dorothy', 'The Tin Woodman', 'Toto', 'The Scarecrow', 'The Cowardly Lion'])
        assert.ok(flows.some((f: any) => f.character === name), name);
      if (++reviews === 1) return reply({valid: false, issues: [{target: 'source',
        reason: 'The Kalidah approach and two companion crossings are missing before later far-bank checkpoints.', repairFields: [], repairEventIndexes: split ? [0, 1] : [0]}]});
      const reviewed = JSON.parse(request.input.split('COMPILED TIMELINE (derived narration fields are expected):\n')[1]!);
      assert.equal(reviewed.significantEvents.flatMap((e: any) => e.beats).length, 9);
      return ok();
    }
    if (name === 'bookrpg_source_event_repair') {
      assert.match(request.input, /the Tin Woodman followed/);
      assert.match(request.instructions!, /remove only the unsupported attribution/);
      assert.match(request.instructions!, /Preserve already faithful wording during repair/);
      assert.deepEqual(Object.keys((request.text!.format.schema as any).properties), split ? ['event_0', 'event_1', 'removeCharacterNames'] : ['event_0', 'removeCharacterNames']);
      return reply(replacements);
    }
    if (name === 'bookrpg_action_goal_plan') {
      const event = JSON.parse(request.input.split('COMPLETE IMMUTABLE TIMELINE (absolute source-part beat indexes):\n')[1]!);
      plannedBeats = event.beats;
      plans = event.beats.flatMap((b: any, i: number) => b.eligibleForGoal ? [{startBeatIndex: i, endBeatIndex: i, goal: b.action, boundaryReason: 'This act ends before another decision.'}] : []);
      return reply({groups: plans});
    }
    if (name === 'bookrpg_action_goal_labels') return reply(Object.fromEntries(plans.map(p => [`beat_${p.startBeatIndex}`, {
      choiceText: p.goal, completion: plannedBeats[p.endBeatIndex].resultingState,
      preconditions: ['The source-supported prior state is established.'], interruptWhen: ['An obstacle prevents the act.'],
    }])));
    assert.match(name, /review$/); return ok();
  };
  const first = await requestStagedChapterIndexes(provider, 'test', book, [part], 1, () => {}, async () => {});
  assert.equal(first.indexes.size, 0);
  assert.ok(!calls.includes('bookrpg_action_goal_plan'));
  // Durable recovery through the production checkpoint, not a manual book patch.
  const restored = JSON.parse(JSON.stringify(book));
  const second = await requestStagedChapterIndexes(provider, 'test', restored, [part], 2, () => {}, async () => {});
  assert.deepEqual([...second.validationErrors], []);
  assert.equal(calls.filter(c => c === 'bookrpg_source_timeline').length, 1);
  assert.equal(calls.filter(c => c === 'bookrpg_source_event_repair').length, 1);
  assert.ok(calls.lastIndexOf('bookrpg_source_timeline_review') < calls.indexOf('bookrpg_action_goal_plan'));
  const events = second.indexes.get(part.sourceId)!.significantEvents;
  const beats = events.flatMap(e => e.beats);
  assert.equal(beats.length, 9);
  assert.equal(beats[4]!.actor, 'The Tin Woodman');
  assert.equal(beats[5]!.actor, 'The Scarecrow');
  assert.equal(beats[6]!.playerAction!.endBeatIndex, split ? 2 : 6);
  assert.equal(beats[8]!.playerAction!.endBeatIndex, split ? 4 : 8);
});

test('bounded source repair freezes unrelated event containers and rejects extra replacements', () => {
  const {timeline, fixed} = fixture();
  timeline.significantEvents.push(structuredClone(timeline.significantEvents[0]!));
  const before = structuredClone(timeline);
  const scope = {eventIndexes: [0], reason: 'Missing transition.'};
  const repaired = applySourceEventRepair(timeline as any, scope, {event_0: fixed});
  assert.deepEqual((repaired.significantEvents as any[])[1], timeline.significantEvents[1]);
  assert.deepEqual(timeline, before);
  assert.throws(() => applySourceEventRepair(timeline as any, scope, {event_0: fixed, event_1: fixed}), /exactly/);
  assert.throws(() => applySourceEventRepair(timeline as any, {eventIndexes: [2], reason: 'Invalid scope.'}, {event_2: fixed}), /scope/);
});


test('a rejected event repair remains unapproved and never reaches goal planning', async () => {
  const {book, part, timeline, fixed} = fixture();
  let generation = 0, repairCalls = 0;
  const provider = async (request: AiResponseRequest) => {
    const name = request.text!.format.name;
    if (name === 'bookrpg_source_timeline') { generation++; return reply({gulf: timeline}); }
    if (name === 'bookrpg_source_event_repair') { repairCalls++; return reply({event_0: fixed}); }
    assert.equal(name, 'bookrpg_source_timeline_review');
    return reply({valid: false, issues: [{target: 'source', reason: 'The transition still lacks source support.', repairFields: [], repairEventIndexes: [0]}]});
  };
  for (const attempt of [1, 2]) {
    const result = await requestStagedChapterIndexes(provider, 'test', book, [part], attempt, () => {}, async () => {});
    assert.equal(result.indexes.size, 0);
    assert.equal(result.validationErrors.size, 1);
  }
  assert.equal(generation, 1);
  assert.equal(repairCalls, 1);
  const checkpoint = book.importAnalysis!.parts.gulf as any;
  assert.notEqual(checkpoint.sourceReviewed, true);
  assert.deepEqual(checkpoint.events, {});
});

for (const kind of ['external', 'routine'] as const) test(`conflicting ${kind} classification resumes with a bounded AI repair and no source regeneration`, async () => {
  const {book, part, timeline} = fixture();
  const target = timeline.significantEvents[0]!.beats[0]!;
  if (kind === 'external') { target.actor = null; target.agency = 'external'; }
  else target.stakes = 'routine';
  const before = structuredClone(timeline);
  let generation = 0, repairs = 0, reviews = 0;
  let plans: any[] = [], beats: any[] = [];
  const provider = async (request: AiResponseRequest) => {
    const name = request.text!.format.name;
    if (name === 'bookrpg_source_timeline') { generation++; return reply({gulf: timeline}); }
    if (name === 'bookrpg_source_field_repair') {
      if (++repairs === 1) throw new Error('Simulated interrupted repair');
      const map = JSON.parse(request.input.split('APPROVED FIELD MAP:\n')[1]!);
      assert.deepEqual(Object.values(map), ['/significantEvents/0/beats/0/sourceSemantics/intentionalRole', '/significantEvents/0/beats/0/stakes', '/significantEvents/0/beats/0/agency']);
      return reply({field_0: 'other', field_1: target.stakes, field_2: target.agency});
    }
    if (name === 'bookrpg_source_timeline_review') {
      reviews++;
      const reviewed = JSON.parse(request.input.split('COMPILED TIMELINE (derived narration fields are expected):\n')[1]!);
      assert.equal(reviewed.significantEvents[0].beats[0].sourceSemantics.intentionalRole, 'other');
      assert.equal(reviewed.significantEvents[0].beats[0].action, target.action);
      assert.deepEqual(reviewed.significantEvents[0].beats.slice(1).map((b: any) => b.action), before.significantEvents[0]!.beats.slice(1).map((b: any) => b.action));
      return ok();
    }
    if (name === 'bookrpg_action_goal_plan') {
      beats = JSON.parse(request.input.split('COMPLETE IMMUTABLE TIMELINE (absolute source-part beat indexes):\n')[1]!).beats;
      plans = beats.flatMap((b: any, i: number) => b.eligibleForGoal ? [{startBeatIndex: i, endBeatIndex: i, goal: b.action, boundaryReason: 'Distinct action.'}] : []);
      assert.equal(beats[0].eligibleForGoal, false);
      return reply({groups: plans});
    }
    if (name === 'bookrpg_action_goal_labels') return reply(Object.fromEntries(plans.map(p => [`beat_${p.startBeatIndex}`, {
      choiceText: p.goal, completion: beats[p.endBeatIndex].resultingState, preconditions: [], interruptWhen: [],
    }])));
    assert.match(name, /review$/); return ok();
  };
  const first = await requestStagedChapterIndexes(provider, 'test', book, [part], 1, () => {}, async () => {});
  assert.equal(first.indexes.size, 0);
  assert.equal(reviews, 0);
  const restored = JSON.parse(JSON.stringify(book));
  const second = await requestStagedChapterIndexes(provider, 'test', restored, [part], 2, () => {}, async () => {});
  assert.deepEqual([...second.validationErrors], []);
  assert.equal(second.indexes.size, 1);
  assert.equal(generation, 1);
  assert.equal(repairs, 2);
  assert.equal(reviews, 1);
});
