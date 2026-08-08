"use strict";

const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const containmentMarker = Symbol.for("sandking.darwin-process-containment.v1");

if (globalThis[containmentMarker] !== true) {
  const retainedNodeOptions = process.env.NODE_OPTIONS;
  if (typeof retainedNodeOptions !== "string" || retainedNodeOptions.length === 0) {
    throw new Error("darwin_process_containment_preload_missing");
  }

  const containOptions = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return {
      ...value,
      detached: false,
      ...(value.env && typeof value.env === "object"
        ? { env: { ...value.env, NODE_OPTIONS: retainedNodeOptions } }
        : {}),
    };
  };

  for (const method of [
    "exec",
    "execFile",
    "execFileSync",
    "execSync",
    "fork",
    "spawn",
    "spawnSync",
  ]) {
    const original = childProcess[method];
    const contained = function containedChildProcess(...args) {
      // A Harness may intentionally provide a minimal environment to a Worker.
      // Keep the containment preload inherited without exposing any Host secret.
      process.env.NODE_OPTIONS = retainedNodeOptions;
      return Reflect.apply(original, this, args.map(containOptions));
    };
    const customPromisify = Object.getOwnPropertyDescriptor(
      original,
      Symbol.for("nodejs.util.promisify.custom"),
    );
    if (customPromisify) {
      Object.defineProperty(
        contained,
        Symbol.for("nodejs.util.promisify.custom"),
        {
          ...customPromisify,
          value: function containedPromisifiedChildProcess(...args) {
            process.env.NODE_OPTIONS = retainedNodeOptions;
            return Reflect.apply(
              customPromisify.value,
              this,
              args.map(containOptions),
            );
          },
        },
      );
    }
    childProcess[method] = contained;
  }

  syncBuiltinESMExports();
  globalThis[containmentMarker] = true;
}
