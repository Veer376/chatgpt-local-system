import fs from "node:fs";
import path from "node:path";
import { ensureStateDirs, LOG_DIR } from "./config.js";

const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const LOG_FILE = path.join(LOG_DIR, "workspace-trace.ndjson");
const MAX_LOG_BYTES = 4_000_000;
const KEEP_LOG_BYTES = 2_000_000;
const MAX_READ_EVENTS = 1_000;

export function registerLocalWorkspaceTraceRoutes(app) {
  app.post("/local-ui/workspace-trace", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }
    try {
      const action = String(req.body?.action || "record").trim().toLowerCase();
      if (action === "record") {
        appendTraceEvent(normalizeTraceEvent(req.body?.event));
        return res.set("Cache-Control", "no-store").json({ ok: true });
      }
      if (action === "read") {
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          events: readTraceEvents(req.body?.limit, req.body?.threadId),
        });
      }
      if (action === "clear") {
        ensureStateDirs();
        fs.writeFileSync(LOG_FILE, "", { encoding: "utf8", mode: 0o600 });
        return res.set("Cache-Control", "no-store").json({ ok: true });
      }
      throw new Error("workspace-trace action must be record, read, or clear");
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function recordWorkspaceTrace(event) {
  appendTraceEvent(normalizeTraceEvent(event));
}

function normalizeTraceEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace trace event is required");
  const stage = String(value.stage || "").trim();
  if (!stage) throw new Error("workspace trace event stage is required");
  return {
    at: new Date().toISOString(),
    stage: stage.slice(0, 160),
    threadId: optionalString(value.threadId, 180),
    path: optionalString(value.path, 2_000),
    data: normalizeJson(value.data),
  };
}

function appendTraceEvent(event) {
  ensureStateDirs();
  rotateLogIfNeeded();
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readTraceEvents(limitValue, threadIdValue) {
  let text;
  try { text = fs.readFileSync(LOG_FILE, "utf8"); } catch { return []; }
  const limit = Number.isInteger(Number(limitValue)) ? Math.min(Math.max(Number(limitValue), 1), MAX_READ_EVENTS) : 200;
  const threadId = optionalString(threadIdValue, 180);
  return text.split("\n")
    .filter(Boolean)
    .slice(-MAX_READ_EVENTS * 3)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter((event) => !threadId || event.threadId === threadId)
    .slice(-limit);
}

function rotateLogIfNeeded() {
  let size = 0;
  try { size = fs.statSync(LOG_FILE).size; } catch { return; }
  if (size <= MAX_LOG_BYTES) return;
  const start = Math.max(0, size - KEEP_LOG_BYTES);
  const fd = fs.openSync(LOG_FILE, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const newline = text.indexOf("\n");
    fs.writeFileSync(LOG_FILE, newline >= 0 ? text.slice(newline + 1) : text, { encoding: "utf8", mode: 0o600 });
  } finally {
    fs.closeSync(fd);
  }
}

function optionalString(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function normalizeJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}
