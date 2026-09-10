import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { defaultDataDir } from "../src/util/env.js";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-env-"));

after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

test("the default data directory stays local outside a linked Git worktree", () => {
  assert.equal(defaultDataDir(testRoot), path.join(testRoot, "data"));
});

test("linked Git worktrees share the primary worktree data directory", async () => {
  const primaryRoot = path.join(testRoot, "primary");
  const commonGitDir = path.join(primaryRoot, ".git");
  const worktreeRoot = path.join(testRoot, "linked");
  const worktreeGitDir = path.join(commonGitDir, "worktrees", "linked");

  await fs.mkdir(worktreeGitDir, { recursive: true });
  await fs.mkdir(worktreeRoot, { recursive: true });
  await fs.writeFile(
    path.join(worktreeRoot, ".git"),
    `gitdir: ${worktreeGitDir}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");

  assert.equal(defaultDataDir(worktreeRoot), path.join(primaryRoot, "data"));
});
