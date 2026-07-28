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

/** @returns {{ logging?: { type: "stdout" } }} */
export const createRunSettings = (args = process.argv.slice(2)) =>
  args.includes("--stdout") ? { logging: { type: "stdout" } } : {};
