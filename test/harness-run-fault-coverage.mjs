import assert from "node:assert/strict";

export const harnessRunFaultMatrix = Object.freeze([
  {
    boundary: "run creation and retained launch outcome",
    faultPoints: [
      "harness_run_launch.before_commit",
      "harness_run_launch.after_state_commit",
      "harness_run_launch.after_commit",
    ],
  },
  {
    boundary: "lifecycle event and current-view publication",
    faultPoints: [
      "harness_run_lifecycle.adapter_ready.before_commit",
      "harness_run_lifecycle.adapter_ready.after_state_commit",
    ],
  },
  {
    boundary: "terminal-envelope acceptance and terminal outcome",
    faultPoints: [
      "harness_run_terminal_envelope.before_commit",
      "harness_run_outcome.before_commit",
      "harness_run_terminal_envelope.after_state_commit",
      "harness_run_outcome.after_state_commit",
    ],
  },
  {
    boundary: "cancellation acceptance",
    faultPoints: [
      "harness_run_cancellation.before_commit",
      "harness_run_cancellation.after_state_commit",
      "harness_run_cancellation.after_commit",
    ],
  },
  {
    boundary: "cancellation signalling and termination",
    faultPoints: [
      "harness_run_cancellation.cooperative_signal.before_dispatch",
      "harness_run_cancellation.cooperative_signal.after_dispatch",
      "harness_run_cancellation.cooperative_signal.after_state_commit",
      "harness_run_cancellation.forced_signal.before_dispatch",
      "harness_run_cancellation.forced_signal.after_dispatch",
      "harness_run_cancellation.forced_signal.after_state_commit",
      "harness_run_cancellation.termination_confirmation.before_commit",
      "harness_run_cancellation.termination_confirmation.after_state_commit",
    ],
  },
  {
    boundary: "restart reconciliation",
    faultPoints: [
      "harness_run_reconciliation.before_commit",
      "harness_run_reconciliation.after_state_commit",
      "harness_run_reconciliation.after_commit",
    ],
  },
  {
    boundary: "recovery intent and action",
    faultPoints: [
      "harness_run_recovery.before_intent_commit",
      "harness_run_recovery.after_intent_commit",
      "harness_run_recovery.before_action",
      "harness_run_recovery.after_action",
      "harness_run_recovery.before_result_commit",
      "harness_run_recovery.after_state_commit",
      "harness_run_recovery.after_commit",
    ],
  },
]);

export const harnessRunFaultDeclarations = Object.freeze(
  harnessRunFaultMatrix.flatMap(({ boundary, faultPoints }) =>
    faultPoints.map((faultPoint) => ({ boundary, faultPoint }))),
);

const declaredByPoint = new Map(
  harnessRunFaultDeclarations.map((entry) => [entry.faultPoint, entry]),
);
const qualifiedByPoint = new Map();

export const qualifyHarnessRunFaultPoint = (faultPoint, testName) => {
  const declaration = declaredByPoint.get(faultPoint);
  assert.ok(declaration, `undeclared Harness-run fault point: ${faultPoint}`);
  assert.equal(qualifiedByPoint.has(faultPoint), false,
    `Harness-run fault point qualified more than once: ${faultPoint}`);
  qualifiedByPoint.set(faultPoint, testName);
};

export const assertHarnessRunFaultCoverage = () => {
  assert.deepEqual(
    [...qualifiedByPoint.keys()].sort(),
    harnessRunFaultDeclarations.map(({ faultPoint }) => faultPoint).sort(),
    "every declared Harness-run fault point must be injected and qualified",
  );
};
