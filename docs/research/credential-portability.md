# Credential portability and authentication constraints

Research date: 2026-07-28. This note covers the MVP's single-user Sand-King host and uses only provider-owned documentation and source repositories.

## Recommendation

Sand-King should implement provider-specific authentication adapters, not a generic credential-directory copier:

| Capability | MVP default | Explicit transfer option | Important limit |
|---|---|---|---|
| Codex using a ChatGPT subscription | Run device-code login on the execution host | Copy the file-based `auth.json` cache after an explicit credential-transfer approval | OS keyring entries are not file-portable; copied credentials are password-equivalent |
| Claude Code controller | Run `/login` on the controller host | Generate and install a `CLAUDE_CODE_OAUTH_TOKEN` only for non-interactive model use | The setup token cannot create Remote Control sessions, so it is not a substitute for controller login |
| GitHub CLI/API | Run `gh auth login` on the host, or install a deliberately supplied token | Accept a PAT through `gh auth login --with-token`, or configure a securely supplied `GH_TOKEN` | Do not copy an opaque OS credential-store entry or infer a token from Git configuration |
| Git over SSH | Create a distinct key for the host and register its public key, or use HTTPS through `gh` | Copy an existing private key only as an exceptional, separately approved secret transfer | Agent forwarding ends with the SSH connection and therefore cannot support unattended runs |

All transfers should be scoped to one provider and destination Unix account, use a confidential channel, create destination files with owner-only permissions, validate by provider commands without printing secrets, and record only non-secret metadata. Sand-King should never inspect, serialize, log, or retain credential contents in its own state.

## Claude Code

Claude Code's supported subscription login is `/login`. Anthropic documents platform-specific storage: macOS uses the encrypted Keychain, while Linux uses `~/.claude/.credentials.json` with mode `0600`, and Windows uses `.claude/.credentials.json` under the protected user profile. Claude Code itself manages the JSON file through `/login` and `/logout` ([Anthropic credential management](https://code.claude.com/docs/en/iam#credential-management)).

Anthropic does **not** document copying `.credentials.json` between machines as a supported authentication flow. A macOS Keychain credential is not available as a standalone provider-defined file at all. Sand-King should therefore classify copying Claude's login cache as unsupported, even though a Linux/Windows cache happens to be file-backed, and direct the user through `/login` on each controller host.

