import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";

const adapterProtocol = "1.0.0";
const adapterId = "conformance-harness-adapter-v1";
const capabilities = ["harness.launch.prepare.v1", "harness.run.v1"];
const launchParameters = {"kind":"fields","fields":[{"name":"issueNumber","label":"Issue number","description":"Optional GitHub issue identifier for the conformance run.","cliFlag":"--issue","required":false,"valueType":"integer","minimum":1,"maximum":999999999},{"name":"targetBranch","label":"Target branch","description":"Optional sandcastle branch associated with the issue.","cliFlag":"--target-branch","required":false,"valueType":"string","minLength":1,"maxLength":128}]};
const writeFrame = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  writeSync(3, header);
  writeSync(3, body);
};
const normalizeParameters = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bounded_configuration_invalid");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "issueNumber" && key !== "targetBranch")) {
    throw new Error("bounded_configuration_invalid");
  }
  if (keys.length === 0) {
    return {
      issueNumber: null,
      targetBranch: null,
      placeholderIdentifier: `conformance-placeholder-${randomBytes(12).toString("hex")}`,
    };
  }
  let issueNumber = value.issueNumber;
  let targetBranch = value.targetBranch;
  if (issueNumber === undefined && typeof targetBranch === "string") {
    const matchedIssue = /^sandcastle\/issue-([1-9][0-9]*)$/.exec(targetBranch);
    issueNumber = matchedIssue ? Number(matchedIssue[1]) : null;
  }
  if (
    !Number.isSafeInteger(issueNumber)
    || issueNumber < 1
    || issueNumber > 999999999
  ) {
    throw new Error("bounded_configuration_invalid");
  }
  targetBranch ??= `sandcastle/issue-${issueNumber}`;
  if (targetBranch !== `sandcastle/issue-${issueNumber}`) {
    throw new Error("bounded_configuration_invalid");
  }
  return { issueNumber, targetBranch, placeholderIdentifier: null };
};
const [command, encodedParameters] = process.argv.slice(2);
if (command === "probe") {
  writeFrame({
    type: "harness.adapter.probe",
    adapterProtocol,
    adapterId,
    capabilities,
    launchParameters,
  });
} else if (command === "prepare") {
  let parameters;
  try {
    parameters = JSON.parse(Buffer.from(encodedParameters ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("bounded_configuration_invalid");
  }
  const normalized = normalizeParameters(parameters);
  writeFrame({
    type: "harness.launch.prepared",
    adapterProtocol,
    adapterId,
    negotiatedCapabilities: ["harness.launch.prepare.v1"],
    suppliedCapabilities: ["github.issues.read", "project.git.read"],
    sanitizedPreview: {
      summary: normalized.placeholderIdentifier
        ? `Delegate generated conformance work ${normalized.placeholderIdentifier} using the pinned Harness.`
        : `Delegate GitHub issue #${normalized.issueNumber} on ${normalized.targetBranch} using the pinned conformance Harness.`,
      secretFree: true,
    },
    sideEffects: {
      delegatedWorkStarted: false,
      projectWrite: false,
      harnessWorkspaceWrite: false,
    },
  });
} else if (command === "run") {
  let execution;
  try {
    execution = JSON.parse(Buffer.from(encodedParameters ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("bounded_configuration_invalid");
  }
  if (!/^harness-run-[a-f0-9]{24}$/.test(execution?.harnessRunId ?? "")) {
    throw new Error("bounded_configuration_invalid");
  }
  const normalized = normalizeParameters(execution.parameters);
  const now = () => new Date().toISOString();
  if (normalized.issueNumber === 999999992) {
    const descendant = spawn(process.execPath, ["--eval", "process.on('SIGTERM', () => undefined); process.send?.('ready'); setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await new Promise((resolve, reject) => {
      descendant.once("message", resolve);
      descendant.once("error", reject);
    });
    descendant.disconnect();
    descendant.unref();
  }
  const handleCancellation = () => {
    writeFrame({
      type: "harness.run.terminal",
      adapterProtocol,
      adapterId,
      harnessRunId: execution.harnessRunId,
      terminalId: `harness-terminal-${"4".repeat(24)}`,
      status: "cancelled",
      completedAt: now(),
      result: { kind: "conformance-cancellation" },
    });
    process.exit(0);
  };
  const handleCancellationRequest = (message) => {
    if (
      message?.type !== "harness.run.cancel"
      || message.adapterProtocol !== adapterProtocol
      || message.adapterId !== adapterId
      || message.harnessRunId !== execution.harnessRunId
      || !Number.isFinite(Date.parse(message.cooperativeDeadlineAt ?? ""))
    ) {
      return;
    }
    handleCancellation();
  };
  if (normalized.issueNumber === 999999994) {
    process.on("SIGTERM", () => undefined);
    process.on("message", () => undefined);
  } else {
    process.once("SIGTERM", handleCancellation);
    process.once("message", handleCancellationRequest);
  }
  process.channel?.unref();
  process.stdout.write(
    normalized.placeholderIdentifier
      ? `Conformance diagnostic stdout for ${normalized.placeholderIdentifier}.\n`
      : `Conformance diagnostic stdout for issue #${normalized.issueNumber}.\n`,
  );
  process.stderr.write(
    normalized.placeholderIdentifier
      ? "Conformance diagnostic stderr for generated work.\n"
      : `Conformance diagnostic stderr for ${normalized.targetBranch}.\n`,
  );
  writeFrame({
    type: "harness.run.ready",
    adapterProtocol,
    adapterId,
    harnessRunId: execution.harnessRunId,
    capabilities: ["harness.run.v1"],
    readyAt: now(),
  });
  if (normalized.issueNumber === 999999999) {
    process.stdout.write("SUCCESS: process exited cleanly without a terminal envelope.\n");
  } else {
    const progressRecordCount = normalized.issueNumber === 999999997 ? 1023 : 1;
    if (progressRecordCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    for (let index = 0; index < progressRecordCount; index += 1) {
      writeFrame({
        type: "harness.run.progress",
        adapterProtocol,
        adapterId,
        harnessRunId: execution.harnessRunId,
        record: {
          recordId: normalized.issueNumber === 999999997
            ? `progress-${index.toString(16).padStart(24, "0")}`
            : `progress-${"1".repeat(24)}`,
          schemaVersion: "1.0.0",
          type: "conformance.step",
          parentRecordId: normalized.issueNumber === 999999998
            ? `progress-${"9".repeat(24)}`
            : null,
          label: "Exercise approved conformance Launch",
          summary: "The deterministic conformance workflow crossed its pinned adapter boundary.",
          status: "complete",
          timestamp: now(),
          payload: normalized.placeholderIdentifier
            ? { placeholderIdentifier: normalized.placeholderIdentifier, index }
            : { issueNumber: normalized.issueNumber, index },
        },
      });
    }
    if (progressRecordCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    if ([999999993, 999999994].includes(normalized.issueNumber)) {
      // These reserved packaged-Cockpit fixtures remain live until the
      // selected run is cancelled. The latter deliberately ignores
      // cooperative cancellation so complete-tree forced termination can be
      // reached without depending on browser polling speed.
      setInterval(() => undefined, 1000);
    } else {
      const terminal = {
        type: "harness.run.terminal",
        adapterProtocol,
        adapterId,
        harnessRunId: execution.harnessRunId,
        terminalId: `harness-terminal-${"2".repeat(24)}`,
        status: "succeeded",
        completedAt: now(),
        result: normalized.placeholderIdentifier ? {
          kind: "conformance-result",
          placeholderIdentifier: normalized.placeholderIdentifier,
        } : {
          kind: "conformance-result",
          issueNumber: normalized.issueNumber,
          targetBranch: normalized.targetBranch,
        },
      };
      if (normalized.issueNumber === 999999995) {
        writeFrame({ ...terminal, terminalId: "invalid-terminal-id" });
      } else {
        writeFrame(terminal);
        if (normalized.issueNumber === 999999996) {
          writeFrame({
            ...terminal,
            terminalId: `harness-terminal-${"3".repeat(24)}`,
          });
        }
      }
    }
  }
} else {
  throw new Error("harness_adapter_command_invalid");
}
