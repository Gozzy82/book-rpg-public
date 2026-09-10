import fs from "node:fs/promises";
import path from "node:path";
import { BlobServiceClient } from "@azure/storage-blob";
import type { ImportedBook } from "../shared/contracts.js";
import { azureCredential } from "../azure/credential.js";
import { dataDir, loadDotEnv } from "../util/env.js";

loadDotEnv();

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatePublishableBook(value: unknown, filename: string): ImportedBook {
  if (!value || typeof value !== "object") {
    throw new Error(`${filename} does not contain a book object`);
  }
  const book = value as Partial<ImportedBook>;
  if (
    !book.bookId?.trim()
    || !book.title?.trim()
    || !Array.isArray(book.chapters)
    || book.chapters.length === 0
  ) {
    throw new Error(`${filename} is missing required imported-book data`);
  }
  if (!book.gameProfile || !book.worldBible) {
    throw new Error(
      `${filename} has not completed book analysis and cannot be published`,
    );
  }
  return book as ImportedBook;
}

async function run(): Promise<void> {
  const accountName = requiredEnvironment("AZURE_STORAGE_ACCOUNT_NAME");
  const containerName = process.env.BOOKRPG_BOOKS_CONTAINER?.trim() || "books";
  const sourceDirectory = path.resolve(process.argv[2] || path.join(dataDir(), "books"));
  const names = (await fs.readdir(sourceDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (names.length === 0) {
    throw new Error(`No imported book JSON files found in ${sourceDirectory}`);
  }

  const service = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    azureCredential(),
  );
  const container = service.getContainerClient(containerName);
  for (const name of names) {
    const filename = path.join(sourceDirectory, name);
    const book = validatePublishableBook(
      JSON.parse(await fs.readFile(filename, "utf8")) as unknown,
      filename,
    );
    const content = JSON.stringify(book);
    await container.getBlockBlobClient(`${book.bookId}.json`).upload(
      content,
      Buffer.byteLength(content),
      {
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" },
      },
    );
    console.log(`Published: ${book.title} (${book.bookId})`);
  }
}

run().catch((error: unknown) => {
  console.error(`Book publication failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
