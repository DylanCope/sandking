import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  MAX_BULK_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  ProtocolError,
  readFrame,
  readProtocolFrame,
  writeBulkFrame,
  writeFrame,
} from "../src/protocol.mjs";

test("framed control reads preserve following frames and validate their schema", async () => {
  const stream = new PassThrough();
  writeFrame(stream, { type: "ping", requestId: "request-1" });
  writeFrame(stream, { type: "ping", requestId: "request-2" });

  assert.deepEqual(await readFrame(stream), { type: "ping", requestId: "request-1" });
  assert.deepEqual(await readFrame(stream), { type: "ping", requestId: "request-2" });

  assert.throws(
    () => writeFrame(stream, { type: "not-a-protocol-message" }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
});

test("framing rejects oversized and malformed frames before buffering their bodies", async () => {
  const oversized = new PassThrough();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1);
  oversized.end(header);

  await assert.rejects(
    readProtocolFrame(oversized),
    (error) => error instanceof ProtocolError && error.code === "frame_size_invalid",
  );

  const malformed = new PassThrough();
  const malformedBody = Buffer.from([1, ...Buffer.from("{not-json", "utf8")]);
  const malformedHeader = Buffer.alloc(4);
  malformedHeader.writeUInt32BE(malformedBody.length);
  malformed.end(Buffer.concat([malformedHeader, malformedBody]));

  await assert.rejects(
    readProtocolFrame(malformed),
    (error) => error instanceof ProtocolError && error.code === "frame_json_invalid",
  );
});

test("opaque bulk frames use a distinct bounded binary channel", async () => {
  const stream = new PassThrough();
  const opaque = Buffer.from([0, 255, 17, 42]);
  writeBulkFrame(stream, {
    streamId: "terminal-1",
    sequence: 7,
    eof: false,
    data: opaque,
  });

  const frame = await readProtocolFrame(stream);
  assert.equal(frame.channel, "bulk");
  assert.equal(frame.streamId, "terminal-1");
  assert.equal(frame.sequence, 7);
  assert.equal(frame.eof, false);
  assert.deepEqual(frame.data, opaque);

  assert.throws(
    () => writeBulkFrame(stream, {
      streamId: "terminal-1",
      sequence: 8,
      eof: true,
      data: Buffer.alloc(MAX_BULK_CHUNK_BYTES + 1),
    }),
    (error) => error instanceof ProtocolError && error.code === "bulk_chunk_too_large",
  );
});
