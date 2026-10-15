/* global document, window */
import { createLiteApp } from "./mcp-lite.js";

function toolArgs(input) {
  return input?.arguments || input || {};
}

function syncChatGptToolInput() {
  const input = window.openai?.toolInput;
  if (!input || typeof input !== "object") return false;
  inputArgs = { ...(inputArgs || {}), ...input };
  return true;
}

const app = createLiteApp({
  name: "Command Result",
  version: "2.3.0",
  onToolInput: (input) => {
    inputArgs = toolArgs(input);
    render();
  },
  onToolInputPartial: (input) => {
    inputArgs = { ...(inputArgs || {}), ...toolArgs(input) };
    render();
  },
  onToolResult: (result) => {
    payload = result?.structuredContent || null;
    render();
  },
  onToolCancelled: ({ reason } = {}) => {
    payload = {
      ok: false,
      cancelled: true,
      command: inputArgs?.command || "",
      cwd: inputArgs?.cwd || "",
      stderr: reason || "Command cancelled.",
      durationMs: 0,
    };
    render();
  },
  onError: (error) => {
    payload = { ok: false, command: "MCP App", stderr: error.message || String(error), durationMs: 0 };
    render();
  },
});
const root = document.getElementById("root");
let payload = null;
let inputArgs = null;

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function basename(value) {
  const parts = String(value || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(value || "");
}

function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n} ms`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`;
}

function render() {
  if (!payload) {
    syncChatGptToolInput();
    const command = String(inputArgs?.command || "");
    const cwd = String(inputArgs?.cwd || "");
    root.innerHTML = `<main class="shell">
      <section class="card" aria-label="Running command" tabindex="0">
        <header class="topbar">
          <div class="status pending"><span class="status-icon">…</span>Running</div>
          ${cwd ? `<div class="meta"><span title="${esc(cwd)}">${esc(cwd)}</span></div>` : ""}
        </header>
        <div class="terminal">
          <div class="prompt"><span class="prompt-mark">$</span><code>${esc(command || "Preparing command…")}</code></div>
        </div>
      </section>
    </main>`;
    return;
  }

  const running = Boolean(payload.running);
  const ok = Boolean(payload.ok);
  const stdout = String(payload.stdout || "");
  const stderr = String(payload.stderr || "");
  const status = running ? "Running" : payload.cancelled ? "Cancelled" : ok ? "Completed" : "Failed";
  const symbol = running ? "…" : ok ? "✓" : "!";
  const exitCode = payload.exitCode == null ? "—" : payload.exitCode;
  const cwd = basename(payload.cwd) || "—";
  const taskId = payload.taskId || "";

  root.innerHTML = `<main class="shell">
    <section class="card" aria-label="Command result" tabindex="0">
      <header class="topbar">
        <div class="status ${running ? "pending" : ok ? "success" : "failure"}"><span class="status-icon">${symbol}</span>${esc(status)}</div>
        <div class="meta"><span>${esc(formatDuration(payload.durationMs))}</span>${taskId ? `<span title="${esc(taskId)}">task ${esc(taskId)}</span>` : ""}${running ? "" : `<span>exit ${esc(exitCode)}</span>`}<span title="${esc(payload.cwd || cwd)}">${esc(cwd)}</span></div>
      </header>
      <div class="terminal">
        <div class="prompt"><span class="prompt-mark">$</span><code>${esc(payload.command || "")}</code></div>
        ${stderr ? `<pre class="stream stderr">${esc(stderr)}</pre>` : ""}
        ${stdout ? `<pre class="stream stdout">${esc(stdout)}</pre>` : ""}
        ${!stdout && !stderr ? '<div class="no-output">Command produced no output.</div>' : ""}
      </div>
    </section>
  </main>`;
}

window.addEventListener("openai:set_globals", () => {
  if (!payload && syncChatGptToolInput()) render();
});

render();
app.connect().catch(() => {});
