# Security model

## Trust assumptions

The bridge is a high-authority local agent. Its MCP caller, local user account, configured workspaces, optional browser profile, and optional Codex CLI are all trusted to the extent described here.

The no-delete layer prevents common accidental destructive actions and creates a reviewable human-confirmation step. It is not a kernel/OS security boundary. Generic command execution, project scripts, interpreters, and delegated agents can express side effects in ways no regex can enumerate.

For sensitive work, run under a dedicated unprivileged OS account in a VM/container or snapshot-capable workspace, with explicit filesystem/network policy and no production credentials.

## Authority controls

- `WORKSPACE_ROOTS` is configured outside MCP; only the dedicated `BRIDGE_SCRATCH_DIR` is added automatically.
- Bridge approvals, audit logs, process metadata, and state are not included in file-tool roots.
- `workspace` registration adds semantic metadata only and cannot expand `WORKSPACE_ROOTS`.
- Existing and not-yet-created paths are canonicalized component-by-component through real parents; dangling/static symlink escapes are rejected.
- JavaScript pathname checks cannot eliminate hostile same-workspace TOCTOU races; use an OS sandbox/native `openat`-style helper when untrusted local processes can mutate path ancestors concurrently.
- Symlink escapes and string-prefix collisions are rejected.
- OS/credential paths such as `.ssh`, `.aws`, `.kube`, keychains, `/etc`, system directories, and Windows credential storage are denied.
- `manage_task` with `action: "kill"` accepts only bridge-created stable IDs and verifies process identity to reduce PID-reuse risk.

## Destructive approvals

Destructive commands and file-deleting patches pause inside the originating tool call and wait for the shared macOS/Telegram human interaction service. Approve executes the exact original operation; Deny executes nothing; a custom answer executes nothing and is returned to the agent as human guidance. Timeout also executes nothing. Typed custom text is never treated as approval.

Approval requests and outcomes are audit-recorded by operation fingerprint. This human gate does not replace backups, snapshots, or OS isolation.

## Network and desktop scope

The current MCP contract does not expose generic web-fetch, browser/CDP, native desktop automation, capture/audio, Office, or scheduler tools. Network or GUI activity can still occur inside commands or delegated agents, so workspace roots and tool policy are not an OS/network sandbox.

## MCP listener

- Default: `127.0.0.1:8765`.
- Non-loopback binds are refused. External exposure must use a separately reviewed TLS/auth proxy while the bridge remains loopback-only.
- Host-header validation protects loopback use from DNS rebinding.
- `MCP_TOKEN` is useful for direct local clients only after verifying that your tunnel profile supplies the same Authorization header. The documented no-auth local tunnel profile assumes loopback trust.

## Secrets

Service installers load `CONTROL_PLANE_API_KEY` from a regular, non-symlink, user-owned secret file. Unix permissions must be `0600`; Windows setup applies a user-only ACL. Secrets are not embedded in plist/unit/task command lines, and audit arguments redact token/password/key-like fields.

The tunnel control-plane key is excluded from the MCP server environment. The runtime file is still readable by the same OS account, so generic command authority can reach it by path; use a separate tunnel identity/account, OS sandbox, or credential broker when that threat matters. Command and process children receive a filtered environment: secret-like names (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_KEY`, credentials, and known provider keys) are removed by default. Use `TOOL_ENV_ALLOWLIST` only for values a project genuinely requires, or `TOOL_ENV_INHERIT_SECRETS=true` only after accepting the broader exposure. A credential broker remains preferable to long-lived environment secrets.

## Audit

Tool start/completion/failure events are redacted and hash-chained in JSONL under:

```text
~/.chatgpt-local-system/audit/
```

The chain helps detect accidental or offline edits but is not tamper-proof against a malicious process running as the same user. Export logs to an external append-only collector for stronger evidence.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Use GitHub's private vulnerability reporting for this repository:

<https://github.com/Veer376/chatgpt-local-system/security/advisories/new>

Include enough information to reproduce and assess the issue without including unrelated private data:

- affected Local System commit/version and platform;
- attack prerequisites and trust boundary crossed;
- minimal reproduction or proof of concept;
- expected versus actual authorization/approval behavior;
- whether credentials, local files, command execution, extension sessions, or public network routes are involved;
- suggested mitigation if you have one.

Do not include live credentials, real private project content, tunnel IDs paired with keys, personal ChatGPT screenshots, or sensitive logs. Use synthetic values and minimal test fixtures. If a credential has already been exposed, revoke/rotate it immediately rather than waiting for triage.

Please allow maintainers reasonable time to investigate and coordinate a fix before public disclosure. This project does not currently promise a formal response-time SLA.

Ordinary bugs and hardening ideas that are not exploitable can use the public issue templates.

## Supported security versions

Security fixes target the current `main` branch and the most recent tagged release when one exists. Older commits/releases receive fixes on a best-effort basis unless a release is explicitly marked supported in [the support matrix](SUPPORT.md).
