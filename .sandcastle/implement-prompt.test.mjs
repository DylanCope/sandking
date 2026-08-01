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
  assert.match(prompt, /executable evidence/i);
  assert.match(prompt, /re-audit the complete matrix/i);
  assert.match(prompt, /not merely the latest findings/i);
});
