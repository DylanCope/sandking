import assert from "node:assert/strict";
import test from "node:test";
import { delimiter } from "node:path";
import { createDestinationWorkerEnvironment } from "../src/destination-worker-environment.mjs";

test("the Host derives a minimal destination-local Worker environment", () => {
  const environment = createDestinationWorkerEnvironment({
    executablePath: "/opt/sandking-node/bin/node",
    homeDirectory: "/srv/destination-user",
    platform: "linux",
    systemRoot: null,
  });

  assert.deepEqual(environment, {
    LANG: "C.UTF-8",
    HOME: "/srv/destination-user",
    PATH: [
      "/opt/sandking-node/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(delimiter),
  });
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.CODEX_HOME, undefined);
});
