import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { webAssetForPath } from "../src/server/web.js";

test("all local assets referenced by the web shell have explicit server routes", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((match) => match[1]!);
  assert.ok(assets.length > 0);
  for (const asset of assets) assert.ok(webAssetForPath(asset), `Missing web route: ${asset}`);
});

test("world rules are served as an app module, not installed as a second global fetch hook", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(app, /import \{ createWorldRulesController \} from "\.\/world-rules\.js"/);
  assert.doesNotMatch(html, /<script[^>]+src="\/world-rules\.js"/);
  assert.equal(webAssetForPath("/world-rules.js")?.contentType, "text/javascript; charset=utf-8");
  assert.equal(webAssetForPath("/turn-controls.css")?.contentType, "text/css; charset=utf-8");
  assert.equal(webAssetForPath("/../../.env"), undefined);
});
