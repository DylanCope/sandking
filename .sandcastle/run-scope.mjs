// --max-review-attempts is a separate, independent option (see
// parseMaxReviewAttempts below) that this parser must tolerate without
// folding it into the returned scope shape — it is recognized here only so
// it doesn't trip the "Unknown option" guard below.
export function parseRunScope(args) {
  let parentIssueId;
  let issueId;
  let parentFlagSeen = false;
  let issueFlagSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--parent") {
      parentIssueId = args[index + 1];
      parentFlagSeen = true;
      index += 1;
    } else if (argument.startsWith("--parent=")) {
      parentIssueId = argument.slice("--parent=".length);
      parentFlagSeen = true;
    } else if (argument === "--issue") {
      issueId = args[index + 1];
      issueFlagSeen = true;
      index += 1;
    } else if (argument.startsWith("--issue=")) {
      issueId = argument.slice("--issue=".length);
      issueFlagSeen = true;
    } else if (argument === "--max-review-attempts") {
      index += 1;
    } else if (argument.startsWith("--max-review-attempts=")) {
      // Value is embedded in this token; nothing further to skip.
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!parentFlagSeen && !issueFlagSeen) {
    return null;
  }

  if (parentFlagSeen && issueFlagSeen) {
    throw new Error("--parent and --issue cannot be combined.");
  }

  if (issueFlagSeen) {
    if (!issueId || !/^[1-9]\d*$/.test(issueId)) {
      throw new Error("--issue requires a positive GitHub issue number.");
    }
    return { issueId };
  }

  if (!parentIssueId || !/^[1-9]\d*$/.test(parentIssueId)) {
    throw new Error("--parent requires a positive GitHub issue number.");
  }
  return { parentIssueId };
}

// Returns undefined when the flag is absent, so callers can apply their own
// default rather than this module owning one.
export function parseMaxReviewAttempts(args) {
  let value;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--max-review-attempts") {
      value = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--max-review-attempts=")) {
      value = argument.slice("--max-review-attempts=".length);
    }
  }
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("--max-review-attempts requires a positive integer.");
  }
  return Number(value);
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
