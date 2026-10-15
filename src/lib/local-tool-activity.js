import { conversationKey } from "./conversation.js";
import { CONNECTOR_TOOL_CALL_EXPIRY_MS } from "./config.js";
import { resolveBrowserThreadState } from "./local-todos.js";
import { redact } from "./text.js";

const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const MAX_CONVERSATIONS = 48;
const MAX_CALLS_PER_CONVERSATION = 80;
const DEFAULT_PAGE_SIZE = 5;
const MAX_LIST_LIMIT = 20;
const MAX_ARGUMENT_DETAIL_CHARS = 18_000;
const MAX_RESULT_DETAIL_CHARS = 24_000;
const TURN_BOUNDARY_TOOL = "bridge_context";
const CURSOR_VERSION = 1;

const histories = new Map();

export function registerLocalToolActivityRoutes(app) {
  app.post("/local-ui/activity", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const resolved = resolveBrowserThreadState(req.body?.threadId);
      if (!resolved.bound) {
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          bound: false,
          calls: [],
          activeCount: 0,
          totalCount: 0,
          nextCursor: null,
          turn: null,
          bridgeActive: false,
          connectorExpiryMs: CONNECTOR_TOOL_CALL_EXPIRY_MS,
        });
      }

      const action = String(req.body?.action || "list").trim().toLowerCase();
      const status = bridgeActivityStatus(resolved.conversationKey);
      if (action === "status") {
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          bound: true,
          turn: latestTurnSummary(resolved.conversationKey),
          ...status,
        });
      }
      if (action === "list") {
        const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(req.body?.limit) || DEFAULT_PAGE_SIZE));
        const page = listToolActivityPage(resolved.conversationKey, {
          limit,
          cursor: req.body?.cursor,
        });
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          bound: true,
          ...page,
          ...status,
        });
      }
      return res.status(400).set("Cache-Control", "no-store").json({ error: "activity action must be status or list" });
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function recordToolQueued({ conversationId, requestId, tool, args, at = Date.now() }) {
  const history = historyForConversation(conversationId, true);
  if (!history) return;
  prepareTurn(history, { requestId, tool, at });
  const call = ensureCall(history, { requestId, tool, args, at });
  call.status = "queued";
  call.queuedAt = iso(at);
  call.updatedAt = iso(at);
  touch(history.key, history);
}

export function recordToolStarted({ conversationId, requestId, tool, args, at = Date.now() }) {
  const history = historyForConversation(conversationId, true);
  if (!history) return null;
  prepareTurn(history, { requestId, tool, at });
  const call = ensureCall(history, { requestId, tool, args, at });
  call.status = "running";
  call.startedAt = iso(at);
  call.updatedAt = iso(at);
  touch(history.key, history);
  return {
    turnId: call.turnId,
    turnStartedAt: call.turnStartedAt,
  };
}

export function recordToolCancelled({ conversationId, requestId, at = Date.now(), reason = "cancelled" }) {
  finishCall(conversationId, requestId, {
    status: "cancelled",
    at,
    error: String(reason || "cancelled"),
  });
}

export function recordToolCompleted({ conversationId, requestId, result, at = Date.now(), durationMs = null }) {
  finishCall(conversationId, requestId, {
    status: result?.isError ? "failed" : "completed",
    at,
    durationMs,
    result: summarizeResult(result),
  });
}

export function recordToolFailed({ conversationId, requestId, error, at = Date.now(), durationMs = null }) {
  finishCall(conversationId, requestId, {
    status: "failed",
    at,
    durationMs,
    error: boundedText(error instanceof Error ? error.message : String(error), 8_000),
  });
}

export function listToolActivity(key, limit = DEFAULT_PAGE_SIZE) {
  return listToolActivityPage(key, { limit }).calls;
}

export function listToolActivityPage(key, { limit = DEFAULT_PAGE_SIZE, cursor = null } = {}) {
  const history = histories.get(String(key || ""));
  if (!history?.currentTurnId) {
    return {
      calls: [],
      totalCount: 0,
      activeCount: 0,
      nextCursor: null,
      staleCursor: false,
      turn: null,
    };
  }

  const max = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || DEFAULT_PAGE_SIZE));
  const turnId = history.currentTurnId;
  const newest = latestTurnIds(history, turnId);
  const decoded = decodeCursor(cursor);
  let start = 0;
  let staleCursor = false;
  if (decoded) {
    if (decoded.turnId !== turnId) {
      staleCursor = true;
    } else {
      const anchorIndex = newest.indexOf(decoded.beforeId);
      if (anchorIndex < 0) staleCursor = true;
      else start = anchorIndex + 1;
    }
  }

  const pageIds = staleCursor ? [] : newest.slice(start, start + max);
  const calls = pageIds.flatMap((id) => {
    const call = history.calls.get(id);
    return call ? [publicCall(call)] : [];
  });
  const lastId = pageIds.at(-1) || null;
  const hasMore = !staleCursor && start + pageIds.length < newest.length;
  const activeCount = newest.reduce((count, id) => count + (isActiveCall(history.calls.get(id)) ? 1 : 0), 0);

  return {
    calls,
    totalCount: newest.length,
    activeCount,
    nextCursor: hasMore && lastId ? encodeCursor({ turnId, beforeId: lastId }) : null,
    staleCursor,
    turn: latestTurnSummary(key),
  };
}

