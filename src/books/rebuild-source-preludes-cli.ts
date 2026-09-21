import {preparePreludeRebuild} from './source-index/prepare-prelude-rebuild.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {ImportedBook} from '../shared/contracts.js';
import {getBook, saveBook} from './repository.js';
import {createDefaultResponse} from './analyze/identity.js';
import {configuredIndexModel} from '../ai/provider.js';
import {loadDotEnv, loadAiApiKey, dataDir} from '../util/env.js';
loadDotEnv();
const args = process.argv.slice(2), values = new Map<string, string>();
let apply = false, review = false;
for (let i = 0; i < args.length; i++) {
  const key = args[i]!;
  if (key === '--apply') { apply = true; review = true; continue; }
  if (key === '--review') { review = true; continue; }
  if (!['--book', '--file', '--model', '--event', '--event-patch'].includes(key) || values.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('Use --book ID or --file INDEX.json [--event EVENT_ID] [--event-patch PATCH.json] [--review] [--model MODEL] [--apply]');
  values.set(key, args[++i]!);
}
if (values.has('--book') === values.has('--file')) throw new Error('Supply exactly one --book or --file.');
if (apply && values.has('--file')) throw new Error('--file creates a separate rebuilt-book.json; use --book for --apply.');
const original: ImportedBook | undefined = values.has('--file') ? JSON.parse(await fs.readFile(path.resolve(values.get('--file')!), 'utf8')) : await getBook(values.get('--book')!);
if (!original) throw new Error('Book not found.');
const directory = path.join(dataDir(), 'source-prelude-rebuilds', new Date().toISOString().replaceAll(':', '-'));
await fs.mkdir(directory, {recursive: true});
await fs.writeFile(path.join(directory, 'original-book.json'), JSON.stringify(original, null, 2));
const eventId = values.get('--event');
if (review) loadAiApiKey();
const result = await preparePreludeRebuild(original, {eventId, model: values.get('--model') || configuredIndexModel(),
  createResponse: review ? createDefaultResponse() : undefined,
  eventPatch: values.has('--event-patch') ? JSON.parse(await fs.readFile(path.resolve(values.get('--event-patch')!), 'utf8')) : undefined});
const {issues, reviewed, reviewStatus, reviewScope, groupReviewStatus} = result.report;
await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(result.report, null, 2));
if (!issues.length) await fs.writeFile(path.join(directory, 'rebuilt-book.json'), JSON.stringify(result.book, null, 2));
if (apply && !issues.length) {
  if (JSON.stringify(await getBook(original.bookId)) !== JSON.stringify(original)) throw new Error('Book changed during audit; not applied.');
  await saveBook(result.book);
}
console.log(JSON.stringify({directory, applied: apply && !issues.length, reviewRequested: review, reviewed, reviewStatus,
  reviewScope, groupReviewStatus, issues: issues.length, restartWithNewGame: true}, null, 2));
if (issues.length) process.exitCode = 1;
