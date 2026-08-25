import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson } from "./common/canonical-json.mjs";
import { digest } from "./common/digest.mjs";
import { projectIdPattern } from "./common/identifiers.mjs";
import { createDestinationWorkerEnvironment } from "./destination-worker-environment.mjs";
import {
  GITHUB_CREDENTIAL_AUTHORIZATION_CLASS,
  HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
  isGitHubCredentialToken,
} from "./github-credential-contract.mjs";
import { SANDCASTLE_HARNESS_ADAPTER_ID } from "./harness-adapter-identity.mjs";
import { readJson, writePrivateJson } from "./private-state.mjs";
import { readProjectState } from "./project-registration/state.mjs";

const execFileAsync = promisify(execFile);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const auditIdSchema = z.string().regex(/^audit-[a-f0-9]{24}$/);
const projectIdSchema = z.string().regex(projectIdPattern);
const tokenSchema = z.string().refine(
  isGitHubCredentialToken,
  "GitHub tokens cannot contain whitespace or NUL bytes",
);
const mutationOutcomeSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: z.object({}).passthrough(),
}).strict();
const githubCredentialStateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  reuseHostGhSession: z.boolean(),
  projectPersonalAccessTokens: z.record(projectIdSchema, tokenSchema),
  mutationOutcomes: z.array(mutationOutcomeSchema).max(256),
}).strict();

export { HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT };

const configurationOptions = Object.freeze([
  {
    mode: "project-pat",
    guidance: "Configure a fine-grained Project PAT limited to this repository with Contents write, Pull requests write, and Issues read/write permissions.",
  },
  {
    mode: "host-gh-session",
    guidance: `Explicitly enable reuse of the full Host GitHub access returned by \`gh auth token\`. A Project PAT still takes precedence. Acknowledgement required: ${HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT}`,
  },
]);

/** @param {"github_credential_unconfigured" | "github_host_gh_session_unavailable"} code */
export const githubCredentialConfigurationOptions = (code) =>
  code === "github_credential_unconfigured"
    ? structuredClone(configurationOptions)
    : [
        structuredClone(configurationOptions[0]),
        {
          mode: "host-gh-session",
          guidance: "Run `gh auth login` on this Host to repair the explicitly enabled Host session reuse mode.",
        },
      ];

const initialState = () => ({
  schemaVersion: 1,
  revision: 0,
  reuseHostGhSession: false,
  projectPersonalAccessTokens: {},
  mutationOutcomes: [],
});

/** @param {string} dataDir */
export const githubCredentialStatePath = (dataDir) =>
  join(dataDir, "github-credentials.json");

export class GitHubCredentialUnavailableError extends Error {
  /** @param {"github_credential_unconfigured" | "github_host_gh_session_unavailable"} code */
  constructor(code) {
    const message = code === "github_credential_unconfigured"
      ? "GitHub authentication is not configured. Set a fine-grained Project PAT, or explicitly enable reuse of this Host's gh CLI session."
      : "The explicitly enabled Host gh CLI session did not provide a GitHub token. Run `gh auth login` on the Host or configure a fine-grained Project PAT.";
    super(message);
    this.name = "GitHubCredentialUnavailableError";
    this.code = code;
    this.configurationOptions = githubCredentialConfigurationOptions(code);
  }
}

/** @param {string} dataDir */
const readState = async (dataDir) => {
  const parsed = githubCredentialStateSchema.safeParse(
    await readJson(githubCredentialStatePath(dataDir), initialState()),
  );
  if (!parsed.success) throw new Error("github_credential_state_invalid");
  return parsed.data;
};

/**
 * Read the Host account's own gh credential without inheriting credential
 * environment variables or placing the returned token in process argv.
 */
const readDestinationHostGhToken = async () => {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      {
        env: createDestinationWorkerEnvironment(),
        timeout: 10_000,
        maxBuffer: 16_384,
      },
    );
    const token = stdout.trim();
    return tokenSchema.parse(token);
  } catch {
    throw new GitHubCredentialUnavailableError("github_host_gh_session_unavailable");
  }
};

