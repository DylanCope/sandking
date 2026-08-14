#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { hostIdPattern } from "./common/identifiers.mjs";
import { runRuntimeDaemon } from "./daemon/index.mjs";
import {
  HOST_SCHEMA_DIGEST,
  hostCapabilities,
  protocolVersion,
} from "./protocol.mjs";

/** @param {string[]} argv */
const parseArgs = (argv) => {
  /** @type {{dataDir?: string, expectedHostId?: string, allowHostIdentityCreate?: boolean, lifecycleRevision?: number, startupId?: string, browserSessionTtlMs?: number}} */
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--data-dir") {
      result.dataDir = argv[index + 1];
      index += 1;
    } else if (current === "--expected-host-id") {
      result.expectedHostId = argv[index + 1];
      index += 1;
    } else if (current === "--allow-host-identity-create") {
      result.allowHostIdentityCreate = true;
    } else if (current === "--lifecycle-revision") {
      result.lifecycleRevision = Number(argv[index + 1]);
      index += 1;
    } else if (current === "--startup-id") {
      result.startupId = argv[index + 1];
      index += 1;
    } else if (current === "--browser-session-ttl-ms") {
      result.browserSessionTtlMs = Number(argv[index + 1]);
      index += 1;
    }
  }
  if (!result.dataDir) throw new Error("runtime_data_dir_missing");
  if (!result.expectedHostId || !hostIdPattern.test(result.expectedHostId)) {
    throw new Error("runtime_expected_host_id_missing");
  }
  if (!Number.isSafeInteger(result.lifecycleRevision) || Number(result.lifecycleRevision) < 1) {
    throw new Error("runtime_lifecycle_revision_missing");
  }
  if (!result.startupId || !/^[a-f0-9]{24}$/.test(result.startupId)) {
    throw new Error("runtime_startup_id_missing");
  }
  if (
    !Number.isSafeInteger(result.browserSessionTtlMs)
    || Number(result.browserSessionTtlMs) < 1
    || Number(result.browserSessionTtlMs) > 15 * 60_000
  ) {
    throw new Error("runtime_browser_session_ttl_missing");
  }
  return /** @type {{dataDir: string, expectedHostId: string, allowHostIdentityCreate?: boolean, lifecycleRevision: number, startupId: string, browserSessionTtlMs: number}} */ (result);
};

const args = parseArgs(process.argv.slice(2));

const main = async () => {
  const localHostPath = fileURLToPath(new URL("./local-host.mjs", import.meta.url));
  const hostArgs = [localHostPath, "--data-dir", args.dataDir];
  if (args.allowHostIdentityCreate) {
    hostArgs.push("--allow-host-identity-create");
  }

  {
    const controllerProtocol = protocolVersion;
    const controllerRequiredCapabilities = [...hostCapabilities];
    const controllerSchemaDigest = HOST_SCHEMA_DIGEST;

    await runRuntimeDaemon({
      args,
      hostArgs,
      controllerProtocol,
      controllerRequiredCapabilities,
      controllerSchemaDigest,
      protocolVersion,
      hostCapabilities,
      hostSchemaDigest: HOST_SCHEMA_DIGEST,
    });
  }
};

await main();
