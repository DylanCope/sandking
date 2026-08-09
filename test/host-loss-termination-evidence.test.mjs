import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHostLossTerminationEvidence,
} from "../src/host-loss-termination-evidence.mjs";

const confirmedEvidence = {
  schemaVersion: 2,
  platform: "linux",
  status: "termination_confirmed",
  terminationScope: "complete_process_tree",
  launchSettled: true,
  treeEmpty: true,
  observedAt: "2026-08-09T20:00:00.000Z",
};

test("Host-loss proof requires both settled launch and an empty complete tree", () => {
  assert.deepEqual(parseHostLossTerminationEvidence(confirmedEvidence), confirmedEvidence);
  assert.equal(parseHostLossTerminationEvidence({
    ...confirmedEvidence,
    launchSettled: false,
  }), null);
  assert.equal(parseHostLossTerminationEvidence({
    ...confirmedEvidence,
    treeEmpty: false,
  }), null);
});

test("legacy platform evidence is not trusted after the launch-race repair", () => {
  assert.equal(parseHostLossTerminationEvidence({
    schemaVersion: 1,
    platform: "darwin",
    applicationSpecifier: "dev.sandking.harness.1234567890abcdef",
    status: "termination_confirmed",
    killAccepted: true,
    coalitionAbsent: true,
    observedAt: "2026-08-09T20:00:00.000Z",
  }), null);
});
