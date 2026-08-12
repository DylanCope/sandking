import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requiredZigVersion = "0.13.0";

test("npm detects both shipped Linux helpers as stale after a real source edit", async (context) => {
  const zigPath = process.env.SANDKING_ZIG ?? "zig";
  try {
    const { stdout } = await execFileAsync(zigPath, ["version"]);
    if (stdout.trim() !== requiredZigVersion) {
      context.skip(`requires Zig ${requiredZigVersion}`);
      return;
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip(`requires Zig ${requiredZigVersion}`);
      return;
    }
    throw error;
  }

  const root = await mkdtemp(join(tmpdir(), "sandking-native-helper-build-"));
  const sourcePath = join(root, "src", "posix-process-tree-helper.c");

  try {
    for (const path of [
      "package.json",
      "scripts/build-linux-process-tree-helpers.mjs",
      "src/posix-process-tree-helper.c",
      "src/native/linux-x64/posix-process-tree-helper",
      "src/native/linux-arm64/posix-process-tree-helper",
    ]) {
      const destination = join(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(repositoryRoot, path), destination);
    }

    const source = await readFile(sourcePath, "utf8");
    const editedSource = source.replace("SANDKING_OK = 0", "SANDKING_OK = 1");
    assert.notEqual(editedSource, source);
    await writeFile(sourcePath, editedSource);

    await assert.rejects(
      execFileAsync("npm", ["run", "check:native-helpers"], {
        cwd: root,
        env: { ...process.env, SANDKING_ZIG: zigPath },
      }),
      (error) => {
        assert.equal(error.code, 1);
        const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
        assert.match(
          output,
          /native_helpers_stale: linux-x64, linux-arm64;/,
        );
        assert.match(output, /npm run build:native-helpers/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
