import test from 'node:test';
import assert from 'node:assert/strict';
import {applySourceFieldRepair, sourceClassificationRepair} from '../src/books/analyze/source-field-repair.js';
import {validateSourceBeatSemantics} from '../src/shared/source-beat-semantics.js';
const beat = {actor: null, action: 'The house lands.', resultingState: 'The house is on the ground.', agency: 'external' as const,
  stakes: 'critical' as const, sourceSemantics: {mode: 'present' as const, narratedContent: null, intentionalRole: 'meaningful' as const, jointAction: null}};
const timeline = {significantEvents: [{description: 'Dorothy knows why Toto floats.', category: 'discovery', beats: [beat]}]};
test('metadata repair freezes rescue beats and validates category enum', () => {
  const repair = {fields: ['/significantEvents/0/description', '/significantEvents/0/category'], reason: 'Unsupported knowledge and compound category.'};
  const fixed = applySourceFieldRepair(timeline, repair, {field_0: 'Dorothy rescues Toto.', field_1: 'other'});
  assert.deepEqual((fixed.significantEvents as any[])[0].beats, [beat]);
  assert.equal(timeline.significantEvents[0]!.description, 'Dorothy knows why Toto floats.');
  assert.throws(() => applySourceFieldRepair(timeline, repair, {field_0: 'Rescue', field_1: 'made-up'}), /Invalid repair enum/);
});
test('classification repair cannot alter prose or accept inconsistent or invalid enum output', () => {
  const repair = sourceClassificationRepair(timeline)!;
  assert.equal(repair.fields.length, 3);
  assert.throws(() => applySourceFieldRepair(timeline, repair, {field_0: 'other', field_1: 'critical', field_2: 'external', action: 'New action'}), /exactly/);
  assert.throws(() => applySourceFieldRepair(timeline, repair, {field_0: 'arbitrary', field_1: 'critical', field_2: 'external'}), /enum/);
  const unchanged = applySourceFieldRepair(timeline, repair, {field_0: 'meaningful', field_1: 'critical', field_2: 'external'});
  assert.throws(() => validateSourceBeatSemantics((unchanged.significantEvents as any[])[0].beats), /meaningful action/);
  const fixed = applySourceFieldRepair(timeline, repair, {field_0: 'other', field_1: 'critical', field_2: 'external'});
  assert.equal(sourceClassificationRepair(fixed), undefined);
  validateSourceBeatSemantics((fixed.significantEvents as any[])[0].beats);
});
