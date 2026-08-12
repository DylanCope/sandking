import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const requiredZigVersion = "0.13.0";
const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const targets = [
  { name: "linux-x64", zigTarget: "x86_64-linux-musl" },
  { name: "linux-arm64", zigTarget: "aarch64-linux-musl" },
];

/**
 * @param {string} root
 * @param {string} zigPath
 */
const createZigCompiler = async (root, zigPath) => {
  let installedVersion;
  try {
    const { stdout } = await execFileAsync(zigPath, ["version"]);
    installedVersion = stdout.trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `zig_not_found: install Zig ${requiredZigVersion} or set SANDKING_ZIG`,
      );
    }
    throw error;
  }
  if (installedVersion !== requiredZigVersion) {
    throw new Error(
      `zig_version_mismatch: expected ${requiredZigVersion}, received ${installedVersion}`,
    );
  }

  return async ({ sourcePath, zigTarget, outputPath }) => {
    await execFileAsync(
      zigPath,
      [
        "cc",
        "-target",
        zigTarget,
        "-O2",
        "-static",
        "-s",
        relative(root, sourcePath),
        "-o",
        outputPath,
      ],
      { cwd: root },
    );
  };
};

/**
 * Rebuild or verify both prebuilt Linux process-tree helpers.
 *
 * @param {"check" | "write"} mode
 */
const buildLinuxProcessTreeHelpers = async (mode) => {
  if (mode !== "check" && mode !== "write") {
    throw new Error(`native_helper_build_mode_invalid: ${mode}`);
  }
  const root = defaultRoot;
  const sourcePath = join(root, "src", "posix-process-tree-helper.c");
  const buildDirectory = await mkdtemp(
    join(tmpdir(), "sandking-native-helpers-"),
  );

  try {
    const compile = await createZigCompiler(
      root,
      process.env.SANDKING_ZIG ?? "zig",
    );
    const builds = await Promise.all(
      targets.map(async (target) => {
        const outputPath = join(buildDirectory, target.name);
        await compile({ sourcePath, ...target, outputPath });
        return {
          ...target,
          builtPath: outputPath,
          committedPath: join(
            root,
            "src",
            "native",
            target.name,
            "posix-process-tree-helper",
          ),
        };
      }),
    );

    if (mode === "check") {
      const staleTargets = [];
      for (const build of builds) {
        const [built, committed] = await Promise.all([
          readFile(build.builtPath),
          readFile(build.committedPath).catch(() => null),
        ]);
        if (committed === null || !built.equals(committed)) {
          staleTargets.push(build.name);
        }
      }
      if (staleTargets.length > 0) {
        throw new Error(
          `native_helpers_stale: ${staleTargets.join(", ")}; ` +
            `run npm run build:native-helpers with Zig ${requiredZigVersion}`,
        );
      }
      return;
    }

    for (const build of builds) {
      await mkdir(dirname(build.committedPath), { recursive: true });
      const replacementPath = `${build.committedPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await copyFile(build.builtPath, replacementPath);
        await chmod(replacementPath, 0o755);
        await rename(replacementPath, build.committedPath);
      } finally {
        await rm(replacementPath, { force: true });
      }
    }
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }
};

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (invokedPath === import.meta.url) {
  const argument = process.argv[2];
  const mode =
    argument === "--check" ? "check" : argument === "--write" ? "write" : null;
  if (mode === null || process.argv.length !== 3) {
    process.stderr.write(
      "Usage: node scripts/build-linux-process-tree-helpers.mjs --check|--write\n",
    );
    process.exitCode = 2;
  } else {
    buildLinuxProcessTreeHelpers(mode)
      .then(() => {
        process.stdout.write(
          mode === "check"
            ? "Linux process-tree helpers match their source.\n"
            : "Rebuilt Linux process-tree helpers.\n",
        );
      })
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
