# Claude Code Controller session transport

Research date: 2026-07-30. This note answers [Research provider-specific Controller session transport](https://github.com/DylanCope/sandking/issues/15) using Anthropic-owned documentation and an inspection plan that deliberately excludes authentication, trust state, and general provider configuration.

## Recommendation

Treat cross-machine transport of a Claude Code Controller session as a **version-gated, best-effort transcript migration**, not a supported stable interchange format. The safe MVP boundary is:

1. stop the source Claude Code process cleanly;
2. copy only the selected session's main JSONL transcript and discovered session-owned subagent/sidecar files;
3. restore them under the destination account's Claude project-storage path for the **same absolute Project path**;
4. let an independently installed and authenticated Claude Code instance perform `--resume <session-id>`; and
5. accept transport only after behavioral resume checks pass.

Do not copy the whole `~/.claude` tree, `.claude.json`, settings, plugin caches, credentials, trust decisions, or arbitrary project state. Do not parse or rewrite transcript entries. Anthropic explicitly calls the JSONL entry format internal and subject to change on any release, and recommends supported script interfaces rather than direct parsing. [Claude Code session storage](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)

This mechanism should be a recovery/convenience feature behind an experimental capability flag. The normal Sand-King design should keep durable project and Harness-run state on the Host and allow a fresh Controller session to reconstruct its working context from Sand-King. Anthropic itself says that carrying application state into a fresh prompt is often more robust than shipping transcript files. [Agent SDK cross-host resume](https://code.claude.com/docs/en/agent-sdk/sessions#resume-across-hosts)

## What is known from the provider contract

### Artifact and path model

- Claude Code saves CLI conversations continuously as JSONL under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. With the Agent SDK the root can instead be `$CLAUDE_CONFIG_DIR/projects/`. The directory key is derived from the absolute working directory by replacing non-alphanumeric characters with `-`. A mismatched current directory causes resume lookup to use the wrong storage location. [Manage sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored) [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions#resume-by-id)
- The main JSONL contains messages, tool uses, tool results, and metadata. A session persists conversation state, not the Project filesystem. File changes must therefore already exist at the destination or be transported separately by a Project-level mechanism. [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- Subagent transcripts are distinct session-owned artifacts. Anthropic's `SessionStore` addresses them with opaque `subpath` values such as `subagents/agent-<id>` and says resume restores them only when the store can enumerate those subkeys. This establishes that exporting only the main JSONL may produce an incomplete session when subagents were used. [SessionStore subagent transcripts](https://code.claude.com/docs/en/agent-sdk/session-storage#subagent-transcripts)
- Checkpoint backup blobs are additional local artifacts, are not mirrored by `SessionStore`, and cannot be combined with that store. Therefore transcript transport does **not** promise file rewind/checkpoint portability. [SessionStore dual-write architecture](https://code.claude.com/docs/en/agent-sdk/session-storage#dual-write-architecture)
- Hooks and status-line commands receive a provider-supplied `transcript_path`; a `SessionEnd` hook may archive it. This is safer discovery than independently reconstructing the path. [Script access to conversations](https://code.claude.com/docs/en/sessions#access-conversations-from-scripts)

### Writes, indexes, and concurrency

- Transcripts are saved continuously, not only at exit. The Agent SDK documents a local-first, append-mirror architecture: Claude Code writes local disk before batches are offered to a `SessionStore`. Mirror failure does not stop the query, and failed batches can be dropped after retries. [SessionStore write behavior](https://code.claude.com/docs/en/agent-sdk/session-storage#dual-write-architecture) [mirror behavior](https://code.claude.com/docs/en/agent-sdk/session-storage#mirror-writes-are-best-effort)
- Anthropic documents direct resume by session ID and scopes lookup to the current Project directory and its git worktrees. Programmatic/SDK sessions can be absent from the interactive picker while still remaining resumable by ID. Therefore a picker/index entry is not a prerequisite for the primary validation path. [Resume a session](https://code.claude.com/docs/en/sessions#resume-a-session)
- Anthropic warns that resuming the same session in two terminals causes both processes' messages to interleave in one transcript. It documents no portable lock file or cross-process exclusion contract. The absence of a documented lock plus explicit interleaving means Sand-King must provide its own exclusive quiesce rule: never copy or restore while any process can write that session. [Branch a session](https://code.claude.com/docs/en/sessions#branch-a-session)
- The session picker displays transcript file size, but Anthropic publishes no maximum resumable transcript size or transport-size limit. Auto-compaction can make the logical resume chain much smaller than the raw stored history: Anthropic gives an example of 503 stored entries yielding 18 messages. Size thresholds must be measured, not assumed. [Session picker](https://code.claude.com/docs/en/sessions#use-the-session-picker) [post-compaction chain](https://code.claude.com/docs/en/agent-sdk/session-storage#getsessionmessages-returns-the-post-compaction-chain)

### Resume semantics and version dependencies

- `--resume <session-id>` restores conversation/tool history and selected saved state, including the model when still available, agent configuration when it can still be found and trusted, permission mode with explicit exceptions, active goals, and unexpired scheduled tasks. Background Bash and monitor tasks are not restored. Several launch-time inputs (`--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, `--add-dir`) must be supplied again. Standard settings are re-read at launch. [What resume restores](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores)
- Restore is consequently not a byte-for-byte runtime continuation. The destination's installed model availability, independently established trust, Project files, standard settings, agents, and explicitly repeated launch flags affect behavior.
- The internal entry schema may change on any Claude Code release. The provider does not publish forward- or backward-compatibility guarantees for copied JSONL. Record the exact source and destination Claude Code versions and classify same-version, upgrade, and downgrade results separately. [Transcript format warning](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)
- Anthropic's supported Agent SDK cross-host recipe is to persist the main JSONL and restore it to the same path with matching `cwd`, or use a `SessionStore`. This is useful evidence for feasibility, but it does not make arbitrary interactive CLI sidecars or mixed-version migration stable. [Resume across hosts](https://code.claude.com/docs/en/agent-sdk/sessions#resume-across-hosts)

## Unknowns that require experiment

The first-party contract does not specify the complete interactive-session sidecar set, any session index format, lock-file names or locking primitive, atomicity/fsync guarantees, crash-consistency boundary, maximum size, or a transcript schema compatibility matrix. The public `anthropics/claude-code` repository distributes releases and a changelog but not a stable source-level persistence contract. These are empirical facts for a pinned release, not API promises.

In particular, do not assume that a file resembling `sessions-index.json`, a lock, a queue, a task database, or a checkpoint directory is portable merely because it changes during a run. The experiment below must classify every changed path before it can join the session bundle. Unknown artifacts default to excluded.

## Safe quiesce/export/restore experiment

Run this only in two disposable VMs or containers representing source and destination machines. Use separate Unix accounts that have independently completed supported Claude Code installation, login, trust, settings, and Sand-King plugin setup. Never copy those account-wide artifacts.

### Matrix

Use a tiny synthetic git Project created at the identical absolute path on both machines. Exercise:

| Axis | Cases |
|---|---|
| Claude Code version | exact match; destination one tested upgrade newer; destination one tested downgrade older |
| Session shape | plain chat; tool call/result; compaction; subagent; named session; interrupted turn; large transcript |
| Project lookup | identical absolute path; different path (expected rejection); same repository worktree |
| Shutdown | clean interactive exit; provider-documented termination; forced crash as a negative control |
| Bundle | main transcript only; main plus every proven session-owned subpath |

Increase the large-transcript fixture geometrically and record raw bytes, line count without interpreting records, resume latency, peak disk use, and success. Stop before resource pressure threatens either machine; the result is an observed envelope, not a provider limit.

### Source observation and quiesce

1. Before starting Claude Code, inventory path, type, owner, mode, byte size, modification time, inode, and cryptographic hash under the isolated account's Claude data root. Do not print file contents. Record the Claude Code version, OS/architecture, exact Project path, git worktree identity, and launch flags.
2. Start one Controller session in the fixture Project. Obtain its session ID and provider-reported `transcript_path` through structured output or a temporary `SessionEnd` hook. Exercise the chosen matrix row.
3. Observe filesystem create/rename/write/delete events and open file descriptors for the Claude process. This discovers candidates without presuming names. Mark paths shared with other sessions or account-wide configuration as ineligible.
4. Exit cleanly and wait for the Claude process and its descendants to terminate. Verify no process has an open writable descriptor to any candidate path, then take two inventories separated by a short filesystem-settle interval. Export only if size, mtime, and hashes are identical across both snapshots.
5. Build a manifest containing relative path, role (`main transcript` or proven session-owned subpath), size, mode, and hash, plus source Claude version and encoded Project key. Reject symlinks, devices, sockets, paths escaping the session's Project-storage directory, credential-like names, and any path not causally attributable to this session.

Quiescence is a precondition, not something the copier tries to infer from a provider lock. A forced-crash row may be inspected, but must never establish the positive compatibility envelope unless a subsequent same-machine provider resume and clean exit first repairs/validates the session.

### Export exclusions

Hard-exclude account-wide files and directories, including credentials, `.claude.json`, settings, managed settings, trust approvals, plugin/marketplace caches, telemetry, logs, shell state, and unrelated Project/session transcripts. Also exclude the Project itself, Git credentials, MCP configuration, environment variables, checkpoints, and background-task processes/state. The bundle contains no file contents other than the narrowly selected session transcript artifacts.

Scan the candidate manifest by pathname and file type before packaging. Package with owner-only access, authenticate and encrypt the transfer channel, and verify hashes after transfer. The bundle should have an expiry and be deleted after acceptance because transcripts can contain prompts, source excerpts, tool output, paths, and other sensitive project data even though they are not authentication artifacts.

### Destination restore and acceptance checks

1. Independently install/configure/authenticate Claude Code and independently trust the fixture Project on the destination. Confirm the Project is at the same absolute path and is at the expected revision/state.
2. Confirm no Claude process is using the destination session ID and no destination artifact would be overwritten. Restore into a newly created encoded-Project directory using restrictive permissions and an atomic staging rename. Never merge JSONL lines or overwrite a pre-existing session.
3. Run the provider's direct ID path from the Project directory: `claude --resume <session-id>`. The picker is informational only.
4. Acceptance requires all of the following: the provider reports the same session ID; the expected earlier prompt and tool result are available through a benign follow-up; a new marker turn completes; the transcript remains appendable and is resumable again after another clean exit; no authentication/trust prompt was satisfied by copied state; and unrelated local sessions/config remain unchanged.
5. For subagent and compaction rows, additionally verify the resumed agent can refer to the expected post-compaction context and that provider APIs can enumerate the expected subagent history. Do not validate by parsing internal JSONL.
6. Record failures by matrix row and preserve only metadata/redacted diagnostics. On any failure, remove the staged destination bundle and fall back to a fresh Controller session reconstructed from Sand-King state.

## Compatibility envelope to expose

Sand-King should store a tested compatibility rule, not a blanket “Claude sessions are portable” claim:

- source/destination Claude Code versions and platform pair;
- exact-path requirement and worktree behavior;
- session features exercised (subagents, compaction, naming, interrupted turn);
- maximum raw size actually tested;
- artifact roles included, expressed without depending on undocumented global indexes;
- shutdown method and acceptance-test version; and
- result: supported experimentally, rejected, or unknown.

Default to exact-version, same-platform, same-absolute-Project-path transport. Permit an upgrade pair only after that exact pair passes the suite. Treat downgrade, crash-state, missing-subpath, in-use, and unknown-artifact cases as unsupported. If the provider changes storage layout or the binary version is outside the recorded matrix, require requalification rather than guessing.

## Decision consequence for Sand-King

Provider-specific transport belongs behind a Claude Code adapter owned by the Host. The Controller asks the Host to quiesce/export or restore/validate a named session, but Sand-King never interprets Claude transcript records. The stable Sand-King object is a manifest plus compatibility evidence; the provider-owned transcript bundle remains opaque, sensitive, and disposable.
