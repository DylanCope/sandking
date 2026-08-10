#!/usr/bin/env node

// Test-only driver for Host negotiation and timing fixtures. It copies the
// production runtime into Host-private test state, instruments only that copy,
// and never adds a fault option to an installed production command.
import { loadTestHostModeRuntime } from "./host-mode-runtime.mjs";

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
if (!options.hostMode || !options.dataDir) {
  throw new Error("test_host_mode_driver_mode_missing");
}

const { RuntimeStartupError, launchRuntime } = await loadTestHostModeRuntime({
  dataDir: options.dataDir,
  hostMode: options.hostMode,
});

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
