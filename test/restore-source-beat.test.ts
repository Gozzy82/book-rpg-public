import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {restoreSourceBeat} from '../src/books/source-index/restore-beat.js';
import type {ImportedBook} from '../src/shared/contracts.js';
const original: ImportedBook=JSON.parse(fs.readFileSync(new URL('./fixtures/missing-sleep.json',import.meta.url),'utf8'));
test('restores the missing indexed sleep without regeneration or shifting retrieval groups',()=>{
 const snapshot=JSON.stringify(original);
 const fixed=restoreSourceBeat(original,3,[3,0,12]);
 const before=original.worldBible!.characterProfiles[0]!.significantEvents!.find(e=>e.sequence===3)!;
 const after=fixed.worldBible!.characterProfiles[0]!.significantEvents!.find(e=>e.sequence===3)!;
 assert.equal(after.eventId,before.eventId);
 assert.equal(after.beats!.length,before.beats!.length+1);
 assert.deepEqual(after.beats!.slice(0,2),before.beats);
 assert.equal(after.beats!.at(-1)!.resultingState,'Dorothy is asleep on the bed, and Toto is lying beside her.');
 assert.equal(after.beats!.at(-1)!.agency,'intentional');
 assert.equal(JSON.stringify(original),snapshot);
 assert.throws(()=>restoreSourceBeat(fixed,3,[3,0,12]),/already covered/);
});
test('refuses ambiguous overlapping ranges, wrong insertion boundaries and conflicting character copies',()=>{
 assert.throws(()=>restoreSourceBeat(original,3,[3,0,0]),/already covered/);
 assert.throws(()=>restoreSourceBeat(original,1,[3,0,12]),/not in the gap/);
 const conflict=structuredClone(original);
 const copy=structuredClone(conflict.worldBible!.characterProfiles[0]!);
 copy.significantEvents![0]!.beats![0]!.action='Different timeline';
 conflict.worldBible!.characterProfiles.push(copy);
 assert.throws(()=>restoreSourceBeat(conflict,3,[3,0,12]),/Conflicting/);
});
