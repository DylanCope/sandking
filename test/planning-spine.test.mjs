import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlanningSpine } from "../src/planning-spine.mjs";

test("the Planning spine projects fixture-labelled built-in stages and stale authority honestly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-planning-projection-"));
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };

  try {
    const planning = await createPlanningSpine({ dataDir, recordAudit });
    const projection = await planning.project();

    assert.equal(projection.kind, "cockpit.planning-spine");
    assert.deepEqual(projection.builtInStages, ["wayfinding", "speccing", "ticketing"]);
    assert.deepEqual(projection.adapter, {
      adapterId: "github-conformance-fixture-v1",
      authority: "github",
      fixture: true,
      label: "Conformance fixture data — not live GitHub",
    });
    assert.deepEqual(projection.excludedCapabilities, [
      "skill-owned-reasoning",
      "private-specifications",
      "ticket-set-publication",
      "complete-optional-or-out-of-order-planning",
      "downstream-needs-review",
    ]);

    const fresh = projection.journeys.find((journey) =>
      journey.journeyId === "journey-fixture-optional-planning");
    assert.ok(fresh);
    assert.equal(fresh.projection.freshness, "fresh");
    assert.equal(fresh.projection.mutationsEnabled, true);
    assert.match(fresh.projection.projectionDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(fresh.stages.map((stage) => stage.stageId), projection.builtInStages);
    assert.ok(fresh.stages.every((stage) =>
      stage.workContext.workContextId.startsWith("work-context-")
      && stage.workContext.canonicalReference.startsWith("github:fixture:issue:")));
    assert.deepEqual(fresh.ordinaryWork, { status: "available", blocked: false });

    const stale = projection.journeys.find((journey) =>
      journey.journeyId === "journey-fixture-unrefreshable");
    assert.ok(stale);
    assert.equal(stale.projection.freshness, "stale");
    assert.equal(stale.projection.mutationsEnabled, false);
    assert.deepEqual(stale.projection.refreshFailure, {
      code: "github_projection_unavailable",
      retryable: true,
    });
    assert.ok(stale.stages.every((stage) => stage.mutation.enabled === false));
    assert.deepEqual(audits, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("opening fixture-backed Planning work creates one focused conformance Controller session", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-planning-session-"));
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  const contract = {
    authorizationAccepted: true,
    idempotencyKeyHash: `sha256:${"a".repeat(64)}`,
    expectedRevision: 0,
    workContextId: "work-context-speccing-optional-planning",
  };

  try {
    const planning = await createPlanningSpine({ dataDir, recordAudit });
    const opened = await planning.openFocusedSession(contract);
    assert.equal(opened.status, 201);
    assert.deepEqual(opened.body, {
      type: "mutation_result",
      code: "focused_controller_session_opened",
      authorizationClass: "planning_focused_session",
      expectedRevision: 0,
      revision: 1,
      idempotentReplay: false,
      auditId: opened.body.auditId,
      session: {
        sessionId: opened.body.session.sessionId,
        focused: true,
        provider: {
          providerId: "conformance-controller-v1",
          kind: "conformance",
          fixture: true,
        },
        workContext: {
          workContextId: "work-context-speccing-optional-planning",
          kind: "planning-stage",
          canonicalReference: "github:fixture:issue:116",
        },
      },
      prohibitedSideEffects: {
        githubWrite: false,
        queuedWrite: false,
        skillInvocation: false,
        projectFileWrite: false,
      },
    });
    assert.match(opened.body.session.sessionId, /^controller-session-[a-f0-9]{24}$/);
    assert.match(opened.body.auditId, /^audit-/);

    const replay = await planning.openFocusedSession(contract);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, { ...opened.body, idempotentReplay: true });

    const changedUse = await planning.openFocusedSession({
      ...contract,
      workContextId: "work-context-ticketing-optional-planning",
    });
    assert.equal(changedUse.status, 409);
    assert.equal(changedUse.body.type, "mutation_failure");
    assert.equal(changedUse.body.code, "idempotency_key_conflict");
    assert.equal(changedUse.body.authorizationClass, "planning_focused_session");
    assert.equal(changedUse.body.retryable, false);
    assert.match(changedUse.body.auditId, /^audit-/);

    assert.deepEqual(audits.map(({ action, outcome }) => ({ action, outcome })), [
      { action: "planning.session.open", outcome: "accepted" },
      { action: "planning.session.open", outcome: "observed" },
      { action: "planning.session.open", outcome: "rejected" },
    ]);
    assert.match(audits[0].details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(audits[0].details.workContextId, contract.workContextId);
    assert.equal(audits[0].details.resultingRevision, 1);
    assert.equal(audits[0].details.projectFileWrite, false);

    const staleProjection = await planning.openFocusedSession({
      ...contract,
      idempotencyKeyHash: `sha256:${"f".repeat(64)}`,
      workContextId: "work-context-speccing-unrefreshable",
    });
    assert.equal(staleProjection.status, 409);
    assert.equal(staleProjection.body.code, "projection_stale");
    assert.equal(staleProjection.body.prohibitedSideEffects.queuedWrite, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Not used is authorized, revisioned, concurrent-idempotent, audited, and fail-closed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-planning-not-used-"));
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  const contract = {
    authorizationAccepted: true,
    idempotencyKeyHash: `sha256:${"b".repeat(64)}`,
    expectedRevision: 1,
    journeyId: "journey-fixture-optional-planning",
    stageId: "ticketing",
  };

  try {
    const planning = await createPlanningSpine({ dataDir, recordAudit });
    const outcomes = await Promise.all(Array.from(
      { length: 8 },
      () => planning.markStageNotUsed(contract),
    ));
    assert.deepEqual(outcomes.map((outcome) => outcome.status), Array(8).fill(200));
    const fresh = outcomes.filter((outcome) => !outcome.body.idempotentReplay);
    assert.equal(fresh.length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.body.idempotentReplay).length, 7);
    assert.equal(new Set(outcomes.map((outcome) => outcome.body.auditId)).size, 1);
    assert.deepEqual(fresh[0].body, {
      type: "mutation_result",
      code: "planning_stage_not_used",
      authorizationClass: "planning_stage_status",
      expectedRevision: 1,
      revision: 2,
      idempotentReplay: false,
      auditId: fresh[0].body.auditId,
      journeyId: "journey-fixture-optional-planning",
      stage: {
        stageId: "ticketing",
        status: "Not used",
        revision: 2,
      },
      ordinaryWorkBlocked: false,
      prohibitedSideEffects: {
        githubWrite: false,
        queuedWrite: false,
        skillInvocation: false,
        projectFileWrite: false,
      },
    });
    assert.match(fresh[0].body.auditId, /^audit-/);

    const projected = await planning.project();
    const updatedJourney = projected.journeys.find((journey) =>
      journey.journeyId === contract.journeyId);
    const updatedStage = updatedJourney.stages.find((stage) => stage.stageId === "ticketing");
    assert.equal(updatedStage.status, "Not used");
    assert.equal(updatedStage.revision, 2);
    assert.equal(updatedJourney.ordinaryWork.blocked, false);

    const changedUse = await planning.markStageNotUsed({
      ...contract,
      stageId: "speccing",
    });
    assert.equal(changedUse.status, 409);
    assert.equal(changedUse.body.code, "idempotency_key_conflict");
    assert.equal(changedUse.body.retryable, false);

    const staleRevision = await planning.markStageNotUsed({
      ...contract,
      idempotencyKeyHash: `sha256:${"c".repeat(64)}`,
    });
    assert.equal(staleRevision.status, 409);
    assert.equal(staleRevision.body.code, "mutation_revision_conflict");
    assert.equal(staleRevision.body.actualRevision, 2);

    const unavailableProjection = await planning.markStageNotUsed({
      ...contract,
      idempotencyKeyHash: `sha256:${"d".repeat(64)}`,
      journeyId: "journey-fixture-unrefreshable",
      stageId: "ticketing",
    });
    assert.equal(unavailableProjection.status, 409);
    assert.equal(unavailableProjection.body.code, "projection_stale");
    assert.equal(unavailableProjection.body.retryable, true);

    const unauthorized = await planning.markStageNotUsed({
      ...contract,
      authorizationAccepted: false,
      idempotencyKeyHash: `sha256:${"e".repeat(64)}`,
      stageId: "speccing",
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.body.code, "authorization_failed");

    const restarted = await createPlanningSpine({ dataDir, recordAudit });
    const replayAfterRestart = await restarted.markStageNotUsed(contract);
    assert.equal(replayAfterRestart.status, 200);
    assert.equal(replayAfterRestart.body.idempotentReplay, true);
    assert.equal(replayAfterRestart.body.auditId, fresh[0].body.auditId);

    const accepted = audits.find((entry) =>
      entry.action === "planning.stage.not-used" && entry.outcome === "accepted");
    assert.ok(accepted);
    assert.deepEqual({
      authorizationClass: accepted.details.authorizationClass,
      expectedRevision: accepted.details.expectedRevision,
      actualRevision: accepted.details.actualRevision,
      resultingRevision: accepted.details.resultingRevision,
      journeyId: accepted.details.journeyId,
      stageId: accepted.details.stageId,
      githubWrite: accepted.details.githubWrite,
      queuedWrite: accepted.details.queuedWrite,
      skillInvocation: accepted.details.skillInvocation,
      projectFileWrite: accepted.details.projectFileWrite,
    }, {
      authorizationClass: "planning_stage_status",
      expectedRevision: 1,
      actualRevision: 1,
      resultingRevision: 2,
      journeyId: contract.journeyId,
      stageId: contract.stageId,
      githubWrite: false,
      queuedWrite: false,
      skillInvocation: false,
      projectFileWrite: false,
    });
    assert.match(accepted.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
