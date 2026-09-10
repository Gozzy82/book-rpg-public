import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { readEpub } from "../src/books/epub.js";

test("EPUB extraction preserves spine order and stable normalized text lines", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bookrpg-epub-"));
  const epubPath = path.join(directory, "synthetic.epub");
  try {
    const zip = new AdmZip();
    zip.addFile("mimetype", Buffer.from("application/epub+zip"));
    zip.addFile("META-INF/container.xml", Buffer.from([
      '<?xml version="1.0"?>',
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
      '  <rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles>',
      "</container>",
    ].join("\n")));
    zip.addFile("EPUB/package.opf", Buffer.from([
      '<?xml version="1.0"?>',
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">',
      "  <metadata",
      '    xmlns:dc="http://purl.org/dc/elements/1.1/">',
      "    <dc:title>Synthetic Story</dc:title>",
      "    <dc:creator>Example Author</dc:creator>",
      "  </metadata>",
      "  <manifest>",
      '    <item id="second" href="second.xhtml" media-type="application/xhtml+xml"/>',
      '    <item id="first" href="first.xhtml" media-type="application/xhtml+xml"/>',
      "  </manifest>",
      '  <spine><itemref idref="first"/><itemref idref="second"/></spine>',
      "</package>",
    ].join("\n")));
    zip.addFile("EPUB/first.xhtml", Buffer.from([
      "<html><body>",
      "<h1>Opening</h1>",
      "<p>Person Alpha enters.</p>",
      "<p>Person Beta responds.</p>",
      "</body></html>",
    ].join("")));
    zip.addFile("EPUB/second.xhtml", Buffer.from(
      "<html><body><h1>Afterward</h1><p>They continue.</p></body></html>",
    ));
    zip.writeZip(epubPath);

    const book = readEpub(epubPath);

    assert.equal(book.title, "Synthetic Story");
    assert.equal(book.author, "Example Author");
    assert.deepEqual(
      book.chapters.map(({ index, title }) => ({ index, title })),
      [
        { index: 0, title: "Opening" },
        { index: 1, title: "Afterward" },
      ],
    );
    assert.deepEqual(book.chapters[0]?.text.split("\n"), [
      "Opening",
      "Person Alpha enters.",
      "Person Beta responds.",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
