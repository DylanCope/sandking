import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createGitRepository } from "./delivery-adapters.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("the Git adapter creates and pushes an issue branch from origin/main", async (t) => {
  const root = mkdtempSync(join(process.cwd(), ".sandcastle-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const working = join(root, "working");

  git(root, "init", "--bare", origin);
  git(root, "clone", origin, working);
  git(working, "config", "user.name", "Sandcastle Test");
  git(working, "config", "user.email", "sandcastle@example.test");
  git(working, "switch", "-c", "main");
  writeFileSync(join(working, "README.md"), "base\n");
  git(working, "add", "README.md");
  git(working, "commit", "-m", "base");
  git(working, "push", "-u", "origin", "main");

  const repository = createGitRepository({ cwd: working });
  const baseCommit = await repository.synchronizeMain();
  await repository.createFreshBranch("sandcastle/issue-12", baseCommit);
  git(working, "switch", "sandcastle/issue-12");
  writeFileSync(join(working, "delivery.txt"), "delivered\n");
  git(working, "add", "delivery.txt");
  git(working, "commit", "-m", "deliver issue 12");
  const headCommit = await repository.pushBranch("sandcastle/issue-12");

  assert.equal(
    git(origin, "rev-parse", "refs/heads/sandcastle/issue-12"),
    headCommit,
  );
  assert.equal(
    git(working, "merge-base", baseCommit, headCommit),
    baseCommit,
  );
});
