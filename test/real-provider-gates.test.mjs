import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

// Real-provider acceptance runners invoke paid models against a real
// destination. Each must refuse to run unless its environment gate is set
// explicitly, so an ordinary `npm test` can never trigger a billed
// invocation. These assertions were preserved when the per-ticket evidence
// receipt files were retired; they are the only part of that machinery that
// guarded a real safety property.
//
// The equivalent gates for issues 152 and 174 live alongside their remaining
// acceptance tests in issue-152-acceptance-evidence.test.mjs and
// issue-174-acceptance-evidence.test.mjs.

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const closedEnvironment = { PATH: process.env.PATH, LANG: "C.UTF-8" };

/**
 * @param {string} runner
 * @param {string} manifest
 * @param {RegExp} expectedFailure
 */
const assertGateClosed = async (runner, manifest, expectedFailure) => {
  await assert.rejects(execFileAsync(process.execPath, [
    fileURLToPath(new URL(runner, import.meta.url)),
    fileURLToPath(new URL(manifest, import.meta.url)),
  ], { cwd: repositoryRoot, env: closedEnvironment }), (error) => {
    assert.match(error.stderr, expectedFailure);
    return true;
  });
};

test("issue 124 real-Claude acceptance fails closed unless its human gate is explicit", async () => {
  await assertGateClosed(
    "./run-installed-claude-acceptance.mjs",
    "../acceptance/issue-124.manifest.json",
    /issue_124_real_acceptance_gate_closed/,
  );
});

test("issue 146 real-Claude acceptance fails closed without the explicit gate", async () => {
  await assertGateClosed(
    "./run-issue-146-real-claude.mjs",
    "../acceptance/issue-146.manifest.json",
    /issue_146_real_acceptance_gate_closed/,
  );
});
