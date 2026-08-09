import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ISSUE_164_DEMONSTRATED_PATHS } from "./issue-164-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestUrl = new URL("../acceptance/issue-164.manifest.json", import.meta.url);
const evidenceUrl = new URL("../acceptance/evidence/issue-164.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const evidenceExists = await access(evidenceUrl).then(() => true, () => false);
const evidenceText = evidenceExists ? await readFile(evidenceUrl, "utf8") : null;
const evidence = evidenceText ? JSON.parse(evidenceText) : null;

const scenarioIds = [
  "durable-execution/reconciles-host-death-mid-run",
  "durable-execution/cancels-across-host-restart",
  "durable-execution/completion-wins-cancellation-race",
  "durable-execution/exposes-uncertain-supervision-for-recovery",
  "durable-execution/recovers-every-canonical-boundary",
];

test("issue 164 manifest qualifies all five durable-execution scenarios", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 164);
  assert.equal(manifest.parentPrd, 165);
  assert.equal(manifest.sourceSpecification.issue, 158);
  assert.match(manifest.sourceIssue.githubBodyUtf8Sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.sourcePrd.githubBodyUtf8Sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.scenarios.map(({ id }) => id), scenarioIds);
  for (const scenario of manifest.scenarios) {
    assert.ok(scenario.requirements.some((requirement) => /#(?:158|164)/.test(requirement)));
    for (const field of [
      "environmentAndTransport",
      "initialState",
      "actionsAndFaultPoints",
      "expectedTypedResults",
      "canonicalInvariants",
      "prohibitedSideEffects",
      "retainedEvidence",
    ]) {
      assert.ok(Array.isArray(scenario[field]), `${scenario.id}.${field} must be an array`);
      assert.ok(scenario[field].length > 0, `${scenario.id}.${field} must not be empty`);
    }
  }
});

test("issue 164 merge gate maps every canonical durability boundary to executable suites", () => {
  assert.deepEqual(manifest.verification.faultMatrix.map(({ boundary }) => boundary), [
    "run creation and retained launch outcome",
    "lifecycle event and current-view publication",
    "terminal-envelope acceptance and terminal outcome",
    "cancellation acceptance",
    "cancellation signalling and termination",
    "restart reconciliation",
    "recovery intent and action",
    "legacy-state migration",
  ]);
  for (const boundary of manifest.verification.faultMatrix) {
    assert.ok(boundary.faultPoints.some((point) => point.includes("before")));
    assert.ok(boundary.faultPoints.some((point) => point.includes("after")));
    assert.ok(boundary.executableEvidence.every((path) => path.startsWith("test/")));
  }
  const commandText = JSON.stringify(manifest.verification.commands);
  for (const suite of [
    "test/protocol.test.mjs",
    "test/browser-protocol.test.mjs",
    "test/harness-run.test.mjs",
    "test/host-loss-termination-evidence.test.mjs",
    "test/security-boundary.test.mjs",
    "test/host-death-reconciliation.browser.test.mjs",
  ]) {
    assert.match(commandText, new RegExp(suite.replaceAll(".", "\\.")));
  }
});

test("fault injection remains outside production CLI, Host, protocol, and browser contracts", async () => {
  const productionCliText = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(productionCliText, /--host-mode|\bhostMode\b/);

  const publicContractText = (await Promise.all([
    "../src/local-host.mjs",
    "../src/protocol.mjs",
    "../src/browser-protocol.mjs",
    "../src/runtime-daemon.mjs",
    "../src/cockpit.js",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")))).join("\n");
  assert.doesNotMatch(publicContractText,
    /pause-after-harness-run-cancellation-acceptance|harness_run_(?:migration|terminal_envelope|lifecycle)\.|faultInjector/);
});

test("retained issue 164 evidence identifies a current sanitized packaged qualification", {
  skip: evidenceExists ? false : "generated after the implementation commit",
}, async () => {
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.issue, 164);
  assert.equal(evidence.parentPrd, 165);
  assert.deepEqual(evidence.scenarioResults.map(({ id }) => id), scenarioIds);
  assert.ok(evidence.scenarioResults.every(({ passed }) => passed === true));
  await execFileAsync("git", [
    "merge-base", "--is-ancestor", evidence.generatedFromCommit, "HEAD",
  ], { cwd: repositoryRoot });
  const { stdout: changes } = await execFileAsync("git", [
    "diff", "--name-only", `${evidence.generatedFromCommit}..HEAD`, "--",
    ...ISSUE_164_DEMONSTRATED_PATHS,
  ], { cwd: repositoryRoot });
  assert.equal(changes.trim(), "", `issue 164 evidence predates changes:\n${changes}`);

  const realProcess = evidence.scenarioResults[0];
  assert.deepEqual({
    command: realProcess.packagedPublicSeam.command,
    installed: realProcess.packagedPublicSeam.installed,
    launchedOutsideCheckout: realProcess.packagedPublicSeam.launchedOutsideCheckout,
    transport: realProcess.packagedPublicSeam.transport,
  }, {
    command: "sandking",
    installed: true,
    launchedOutsideCheckout: true,
    transport: "loopback Cockpit -> authenticated WebSocket -> Controller runtime -> framed local Host",
  });
  for (const [name, pattern] of Object.entries({
    hostId: /^host-[a-f0-9]{24}$/,
    projectId: /^project-[a-f0-9]{24}$/,
    harnessId: /^harness-[a-f0-9]{24}$/,
    harnessRunId: /^harness-run-[a-f0-9]{24}$/,
  })) {
    assert.match(realProcess.identities[name], pattern);
  }
  assert.match(realProcess.identities.harnessPinnedCommit, /^[a-f0-9]{40}$/);
  assert.equal(realProcess.adapter.identity, "conformance-harness-adapter-v1");
  assert.equal(realProcess.adapter.protocol, "1.0.0");
  assert.ok(realProcess.eventReferences.length >= 3);
  assert.ok(realProcess.auditReferences.length >= 4);
  assert.ok(realProcess.retryKeyHashes.every((hash) => /^sha256:[a-f0-9]{64}$/.test(hash)));
  assert.equal(realProcess.faultPoint, "real_host_sigkill_after_active_publication");
  assert.equal(realProcess.reconciliationDecision, "finalize_failed_incomplete");
  assert.equal(realProcess.terminalEnvelopeValidation.exactlyOne, false);
  assert.equal(realProcess.typedOutcome.code, "host_daemon_interrupted");
  assert.equal(realProcess.typedOutcome.incompleteResult, true);
  assert.deepEqual(realProcess.sanitizedDiagnosticRanges.map(({ producer }) => producer), [
    "stdout",
    "stderr",
  ]);
  assert.ok(Object.values(evidence.securityAssertions).every(Boolean));
  assert.doesNotMatch(evidenceText,
    /host-death-reconciliation-secret|durable-environment-dump-164|raw-durable-retry-key-164|unrestricted-process-handle-164|TRACKED_PROJECT_CHANGE_164|process\.env|GITHUB_TOKEN=|SANDKING_CONTROLLER_SECRET=/i);
});
