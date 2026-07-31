export async function runPullRequestReview({
  issue,
  pullRequest,
  createSandbox,
  sandboxOptions,
  runOptions,
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
    return result.output;
  } finally {
    await sandbox.close();
  }
}
