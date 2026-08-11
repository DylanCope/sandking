import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const storySequence = (count) => Array.from({ length: count }, (_, index) => index + 1);
const normalizeChildren = (children) => children
  .map(({ issue, state }) => ({ issue, state: state.toLowerCase() }))
  .sort((left, right) => left.issue - right.issue);
const normalizeDependencies = (dependencies) => dependencies
  .map(([blocker, blocked]) => [blocker, blocked])
  .sort(([leftBlocker, leftBlocked], [rightBlocker, rightBlocked]) =>
    leftBlocked - rightBlocked || leftBlocker - rightBlocker);

export const hashIssueBody = (body) => createHash("sha256").update(body).digest("hex");

export const extractSpecificationStoryNumbers = (body) => [
  ...body.matchAll(/^(\d+)\. As a\b/gm),
].map((match) => Number(match[1]));

export const assertIssue175SourceAndGraph = ({
  manifest,
  sourceBodyHashes,
  specificationStories,
  children,
  dependencies,
}) => {
  const expectedSourceHashes = {
    168: manifest.sourceSpecification.githubBodyUtf8Sha256,
    169: manifest.sourcePrd.githubBodyUtf8Sha256,
    175: manifest.sourceIssue.githubBodyUtf8Sha256,
  };
  for (const issue of [168, 169, 175]) {
    if (sourceBodyHashes[issue] !== expectedSourceHashes[issue]) {
      throw new Error(`issue_175_source_revision_mismatch:${issue}`);
    }
  }

  const expectedStories = storySequence(45);
  if (
    JSON.stringify(specificationStories) !== JSON.stringify(expectedStories)
    || JSON.stringify(manifest.sourceCoverageIndex.map(({ story }) => story))
      !== JSON.stringify(expectedStories)
  ) {
    throw new Error("issue_175_specification_story_coverage_mismatch");
  }

  const expectedChildren = normalizeChildren(manifest.acceptanceGraph.children);
  const actualChildren = normalizeChildren(children);
  if (JSON.stringify(actualChildren) !== JSON.stringify(expectedChildren)) {
    throw new Error("issue_175_child_graph_mismatch");
  }

  const expectedDependencies = normalizeDependencies(manifest.acceptanceGraph.dependencies);
  const actualDependencies = normalizeDependencies(dependencies);
  if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
    throw new Error("issue_175_dependency_graph_mismatch");
  }

  return {
    sourceIssues: [168, 169, 175],
    coveredStories: expectedStories.length,
    childIssues: actualChildren.map(({ issue }) => issue),
    dependencyEdges: actualDependencies.length,
  };
};

const readGhJson = async (args, cwd) => {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};

export const verifyLiveIssue175SourceAndGraph = async ({ manifest, repositoryRoot }) => {
  const repository = (await execFileAsync(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { cwd: repositoryRoot },
  )).stdout.trim();
  const sourceIssues = await Promise.all([168, 169, 175].map(async (issue) => ({
    issue,
    ...(await readGhJson(["issue", "view", String(issue), "--json", "body,state"],
      repositoryRoot)),
  })));
  const childIssues = await readGhJson([
    "api",
    `repos/${repository}/issues/169/sub_issues`,
  ], repositoryRoot);
  const dependencyGroups = await Promise.all(
    manifest.acceptanceGraph.children.map(async ({ issue: blocked }) => ({
      blocked,
      blockers: await readGhJson([
        "api",
        `repos/${repository}/issues/${blocked}/dependencies/blocked_by`,
      ], repositoryRoot),
    })),
  );
  const sourceBodyHashes = Object.fromEntries(sourceIssues.map(({ issue, body }) => [
    issue,
    hashIssueBody(body),
  ]));
  const specification = sourceIssues.find(({ issue }) => issue === 168);
  const children = childIssues.map(({ number, state }) => ({ issue: number, state }));
  const dependencies = dependencyGroups.flatMap(({ blocked, blockers }) =>
    blockers.map(({ number: blocker }) => [blocker, blocked]));
  const summary = assertIssue175SourceAndGraph({
    manifest,
    sourceBodyHashes,
    specificationStories: extractSpecificationStoryNumbers(specification.body),
    children,
    dependencies,
  });

  return {
    ...summary,
    repository,
    sourceBodyHashes,
    children: normalizeChildren(children),
    dependencies: normalizeDependencies(dependencies),
    parentState: sourceIssues.find(({ issue }) => issue === 169).state.toLowerCase(),
    qualificationIssueState: sourceIssues.find(({ issue }) => issue === 175).state.toLowerCase(),
  };
};
