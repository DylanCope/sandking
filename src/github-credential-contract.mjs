export const GITHUB_CREDENTIAL_MODES = Object.freeze([
  "project-pat",
  "host-gh-session",
]);

export const GITHUB_CREDENTIAL_AUTHORIZATION_CLASS =
  "host_local_github_credentials";

export const HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT =
  "I understand this grants every unscoped Project my full Host GitHub access.";

export const GITHUB_AUTHENTICATION_VERIFICATION_CAPABILITY =
  "github.authentication.verify";
export const GITHUB_CREDENTIAL_CAPABILITIES = Object.freeze([
  GITHUB_AUTHENTICATION_VERIFICATION_CAPABILITY,
  "github.issues.read",
]);

export const GITHUB_CREDENTIAL_UNCONFIGURED_CODE =
  "github_credential_unconfigured";
export const GITHUB_HOST_GH_SESSION_UNAVAILABLE_CODE =
  "github_host_gh_session_unavailable";

/** @type {readonly ("github_credential_unconfigured" | "github_host_gh_session_unavailable")[]} */
export const GITHUB_CREDENTIAL_FAILURE_CODES = Object.freeze([
  GITHUB_CREDENTIAL_UNCONFIGURED_CODE,
  GITHUB_HOST_GH_SESSION_UNAVAILABLE_CODE,
]);

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
  code === GITHUB_CREDENTIAL_UNCONFIGURED_CODE
    ? structuredClone(configurationOptions)
    : [
        structuredClone(configurationOptions[0]),
        {
          mode: "host-gh-session",
          guidance: "Run `gh auth login` on this Host to repair the explicitly enabled Host session reuse mode.",
        },
      ];

/** @param {unknown} value */
export const isGitHubCredentialConfigurationOptions = (value) => Array.isArray(value)
  && value.length === 2
  && new Set(value.map((option) => option?.mode)).size === 2
  && value.every((option) => option
    && typeof option === "object"
    && !Array.isArray(option)
    && Object.keys(option).every((key) => ["mode", "guidance"].includes(key))
    && GITHUB_CREDENTIAL_MODES.includes(option.mode)
    && typeof option.guidance === "string"
    && option.guidance.length >= 1
    && option.guidance.length <= 1_024
    && !/[\r\n\0]/.test(option.guidance));

/**
 * @param {unknown} value
 * @returns {value is "github_credential_unconfigured" | "github_host_gh_session_unavailable"}
 */
export const isGitHubCredentialFailureCode = (value) =>
  GITHUB_CREDENTIAL_FAILURE_CODES.includes(/** @type {any} */ (value));

/** @param {unknown} value */
export const isGitHubCredentialCapability = (value) =>
  GITHUB_CREDENTIAL_CAPABILITIES.includes(/** @type {any} */ (value));

/**
 * One typed error crosses credential resolution, Host launch, Controller, and
 * CLI boundaries without copying the actionable configuration contract.
 */
export class GitHubCredentialUnavailableError extends Error {
  /**
   * @param {"github_credential_unconfigured" | "github_host_gh_session_unavailable"} code
   * @param {unknown} [providedOptions]
   */
  constructor(code, providedOptions) {
    const resolvedOptions = isGitHubCredentialConfigurationOptions(providedOptions)
      ? /** @type {Array<{mode: "project-pat" | "host-gh-session", guidance: string}>} */ (
          structuredClone(providedOptions)
        )
      : githubCredentialConfigurationOptions(code);
    const summary = code === GITHUB_CREDENTIAL_UNCONFIGURED_CODE
      ? "GitHub authentication is not configured."
      : "The explicitly enabled Host gh CLI session did not provide a GitHub token.";
    super([
      `${code}: ${summary}`,
      `Project PAT: ${resolvedOptions.find(({ mode }) => mode === "project-pat")?.guidance ?? "Configure a fine-grained Project PAT."}`,
      `Host gh CLI session: ${resolvedOptions.find(({ mode }) => mode === "host-gh-session")?.guidance ?? "Explicitly enable Host gh CLI session reuse."}`,
    ].join("\n"));
    this.name = "GitHubCredentialUnavailableError";
    this.code = code;
    this.configurationOptions = resolvedOptions;
  }
}

/** @param {unknown} value */
export const isGitHubCredentialToken = (value) => typeof value === "string"
  && value.length >= 1
  && value.length <= 4_096
  && value.trim() === value
  && !/[\s\0]/.test(value);

/** @param {unknown} value */
export const isGitHubCredential = (value) => Boolean(
  value
  && typeof value === "object"
  && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["mode", "token"])
  && "mode" in value
  && GITHUB_CREDENTIAL_MODES.includes(/** @type {any} */ (value.mode))
  && "token" in value
  && isGitHubCredentialToken(value.token),
);

/**
 * @param {unknown} value
 * @param {string} [failureCode]
 * @returns {{mode: "project-pat" | "host-gh-session", token: string}}
 */
export const parseGitHubCredential = (
  value,
  failureCode = "github_credential_invalid",
) => {
  if (!isGitHubCredential(value)) throw new Error(failureCode);
  return /** @type {{mode: "project-pat" | "host-gh-session", token: string}} */ (value);
};
