#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = "Darwin" ] || { echo "macOS only" >&2; exit 2; }

ACTION="${1:-status}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BRIDGE_ENV_FILE:-$HOME/.config/chatgpt-local-system/runtime.env}"
NODE="$(command -v node)"
TUNNEL="$(command -v tunnel-client || true)"
DOMAIN="gui/$(id -u)"
SERVER_LABEL="com.chatgpt-local-system.server"
TUNNEL_LABEL="com.chatgpt-local-system.tunnel"
PLIST_DIR="$HOME/Library/LaunchAgents"
STATE="$HOME/.chatgpt-local-system"
LOG_DIR="$STATE/logs"
NGROK_LABEL="com.chatgpt-local-system.ngrok"
NGROK_CONFIG="$HOME/.config/chatgpt-local-system/ngrok.yml"
LABELS=("$SERVER_LABEL" "$TUNNEL_LABEL")
if [ -f "$PLIST_DIR/$NGROK_LABEL.plist" ]; then LABELS+=("$NGROK_LABEL"); fi

# Normal lifecycle operations preserve launchd supervision. Only explicit
# stop/uninstall requests may unload jobs; restart never calls bootout.
audit() {
  mkdir -p "$LOG_DIR"
  (umask 077; printf '%s action=%s event=%s pid=%s ppid=%s caller=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ACTION" "$1" "$$" "$PPID" \
    "$(ps -p "$PPID" -o comm= 2>/dev/null || true)" >> "$LOG_DIR/lifecycle.log")
}

ensure_loaded() {
  local label="$1"
  launchctl print "$DOMAIN/$label" >/dev/null 2>&1 ||
    launchctl bootstrap "$DOMAIN" "$PLIST_DIR/$label.plist"
}

recover_on_exit() {
  local result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    # Best-effort repair of missing jobs, without stopping healthy services.
    for label in "${LABELS[@]}"; do
      ensure_loaded "$label" || true
    done
    audit "failed-$result"
  else
    audit complete
  fi
  exit "$result"
}

case "$ACTION" in
  stop|uninstall)
    if [ "${2:-}" != "--confirm-downtime" ]; then
      echo "$ACTION disables auto-recovery. For intentional downtime use: $0 $ACTION --confirm-downtime. For recovery use: $0 restart." >&2
      exit 2
    fi
    audit requested
    ;;
  start|restart)
    # Validate both descriptors before changing either service.
    for label in "${LABELS[@]}"; do
      plutil -lint "$PLIST_DIR/$label.plist" >/dev/null
    done
    audit requested
    trap recover_on_exit EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    ;;
esac

check_status() {
  [ -f "$ENV_FILE" ] || { echo "runtime env missing: $ENV_FILE" >&2; return 1; }
  local host port tunnel_port
  host="$($NODE "$REPO/scripts/runtime-value.mjs" "$ENV_FILE" HOST)"
  port="$($NODE "$REPO/scripts/runtime-value.mjs" "$ENV_FILE" PORT)"
  tunnel_port="$($NODE "$REPO/scripts/runtime-value.mjs" "$ENV_FILE" TUNNEL_HEALTH_PORT)"
  local ngrok_enabled=false
  if [ -f "$PLIST_DIR/$NGROK_LABEL.plist" ]; then ngrok_enabled=true; fi
  "$NODE" "$REPO/scripts/service-status.mjs" "$host" "$port" "$tunnel_port" "${1:-0}" "$ngrok_enabled"
}

xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

write_plist() {
  local label="$1"; shift
  local out="$PLIST_DIR/$label.plist"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$(xml "$label")</string>
<key>ProgramArguments</key><array>
EOF
    for arg in "$@"; do printf '<string>%s</string>\n' "$(xml "$arg")"; done
    cat <<EOF
</array>
<key>WorkingDirectory</key><string>$(xml "$REPO")</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Interactive</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>$(xml "$LOG_DIR/${label##*.}.out.log")</string>
<key>StandardErrorPath</key><string>$(xml "$LOG_DIR/${label##*.}.err.log")</string>
</dict></plist>
EOF
  } > "$out"
  chmod 600 "$out"
}

