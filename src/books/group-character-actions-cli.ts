import fs from "node:fs/promises";
import path from "node:path";
import type { BookStoryEvent, ImportedBook } from "../shared/contracts.js";
import { configuredIndexModel } from "../ai/provider.js";
import { loadAiApiKey, loadDotEnv, dataDir } from "../util/env.js";
import { getBook, saveBook } from "./repository.js";
import { createDefaultResponse } from "./analyze/identity.js";
import { groupExistingCharacterEvent } from "./analyze/character-action-groups.js";
import { sourceIndexFingerprint } from "./source-index/game-version.js";

loadDotEnv();
const args = process.argv.slice(2);
const options = new Map<string, string>();
let apply = false;
for (let i = 0; i < args.length; i++) {
  const key = args[i]!;
  if (key === "--apply") { apply = true; continue; }
  if (!["--book", "--file", "--character", "--events", "--model"].includes(key) || !args[i + 1] || args[i + 1]!.startsWith("--") || options.has(key)) {
    throw new Error("Usage: npm run group:actions -- --book BOOK_ID (or --file INDEX.json) --character NAME --events 1,13 [--model MODEL] [--apply]");
  }
  options.set(key, args[++i]!);
}
if (options.has("--book") === options.has("--file") || !options.get("--character") || !options.get("--events")) throw new Error("Supply exactly one --book or --file, plus --character and --events (event sequence numbers)");
if (apply && options.has("--file")) throw new Error("--file writes a separate grouped-book.json; use --book with --apply to update the game library");
const book: ImportedBook | undefined = options.has("--file")
  ? JSON.parse(await fs.readFile(path.resolve(options.get("--file")!), "utf8"))
  : await getBook(options.get("--book")!);
if (!book) throw new Error("Book not found");
const original = structuredClone(book);
const profile = book.worldBible?.characterProfiles?.find(p => [p.name, ...p.aliases].some(n => n.toLowerCase() === options.get("--character")!.toLowerCase()));
if (!profile) throw new Error("Character not found in the existing index");
const sequences = options.get("--events")!.split(",").map(Number);
if (!sequences.length || sequences.some(n => !Number.isInteger(n) || n < 1) || new Set(sequences).size !== sequences.length) throw new Error("--events must contain unique positive event sequence numbers");

// Old exports can contain the shared timeline only in character profiles.
// Refuse inconsistent copies; never mix newer chapter beats into this timeline.
if (!book.storyEvents?.length) {
  const events = new Map<string, BookStoryEvent>();
  const core = (e: BookStoryEvent) => JSON.stringify({...e, beats: e.beats?.map(b => {
    const {automaticPreludeEndState: _state, ...rest} = b;
    delete (rest as Record<string, unknown>).automaticPreludeSourceExcerpt;
    return rest;
  })});
  for (const p of book.worldBible?.characterProfiles ?? []) for (const e of p.significantEvents ?? []) {
    const previous = events.get(e.eventId);
    if (previous && core(previous) !== core(e)) throw new Error(`Conflicting character copies of ${e.eventId}; no model calls made`);
    events.set(e.eventId, e);
  }
  book.storyEvents = [...events.values()].map(e => structuredClone(e)).sort((a, b) => a.sequence - b.sequence);
}
const selected = sequences.map(sequence => {
  const matches = book.storyEvents!.filter(e => e.sequence === sequence);
  if (matches.length !== 1 || !profile.significantEvents?.some(e => e.eventId === matches[0]!.eventId)) throw new Error(`Event ${sequence} is missing, ambiguous, or not attached to ${profile.name}`);
  return matches[0]!;
});
const directory = path.join(dataDir(), "character-action-pilots", new Date().toISOString().replaceAll(":", "-"));
await fs.mkdir(directory, {recursive: true});
await fs.writeFile(path.join(directory, "original-book.json"), JSON.stringify(original, null, 2));
loadAiApiKey();
const model = options.get("--model") || configuredIndexModel();
const createResponse = createDefaultResponse();
const report: unknown[] = [];
for (const event of selected) {
  console.error(`${profile.name}: grouping existing event ${event.sequence} (${model}, medium; one attempt)...`);
  try {
    const grouped = await groupExistingCharacterEvent(async request => {
      await fs.writeFile(path.join(directory, `event-${event.sequence}-request.json`), JSON.stringify(request, null, 2));
      const response = await createResponse(request);
      await fs.writeFile(path.join(directory, `event-${event.sequence}-response.json`), JSON.stringify(response, null, 2));
      return response;
    }, model, event, profile);
    book.storyEvents = book.storyEvents!.map(e => e.eventId === event.eventId ? grouped.event : e);
    for (const p of book.worldBible?.characterProfiles ?? []) for (const copy of p.significantEvents ?? []) {
      if (copy.eventId !== event.eventId) continue;
      if (copy.beats?.length !== grouped.event.beats?.length || copy.beats?.some((b, i) => b.actor !== grouped.event.beats![i]!.actor || b.action !== grouped.event.beats![i]!.action)) throw new Error(`Character copy differs for ${event.eventId}`);
      copy.beats?.forEach((b, i) => {
        const annotation = grouped.event.beats![i]!.characterActionGroup;
        if (annotation !== undefined) b.characterActionGroup = structuredClone(annotation);
      });
    }
    report.push({eventId: event.eventId, sequence: event.sequence, character: profile.name, model, ranges: grouped.ranges, usage: grouped.usage});
  } catch (error) {
    report.push({sequence: event.sequence, error: String(error)});
    await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    throw error;
  }
  await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
}
await fs.writeFile(path.join(directory, "grouped-book.json"), JSON.stringify(book, null, 2));
if (apply) {
  const current = await getBook(book.bookId);
  if (!current || sourceIndexFingerprint(current) !== sourceIndexFingerprint(original)
    || JSON.stringify(current.worldBible) !== JSON.stringify(original.worldBible)) throw new Error("Book changed during grouping; grouped-book.json is saved, live book was not replaced");
  await saveBook(book);
}
console.log(JSON.stringify({applied: apply, directory, events: report}, null, 2));
