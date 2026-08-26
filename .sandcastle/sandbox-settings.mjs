const credentialHelperUrl = new URL("./github-credential-v1.mjs", import.meta.url);
const sourceCredentialHelperUrl = new URL(
  "../src/production-sandcastle-adapter/github-credential-v1.mjs",
  import.meta.url,
);
const {
  createGitHubSandboxEnvironment,
  githubSandboxEnvironment,
  githubSandboxReadyCommands,
  materializeGitHubCredential,
} = await import(credentialHelperUrl.href).catch(() =>
  import(sourceCredentialHelperUrl.href));

export {
  createGitHubSandboxEnvironment,
  githubSandboxEnvironment,
  githubSandboxReadyCommands,
  materializeGitHubCredential,
};

export const REAL_SANDBOX_IMAGE = "sandcastle:sandking-real-worker";
const SANDBOX_GITHUB_CREDENTIAL_PATH =
  "/home/agent/.sandcastle-secrets/github-token";

/**
 * @param {string} [hostAuthPath]
 * @param {{githubCredentialPath?: string | null, imageName?: string}} [options]
 */
export const createCodexSandboxSettings = (
  hostAuthPath = "~/.codex/auth.json",
  { githubCredentialPath = null, imageName = REAL_SANDBOX_IMAGE } = {},
) => {
  const githubConfigured = typeof githubCredentialPath === "string"
    && githubCredentialPath.length > 0;
  return {
    docker: {
      imageName,
      mounts: [
        {
          hostPath: hostAuthPath,
          sandboxPath: "/home/agent/.sandcastle-secrets/codex-auth.json",
          readonly: true,
        },
        ...(githubConfigured ? [{
          hostPath: githubCredentialPath,
          sandboxPath: SANDBOX_GITHUB_CREDENTIAL_PATH,
          readonly: true,
        }] : []),
      ],
      env: {
        ...githubSandboxEnvironment,
        ...(githubConfigured
          ? { SANDKING_GITHUB_CREDENTIAL_PATH: SANDBOX_GITHUB_CREDENTIAL_PATH }
          : {}),
      },
    },
    hooks: {
      sandbox: {
        onSandboxReady: [
          {
            command: [
              "set -eu",
              'codex_auth_source="${CODEX_AUTH_SOURCE:-${HOME}/.sandcastle-secrets/codex-auth.json}"',
              'codex_home="${CODEX_HOME:-${HOME}/.codex}"',
              'mkdir -p "${codex_home}"',
              'cp "${codex_auth_source}" "${codex_home}/auth.json"',
              'chmod 600 "${codex_home}/auth.json"',
            ].join("; "),
          },
          {
            command: githubSandboxReadyCommands(githubConfigured).join("; "),
          },
          { command: "npm install" },
        ],
      },
    },
  };
};

export const createWorkerSandboxSettings = (
  issueId,
  environment = process.env,
  paths = {},
) => {
  const codexAuthPath = paths.codexAuthPath ?? "~/.codex/auth.json";
  const settings = createCodexSandboxSettings(codexAuthPath, {
    githubCredentialPath: paths.githubCredentialPath,
  });
  const allowedIssues = new Set(
    (environment.SANDCASTLE_REAL_CLAUDE_ISSUES ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!allowedIssues.has(String(issueId))) {
    return settings;
  }
  settings.docker.mounts.push(
    {
      hostPath: paths.claudeCredentialPath ?? "~/.claude/.credentials.json",
      sandboxPath: "/home/agent/.sandcastle-secrets/claude-credentials.json",
      readonly: true,
    },
    {
      hostPath: paths.claudeExecutablePath ?? "~/.local/bin/claude",
      sandboxPath: "/home/agent/.local/bin/claude",
      readonly: true,
    },
  );
  settings.docker.env = {
    ...settings.docker.env,
    PATH: [
      "/home/agent/.local/bin",
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ].join(":"),
  };
  settings.hooks.sandbox.onSandboxReady.splice(-1, 0, {
    command: [
      "set -eu",
      'claude_credential_source="${CLAUDE_CREDENTIAL_SOURCE:-${HOME}/.sandcastle-secrets/claude-credentials.json}"',
      'claude_home="${CLAUDE_HOME:-${HOME}/.claude}"',
      'mkdir -p "${claude_home}"',
      'cp "${claude_credential_source}" "${claude_home}/.credentials.json"',
      'chmod 600 "${claude_home}/.credentials.json"',
    ].join("; "),
  });
  return settings;
};

/** @returns {{ logging?: { type: "stdout" } }} */
export const createRunSettings = (args = process.argv.slice(2)) =>
  args.includes("--stdout") ? { logging: { type: "stdout" } } : {};
