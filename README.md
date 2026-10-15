# chatgpt-local-system

A production-grade, cross-platform implementation of the **ChatGPT Web → OpenAI Secure MCP Tunnel → local workstation** workflow.

The bridge exposes a deliberately small **11-tool** model-facing contract. Local execution, file operations, conversation-scoped workspace/todo/runtime state, human confirmation, and skills are the supported surface.

The local MCP endpoint binds to loopback by default. Tunnel connectivity is initiated outbound by `tunnel-client` over HTTPS—no public port or inbound firewall rule is required. Commands, project scripts, package managers, tests, and delegated agents may make their own outbound connections.

> [!IMPORTANT]
> This bridge gives an AI agent the authority of the local user running it. Destructive operations pause inside the originating tool call for explicit human confirmation through macOS/Telegram; this is **not an OS sandbox**. For sensitive work, use a dedicated OS account, VM/container, filesystem snapshots, and limited workspace roots.

> [!WARNING]
> **Do not publish the local MCP port using an unprotected ngrok or other public HTTP tunnel.** The documented OpenAI Secure MCP Tunnel workflow intentionally uses no application-level MCP authentication. That trust model does **not** apply to a public reverse proxy. A public endpoint can otherwise expose command execution and file access. Configure an independently authenticated proxy and verify it before enabling any public tunnel; ngrok is not required for the standard installation.

> **Optional ngrok setup is for experienced users until the authenticated onboarding flow is complete.** On macOS, `install-ngrok` refuses to install without a strong `MCP_TOKEN` in the per-user `runtime.env`. Your MCP client must send that token in an `Authorization: Bearer` header. Configure the ngrok ingress to expose **only `/mcp`**, never `/local-ui/*`, `/local-file/*` or `/local-image/*`, and verify unauthenticated requests get HTTP 401/403 before sharing the URL. Simply installing ngrok does not supply these protections. If your ChatGPT connection cannot send an authorization header, do not use this ngrok path.

---

## Why this exists

ChatGPT can reason about a bug, but without tools a human still has to copy patches, run commands, paste logs, switch to a browser, and report results. This bridge closes that execution loop while keeping the workstation private:

- Operate a development machine from ChatGPT Web—including from another device.
- Reuse the ChatGPT product surface as the orchestrator while keeping local Codex optional.
- Avoid public tunnel URLs and inbound network exposure.
- Keep tool authority, workspace roots, output limits, and destructive approvals under code you control.
- Preserve the original rule: **create/update/edit are allowed; delete/reset/quit must be previewed and confirmed first**.

## Architecture

```text
ChatGPT Web / desktop
        │
        ▼
OpenAI Secure MCP Tunnel
        ▲
        │ outbound HTTPS
  tunnel-client (local)
        │ loopback HTTP
        ▼
http://127.0.0.1:8765/mcp
        │
 ┌──────┼──────────┬───────────┐
 files  tasks     human       skills
 patch  workspace approval    discovery
```

The bridge and tunnel are separate processes so they can be tested, restarted, logged, and supervised independently.

## Exact 11-tool contract

The model-facing names are frozen and contract-tested:

| Family         | Tools                                          |
| -------------- | ---------------------------------------------- |
| Context        | `bridge_context`                               |
| Workspace      | `workspace`                                    |
| Files          | `display`, `view_image`, `apply_patch`         |
| Commands/tasks | `execute_command`, `manage_task`               |
| Human/state    | `request_user_input`, `write_todos`, `runtime_memory` |
| Skills         | `discover_skills`                              |

`bridge_context` returns the essential Local System instructions, platform/project orientation, durable memory/skill context, runtime memory, open todo summary, and Local System scratch directory. `workspace` selects the current project per conversation. `execute_command` covers local inspection/search/build/test work; `apply_patch` covers ordinary text-file creation and edits.

The model-facing contract intentionally stays small. Internal or deferred implementations may exist when they are still part of an active project direction, but they are not advertised as model tools until they are deliberately registered.

### request_user_input

Pass optional `content` and/or one `question` object. Call `request_user_input` with `{}` to
resume an existing conversation-scoped questionnaire. A question without options is free text;
`multiple: true` requires options and allows several choices. Partial answers survive between
observing calls.

