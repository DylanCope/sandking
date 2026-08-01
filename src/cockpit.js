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
    ],
    optional: [],
  },
  schemaDigest: "sha256:2e2991f6b45819a098d3224fbeeaf1fb5437c0d74bf5908395beee5d8524a48c",
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
        sessionPanel.textContent = "Focused conformance Controller session opened for "
          + `${outcome.body.session.workContext.workContextId} `
          + `(${outcome.body.session.sessionId}).`;
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
    || message.viewModel?.kind !== "cockpit.connection"
  ) {
    requireReload("browser_runtime_handshake_mismatch");
    return;
  }

  sessionStorage.setItem("sandking.observationCursor", message.observation.cursor);
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
    renderPlanning(message.viewModel.planning, message.session),
  );
});

socket.addEventListener("close", (event) => {
  if (!document.documentElement.dataset.protocolError && !event.wasClean) {
    app.textContent = "Host connection is stale. Retry by reloading the Cockpit.";
  }
});
