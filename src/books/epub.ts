import path from "node:path";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import type { ImportedBook } from "../shared/contracts.js";
import { koreaderPartialMd5, sha256File } from "./koreader-hash.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return firstText(value[0]);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"].trim() || undefined;
  }
  return undefined;
}

function guessChapterTitle(text: string, index: number): string {
  const first = text.split(/\n+/).map((s) => s.trim()).find(Boolean);
  if (first && first.length <= 100) return first;
  return `Chapter ${index + 1}`;
}

export function readEpub(filePath: string): ImportedBook {
  const zip = new AdmZip(filePath);
  const container = zip.readAsText("META-INF/container.xml");
  if (!container) throw new Error("Invalid EPUB: META-INF/container.xml missing");

  const containerXml = parser.parse(container) as any;
  const rootFile = asArray(containerXml?.container?.rootfiles?.rootfile)[0];
  const opfPath = rootFile?.["full-path"];
  if (!opfPath) throw new Error("Invalid EPUB: package OPF path missing");

  const opfText = zip.readAsText(opfPath);
  if (!opfText) throw new Error(`Invalid EPUB: ${opfPath} missing`);
  const opf = parser.parse(opfText) as any;
  const pkg = opf?.package;
  if (!pkg) throw new Error("Invalid EPUB: package element missing");

  const title = firstText(pkg.metadata?.["dc:title"]) || path.basename(filePath, path.extname(filePath));
  const author = firstText(pkg.metadata?.["dc:creator"]);
  const manifestItems = asArray<any>(pkg.manifest?.item);
  const manifest = new Map<string, any>(manifestItems.map((item) => [item.id, item]));
  const spine = asArray<any>(pkg.spine?.itemref);
  const opfDir = path.posix.dirname(opfPath);

  const chapters = spine.flatMap((ref, index) => {
    const item = manifest.get(ref.idref);
    if (!item?.href) return [];
    const entryPath = path.posix.normalize(path.posix.join(opfDir, item.href));
    const html = zip.readAsText(entryPath);
    if (!html) return [];
    const text = htmlToText(html);
    if (!text) return [];
    return [{ index, title: guessChapterTitle(text, index), text }];
  });

  if (chapters.length === 0) throw new Error("No readable spine chapters found in EPUB");

  return {
    bookId: koreaderPartialMd5(filePath),
    sourceSha256: sha256File(filePath),
    title,
    author,
    chapters,
    importedAt: new Date().toISOString(),
  };
}
