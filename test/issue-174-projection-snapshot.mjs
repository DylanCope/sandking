import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export const snapshotIssue174Projection = async (root) => {
  const entries = [];
  const visit = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          integrity: sha256(await readFile(path)),
        });
      } else if (entry.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          type: "symlink",
          target: await readlink(path),
        });
      } else {
        throw new Error("issue_174_projection_shape_invalid");
      }
    }
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
};
