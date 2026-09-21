import {validateCharacterNameEvidence} from '../source-index/chapter-index.js';
import type {ChapterPartSourceIndex} from '../source-index.js';
import type {ChapterAnalysisPart} from './batching.js';
import type {SourceEventRepair} from './source-event-repair.js';

/** Locate existing invalid identity references; AI decides their semantic replacement. */
export function sourceIdentityRepair(timeline: ChapterPartSourceIndex, part: ChapterAnalysisPart): SourceEventRepair | undefined {
  const eventIndexes = new Set<number>();
  const defects: unknown[] = [];
  for (const character of timeline.characters) {
    try { validateCharacterNameEvidence(character, {...part, sourceText: part.text}); }
    catch (error) {
      const names = new Set([character.name, ...character.aliases]);
      const paths: string[] = [];
      const visit = (value: unknown, path: string, eventIndex: number) => {
        if (typeof value === 'string' && names.has(value)) { paths.push(path); eventIndexes.add(eventIndex); }
        else if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}/${i}`, eventIndex));
        else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => visit(v, `${path}/${k}`, eventIndex));
      };
      timeline.significantEvents.forEach((event, i) => visit(event, `/significantEvents/${i}`, i));
      defects.push({identity: character.name, error: error instanceof Error ? error.message : String(error), paths});
    }
  }
  if (!defects.length || !eventIndexes.size) return undefined;
  const indexes = [...eventIndexes].sort((a,b) => a-b);
  const reason = `An existing saved identity fails source validation outside the pending repair. Correct its actual uses against the source; preserve their substantive content and do not invent speech. Remove the synthetic identity only after repairing all references. Identity diagnostics: ${JSON.stringify(defects)}`;
  return {eventIndexes: indexes, reason, findings: [{repairEventIndexes: indexes, reason}]};
}
