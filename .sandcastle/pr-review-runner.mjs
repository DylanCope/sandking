export async function runPullRequestReview({
  issue,
  pullRequest,
  createSandbox,
  sandboxOptions,
  runOptions,
  parseReview,
}) {
  const sandbox = await createSandbox({
    ...sandboxOptions,
    branch: issue.branch,
  });

  try {
    const result = await sandbox.run({
      ...runOptions,
      promptArgs: {
        ...runOptions.promptArgs,
        BRANCH: issue.branch,
        PR_NUMBER: String(pullRequest.number),
        TASK_ID: issue.id,
      },
    });
    return parseReview(extractReviewVerdict(result.stdout));
  } finally {
    await sandbox.close();
  }
}

export function extractReviewVerdict(stdout) {
  const matches = [...stdout.matchAll(/<review>\s*([\s\S]*?)\s*<\/review>/g)];
  const rawVerdict = matches.at(-1)?.[1];
  if (!rawVerdict) {
    throw new Error("Pull request reviewer did not emit a <review> verdict.");
  }

  try {
    return JSON.parse(rawVerdict);
  } catch (cause) {
    throw new Error("Pull request reviewer emitted invalid JSON in <review>.", {
      cause,
    });
  }
}
