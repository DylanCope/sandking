# Claude Code controller integration surface

Research date: 2026-07-28. Sources are current first-party Claude Code documentation.

## Recommendation

Ship the MVP controller adapter as a **versioned Claude Code plugin** loaded into an ordinary interactive Claude Code CLI session, with a small Sand-King executable exposed through the plugin's `bin/` directory and user-triggered skills for gated operations. Use command hooks only for deterministic observation and policy enforcement. Treat Claude Code Remote Control as the supported human UI and session transport, but not as Sand-King's machine API. Keep the Sand-King host protocol outside Claude Code so a later controller can replace the plugin without changing remote project or run state.

Do not build the controller on the Claude Agent SDK: Anthropic says third-party products may not offer `claude.ai` login or subscription rate limits without prior approval, and directs SDK products to API-key authentication. That conflicts with Sand-King's intended Claude subscription setup. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#authentication)

## Supported surfaces

### Plugin as the distribution boundary

Claude Code plugins officially package skills, agents, hooks, MCP servers, LSP configuration, background monitors, and executables. Executables under a plugin's `bin/` directory are added to the Bash tool's `PATH`, making a plugin a suitable thin adapter around a separately testable `sandking` executable. [Plugins reference](https://code.claude.com/docs/en/plugins-reference#file-locations-reference)

Plugins can be installed persistently through a marketplace or loaded for one session with `--plugin-dir`/`--plugin-url`. Marketplace-installed plugins are copied into a versioned user cache, and old versions remain temporarily so already-running sessions do not break during an update. Installed plugins cannot reference files outside their own directory, so every adapter script must either be bundled or locate the separately installed Sand-King executable through `PATH`/configuration rather than relative traversal. [Plugins reference](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution)

Installation scopes are user, project, local, and managed. A Sand-King controller belongs at **user scope** because it should follow the developer across projects; a repository may separately carry project instructions. Project scope is committed and shared, while local scope is gitignored. [Settings](https://code.claude.com/docs/en/settings#configuration-scopes)

### Skills and commands as the conversational interface

Custom commands have been merged into skills: legacy `.claude/commands/*.md` files still work, but new integrations should use `skills/<name>/SKILL.md`. Personal skills live under `~/.claude/skills` and work across projects; plugin skills are the distributable equivalent. [Skills](https://code.claude.com/docs/en/slash-commands#extend-claude-with-skills)

Skills support arguments, bundled supporting files, dynamic context, tool allowlists, and explicit invocation control. `disable-model-invocation: true` prevents Claude from invoking a skill itself, making it appropriate for launch approval, credential transfer, and initialization actions that must follow a user gesture. The tool grant in `allowed-tools` lasts only for the invoking turn; persistent policy belongs in permission settings. [Skills: invocation control](https://code.claude.com/docs/en/slash-commands#control-who-invokes-a-skill) [Skills: tool permissions](https://code.claude.com/docs/en/slash-commands#pre-approve-tools-for-a-skill)

Once invoked, rendered skill instructions stay in the conversation, but Claude Code does not reread the file on later turns. Compaction only carries invoked skills forward within documented per-skill and combined token budgets. Sand-King must therefore put canonical state in its host and return fresh snapshots through commands; it must not rely on old skill text or conversation context as durable state. [Skills: content lifecycle](https://code.claude.com/docs/en/slash-commands#skill-content-lifecycle)

### Hooks for lifecycle signals and hard gates

Hooks are an officially supported deterministic lifecycle surface. Events cover session start/resume/end, user prompts, tool permission/use, compaction, configuration changes, worktree creation/removal, notifications, and other agent events. Command hooks receive JSON on stdin; HTTP and MCP-tool hooks are also supported. [Hooks guide](https://code.claude.com/docs/en/hooks-guide#how-hooks-work) [Hooks reference](https://code.claude.com/docs/en/hooks#hook-input-and-output)

Hooks may block selected actions (for example `PreToolUse`, `PermissionRequest`, `UserPromptSubmit`, and `ConfigChange`) using documented output/exit behavior. Many after-the-fact events cannot block. Sand-King should use hooks for audit/status emission and narrow deterministic protections, not as its primary control protocol. Agent-based hooks are explicitly experimental; production integration should prefer command hooks. [Hooks: exit behavior](https://code.claude.com/docs/en/hooks#exit-code-output) [Hooks guide: agent hooks](https://code.claude.com/docs/en/hooks-guide#agent-based-hooks)

Plugin background monitors can stream process output into interactive sessions, but they run only in interactive CLI sessions, are unsandboxed, and are skipped where the Monitor tool is unavailable. They may improve live run notifications but cannot be required for correctness or durable observation. [Plugins reference: background monitors](https://code.claude.com/docs/en/plugins-reference#background-monitors)

### Subprocess and programmatic execution

The CLI officially supports interactive sessions plus non-interactive `claude -p`, structured `json`/`stream-json` output, streamed input, bounded turns, explicit permission modes, tool allow/deny flags, and resume/continue by session identifier. This is a useful testing and automation surface, but it creates a separate agent turn rather than controlling the user's live interactive controller. [CLI reference](https://code.claude.com/docs/en/cli-usage)

The Claude Agent SDK is the official embedded/programmatic agent surface, but its authentication policy is decisive: absent Anthropic approval, third-party applications must use API credentials rather than offering Claude subscription login or rate limits. Sand-King should not depend on it for the MVP controller. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#authentication)

MCP is appropriate if Sand-King later needs typed tools rather than a CLI wrapper. Claude Code supports stdio and remote servers, project/user/local scopes, and prompts exposed as slash commands. Project MCP definitions are shareable via `.mcp.json` but require trust approval; local and user definitions live in path-sensitive `~/.claude.json`. For the MVP, a plugin-bundled executable is simpler and avoids running a second persistent protocol solely for controller tool calls. [MCP scopes](https://code.claude.com/docs/en/mcp#choose-a-scope)

### Remote session and lifecycle

Remote Control is the official way to use a Claude Code process running on one machine through `claude.ai/code` or mobile. Filesystem access, tools, MCP servers, and project configuration remain on the host; the web/mobile surfaces synchronize the conversation. It uses outbound HTTPS only and does not expose an inbound port. [Remote Control](https://code.claude.com/docs/en/remote-control#connection-and-security)

It can run as an interactive session (`claude --remote-control`), attach to an existing session (`/remote-control`), or run server mode (`claude remote-control`). Server mode supports same-directory, worktree, and single-session spawning plus a capacity limit; same-directory concurrent sessions can conflict. Sand-King's MVP should use one interactive controller session and keep concurrent project mutation policy in Sand-King rather than infer it from Remote Control. [Remote Control: start](https://code.claude.com/docs/en/remote-control#start-a-remote-control-session)

Remote Control is a research preview, requires a sufficiently recent Claude Code version, requires a Pro/Max/Team/Enterprise `claude.ai` OAuth login, and does not support API-key authentication. Team/Enterprise administrators must enable it. A controller adapter must feature-detect the installed version and degrade to terminal-only interaction if Remote Control is unavailable. [Remote Control: requirements](https://code.claude.com/docs/en/remote-control#requirements)

The session continues to execute locally; network loss can reconnect when the host returns, but closing the local CLI process ends the running controller. Conversations can be resumed by ID or most recent directory session, and resuming reconnects the recorded Remote Control session where possible. This is controller-conversation continuity, not durable Sand-King run state. [Remote Control](https://code.claude.com/docs/en/remote-control) [CLI reference](https://code.claude.com/docs/en/cli-usage)

## Portability and lifecycle constraints

- Claude Code user configuration and OAuth/session state are machine-local. User settings and plugins are under `~/.claude`; `~/.claude.json` contains OAuth, trust, per-project state, and caches. Copying a plugin is not equivalent to migrating a controller session or trust decisions. Sand-King setup should install its plugin declaratively and leave Claude authentication to supported login/setup flows. [Settings files](https://code.claude.com/docs/en/settings#settings-files)
- Local MCP configuration is keyed by absolute project path in `~/.claude.json`; it will not port cleanly between machines or moved checkouts. Prefer plugin-provided tools or user-scope configuration for Sand-King itself. [MCP local scope](https://code.claude.com/docs/en/mcp#local-scope)
- Project-scoped `.claude/` configuration is intentionally version-controlled and applies to every collaborator; it is suitable only for repository-owned guidance, not Sand-King execution state or controller credentials. [Settings scopes](https://code.claude.com/docs/en/settings#available-scopes)
- Claude Code auto-updates independently. Pin and test a minimum supported version, run capability checks at startup, and avoid coupling the durable host protocol to undocumented transcript files or terminal UI behavior. Official CLI, plugin, skill, hook, and Remote Control flags are the supported boundary. [Claude Code setup and updates](https://code.claude.com/docs/en/setup#update-claude-code)

## Proposed MVP adapter contract

1. Install a user-scoped `sandking` plugin with user-invocable planning/status skills and manually invocable gated-action skills.
2. Bundle a thin executable shim that calls the provider-neutral Sand-King CLI/host protocol and returns concise structured state to Claude.
3. Use command hooks only to record session lifecycle and enforce explicit, deterministic prohibitions; failure of hooks or monitors must not lose run state.
4. Launch Claude Code normally in the selected local workspace, optionally with `--remote-control`; let Claude Code own its conversation, compaction, resume, and human UI.
5. Keep project identity, live harness state, logs, approvals, and results in the Sand-King host. The controller requests snapshots each time it reconnects.
6. Feature-detect Claude Code version/capabilities, especially Remote Control; never parse private transcript/config formats as an interoperability API.

