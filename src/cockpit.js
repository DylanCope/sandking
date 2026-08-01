const browserProtocol = Object.freeze({
  protocol: { major: 1, minor: 0, patch: 0, version: "1.0.0" },
  release: "0.1.0",
  identity: "cockpit",
  expectedPeerIdentity: "controller-runtime",
  capabilities: {
    required: [
      "cockpit.structured-control.v1",
      "cockpit.opaque-stream.v1",
      "cockpit.resynchronization.v1",
      "cockpit.planning-spine.v1",
      "cockpit.controller-terminal.v1",
      "cockpit.project-preparation.v1",
      "cockpit.launch-request.v1",
      "cockpit.harness-run-observation.v1",
    ],
    optional: [],
  },
  schemaDigest: "sha256:92e4331f6945b40de00865c16724ab9d9162e0b43da527298850c738b4ff6fd4",
  framing: {
    maxControlMessageBytes: 32_768,
    maxOpaqueStreamChunkBytes: 16_384,
  },
});

const app = document.getElementById("app");
const reload = document.getElementById("reload-cockpit");
const websocketProtocol = location.protocol === "https:" ? "wss" : "ws";
const socket = new WebSocket(`${websocketProtocol}://${location.host}/ws`);
socket.binaryType = "arraybuffer";
const terminalStreams = new Map();
const diagnosticStreams = new Map();
let runtimeNegotiated = false;
let harnessRunSection;
let harnessObservationTimer;
let harnessRequestSequence = 0;

const encodeOpaqueFrame = (streamId, sequence, data) => {
  const id = new TextEncoder().encode(streamId);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const frame = new Uint8Array(6 + id.byteLength + bytes.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, id.byteLength);
  view.setUint32(1, sequence);
  view.setUint8(5, 0);
  frame.set(id, 6);
  frame.set(bytes, 6 + id.byteLength);
  return frame;
};

