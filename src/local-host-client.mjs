import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalHostTransport } from "./daemon/host-transport/local.mjs";
import {
  acceptControllerHostBinding,
  prepareControllerHostBinding,
} from "./host-identity.mjs";
import { createHostOperationAuditRecorder } from "./host-audit.mjs";
import { withPrivateStateLock } from "./private-state-lock.mjs";
import {
  HOST_SCHEMA_DIGEST,
  hostCapabilities,
  protocolVersion,
} from "./protocol.mjs";

const localHostPath = fileURLToPath(new URL("./local-host.mjs", import.meta.url));

/**
 * Run a bounded group of local control operations through the shipped Host
 * process. Independent CLI processes share this lock, so an inspect followed
 * by its revisioned mutation remains one person-facing action.
 *
 * @template T
 * @param {string} dataDir
 * @param {(request: (message: any) => Promise<any>) => Promise<T>} operation
 * @returns {Promise<T>}
 */
export const withLocalHostControl = async (dataDir, operation) =>
  withPrivateStateLock(join(dataDir, "local-host-client.lock"), async () => {
    const binding = await prepareControllerHostBinding(dataDir);
    const runtimeId = `runtime-${randomBytes(12).toString("hex")}`;
    const transport = createLocalHostTransport({
      args: {
        allowHostIdentityCreate: binding.allowHostIdentityCreate,
        dataDir,
        expectedHostId: binding.hostId,
        startupId: `local-control-${randomBytes(12).toString("hex")}`,
      },
      controllerProtocol: protocolVersion,
      controllerRequiredCapabilities: [...hostCapabilities],
      controllerSchemaDigest: HOST_SCHEMA_DIGEST,
      hostArgs: [
        localHostPath,
        "--data-dir", dataDir,
        ...(binding.allowHostIdentityCreate ? ["--allow-host-identity-create"] : []),
      ],
      credentialOperationsOnly: true,
      hostCapabilities,
      hostSchemaDigest: HOST_SCHEMA_DIGEST,
      protocolVersion,
      recordAudit: createHostOperationAuditRecorder(dataDir),
      state: null,
    });
    try {
      await transport.launchHost(runtimeId);
      await acceptControllerHostBinding(dataDir, binding.hostId);
      return await operation(transport.requestHostOperation);
    } finally {
      await transport.stopHost();
    }
  }, {
    timeoutMs: 60_000,
    timeoutCode: "local_host_control_lock_timeout",
  });
