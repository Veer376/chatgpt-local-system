import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUDIT_FILE, MAX_CONCURRENT_TOOLS, ensureStateDirs } from "./config.js";
import { nowIso, redact } from "./text.js";
import { currentConversationId, shortConversationKey } from "./conversation.js";
import {
  recordToolCancelled,
  recordToolCompleted,
  recordToolFailed,
  recordToolQueued,
  recordToolStarted,
} from "./local-tool-activity.js";
import { appendTurnCheckpoint, beginTurnCheckpoint } from "./turn-checkpoint.js";

const MAX_AUDIT_BYTES = 10 * 1024 * 1024;
let lastHash;
let activeTools = 0;
let activeControlTools = 0;
const toolQueue = [];
const controlQueue = [];
const CONTROL_TOOL_NAMES = new Set(["subagents", "manage_task", "bridge_context", "request_user_input"]);
const RESERVED_CONTROL_SLOTS = Math.min(2, Math.max(0, MAX_CONCURRENT_TOOLS - 1));
const MAX_NORMAL_TOOLS = Math.max(1, MAX_CONCURRENT_TOOLS - RESERVED_CONTROL_SLOTS);
const MAX_CONTROL_TOOLS = Math.max(1, Math.min(4, MAX_CONCURRENT_TOOLS));

function queueFor(name) {
  return CONTROL_TOOL_NAMES.has(name) ? controlQueue : toolQueue;
}

function hasCapacity(name) {
  const total = activeTools + activeControlTools;
  if (total >= MAX_CONCURRENT_TOOLS) return false;
  return CONTROL_TOOL_NAMES.has(name)
    ? activeControlTools < MAX_CONTROL_TOOLS
    : activeTools < MAX_NORMAL_TOOLS;
}

function occupy(name) {
  if (CONTROL_TOOL_NAMES.has(name)) activeControlTools += 1;
  else activeTools += 1;
}

function drainQueue(name) {
  const queue = queueFor(name);
  while (queue.length && hasCapacity(name)) {
    const waiter = queue.shift();
    if (waiter.signal?.aborted) {
      waiter.cleanup();
      waiter.resolve(false);
      continue;
    }
    occupy(name);
    waiter.cleanup();
    waiter.resolve(true);
  }
}

function releaseSlot(name) {
  if (CONTROL_TOOL_NAMES.has(name)) activeControlTools = Math.max(0, activeControlTools - 1);
  else activeTools = Math.max(0, activeTools - 1);
  // Always service the reserved control lane first, then use any remaining
  // capacity for ordinary worker calls.
  drainQueue("subagents");
  drainQueue("ordinary");
}

function acquireSlot(name, signal) {
  if (hasCapacity(name)) {
    occupy(name);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const queue = queueFor(name);
    const waiter = {
      signal,
      resolve,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    };
    const onAbort = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      waiter.cleanup();
      resolve(false);
    };
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(waiter);
  });
}

export function instrumentServer(server) {
  const original = server.registerTool.bind(server);
  server.registerTool = (name, definition, handler) => original(name, definition, async (args, extra) => {
    const requestId = `req_${crypto.randomBytes(8).toString("hex")}`;
    const activeConversation = currentConversationId();
    const conversation = activeConversation ? shortConversationKey(activeConversation) : null;
    const queued = !hasCapacity(name);
    if (queued) {
      recordToolQueued({ conversationId: activeConversation, requestId, tool: name, args });
      auditEvent("tool.queued", {
        requestId,
        conversation,
        tool: name,
        activeTools,
        activeControlTools,
      });
    }
    const acquired = await acquireSlot(name, extra?.signal);
    if (!acquired) {
      recordToolCancelled({ conversationId: activeConversation, requestId, reason: "cancelled while queued" });
      auditEvent("tool.queue_cancelled", { requestId, conversation, tool: name });
      return { content: [{ type: "text", text: "tool call cancelled while waiting for Local System capacity" }], isError: true };
    }
    const started = Date.now();
    if (name === "bridge_context") beginTurnCheckpoint(activeConversation, started);
    recordToolStarted({ conversationId: activeConversation, requestId, tool: name, args, at: started });
    auditEvent("tool.started", { requestId, conversation, tool: name, args: redact(args || {}) });
    try {
      const result = await handler(args, extra);
      recordToolCompleted({
        conversationId: activeConversation,
        requestId,
        result,
        at: Date.now(),
        durationMs: Date.now() - started,
      });
      auditEvent("tool.completed", {
        requestId,
        conversation,
        tool: name,
        durationMs: Date.now() - started,
        isError: Boolean(result?.isError),
        outputChars: outputLength(result),
      });
      const finalResult = appendTurnCheckpoint(result, {
        conversationId: activeConversation,
        tool: name,
        at: Date.now(),
      });
      if (finalResult !== result) {
        auditEvent("turn.checkpoint_delivered", {
          conversation,
          tool: name,
        });
      }
      return finalResult;
    } catch (error) {
      recordToolFailed({
        conversationId: activeConversation,
        requestId,
        error,
        at: Date.now(),
        durationMs: Date.now() - started,
      });
      auditEvent("tool.failed", {
        requestId,
        conversation,
        tool: name,
        durationMs: Date.now() - started,
        error: redact(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    } finally {
      releaseSlot(name);
    }
  });
  return server;
}

export function auditEvent(event, data = {}) {
  try {
    ensureStateDirs();
    rotateIfNeeded();
    if (lastHash === undefined) lastHash = readLastHash();
    const payload = { at: nowIso(), pid: process.pid, event, ...redact(data), previousHash: lastHash || null };
    const hash = crypto.createHash("sha256").update(`${lastHash || ""}\n${JSON.stringify(payload)}`).digest("hex");
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ ...payload, hash })}\n`, { encoding: "utf8", mode: 0o600 });
    lastHash = hash;
    return true;
  } catch (error) {
    process.stderr.write(`[audit] ${error.message}\n`);
    return false;
  }
}

function outputLength(result) {
  return (result?.content || []).reduce((total, item) => total + (typeof item?.text === "string" ? item.text.length : 0), 0);
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(AUDIT_FILE);
    if (stat.size < MAX_AUDIT_BYTES) return;
    const rotated = path.join(path.dirname(AUDIT_FILE), `bridge-${Date.now()}.jsonl`);
    fs.renameSync(AUDIT_FILE, rotated);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function readLastHash() {
  try {
    const stat = fs.statSync(AUDIT_FILE);
    const bytes = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(AUDIT_FILE, "r");
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
    fs.closeSync(fd);
    const line = buffer.toString("utf8").trim().split(/\r?\n/).at(-1);
    return line ? JSON.parse(line).hash || "" : "";
  } catch {
    return "";
  }
}
