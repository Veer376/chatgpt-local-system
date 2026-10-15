import fs from "node:fs";
import path from "node:path";
import { ensureStateDirs, LOG_DIR } from "./config.js";

const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const LOG_FILE = path.join(LOG_DIR, "thread-performance.ndjson");
const MAX_LOG_BYTES = 8_000_000;
const KEEP_LOG_BYTES = 4_000_000;
const MAX_READ_SAMPLES = 1_000;

export function registerLocalThreadPerformanceRoutes(app) {
  app.post("/local-ui/thread-performance", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }
    try {
      const action = String(req.body?.action || "record").trim().toLowerCase();
      if (action === "record") {
        const sample = normalizeThreadPerformanceSample(req.body?.sample, {
          tabId: req.body?.tabId,
          windowId: req.body?.windowId,
        });
        appendThreadPerformanceSample(sample);
        return res.set("Cache-Control", "no-store").json({ ok: true });
      }
      if (action === "read") {
        const limit = normalizeLimit(req.body?.limit);
        const samples = readThreadPerformanceSamples(limit, req.body || {});
        return res.set("Cache-Control", "no-store").json({ ok: true, samples });
      }
      throw new Error("thread-performance action must be record or read");
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function normalizeThreadPerformanceSample(value, { tabId, windowId } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("thread performance sample is required");
  return {
    receivedAt: new Date().toISOString(),
    tabId: normalizeNullableInteger(tabId),
    windowId: normalizeNullableInteger(windowId),
    id: normalizeShortString(value.id, 160),
    at: normalizeShortString(value.at, 80),
    reason: normalizeShortString(value.reason, 80),
    sessionId: normalizeShortString(value.sessionId, 160),
    threadId: normalizeOptionalString(value.threadId, 160),
    path: normalizeOptionalString(value.path, 1_000),
    visibility: normalizeOptionalString(value.visibility, 40),
    memory: normalizeMemory(value.memory),
    domNodes: normalizeCount(value.domNodes),
    conversationTurns: normalizeCount(value.conversationTurns),
    messageRoles: normalizeCount(value.messageRoles),
    toolMessages: normalizeCount(value.toolMessages),
    iframes: normalizeCount(value.iframes),
    bodyTextChars: normalizeCount(value.bodyTextChars),
    persisted: value.persisted === true,
    clamp: normalizeJsonObject(value.clamp),
    navigation: normalizeJsonObject(value.navigation),
  };
}

function appendThreadPerformanceSample(sample) {
  ensureStateDirs();
  rotateLogIfNeeded();
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(sample)}\n`, { encoding: "utf8", mode: 0o600 });
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

function readThreadPerformanceSamples(limit, filters) {
  let text;
  try { text = fs.readFileSync(LOG_FILE, "utf8"); } catch { return []; }
  const tabId = normalizeNullableInteger(filters.tabId);
  const sessionId = normalizeOptionalString(filters.sessionId, 160);
  const threadId = normalizeOptionalString(filters.threadId, 160);
  return text.split("\n")
    .filter(Boolean)
    .slice(-MAX_READ_SAMPLES * 3)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter((sample) => tabId == null || sample.tabId === tabId)
    .filter((sample) => !sessionId || sample.sessionId === sessionId)
    .filter((sample) => !threadId || sample.threadId === threadId)
    .slice(-limit);
}

function normalizeLimit(value) {
  const number = Number(value ?? 200);
  return Number.isInteger(number) ? Math.min(Math.max(number, 1), MAX_READ_SAMPLES) : 200;
}

function normalizeNullableInteger(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function normalizeShortString(value, max) {
  const text = String(value || "").trim();
  if (!text) throw new Error("thread performance sample is missing required text");
  return text.slice(0, max);
}

function normalizeOptionalString(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function normalizeMemory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    usedJSHeapSize: normalizeCount(value.usedJSHeapSize),
    totalJSHeapSize: normalizeCount(value.totalJSHeapSize),
    jsHeapSizeLimit: normalizeCount(value.jsHeapSizeLimit),
  };
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value));
}
