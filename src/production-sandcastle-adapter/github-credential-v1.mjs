import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitHubCredential } from "../github-credential-contract.mjs";

export const githubSandboxEnvironment = Object.freeze({
  PATH: "/home/agent/.sandcastle-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  GH_CONFIG_DIR: "/home/agent/.config/gh",
  GH_PROMPT_DISABLED: "1",
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
});

export const githubSandboxReadyCommands = (configured) => [
  'rm -rf "${HOME}/.config/gh"',
  'mkdir -p "${HOME}/.config/gh"',
  'rm -rf "${HOME}/.sandcastle-bin"',
  ...(configured ? [
    'mkdir -p "${HOME}/.sandcastle-bin"',
    'github_executable="$(command -v gh)"',
    'printf \'%s\\n\' \'#!/bin/sh\' \'set -eu\' \'credential_path="${SANDKING_GITHUB_CREDENTIAL_PATH:-${HOME}/.sandcastle-secrets/github-token}"\' \'GH_TOKEN="$(cat "${credential_path}")"\' \'export GH_TOKEN\' "exec \\"${github_executable}\\" \\"\\$@\\"" > "${HOME}/.sandcastle-bin/gh"',
    'chmod 700 "${HOME}/.sandcastle-bin/gh"',
    "gh api user --hostname github.com --jq .login >/dev/null",
  ] : []),
];

export const materializeGitHubCredential = async (credential) => {
  if (credential === null || credential === undefined) return null;
  const parsedCredential = parseGitHubCredential(credential);
  const directory = await mkdtemp(join(tmpdir(), "sandking-github-auth-"));
  const path = join(directory, "token");
  try {
    await writeFile(path, `${parsedCredential.token}\n`, { flag: "wx", mode: 0o600 });
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("github_credential_invalid");
    }
    return {
      path,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};
