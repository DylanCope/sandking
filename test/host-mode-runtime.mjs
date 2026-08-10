import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const replaceOnce = (source, anchor, replacement, label) => {
  if (source.split(anchor).length !== 2) {
    throw new Error(`test_host_mode_instrumentation_anchor_invalid:${label}`);
  }
  return source.replace(anchor, replacement);
};

const instrumentLocalHost = (initialSource) => {
  let source = initialSource;
  source = replaceOnce(
    source,
    "const parseArgs = (argv) => {\n  let dataDir = process.cwd();\n",
    "const parseArgs = (argv) => {\n  let mode = \"normal\";\n  let dataDir = process.cwd();\n",
    "host-mode-declaration",
  );
  source = replaceOnce(
    source,
    "    if (argv[index] === \"--data-dir\") {\n",
    "    if (argv[index] === \"--mode\") {\n"
      + "      mode = argv[index + 1] ?? mode;\n"
      + "      index += 1;\n"
      + "    } else if (argv[index] === \"--data-dir\") {\n",
    "host-mode-argument",
  );
  source = replaceOnce(
    source,
    "  return { dataDir, allowHostIdentityCreate };\n};\n\n"
      + "const { dataDir, allowHostIdentityCreate } = parseArgs(process.argv.slice(2));\n",
    "  return { mode, dataDir, allowHostIdentityCreate };\n};\n\n"
      + "const { mode, dataDir, allowHostIdentityCreate } = parseArgs(process.argv.slice(2));\n",
    "host-mode-result",
  );
  source = replaceOnce(
    source,
    "const rejectHandshake = (code) => {\n",
    "const writeMalformedFrame = () => {\n"
      + "  const header = Buffer.alloc(4);\n"
      + "  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);\n"
      + "  process.stdout.write(header);\n"
      + "};\n\n"
      + "const rejectHandshake = (code) => {\n",
    "malformed-frame-helper",
  );
  source = replaceOnce(
    source,
    "const main = async () => {\n  const hello = await readFrame(process.stdin);\n",
    "const main = async () => {\n"
      + "  if (mode === \"exit-before-ack\") {\n"
      + "    process.exitCode = 12;\n"
      + "    return;\n"
      + "  }\n\n"
      + "  const hello = await readFrame(process.stdin);\n",
    "exit-before-ack",
  );
  source = replaceOnce(
    source,
    "  if (hello.type !== \"hello\") {\n"
      + "    rejectHandshake(\"host_protocol_unexpected_message\");\n"
      + "    return;\n"
      + "  }\n\n",
    "  if (hello.type !== \"hello\") {\n"
      + "    rejectHandshake(\"host_protocol_unexpected_message\");\n"
      + "    return;\n"
      + "  }\n\n"
      + "  if (mode === \"hang-before-ack\") {\n"
      + "    await new Promise(() => {});\n"
      + "    return;\n"
      + "  }\n"
      + "  if (mode === \"delayed-ack\") {\n"
      + "    await new Promise((resolve) => setTimeout(resolve, 250));\n"
      + "  }\n\n",
    "pre-ack-timing",
  );
  source = replaceOnce(
    source,
    "  const major = protocolVersion.major;\n"
      + "  const identity = \"local-host\";\n"
      + "  const hostId = negotiatedHostId;\n"
      + "  const requiredCapabilities = [\"sandking.control.slice-1\"];\n",
    "  if (mode === \"malformed-frame\") {\n"
      + "    writeMalformedFrame();\n"
      + "    return;\n"
      + "  }\n\n"
      + "  const major = mode === \"incompatible-major\"\n"
      + "    ? protocolVersion.major + 1\n"
      + "    : protocolVersion.major;\n"
      + "  const identity = \"local-host\";\n"
      + "  const hostId = mode === \"unexpected-identity\"\n"
      + "    ? `host-${\"0\".repeat(24)}`\n"
      + "    : negotiatedHostId;\n"
      + "  const requiredCapabilities = mode === \"unknown-required-capability\"\n"
      + "    ? [\"sandking.control.slice-1\", \"sandking.future-required\"]\n"
      + "    : [\"sandking.control.slice-1\"];\n"
      + "  const secretLeaked = mode === \"secret-probe\"\n"
      + "    && typeof process.env.SANDKING_CONTROLLER_SECRET === \"string\";\n",
    "host-negotiation-modes",
  );
  source = replaceOnce(
    source,
    "    identity,\n    hostId,\n",
    "    identity: secretLeaked ? \"controller-secret-leaked\" : identity,\n    hostId,\n",
    "secret-probe",
  );
  source = replaceOnce(
    source,
    "  // The Host is a durable process boundary. It remains available after\n",
    "  let delayedHarnessRunLaunchResponse = false;\n"
      + "  let pausedAfterProjectRegistration = false;\n"
      + "  let startupObservationCompleted = false;\n\n"
      + "  // The Host is a durable process boundary. It remains available after\n",
    "post-negotiation-state",
  );
  source = replaceOnce(
    source,
    "      const outcome = await projectRegistry.registerProject(frame.message);\n"
      + "      writeFrame(process.stdout, outcome);\n"
      + "      continue;\n",
    "      const outcome = await projectRegistry.registerProject(frame.message);\n"
      + "      writeFrame(process.stdout, outcome);\n"
      + "      if (mode === \"pause-after-project-registration\"\n"
      + "        && !pausedAfterProjectRegistration\n"
      + "        && outcome?.type === \"project.register.result\"\n"
      + "        && outcome?.code === \"project_registered\") {\n"
      + "        pausedAfterProjectRegistration = true;\n"
      + "        process.kill(process.pid, \"SIGSTOP\");\n"
      + "      }\n"
      + "      continue;\n",
    "project-registration-pause",
  );
  source = replaceOnce(
    source,
    "      const outcome = await harnessRuns.launch(frame.message);\n"
      + "      writeFrame(process.stdout, outcome);\n",
    "      const outcome = await harnessRuns.launch(frame.message);\n"
      + "      if (mode === \"delayed-harness-run-launch-response\"\n"
      + "        && !delayedHarnessRunLaunchResponse) {\n"
      + "        delayedHarnessRunLaunchResponse = true;\n"
      + "        await new Promise((resolve) => setTimeout(resolve, 3_250));\n"
      + "      }\n"
      + "      writeFrame(process.stdout, outcome);\n",
    "launch-response-delay",
  );
  source = replaceOnce(
    source,
    "    if (frame.message.type === \"harness.run.observe\") {\n"
      + "      writeFrame(process.stdout, await harnessRuns.observe(frame.message));\n",
    "    if (frame.message.type === \"harness.run.observe\") {\n"
      + "      if (mode === \"malformed-frame-after-negotiation\"\n"
      + "        && startupObservationCompleted) {\n"
      + "        writeMalformedFrame();\n"
      + "        continue;\n"
      + "      }\n"
      + "      startupObservationCompleted = true;\n"
      + "      writeFrame(process.stdout, await harnessRuns.observe(frame.message));\n",
    "post-negotiation-malformed-frame",
  );
  return source;
};

