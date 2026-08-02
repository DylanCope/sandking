import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { classifyClaudeStopFailure } from "../src/claude-provider-adapter.mjs";

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
  process.stdout.write("Usage: claude [options]\\n  --session-id <uuid>\\n  --plugin-dir <path>\\n");
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
        "controller.work-context.inspect",
        "controller.launch-request.prepare",
        "controller.launch-request.decide",
        "controller.harness-run.start",
        "controller.session.stable-identity",
        "controller.session.typed-exit",
      ],
      terminal: {
        ptyRequired: true,
        runtimeOwnershipRequired: true,
      },
      integration: {
        pluginId: "sandking-controller",
        pluginVersion: "1.0.0",
        scope: "session",
        loading: "--plugin-dir",
        boundary: "session-plugin-private-typed-shim",
        credentialsTransferred: false,
      },
    });
    assert.doesNotMatch(stdout, /probe-secret-must-not-be-used/);
  } finally {
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

test("the Claude adapter prepares a stable plugin-backed session with a sanitized environment", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-prepare-"));
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("2.1.141 (Claude Code)\\n");
else if (args[0] === "--help") {
  process.stdout.write("--session-id <uuid> --plugin-dir <path>\\n");
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
    assert.equal(prepared.command.environment.SANDKING_CLAUDE_SESSION_ID, providerSessionId);
    assert.equal(prepared.command.environment.SANDKING_CONTROLLER_SESSION_ID, sessionId);
    assert.equal(prepared.command.environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(prepared.command.environment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(prepared.command.environment.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(prepared.command.environment.NODE_OPTIONS, undefined);
    assert.match(prepared.integration.pluginDirectory,
      /src\/claude-controller-plugin$/);
    assert.equal(prepared.integration.scope, "session");
    assert.equal(prepared.integration.loading, "--plugin-dir");
    assert.equal(prepared.integration.boundary, "session-plugin-private-typed-shim");
    assert.deepEqual(prepared.command.providerArgs, [
      "--session-id", providerSessionId,
      "--plugin-dir", prepared.integration.pluginDirectory,
    ]);
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
    [{ error: "server_error" }, "provider_outage", true],
    [{ error: "network_error" }, "provider_network_unavailable", true],
    [{ error: "unknown", error_details: "DNS lookup failed" },
      "provider_network_unavailable", true],
    [{ error: "max_output_tokens" }, "provider_model_behavior_unconfirmed", true],
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
else if (args[0] === "--help") process.stdout.write("--session-id <uuid> --plugin-dir <path>\\n");
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
    assert.equal(unauthenticated.capabilities.length, 9);
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
else if (args[0] === "--help") process.stdout.write("--session-id <uuid> --plugin-dir <path>\\n");
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
