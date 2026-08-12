import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildLinuxProcessTreeHelpers } from "../scripts/build-linux-process-tree-helpers.mjs";

test("the native-helper check reports both shipped Linux targets stale after a source edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-native-helper-build-"));
  const sourcePath = join(root, "src", "posix-process-tree-helper.c");
  const compile = async ({
    sourcePath: compilerSourcePath,
    target,
    outputPath,
  }) => {
    const source = await readFile(compilerSourcePath, "utf8");
    await writeFile(outputPath, `${target}\n${source}`, { mode: 0o755 });
  };

  try {
    await mkdir(join(root, "src", "native", "linux-x64"), { recursive: true });
    await mkdir(join(root, "src", "native", "linux-arm64"), {
      recursive: true,
    });
    await writeFile(sourcePath, "int main(void) { return 0; }\n");

    await buildLinuxProcessTreeHelpers({ root, mode: "write", compile });
    await buildLinuxProcessTreeHelpers({ root, mode: "check", compile });

    await writeFile(sourcePath, "int main(void) { return 1; }\n");
    await assert.rejects(
      buildLinuxProcessTreeHelpers({ root, mode: "check", compile }),
      (error) => {
        assert.match(error.message, /linux-x64/);
        assert.match(error.message, /linux-arm64/);
        assert.match(error.message, /npm run build:native-helpers/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
