import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  REAL_DELEGATION_ARTIFACT,
  REAL_DELEGATION_CONTENT,
  verifyRealDelegationCommit,
} from "../src/production-sandcastle-adapter/real-worker.mjs";

const execFileAsync = promisify(execFile);

const commit = (projectPath, message) => execFileAsync("git", [
  "-C", projectPath,
  "-c", "user.name=Real Worker Test",
  "-c", "user.email=real-worker-test@sandking.invalid",
  "-c", "commit.gpgSign=false",
  "commit", "--quiet", "-m", message,
]);

test("the real Worker accepts only one clean exact artifact commit", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "sandking-real-worker-commit-"));
  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    await writeFile(join(projectPath, "README.md"), "unrelated tracked content\n");
    await execFileAsync("git", ["-C", projectPath, "add", "README.md"]);
    await commit(projectPath, "Initialize disposable Project");
    const beforeCommit = (await execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "HEAD"],
    )).stdout.trim();

    await writeFile(join(projectPath, REAL_DELEGATION_ARTIFACT), REAL_DELEGATION_CONTENT);
    await execFileAsync("git", ["-C", projectPath, "add", REAL_DELEGATION_ARTIFACT]);
    await commit(projectPath, "Prove pinned Sandcastle delegation");

    const afterCommit = await verifyRealDelegationCommit({ projectPath, beforeCommit });
    assert.match(afterCommit, /^[a-f0-9]{40}$/);
    assert.equal(
      await readFile(join(projectPath, REAL_DELEGATION_ARTIFACT), "utf8"),
      REAL_DELEGATION_CONTENT,
    );
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test("the real Worker rejects extra tracked changes in the delegated commit", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "sandking-real-worker-extra-"));
  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    await writeFile(join(projectPath, "README.md"), "original\n");
    await execFileAsync("git", ["-C", projectPath, "add", "README.md"]);
    await commit(projectPath, "Initialize disposable Project");
    const beforeCommit = (await execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "HEAD"],
    )).stdout.trim();

    await Promise.all([
      writeFile(join(projectPath, REAL_DELEGATION_ARTIFACT), REAL_DELEGATION_CONTENT),
      writeFile(join(projectPath, "README.md"), "changed\n"),
    ]);
    await execFileAsync("git", ["-C", projectPath, "add", "--all"]);
    await commit(projectPath, "Invalid broad delegation");

    await assert.rejects(
      verifyRealDelegationCommit({ projectPath, beforeCommit }),
      /real_delegation_commit_invalid/,
    );
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
