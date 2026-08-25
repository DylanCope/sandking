import assert from "node:assert/strict";
import test from "node:test";
import { restoreIssue174SandboxImage } from "./issue-174-sandbox-image.mjs";

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
