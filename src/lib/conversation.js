import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { loadState } from "./config.js";

// Clients that identify a conversation do it through request `_meta`. ChatGPT
// sends `openai/session`; Codex sends `threadId`. Other MCP clients may send
// standard identifiers like `sessionId` or `conversation_id`.
const CONVERSATION_META_KEYS = [
  "openai/session",
  "threadId",
  "sessionId",
  "conversation_id",
  "session_id",
  "chat_id",
];

const storage = new AsyncLocalStorage();

export function conversationDescriptorFromMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  for (const key of CONVERSATION_META_KEYS) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) {
      return {
        id: value.trim(),
        metaKey: key,
        isOpenAi: key === "openai/session",
      };
    }
  }
  return null;
}

export function conversationDescriptorFromBody(body) {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const desc = conversationDescriptorFromMeta(message?.params?._meta);
    if (desc) return desc;
  }
  return null;
}

export function conversationDescriptorFromRequest(req) {
  if (!req || typeof req !== "object") return null;

  // 1. Body _meta (ChatGPT, Codex, extended keys)
  const fromBody = conversationDescriptorFromBody(req.body);
  if (fromBody) return fromBody;

  // 2. Request headers (Claude Desktop, custom reverse proxy, client config)
  const headers = req.headers;
  if (headers && typeof headers === "object") {
    const fromHeader = headers["x-conversation-id"]
      || headers["x-session-id"]
      || headers["mcp-session-id"];
    if (typeof fromHeader === "string" && fromHeader.trim()) {
      return { id: fromHeader.trim(), metaKey: "header", isOpenAi: false };
    }
  }

  // 3. URL query parameters (/mcp?sessionId=... or /mcp?conversationId=...)
  const query = req.query;
  if (query && typeof query === "object") {
    const fromQuery = query.sessionId || query.conversationId || query.session_id;
    if (typeof fromQuery === "string" && fromQuery.trim()) {
      return { id: fromQuery.trim(), metaKey: "query", isOpenAi: false };
    }
  }

  return null;
}

export function conversationIdFromMeta(meta) {
  return conversationDescriptorFromMeta(meta)?.id ?? null;
}

export function conversationIdFromBody(body) {
  return conversationDescriptorFromBody(body)?.id ?? null;
}

export function conversationIdFromRequest(req) {
  return conversationDescriptorFromRequest(req)?.id ?? null;
}

export function runWithConversationContext({ conversationId, isOpenAi = false } = {}, fn) {
  if (typeof conversationId !== "string" || !conversationId.trim()) return fn();
  return storage.run({
    conversationId: conversationId.trim(),
    isOpenAi: Boolean(isOpenAi),
  }, fn);
}

export function runWithConversationId(conversationId, fn, { isOpenAi = false } = {}) {
  return runWithConversationContext({ conversationId, isOpenAi }, fn);
}

export function runWithConversation(reqOrBody, fn) {
  const desc = reqOrBody && (reqOrBody.body !== undefined || reqOrBody.headers !== undefined || reqOrBody.query !== undefined)
    ? conversationDescriptorFromRequest(reqOrBody)
    : conversationDescriptorFromBody(reqOrBody);
  return runWithConversationContext({
    conversationId: desc?.id,
    isOpenAi: desc?.isOpenAi ?? false,
  }, fn);
}

export function currentConversationId() {
  return storage.getStore()?.conversationId ?? null;
}

export function isOpenAiConversation() {
  return Boolean(storage.getStore()?.isOpenAi);
}

// Conversation ids are opaque, client-supplied, and contain characters that are
// unsafe in a path (real ChatGPT ids look like `v1/2U25...`). Hashing yields a
// fixed-length, traversal-proof filename and keeps the raw id out of state
// filenames and audit records.
export function conversationKey(conversationId) {
  return crypto.createHash("sha256").update(String(conversationId)).digest("hex");
}

export function shortConversationKey(conversationId) {
  return conversationKey(conversationId).slice(0, 12);
}

/**
 * Resolves the active persistence scope using the 3-tier hierarchy:
 * Tier 1: Explicit conversation ID (ChatGPT / Codex threads)
 * Tier 2: Active project workspace (Claude / single-thread project scope)
 * Tier 3: Global fallback (pre-workspace / general environment)
 *
 * @param {Object} [options]
 * @param {string|null} [options.conversationId] Explicit conversation ID override
 * @param {string|null} [options.workspace] Explicit workspace path override
 * @returns {{ type: "conversation" | "project" | "global", id: string, key: string, workspace?: string }}
 */
export function resolveActiveScopeKey({ conversationId = currentConversationId(), workspace } = {}) {
  // Tier 1: Explicit conversation ID
  if (typeof conversationId === "string" && conversationId.trim()) {
    const id = conversationId.trim();
    return {
      type: "conversation",
      id,
      key: conversationKey(id),
    };
  }

  // Tier 2: Active project workspace scope
  const resolvedWorkspace = workspace !== undefined
    ? (typeof workspace === "string" ? workspace.trim() : "")
    : (loadState()?.currentWorkspace || "");

  if (resolvedWorkspace) {
    const id = `project:${resolvedWorkspace}`;
    return {
      type: "project",
      id,
      key: conversationKey(id),
      workspace: resolvedWorkspace,
    };
  }

  // Tier 3: Global fallback
  const fallbackId = process.env.LOCAL_SYSTEM_CONVERSATION_ID || "global";
  return {
    type: "global",
    id: fallbackId,
    key: conversationKey(fallbackId),
  };
}

export function activeScopeKey(options) {
  return resolveActiveScopeKey(options).key;
}
