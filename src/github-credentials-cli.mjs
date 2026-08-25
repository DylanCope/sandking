import { randomBytes } from "node:crypto";
import { projectIdPattern } from "./common/identifiers.mjs";
import {
  GITHUB_CREDENTIAL_AUTHORIZATION_CLASS,
  HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
  isGitHubCredentialToken,
} from "./github-credential-contract.mjs";
import { createGitHubCredentialManager } from "./github-credentials.mjs";
import { createHostOperationAuditRecorder } from "./host-audit.mjs";
import { resolveDataDir } from "./runtime.mjs";

export const githubCredentialsHelp = `Usage:
  sandking github-credentials inspect [<project-id>] [--data-dir <path>] [--json]
  sandking github-credentials set-project-pat <project-id> [--data-dir <path>] [--json]
  sandking github-credentials clear-project-pat <project-id> [--data-dir <path>] [--json]
  sandking github-credentials enable-host-session --acknowledge-full-host-access [--data-dir <path>] [--json]
  sandking github-credentials disable-host-session [--data-dir <path>] [--json]

set-project-pat reads one fine-grained Project PAT from standard input so the
secret never appears in process arguments. Limit it to the Project repository
with Contents write, Pull requests write, and Issues read/write permissions.

Host-session reuse is off by default. Enabling it gives every production
Project without its own PAT the full Host GitHub access returned by gh auth
token. The --acknowledge-full-host-access flag is required deliberately.
`;

/** @param {string[]} argv */
const parseArgs = (argv) => {
  const [action, ...rest] = argv;
  /** @type {{action?: string, help: boolean, json: boolean, acknowledgeFullHostAccess: boolean, dataDir?: string, positionals: string[]}} */
  const options = {
    action,
    help: action === undefined || action === "--help" || action === "-h",
    json: false,
    acknowledgeFullHostAccess: false,
    positionals: [],
  };
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (current === "--help" || current === "-h") {
      options.help = true;
    } else if (current === "--json") {
      options.json = true;
    } else if (current === "--acknowledge-full-host-access") {
      options.acknowledgeFullHostAccess = true;
    } else if (current === "--data-dir") {
      if (!rest[index + 1]) throw new Error("GitHub credential configuration requires a --data-dir value.");
      options.dataDir = rest[index + 1];
      index += 1;
    } else if (current.startsWith("-")) {
      throw new Error(`Unsupported GitHub credential option: ${current}`);
    } else {
      options.positionals.push(current);
    }
  }
  return options;
};

/** @param {any} outcome */
const publicStatus = (outcome) => ({
  code: outcome.code,
  revision: outcome.revision,
  projectPat: outcome.projectPat,
  hostGhSessionReuse: outcome.hostGhSessionReuse,
  effectiveMode: outcome.effectiveMode,
  configurationOptions: outcome.configurationOptions,
});

/** @param {ReturnType<typeof publicStatus>} status */
const formatStatus = (status) => [
  `GitHub credentials: ${status.code === "github_credentials_configured" ? "configured" : "not configured"}`,
  `Project PAT: ${status.projectPat ?? "not inspected"}`,
  `Host gh session reuse: ${status.hostGhSessionReuse}`,
  `Effective mode: ${status.effectiveMode ?? "none"}`,
  `Revision: ${status.revision}`,
].join("\n");

const readProjectPat = async () => {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) {
    source += String(chunk);
    if (Buffer.byteLength(source, "utf8") > 4_098) {
      throw new Error("Invalid Project PAT on standard input: token is too large.");
    }
  }
  const token = source.endsWith("\r\n")
    ? source.slice(0, -2)
    : source.endsWith("\n")
      ? source.slice(0, -1)
      : source;
  if (!isGitHubCredentialToken(token)) {
    throw new Error(
      "Invalid Project PAT on standard input: expected one non-empty token without whitespace.",
    );
  }
  return token;
};

/** @param {string[]} argv */
export const runGitHubCredentialsCli = async (argv) => {
  const options = parseArgs(argv);
  if (options.help) return { help: githubCredentialsHelp };
  const actions = new Set([
    "inspect",
    "set-project-pat",
    "clear-project-pat",
    "enable-host-session",
    "disable-host-session",
  ]);
  if (!options.action || !actions.has(options.action)) {
    throw new Error(`Unsupported GitHub credential action: ${options.action ?? "missing"}`);
  }
  const projectAction = ["set-project-pat", "clear-project-pat"].includes(options.action);
  const inspectAction = options.action === "inspect";
  const expectedPositionals = projectAction ? 1 : 0;
  if (
    options.positionals.length !== expectedPositionals
    && !(inspectAction && options.positionals.length <= 1)
  ) {
    throw new Error(`Invalid arguments for GitHub credential action: ${options.action}`);
  }
  const projectId = options.positionals[0];
  if (projectId !== undefined && !projectIdPattern.test(projectId)) {
    throw new Error("Invalid Project ID for GitHub credential configuration.");
  }
  if (options.acknowledgeFullHostAccess && options.action !== "enable-host-session") {
    throw new Error(
      "--acknowledge-full-host-access is valid only when enabling Host-session reuse.",
    );
  }
  if (options.action === "enable-host-session" && !options.acknowledgeFullHostAccess) {
    throw new Error(
      "Enabling Host-session reuse grants full Host GitHub access to every production Project without its own PAT. Retry with --acknowledge-full-host-access to accept this risk.",
    );
  }

  const dataDir = resolveDataDir(options.dataDir);
  const manager = await createGitHubCredentialManager({
    dataDir,
    recordAudit: createHostOperationAuditRecorder(dataDir),
  });
  const requestId = `github-cli-${randomBytes(12).toString("hex")}`;
  let outcome;
  if (inspectAction) {
    outcome = await manager.inspect({ requestId, ...(projectId ? { projectId } : {}) });
  } else {
    const inspected = await manager.inspect({
      requestId: `github-cli-${randomBytes(12).toString("hex")}`,
      ...(projectId ? { projectId } : {}),
    });
    const mutation = {
      requestId,
      authorizationClass: GITHUB_CREDENTIAL_AUTHORIZATION_CLASS,
      idempotencyKey: randomBytes(32).toString("hex"),
      expectedRevision: inspected.revision,
    };
    if (projectAction) {
      outcome = await manager.configureProject({
        ...mutation,
        projectId,
        action: options.action === "set-project-pat" ? "set" : "clear",
        ...(options.action === "set-project-pat"
          ? { personalAccessToken: await readProjectPat() }
          : {}),
      });
    } else {
      outcome = await manager.configureHost({
        ...mutation,
        action: options.action === "enable-host-session" ? "enable" : "disable",
        ...(options.action === "enable-host-session"
          ? { riskAcknowledgement: HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT }
          : {}),
      });
    }
    if (outcome.type === "github.credentials.configure.failure") {
      throw new Error(`GitHub credential configuration failed: ${outcome.code}. Retry after inspecting the current configuration.`);
    }
  }
  const status = publicStatus(outcome);
  return {
    output: options.json ? JSON.stringify(status) : formatStatus(status),
  };
};
