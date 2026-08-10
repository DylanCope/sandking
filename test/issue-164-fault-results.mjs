import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-164.manifest.json", import.meta.url),
  "utf8",
));

const declarations = manifest.verification.faultMatrix.flatMap((boundary) =>
  boundary.faultPoints.map((faultPoint) => ({
    boundary: boundary.boundary,
    faultPoint,
  })));
const declaredByPoint = new Map(declarations.map((entry) => [entry.faultPoint, entry]));
const qualifiedByPoint = new Map();

export const qualifyIssue164FaultPoint = (faultPoint, testName) => {
  const declaration = declaredByPoint.get(faultPoint);
  assert.ok(declaration, `undeclared issue 164 fault point: ${faultPoint}`);
  assert.equal(qualifiedByPoint.has(faultPoint), false,
    `issue 164 fault point qualified more than once: ${faultPoint}`);
  qualifiedByPoint.set(faultPoint, {
    boundary: declaration.boundary,
    faultPoint,
    injected: true,
    restarted: true,
    converged: true,
    passed: true,
    executableEvidence: `test/harness-run.test.mjs:${testName}`,
  });
};

export const retainIssue164FaultPointResults = async () => {
  assert.deepEqual(
    [...qualifiedByPoint.keys()].sort(),
    declarations.map(({ faultPoint }) => faultPoint).sort(),
    "every declared issue 164 fault point must be injected and qualified",
  );
  const results = declarations.map(({ faultPoint }) => qualifiedByPoint.get(faultPoint));
  const resultDirectory = process.env.SANDKING_ACCEPTANCE_RESULT_DIR;
  if (resultDirectory) {
    await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(resultDirectory, "canonical-boundary-manager-results.json"),
      `${JSON.stringify({ schemaVersion: 1, issue: 164, results }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return results;
};
