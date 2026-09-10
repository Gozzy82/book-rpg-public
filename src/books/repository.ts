import path from "node:path";
import { BlobServiceClient } from "@azure/storage-blob";
import type { ImportedBook } from "../shared/contracts.js";
import { azureCredential } from "../azure/credential.js";
import { dataDir } from "../util/env.js";
import { JsonFileStore } from "../util/json-file-store.js";

interface BookStore {
  put(book: ImportedBook): Promise<void>;
  get(bookId: string): Promise<ImportedBook | undefined>;
  list(): Promise<ImportedBook[]>;
}

class FileBookStore implements BookStore {
  private readonly store = new JsonFileStore<ImportedBook>(path.join(dataDir(), "books"));

  async put(book: ImportedBook): Promise<void> {
    await this.store.put(book.bookId, book);
  }

  async get(bookId: string): Promise<ImportedBook | undefined> {
    return await this.store.get(bookId);
  }

  async list(): Promise<ImportedBook[]> {
    return await this.store.list();
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "statusCode" in error
    && error.statusCode === 404,
  );
}

class AzureBlobBookStore implements BookStore {
  private readonly container;

  constructor() {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME?.trim();
    if (!accountName) {
      throw new Error("AZURE_STORAGE_ACCOUNT_NAME is required for Azure book storage");
    }
    const containerName = process.env.BOOKRPG_BOOKS_CONTAINER?.trim() || "books";
    const service = new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      azureCredential(),
    );
    this.container = service.getContainerClient(containerName);
  }

  private blob(bookId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(bookId)) throw new Error("Invalid book id");
    return this.container.getBlockBlobClient(`${bookId}.json`);
  }

  async put(book: ImportedBook): Promise<void> {
    const content = JSON.stringify(book);
    await this.blob(book.bookId).upload(content, Buffer.byteLength(content), {
      blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" },
    });
  }

  async get(bookId: string): Promise<ImportedBook | undefined> {
    try {
      const buffer = await this.blob(bookId).downloadToBuffer();
      return JSON.parse(buffer.toString("utf8")) as ImportedBook;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async list(): Promise<ImportedBook[]> {
    const books: ImportedBook[] = [];
    for await (const item of this.container.listBlobsFlat()) {
      if (!item.name.endsWith(".json")) continue;
      const buffer = await this.container.getBlobClient(item.name).downloadToBuffer();
      books.push(JSON.parse(buffer.toString("utf8")) as ImportedBook);
    }
    return books;
  }
}

function createBookStore(): BookStore {
  const mode = process.env.BOOKRPG_STORAGE_MODE?.trim().toLowerCase() || "local";
  if (mode === "local") return new FileBookStore();
  if (mode === "azure") return new AzureBlobBookStore();
  throw new Error(`Unsupported BOOKRPG_STORAGE_MODE: ${mode}`);
}

const store = createBookStore();

export async function saveBook(book: ImportedBook): Promise<void> {
  await store.put(book);
}

export async function getBook(bookId: string): Promise<ImportedBook | undefined> {
  return await store.get(bookId);
}

export async function listBooks(): Promise<ImportedBook[]> {
  return await store.list();
}
