#!/usr/bin/env node

// Test-only driver for the pre-existing Host negotiation and timing fixtures.
// The installed production command deliberately has no Host fault-mode option.
import { RuntimeStartupError, launchRuntime } from "../src/runtime.mjs";

const argv = process.argv.slice(2);
if (argv[0] !== "launch") {
  throw new Error("test_host_mode_driver_only_supports_launch");
}

/** @type {{dataDir?: string, hostMode?: string, startupTimeoutMs?: number, bootstrapTtlMs?: number, browserSessionTtlMs?: number, idempotencyKey?: string, expectedRevision?: number}} */
const options = {};
for (let index = 1; index < argv.length; index += 1) {
  const current = argv[index];
  if (current === "--data-dir") {
    options.dataDir = argv[++index];
  } else if (current === "--host-mode") {
    options.hostMode = argv[++index];
  } else if (current === "--startup-timeout-ms") {
    options.startupTimeoutMs = Number(argv[++index]);
  } else if (current === "--bootstrap-ttl-ms") {
    options.bootstrapTtlMs = Number(argv[++index]);
  } else if (current === "--browser-session-ttl-ms") {
    options.browserSessionTtlMs = Number(argv[++index]);
  } else if (current === "--idempotency-key") {
    options.idempotencyKey = argv[++index];
  } else if (current === "--expected-revision") {
    options.expectedRevision = Number(argv[++index]);
  } else if (current !== "--json" && current !== "--no-open") {
    throw new Error(`test_host_mode_driver_option_unsupported:${current}`);
  }
}
if (!options.hostMode) {
  throw new Error("test_host_mode_driver_mode_missing");
}

try {
  const output = await launchRuntime(options);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  if (error instanceof RuntimeStartupError) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      diagnosis: error.diagnosis,
    })}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
