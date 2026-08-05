export function parseRunScope(args) {
  if (args.length === 0) return null;

  let parentIssueId;
  let issueId;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--parent") {
      parentIssueId = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--parent=")) {
      parentIssueId = argument.slice("--parent=".length);
    } else if (argument === "--issue") {
      issueId = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--issue=")) {
      issueId = argument.slice("--issue=".length);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (parentIssueId !== undefined && issueId !== undefined) {
    throw new Error("--parent and --issue cannot be combined.");
  }

  if (issueId !== undefined) {
    if (!/^[1-9]\d*$/.test(issueId)) {
      throw new Error("--issue requires a positive GitHub issue number.");
    }
    return { issueId };
  }

  if (!parentIssueId || !/^[1-9]\d*$/.test(parentIssueId)) {
    throw new Error("--parent requires a positive GitHub issue number.");
  }
  return { parentIssueId };
}

export async function createIssueScope({ issueId, github }) {
  const issue = await github.getIssue(issueId);
  if (!issue) {
    throw new Error(`Issue #${issueId} was not found.`);
  }

  return {
    issueIds: new Set([issueId]),
    async isComplete() {
      return (await github.getIssue(issueId)).state === "closed";
    },
  };
}

export async function createParentScope({ parentIssueId, github }) {
  const parent = await github.getIssue(parentIssueId);
  if (!parent) {
    throw new Error(`Parent issue #${parentIssueId} was not found.`);
  }

  const issueIds = new Set();
  const visited = new Set([parentIssueId]);
  const visitDescendants = async (issueId) => {
    for (const child of await github.listSubIssues(issueId)) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      issueIds.add(child.id);
      await visitDescendants(child.id);
    }
  };
  await visitDescendants(parentIssueId);

  return {
    parentIssueId,
    issueIds,
    async isComplete() {
      return (await github.getIssue(parentIssueId)).state === "closed";
    },
  };
}

export function selectScopedIssues(issues, scope) {
  return scope
    ? issues.filter((issue) => scope.issueIds.has(String(issue.id)))
    : issues;
}