const decodeOpaqueFrame = (value) => {
  const frame = new Uint8Array(value);
  if (frame.byteLength < 6) {
    return null;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const idLength = view.getUint8(0);
  const dataOffset = 6 + idLength;
  if (dataOffset > frame.byteLength) {
    return null;
  }
  return {
    streamId: new TextDecoder().decode(frame.subarray(6, dataOffset)),
    sequence: view.getUint32(1),
    eof: Boolean(view.getUint8(5) & 1),
    data: frame.subarray(dataOffset),
  };
};

const element = (name, attributes = {}, text = "") => {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "hidden") {
      node.hidden = Boolean(value);
    } else if (key === "disabled") {
      node.disabled = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  node.textContent = text;
  return node;
};

const mutationKey = () => globalThis.crypto?.randomUUID?.()
  ?? `planning-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const submitPlanningMutation = async (path, body, expectedRevision, csrfToken) => {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sandking-csrf": csrfToken,
      "x-sandking-idempotency-key": mutationKey(),
      "x-sandking-expected-revision": String(expectedRevision),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const renderPreparedProject = (current) => {
  if (!current) {
    return element(
      "p",
      { id: "project-not-selected", "data-project-selected": "false" },
      "No Project path has been selected.",
    );
  }
  const card = element("article", {
    id: "project-readiness",
    "data-project-selected": "true",
    "data-project-id": current.projectId,
    "data-project-revision": current.revision,
    "data-harness-id": current.harness?.harnessId ?? "",
    "data-harness-pin": current.harness?.pinnedRevision ?? "",
    "data-checks-readiness": current.readiness.checks,
    "data-configuration-readiness": current.readiness.configuration,
    "data-launch-request-ready": String(current.canPrepareLaunchRequest),
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
    element("p", {}, current.harness
      ? `Pinned immutable revision: ${current.harness.pinnedRevision}`
      : "Pinned immutable revision: missing"),
    element("p", { "data-launch-guidance": current.readiness.launchRequest },
      current.canPrepareLaunchRequest
        ? "A Launch request can be prepared."
        : `Launch request preparation is blocked: ${current.readiness.diagnostics.join(", ")}`),
  );
  return card;
};

const renderProjectPreparation = (preparation, session) => {
  const section = element("section", {
    id: "project-preparation",
    "data-explicit-path-only": "true",
    "data-directory-scanning": String(preparation.selection.directoryScanning),
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
  const openButton = element("button", {
    id: "open-project",
    type: "button",
    "data-action": "open-project",
  }, "Open and prepare Project");
  const feedback = element("p", { id: "project-feedback", role: "status" });
  let currentNode = renderPreparedProject(preparation.current);
  let currentProject = preparation.current;
  let expectedRevision = preparation.current?.revision ?? 0;
  const openController = element("button", {
    id: "open-project-controller",
    type: "button",
    "data-action": "open-project-controller",
    disabled: !preparation.current?.canPrepareLaunchRequest,
  }, "Open focused Controller for Launch");
  const controllerFeedback = element("p", {
    id: "project-controller-feedback",
    role: "status",
  });
  const controllerPanel = element("section", {
    id: "project-focused-controller-session",
    "data-session-state": "closed",
    hidden: true,
  });

  openButton.addEventListener("click", async () => {
    openButton.disabled = true;
    feedback.textContent = "Opening the selected Project path…";
    const response = await fetch("/projects/open", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandking-csrf": session.csrfToken,
        "x-sandking-idempotency-key": mutationKey(),
        "x-sandking-expected-revision": String(expectedRevision),
      },
      body: JSON.stringify({
        path: pathInput.value,
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
      if (
        outcome.code === "mutation_revision_conflict"
        && Number.isSafeInteger(outcome.actualRevision)
      ) {
        expectedRevision = outcome.actualRevision;
      }
      feedback.textContent = `Project was not changed: ${outcome.code}. ${
        outcome.resolution?.actions?.join(", ") ?? "Review the typed guidance."}`;
      openButton.disabled = false;
      return;
    }
    expectedRevision = outcome.project.revision;
    currentProject = outcome.project;
    const replacement = renderPreparedProject(outcome.project);
    currentNode.replaceWith(replacement);
    currentNode = replacement;
    feedback.textContent = "Project and conformance Harness are ready for Launch preparation.";
    openController.disabled = !outcome.project.canPrepareLaunchRequest;
    openButton.disabled = false;
  });

  openController.addEventListener("click", async () => {
    if (!currentProject) {
      return;
    }
    openController.disabled = true;
    controllerFeedback.textContent = "Opening the owning focused Controller session…";
    const response = await fetch("/projects/sessions/open", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandking-csrf": session.csrfToken,
        "x-sandking-idempotency-key": mutationKey(),
        "x-sandking-expected-revision": String(currentProject.revision),
      },
      body: JSON.stringify({ projectId: currentProject.projectId }),
    });
    const outcome = await response.json();
    if (!response.ok || outcome.type !== "mutation_result") {
      controllerFeedback.textContent = `Focused Controller failed safely: ${outcome.code}.`;
      openController.disabled = false;
      return;
    }
    const focused = outcome.session;
    controllerPanel.hidden = false;
    controllerPanel.dataset.sessionState = "open";
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
    const terminalOutput = element("pre", {
      id: "project-controller-terminal-output",
      "data-terminal-output": focused.terminal.streamId,
      "aria-live": "polite",
    });
    const terminalInput = element("input", {
      id: "project-controller-terminal-input",
      type: "text",
      autocomplete: "off",
      "aria-label": "Project Controller terminal input",
    });
    const sendInput = element("button", {
      id: "send-project-controller-input",
      type: "button",
      disabled: true,
    }, "Send to Controller");
    const terminalState = {
      attachmentId: focused.terminal.writableAttachment.attachmentId,
      decoder: new TextDecoder(),
      inputSequence: 0,
      output: terminalOutput,
      panel: controllerPanel,
      sendInput,
      terminalInput,
    };
    terminalStreams.set(focused.terminal.streamId, terminalState);
    const submitTerminalInput = () => {
      if (socket.readyState !== WebSocket.OPEN || sendInput.disabled) {
        return;
      }
      const input = `${terminalInput.value}\n`;
      terminalInput.value = "";
      socket.send(encodeOpaqueFrame(
        focused.terminal.streamId,
        terminalState.inputSequence,
        new TextEncoder().encode(input),
      ));
      terminalState.inputSequence += 1;
    };
    sendInput.addEventListener("click", submitTerminalInput);
    terminalInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitTerminalInput();
      }
    });
    controllerPanel.replaceChildren(
      element("p", {}, `Focused Controller session ${focused.sessionId} owns Launch decisions for ${focused.workContext.workContextId}.`),
      element("p", { "data-browser-approval": "prohibited" },
        "The Cockpit can navigate to this conversation but cannot submit a Launch approval assertion."),
      terminalOutput,
      terminalInput,
      sendInput,
    );
    socket.send(JSON.stringify({
      channel: "control",
      message: {
        type: "browser.terminal.attach",
        sessionId: focused.sessionId,
        streamId: focused.terminal.streamId,
        attachmentId: focused.terminal.writableAttachment.attachmentId,
        mode: "read-write",
        outputCursor: 0,
      },
    }));
    controllerFeedback.textContent =
      "Use the focused Controller conversation to inspect, prepare, approve, or reject.";
  });

  section.append(
    element("h3", {}, "Bounded Project configuration"),
    element("p", {}, "Issue workflow: GitHub Issues"),
    pathLabel,
    pathInput,
    typecheckLabel,
    typecheckInput,
    testLabel,
    testInput,
    openButton,
    feedback,
    currentNode,
    openController,
    controllerFeedback,
    controllerPanel,
    element("p", { "data-project-scope": "registration-only" },
      "This slice does not project a Harness into the Project or provide import, update, rollback, switching, or drift recovery."),
  );
  return section;
};

const requestHarnessRunObservation = () => {
  if (!runtimeNegotiated || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({
    channel: "control",
    message: {
      type: "browser.harness-run.observe",
      requestId: `harness-observe-${harnessRequestSequence}`,
      harnessRunId: null,
      afterSequence: 0,
    },
  }));
  harnessRequestSequence += 1;
};

const renderHarnessRun = (observation) => {
  const section = element("section", {
    id: "harness-run-observation",
    "data-observation-mode": observation.mode,
    "data-run-present": String(Boolean(observation.run)),
  });
  section.append(
    element("h2", {}, "Harness run observation"),
    element("p", { "data-observation-independent": "true" },
      "Observation is independent of the browser and focused Controller session lifecycle."),
  );
  if (!observation.run) {
    section.append(element("p", { id: "harness-run-empty" },
      "No approved Harness run has started."));
    return section;
  }
  const run = observation.run;
  section.dataset.runId = run.harnessRunId;
  section.dataset.runStatus = run.status;
  section.dataset.launchRequestId = run.launchRequestId;
  section.dataset.harnessPin = run.harnessPinnedRevision;
  section.append(
    element("h3", {}, `Harness run ${run.harnessRunId}`),
    element("p", { "data-run-status": run.status }, `Lifecycle status: ${run.status}`),
    element("p", {}, `Launch request: ${run.launchRequestId}`),
    element("p", {}, `Harness: ${run.harnessId} @ ${run.harnessPinnedRevision}`),
  );
  const events = element("ol", {
    id: "harness-run-events",
    "data-event-count": observation.events.length,
    "data-event-sequences": observation.events.map((event) => event.sequence).join(","),
  });
  for (const event of observation.events) {
    events.append(element("li", {
      "data-event-id": event.eventId,
      "data-event-sequence": event.sequence,
      "data-event-type": event.type,
    }, `${event.sequence}. ${event.type}${event.progressRecord
      ? ` — ${event.progressRecord.summary}`
      : ""}`));
  }
  section.append(element("h3", {}, "Ordered lifecycle events"), events);

  const logs = element("section", {
    id: "harness-run-diagnostics",
    "data-logs-separate": "true",
    "data-conversation-insertion": "false",
  });
  logs.append(element("p", {},
    "Diagnostic logs are explicitly ranged and are never inserted into a Controller conversation."));
  for (const producer of ["stdout", "stderr"]) {
    const stream = observation.logStreams.find((candidate) => candidate.producer === producer);
    logs.append(
      element("h4", {}, `${producer} diagnostics`),
      element("pre", {
        "data-log-producer": producer,
        "data-log-stream-id": stream?.streamId ?? "",
        "data-range-start": stream?.availableStart ?? 0,
        "data-range-end": stream?.availableEnd ?? 0,
        "data-explicit-retrieval": String(stream?.explicitRetrievalRequired ?? true),
        "data-conversation-inserted": String(stream?.insertedIntoControllerConversation ?? false),
      }),
    );
  }
  section.append(logs);
  const outcome = element("pre", {
    id: "harness-run-structured-outcome",
    "data-outcome-status": observation.outcome?.status ?? "pending",
    "data-incomplete-result": String(observation.outcome?.incompleteResult ?? false),
  }, observation.outcome ? JSON.stringify(observation.outcome, null, 2) : "Outcome pending");
  section.append(
    element("h3", {}, "Structured outcome"),
    outcome,
    element("p", {
      id: "harness-terminal-validation",
      "data-exactly-one-terminal": String(
        observation.terminalEnvelopeValidation?.exactlyOne ?? false,
      ),
      "data-process-exit-observed": String(
        observation.terminalEnvelopeValidation?.processExitObserved ?? false,
      ),
    }, observation.terminalEnvelopeValidation
      ? `Terminal envelopes: ${observation.terminalEnvelopeValidation.validTerminalEnvelopeCount}; process exit observed: ${observation.terminalEnvelopeValidation.processExitObserved}.`
      : "Terminal envelope validation pending."),
  );
  return section;
};

const applyHarnessRunObservation = (observation) => {
  const replacement = renderHarnessRun(observation);
  harnessRunSection?.replaceWith(replacement);
  harnessRunSection = replacement;
  diagnosticStreams.clear();
  if (observation.run) {
    for (const stream of observation.logStreams) {
      if (stream.availableEnd === 0) {
        continue;
      }
      socket.send(JSON.stringify({
        channel: "control",
        message: {
          type: "browser.harness-run.logs.get",
          requestId: `harness-logs-${stream.producer}-${harnessRequestSequence}`,
          harnessRunId: observation.run.harnessRunId,
          producer: stream.producer,
          offset: 0,
          limit: Math.min(16_384, Math.max(1, stream.availableEnd)),
        },
      }));
      harnessRequestSequence += 1;
    }
  }
  clearTimeout(harnessObservationTimer);
  if (!observation.run || !["succeeded", "failed", "cancelled"].includes(observation.run.status)) {
    harnessObservationTimer = setTimeout(requestHarnessRunObservation, 75);
  }
};

const renderPlanning = (planning, session) => {
  const section = element("section", {
    id: "planning-spine",
    "data-planning-ready": "true",
    "data-adapter-fixture": String(planning.adapter.fixture),
  });
  section.append(
    element("h2", {}, "Planning Journey Rail"),
    element("p", { "data-projection-provenance": planning.adapter.adapterId },
      planning.adapter.label),
  );

  const feedback = element("p", { id: "planning-feedback", role: "status" });
  const sessionPanel = element("section", {
    id: "focused-controller-session",
    "data-session-state": "closed",
    hidden: true,
  });

  for (const journey of planning.journeys) {
    const journeyNode = element("article", {
      "data-journey-id": journey.journeyId,
      "data-freshness": journey.projection.freshness,
      "data-projection-id": journey.projection.projectionId,
      "data-projection-digest": journey.projection.projectionDigest,
      "data-ordinary-work-blocked": String(journey.ordinaryWork.blocked),
    });
    journeyNode.append(element("h3", {}, journey.title));
    if (journey.projection.freshness === "stale") {
      journeyNode.append(element(
        "p",
        { role: "alert", "data-stale-code": journey.projection.refreshFailure?.code ?? "stale" },
        "GitHub canonical projection is visibly stale; mutation is disabled and no write is queued.",
      ));
    }
    journeyNode.append(element(
      "p",
      { "data-ordinary-work-status": journey.ordinaryWork.status },
      "Ordinary work remains available; Planning is optional.",
    ));
    const rail = element("ol", { "data-journey-rail": "built-in" });
    for (const stage of journey.stages) {
      const stageNode = element("li", {
        "data-stage-id": stage.stageId,
        "data-stage-status": stage.status,
        "data-stage-revision": String(stage.revision),
        "data-work-context-id": stage.workContext.workContextId,
      });
      const status = element("span", { "data-stage-status-label": "true" }, stage.status);
      stageNode.append(
        element("strong", {}, stage.label),
        document.createTextNode(" — "),
        status,
        element("p", {}, `Fixture artifact: ${stage.artifact.title}`),
      );
      const mutationEnabled = journey.projection.mutationsEnabled && stage.mutation.enabled;
      const openSession = element("button", {
        type: "button",
        "data-action": "open-session",
        "data-planning-mutation": "true",
        disabled: !mutationEnabled,
      }, "Open focused session");
      openSession.addEventListener("click", async () => {
        openSession.disabled = true;
        const outcome = await submitPlanningMutation(
          "/planning/sessions/open",
          { workContextId: stage.workContext.workContextId },
          0,
          session.csrfToken,
        );
        if (outcome.body.type !== "mutation_result") {
          feedback.textContent = `Focused session failed safely: ${outcome.body.code}`;
          openSession.disabled = !mutationEnabled;
          return;
        }
        sessionPanel.hidden = false;
        sessionPanel.dataset.sessionState = "open";
        sessionPanel.dataset.sessionId = outcome.body.session.sessionId;
        sessionPanel.dataset.workContextId = outcome.body.session.workContext.workContextId;
        sessionPanel.dataset.providerId = outcome.body.session.provider.providerId;
        sessionPanel.dataset.providerAdapterId = outcome.body.session.provider.adapterId;
        sessionPanel.dataset.providerSessionId = outcome.body.session.provider.providerSessionId;
        sessionPanel.dataset.providerControlProtocol =
          outcome.body.session.provider.readiness.controlProtocol;
        sessionPanel.dataset.providerReadySignal =
          outcome.body.session.provider.readiness.signal;
        sessionPanel.dataset.providerObservedTty = String(
          outcome.body.session.provider.readiness.providerObservedTty,
        );
        sessionPanel.dataset.terminalStreamId = outcome.body.session.terminal.streamId;
        sessionPanel.dataset.terminalAttachmentId =
          outcome.body.session.terminal.writableAttachment.attachmentId;
        sessionPanel.dataset.ptyRuntimeOwned = String(
          outcome.body.session.terminal.runtimeOwned,
        );
        sessionPanel.dataset.terminalAttachment = "attaching";
        const terminalOutput = element("pre", {
          id: "controller-terminal-output",
          "data-terminal-output": outcome.body.session.terminal.streamId,
          "aria-live": "polite",
        });
        const terminalInput = element("input", {
          id: "controller-terminal-input",
          type: "text",
          autocomplete: "off",
          "aria-label": "Controller terminal input",
        });
        const sendInput = element("button", {
          id: "send-controller-input",
          type: "button",
          disabled: true,
        }, "Send to Controller");
        const terminalState = {
          attachmentId: outcome.body.session.terminal.writableAttachment.attachmentId,
          decoder: new TextDecoder(),
          inputSequence: 0,
          output: terminalOutput,
          panel: sessionPanel,
          sendInput,
          terminalInput,
        };
        terminalStreams.set(outcome.body.session.terminal.streamId, terminalState);
        const submitTerminalInput = () => {
          if (socket.readyState !== WebSocket.OPEN || sendInput.disabled) {
            return;
          }
          const input = `${terminalInput.value}\n`;
          terminalInput.value = "";
          socket.send(encodeOpaqueFrame(
            outcome.body.session.terminal.streamId,
            terminalState.inputSequence,
            new TextEncoder().encode(input),
          ));
          terminalState.inputSequence += 1;
        };
        sendInput.addEventListener("click", submitTerminalInput);
        terminalInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submitTerminalInput();
          }
        });
        sessionPanel.replaceChildren(
          element("p", {}, "Focused conformance Controller session opened for "
            + `${outcome.body.session.workContext.workContextId} `
            + `(${outcome.body.session.sessionId}).`),
          terminalOutput,
          terminalInput,
          sendInput,
        );
        socket.send(JSON.stringify({
          channel: "control",
          message: {
            type: "browser.terminal.attach",
            sessionId: outcome.body.session.sessionId,
            streamId: outcome.body.session.terminal.streamId,
            attachmentId: outcome.body.session.terminal.writableAttachment.attachmentId,
            mode: "read-write",
            outputCursor: 0,
          },
        }));
        feedback.textContent = "Selected Planning work opened in an independently identified session.";
      });
      const notUsed = element("button", {
        type: "button",
        "data-action": "not-used",
        "data-planning-mutation": "true",
        disabled: !mutationEnabled || !stage.optional,
      }, "Mark Not used");
      notUsed.addEventListener("click", async () => {
        notUsed.disabled = true;
        const outcome = await submitPlanningMutation(
          "/planning/stages/not-used",
          { journeyId: journey.journeyId, stageId: stage.stageId },
          stage.revision,
          session.csrfToken,
        );
        if (outcome.body.type !== "mutation_result") {
          feedback.textContent = `Not used failed safely: ${outcome.body.code}`;
          notUsed.disabled = !mutationEnabled;
          return;
        }
        stage.status = outcome.body.stage.status;
        stage.revision = outcome.body.stage.revision;
        stageNode.dataset.stageStatus = outcome.body.stage.status;
        stageNode.dataset.stageRevision = String(outcome.body.stage.revision);
        status.textContent = outcome.body.stage.status;
        for (const button of stageNode.querySelectorAll("button[data-planning-mutation]")) {
          button.disabled = true;
        }
        journeyNode.dataset.ordinaryWorkBlocked = String(outcome.body.ordinaryWorkBlocked);
        feedback.textContent = "Stage marked Not used. Ordinary work remains available.";
      });
      stageNode.append(openSession, notUsed);
      rail.append(stageNode);
    }
    journeyNode.append(rail);
    section.append(journeyNode);
  }
  section.append(
    sessionPanel,
    feedback,
    element(
      "p",
      { "data-planning-scope": "thin-spine" },
      "This thin Planning spine does not include skill-owned reasoning, private Specifications, "
        + "Ticket-set publication, complete optional or out-of-order behavior, or downstream Needs review.",
    ),
  );
  return section;
};

const requireReload = (code) => {
  document.documentElement.dataset.reloadRequired = "true";
  document.documentElement.dataset.protocolError = code;
  app.textContent = "Cockpit update required. Reload to reconnect safely.";
  reload.hidden = false;
};

reload.addEventListener("click", () => location.reload());

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({
    channel: "control",
    message: {
      type: "browser.hello",
      ...browserProtocol,
      observationCursor: sessionStorage.getItem("sandking.observationCursor"),
    },
  }));
});

socket.addEventListener("message", (event) => {
  if (typeof event.data !== "string") {
    // Opaque terminal streams are binary and never parsed as structured control.
    document.documentElement.dataset.opaqueStreamReceived = "true";
    const opaque = decodeOpaqueFrame(event.data);
    const terminal = opaque ? terminalStreams.get(opaque.streamId) : null;
    if (opaque && terminal) {
      terminal.output.textContent += terminal.decoder.decode(opaque.data, {
        stream: !opaque.eof,
      });
      terminal.output.dataset.outputSequence = String(opaque.sequence);
      if (opaque.eof) {
        terminal.panel.dataset.sessionState = "exited";
        terminal.sendInput.disabled = true;
      }
    } else if (opaque) {
      const diagnostic = diagnosticStreams.get(opaque.streamId);
      if (diagnostic) {
        diagnostic.output.textContent += diagnostic.decoder.decode(opaque.data, {
          stream: !opaque.eof,
        });
        diagnostic.output.dataset.outputSequence = String(opaque.sequence);
        diagnostic.output.dataset.rangeEof = String(opaque.eof);
      }
    }
    return;
  }

  let envelope;
  try {
    envelope = JSON.parse(event.data);
  } catch {
    requireReload("runtime_control_json_invalid");
    return;
  }

  const message = envelope?.channel === "control" ? envelope.message : null;
  if (message?.type === "runtime.protocol-error") {
    if (message.reloadRequired) {
      requireReload(message.code);
    } else {
      app.textContent = `Connection failed safely: ${message.code}`;
    }
    return;
  }

  if (message?.type === "runtime.terminal-attached") {
    const terminal = terminalStreams.get(message.streamId);
    if (
      !runtimeNegotiated
      || !terminal
      || terminal.attachmentId !== message.attachmentId
      || message.mode !== "read-write"
      || message.exclusive !== true
    ) {
      requireReload("runtime_terminal_attachment_mismatch");
      return;
    }
    terminal.panel.dataset.terminalAttachment = "read-write";
    terminal.sendInput.disabled = false;
    return;
  }

  if (message?.type === "runtime.harness-run.observation") {
    if (!runtimeNegotiated) {
      requireReload("runtime_harness_observation_before_negotiation");
      return;
    }
    applyHarnessRunObservation(message.observation);
    return;
  }

  if (message?.type === "runtime.harness-run.logs.result") {
    if (!runtimeNegotiated || !harnessRunSection) {
      requireReload("runtime_harness_logs_before_negotiation");
      return;
    }
    const output = harnessRunSection.querySelector(
      `[data-log-producer="${message.producer}"]`,
    );
    if (!output || output.dataset.logStreamId !== message.streamId) {
      requireReload("runtime_harness_log_stream_mismatch");
      return;
    }
    output.textContent = "";
    output.dataset.rangeStart = String(message.range.start);
    output.dataset.rangeEnd = String(message.range.end);
    diagnosticStreams.set(message.streamId, {
      output,
      decoder: new TextDecoder(),
    });
    return;
  }

  if (message?.type === "runtime.pong") {
    return;
  }

  const runtimeRequired = Array.isArray(message?.capabilities?.required)
    ? message.capabilities.required
    : [];
  const runtimeOptional = Array.isArray(message?.capabilities?.optional)
    ? message.capabilities.optional
    : [];
  const negotiated = Array.isArray(message?.negotiatedCapabilities)
    ? message.negotiatedCapabilities
    : [];
  const browserKnown = new Set([
    ...browserProtocol.capabilities.required,
    ...browserProtocol.capabilities.optional,
  ]);
  const runtimeAdvertised = new Set([...runtimeRequired, ...runtimeOptional]);
  const capabilitiesCompatible = runtimeRequired.every((capability) =>
    browserKnown.has(capability))
    && browserProtocol.capabilities.required.every((capability) =>
      negotiated.includes(capability))
    && negotiated.every((capability) =>
      browserKnown.has(capability) && runtimeAdvertised.has(capability));
  const framingCompatible = Number.isSafeInteger(message?.framing?.maxControlMessageBytes)
    && message.framing.maxControlMessageBytes > 0
    && message.framing.maxControlMessageBytes <= browserProtocol.framing.maxControlMessageBytes
    && Number.isSafeInteger(message?.framing?.maxOpaqueStreamChunkBytes)
    && message.framing.maxOpaqueStreamChunkBytes > 0
    && message.framing.maxOpaqueStreamChunkBytes
      <= browserProtocol.framing.maxOpaqueStreamChunkBytes;
  const durableIdentitiesCompatible = /^runtime-[a-f0-9]{24}$/
    .test(message?.viewModel?.runtime?.runtimeId ?? "")
    && /^host-[a-f0-9]{24}$/.test(message?.viewModel?.host?.hostId ?? "");
  const planningCompatible = message?.viewModel?.planning?.kind === "cockpit.planning-spine"
    && message.viewModel.planning.adapter?.fixture === true
    && JSON.stringify(message.viewModel.planning.builtInStages)
      === JSON.stringify(["wayfinding", "speccing", "ticketing"]);
  const projectPreparationCompatible =
    message?.viewModel?.projectPreparation?.kind === "cockpit.project-preparation"
    && message.viewModel.projectPreparation.selection?.mode === "explicit-host-path"
    && message.viewModel.projectPreparation.selection?.directoryScanning === false
    && message.viewModel.projectPreparation.conformanceHarness?.permittedTestDouble === true;

  if (
    message?.type !== "runtime.hello-ack"
    || message.protocol?.major !== browserProtocol.protocol.major
    || message.identity !== browserProtocol.expectedPeerIdentity
    || message.peerIdentity !== browserProtocol.identity
    || message.schemaDigest !== browserProtocol.schemaDigest
    || !capabilitiesCompatible
    || !framingCompatible
    || !durableIdentitiesCompatible
    || !planningCompatible
    || !projectPreparationCompatible
    || message.viewModel?.kind !== "cockpit.connection"
  ) {
    requireReload("browser_runtime_handshake_mismatch");
    return;
  }

  sessionStorage.setItem("sandking.observationCursor", message.observation.cursor);
  runtimeNegotiated = true;
  document.documentElement.dataset.observationMode = message.observation.mode;
  document.documentElement.dataset.protocolVersion = message.protocol.version;
  app.textContent = "";
  app.append(
    element(
      "p",
      { id: "connection-status" },
      `Connected to ${message.viewModel.host.identity} with protocol ${message.protocol.version}`
        + ` (${message.viewModel.host.hostId})`,
    ),
    renderProjectPreparation(message.viewModel.projectPreparation, message.session),
    renderHarnessRun({
      mode: "snapshot",
      run: null,
      events: [],
      outcome: null,
      logStreams: [],
      terminalEnvelopeValidation: null,
    }),
    renderPlanning(message.viewModel.planning, message.session),
  );
  harnessRunSection = document.getElementById("harness-run-observation");
  requestHarnessRunObservation();
});

socket.addEventListener("close", (event) => {
  clearTimeout(harnessObservationTimer);
  if (!document.documentElement.dataset.protocolError && !event.wasClean) {
    app.textContent = "Host connection is stale. Retry by reloading the Cockpit.";
  }
});