The macOS dialog and Telegram are offered at once; the first surface answered wins. The underlying
questionnaire remains alive when an observing MCP call is cancelled. The human-facing
questionnaire TTL is five minutes, while each observing connector call yields earlier so it can
resume cleanly before the upstream tool-call deadline.

### runtime_memory

`runtime_memory` stores one compact conversation-scoped working snapshot for long-running tasks. It
supports `read`, `write`, and `clear`; `write` replaces the complete snapshot rather than merging
fragments. `bridge_context` includes the current snapshot automatically, and the long-turn checkpoint
asks the agent to refresh it before handing control back.

Known limits:

- Telegram has no native multi-select control. It is emulated with toggle rows plus a Done button,
  so a multi-select answer costs one extra tap versus a single choice.
- The macOS panel is a fixed size. Around eight or more options crowd the question text, which
  scrolls rather than growing the window.
- Because both surfaces are live at once, the macOS panel is deliberately not always-on-top: it
  stays visible across app switches, but must not sit over Telegram and block answering there.
- The panel needs a pyobjc-capable interpreter. Set `MACOS_ASK_USER_PYTHON` to pin one — otherwise
  the helper uses whichever `python3` is first on `PATH`, so launching the bridge from a shell with
  a virtualenv active silently disables the native prompt with no error.
- `ASK_USER_DEBUG=1` records question and answer routing to `ASK_USER_DEBUG_FILE`
  (default `/tmp/ask-user-debug.log`). It writes to that file directly rather than through stdout,
  which was observed to swallow the output depending on how the bridge was launched.

## Platform support

The MCP server, workspace/file primitives, managed commands, human interaction service, and skill discovery are supported on macOS, Linux, and Windows where their documented runtime dependencies are available. Native desktop automation, browser/CDP, Office, web-fetch, capture/audio, scheduler, and standalone Git/project wrapper tools are not part of this bridge contract.

---

## Quick start: local server

### 1. Requirements

Required:

- Node.js 20+
- Git
- `tunnel-client` from OpenAI
- An eligible ChatGPT web account with Developer Mode available (managed workspaces may require an admin grant)
- An OpenAI Platform organization with tunnel permissions and a runtime API key

Recommended/optional:

```bash
# macOS examples
brew install openai/tools/tunnel-client
brew install ripgrep ffmpeg tesseract
# interceptor and codex are optional integrations
```

