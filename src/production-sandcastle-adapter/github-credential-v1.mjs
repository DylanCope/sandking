import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    'printf \'%s\\n\' \'#!/bin/sh\' \'set -eu\' \'GH_TOKEN="$(cat "${HOME}/.sandcastle-secrets/github-token")"\' \'export GH_TOKEN\' "exec \\"${github_executable}\\" \\"\\$@\\"" > "${HOME}/.sandcastle-bin/gh"',
    'chmod 700 "${HOME}/.sandcastle-bin/gh"',
    "gh auth status --hostname github.com >/dev/null",
  ] : []),
];

export const materializeGitHubCredential = async (credential) => {
  if (credential === null || credential === undefined) return null;
  if (
    !credential
    || typeof credential !== "object"
    || Array.isArray(credential)
    || !["project-pat", "host-gh-session"].includes(credential.mode)
    || typeof credential.token !== "string"
    || credential.token.length < 1
    || credential.token.length > 4_096
    || credential.token.trim() !== credential.token
    || /[\s\0]/.test(credential.token)
  ) {
    throw new Error("github_credential_invalid");
  }
  const directory = await mkdtemp(join(tmpdir(), "sandking-github-auth-"));
  const path = join(directory, "token");
  try {
    await writeFile(path, `${credential.token}\n`, { flag: "wx", mode: 0o600 });
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
