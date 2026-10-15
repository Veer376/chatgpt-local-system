#!/usr/bin/env bash
set -euo pipefail

NGROK_BIN="${NGROK_BIN:-ngrok}"
NGROK_PORT="${NGROK_PORT:-${PORT:-8765}}"
NGROK_API_URL="${NGROK_API_URL:-http://127.0.0.1:4040/api/tunnels}"
PID_FILE="${NGROK_PID_FILE:-${TMPDIR:-/tmp}/chatgpt-local-system-ngrok.pid}"
LOG_FILE="${NGROK_LOG_FILE:-${TMPDIR:-/tmp}/chatgpt-local-system-ngrok.log}"
POLICY_FILE="${NGROK_POLICY_FILE:-${TMPDIR:-/tmp}/chatgpt-local-system-ngrok-policy.json}"

escape_ere() {
  printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\&/g'
}

NGROK_NAME_PATTERN="$(escape_ere "$(basename "$NGROK_BIN")")"
NGROK_PORT_PATTERN="$(escape_ere "$NGROK_PORT")"
NGROK_PROCESS_PATTERN="(^|/)${NGROK_NAME_PATTERN}[[:space:]]+http[[:space:]]+${NGROK_PORT_PATTERN}([[:space:]]|$)"

is_ngrok_pid() {
  local pid="${1:-}"
  local command=""

  case "$pid" in
    ""|*[!0-9]*) return 1 ;;
  esac

  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  printf '%s\n' "$command" | grep -Eq "$NGROK_PROCESS_PATTERN"
}

find_ngrok_pid() {
  local pid=""

  if [ -f "$PID_FILE" ]; then
    pid="$(head -n 1 "$PID_FILE" 2>/dev/null || true)"
    if is_ngrok_pid "$pid"; then
      printf '%s\n' "$pid"
      return 0
    fi
  fi

  pid="$(pgrep -f "$NGROK_PROCESS_PATTERN" | head -n 1 || true)"
  if is_ngrok_pid "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi

  return 1
}

tunnel_is_ready() {
  curl -fsS --max-time 1 "$NGROK_API_URL" 2>/dev/null \
    | grep -Eq "\"addr\"[[:space:]]*:[[:space:]]*\"http://(localhost|127\\.0\\.0\\.1):${NGROK_PORT_PATTERN}\""
}

write_traffic_policy() {
  (
    umask 077
    printf '%s\n' '{"on_http_request":[{"actions":[{"type":"add-headers","config":{"headers":{"host":"localhost"}}}]}]}' > "$POLICY_FILE"
  )
}

stop_ngrok() {
  local pid=""

  pid="$(find_ngrok_pid || true)"
  if [ -z "$pid" ]; then
    echo "ngrok is not running."
    rm -f "$PID_FILE" "$POLICY_FILE"
    return 0
  fi

  echo "Stopping ngrok on port $NGROK_PORT (pid $pid)..."
  if ! kill "$pid" 2>/dev/null; then
    rm -f "$PID_FILE" "$POLICY_FILE"
    echo "ngrok stopped."
    return 0
  fi

  for _ in 1 2 3 4 5; do
    if ! is_ngrok_pid "$pid"; then
      rm -f "$PID_FILE" "$POLICY_FILE"
      echo "ngrok stopped."
      return 0
    fi
    sleep 1
  done

  echo "ngrok did not stop within 5 seconds (pid $pid)." >&2
  return 1
}

start_ngrok() {
  if ! command -v "$NGROK_BIN" >/dev/null 2>&1; then
    echo "ngrok executable not found: $NGROK_BIN" >&2
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to verify ngrok readiness." >&2
    return 1
  fi
  if ! write_traffic_policy; then
    echo "could not create temporary ngrok traffic policy: $POLICY_FILE" >&2
    return 1
  fi

  echo "Starting ngrok on port $NGROK_PORT..."
  nohup "$NGROK_BIN" http "$NGROK_PORT" --traffic-policy-file "$POLICY_FILE" >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if is_ngrok_pid "$pid" && tunnel_is_ready; then
      echo "ngrok started with pid $pid"
      return 0
    fi
  done

  echo "ngrok failed to start; see $LOG_FILE" >&2
  if is_ngrok_pid "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE" "$POLICY_FILE"
  return 1
}

if find_ngrok_pid >/dev/null; then
  stop_ngrok
else
  start_ngrok
fi
