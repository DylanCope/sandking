import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const parameters = JSON.parse(Buffer.from(
  process.argv[2] ?? "e30",
  "base64url",
).toString("utf8"));
const manifest = JSON.parse(await readFile(
  join(process.cwd(), "sandcastle.worker-fixture.json"),
  "utf8",
));

const publish = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const progress = () => publish({
  type: "sandcastle.worker.progress",
  label: "Controlled Worker",
  summary: "The deterministic Worker fixture is performing delegated work.",
  status: "running",
});
const result = (status, code, artifact) => publish({
  type: "sandcastle.worker.result",
  status,
  result: {
    schemaVersion: 1,
    kind: "sandcastle.delegation",
    code,
    selection: parameters,
    ...(artifact ? { artifact } : {}),
  },
});

progress();
if (manifest.scenario === "succeeded" || manifest.scenario === "succeeded-nonzero") {
  if (manifest.artifact) {
    await appendFile(
      join(process.cwd(), manifest.artifact.path),
      manifest.artifact.content,
      { flag: "a" },
    );
  }
  result("succeeded", "work_completed", manifest.artifact?.path);
  if (manifest.scenario === "succeeded-nonzero") process.exitCode = 23;
} else if (manifest.scenario === "failed") {
  result("failed", "work_failed");
} else if (manifest.scenario === "malformed-output") {
  process.stdout.write("{malformed controlled Worker output\n");
} else if (manifest.scenario === "nonzero-exit") {
  process.exitCode = 17;
} else if (manifest.scenario === "duplicate-result") {
  result("succeeded", "work_completed");
  result("succeeded", "duplicate_result");
} else if (manifest.scenario === "diagnostic-only") {
  process.stderr.write("Controlled diagnostic says SUCCESS but declares no result.\n");
} else if (manifest.scenario === "cancellable") {
  process.stderr.write("Controlled Worker is waiting for whole-run cancellation.\n");
  await new Promise((resolve) => {
    const timer = setInterval(() => undefined, 1_000);
    process.once("SIGTERM", () => {
      clearInterval(timer);
      resolve(undefined);
    });
  });
}