For headless scripts, Anthropic provides `claude setup-token`. It produces a one-year OAuth token that the user places in `CLAUDE_CODE_OAUTH_TOKEN`; it authenticates against Pro, Max, Team, or Enterprise subscriptions. The command prints the token but does not store it ([Anthropic long-lived token documentation](https://code.claude.com/docs/en/iam#generate-a-long-lived-token)). This is a provider-supported persistent secret that Sand-King may install after a typed approval.

However, that long-lived token can only make model requests: Anthropic explicitly says it cannot establish Remote Control sessions or fetch claude.ai connectors ([Anthropic long-lived token limitations](https://code.claude.com/docs/en/iam#generate-a-long-lived-token)). Because the Sand-King controller is intended to use Claude's remotely accessible session, `CLAUDE_CODE_OAUTH_TOKEN` is not a replacement for `/login` on the controller host.

Subscription logins can expire. Claude Code warns shortly before expiry, and once an unrefreshable login expires, unattended or Remote Control work stops until `/login` is performed again ([Anthropic login renewal behavior](https://code.claude.com/docs/en/iam#renew-an-expiring-login)). `doctor` should therefore report the active method and expiry state without exposing credential material.

## Codex with ChatGPT subscription authentication

Codex caches ChatGPT or API-key login details either in plaintext `~/.codex/auth.json` (more generally `$CODEX_HOME/auth.json`) or an OS-specific credential store. ChatGPT tokens are automatically refreshed during active use. `cli_auth_credentials_store` selects `file`, `keyring`, or `auto`; only `file` guarantees a transferable cache ([OpenAI Codex login caching and credential storage](https://learn.chatgpt.com/docs/auth#login-caching)).

OpenAI explicitly documents two headless login paths:

1. Preferred: enable device-code authentication and run `codex login --device-auth` on the execution host.
2. Fallback: authenticate on a browser-capable machine and copy `~/.codex/auth.json` to the same path on the headless machine, including examples using SSH and `scp`.

OpenAI warns that `auth.json` contains access tokens and must be treated like a password, and notes that copying does not apply when the source uses an OS credential store ([OpenAI headless-device authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)). Thus Codex file-cache transfer is provider-supported, but only after verifying that the configured source store is `file`; Sand-King must not attempt to extract credentials from a keyring.

The copied cache is mutable durable state: Codex can refresh it during normal runs. OpenAI describes retaining the updated file between trusted automation runs, while still recommending API keys as the default for automation ([OpenAI headless-device authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)). For this project, ChatGPT subscription access is intentional, so the destination's copy must be host-owned, writable only by that Unix account, and validated with a non-secret authentication-status check.

The ordinary browser flow can also be completed remotely by forwarding Codex's localhost callback over SSH, while current Codex app-server interfaces expose a device-code login intended for a frontend to display to the user ([OpenAI callback forwarding](https://learn.chatgpt.com/docs/auth#login-on-headless-devices), [OpenAI Codex app-server authentication](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints)). These are preferable fallbacks when transfer is unavailable or unwanted.

## GitHub CLI and HTTPS Git

`gh auth login` uses a browser flow by default and stores the resulting token in the system credential store; only when that store is unavailable does it fall back to plaintext. `gh auth status` reports the storage location. The CLI also supports a classic PAT on standard input with `--with-token`, recommends `GH_TOKEN` for fine-grained PAT use, and describes environment-token authentication as suitable for headless automation ([GitHub CLI `gh auth login`](https://cli.github.com/manual/gh_auth_login)).

Accordingly, Sand-King should not copy GitHub CLI's opaque cached login: it may be keyring-bound, and GitHub does not document cache copying as a supported migration method. The provider-supported options are host-local `gh auth login`, or installing a deliberately supplied PAT through `--with-token`/`GH_TOKEN` after explicit authorization. Tokens should be narrowly scoped to the operations the harness needs and handled as persistent host secrets, not Sand-King runtime state.

For HTTPS Git, `gh auth setup-git` configures Git to use GitHub CLI as its credential helper for authenticated hosts ([GitHub CLI `gh auth setup-git`](https://cli.github.com/manual/gh_auth_setup-git)). This cleanly reuses the host's supported `gh` authentication instead of transferring a separate Git credential file.

## Git over SSH

Git-over-SSH authentication is independent from `gh` API authentication. GitHub documents generating an SSH keypair on a machine, loading the private key into `ssh-agent`, and adding the public key to the GitHub account ([GitHub SSH key setup](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent)). A host-specific key registered with GitHub is the best persistent unattended option because it can be individually identified and revoked.

An OpenSSH private-key file can technically be copied, but GitHub's supported guidance emphasizes securing private keys with passphrases and caching the unlocked key in an agent. OS keychains and running agents are machine-local, so copying a key file does not copy its unlocked state ([GitHub SSH key passphrases](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/working-with-ssh-key-passphrases)). Sand-King should not copy a developer's existing private key by default; if offered at all, it must be an exceptional typed transfer with an explicit warning that the destination gains that key's full identity and access.

GitHub recommends SSH agent forwarding when a remote server should use a local key without storing it. The remote can use the forwarded agent only while the SSH connection is established, and GitHub warns to enable forwarding only for trusted hosts because the server can exercise the forwarded identity ([GitHub SSH agent forwarding](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/using-ssh-agent-forwarding)). It therefore cannot satisfy Sand-King's requirement that harness runs continue after the controller disconnects.

## MVP policy consequences

- Keep Claude controller authentication local to each controller installation. Use `/login`; do not automate cache copying. Offer `setup-token` only for future non-controller/headless Claude execution, clearly excluding Remote Control.
- On each Codex worker host, prefer `codex login --device-auth`. Also implement an explicitly approved `auth.json` transfer adapter because OpenAI officially supports it for trusted headless machines; require or establish file-based Codex credential storage first.
- On each host, prefer `gh auth login`, or explicitly provision a PAT. Configure HTTPS Git through `gh auth setup-git` where practical.
- For SSH Git, generate a distinct persistent host key and guide the user to register its public half. Do not rely on agent forwarding for durable jobs.
- `doctor` should test authentication using provider status/test commands and report method, account identity where safely exposed by that command, access sufficiency, and renewal needed. It must never print tokens, private keys, or credential-file contents.
- Credential transfer approval must remain distinct from silent Sand-King host installation and from harness-run launch authorization.
