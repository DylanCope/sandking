import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControllerSessionManager } from "../src/controller-sessions.mjs";

const waitFor = async (predicate, timeout = 500) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
};

test("terminal attachment acknowledges and replays before delivering live PTY output", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-terminal-attachment-"));
  const dataDir = join(root, "state");
  await mkdir(dataDir);
  let releaseAttachmentAudit = () => undefined;
  const attachmentAuditRelease = new Promise((resolve) => {
    releaseAttachmentAudit = resolve;
  });
  let observeAttachmentAudit = () => undefined;
  const attachmentAuditStarted = new Promise((resolve) => {
    observeAttachmentAudit = resolve;
  });
  let auditSequence = 0;
  const manager = await createControllerSessionManager({
    dataDir,
    recordAudit: async (action) => {
      auditSequence += 1;
      if (action === "controller.terminal.attach") {
        observeAttachmentAudit();
        await attachmentAuditRelease;
      }
      return `audit-${auditSequence}`;
    },
  });

  try {
    const focused = await manager.start({
      workContextId: `project-${"1".repeat(24)}`,
      kind: "project",
      canonicalReference: `sandking:project:project-${"1".repeat(24)}`,
    }, { workingDirectory: root });
    const socket = { readyState: 1 };
    const liveFrames = [];
    const deliveryEvents = [];
    const attachmentPromise = manager.attach({
      socket,
      sessionId: focused.sessionId,
      streamId: focused.terminal.streamId,
      attachmentId: focused.terminal.writableAttachment.attachmentId,
      mode: "read-write",
      outputCursor: 0,
      onAttached: (attachment) => deliveryEvents.push({
        kind: "acknowledgement",
        outputCursor: attachment.outputCursor,
      }),
      onOutput: (_target, frame) => {
        liveFrames.push(frame);
        deliveryEvents.push({ kind: "output", sequence: frame.sequence });
      },
    });

    await attachmentAuditStarted;
    await manager.write({
      socket,
      streamId: focused.terminal.streamId,
      sequence: 0,
      eof: false,
      data: Buffer.from("ansi-fixture\r"),
    });
    await waitFor(() => liveFrames.length > 0);
    const framesDeliveredBeforeAcknowledgement = [...liveFrames];
    releaseAttachmentAudit();
    const attached = await attachmentPromise;

    assert.deepEqual(
      framesDeliveredBeforeAcknowledgement,
      [],
      "PTY output must remain staged until the attachment acknowledgement is ready",
    );

    const replaySequences = attached.frames.map(({ sequence }) => sequence);
    assert.match(Buffer.concat(attached.frames.map(({ data }) => data)).toString("utf8"),
      /WORKBENCH VT FIXTURE/,
      "output emitted while attachment was pending must be present in retained replay");
    assert.equal(attached.activate(), true);
    assert.deepEqual(deliveryEvents, [
      { kind: "acknowledgement", outputCursor: attached.outputCursor },
      ...replaySequences.map((sequence) => ({ kind: "output", sequence })),
    ], "activation must atomically acknowledge the cursor before replaying retained output");
    const replayDeliveryCount = liveFrames.length;
    await manager.write({
      socket,
      streamId: focused.terminal.streamId,
      sequence: 1,
      eof: false,
      data: Buffer.from("dimensions\r"),
    });
    assert.equal(await waitFor(() => liveFrames.length > replayDeliveryCount), true,
      "PTY output emitted after activation must be delivered live");
    const liveSequences = liveFrames.slice(replayDeliveryCount).map(({ sequence }) => sequence);
    assert.equal(new Set([...replaySequences, ...liveSequences]).size,
      replaySequences.length + liveSequences.length,
      "a replayed PTY frame must not be delivered live a second time");
    assert.deepEqual([...replaySequences, ...liveSequences],
      [...replaySequences, ...liveSequences].toSorted((left, right) => left - right),
      "replay and live PTY frames must preserve sequence order");
  } finally {
    releaseAttachmentAudit();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
