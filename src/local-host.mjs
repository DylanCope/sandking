import { readFrame, protocolVersion, releaseVersion, writeFrame } from "./protocol.mjs";

const hostMode = process.env.SANDKING_HOST_MODE ?? "normal";
const hostIdentity = process.env.SANDKING_HOST_IDENTITY ?? "local-host";

const main = async () => {
  const hello = await readFrame(process.stdin);
  if (hello.type !== "hello") {
    throw new Error("Expected hello frame.");
  }

  const major = hostMode === "incompatible-major"
    ? protocolVersion.major + 1
    : protocolVersion.major;

  writeFrame(process.stdout, {
    type: "hello-ack",
    protocol: {
      major,
      minor: protocolVersion.minor,
      patch: protocolVersion.patch,
      version: `${major}.${protocolVersion.minor}.${protocolVersion.patch}`,
    },
    release: releaseVersion,
    identity: hostIdentity,
    capabilities: ["slice-1"],
    schemaDigest: "sha256:slice-1-local-host",
    framing: { maxFrameBytes: 65_536 },
    observationCursor: "origin",
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
