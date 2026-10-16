# Operations runbook

## Process topology

Run two independently supervised user processes:

1. Node MCP server on `127.0.0.1:8765`.
2. `tunnel-client run --profile sol-local-bridge`.

Provision the profile once. Runtime services should run it, not repeatedly reinitialize it.

# Operating Local System

This page is for day-to-day operation after the initial connection setup. For a first install, start with the [Secure MCP Tunnel guide](INSTALL-SECURE-TUNNEL.md). The ngrok path remains advanced until the project ships compatible OAuth/device pairing.

## Quick lifecycle

If you are running Local System directly from a terminal, use:

```bash
npm run start:all
```

Keep that terminal open. Press **Ctrl+C** for an intentional foreground shutdown. For an unattended machine, install the OS service once and then use the lifecycle commands below.

| Action | Meaning |
| --- | --- |
| `status` | Inspect whether the managed server/tunnel are running. No restart. |
| `logs` | Show recent logs. Use this before restarting when diagnosing a failure. |
| `start` | Start services that are currently stopped. |
| `restart` | Reload the current checkout and restore supervised services. Use after code/config changes. |
| `stop` | Intentional downtime. Does **not** delete config/state. |
| `uninstall` | Remove OS service registration. Config/state/logs are deliberately kept. |

## Managed service commands

macOS:

```bash
./scripts/service-macos.sh status
./scripts/service-macos.sh logs
./scripts/service-macos.sh start
./scripts/service-macos.sh restart
./scripts/service-macos.sh stop --confirm-downtime
./scripts/service-macos.sh uninstall --confirm-downtime
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

`install-ngrok` is an **advanced** optional action, not part of normal service installation. It refuses installation without a strong `MCP_TOKEN`, but that token check alone does not make ChatGPT public-MCP OAuth work. Follow [INSTALL-NGROK.md](INSTALL-NGROK.md) and do not expose an anonymous `/mcp` endpoint.

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
npm run smoke:clone
```

`npm run doctor` automatically reads the normal per-user `runtime.env`. It checks Node.js, the runtime file and Unix permissions, configured workspace roots/default workspace, required binaries, tunnel profile, optional extension origin, Local System's port/readiness, and the tunnel health port. Secret-bearing values are reported only as configured/redacted, not printed. A stopped bridge/tunnel is a warning by default; use `npm run doctor -- --live` to require the local bridge and `npm run doctor -- --tunnel` to require the configured tunnel/profile.

`readyz` publishes the frozen 11-tool contract. `npm run smoke` connects to the currently configured bridge and performs writes only inside a unique run directory under `BRIDGE_SCRATCH_DIR` (or `SMOKE_WORKSPACE`), cleaning it in `finally`.

`npm run smoke:clone` is the release/installability check: it makes a fresh Git clone of the current committed checkout into temporary storage, runs `npm ci`, builds it, starts an isolated loopback server on a temporary port, exercises the MCP tool roundtrip, stops it, and removes the temporary clone. It intentionally tests **committed files only**, so a dirty working tree is not smuggled into the result.

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

Before upgrading, make sure the checkout does not contain work you would lose and record the currently working commit:

```bash
git status --short
git rev-parse HEAD
git pull --ff-only
npm ci
npm run check
npm run smoke:clone
npm run doctor
# then restart services for your platform
```

Use a release checkout rather than an actively edited working tree for unattended operation. Keep filesystem snapshots/backups of connected projects.

### Roll back to a known-good commit

If an upgrade breaks the bridge, do **not** reset a dirty development checkout. In a clean release checkout:

```bash
git status --short               # should be empty
git switch --detach <known-good-commit-or-tag>
npm ci
npm run check
npm run doctor
# restart the managed service for your platform
```

After the issue is fixed upstream, return to the main branch with `git switch main`, run `git pull --ff-only`, `npm ci`, and the checks again. Runtime configuration and state live outside the Git checkout, so switching source revisions does not intentionally delete them. If a future release changes state formats, follow that release's migration notes before rolling backward.

## ChatGPT browser extension

The first-class unpacked Chrome extension lives at `extensions/local-system/`.

It is a client of the same loopback Node process described above; there is no second extension server. `src/server.js` serves MCP on `/mcp` and the extension-facing `/local-image/*` and `/local-ui/*` routes on `127.0.0.1:8765`.

`npm run start:all` is the canonical all-in-one local runtime command: it builds project/extension artifacts, automatically loads the default per-user `runtime.env`, starts `src/server.js`, and starts the configured secure MCP tunnel. With the normal setup, no inline `BRIDGE_ENV_FILE`, tunnel, or macOS prompt environment variables are required. Chrome still loads the extension itself from `extensions/local-system/`.
