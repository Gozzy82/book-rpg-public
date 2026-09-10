import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { serveWebAsset, webAssetForPath } from "../src/server/web.js";

test("the mobile web app is served with safe headers and explicit asset routes", async (t) => {
  const server = http.createServer((request, response) => {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", "http://localhost");
    void serveWebAsset(method, url.pathname, response)
      .then((served) => {
        if (served) return;
        response.writeHead(404);
        response.end();
      })
      .catch((error: unknown) => {
        response.writeHead(500);
        response.end(error instanceof Error ? error.message : String(error));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const root = await fetch(`${baseUrl}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type") || "", /^text\/html/);
  assert.match(root.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.equal(root.headers.get("x-content-type-options"), "nosniff");
  const document = await root.text();
  assert.match(document, /<html lang="en">/);
  assert.match(document, /<main id="app"/);
  assert.match(document, /BookRPG - Enter your story/);

  const script = await fetch(`${baseUrl}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") || "", /^text\/javascript/);
  const scriptText = await script.text();
  assert.match(scriptText, /FREE_ACTION_CHOICE_ID/);
  assert.match(scriptText, /Continue with Microsoft/);
  assert.match(scriptText, /Continue with GitHub/);
  assert.match(scriptText, /const MAX_CHARACTER_CHOICES = 5;/);
  assert.match(scriptText, /\.slice\(0, MAX_CHARACTER_CHOICES\)/);
  assert.match(scriptText, /Turn history/);
  assert.match(scriptText, /turn\.action/);
  assert.doesNotMatch(scriptText, /customPlayer|A custom character/);

  const head = await fetch(`${baseUrl}/styles.css`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  assert.equal(webAssetForPath("/../../.env"), undefined);
  assert.equal((await fetch(`${baseUrl}/../../.env`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/`, { method: "POST" })).status, 404);
});
