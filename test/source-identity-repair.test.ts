import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {sourceIdentityRepair} from '../src/books/analyze/source-identity-repair.js';
import {requestStagedChapterIndexes} from '../src/books/analyze/staged-index.js';
import {buildChapterAnalysisBatches} from '../src/books/analyze/batching.js';
import type {ImportedBook} from '../src/shared/contracts.js';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/import-goals/narrator-outside-repair.json', import.meta.url), 'utf8'));
const reply = (value: unknown) => ({status: 'completed' as const, output_text: JSON.stringify(value)});

test('captured chapter identifies narrator in event 0 rather than queued event 5', () => {
  const book: ImportedBook = {bookId:'test', title:'Oz', importedAt:'now', chapters:[fixture.source]};
  const part = buildChapterAnalysisBatches(book)[0]!.parts[0]!;
  const repair = sourceIdentityRepair(fixture.timeline, part)!;
  assert.deepEqual(repair.eventIndexes, [0]);
  assert.ok(repair.reason.includes('/significantEvents/0/beats/24/actor'));
});

test('resume repairs captured identity before unrelated event and reviews complete chapter', async () => {
  const book: ImportedBook = {bookId:'test', title:'Oz', sourceSha256:'source', importedAt:'now', chapters:[fixture.source]};
  const part = buildChapterAnalysisBatches(book)[0]!.parts[0]!;
  const fingerprint = createHash('sha256').update(JSON.stringify({version:6, source:book.sourceSha256, part, sharedEventsOnly:true})).digest('hex');
  const cp = {fingerprint, timeline:structuredClone(fixture.timeline), events:{}, sourceEventRepair:{eventIndexes:[5],reason:'Add collective inference'},
    sourceRepair:{fields:['/significantEvents/0/description'], reason:'Old field scope'}};
  (book as any).importAnalysis = {version:1,parts:{[part.sourceId]:cp}};
  const stages: string[] = [];
  let saved = 0;
  const result = await requestStagedChapterIndexes(async (request: any) => {
    const schema = request.text.format;
    stages.push(schema.name);
    if (schema.name === 'bookrpg_source_event_repair') {
      if ('event_0' in schema.schema.properties) {
        const event = structuredClone(fixture.timeline.significantEvents[0]);
        const beat = event.beats[24];
        beat.actor = 'Dorothy';
        beat.action = 'Silently forgives Oz because he did his best despite not keeping his promise.';
        beat.resultingState = 'Dorothy has forgiven Oz while recognizing his failure to keep his promise.';
        beat.sourceSemantics = {mode:'present', narratedContent:null, intentionalRole:'meaningful',jointAction:null};
        event.actors = event.actors.filter((n: string) => n !== 'narrator');
        return reply({event_0:event,removeCharacterNames:['narrator']});
      }
      assert.ok(saved > 0);
      assert.ok(!JSON.stringify(cp.timeline.characters).includes('narrator'));
      return reply({event_5:fixture.timeline.significantEvents[5], removeCharacterNames:[]});
    }
    assert.equal(schema.name,'bookrpg_source_timeline_review');
    return reply({valid:true,issues:[],previousFindings:[]});
  },'test',book,[part],1,()=>{},async()=>{saved++;},{sharedEventsOnly:true});
  assert.deepEqual([...result.validationErrors],[]);
  assert.deepEqual(stages,['bookrpg_source_event_repair','bookrpg_source_event_repair','bookrpg_source_timeline_review']);
  assert.equal((cp as any).sourceRepair,undefined);
});
