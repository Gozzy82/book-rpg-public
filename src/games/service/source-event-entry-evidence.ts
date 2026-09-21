import type { ImportedBook } from '../../shared/contracts.js';

/** Only the unindexed passage between adjacent events can authorize an entry transition.
 * The first beat's separate evidence supplies static entry facts, never permission to execute it.
 * Never take a whole chapter or skip an indexed event.
 */
export function sourceEventEntryEvidence(book: Pick<ImportedBook, 'chapters' | 'storyEvents'>, targetEventIds?: readonly string[]) {
  const entries: Record<string, {fromEventId: string; excerpt: string; entryExcerpt: string}> = {};
  const events = [...(book.storyEvents ?? [])].sort((a, b) => a.sequence - b.sequence);
  for (let i = 1; i < events.length; i++) {
    const previous = events[i - 1]!, next = events[i]!;
    if (targetEventIds && !targetEventIds.includes(next.eventId)) continue;
    const previousRefs = previous.beats?.flatMap(b => b.sourceReferences) ?? previous.sourceReferences;
    const nextRefs = next.beats?.[0]?.sourceReferences ?? next.sourceReferences;
    if (!previousRefs.length || !nextRefs.length) continue;
    const end = [...previousRefs].sort((a, b) => b.chapterPosition - a.chapterPosition || b.lineEnd - a.lineEnd)[0]!;
    const start = [...nextRefs].sort((a, b) => a.chapterPosition - b.chapterPosition || a.lineStart - b.lineStart)[0]!;
    if (end.chapterPosition > start.chapterPosition) continue;
    const parts: string[] = [];
    let valid = true;
    for (let position = end.chapterPosition; position <= start.chapterPosition; position++) {
      const chapter = book.chapters[position];
      if (!chapter) { valid = false; break; }
      const lines = chapter.text.trim().split(/\r?\n/);
      const from = position === end.chapterPosition ? end.lineEnd : 0;
      const to = position === start.chapterPosition ? start.lineStart - 1 : lines.length;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > lines.length
        || (position === end.chapterPosition && chapter.index !== end.chapterIndex)
        || (position === start.chapterPosition && chapter.index !== start.chapterIndex)) { valid = false; break; }
      parts.push(lines.slice(from, to).join('\n'));
    }
    const excerpt = parts.join('\n\n').trim();
    const entryParts: string[] = [];
    for (const reference of nextRefs) {
      const chapter = book.chapters[reference.chapterPosition];
      const lines = chapter?.text.trim().split(/\r?\n/);
      if (!chapter || chapter.index !== reference.chapterIndex || !lines
        || !Number.isInteger(reference.lineStart) || !Number.isInteger(reference.lineEnd)
        || reference.lineStart < 1 || reference.lineEnd < reference.lineStart || reference.lineEnd > lines.length) { valid = false; break; }
      entryParts.push(lines.slice(reference.lineStart - 1, reference.lineEnd).join('\n'));
    }
    const entryExcerpt = entryParts.join('\n\n');
    if (valid && excerpt && excerpt.length + entryExcerpt.length <= 12000) entries[next.eventId] = {fromEventId: previous.eventId, excerpt, entryExcerpt};
  }
  return entries;
}