export function toolActivityDetail(key, id) {
  if (!id) return null;
  const call = histories.get(String(key || ""))?.calls.get(String(id));
  return call ? clone(call) : null;
}

function latestTurnIds(history, turnId = history?.currentTurnId || "") {
  if (!history || !turnId) return [];
  return [...history.order].reverse().filter((id) => history.calls.get(id)?.turnId === turnId);
}

function publicCall(call) {
  return {
    id: call.id,
    tool: call.tool,
    status: call.status,
    arguments: clone(call.arguments),
    ...(Number.isFinite(Number(call.durationMs))
      ? { durationMs: Math.max(0, Math.round(Number(call.durationMs))) }
      : {}),
    ...(call.result !== undefined ? { result: clone(call.result) } : {}),
    ...(call.error ? { error: boundedText(call.error, 8_000) } : {}),
    // One timestamp plus the compact duration is enough for the activity row.
    // Turn-level timing still owns start/end presentation.
    updatedAt: call.updatedAt || call.finishedAt || call.startedAt || call.createdAt,
  };
}

function isActiveCall(call) {
  return call?.status === "queued" || call?.status === "running";
}

function encodeCursor({ turnId, beforeId }) {
  if (!turnId || !beforeId) return null;
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, turnId, beforeId }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed?.v !== CURSOR_VERSION
      || typeof parsed.turnId !== "string"
      || !parsed.turnId
      || typeof parsed.beforeId !== "string"
      || !parsed.beforeId
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function bridgeActivityStatus(key, now = Date.now()) {
  const history = histories.get(String(key || ""));
  if (!history) {
    return {
      bridgeActive: false,
      lastBridgeAt: null,
      lastToolAt: null,
      connectorExpiryMs: CONNECTOR_TOOL_CALL_EXPIRY_MS,
    };
  }
  let lastBridgeAt = null;
  let lastToolAt = null;
  let hasActiveCall = false;
  for (let index = history.order.length - 1; index >= 0; index -= 1) {
    const call = history.calls.get(history.order[index]);
    if (!call) continue;
    if (call.turnId === history.currentTurnId && isActiveCall(call)) hasActiveCall = true;
    const timestamp = call.updatedAt || call.finishedAt || call.startedAt || call.createdAt || null;
    if (!lastToolAt && timestamp) lastToolAt = timestamp;
    if (!lastBridgeAt && call.tool === TURN_BOUNDARY_TOOL && timestamp) lastBridgeAt = timestamp;
    if (lastToolAt && lastBridgeAt && hasActiveCall) break;
  }
  const bridgeAgeMs = lastBridgeAt ? Math.max(0, now - Date.parse(lastBridgeAt)) : null;
  const toolAgeMs = lastToolAt ? Math.max(0, now - Date.parse(lastToolAt)) : null;
  return {
    bridgeActive: hasActiveCall || (toolAgeMs != null && toolAgeMs < CONNECTOR_TOOL_CALL_EXPIRY_MS),
    lastBridgeAt,
    lastToolAt,
    bridgeAgeMs,
    toolAgeMs,
    connectorExpiryMs: CONNECTOR_TOOL_CALL_EXPIRY_MS,
  };
}

export function clearToolActivityForTests() {
  histories.clear();
}

function finishCall(conversationId, requestId, { status, at, durationMs, result, error }) {
  const history = historyForConversation(conversationId, false);
  if (!history) return;
  const call = history.calls.get(String(requestId || ""));
  if (!call) return;
  call.status = status;
  call.finishedAt = iso(at);
  call.updatedAt = iso(at);
  if (Number.isFinite(Number(durationMs))) call.durationMs = Math.max(0, Math.round(Number(durationMs)));
  else if (call.startedAt) call.durationMs = Math.max(0, at - Date.parse(call.startedAt));
  if (result !== undefined) call.result = result;
  if (error) call.error = boundedText(error, 8_000);
  touch(history.key, history);
}

