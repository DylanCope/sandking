import {
  readHarnessLaunchParameters,
  renderHarnessLaunchParameterFields,
} from "/cockpit-launch-parameters.mjs";
import { createProjectRegistrationResolutionControls } from "/cockpit-project-registration.mjs";
import { projectIdPattern } from "/common/identifiers.mjs";
import { element } from "./dom.mjs";
import {
  harnessLaunchRetryHash,
  retainPendingHarnessLaunch,
} from "./socket.mjs";

export const createProjectPreparation = ({
  state,
  socket,
  attachTerminalSurface,
  updateWorkbenchChrome,
}) => {
  const launchConfirmationSuppressed = () => {
    try {
      return localStorage.getItem(state.storageKeys.launchConfirmation) === "true";
    } catch {
      return false;
    }
  };

  const suppressLaunchConfirmation = () => {
    try {
      localStorage.setItem(state.storageKeys.launchConfirmation, "true");
    } catch {
      // Storage can be unavailable in privacy-restricted contexts. Launch still proceeds.
    }
  };

  const selectedProjectLaunchReady = () => {
    const selectedProject = document.getElementById("project-readiness");
    return selectedProject?.dataset.harnessLaunchReady === "true";
  };

  const mutationKey = () => globalThis.crypto?.randomUUID?.()
    ?? `mutation-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const readPendingHarnessLaunch = () => {
    try {
      const launch = JSON.parse(sessionStorage.getItem(state.storageKeys.pendingHarnessLaunch) ?? "null");
      if (
        !projectIdPattern.test(launch?.projectId ?? "")
        || !/^sha256:[a-f0-9]{64}$/.test(launch?.idempotencyKeyHash ?? "")
        || !launch.parameters
        || typeof launch.parameters !== "object"
        || Array.isArray(launch.parameters)
        || (launch.reconnectHarnessRunId !== undefined
          && !/^harness-run-[a-f0-9]{24}$/.test(launch.reconnectHarnessRunId))
      ) {
        sessionStorage.removeItem(state.storageKeys.pendingHarnessLaunch);
        return null;
      }
      return launch;
    } catch {
      sessionStorage.removeItem(state.storageKeys.pendingHarnessLaunch);
      return null;
    }
  };

  const renderPreparedProject = (current) => {
    if (!current) {
      return element(
        "p",
        { id: "project-not-selected", "data-project-selected": "false" },
        "No Project path has been selected.",
      );
    }
    const productionPreparation = current.harness?.adapterId
      === "sandcastle-harness-adapter-v1"
      ? current.harness.preparation
      : null;
    const card = element("article", {
      id: "project-readiness",
      "data-project-selected": "true",
      "data-project-id": current.projectId,
      "data-project-revision": current.revision,
      "data-harness-id": current.harness?.harnessId ?? "",
      "data-harness-pin": current.harness?.pinnedRevision ?? "",
      "data-harness-adapter-id": current.harness?.adapterId ?? "",
      "data-harness-skill-lock": productionPreparation?.skillSetLockDigest ?? "",
      "data-harness-projection-digest": productionPreparation?.projection.digest ?? "",
      "data-harness-resolved-skills": productionPreparation?.resolvedSkills
        .map(({ identity, revision }) => `${identity}@${revision}`).join(",") ?? "",
      "data-checks-readiness": current.readiness.checks,
      "data-configuration-readiness": current.readiness.configuration,
      "data-harness-launch-ready": String(current.canPrepareLaunchRequest),
    });
    card.append(
      element("h3", {}, current.displayName),
      element("p", {}, `Project identity: ${current.projectId} (revision ${current.revision})`),
      element("p", {},
        `Issue workflow: GitHub Issues — ${current.issueWorkflow.readiness}`),
      element("p", {},
        `Checks: ${current.checks.map((check) => `${check.checkId} (${check.readiness})`).join(", ")}`),
      element("p", {}, current.harness
        ? `Harness identity: ${current.harness.harnessId} — ${current.harness.name}`
        : "Harness: missing"),
      element("p", { "data-project-harness-adapter-id": current.harness?.adapterId ?? "" },
        current.harness
          ? `Harness adapter: ${current.harness.adapterId}`
          : "Harness adapter: missing"),
      element("p", {}, current.harness
        ? `Pinned immutable revision: ${current.harness.pinnedRevision}`
        : "Pinned immutable revision: missing"),
      ...(productionPreparation ? [
        element("p", { "data-production-preparation": productionPreparation.status },
          `Production preparation: ${productionPreparation.status}; skill-set lock: ${productionPreparation.skillSetLockDigest}`),
        element("p", {}, `Resolved Worker skills: ${productionPreparation.resolvedSkills
          .map(({ identity, revision }) => `${identity}@${revision}`).join(", ")}`),
        element("p", {}, `Ignored Project projection: ${productionPreparation.projection.path} (${productionPreparation.projection.digest})`),
        element("p", {}, `Versioned execution runtime inputs: ${productionPreparation.executionRuntimeInputs
          .map(({ identity, version }) => `${identity}@${version}`).join(", ")}`),
      ] : []),
      element("p", { "data-launch-guidance": current.readiness.launchRequest },
        current.canPrepareLaunchRequest
          ? "The pinned Harness is ready to launch."
          : `Harness launch is unavailable: ${current.readiness.diagnostics.join(", ")}`),
    );
    return card;
  };

  const renderProjectPreparation = (
    preparation,
    session,
    controllerProviders,
    focusedControllerSession,
  ) => {
    const section = element("section", {
      id: "project-preparation",
      "data-explicit-path-only": "true",
      "data-directory-scanning": String(preparation.selection.directoryScanning),
      "data-host-freshness": state.hostFreshness,
    });
    section.append(
      element("h2", {}, "Open and prepare a local Project"),
      element("p", {},
        "Choose one explicit Host-native path. Sand-King does not scan other directories."),
      element("p", {},
        "Host-local Project registration requires no separate Sand-King approval."),
    );
    const pathLabel = element("label", { for: "project-path" }, "Project path");
    const pathInput = element("input", {
      id: "project-path",
      name: "projectPath",
      type: "text",
      autocomplete: "off",
      placeholder: "/absolute/path/to/project",
    });
    const typecheckLabel = element(
      "label",
      { for: "project-typecheck-command" },
      "Typecheck command",
    );
    const typecheckInput = element("input", {
      id: "project-typecheck-command",
      type: "text",
      value: "npm run typecheck",
    });
    const testLabel = element("label", { for: "project-test-command" }, "Test command");
    const testInput = element("input", {
      id: "project-test-command",
      type: "text",
      value: "npm run test",
    });
    const harnessLabel = element("label", { for: "project-harness-adapter" }, "Bundled Harness");
    const harnessSelect = element("select", {
      id: "project-harness-adapter",
      disabled: Boolean(preparation.current?.harness),
    });
    harnessSelect.append(
      element("option", {
        value: preparation.productionHarness.adapterId,
      }, `${preparation.productionHarness.name} (production default)`),
      element("option", {
        value: preparation.conformanceHarness.adapterId,
      }, `${preparation.conformanceHarness.name} (deterministic conformance)`),
    );
    harnessSelect.value = preparation.current?.harness?.adapterId
      ?? preparation.defaultHarnessAdapterId;
    const openButton = element("button", {
      id: "open-project",
      type: "button",
      "data-action": "open-project",
      "data-host-mutation": "true",
      disabled: state.hostConnectionStatus !== "connected",
    }, "Open and prepare Project");
    const feedback = element("p", { id: "project-feedback", role: "status" });
    let currentNode = renderPreparedProject(preparation.current);
    let currentProject = preparation.current;
    let expectedRevision = preparation.current?.revision ?? 0;
    let registrationResolutionControls;
    const openController = element("button", {
      id: "open-project-controller",
      type: "button",
      "data-action": "open-project-controller",
      "data-host-mutation": "true",
      disabled: state.hostConnectionStatus !== "connected"
        || !preparation.current?.canPrepareLaunchRequest,
    }, "Open focused Controller for Launch");
    let launchParameterDeclaration = preparation.current?.harness?.launchParameters
      ?? { kind: "none" };
    let launchParameterFields = renderHarnessLaunchParameterFields(
      document,
      launchParameterDeclaration,
    );
    const updateLaunchParameterFields = () => {
      launchParameterDeclaration = currentProject?.harness?.launchParameters
        ?? { kind: "none" };
      const replacement = renderHarnessLaunchParameterFields(
        document,
        launchParameterDeclaration,
      );
      launchParameterFields.replaceWith(replacement);
      launchParameterFields = replacement;
    };
    const launchButton = element("button", {
      id: "launch-harness",
      type: "button",
      "data-action": "launch-harness",
      "data-host-mutation": "true",
      disabled: state.hostConnectionStatus !== "connected"
        || !preparation.current?.canPrepareLaunchRequest,
    }, "Launch");
    state.harnessLaunchFeedback = element("p", { id: "harness-launch-feedback", role: "status" });
    const confirmation = element("dialog", {
      id: "harness-launch-confirmation",
      "aria-labelledby": "harness-launch-confirmation-title",
    });
    const confirmationTitle = element(
      "h3",
      { id: "harness-launch-confirmation-title" },
      "You’re about to launch the Harness — continue?",
    );
    const confirmationDetail = element("p", {},
      "This immediately starts delegated Harness work for the selected Project.");
    const skipConfirmation = element("input", {
      id: "harness-launch-confirmation-skip",
      type: "checkbox",
    });
    const skipConfirmationLabel = element(
      "label",
      { for: "harness-launch-confirmation-skip" },
      "Don’t show again",
    );
    const confirmYes = element("button", {
      id: "harness-launch-confirmation-yes",
      type: "button",
      value: "yes",
    }, "Yes");
    const confirmNo = element("button", {
      id: "harness-launch-confirmation-no",
      type: "button",
      value: "no",
    }, "No");
    confirmation.append(
      confirmationTitle,
      confirmationDetail,
      skipConfirmation,
      skipConfirmationLabel,
      element("div", { class: "harness-launch-confirmation__actions" }),
    );
    confirmation.lastElementChild.append(confirmYes, confirmNo);

    const launch = () => {
      if (
        !currentProject
        || currentProject.canPrepareLaunchRequest !== true
        || !selectedProjectLaunchReady()
        || state.hostConnectionStatus !== "connected"
        || state.pendingHarnessLaunchRequestId !== null
      ) {
        state.harnessLaunchFeedback.textContent =
          "Harness was not launched: the selected Project is not launch-ready.";
        updateProjectActionAvailability();
        return false;
      }
      const parsedParameters = readHarnessLaunchParameters(
        launchParameterFields,
        launchParameterDeclaration,
      );
      if (!parsedParameters.ok) {
        state.harnessLaunchFeedback.textContent =
          `Harness was not launched: ${parsedParameters.error}.`;
        return false;
      }
      state.pendingHarnessLaunchRequestId = `harness-launch-${state.harnessRequestSequence}`;
      state.harnessRequestSequence += 1;
      launchButton.disabled = true;
      state.harnessLaunchFeedback.textContent = "Launching the Harness run…";
      const pendingLaunch = {
        projectId: currentProject.projectId,
        parameters: parsedParameters.parameters,
        idempotencyKeyHash: harnessLaunchRetryHash(),
      };
      retainPendingHarnessLaunch(state, pendingLaunch);
      socket.send(JSON.stringify({
        channel: "control",
        message: {
          type: "browser.harness-run.launch",
          requestId: state.pendingHarnessLaunchRequestId,
          projectId: pendingLaunch.projectId,
          ...(Object.keys(pendingLaunch.parameters).length === 0
            ? {}
            : { parameters: pendingLaunch.parameters }),
          idempotencyKeyHash: pendingLaunch.idempotencyKeyHash,
        },
      }));
      return true;
    };
    launchButton.addEventListener("click", () => {
      if (launchConfirmationSuppressed()) {
        launch();
      } else {
        skipConfirmation.checked = false;
        confirmation.showModal();
      }
    });
    confirmYes.addEventListener("click", () => {
      confirmation.close("yes");
      if (launch() && skipConfirmation.checked) suppressLaunchConfirmation();
    });
    confirmNo.addEventListener("click", () => confirmation.close("no"));
    const claudeProvider = controllerProviders.find((provider) =>
      provider.providerId === "claude-code");
    const claudeAvailable = claudeProvider?.availability.status === "available";
    const openClaudeController = element("button", {
      id: "open-project-claude-controller",
      type: "button",
      "data-action": "open-project-claude-controller",
      "data-host-mutation": "true",
      "data-provider-availability": claudeProvider?.availability.status ?? "unavailable",
      disabled: state.hostConnectionStatus !== "connected"
        || !preparation.current?.canPrepareLaunchRequest
        || !claudeAvailable,
    }, "Open installed Claude Controller");
    const claudeProviderStatus = element("p", {
      id: "claude-provider-status",
      "data-provider-id": "claude-code",
      "data-availability": claudeProvider?.availability.status ?? "unavailable",
      "data-authentication": claudeProvider?.availability.authentication ?? "unknown",
      "data-failure-code": claudeProvider?.availability.failureCode ?? "",
    }, claudeAvailable
      ? `Claude Code ${claudeProvider.availability.version} is available with destination-local authentication.`
      : `Claude Controller unavailable: ${claudeProvider?.availability.failureCode ?? "provider_cli_unavailable"}.`);
    const controllerFeedback = element("p", {
      id: "project-controller-feedback",
      role: "status",
    });
    const controllerPanel = element("section", {
      id: "project-focused-controller-session",
      "data-session-state": "closed",
      hidden: true,
    });
    const updateProjectActionAvailability = () => {
      const projectReady = currentProject?.canPrepareLaunchRequest === true;
      const launchReady = projectReady && selectedProjectLaunchReady();
      launchButton.disabled = state.hostConnectionStatus !== "connected"
        || !launchReady
        || state.pendingHarnessLaunchRequestId !== null;
      openController.disabled = state.hostConnectionStatus !== "connected" || !projectReady;
      openClaudeController.disabled = state.hostConnectionStatus !== "connected"
        || !projectReady
        || !claudeAvailable;
      registrationResolutionControls?.updateAvailability();
    };

    const clearCurrentProject = () => {
      currentProject = null;
      expectedRevision = 0;
      harnessSelect.disabled = false;
      updateLaunchParameterFields();
      const replacement = renderPreparedProject(null);
      currentNode.replaceWith(replacement);
      currentNode = replacement;
      updateWorkbenchChrome({ currentProject: null });
    };
    /** @param {any} outcome */
    const projectFailureInvalidatesCurrentProject = (outcome) =>
      outcome.code === "project_path_conflict"
      || outcome.registrations?.some((/** @type {any} */ registration) =>
        registration.projectId === currentProject?.projectId) === true;
    const openSelectedProject = async (resolutionAction, resolutionExpectedRevision) => {
      const requestExpectedRevision = resolutionAction === "register_as_new"
        && Number.isSafeInteger(resolutionExpectedRevision)
        ? resolutionExpectedRevision
        : expectedRevision;
      openButton.disabled = true;
      registrationResolutionControls.registerAsNewButton.disabled = true;
      feedback.textContent = "Opening the selected Project path…";
      const response = await fetch("/projects/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sandking-csrf": session.csrfToken,
          "x-sandking-idempotency-key": mutationKey(),
          "x-sandking-expected-revision": String(requestExpectedRevision),
        },
        body: JSON.stringify({
          path: pathInput.value,
          harnessAdapterId: harnessSelect.value,
          ...(resolutionAction ? { resolutionAction } : {}),
          configuration: {
            issueWorkflow: { provider: "github", kind: "issues" },
            checks: [
              { checkId: "typecheck", command: typecheckInput.value },
              { checkId: "test", command: testInput.value },
            ],
          },
        }),
      });
      const outcome = await response.json();
      if (!response.ok) {
        registrationResolutionControls.render(outcome);
        if (projectFailureInvalidatesCurrentProject(outcome)) {
          clearCurrentProject();
        }
        if (outcome.project) {
          expectedRevision = outcome.project.revision;
          currentProject = outcome.project;
          updateLaunchParameterFields();
          const replacement = renderPreparedProject(outcome.project);
          currentNode.replaceWith(replacement);
          currentNode = replacement;
          updateWorkbenchChrome({ currentProject: outcome.project });
        }
        if (
          outcome.code === "mutation_revision_conflict"
          && Number.isSafeInteger(outcome.actualRevision)
        ) {
          expectedRevision = outcome.actualRevision;
        }
        feedback.textContent = outcome.project
          ? `Project ${outcome.project.projectId} was accepted, but preparation stopped: ${
              outcome.code}. Its retained readiness is shown above.`
          : outcome.code === "project_path_conflict"
            ? `Project registration requires conflict resolution: ${outcome.code}. ${
                outcome.resolution?.actions?.join(", ") ?? "Select a retained registration."}`
            : `Project was not changed: ${outcome.code}. ${
                outcome.resolution?.actions?.join(", ") ?? "Review the typed guidance."}`;
        updateProjectActionAvailability();
        openButton.disabled = state.hostConnectionStatus !== "connected";
        return;
      }
      registrationResolutionControls.clear();
      expectedRevision = outcome.project.revision;
      currentProject = outcome.project;
      updateLaunchParameterFields();
      const replacement = renderPreparedProject(outcome.project);
      currentNode.replaceWith(replacement);
      currentNode = replacement;
      updateWorkbenchChrome({ currentProject: outcome.project });
      feedback.textContent = `Project and ${outcome.project.harness.name} are ready to launch.`;
      updateProjectActionAvailability();
      openButton.disabled = state.hostConnectionStatus !== "connected";
    };
    registrationResolutionControls = createProjectRegistrationResolutionControls({
      element,
      csrfToken: session.csrfToken,
      mutationKey,
      getHostConnectionStatus: () => state.hostConnectionStatus,
      getCurrentProject: () => currentProject,
      getSelectedPath: () => pathInput.value,
      clearCurrentProject,
      openSelectedProject,
      setFeedback: (message) => {
        feedback.textContent = message;
      },
      updateAvailability: updateProjectActionAvailability,
      confirmForget: (message) => window.confirm(message),
    });
    openButton.addEventListener("click", () => openSelectedProject());

    const attachFocusedController = (focused, reconnected) => {
      updateWorkbenchChrome({ focusedControllerSession: focused });
      controllerPanel.hidden = false;
      controllerPanel.dataset.sessionState = "open";
      controllerPanel.dataset.reconnected = String(reconnected);
      controllerPanel.dataset.sessionId = focused.sessionId;
      controllerPanel.dataset.workContextId = focused.workContext.workContextId;
      controllerPanel.dataset.providerId = focused.provider.providerId;
      controllerPanel.dataset.providerAdapterId = focused.provider.adapterId;
      controllerPanel.dataset.providerSessionId = focused.provider.providerSessionId;
      controllerPanel.dataset.providerControlProtocol =
        focused.provider.readiness.controlProtocol;
      controllerPanel.dataset.providerReadySignal = focused.provider.readiness.signal;
      controllerPanel.dataset.providerObservedTty = String(
        focused.provider.readiness.providerObservedTty,
      );
      controllerPanel.dataset.terminalStreamId = focused.terminal.streamId;
      controllerPanel.dataset.terminalAttachmentId =
        focused.terminal.writableAttachment.attachmentId;
      controllerPanel.dataset.ptyRuntimeOwned = String(focused.terminal.runtimeOwned);
      controllerPanel.dataset.terminalAttachment = "attaching";
      attachTerminalSurface({
        focused,
        panel: controllerPanel,
        outputId: "project-controller-terminal-output",
        accessibleLabel: "Project Controller terminal",
        requestedMode: reconnected ? "read-write-if-available" : "read-write",
        description: [
          element("p", {}, `Focused Controller session ${focused.sessionId} can launch the Harness for ${focused.workContext.workContextId} with the ordinary sandking CLI.`),
        ],
      });
      controllerFeedback.textContent = reconnected
        ? "Reconnected to the existing focused Controller and retained terminal output."
        : "Use the focused Controller conversation for project work or launch with sandking.";
    };

    const openFocusedController = async (providerId, sourceButton) => {
      if (!currentProject) {
        return;
      }
      sourceButton.disabled = true;
      controllerFeedback.textContent = "Opening the owning focused Controller session…";
      const response = await fetch("/projects/sessions/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sandking-csrf": session.csrfToken,
          "x-sandking-idempotency-key": mutationKey(),
          "x-sandking-expected-revision": String(currentProject.revision),
        },
        body: JSON.stringify({ projectId: currentProject.projectId, providerId }),
      });
      const outcome = await response.json();
      if (!response.ok || outcome.type !== "mutation_result") {
        controllerFeedback.textContent = `Focused Controller failed safely: ${outcome.code}.`;
        sourceButton.disabled = state.hostConnectionStatus !== "connected"
          || (providerId === "claude-code" ? !claudeAvailable : false);
        return;
      }
      attachFocusedController(outcome.session, false);
    };
    openController.addEventListener("click", () =>
      openFocusedController("conformance-controller-v1", openController));
    openClaudeController.addEventListener("click", () =>
      openFocusedController("claude-code", openClaudeController));
    if (focusedControllerSession) {
      attachFocusedController(focusedControllerSession, true);
    }

    section.append(
      element("h3", {}, "Bounded Project configuration"),
      element("p", {}, "Issue workflow: GitHub Issues"),
      pathLabel,
      pathInput,
      typecheckLabel,
      typecheckInput,
      testLabel,
      testInput,
      harnessLabel,
      harnessSelect,
      openButton,
      registrationResolutionControls.registerAsNewButton,
      feedback,
      currentNode,
      registrationResolutionControls.forgetRegistrationButton,
      registrationResolutionControls.resolutionPanel,
      element("h3", {}, "Launch Harness"),
      launchParameterFields,
      launchButton,
      state.harnessLaunchFeedback,
      confirmation,
      openController,
      openClaudeController,
      claudeProviderStatus,
      controllerFeedback,
      controllerPanel,
      element("p", { "data-project-scope": "registration-only" },
        "This slice does not project a Harness into the Project or provide import, update, rollback, switching, or drift recovery."),
    );
    return section;
  };

  return {
    readPendingHarnessLaunch,
    renderProjectPreparation,
    selectedProjectLaunchReady,
  };
};
