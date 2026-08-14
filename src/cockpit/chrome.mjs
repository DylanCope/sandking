import { element } from "./dom.mjs";

export const createCockpitChrome = ({
  state,
  renderHarnessRun,
  renderProjectPreparation,
}) => {
  const workbenchLink = (label, destination, active = false, attributes = {}) => element("a", {
    ...attributes,
    class: `workbench-nav__link${active ? " is-active" : ""}`,
    href: destination,
    ...(active ? { "aria-current": "page" } : {}),
  }, label);

  const setWorkbenchDestinationActive = (destination, active) => {
    destination.classList.toggle("is-active", active);
    if (active) {
      destination.setAttribute("aria-current", "page");
    } else {
      destination.removeAttribute("aria-current");
    }
  };

  const synchronizeWorkbenchChrome = () => {
    const currentProject = state.chrome.currentProject;
    const focused = state.chrome.focusedControllerSession;
    const focusedContextId = focused?.workContext?.workContextId ?? "";
    const breadcrumb = document.getElementById("workbench-project-breadcrumb");
    if (breadcrumb) {
      breadcrumb.textContent = `Projects / ${currentProject?.displayName ?? "Select a Project"}`;
    }
    for (const destination of document.querySelectorAll(
      "[data-workbench-controller-destination]",
    )) {
      setWorkbenchDestinationActive(destination, Boolean(focused));
    }
    const focusedController = document.getElementById("workbench-focused-controller");
    if (focusedController) {
      focusedController.dataset.workContextId = focusedContextId;
      const title = focusedController.querySelector("h1");
      if (title) {
        title.textContent = focused
          ? `Work context ${focusedContextId}`
          : "Open a Project and focused Controller";
      }
    }
    const focusedContext = document.getElementById("workbench-focused-context");
    if (focusedContext) {
      focusedContext.dataset.workContextId = focusedContextId;
      const title = focusedContext.querySelector("h2");
      if (title) {
        title.textContent = focusedContextId || "No focused context";
      }
    }
    const attachment = document.getElementById("workbench-attachment-status");
    if (attachment) {
      const attachmentMode = focused
        && state.chrome.terminalAttachment.sessionId === focused.sessionId
        ? state.chrome.terminalAttachment.mode
        : focused ? "attaching" : "none";
      attachment.dataset.provider = focused?.provider?.providerId ?? "none";
      attachment.dataset.sessionId = focused?.sessionId ?? "";
      attachment.dataset.attachment = attachmentMode;
      const status = attachment.querySelector("p");
      if (status) {
        status.textContent = focused
          ? `${focused.provider.providerId} · runtime-owned PTY · ${
              attachmentMode === "attaching"
                ? "attachment negotiating"
                : attachmentMode === "exited" ? "exited · read-only" : attachmentMode
            }`
          : "No Controller provider is attached.";
      }
    }
    const personAction = document.getElementById("workbench-person-action");
    if (personAction) {
      personAction.classList.remove("is-pending");
      personAction.dataset.personAction = "none";
      const eyebrow = personAction.querySelector(".workbench-eyebrow");
      const title = personAction.querySelector("h3");
      const description = personAction.querySelector("h3 + p");
      if (eyebrow) {
        eyebrow.textContent = "Person action";
      }
      if (title) {
        title.textContent = "No pending person action";
      }
      if (description) {
        description.textContent = "Launch uses its own optional confirmation preference.";
      }
    }
  };

  const updateWorkbenchChrome = (patch) => {
    if (Object.hasOwn(patch, "currentProject")) {
      state.chrome.currentProject = patch.currentProject;
    }
    if (Object.hasOwn(patch, "focusedControllerSession")) {
      const previousSessionId = state.chrome.focusedControllerSession?.sessionId ?? null;
      state.chrome.focusedControllerSession = patch.focusedControllerSession;
      const nextSessionId = patch.focusedControllerSession?.sessionId ?? null;
      if (nextSessionId !== previousSessionId) {
        state.chrome.terminalAttachment = {
          sessionId: nextSessionId,
          mode: nextSessionId ? "attaching" : "none",
        };
      }
    }
    if (Object.hasOwn(patch, "harnessRunObservation")) {
      state.chrome.harnessRunObservation = patch.harnessRunObservation;
    }
    if (Object.hasOwn(patch, "terminalAttachment")) {
      const terminalAttachment = patch.terminalAttachment;
      if (terminalAttachment.sessionId
        === state.chrome.focusedControllerSession?.sessionId) {
        state.chrome.terminalAttachment = terminalAttachment;
      }
    }
    synchronizeWorkbenchChrome();
  };

  const renderWorkbench = (message) => {
    const viewModel = message.viewModel;
    const focused = viewModel.focusedControllerSession;
    const currentProject = viewModel.projectPreparation.current;
    const observation = viewModel.harnessRunObservation;
    updateWorkbenchChrome({
      currentProject,
      focusedControllerSession: focused,
      harnessRunObservation: observation,
    });
    const project = renderProjectPreparation(
      viewModel.projectPreparation,
      message.session,
      viewModel.controllerProviders,
      focused,
    );
    const harnessRun = renderHarnessRun(observation);
    const shell = element("div", {
      id: "workbench-shell",
      class: "workbench-shell",
      "data-layout": "workbench",
    });
    const navigation = element("aside", {
      id: "workbench-navigation",
      class: "workbench-navigation",
      "aria-label": "Product and work context navigation",
    });
    const brand = element("a", {
      class: "workbench-brand",
      href: "#workbench-main",
      "aria-label": "Sand-King Cockpit home",
    }, "SAND—KING");
    const productNavigation = element("nav", {
      class: "workbench-nav",
      "aria-label": "Product destinations",
    });
    productNavigation.append(
      workbenchLink("Projects", "#project-preparation", true),
      workbenchLink(
        "Controller",
        "#project-focused-controller-session",
        Boolean(focused),
        { "data-workbench-controller-destination": "true" },
      ),
      workbenchLink("Runs", "#harness-run-observation"),
    );
    navigation.append(brand, productNavigation);

    const main = element("main", { id: "workbench-main", class: "workbench-main" });
    const topbar = element("header", { class: "workbench-topbar" });
    const navigationToggle = element("button", {
      id: "workbench-navigation-toggle",
      class: "workbench-drawer-toggle workbench-drawer-toggle--navigation",
      type: "button",
      "aria-controls": "workbench-navigation",
      "aria-expanded": "false",
      "aria-label": "Open product navigation",
    }, "Menu");
    const connectionStatus = element(
      "p",
      {
        id: "connection-status",
        class: `workbench-status workbench-status--${state.hostConnectionStatus}`,
        "data-host-status": state.hostConnectionStatus,
        "data-failure-code": viewModel.host.failure?.code ?? "",
        "data-connection-audit-id": viewModel.host.failure?.auditId ?? "",
        ...(state.hostConnectionStatus === "disconnected" ? { role: "alert" } : { role: "status" }),
      },
      state.hostConnectionStatus === "connected"
        ? `Connected to ${viewModel.host.identity} with protocol ${message.protocol.version}`
        : `Disconnected · Host ${viewModel.host.hostId}; Project and Harness state is stale`,
    );
    const contextToggle = element("button", {
      id: "workbench-context-toggle",
      class: "workbench-drawer-toggle workbench-drawer-toggle--context",
      type: "button",
      "aria-controls": "workbench-context",
      "aria-expanded": "false",
      "aria-label": "Open current context",
    }, "Context");
    topbar.append(
      navigationToggle,
      element("div", {
        id: "workbench-project-breadcrumb",
        class: "workbench-breadcrumbs",
      },
        `Projects / ${currentProject?.displayName ?? "Select a Project"}`),
      connectionStatus,
      contextToggle,
    );

    const stage = element("div", { class: "workbench-stage" });
    const stageHeader = element("header", { class: "workbench-stage__header" });
    const title = element("div", {
      id: "workbench-focused-controller",
      "data-work-context-id": focused?.workContext?.workContextId ?? "",
    });
    title.append(
      element("p", { class: "workbench-eyebrow" }, "Focused Controller"),
      element("h1", {}, focused
        ? `Work context ${focused.workContext.workContextId}`
        : "Open a Project and focused Controller"),
    );
    stageHeader.append(title);
    stage.append(stageHeader, project);
    main.append(topbar, stage);

    const context = element("aside", {
      id: "workbench-context",
      class: "workbench-context",
      "aria-label": "Current work context and operational status",
    });
    const contextHeader = element("header", {
      id: "workbench-focused-context",
      class: "workbench-context__header",
      "data-work-context-id": focused?.workContext?.workContextId ?? "",
    });
    contextHeader.append(
      element("p", { class: "workbench-eyebrow" }, "Current work context"),
      element("h2", {}, focused?.workContext?.workContextId ?? "No focused context"),
    );
    const attachment = element("section", {
      class: "workbench-context__section",
      id: "workbench-attachment-status",
      "data-provider": focused?.provider?.providerId ?? "none",
      "data-attachment": focused ? "attaching" : "none",
    });
    attachment.append(
      element("h3", {}, "Provider and attachment"),
      element("p", {}, focused
        ? `${focused.provider.providerId} · runtime-owned PTY · attachment negotiating`
        : "No Controller provider is attached."),
    );
    const personAction = element("section", {
      id: "workbench-person-action",
      class: "workbench-context__section workbench-person-action",
      "data-person-action": "none",
    });
    personAction.append(
      element("p", { class: "workbench-eyebrow" }, "Person action"),
      element("h3", {}, "No pending person action"),
      element("p", {}, "Launch uses its own optional confirmation preference."),
    );
    context.append(contextHeader, attachment, personAction, harnessRun);
    shell.append(navigation, main, context);
    queueMicrotask(synchronizeWorkbenchChrome);

    const setDrawer = (drawer, open) => {
      shell.classList.toggle(`is-${drawer}-open`, open);
      const toggle = drawer === "navigation" ? navigationToggle : contextToggle;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", `${open ? "Close" : "Open"} ${
        drawer === "navigation" ? "product navigation" : "current context"}`);
    };
    navigationToggle.addEventListener("click", () =>
      setDrawer("navigation", navigationToggle.getAttribute("aria-expanded") !== "true"));
    contextToggle.addEventListener("click", () =>
      setDrawer("context", contextToggle.getAttribute("aria-expanded") !== "true"));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setDrawer("navigation", false);
        setDrawer("context", false);
      }
    });
    return shell;
  };

  return {
    renderWorkbench,
    updateWorkbenchChrome,
  };
};
