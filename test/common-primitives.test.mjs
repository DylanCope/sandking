import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { canonicalJson } from "../src/common/canonical-json.mjs";
import { digest } from "../src/common/digest.mjs";
import {
  auditIdPattern,
  harnessIdPattern,
  hostIdPattern,
  identifierSchemas,
  projectIdPattern,
  runtimeIdPattern,
} from "../src/common/identifiers.mjs";

test("shared primitives preserve canonical fingerprints and Sand-King identifier shapes", () => {
  const omitted = canonicalJson({ nested: { value: undefined }, present: null });
  const explicitNull = canonicalJson({ nested: { value: null }, present: null });

  assert.equal(omitted, '{"nested":{"value":"<undefined>"},"present":null}');
  assert.equal(explicitNull, '{"nested":{"value":null},"present":null}');
  assert.notEqual(digest(omitted), digest(explicitNull));
  assert.equal(
    digest("Sand-King"),
    "sha256:2c31513025b7284a7645e071b0d1bd1e65dbcae489fe17db028b826771d55add",
  );

  const schemas = identifierSchemas(z);
  assert.strictEqual(identifierSchemas(z), schemas);
  for (const [pattern, schema, valid, invalid] of [
    [auditIdPattern, schemas.auditIdSchema, `audit-${"a".repeat(24)}`, `audit-${"A".repeat(24)}`],
    [projectIdPattern, schemas.projectIdSchema, `project-${"b".repeat(24)}`, `project-${"b".repeat(23)}`],
    [harnessIdPattern, schemas.harnessIdSchema, `harness-${"c".repeat(24)}`, `worker-${"c".repeat(24)}`],
    [hostIdPattern, schemas.hostIdSchema, `host-${"d".repeat(24)}`, `host-${"d".repeat(25)}`],
    [runtimeIdPattern, schemas.runtimeIdSchema, `runtime-${"e".repeat(24)}`, `runtime_${"e".repeat(24)}`],
  ]) {
    assert.equal(pattern.test(valid), true);
    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(pattern.test(invalid), false);
    assert.equal(schema.safeParse(invalid).success, false);
  }
});
