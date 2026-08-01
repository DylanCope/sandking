export async function createImplementPromptArgs({ issue, github }) {
  const currentIssue = await loadIssueDetails({ github, issueId: issue.id });
  const parents = await loadParentIssues({ github, issueId: issue.id });

  return {
    TASK_ID: currentIssue.id,
    ISSUE_TITLE: currentIssue.title,
    ISSUE_BODY: formatIssue(currentIssue),
    PARENT_ISSUES: parents.length === 0
      ? "None."
      : parents.map(formatIssue).join("\n\n"),
  };
}

async function loadParentIssues({ github, issueId }) {
  const parents = [];
  let childIssueId = issueId;

  while (true) {
    const parent = await github.getParentIssue(childIssueId);
    if (!parent) {
      return parents;
    }

    parents.push(await loadIssueDetails({ github, issueId: parent.id }));
    childIssueId = parent.id;
  }
}

async function loadIssueDetails({ github, issueId }) {
  if (typeof github.getIssueDetails === "function") {
    return github.getIssueDetails(issueId);
  }

  const issue = await github.getIssue(issueId);
  return {
    id: issue.id,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
  };
}

function formatIssue(issue) {
  const body = issue.body?.trim() || "_No issue body provided._";
  return `#${issue.id}: ${issue.title}\n\n${body}`;
}
