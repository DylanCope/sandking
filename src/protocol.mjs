import { once } from "node:events";

const FRAME_HEADER_BYTES = 4;

export const protocolVersion = {
  major: 1,
  minor: 0,
  patch: 0,
  version: "1.0.0",
};

export const releaseVersion = "0.1.0";

export const writeFrame = (stream, payload) => {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  stream.write(Buffer.concat([header, body]));
};

export const readFrame = async (stream) => {
  let buffer = Buffer.alloc(0);

  const readChunk = async () => {
    const chunk = stream.read();
    if (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      return;
    }

    await once(stream, "readable");
    const readableChunk = stream.read();
    if (!readableChunk) {
      throw new Error("Protocol stream ended before a complete frame arrived.");
    }
    buffer = Buffer.concat([buffer, readableChunk]);
  };

  while (buffer.length < FRAME_HEADER_BYTES) {
    await readChunk();
  }

  const frameLength = buffer.readUInt32BE(0);
  buffer = buffer.subarray(FRAME_HEADER_BYTES);

  while (buffer.length < frameLength) {
    await readChunk();
  }

  const body = buffer.subarray(0, frameLength);
  return JSON.parse(body.toString("utf8"));
};