const instrumentRuntime = (initialSource) => replaceOnce(
  initialSource,
  "  daemonArgs.push(\"--browser-session-ttl-ms\", String(options.browserSessionTtlMs));\n",
  "  daemonArgs.push(\"--browser-session-ttl-ms\", String(options.browserSessionTtlMs));\n"
    + "  if (options.hostMode) daemonArgs.push(\"--host-mode\", options.hostMode);\n",
  "runtime-host-mode-forwarding",
);

const instrumentRuntimeDaemon = (initialSource) => {
  let source = initialSource;
  source = replaceOnce(
    source,
    "    } else if (current === \"--expected-host-id\") {\n",
    "    } else if (current === \"--host-mode\") {\n"
      + "      result.hostMode = argv[index + 1];\n"
      + "      index += 1;\n"
      + "    } else if (current === \"--expected-host-id\") {\n",
    "daemon-host-mode-argument",
  );
  source = replaceOnce(
    source,
    "  if (args.allowHostIdentityCreate) {\n"
      + "    hostArgs.push(\"--allow-host-identity-create\");\n"
      + "  }\n",
    "  if (args.allowHostIdentityCreate) {\n"
      + "    hostArgs.push(\"--allow-host-identity-create\");\n"
      + "  }\n"
      + "  if (args.hostMode) hostArgs.push(\"--mode\", args.hostMode);\n",
    "daemon-host-mode-forwarding",
  );
  source = replaceOnce(
    source,
    "    const controllerProtocol = protocolVersion;\n"
      + "    const controllerRequiredCapabilities = [...hostCapabilities];\n"
      + "    const controllerSchemaDigest = HOST_SCHEMA_DIGEST;\n",
    "    const controllerProtocol = args.hostMode === \"controller-incompatible-major\"\n"
      + "      ? { ...protocolVersion, major: protocolVersion.major + 1,\n"
      + "          version: `${protocolVersion.major + 1}.${protocolVersion.minor}.${protocolVersion.patch}` }\n"
      + "      : protocolVersion;\n"
      + "    const controllerRequiredCapabilities =\n"
      + "      args.hostMode === \"controller-unknown-required-capability\"\n"
      + "        ? [...hostCapabilities, \"sandking.controller.future-required\"]\n"
      + "        : [...hostCapabilities];\n"
      + "    const controllerSchemaDigest = args.hostMode === \"controller-schema-mismatch\"\n"
      + "      ? `sha256:${\"0\".repeat(64)}`\n"
      + "      : HOST_SCHEMA_DIGEST;\n",
    "daemon-controller-negotiation-modes",
  );
  return source;
};

export const instrumentHostModeRuntime = async ({ packageDirectory }) => {
  for (const [name, instrument] of [
    ["local-host.mjs", instrumentLocalHost],
    ["runtime.mjs", instrumentRuntime],
    ["runtime-daemon.mjs", instrumentRuntimeDaemon],
  ]) {
    const path = join(packageDirectory, "src", name);
    await writeFile(path, instrument(await readFile(path, "utf8")), { mode: 0o755 });
  }
};

export const loadTestHostModeRuntime = async ({ dataDir, hostMode }) => {
  const suffix = createHash("sha256").update(hostMode).digest("hex").slice(0, 12);
  const packageDirectory = join(dataDir, `.test-host-mode-runtime-${suffix}`);
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
  await cp(join(repositoryRoot, "src"), join(packageDirectory, "src"), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await symlink(join(repositoryRoot, "node_modules"), join(packageDirectory, "node_modules"),
    "junction");
  await instrumentHostModeRuntime({ packageDirectory });
  return import(pathToFileURL(join(packageDirectory, "src", "runtime.mjs")).href);
};
