import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { koreaderPartialMd5 } from "../src/books/koreader-hash.js";

test("KOReader partial MD5 uses the documented non-linear samples", () => {
  const file = path.join(os.tmpdir(), `bookrpg-hash-${process.pid}.bin`);
  const data = Buffer.alloc(2_000_000);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  fs.writeFileSync(file, data);

  const expectedHash = crypto.createHash("md5");
  for (let i = -1; i <= 10; i++) {
    const offset = 1024 * Math.pow(4, i);
    const sample = data.subarray(offset, Math.min(offset + 1024, data.length));
    if (sample.length === 0) break;
    expectedHash.update(sample);
    if (sample.length < 1024) break;
  }

  assert.equal(koreaderPartialMd5(file), expectedHash.digest("hex"));
  fs.unlinkSync(file);
});
