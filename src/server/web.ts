import fs from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";

interface WebAsset {
  filename: string;
  contentType: string;
}

const WEB_ASSETS = new Map<string, WebAsset>([
  ["/", { filename: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/index.html", { filename: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", { filename: "app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { filename: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/world-rules.js", { filename: "world-rules.js", contentType: "text/javascript; charset=utf-8" }],
  ["/world-rules.css", { filename: "world-rules.css", contentType: "text/css; charset=utf-8" }],
  ["/narrative-layout.js", { filename: "narrative-layout.js", contentType: "text/javascript; charset=utf-8" }],
  ["/narrative-layout.css", { filename: "narrative-layout.css", contentType: "text/css; charset=utf-8" }],
  ["/turn-controls.css", { filename: "turn-controls.css", contentType: "text/css; charset=utf-8" }],
  [
    "/manifest.webmanifest",
    { filename: "manifest.webmanifest", contentType: "application/manifest+json; charset=utf-8" },
  ],
  ["/icon.svg", { filename: "icon.svg", contentType: "image/svg+xml; charset=utf-8" }],
  ["/favicon.ico", { filename: "icon.svg", contentType: "image/svg+xml; charset=utf-8" }],
]);

const WEB_SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function webAssetForPath(pathname: string): WebAsset | undefined {
  return WEB_ASSETS.get(pathname);
}

export async function serveWebAsset(
  method: string,
  pathname: string,
  response: ServerResponse,
): Promise<boolean> {
  if (method !== "GET" && method !== "HEAD") return false;
  const asset = webAssetForPath(pathname);
  if (!asset) return false;

  const filename = path.join(process.cwd(), "public", asset.filename);
  let body: Buffer;
  try {
    body = await fs.readFile(filename);
  } catch (cause) {
    throw new Error(`Could not load web asset ${filename}`, { cause });
  }

  response.writeHead(200, {
    ...WEB_SECURITY_HEADERS,
    "cache-control": "no-cache",
    "content-length": body.byteLength,
    "content-type": asset.contentType,
  });
  response.end(method === "HEAD" ? undefined : body);
  return true;
}
