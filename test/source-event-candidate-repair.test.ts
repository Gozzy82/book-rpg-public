import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {repairSourceEvents, type RejectedEventRepair} from '../src/books/analyze/staged-index.js';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/import-goals/source-review-drift.json', import.meta.url), 'utf8'));
const part = {sourceId: 'chapter_1_part_1', chapterPosition: 0, chapterIndex: fixture.source.index, chapterTitle: fixture.source.title,
  partIndex: 0, partCount: 1, lineStart: 1, lineEnd: fixture.source.text.trim().split(/\r?\n/).length, text: fixture.source.text};
const reply = (value: unknown) => ({status: 'completed' as const, output_text: JSON.stringify(value)});

test('failed actor assignment retains raw candidate; next repair receives it and frozen baseline', async () => {
  const original = structuredClone(fixture.after);
  const event = structuredClone(original.significantEvents[8]);
  event.beats[0].actor = 'narrator';
  let rejected: RejectedEventRepair | undefined;
  await assert.rejects(repairSourceEvents(async () => reply({event_8: event}), 'mock', 'medium', part, original,
    {eventIndexes: [8], reason: 'Preserve bedtime facts'}, undefined, async r => {rejected = r;}), /narrator/);
  assert.equal((rejected!.raw as any).event_8.beats[0].actor, 'narrator');
  assert.deepEqual(original, fixture.after);
  const repaired = await repairSourceEvents(async request => {
    assert.ok(String(request.input).includes(JSON.stringify(rejected)));
    assert.ok(String(request.instructions).includes('actor=null, agency=external'));
    return reply({event_8: original.significantEvents[8]});
  }, 'mock', 'medium', part, original, {eventIndexes: [8], reason: 'Preserve bedtime facts'}, rejected);
  assert.deepEqual(repaired.significantEvents[8], original.significantEvents[8]);
});

test('stale rejected candidate is excluded after baseline changes', async () => {
  const original = structuredClone(fixture.after);
  await repairSourceEvents(async request => {
    assert.ok(String(request.input).endsWith('null'));
    return reply({event_8: original.significantEvents[8]});
  }, 'mock', 'medium', part, original, {eventIndexes: [8], reason: 'Preserve bedtime facts'},
    {baselineHash: 'stale', eventIndexes: [8], raw: {bad: true}, error: 'old failure'});
});

test('AI can remove an unused synthetic identity from a saved failed timeline', async () => {
  const original = structuredClone(fixture.after);
  original.characters.push({name: 'narrator', aliases: [], references: []});
  const repaired = await repairSourceEvents(async () => reply({event_8: original.significantEvents[8], removeCharacterNames: ['narrator']}),
    'mock', 'medium', part, original, {eventIndexes: [8], reason: 'Correct external narrator attribution'});
  assert.ok(!repaired.characters.some(c => c.name === 'narrator'));
  assert.equal(original.characters.at(-1).name, 'narrator');
});

test('removing a still-referenced identity is rejected', async () => {
  const original = structuredClone(fixture.after);
  await assert.rejects(repairSourceEvents(async () => reply({event_8: original.significantEvents[8], removeCharacterNames: ['Dorothy']}),
    'mock', 'medium', part, original, {eventIndexes: [8], reason: 'Invalid removal'}), /still-referenced/);
});
