import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Mirrors KOReader util.partialMD5(): 1 KiB samples at offsets
 * 1024 << (2*i), i = -1..10 => 256, 1024, 4096, ...
 */
export function koreaderPartialMd5(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const md5 = crypto.createHash("md5");
    const size = 1024;
    for (let i = -1; i <= 10; i++) {
      const offset = 1024 * Math.pow(4, i);
      const buffer = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buffer, 0, size, offset);
      if (bytesRead <= 0) break;
      md5.update(buffer.subarray(0, bytesRead));
      if (bytesRead < size) break;
    }
    return md5.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}