/**
 * Keep GitHub secrets outside public Project registrations and expose only
 * configured/not-configured status over Controller-visible boundaries.
 *
 * @param {{
 *   dataDir: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>, auditId?: string) => Promise<string>,
 *   readHostGhToken?: () => Promise<string>,
 * }} options
 */
export const createGitHubCredentialManager = async (options) => {
  let mutationQueue = Promise.resolve();
  /** @template T @param {() => Promise<T>} operation */
  const withMutationLock = (operation) => {
    const current = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  };

  /** @param {string} projectId */
  const requireProductionProject = async (projectId) => {
    if (!projectIdSchema.safeParse(projectId).success) return false;
    const projectState = await readProjectState(options.dataDir);
    return projectState.projects.some((project) =>
      project.projectId === projectId
      && project.status === "active"
      && project.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID);
  };

  /** @param {z.infer<typeof githubCredentialStateSchema>} state @param {string | undefined} projectId */
  const publicStatus = (state, projectId) => {
    const projectPat = projectId === undefined
      ? null
      : Object.hasOwn(state.projectPersonalAccessTokens, projectId)
        ? "configured"
        : "not-configured";
    const hostGhSessionReuse = state.reuseHostGhSession ? "enabled" : "disabled";
    const configured = projectPat === "configured" || hostGhSessionReuse === "enabled";
    return {
      code: configured ? "github_credentials_configured" : "github_credentials_unconfigured",
      revision: state.revision,
      projectPat,
      hostGhSessionReuse,
      effectiveMode: projectPat === "configured"
        ? "project-pat"
        : projectPat !== null && hostGhSessionReuse === "enabled"
          ? "host-gh-session"
          : null,
      configurationOptions: configured ? [] : structuredClone(configurationOptions),
    };
  };

  /** @param {{requestId: string, projectId?: string}} request */
  const inspect = async (request) => {
    const state = await readState(options.dataDir);
    return {
      type: "github.credentials.inspect.result",
      requestId: request.requestId,
      ...publicStatus(state, request.projectId),
    };
  };

  /**
   * @param {any} request
   * @param {"project" | "host"} target
   */
  const configure = (request, target) => withMutationLock(async () => {
    const state = await readState(options.dataDir);
    const authorizationClass = GITHUB_CREDENTIAL_AUTHORIZATION_CLASS;
    const idempotencyKeyHash = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256
      ? digest(request.idempotencyKey)
      : null;
    const projectId = target === "project" ? request.projectId : undefined;
    const requestFingerprint = digest(canonicalJson({
      target,
      projectId,
      action: request.action,
      personalAccessToken: request.personalAccessToken,
      riskAcknowledgement: request.riskAcknowledgement,
      authorizationClass: request.authorizationClass,
      expectedRevision: request.expectedRevision,
    }));
    const validTokenAction = target !== "project" || (
      request.action === "set"
        ? tokenSchema.safeParse(request.personalAccessToken).success
        : request.action === "clear" && request.personalAccessToken === undefined
    );
    const validHostAction = target !== "host" || (
      request.action === "disable"
        ? request.riskAcknowledgement === undefined
        : request.action === "enable"
    );
    let code = null;
    if (
      request.authorizationClass !== authorizationClass
      || !idempotencyKeyHash
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
      || !validTokenAction
      || !validHostAction
    ) {
      code = "mutation_contract_invalid";
    } else if (
      target === "host"
      && request.action === "enable"
      && request.riskAcknowledgement !== HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT
    ) {
      code = "github_host_session_risk_not_acknowledged";
    } else if (target === "project" && !await requireProductionProject(projectId)) {
      code = "github_credential_project_not_production";
    }

    const existing = idempotencyKeyHash
      ? state.mutationOutcomes.find((outcome) =>
          outcome.idempotencyKeyHash === idempotencyKeyHash)
      : null;
    if (!code && existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        code = "idempotency_key_conflict";
      } else {
        await options.recordAudit("github.credentials.configure", "observed", {
          authorizationClass,
          target,
          projectId: projectId ?? null,
          idempotencyKeyHash,
          idempotentReplay: true,
          originalAuditId: existing.response.auditId,
        });
        return {
          ...structuredClone(existing.response),
          requestId: request.requestId,
          idempotentReplay: true,
        };
      }
    }
    if (!code && request.expectedRevision !== state.revision) {
      code = "mutation_revision_conflict";
    }
    if (code) {
      const auditId = await options.recordAudit("github.credentials.configure", "rejected", {
        code,
        authorizationClass: request.authorizationClass === authorizationClass
          ? authorizationClass
          : null,
        target,
        projectId: projectIdSchema.safeParse(projectId).success ? projectId : null,
        idempotencyKeyHash,
        expectedRevision: Number.isSafeInteger(request.expectedRevision)
          ? request.expectedRevision
          : null,
        actualRevision: state.revision,
        credentialRetained: false,
      });
      return {
        type: "github.credentials.configure.failure",
        requestId: typeof request.requestId === "string" ? request.requestId : "invalid-request",
        code,
        retryable: [
          "mutation_revision_conflict",
          "github_credential_project_not_production",
          "github_host_session_risk_not_acknowledged",
        ].includes(code),
        authorizationClass,
        idempotencyKeyHash,
        expectedRevision: Number.isSafeInteger(request.expectedRevision)
          ? request.expectedRevision
          : null,
        actualRevision: state.revision,
        auditId,
        prohibitedSideEffects: { credentialChanged: false, projectWrite: false },
      };
    }

    if (target === "project") {
      if (request.action === "set") {
        state.projectPersonalAccessTokens[projectId] = tokenSchema.parse(
          request.personalAccessToken,
        );
      } else {
        delete state.projectPersonalAccessTokens[projectId];
      }
    } else {
      state.reuseHostGhSession = request.action === "enable";
    }
    state.revision += 1;
    const auditId = `audit-${randomBytes(12).toString("hex")}`;
    const acceptedIdempotencyKeyHash = digestSchema.parse(idempotencyKeyHash);
    const response = {
      type: "github.credentials.configure.result",
      requestId: request.requestId,
      ...publicStatus(state, projectId),
      authorizationClass,
      idempotencyKeyHash: acceptedIdempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      idempotentReplay: false,
      auditId: auditIdSchema.parse(auditId),
    };
    state.mutationOutcomes.push({
      idempotencyKeyHash: acceptedIdempotencyKeyHash,
      requestFingerprint,
      response,
    });
    if (state.mutationOutcomes.length > 256) state.mutationOutcomes.shift();
    await writePrivateJson(githubCredentialStatePath(options.dataDir), state);
    await options.recordAudit("github.credentials.configure", "accepted", {
      authorizationClass,
      target,
      projectId: projectId ?? null,
      action: request.action,
      idempotencyKeyHash: acceptedIdempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      resultingRevision: state.revision,
      projectPatConfigured: projectId === undefined
        ? null
        : Object.hasOwn(state.projectPersonalAccessTokens, projectId),
      hostGhSessionReuseEnabled: state.reuseHostGhSession,
    }, auditId);
    return response;
  });

  /** @param {any} request */
  const configureProject = (request) => configure(request, "project");
  /** @param {any} request */
  const configureHost = (request) => configure(request, "host");

  /** @param {string} projectId */
  const resolveForProject = async (projectId) => {
    const state = await readState(options.dataDir);
    const projectToken = state.projectPersonalAccessTokens[projectId];
    if (projectToken) return { mode: "project-pat", token: projectToken };
    if (state.reuseHostGhSession) {
      try {
        const token = tokenSchema.parse(await (
          options.readHostGhToken ?? readDestinationHostGhToken
        )());
        return { mode: "host-gh-session", token };
      } catch (error) {
        if (error instanceof GitHubCredentialUnavailableError) throw error;
        throw new GitHubCredentialUnavailableError(
          "github_host_gh_session_unavailable",
        );
      }
    }
    return null;
  };

  /** @param {string} projectId */
  const requireForProject = async (projectId) => {
    const credential = await resolveForProject(projectId);
    if (!credential) {
      throw new GitHubCredentialUnavailableError("github_credential_unconfigured");
    }
    return credential;
  };

  return {
    configureHost,
    configureProject,
    inspect,
    requireForProject,
    resolveForProject,
  };
};
