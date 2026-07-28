import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function selectPlannerCandidates(pages) {
  const issues = Array.isArray(pages[0]) ? pages.flat() : pages;

  return issues.filter(isPlannerCandidate).map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((label) => label.name),
    }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pages = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(`${JSON.stringify(selectPlannerCandidates(pages))}\n`);
}

function isPlannerCandidate(issue) {
  const labels = issue.labels.map((label) => label.name.toLowerCase());
  const isPrd = labels.some(
    (label) => label === "prd" || label.endsWith(":prd"),
  );
  const isWayfinder = labels.some((label) => label.startsWith("wayfinder:"));

  return (
    issue.state === "open" &&
    labels.includes("ready-for-agent") &&
    issue.issue_dependencies_summary?.blocked_by === 0 &&
    issue.sub_issues_summary?.total === 0 &&
    !isPrd &&
    !isWayfinder &&
    issue.pull_request === undefined
  );
}
