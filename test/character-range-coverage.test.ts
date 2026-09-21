import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {applyCharacterChoiceRanges, characterRangeCoverage, groupExistingCharacterEvent} from '../src/books/analyze/character-action-groups.js';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/import-goals/missing-anchor-coverage.json', import.meta.url),'utf8'));
test('captured rescue range reports missing observation without changing source agency', () => {
  const coverage = characterRangeCoverage(fixture.event, fixture.character, fixture.checkpoint.rejectedCandidate);
  assert.deepEqual(coverage.eligibleBeatIndexes,[1,2,3]);
  assert.deepEqual(coverage.missingBeatIndexes,[1]);
  assert.throws(()=>applyCharacterChoiceRanges(fixture.event,fixture.character,fixture.checkpoint.rejectedCandidate),/Missing beat indexes: \[1\]/);
});
test('resumed repair receives missing indices even with an old generic checkpoint error', async () => {
  const original = structuredClone(fixture.event);
  const result = await groupExistingCharacterEvent(async request => {
    const input = JSON.parse(String(request.input));
    assert.deepEqual(input.sourceEvidence.candidateCoverage.missingBeatIndexes,[1]);
    assert.deepEqual(input.sourceEvidence.rejectedCandidate,fixture.checkpoint.rejectedCandidate);
    return {status:'completed',output_text:JSON.stringify({groups:[{...fixture.checkpoint.rejectedCandidate[0],startBeatIndex:1}]})};
  },'test',fixture.event,fixture.character,{source:{},previousEvents:[],feedback:fixture.checkpoint.error,candidate:fixture.checkpoint.rejectedCandidate});
  assert.deepEqual(result.event.beats![1]!.characterActionGroup!.playerBeatIndexes,[1,2,3]);
  assert.deepEqual(fixture.event,original);
  assert.equal(result.ranges[0]!.label,fixture.checkpoint.rejectedCandidate[0].label);
});
test('coverage distinguishes duplicates from missing beats and excludes involuntary actor beats', () => {
  const coverage = characterRangeCoverage(fixture.event,fixture.character,[{startBeatIndex:1,endBeatIndex:2},{startBeatIndex:2,endBeatIndex:3}]);
  assert.deepEqual(coverage.multiplyCoveredBeatIndexes,[2]);
  assert.deepEqual(coverage.missingBeatIndexes,[]);
});
