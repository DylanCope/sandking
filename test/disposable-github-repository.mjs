import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { digest as sha256 } from "../src/common/digest.mjs";

const execFileAsync = promisify(execFile);
const projectArtifact = "Delivered through Sand-King.\n";

const tokenEnvironment = (token, baseEnvironment = process.env) => {
  const environment = { ...baseEnvironment, GH_TOKEN: token };
  delete environment.GITHUB_TOKEN;
  return environment;
};

const gh = async (token, arguments_, code, environment = process.env) => {
  try {
    return await execFileAsync("gh", arguments_, {
      env: tokenEnvironment(token, environment),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error(code);
  }
};

const repositoryReference = (value) => ({
  nameWithOwner: value.full_name,
  url: value.html_url,
});

const putFile = async (token, repository, path, source) => {
  await gh(token, [
    "api",
    "--method", "PUT",
    `repos/${repository}/contents/${path}`,
    "-f", `message=Seed ${path}`,
    "-f", `content=${Buffer.from(source, "utf8").toString("base64")}`,
  ], "real_github_repository_seed_failed");
};

const runPatProvisioner = ({ input = "", operation, path, repositories }) =>
  new Promise((resolve, reject) => {
    const child = spawn(path, [operation, ...repositories], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`real_github_project_pat_${operation}_timed_out`));
    }, 5 * 60_000);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 16_384) {
        child.kill("SIGKILL");
        finish(new Error(`real_github_project_pat_${operation}_output_invalid`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => {
      finish(new Error(`real_github_project_pat_${operation}_failed`));
    });
    child.once("close", (code) => {
      finish(
        code === 0 ? null : new Error(`real_github_project_pat_${operation}_failed`),
        Buffer.concat(stdout).toString("utf8").trim(),
      );
    });
    child.stdin.end(input);
  });

/**
 * Issue the fine-grained Project PAT only after both disposable repositories
 * exist. The external provisioner must select the first repository alone and
 * revoke the returned token when this lease closes.
 */
export const provisionDisposableProjectPat = async ({
  deniedRepository,
  primaryRepository,
  provisionerPath,
}) => {
  const repositories = [primaryRepository, deniedRepository];
  const token = await runPatProvisioner({
    operation: "issue",
    path: provisionerPath,
    repositories,
  });
  if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) {
    throw new Error("real_github_project_pat_issue_output_invalid");
  }
  let disposed = false;
  return {
    token,
    async dispose() {
      if (disposed) return;
      await runPatProvisioner({
        input: `${token}\n`,
        operation: "revoke",
        path: provisionerPath,
        repositories,
      });
      disposed = true;
    },
  };
};

/**
 * Provision two private repositories with a credential that is kept entirely
 * outside the retained qualification result. The Project credential is
 * deliberately separate and is checked against both repositories later.
 */
