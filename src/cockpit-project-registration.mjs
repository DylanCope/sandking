import { projectIdPattern } from "./common/identifiers.mjs";

/**
 * @param {{
 *   element: (name: string, attributes?: Record<string, unknown>, text?: string) => HTMLElement,
 *   csrfToken: string,
 *   mutationKey: () => string,
 *   getHostConnectionStatus: () => string,
 *   getCurrentProject: () => any,
 *   getSelectedPath: () => string,
 *   clearCurrentProject: () => void,
 *   openSelectedProject: (resolutionAction: "register_as_new", expectedRevision: number) => void,
 *   setFeedback: (message: string) => void,
 *   updateAvailability: () => void,
 *   confirmForget: (message: string) => boolean,
 * }} options
 */
export const createProjectRegistrationResolutionControls = (options) => {
  /** @type {number | null} */
  let registerAsNewExpectedRevision = null;
  const registerAsNewButton = /** @type {HTMLButtonElement} */ (options.element("button", {
    id: "register-project-as-new",
    type: "button",
    "data-action": "register-project-as-new",
    "data-host-mutation": "true",
    disabled: true,
    hidden: true,
  }, "Register selected path as a new Project"));
  const forgetRegistrationButton = /** @type {HTMLButtonElement} */ (options.element("button", {
    id: "forget-project-registration",
    type: "button",
    "data-action": "forget-project-registration",
    "data-host-mutation": "true",
    disabled: true,
  }, "Forget current Project registration"));
  const resolutionPanel = options.element("div", {
    id: "project-registration-resolution",
    "data-registration-resolution": "true",
    "data-registration-failure-code": "",
    hidden: true,
  });

  const clear = () => {
    resolutionPanel.replaceChildren();
    resolutionPanel.hidden = true;
    resolutionPanel.dataset.registrationFailureCode = "";
    registerAsNewButton.hidden = true;
    registerAsNewExpectedRevision = null;
  };

  const updateAvailability = () => {
    const connected = options.getHostConnectionStatus() === "connected";
    forgetRegistrationButton.disabled = !connected || !options.getCurrentProject();
    registerAsNewButton.disabled = !connected || registerAsNewButton.hidden;
  };

  /** @param {"forget" | "restore" | "resolve_conflict"} action @param {any} registration */
  const requestResolution = async (action, registration) => {
    if (
      options.getHostConnectionStatus() !== "connected"
      || !projectIdPattern.test(registration?.projectId ?? "")
      || !Number.isSafeInteger(registration?.revision)
    ) {
      options.setFeedback("Project registration was not changed: refresh and retry.");
      return;
    }
    resolutionPanel.querySelectorAll("button").forEach((button) => {
      /** @type {HTMLButtonElement} */ (button).disabled = true;
    });
    /** @type {HTMLButtonElement} */ (forgetRegistrationButton).disabled = true;
    const response = await fetch("/projects/registration/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandking-csrf": options.csrfToken,
        "x-sandking-idempotency-key": options.mutationKey(),
        "x-sandking-expected-revision": String(registration.revision),
      },
      body: JSON.stringify({
        action,
        projectId: registration.projectId,
        path: options.getSelectedPath(),
      }),
    });
    const outcome = await response.json();
    if (!response.ok) {
      const conflictRequiresResolution = outcome.code === "project_path_conflict";
      if (conflictRequiresResolution) options.clearCurrentProject();
      options.setFeedback(conflictRequiresResolution
        ? `Project registration requires conflict resolution: ${outcome.code}. ${
            outcome.resolution?.actions?.join(", ") ?? "Select a retained registration."}`
        : `Project registration was not changed: ${outcome.code}. ${
            outcome.resolution?.actions?.join(", ") ?? "Refresh and retry."}`);
      render(outcome);
      options.updateAvailability();
      return;
    }
    clear();
    options.clearCurrentProject();
    options.setFeedback(action === "forget"
      ? `Project registration ${registration.projectId} was forgotten safely.`
      : action === "restore"
        ? `Project registration ${registration.projectId} was restored. Open its path to continue.`
        : `Project registration ${registration.projectId} was kept and its conflicts were retired. Open its path to continue.`);
    options.updateAvailability();
  };

  /** @param {any} outcome */
  const render = (outcome) => {
    clear();
    resolutionPanel.dataset.registrationFailureCode = outcome.code ?? "";
    if (
      outcome.resolution?.actions?.includes("register_as_new")
      && Number.isSafeInteger(outcome.actualRevision)
    ) {
      registerAsNewButton.hidden = false;
      registerAsNewExpectedRevision = outcome.actualRevision;
    }
    const registrations = Array.isArray(outcome.registrations)
      ? outcome.registrations.filter((/** @type {any} */ registration) =>
        projectIdPattern.test(registration?.projectId ?? "")
        && Number.isSafeInteger(registration?.revision))
      : [];
    for (const registration of registrations) {
      const action = outcome.code === "project_path_tombstoned"
        && registration.status === "tombstoned"
        ? "restore"
        : outcome.resolution?.actions?.includes("forget_registration")
          && registration.status === "active"
          ? "forget"
        : outcome.code === "project_path_conflict"
          && registration.status === "active"
          ? "resolve_conflict"
          : null;
      if (!action) continue;
      const button = options.element("button", {
        type: "button",
        class: action === "restore"
          ? "restore-project-registration"
          : action === "forget"
            ? "forget-retained-project-registration"
            : "resolve-project-registration-conflict",
        "data-action": action,
        "data-project-id": registration.projectId,
        "data-project-revision": registration.revision,
        "data-project-path": registration.canonicalPath,
        "data-host-mutation": "true",
      }, action === "restore"
        ? `Restore ${registration.projectId}`
        : action === "forget"
          ? `Forget ${registration.projectId} at ${registration.canonicalPath}`
          : `Keep ${registration.projectId} at ${registration.canonicalPath}`);
      button.addEventListener("click", () => {
        if (
          action === "forget"
          && !options.confirmForget(
            `Forget Project registration ${registration.projectId}? The Host will retain a tombstone so this path cannot be silently reused.`,
          )
        ) {
          return;
        }
        requestResolution(action, registration);
      });
      resolutionPanel.append(button);
    }
    resolutionPanel.hidden = resolutionPanel.childElementCount === 0;
    updateAvailability();
  };

  registerAsNewButton.addEventListener("click", () => {
    const revision = registerAsNewExpectedRevision;
    if (typeof revision === "number" && Number.isSafeInteger(revision)) {
      options.openSelectedProject("register_as_new", revision);
    }
  });
  forgetRegistrationButton.addEventListener("click", () => {
    const currentProject = options.getCurrentProject();
    if (
      !currentProject
      || !options.confirmForget(
        `Forget Project registration ${currentProject.projectId}? The Host will retain a tombstone so this path cannot be silently reused.`,
      )
    ) {
      return;
    }
    requestResolution("forget", currentProject);
  });
  updateAvailability();

  return Object.freeze({
    registerAsNewButton,
    forgetRegistrationButton,
    resolutionPanel,
    clear,
    render,
    updateAvailability,
  });
};
