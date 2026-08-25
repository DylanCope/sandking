import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  constants,
  copyFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const exactCodexPath = join(
  dirname(require.resolve("@openai/codex/package.json")),
  "bin",
  "codex.js",
);
const incompatibleCodexPath = join(
  dirname(require.resolve("@openai/codex-incompatible/package.json")),
  "bin",
  "codex.js",
);
const testApiKey = "sk-sandking-readiness-not-a-real-key";

const findExecutable = async (command, pathValue) => {
  for (const pathEntry of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(pathEntry, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue across the actual executable search path.
    }
  }
  return null;
};

const runCodexLogin = (command, environment) => new Promise((resolve, reject) => {
  const child = spawn(command, ["login", "--with-api-key"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostic = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    diagnostic += chunk;
  });
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(
      `real_codex_login_failed:${code ?? signal ?? "unknown"}:${diagnostic}`,
    ));
  });
  child.stdin.end(`${testApiKey}\n`);
});

const observeCodexAuthentication = async (command, environment) => {
  try {
    const result = await execFileAsync(command, ["login", "status"], {
      env: environment,
      timeout: 5_000,
    });
    return {
      authenticated: /^Logged in\b/m.test(`${result.stdout}\n${result.stderr}`),
      exitCode: 0,
    };
  } catch (error) {
    return {
      authenticated: false,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
    };
  }
};

/**
 * Prepare actual Codex/npm/Docker processes for one installed-CLI readiness
 * scenario. No command emits fabricated readiness output: both Codex versions
 * are released CLI packages, authentication is written by `codex login`, and
 * Docker unavailability is observed from the installed client against a
 * nonexistent daemon socket.
 *
 * @param {{
 *   condition: "missing-codex" | "wrong-codex-version" | "unauthenticated-codex" | "unavailable-docker",
 *   homeDirectory: string,
 *   root: string,
 * }} options
 */
export const installRealReadinessProcesses = async (options) => {
  if (process.platform === "win32") {
    return {
      supported: false,
      reason: "the installed readiness seam currently uses a Unix-domain Controller endpoint",
      restore: () => undefined,
    };
  }
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const sourcePath = originalPath ?? "";
  const binPath = join(options.root, "readiness-bin");
  await mkdir(binPath, { recursive: true });

  const [npmPath, gitPath, dockerPath] = await Promise.all([
    findExecutable("npm", sourcePath),
    findExecutable("git", sourcePath),
    findExecutable("docker", sourcePath),
  ]);
  if (!npmPath || !gitPath) {
    throw new Error("real_readiness_support_process_missing");
  }

  const nodePath = join(binPath, "node");
  await copyFile(process.execPath, nodePath);
  await chmod(nodePath, 0o700);
  await Promise.all([
    symlink(npmPath, join(binPath, "npm")),
    symlink(gitPath, join(binPath, "git")),
  ]);

  const restore = () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  };
  process.env.HOME = options.homeDirectory;
  process.env.PATH = binPath;
  const environment = { ...process.env };

  try {
    if (options.condition === "missing-codex") {
      const ambientCodex = await findExecutable(
        "codex",
        [dirname(nodePath), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
      );
      if (ambientCodex) {
        return {
          supported: false,
          reason: "an ambient Codex executable remains in the Host fallback path",
          restore,
        };
      }
      const lookupFailed = await execFileAsync("codex", ["--version"], {
        env: environment,
        timeout: 5_000,
      }).then(() => false, (error) => error?.code === "ENOENT");
      if (!lookupFailed) throw new Error("real_missing_codex_precondition_invalid");
      return {
        supported: true,
        nodePath,
        observation: { codex: "ENOENT" },
        restore,
      };
    }

    const codexSource = options.condition === "wrong-codex-version"
      ? incompatibleCodexPath
      : exactCodexPath;
    const codexPath = join(binPath, "codex");
    await symlink(codexSource, codexPath);
    const version = (await execFileAsync(codexPath, ["--version"], {
      env: environment,
      timeout: 5_000,
    })).stdout.trim();

    if (options.condition === "unauthenticated-codex") {
      const authentication = await observeCodexAuthentication(codexPath, environment);
      if (authentication.authenticated || authentication.exitCode === 0) {
        throw new Error("real_unauthenticated_codex_precondition_invalid");
      }
      return {
        supported: true,
        nodePath,
        observation: { authentication, version },
        restore,
      };
    }

    await runCodexLogin(codexPath, environment);
    const authentication = await observeCodexAuthentication(codexPath, environment);
    if (!authentication.authenticated || authentication.exitCode !== 0) {
      throw new Error("real_authenticated_codex_precondition_invalid");
    }
    if (options.condition === "wrong-codex-version") {
      return {
        supported: true,
        nodePath,
        observation: { authentication, version },
        restore,
      };
    }

    if (!dockerPath) {
      return {
        supported: false,
        reason: "an actual Docker client is required to exercise daemon unavailability",
        restore,
      };
    }
    const localDockerPath = join(binPath, "docker");
    await symlink(dockerPath, localDockerPath);
    const contextName = `sandking-unavailable-${process.pid}`;
    const missingSocket = join(options.root, "missing-docker-daemon.sock");
    await execFileAsync(localDockerPath, [
      "context", "create", contextName,
      "--docker", `host=unix://${missingSocket}`,
    ], { env: environment, timeout: 5_000 });
    await execFileAsync(localDockerPath, ["context", "use", contextName], {
      env: environment,
      timeout: 5_000,
    });
    const daemonUnavailable = await execFileAsync(localDockerPath, [
      "version", "--format", "{{.Server.Version}}",
    ], { env: environment, timeout: 5_000 }).then(() => false, () => true);
    if (!daemonUnavailable) {
      throw new Error("real_unavailable_docker_precondition_invalid");
    }
    return {
      supported: true,
      nodePath,
      observation: { authentication, docker: "daemon-unavailable", version },
      restore,
    };
  } catch (error) {
    restore();
    throw error;
  }
};

export const REAL_READINESS_TEST_API_KEY = testApiKey;