export const createDisposableGitHubRepositories = async ({
  owner: requestedOwner,
  provisioningToken,
}) => {
  const viewer = JSON.parse((await gh(provisioningToken, [
    "api", "user",
  ], "real_github_provisioner_unavailable")).stdout);
  const owner = requestedOwner || viewer.login;
  const endpoint = owner.toLowerCase() === String(viewer.login).toLowerCase()
    ? "user/repos"
    : `orgs/${owner}/repos`;
  const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
  const names = [
    `sandking-delegation-${suffix}`,
    `sandking-scope-denial-${suffix}`,
  ];
  const repositories = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const failures = [];
    for (const repository of repositories.toReversed()) {
      try {
        await gh(provisioningToken, [
          "api", "--method", "DELETE", `repos/${repository.full_name}`,
        ], "real_github_repository_cleanup_failed");
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  };

  try {
    for (const name of names) {
      const created = JSON.parse((await gh(provisioningToken, [
        "api",
        "--method", "POST",
        endpoint,
        "-f", `name=${name}`,
        "-F", "private=true",
        "-F", "auto_init=true",
      ], "real_github_repository_provision_failed")).stdout);
      repositories.push(created);
    }

    const primary = repositories[0];
    await putFile(provisioningToken, primary.full_name, "package.json", `${JSON.stringify({
      name: "sandking-disposable-delegation",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }, null, 2)}\n`);
    await putFile(provisioningToken, primary.full_name, "delegation.test.mjs", `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("delegated issue marker is complete", async () => {
  assert.equal(await readFile("delegated-issue.txt", "utf8"), "Delivered through Sand-King.\\n");
});
`.trimStart());
    const issue = JSON.parse((await gh(provisioningToken, [
      "api",
      "--method", "POST",
      `repos/${primary.full_name}/issues`,
      "-f", "title=Add the delegated issue marker",
      "-f", [
        "body=Create `delegated-issue.txt` containing exactly",
        "`Delivered through Sand-King.` followed by one newline.",
        "Do not change the existing test. Run `npm test` before delivery.",
      ].join(" "),
    ], "real_github_issue_seed_failed")).stdout);
    const baseCommit = (await gh(provisioningToken, [
      "api", `repos/${primary.full_name}/commits/main`, "--jq", ".sha",
    ], "real_github_base_commit_observation_failed")).stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) {
      throw new Error("real_github_base_commit_observation_failed");
    }

    return {
      baseCommit,
      primary: repositoryReference(primary),
      denied: repositoryReference(repositories[1]),
      issue: {
        number: issue.number,
        url: issue.html_url,
      },
      clone: async (destination) => {
        await gh(provisioningToken, [
          "repo", "clone", primary.full_name, destination,
        ], "real_github_repository_clone_failed");
      },
      verifyMergedProject: async (destination) => {
        await gh(provisioningToken, [
          "repo", "clone", primary.full_name, destination,
        ], "real_github_merged_repository_clone_failed");
        await execFileAsync("npm", ["test"], {
          cwd: destination,
          env: process.env,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        }).catch(() => {
          throw new Error("real_github_seeded_test_failed");
        });
        const [artifact, { stdout: mainCommitSource }] = await Promise.all([
          readFile(join(destination, "delegated-issue.txt")),
          execFileAsync("git", ["-C", destination, "rev-parse", "HEAD"], {
            timeout: 10_000,
          }),
        ]);
        if (artifact.toString("utf8") !== projectArtifact) {
          throw new Error("real_github_delivered_artifact_invalid");
        }
        const mainCommit = mainCommitSource.trim();
        if (!/^[a-f0-9]{40}$/.test(mainCommit) || mainCommit === baseCommit) {
          throw new Error("real_github_merged_main_invalid");
        }
        return {
          baseCommit,
          mainCommit,
          artifact: {
            path: "delegated-issue.txt",
            integrity: sha256(artifact),
            bytes: artifact.byteLength,
          },
          seededTest: { command: "npm test", passed: true },
        };
      },
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }
};

export const verifyProjectPatRepositoryScope = async ({
  deniedRepository,
  environment = process.env,
  primaryRepository,
  projectPat,
  provisioningToken,
}) => {
  await gh(provisioningToken, [
    "api", `repos/${deniedRepository}`,
  ], "real_github_denied_repository_observation_failed", environment);
  await gh(projectPat, [
    "api", `repos/${primaryRepository}`,
  ], "real_github_project_pat_primary_access_failed", environment);
  try {
    await execFileAsync("gh", ["api", `repos/${deniedRepository}`], {
      env: tokenEnvironment(projectPat, environment),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const diagnostic = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (/(?:HTTP 404|Not Found|Resource not accessible by personal access token)/i
      .test(diagnostic)) return true;
    throw new Error("real_github_project_pat_scope_check_failed");
  }
  throw new Error("real_github_project_pat_scope_not_enforced");
};

export const readGitHubDelegationState = async ({
  issueNumber,
  provisioningToken,
  repository,
}) => {
  const [issue, pullRequests] = await Promise.all([
    gh(provisioningToken, [
      "issue", "view", String(issueNumber),
      "--repo", repository,
      "--json", "number,url,state,comments",
    ], "real_github_issue_observation_failed").then(({ stdout }) => JSON.parse(stdout)),
    gh(provisioningToken, [
      "pr", "list", "--state", "all",
      "--repo", repository,
      "--head", `sandcastle/issue-${issueNumber}`,
      "--json", "number,url,state,baseRefName,headRefName",
    ], "real_github_pull_request_observation_failed").then(({ stdout }) =>
      JSON.parse(stdout)),
  ]);
  const claimActions = issue.comments
    .flatMap(({ body }) => [...body.matchAll(/<!-- sandcastle-claim:([A-Za-z0-9_-]+) -->/g)])
    .map(([, encoded]) => JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
    .map(({ action }) => action);
  return { issue, pullRequests, claimActions };
};
