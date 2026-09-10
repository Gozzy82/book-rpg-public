import path from "node:path";
import { loadDotEnv } from "../util/env.js";
import { getBook } from "./repository.js";
import { exportKindlePackage } from "./kindle-package.js";

loadDotEnv();

const bookId = process.argv[2];
if (!bookId) {
  console.error("Usage: npm run export:kindle -- <bookId> [output-directory]");
  process.exit(1);
}

const book = await getBook(bookId);
if (!book) {
  throw new Error(`Unknown bookId ${bookId}. Import and analyze the EPUB first.`);
}

const outputDirectory = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const result = await exportKindlePackage(book, outputDirectory);
console.log(JSON.stringify(result, null, 2));
