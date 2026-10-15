# Operations runbook

## Process topology

Run two independently supervised user processes:

1. Node MCP server on `127.0.0.1:8765`.
2. `tunnel-client run --profile sol-local-bridge`.

Provision the profile once. Runtime services should run it, not repeatedly reinitialize it.

## Lifecycle

macOS:

```bash
./scripts/service-macos.sh status
./scripts/service-macos.sh start
./scripts/service-macos.sh restart
```

Use `status` and `logs` for inspection, `start` to restore missing services, and
`restart` to reload running code. Restart preserves launchd supervision and checks
readiness; `npm run restart:all` delegates to it when LaunchAgents are installed.
Do not stop services as a prerequisite for inspection or restart.

`install` is initial setup and refuses to overwrite existing descriptors.
Intentional shutdown/removal requires `stop --confirm-downtime` or
`uninstall --confirm-downtime`; these unload services and disable auto-recovery.
Lifecycle requests and start/restart outcomes are recorded in
`~/.chatgpt-local-system/logs/lifecycle.log` with the caller PID and executable.
Local readiness does not establish remote connector connectivity; verify a tool
call after recovery.

For an existing public ngrok configuration, run `./scripts/service-macos.sh install-ngrok`
once. It uses `~/.config/chatgpt-local-system/ngrok.yml` and its `local-system`
tunnel, preserving that account's credentials. It adds a separate KeepAlive
LaunchAgent and loopback agent API on port 4048. Installed ngrok participates in
start, restart, status, stop, and uninstall; normal restarts retain supervision.
The public URL is reachable while the Mac is awake, online, and logged in.

Linux:

```bash
./scripts/service-linux.sh install|status|logs|restart|stop|start|uninstall
```

Windows:

```powershell
.\scripts\windows\service.ps1 install|status|logs|restart|stop|start|uninstall
```

Uninstall keeps runtime configuration, state, approvals, audit records, and logs. Remove those manually only after deciding they are no longer needed.

## Health

```bash
curl -fsS http://127.0.0.1:8765/healthz
curl -fsS http://127.0.0.1:8765/readyz
npm run doctor
npm run smoke
```

`readyz` publishes the frozen 11-tool contract. `smoke` performs writes only inside a unique run directory under `BRIDGE_SCRATCH_DIR` (or `SMOKE_WORKSPACE`) and cleans it in `finally`.

## Logs/state

Default Unix state:

```text
~/.chatgpt-local-system/
  audit/bridge.jsonl
  captures/
  logs/
  processes/
  pending-destructive.json
  state.json
```

Windows uses the same state folder under `%USERPROFILE%`. Agent-visible scratch data lives separately at `~/.local-system/scratch` by default; internal state is not a file-tool root.

## Key/profile rotation

1. Create a replacement runtime API key.
2. Update `runtime.env` without changing its owner/permissions.
3. Run `tunnel-client doctor --profile <profile> --explain` through `scripts/run-with-env.mjs`.
4. Restart only the tunnel service.
5. Revoke the old key.

## Upgrade

```bash
git pull --ff-only
npm ci
npm run check
npm run doctor
# then restart services for your platform
```

Use a release checkout rather than an actively edited working tree for unattended operation. Keep filesystem snapshots/backups of connected projects.

## ChatGPT browser extension

The first-class unpacked Chrome extension lives at `extensions/local-system/`.

It is a client of the same loopback Node process described above; there is no second extension server. `src/server.js` serves MCP on `/mcp` and the extension-facing `/local-image/*` and `/local-ui/*` routes on `127.0.0.1:8765`.

`npm run start:all` is the canonical all-in-one local runtime command: it builds project/extension artifacts, automatically loads the default per-user `runtime.env`, starts `src/server.js`, and starts the configured secure MCP tunnel. With the normal setup, no inline `BRIDGE_ENV_FILE`, tunnel, or macOS prompt environment variables are required. Chrome still loads the extension itself from `extensions/local-system/`.
