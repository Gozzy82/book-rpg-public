import type { ImportedBook, CharacterProfile } from "../../shared/contracts.js";

const identity = (name: string) => name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A probe needs source text, not a successful earlier whole-book analysis. */
export function createAnchorProbeBook(original: ImportedBook | undefined, bookId: string, chapterNumber: number): ImportedBook {
  if (!original) throw new Error(`Book ${bookId} was not found in the configured book storage. Check BOOKRPG_DATA_DIR and BOOKRPG_STORAGE_MODE.`);
  const chapter = original.chapters[chapterNumber - 1];
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1 || !chapter) {
    throw new Error(`Chapter position ${chapterNumber} does not exist; this book has ${original.chapters.length} chapters.`);
  }
  if (!chapter.text.trim()) throw new Error(`Chapter position ${chapterNumber} has no source text.`);
  return {bookId: original.bookId, sourceSha256: original.sourceSha256, title: original.title, importedAt: original.importedAt,
    chapters: [{index: chapter.index, title: chapter.title, text: chapter.text}]};
}

/** Only source-reviewed chapter identities can become probe actors. CLI names never create identities. */
export function attachAnchorProbeIdentities(book: ImportedBook, existingProfiles: readonly CharacterProfile[] = []): void {
  const source = book.chapters[0]?.sourceIndex;
  if (!source || source.extractionMode !== "shared_events_v1") throw new Error("Review the probe source before resolving its characters");
  const profiles = new Map<string, CharacterProfile>();
  for (const observed of source.characters) {
    const observedNames = [observed.name, ...observed.aliases];
    const matches = existingProfiles.filter(p => [p.name, ...p.aliases].some(n => observedNames.some(o => identity(o) === identity(n))));
    if (matches.length > 1) throw new Error(`Ambiguous existing identity for chapter character ${observed.name}`);
    const name = matches[0]?.name ?? observed.name;
    const key = identity(name);
    const profile = profiles.get(key) ?? {name, aliases: [], role: "Chapter participant", description: "Identified in the reviewed chapter source.",
      traits: [], relationships: [], storyArc: "", sourceReferences: []};
    profile.aliases = [...new Set([...profile.aliases, ...(matches[0]?.aliases ?? []), ...observedNames])].filter(n => identity(n) !== key);
    profile.sourceReferences!.push(...structuredClone(observed.sourceReferences));
    profiles.set(key, profile);
  }
  book.worldBible = {summary: source.summary, characters: [...profiles.values()].map(p => p.name), characterProfiles: [...profiles.values()], locations: []};
}
