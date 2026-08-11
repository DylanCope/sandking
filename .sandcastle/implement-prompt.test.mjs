import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Worker audits the complete acceptance matrix on every pass", async () => {
  const prompt = await readFile(
    new URL("./implement-prompt.md", import.meta.url),
    "utf8",
  );

  assert.match(prompt, /acceptance matrix/i);
  assert.match(prompt, /ticket.*inherited parent requirements/i);
  assert.match(prompt, /public seam/i);
  // The matrix must tie each requirement to something that fails when the
  // behaviour breaks. Earlier wording said "executable evidence", which the
  // Worker read as licence to produce evidence artifacts.
  assert.match(prompt, /behavioural test/i);
  assert.match(prompt, /re-audit the complete matrix/i);
  assert.match(prompt, /not merely the latest findings/i);
});