function historyForConversation(conversationId, create) {
  if (typeof conversationId !== "string" || !conversationId.trim()) return null;
  const key = conversationKey(conversationId.trim());
  let history = histories.get(key);
  if (!history && create) {
    history = {
      key,
      calls: new Map(),
      order: [],
      touchedAt: Date.now(),
      turnSequence: 0,
      currentTurnId: "",
      currentTurnStartedAt: null,
    };
    histories.set(key, history);
    pruneHistories();
  }
  return history || null;
}

function ensureCall(history, { requestId, tool, args, at }) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("tool activity request id is required");
  let call = history.calls.get(id);
  if (!call) {
    call = {
      id,
      tool: String(tool || "tool"),
      status: "running",
      createdAt: iso(at),
      updatedAt: iso(at),
      turnId: history.currentTurnId || startTurn(history, at),
      turnStartedAt: history.currentTurnStartedAt || iso(at),
      arguments: boundedSnapshot(args || {}, MAX_ARGUMENT_DETAIL_CHARS),
    };
    history.calls.set(id, call);
    history.order.push(id);
    while (history.order.length > MAX_CALLS_PER_CONVERSATION) {
      history.calls.delete(history.order.shift());
    }
  }
  return call;
}

function prepareTurn(history, { requestId, tool, at }) {
  const id = String(requestId || "").trim();
  if (id && history.calls.has(id)) return;
  if (!history.currentTurnId || String(tool || "") === TURN_BOUNDARY_TOOL) startTurn(history, at);
}

function startTurn(history, at) {
  history.turnSequence = Math.max(0, Number(history.turnSequence) || 0) + 1;
  history.currentTurnId = `turn_${history.turnSequence}_${Math.max(0, Math.round(Number(at) || Date.now()))}`;
  history.currentTurnStartedAt = iso(at);
  return history.currentTurnId;
}

function latestTurnSummary(key, now = Date.now()) {
  const history = histories.get(String(key || ""));
  if (!history?.currentTurnId) return null;
  const ids = latestTurnIds(history);
  const calls = ids.map((id) => history.calls.get(id)).filter(Boolean);
  const activeCount = calls.filter(isActiveCall).length;
  const startedAt = history.currentTurnStartedAt || calls.at(-1)?.createdAt || null;
  const latestTimestamp = calls.reduce((latest, call) => {
    const candidate = call.finishedAt || call.updatedAt || call.startedAt || call.createdAt || null;
    if (!candidate) return latest;
    const candidateMs = Date.parse(candidate);
    const latestMs = latest ? Date.parse(latest) : Number.NEGATIVE_INFINITY;
    return Number.isFinite(candidateMs) && candidateMs > latestMs ? candidate : latest;
  }, startedAt);
  const endedAt = activeCount > 0 ? null : latestTimestamp;
  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  const endMs = endedAt ? Date.parse(endedAt) : Number(now);
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round(endMs - startMs))
    : null;
  return {
    id: history.currentTurnId,
    startedAt,
    endedAt,
    durationMs,
    toolCount: calls.length,
    activeCount,
    active: activeCount > 0,
  };
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") return boundedSnapshot(result, MAX_RESULT_DETAIL_CHARS);
  const content = Array.isArray(result.content) ? result.content.slice(0, 12).map((item) => {
    if (!item || typeof item !== "object") return item;
    if (item.type === "text") return { type: "text", text: boundedText(redact(item.text || ""), 6_000) };
    if (item.type === "image" || item.type === "audio") {
      return {
        type: item.type,
        mimeType: String(item.mimeType || "application/octet-stream"),
        encodedChars: typeof item.data === "string" ? item.data.length : 0,
      };
    }
    if (item.type === "resource") {
      return {
        type: "resource",
        resource: boundedSnapshot(item.resource || {}, 6_000),
      };
    }
    return boundedSnapshot(item, 4_000);
  }) : [];
  return boundedSnapshot({
    isError: Boolean(result.isError),
    content,
    ...(result.structuredContent !== undefined
      ? { structuredContent: boundedSnapshot(result.structuredContent, 12_000) }
      : {}),
  }, MAX_RESULT_DETAIL_CHARS);
}

function boundedSnapshot(value, maxChars) {
  const safe = redact(value);
  try {
    const serialized = JSON.stringify(safe);
    if (serialized.length <= maxChars) return clone(safe);
    return { truncated: true, preview: serialized.slice(0, maxChars) };
  } catch {
    return { truncated: true, preview: boundedText(String(safe), maxChars) };
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function boundedText(value, maxChars) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… [truncated]`;
}

function iso(value) {
  return new Date(Number(value) || Date.now()).toISOString();
}

function touch(key, history) {
  history.touchedAt = Date.now();
  histories.delete(key);
  histories.set(key, history);
}

function pruneHistories() {
  while (histories.size > MAX_CONVERSATIONS) histories.delete(histories.keys().next().value);
}
