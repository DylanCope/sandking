import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { snapshotIssue174Projection } from "./issue-174-projection-snapshot.mjs";

test("issue 174 projection snapshots include npm bin symlinks without following them", {
  skip: process.platform === "win32" ? "symlink creation requires platform privileges" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-issue-174-snapshot-"));
  try {
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(root, "node_modules", "runtime"), { recursive: true });
    await writeFile(join(root, "node_modules", "runtime", "cli.js"), "runtime\n");
    await symlink("../runtime/cli.js", join(root, "node_modules", ".bin", "runtime"));

    assert.deepEqual(await snapshotIssue174Projection(root), [
      {
        path: "node_modules/.bin/runtime",
        type: "symlink",
        target: "../runtime/cli.js",
      },
      {
        path: "node_modules/runtime/cli.js",
        type: "file",
        integrity: "sha256:fae9d8f386d67956867dedef7c89476199a4a25ee9ffe13560a6bfae7ae6c407",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
