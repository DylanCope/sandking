export const GITHUB_CREDENTIAL_MODES = Object.freeze([
  "project-pat",
  "host-gh-session",
]);

export const GITHUB_CREDENTIAL_AUTHORIZATION_CLASS =
  "host_local_github_credentials";

export const HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT =
  "I understand this grants every unscoped Project my full Host GitHub access.";

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
