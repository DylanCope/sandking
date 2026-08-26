import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const tokenEnvironment = (token) => {
  const environment = { ...process.env, GH_TOKEN: token };
  delete environment.GITHUB_TOKEN;
  return environment;
};

const gh = async (token, arguments_, code) => {
  try {
    return await execFileAsync("gh", arguments_, {
      env: tokenEnvironment(token),
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

    return {
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
  primaryRepository,
  projectPat,
}) => {
  await gh(projectPat, [
    "api", `repos/${primaryRepository}`,
  ], "real_github_project_pat_primary_access_failed");
  try {
    await execFileAsync("gh", ["api", `repos/${deniedRepository}`], {
      env: tokenEnvironment(projectPat),
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
