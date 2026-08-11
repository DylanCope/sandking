import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareIssue174SandboxImage,
  restoreIssue174SandboxImage,
} from "./issue-174-sandbox-image.mjs";

test("the gated runner builds the pinned sandbox image and restores its projection", {
  skip: process.platform === "win32" ? "symlink creation requires platform privileges" : false,
}, async () => {
  const projectionPath = await mkdtemp(join(tmpdir(), "sandking-issue-174-image-"));
  const calls = [];
  let built = false;
  try {
    const imageId = await prepareIssue174SandboxImage({
      projectionPath,
      imageName: "sandcastle:sandking-real-worker",
      dockerfilePath: join(projectionPath, ".sandcastle", "Dockerfile"),
      executeFile: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (command === "npm") {
          await mkdir(join(projectionPath, "node_modules", ".bin"), { recursive: true });
          await mkdir(join(projectionPath, "node_modules", "runtime"), { recursive: true });
          await writeFile(join(projectionPath, "node_modules", "runtime", "cli.js"), "");
          await symlink("../runtime/cli.js", join(projectionPath, "node_modules", ".bin", "runtime"));
        } else {
          built = true;
        }
        return { stdout: "", stderr: "" };
      },
      inspectImage: async () => built ? `sha256:${"e".repeat(64)}` : null,
    });

    assert.equal(imageId, `sha256:${"e".repeat(64)}`);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [
      "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    ]);
    assert.deepEqual(calls[1].args.slice(-5), [
      "build-image",
      "--image-name", "sandcastle:sandking-real-worker",
      "--dockerfile", join(projectionPath, ".sandcastle", "Dockerfile"),
    ]);
    await assert.rejects(access(join(projectionPath, "node_modules")));
  } finally {
    await rm(projectionPath, { recursive: true, force: true });
  }
});

test("the gated runner restores an existing fixed image and removes its temporary tag", async () => {
  const oldId = `sha256:${"a".repeat(64)}`;
  const newId = `sha256:${"b".repeat(64)}`;
  const tags = new Map([
    ["sandcastle:sandking-real-worker", newId],
    ["sandcastle:sandking-real-worker-issue-174-test", newId],
  ]);
  await restoreIssue174SandboxImage({
    fixedImageName: "sandcastle:sandking-real-worker",
    fixedImageBefore: oldId,
    fixedTagChanged: true,
    temporaryImageName: "sandcastle:sandking-real-worker-issue-174-test",
    temporaryImageOwned: true,
    inspectImage: async (name) => tags.get(name) ?? null,
    executeFile: async (_command, args) => {
      if (args[0] === "tag") tags.set(args[2], args[1]);
      if (args[0] === "image" && args[1] === "rm") tags.delete(args[2]);
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(tags.get("sandcastle:sandking-real-worker"), oldId);
  assert.equal(tags.has("sandcastle:sandking-real-worker-issue-174-test"), false);
});

test("the gated runner removes npm artifacts when the sandbox build fails", async () => {
  const projectionPath = await mkdtemp(join(tmpdir(), "sandking-issue-174-image-failure-"));
  try {
    await assert.rejects(prepareIssue174SandboxImage({
      projectionPath,
      imageName: "sandcastle:sandking-real-worker",
      dockerfilePath: join(projectionPath, ".sandcastle", "Dockerfile"),
      executeFile: async (command) => {
        if (command === "npm") {
          await mkdir(join(projectionPath, "node_modules"), { recursive: true });
          return { stdout: "", stderr: "" };
        }
        throw new Error("sandbox build failed");
      },
    }), /sandbox build failed/);
    await assert.rejects(access(join(projectionPath, "node_modules")));
  } finally {
    await rm(projectionPath, { recursive: true, force: true });
  }
});
