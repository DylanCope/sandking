export const createCodexSandboxSettings = (
  hostAuthPath = "~/.codex/auth.json",
) => ({
  docker: {
    mounts: [
      {
        hostPath: hostAuthPath,
        sandboxPath: "/home/agent/.sandcastle-secrets/codex-auth.json",
        readonly: true,
      },
    ],
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
        { command: "npm install" },
      ],
    },
  },
});

export const createWorkerSandboxSettings = (
  issueId,
  environment = process.env,
  paths = {},
) => {
  const codexAuthPath = paths.codexAuthPath ?? "~/.codex/auth.json";
  const settings = createCodexSandboxSettings(codexAuthPath);
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
