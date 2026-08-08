import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  classifyClaudeStopFailure,
  probeClaude,
} from "../src/claude-provider-adapter.mjs";

const execFileAsync = promisify(execFile);
const adapterPath = fileURLToPath(new URL("../src/claude-provider-adapter.mjs", import.meta.url));

test("the Claude adapter probes destination-local CLI readiness without invoking a model", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-probe-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.141 (Claude Code)\\n");
} else if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("Usage: claude [options]\\n  --session-id <uuid>\\n  --settings <json>\\n  --plugin-dir <path>\\n");
} else if (args[0] === "plugin" && args[1] === "validate" && args.at(-1) === "--strict") {
  process.stdout.write("Validated plugin\\n");
} else if (args[0] === "--plugin-dir" && args.slice(2).join(" ") === "plugin list --json") {
  process.stdout.write(JSON.stringify([{ name: "sandking-controller", version: "1.0.0" }]));
} else if (args.join(" ") === "auth status") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
} else {
  process.stderr.write("model invocation is prohibited in adapter probe tests\\n");
  process.exitCode = 97;
}
`, { mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [adapterPath, "probe"],
      {
        env: {
          LANG: "C.UTF-8",
          PATH: process.env.PATH,
          SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
          ANTHROPIC_API_KEY: "probe-secret-must-not-be-used",
        },
      },
    );
    assert.equal(stderr, "");
    const probe = JSON.parse(stdout);
    assert.deepEqual(probe, {
      type: "provider.adapter.probe",
      adapterProtocol: { major: 1, minor: 0, patch: 0, version: "1.0.0" },
      adapterId: "claude-code-controller-adapter-v1",
      provider: {
        providerId: "claude-code",
        kind: "production",
        fixture: false,
      },
      availability: {
        status: "available",
        command: "claude",
        version: "2.1.141",
        authentication: {
          status: "authenticated",
          source: "destination-local",
        },
        failure: null,
      },
      capabilities: [
        "controller.session.start",
        "controller.session.interactive",
        "controller.session.terminate",
        "controller.harness-run.launch",
        "controller.harness-run.cancel",
        "controller.session.stable-identity",
        "controller.session.typed-exit",
      ],
      terminal: {
        ptyRequired: true,
        runtimeOwnershipRequired: true,
      },
    });
    assert.doesNotMatch(stdout, /probe-secret-must-not-be-used/);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter accepts the native CLI without plugin support", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-native-probe-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await writeFile(fakeClaudePath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.220 (Claude Code)'
elif [ "$1" = "--help" ]; then
  printf '%s\\n' '--session-id <uuid> --settings <json> --plugin-dir <path>'
elif [ "$1" = "plugin" ] && [ "$2" = "validate" ] && [ "$4" = "--strict" ]; then
  grep -q '"author"' "$3/.claude-plugin/plugin.json"
elif [ "$1" = "--plugin-dir" ] && [ "$3" = "plugin" ] && [ "$4" = "list" ] && [ "$5" = "--json" ]; then
  printf '%s' '[{"id":"sandking-controller@inline","version":"1.0.0","scope":"session","enabled":true}]'
elif [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s' '{"loggedIn":true,"authMethod":"claude.ai"}'
else
  exit 97
fi
`, { mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);

  const previousExecutable = process.env.SANDKING_CLAUDE_EXECUTABLE;
  try {
    process.env.SANDKING_CLAUDE_EXECUTABLE = fakeClaudePath;
    const probe = await probeClaude();
    assert.equal(probe.availability.status, "available", JSON.stringify(probe));
    assert.equal(probe.availability.version, "2.1.220");
    assert.equal(probe.availability.authentication.status, "authenticated");
    assert.equal("integration" in probe, false);
  } finally {
    if (previousExecutable === undefined) delete process.env.SANDKING_CLAUDE_EXECUTABLE;
    else process.env.SANDKING_CLAUDE_EXECUTABLE = previousExecutable;
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter does not advertise capabilities an installed CLI cannot prove", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-incompatible-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.141 (Claude Code)\\n");
} else if (args.join(" ") === "auth status") {
  process.stdout.write('{"loggedIn":true}');
} else {
  process.stderr.write("unsupported CLI surface\\n");
  process.exitCode = 97;
}
`, { mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);

  try {
    const probe = JSON.parse((await execFileAsync(process.execPath, [adapterPath, "probe"], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
      },
    })).stdout);
    assert.equal(probe.availability.status, "unavailable");
    assert.deepEqual(probe.availability.failure, {
      code: "provider_cli_incompatible",
      retryable: false,
    });
    assert.deepEqual(probe.capabilities, []);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter requires the notification-only typed-failure settings surface", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-no-settings-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.141 (Claude Code)\\n");
} else if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("--session-id <uuid>\\n");
} else if (args.join(" ") === "auth status") {
  process.stdout.write('{"loggedIn":true}');
} else {
  process.exitCode = 97;
}
`, { mode: 0o700 });

  try {
    const probe = JSON.parse((await execFileAsync(process.execPath, [adapterPath, "probe"], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
      },
    })).stdout);
    assert.equal(probe.availability.status, "unavailable");
    assert.deepEqual(probe.availability.failure, {
      code: "provider_cli_incompatible",
      retryable: false,
    });
    assert.deepEqual(probe.capabilities, [
      "controller.session.start",
      "controller.session.interactive",
      "controller.session.terminate",
      "controller.harness-run.launch",
      "controller.harness-run.cancel",
      "controller.session.stable-identity",
    ]);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter requires a CLI version that implements StopFailure hooks", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-no-stop-failure-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.77 (Claude Code)\\n");
} else if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("--session-id <uuid> --settings <json>\\n");
} else if (args.join(" ") === "auth status") {
  process.stdout.write('{"loggedIn":true}');
} else {
  process.exitCode = 97;
}
`, { mode: 0o700 });

  try {
    const probe = JSON.parse((await execFileAsync(process.execPath, [adapterPath, "probe"], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
      },
    })).stdout);
    assert.equal(probe.availability.status, "unavailable");
    assert.deepEqual(probe.availability.failure, {
      code: "provider_cli_incompatible",
      retryable: false,
    });
    assert.deepEqual(probe.capabilities, [
      "controller.session.start",
      "controller.session.interactive",
      "controller.session.terminate",
      "controller.harness-run.launch",
      "controller.harness-run.cancel",
      "controller.session.stable-identity",
    ]);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter ignores unrelated plugin inventory", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-inventory-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.141 (Claude Code)\\n");
} else if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("--session-id <uuid> --settings <json> --plugin-dir <path>\\n");
} else if (args[0] === "plugin" && args[1] === "validate" && args.at(-1) === "--strict") {
  process.stdout.write("Validated plugin\\n");
} else if (args[0] === "--plugin-dir" && args.slice(2).join(" ") === "plugin list --json") {
  process.stdout.write(JSON.stringify([{
    name: "unrelated-plugin",
    version: "9.9.9",
    description: "mentions sandking-controller and 1.0.0 but is not that plugin",
  }]));
} else if (args.join(" ") === "auth status") {
  process.stdout.write('{"loggedIn":true}');
} else {
  process.exitCode = 97;
}
`, { mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);

  try {
    const probe = JSON.parse((await execFileAsync(process.execPath, [adapterPath, "probe"], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
      },
    })).stdout);
    assert.equal(probe.availability.status, "available");
    assert.deepEqual(probe.capabilities, [
      "controller.session.start",
      "controller.session.interactive",
      "controller.session.terminate",
      "controller.harness-run.launch",
      "controller.harness-run.cancel",
      "controller.session.stable-identity",
      "controller.session.typed-exit",
    ]);
    assert.equal("integration" in probe, false);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter does not invoke plugin validation", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-validation-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.141 (Claude Code)\\n");
} else if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("--session-id <uuid> --settings <json> --plugin-dir <path>\\n");
} else if (args[0] === "plugin" && args[1] === "validate") {
  process.stderr.write("plugin validation failed\\n");
  process.exitCode = 96;
} else if (args[0] === "--plugin-dir" && args.slice(2).join(" ") === "plugin list --json") {
  process.stdout.write('[{"name":"sandking-controller","version":"1.0.0"}]');
} else if (args.join(" ") === "auth status") {
  process.stdout.write('{"loggedIn":true}');
} else {
  process.exitCode = 97;
}
`, { mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);

  try {
    const probe = JSON.parse((await execFileAsync(process.execPath, [adapterPath, "probe"], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
      },
    })).stdout);
    assert.equal(probe.availability.status, "available");
    assert.deepEqual(probe.capabilities, [
      "controller.session.start",
      "controller.session.interactive",
      "controller.session.terminate",
      "controller.harness-run.launch",
      "controller.harness-run.cancel",
      "controller.session.stable-identity",
      "controller.session.typed-exit",
    ]);
    assert.equal("integration" in probe, false);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter prepares a stable plugin-free session with a sanitized environment", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-prepare-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("2.1.141 (Claude Code)\\n");
else if (args[0] === "--help") {
  process.stdout.write("--session-id <uuid> --settings <json> --plugin-dir <path>\\n");
} else if (args[0] === "plugin" && args[1] === "validate" && args.at(-1) === "--strict") {
  process.stdout.write("Validated plugin\\n");
} else if (args[0] === "--plugin-dir" && args.slice(2).join(" ") === "plugin list --json") {
  process.stdout.write('[{"name":"sandking-controller","version":"1.0.0"}]');
} else if (args.join(" ") === "auth status") process.stdout.write('{"loggedIn":true}');
else process.exitCode = 97;
`, { mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);
  const providerSessionId = "550e8400-e29b-41d4-a716-446655440000";
  const sessionId = `controller-session-${"1".repeat(24)}`;
  const projectId = `project-${"2".repeat(24)}`;

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      adapterPath,
      "prepare",
      "--session-id", sessionId,
      "--provider-session-id", providerSessionId,
      "--work-context-id", projectId,
      "--canonical-reference", `sandking:project:${projectId}`,
      "--control-endpoint", join(fixtureDirectory, "control.sock"),
    ], {
      env: {
        HOME: fixtureDirectory,
        PATH: process.env.PATH,
        LANG: "en_US.UTF-8",
        SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
        ANTHROPIC_API_KEY: "api-secret-must-be-stripped",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-must-be-stripped",
        AWS_SECRET_ACCESS_KEY: "cloud-secret-must-be-stripped",
        NODE_OPTIONS: "--no-warnings",
      },
    });
    const prepared = JSON.parse(stdout);
    assert.equal(prepared.type, "provider.session.prepared");
    assert.equal(prepared.adapterId, "claude-code-controller-adapter-v1");
    assert.equal(prepared.providerSessionId, providerSessionId);
    assert.equal(prepared.sessionIdentity.stable, true);
    assert.equal(prepared.sessionIdentity.source, "controller-assigned-supported-cli-flag");
    assert.equal(prepared.command.executable, process.execPath);
    assert.equal(prepared.command.args[0], adapterPath);
    assert.equal(prepared.command.args[1], "run");
    assert.equal(prepared.command.environment.HOME, fixtureDirectory);
    assert.equal(prepared.command.environment.SANDKING_CLAUDE_EXECUTABLE, fakeClaudePath);
    assert.equal(prepared.command.environment.SANDKING_CLAUDE_SESSION_ID, undefined);
    assert.equal(prepared.command.environment.SANDKING_CONTROLLER_SESSION_ID, undefined);
    assert.equal(prepared.command.environment.TERM, "xterm-256color");
    assert.equal(prepared.command.environment.COLORTERM, "truecolor");
    assert.equal(prepared.command.environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(prepared.command.environment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(prepared.command.environment.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(prepared.command.environment.NODE_OPTIONS, undefined);
    assert.deepEqual(prepared.command.providerArgs, [
      "--session-id", providerSessionId,
    ]);
    assert.equal("integration" in prepared, false);
    assert.doesNotMatch(JSON.stringify(prepared), /plugin|hook|skill/i);
    assert.doesNotMatch(stdout,
      /api-secret-must-be-stripped|oauth-secret-must-be-stripped|cloud-secret-must-be-stripped|--no-warnings/);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter keeps provider failures distinct from adapter failure", () => {
  const cases = [
    [{ error: "authentication_failed" }, "provider_authentication_failed", false],
    [{ error: "oauth_org_not_allowed" }, "provider_authentication_failed", false],
    [{ error: "rate_limit" }, "provider_quota_unavailable", true],
    [{ error: "billing_error" }, "provider_quota_unavailable", false],
    [{ error: "overloaded" }, "provider_outage", true],
    [{ type: "overloaded" }, "provider_outage", true],
    [{ error: "server_error" }, "provider_outage", true],
    [{ error: "network_error" }, "provider_network_unavailable", true],
    [{ error: "unknown", error_details: "DNS lookup failed" },
      "provider_network_unavailable", true],
    [{ error: "max_output_tokens" }, "provider_model_behavior_unconfirmed", true],
    [{ error: "model_not_found" }, "provider_model_behavior_unconfirmed", false],
    [{ error: "invalid_request" }, "provider_model_behavior_unconfirmed", false],
    [{ error: "unknown", error_details: "unexpected model response" },
      "provider_model_behavior_unconfirmed", true],
    [{ error: "invented_failure", credential: "must-not-be-retained" },
      "provider_adapter_failed", true],
  ];
  for (const [input, code, retryable] of cases) {
    assert.deepEqual(classifyClaudeStopFailure(input), {
      code,
      retryable,
      source: code === "provider_adapter_failed"
        ? "sandking-adapter"
        : "claude-stop-failure",
    });
  }
});

test("the Claude adapter reports missing CLI and destination-local authentication distinctly", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-unavailable-"));
  const unauthenticatedClaude = join(fixtureDirectory, "claude");
  await writeFile(unauthenticatedClaude, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("2.1.141 (Claude Code)\\n");
else if (args[0] === "--help") process.stdout.write("--session-id <uuid> --settings <json> --plugin-dir <path>\\n");
else if (args[0] === "plugin" && args[1] === "validate" && args.at(-1) === "--strict") {
  process.stdout.write("Validated plugin\\n");
}
else if (args[0] === "--plugin-dir" && args.slice(2).join(" ") === "plugin list --json") {
  process.stdout.write('[{"name":"sandking-controller","version":"1.0.0"}]');
} else if (args.join(" ") === "auth status") {
  process.stdout.write('{"loggedIn":false}');
  process.exitCode = 1;
} else process.exitCode = 97;
`, { mode: 0o700 });
  await chmod(unauthenticatedClaude, 0o700);
  try {
    const missing = JSON.parse((await execFileAsync(process.execPath, [adapterPath, "probe"], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CLAUDE_EXECUTABLE: join(fixtureDirectory, "not-installed"),
      },
    })).stdout);
    const unauthenticated = JSON.parse((await execFileAsync(
      process.execPath,
      [adapterPath, "probe"],
      {
        env: {
          HOME: fixtureDirectory,
          LANG: "C.UTF-8",
          PATH: process.env.PATH,
          SANDKING_CLAUDE_EXECUTABLE: unauthenticatedClaude,
        },
      },
    )).stdout);
    assert.deepEqual(missing.availability, {
      status: "unavailable",
      command: "claude",
      version: null,
      authentication: { status: "unknown", source: "destination-local" },
      failure: { code: "provider_cli_unavailable", retryable: true },
    });
    assert.deepEqual(missing.capabilities, []);
    assert.deepEqual(unauthenticated.availability, {
      status: "unauthenticated",
      command: "claude",
      version: "2.1.141",
      authentication: { status: "missing", source: "destination-local" },
      failure: { code: "provider_authentication_missing", retryable: false },
    });
    assert.equal(unauthenticated.capabilities.length, 7);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter reports auth probe failures as adapter failures", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-auth-probe-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  const writeFixture = (mode) => writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
const authProbeMode = ${JSON.stringify(mode)};
if (args[0] === "--version") process.stdout.write("2.1.141 (Claude Code)\\n");
else if (args[0] === "--help") process.stdout.write("--session-id <uuid> --settings <json> --plugin-dir <path>\\n");
else if (args[0] === "plugin" && args[1] === "validate" && args.at(-1) === "--strict") {
  process.stdout.write("Validated plugin\\n");
}
else if (args[0] === "--plugin-dir" && args.slice(2).join(" ") === "plugin list --json") {
  process.stdout.write('[{"name":"sandking-controller","version":"1.0.0"}]');
} else if (args.join(" ") === "auth status") {
  if (authProbeMode === "malformed") process.stdout.write('{"loggedIn":');
  else if (authProbeMode === "invalid-response") process.stdout.write('{"loggedIn":"yes"}');
  else if (authProbeMode === "execution-error") process.exitCode = 2;
  else if (authProbeMode === "timeout") setTimeout(() => undefined, 10_000);
  else process.exitCode = 97;
} else process.exitCode = 97;
`, { mode: 0o700 });

  try {
    for (const mode of ["malformed", "invalid-response", "execution-error", "timeout"]) {
      await writeFixture(mode);
      await chmod(fakeClaudePath, 0o700);
      const probe = JSON.parse((await execFileAsync(process.execPath, [adapterPath, "probe"], {
        env: {
          LANG: "C.UTF-8",
          PATH: process.env.PATH,
          SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
        },
      })).stdout);
      assert.deepEqual(probe.availability, {
        status: "unavailable",
        command: "claude",
        version: "2.1.141",
        authentication: { status: "unknown", source: "destination-local" },
        failure: { code: "provider_adapter_failed", retryable: true },
      }, mode);
      assert.equal(probe.capabilities.length, 7, mode);
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the Claude adapter entry point executes from a URL-encoded filesystem path", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-path-"));
  const copiedAdapterPath = join(fixtureDirectory, "adapter with spaces.mjs");
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await copyFile(adapterPath, copiedAdapterPath);
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("2.1.141 (Claude Code)\\n");
else if (args[0] === "--help") process.stdout.write("--session-id <uuid> --settings <json> --plugin-dir <path>\\n");
else if (args[0] === "plugin" && args[1] === "validate" && args.at(-1) === "--strict") {
  process.stdout.write("Validated plugin\\n");
}
else if (args[0] === "--plugin-dir" && args.slice(2).join(" ") === "plugin list --json") {
  process.stdout.write('[{"name":"sandking-controller","version":"1.0.0"}]');
} else if (args.join(" ") === "auth status") process.stdout.write('{"loggedIn":true}');
else process.exitCode = 97;
`, { mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);

  try {
    const { stdout } = await execFileAsync(process.execPath, [copiedAdapterPath, "probe"], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
      },
    });
    assert.equal(JSON.parse(stdout).availability.status, "available");
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
