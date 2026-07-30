import { readFile } from "node:fs/promises";
import { join } from "node:path";

const issueId = process.argv[2];
if (!/^\d+$/.test(issueId ?? "")) {
  throw new Error("A numeric issue id is required.");
}

const verdictPath = join(
  ".sandcastle",
  "review-verdicts",
  `issue-${issueId}.json`,
);
const verdict = JSON.parse(await readFile(verdictPath, "utf8"));

if (
  verdict.issueId !== issueId
  || typeof verdict.approved !== "boolean"
  || !Array.isArray(verdict.findings)
  || verdict.findings.some((finding) => typeof finding !== "string")
) {
  throw new Error(`Invalid review verdict for issue #${issueId}.`);
}

process.stdout.write(JSON.stringify({
  approved: verdict.approved,
  findings: verdict.findings,
}));
