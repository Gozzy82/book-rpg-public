import { assertCharacterAnchorsReady } from "../analyze/character-anchor-import.js";
import { createHash } from "node:crypto";
import type { GameState, ImportedBook } from "../../shared/contracts.js";
export function sourceIndexFingerprint(book: ImportedBook): string {
  return createHash("sha256").update(JSON.stringify({...(book.characterAnchors ? {characterAnchors: book.characterAnchors} : {}), events: book.storyEvents ?? [], chapters: book.chapters.map(c => c.sourceIndex ?? null)})).digest("hex");
}
export function assertGameSourceVersion(game: GameState, book: ImportedBook): void {
  assertCharacterAnchorsReady(book, game.playerName);
  if (game.sourceIndexFingerprint ? game.sourceIndexFingerprint !== sourceIndexFingerprint(book)
    : book.chapters.some(c => (c.sourceIndex?.schemaVersion ?? 0) >= 9)) {
    throw new Error("This book's source index changed. Start a new game for the new decision boundaries; the saved beat positions cannot be remapped. Restore the original book index to continue this save.");
  }
}