case "$ACTION" in
  install-ngrok)
    NGROK="$(command -v ngrok || true)"
    [ -x "$NGROK" ] || { echo "ngrok binary not found" >&2; exit 1; }
    [ -f "$NGROK_CONFIG" ] || { echo "missing $NGROK_CONFIG" >&2; exit 1; }
    [ ! -e "$PLIST_DIR/$NGROK_LABEL.plist" ] || { echo "ngrok already installed; use start" >&2; exit 2; }
    # A reverse tunnel exposes the local HTTP server to the public internet.
    # Never install an unauthenticated MCP tunnel, even if it targets loopback.
    [ -f "$ENV_FILE" ] || { echo "missing runtime.env; ngrok requires authenticated MCP access" >&2; exit 2; }
    "$NODE" "$REPO/scripts/verify-ngrok-auth.mjs" "$ENV_FILE" || exit 2
    mkdir -p "$PLIST_DIR" "$LOG_DIR"
    # Use a dedicated loopback agent API, separate from other ngrok instances.
    (umask 077; printf 'version: "2"\nweb_addr: 127.0.0.1:4048\n' > "$STATE/ngrok-agent.yml")
    "$NGROK" config check --config "$NGROK_CONFIG" --config "$STATE/ngrok-agent.yml" >/dev/null
    write_plist "$NGROK_LABEL" "$NGROK" start --config "$NGROK_CONFIG" --config "$STATE/ngrok-agent.yml" local-system --log stdout --log-format json
    plutil -lint "$PLIST_DIR/$NGROK_LABEL.plist" >/dev/null
    audit requested
    ensure_loaded "$NGROK_LABEL"
    check_status 45000
    audit complete
    ;;
  install)
    # Installation is initial setup, not an implicit reconfiguration/restart.
    # Preserve existing descriptors and their environment overrides.
    if [ -e "$PLIST_DIR/$SERVER_LABEL.plist" ] || [ -e "$PLIST_DIR/$TUNNEL_LABEL.plist" ]; then
      echo "LaunchAgent descriptors already exist; use start or restart. Explicitly uninstall before replacing service configuration." >&2
      exit 2
    fi
    [ -x "$NODE" ] || { echo "Node 20+ not found" >&2; exit 1; }
    [ -x "$TUNNEL" ] || { echo "tunnel-client not found" >&2; exit 1; }
    [ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE; run scripts/connect-chatgpt.sh" >&2; exit 1; }
    MODE="$(stat -f '%Lp' "$ENV_FILE")"
    [ "$MODE" = "600" ] || { echo "$ENV_FILE must be mode 0600 (currently $MODE)" >&2; exit 1; }
    mkdir -p "$PLIST_DIR" "$LOG_DIR"
    chmod 700 "$STATE" "$LOG_DIR"
    write_plist "$SERVER_LABEL" "$NODE" "$REPO/scripts/run-with-env.mjs" "$ENV_FILE" --exclude=CONTROL_PLANE_API_KEY -- "$NODE" "$REPO/src/server.js"
    write_plist "$TUNNEL_LABEL" "$NODE" "$REPO/scripts/run-with-env.mjs" "$ENV_FILE" -- "$NODE" "$REPO/scripts/run-tunnel.mjs" "$TUNNEL"
    for label in "$SERVER_LABEL" "$TUNNEL_LABEL"; do
      plist="$PLIST_DIR/$label.plist"
      plutil -lint "$plist" >/dev/null
      launchctl bootstrap "$DOMAIN" "$plist"
    done
    check_status 45000
    ;;
  uninstall)
    for label in "${LABELS[@]}"; do
      launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
      rm -f "$PLIST_DIR/$label.plist"
    done
    echo "services uninstalled; runtime config and logs were kept"
    ;;
  start)
    for label in "${LABELS[@]}"; do
      ensure_loaded "$label"
      launchctl kickstart "$DOMAIN/$label"
    done
    check_status 45000
    ;;
  restart)
    # Load missing jobs first. A killed/interrupted caller cannot leave a
    # previously supervised service unloaded during this restart.
    for label in "${LABELS[@]}"; do ensure_loaded "$label"; done
    for label in "${LABELS[@]}"; do launchctl kickstart -k "$DOMAIN/$label"; done
    check_status 45000
    ;;
  stop)
    for label in "${LABELS[@]}"; do launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true; done
    ;;
  status)
    check_status
    ;;
  logs)
    tail -n 100 "$LOG_DIR"/*.log 2>/dev/null || echo "no logs yet"
    ;;
  logs-follow)
    echo "following logs; press Ctrl-C to stop"
    touch "$LOG_DIR/server.err.log" "$LOG_DIR/server.out.log" "$LOG_DIR/tunnel.err.log" "$LOG_DIR/tunnel.out.log"
    tail -n 100 -f "$LOG_DIR"/*.log
    ;;
  *) echo "Usage: $0 {install|install-ngrok|start|restart|status|logs|logs-follow} or {stop|uninstall} --confirm-downtime" >&2; exit 2 ;;
esac