Windows users should install the current `tunnel-client` release from [openai/tunnel-client](https://github.com/openai/tunnel-client/releases).

### 2. Install

```bash
git clone https://github.com/Veer376/chatgpt-local-system.git
cd chatgpt-local-system
npm ci
cp .env.example .env
```

Edit `.env` and grant only the directories ChatGPT actually needs:

```dotenv
HOST=127.0.0.1
PORT=8765
WORKSPACE_ROOTS=/Users/you/projects
DEFAULT_WORKSPACE=/Users/you/projects/example-project
ALLOW_TOOL_ROOT_REGISTRATION=false
INCLUDE_COMMON_WORKSPACE_ROOTS=false
TOOL_UI=false
TOOL_UI_APPLY_PATCH=true
# TOOL_UI_DISPLAY=true
```

On Windows, separate multiple roots with `;`. On macOS/Linux, use `:`.

`TOOL_UI` controls optional rich ChatGPT tool views. `apply_patch` defaults to its compact diff viewer even when the global switch is off; set `TOOL_UI_APPLY_PATCH=false` to disable it. Other tools can be overridden with `TOOL_UI_<TOOL_NAME>`, for example `TOOL_UI_EXECUTE_COMMAND=false` or `TOOL_UI_DISPLAY=true`. Tool execution and returned content are unchanged. Destructive confirmation is handled separately through the macOS/Telegram human interaction service.

The workspace settings have distinct roles:

- `WORKSPACE_ROOTS` authorizes parent directories that may contain many projects.
- `DEFAULT_WORKSPACE` supplies the initial current project when no persisted selection exists; it must be inside `WORKSPACE_ROOTS` and accepts exactly one directory.
- `workspace` with `action: "save"` stores an optional project shortcut with name and description metadata without granting access or selecting it. Saved projects are not an exhaustive list of accessible directories.
- `workspace` with `action: "open"` selects a directory within an authorized project root as the current project workspace and cannot select Local System scratch.
- `BRIDGE_SCRATCH_DIR` is the parent for automatically created, conversation-scoped machine-side scratch directories. `bridge_context` returns the calling conversation's full `localScratchDir`; agents pass that value explicitly as `cwd` for non-project work and never construct its hashed suffix.

Authorized project roots and Local System scratch constrain exposed file tools and command working directories; they are not an OS sandbox for subprocesses launched through `execute_command` or `manage_task`. No Desktop, Documents, or home-directory project roots are implicit unless `INCLUDE_COMMON_WORKSPACE_ROOTS=true`. Add project roots to `.env`, or explicitly opt into broader authority only if you accept that risk.

### 3. Diagnose, start, and smoke-test

```bash
npm run doctor
npm start
```

In another terminal:

```bash
npm run smoke
```

Expected result: exactly 11 model tools, an `apply_patch` create/edit round trip, `execute_command` inspection/search in a unique directory under `BRIDGE_SCRATCH_DIR`, and structured `bridge_context` output.

Health endpoints:

```bash
curl http://127.0.0.1:8765/healthz
curl http://127.0.0.1:8765/readyz
```

---

## Connect through OpenAI Secure MCP Tunnel

### 1. Create the OpenAI resources

1. Create a tunnel at <https://platform.openai.com/settings/organization/tunnels>.
2. Associate it with the ChatGPT workspace that should discover it.
3. Create a runtime API key at <https://platform.openai.com/settings/organization/api-keys> with Tunnels **Read + Use**.
4. Enable ChatGPT Developer Mode/custom apps in the target workspace.

Platform tunnel roles and ChatGPT workspace Developer Mode are separate permissions.

### 2. Guided configuration

macOS/Linux:

```bash
./scripts/connect-chatgpt.sh
```

Windows PowerShell:

```powershell
.\scripts\windows\configure-tunnel.ps1
```

The wizard seeds a user-only `runtime.env` from the repository `.env` (intentionally omitting `MCP_TOKEN` because the documented tunnel profile uses `sample_mcp_remote_no_auth`), prompts separately for workspace roots/default workspace, initializes the profile from the configured MCP endpoint, and runs `tunnel-client doctor`. API keys are not embedded in service descriptors or process arguments. For persistent services, `runtime.env` is authoritative—edit it rather than `.env`, then restart the affected service.

Default runtime config locations:

- macOS/Linux: `~/.config/chatgpt-local-system/runtime.env` (`0600`)
- Windows: `%APPDATA%\chatgpt-local-system\runtime.env` (user-only ACL)

### 3. Equivalent manual commands

```bash
export CONTROL_PLANE_API_KEY="sk-..."
tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile sol-local-bridge \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --health-listen-addr 127.0.0.1:8766 \
  --mcp-server-url http://127.0.0.1:8765/mcp

tunnel-client doctor --profile sol-local-bridge --explain
tunnel-client run --profile sol-local-bridge
```

Leave both `npm start` and `tunnel-client run` running, use `npm run start:all` to start them in dependency order, or install the user services below. The tunnel wrapper waits for `/readyz` before launching `tunnel-client`, avoiding a cold-start probe race. If `HOST`/`PORT` changes, rerun tunnel profile initialization so its `--mcp-server-url` stays in sync. Service status also checks tunnel readiness at `http://127.0.0.1:8766/readyz`.

### 4. Attach ChatGPT on the website or desktop app

See **[ChatGPT website and desktop setup](docs/CHATGPT_SETUP.md)** for the complete, current walkthrough and troubleshooting guide.

#### ChatGPT website

1. On ChatGPT web, open **Settings → Security and login** and enable **Developer mode**.
2. Open <https://chatgpt.com/plugins>, select **+**, and create a developer-mode connection.
3. Choose **Connection = Tunnel**, select/paste your `tunnel_...` ID, and choose **No Authentication**.
4. Verify that discovery returns exactly 11 model tools.
5. In a new conversation, choose **Developer mode** from the composer's **+** menu, enable the app, and ask:

> Use SOL Local Bridge only. Call `bridge_context`, then call `workspace` with `action: "list"`. If `currentProjectWorkspace` is set, use `execute_command` for a bounded read-only inspection such as `git status --short` and a shallow file listing. Do not modify anything.

#### ChatGPT desktop app

OpenAI currently registers custom MCP connections on the website first. Sign into the desktop app with the same account/workspace and check its Plugins/Developer Mode picker. If the connection does not appear directly, copy its `plugin_asdk_app_...` technical ID from the website URL and use `@plugin-creator` in desktop **Work mode** to package it with a personal marketplace entry. Restart the desktop app, install it from the Plugins Directory, and test it in a new conversation. The detailed guide explains each step and the difference between `tunnel_...` and `plugin_asdk_app_...` IDs.

If **Developer mode** is absent on the website, confirm account/workspace eligibility and—on a managed workspace—ask its admin for access. If Work mode or the Plugins Directory is absent from the desktop app, update it; if the surface remains unavailable for that account/build, use the website integration.

---

## Run persistently

Desktop automation must run in the logged-in user's session. Do not run it as a macOS LaunchDaemon, Windows Session-0 service, or headless system service if you expect UI control.

### macOS LaunchAgents

```bash
./scripts/service-macos.sh install
./scripts/service-macos.sh status
./scripts/service-macos.sh logs
# start restores services; restart preserves launchd supervision
# intentional stop/uninstall requires --confirm-downtime
```

Two LaunchAgents are installed: one for the MCP server and one for `tunnel-client`. The plist files contain only paths—not secrets.

### Linux systemd user services

```bash
./scripts/service-linux.sh install
./scripts/service-linux.sh status
./scripts/service-linux.sh logs
```

For an interactive desktop, keep these as user services. A dedicated system user is appropriate only for headless file/git/build workflows. User services normally follow the user's login session; intentional headless persistence may require `loginctl enable-linger <user>` and is not universally available in containers, minimal distributions, or WSL.

### Windows Scheduled Tasks

```powershell
.\scripts\windows\service.ps1 install
.\scripts\windows\service.ps1 status
.\scripts\windows\service.ps1 logs
```

Tasks run at user logon with limited privileges and `MultipleInstances=IgnoreNew`. They do not request highest privileges.

---

## Destructive approval model

Destructive shell operations and patch-based file deletion are intercepted before execution. The originating tool call stays pending while the bridge asks the human through the shared macOS/Telegram interaction service.

- **Approve** executes the exact original operation.
- **Deny** cancels it.
- A **custom response** cancels it and returns that text to the agent as a human instruction.
- Timeout executes nothing and tells the agent to retry the original call only if the operation is still necessary.

Only the explicit Approve option authorizes execution; typed text never authorizes a destructive action. Approval and execution events are audited by operation fingerprint.

---

## Security defaults

- Loopback-only bind is enforced. Non-loopback operation is intentionally refused; any external TLS/auth proxy requires a separate security design and keeps the bridge itself on loopback.
- Host-header validation against DNS rebinding.
- Optional bearer authentication with timing-safe comparison.
- Explicit project roots; tool-driven authority expansion disabled. The calling conversation's directory beneath `BRIDGE_SCRATCH_DIR` is its only automatic non-project tool root.
- Internal approvals/process metadata/audit state is never a file-tool root; realpath/symlink-aware containment and protected credential/system paths are enforced.
- Bridge-owned process IDs only, with start-identity checks and process-tree termination.
- Bounded request bodies, command output, timeouts, concurrent tool calls, task-log size, record count, and retention.
- Hash-chained, redacted audit JSONL under `~/.chatgpt-local-system/audit/`.
- Runtime API keys live only in a user-owned secret file. The tunnel key is excluded from the MCP server, and secret-like environment variables are stripped from command and process children unless explicitly allowlisted.

Tool arguments/results can include source code or local data and are sent through the calling OpenAI product. Do not expose a workspace whose data policy forbids that processing.

---

## Historical tool recovery

Dormant, intentionally unexposed tool implementations were removed to keep the runtime source aligned with the actual MCP contract. If one of those implementations is needed later, search Git history for the commit titled **`Remove dormant unexposed tool implementations`** and recover only the specific capability being reconsidered.

## Agent-runtime compatibility caveat

The current bridge integrates with runtime conventions supplied by ChatGPT, not only generic MCP calls. In particular:

- Tool results rely on the agent runtime consuming MCP `structuredContent`; `content` is intentionally concise while the complete machine-readable payload is returned in `structuredContent`.
- Conversation-scoped workspace and todo state rely on the caller supplying a stable conversation/thread identity in request metadata. The current ChatGPT path provides this through `openai/session` (with `threadId` supported as a fallback).
- App-only helper tools rely on MCP UI visibility metadata being respected by the client so UI plumbing is not presented as model-facing tools.

Before moving this bridge to another agent/runtime, verify equivalent support for result payloads, stable conversation identity, and app-only tool visibility. If any assumption is missing, adapt that runtime or add a compatibility layer in the bridge before treating the alternate agent as functionally equivalent. Otherwise calls can succeed while the agent misses result data, thread-scoped state becomes unavailable, or UI-only helpers leak into the model tool surface.

## Development and validation

```bash
npm run lint
npm test                 # unit + integration
npm run test:unit
npm run test:integration
npm run check            # lint + all tests
npm run doctor -- --json
npm run doctor -- --live       # require local /readyz
# For service configuration, load runtime.env without echoing secrets:
node scripts/run-with-env.mjs ~/.config/chatgpt-local-system/runtime.env -- npm run doctor -- --tunnel
```

The test suite covers:

- exact 11-tool contract
- authenticated Streamable HTTP MCP lifecycle
- workspace and symlink escape protection
- file preview/image/patch round trips
- destructive detection and inline human confirmations
- managed-task ownership/logging/input/stopping
- project command detection

## Repository layout

```text
src/
  server.js              Streamable HTTP MCP server
  tool-contract.js       frozen exact 11-tool list
  lib/                   policy, paths, task/process state, audit, conversation state
  platform/              lightweight OS identity summary
  tools/                 exposed tool-family modules
docs/
  CHATGPT_SETUP.md       website + desktop app connection guide
  SECURITY.md            trust boundaries and hardening
  OPERATIONS.md          service and incident runbook
scripts/
  connect-chatgpt.sh     Unix tunnel setup wizard
  service-macos.sh       LaunchAgent lifecycle
  service-linux.sh       systemd-user lifecycle
  windows/               PowerShell setup/service scripts
  smoke.mjs              live MCP smoke test
examples/python-minimal/  original small FastMCP teaching example
```

## Operational caveats

- The workstation must be awake, logged in, connected, and running both services.
- macOS Accessibility/Screen Recording/Microphone permissions are granted to the executable actually running the bridge (Terminal/Node/interceptor).
- Linux Wayland support varies by compositor.
- Windows desktop automation requires an interactive user session.
- Cross-platform DOCX/XLSX support covers document data, not Office macros, rendering fidelity, or Excel formula recalculation.
- Attaching browser automation to a personal profile exposes that profile's signed-in sessions to the agent.

## References

- [ChatGPT Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Package plugins for ChatGPT desktop/Codex](https://developers.openai.com/plugins/build/plugins)
- [openai/tunnel-client](https://github.com/openai/tunnel-client)
- [OpenAI private MCP server announcement](https://developers.openai.com/blog/connect-private-mcp-servers-to-openai-products)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## License

MIT. `tunnel-client` itself is OpenAI's separate Apache-2.0 project; it is not vendored here.

## ChatGPT browser extension

The production unpacked Chrome extension is maintained at [`extensions/local-system/`](extensions/local-system/README.md). It provides clickable local-file references, inline image/PDF previews, todos, local file pickers, the right-side file workspace, and annotations.

The extension uses the **same Local System server** as MCP at `http://127.0.0.1:8765`; it does not run a separate local server. `npm run start:all` builds the extension bundle, launches `src/server.js`, and launches the configured secure MCP tunnel. See the extension README for Chrome loading instructions and shortcuts.
