import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, ensureStateDirs, readConversationStateByKey } from "./config.js";
import { conversationIdFromBody, conversationKey } from "./conversation.js";

const BINDINGS_FILE = path.join(STATE_DIR, "browser-thread-bindings.json");
const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const BINDINGS_VERSION = 2;
const RECENT_BIND_WINDOW_MS = 15_000;
const BIND_INTENT_WINDOW_MS = 120_000;
const BIND_CLOCK_TOLERANCE_MS = 1_500;
const MAX_RECENT_WEB_CONVERSATIONS = 32;
const MAX_PENDING_BROWSER_INTENTS = 32;
const BROWSER_BIND_TOKEN_TTL_MS = 120_000;
const MAX_BROWSER_BIND_TOKENS = 64;
const THREAD_ID_RE = /^[A-Za-z0-9_-]{8,160}$/;
const CONVERSATION_KEY_RE = /^[a-f0-9]{64}$/;
const VALID_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

let recentWebConversations = [];
let pendingBrowserIntents = new Map();
let browserBindingTokens = new Map();

export function registerLocalTodoRoutes(app) {
  app.post("/local-ui/todos", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const result = resolveBrowserThreadTodos(req.body?.threadId);
      return res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/local-ui/thread-bind", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const result = bindBrowserThreadToRecentConversation(req.body?.threadId, {
        sentAt: req.body?.sentAt,
      });
      return res.set("Cache-Control", "no-store").json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/local-ui/thread-bind-intent", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const result = registerBrowserThreadIntent(req.body?.threadId, {
        sentAt: req.body?.sentAt,
      });
      return res.set("Cache-Control", "no-store").json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/local-ui/thread-bind-observed", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const result = bindBrowserThreadToObservedConversation(req.body?.threadId, req.body?.conversationId);
      return res.set("Cache-Control", "no-store").json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/local-ui/thread-bind-token", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const result = bindBrowserThreadWithToken(req.body?.threadId, req.body?.token);
      return res.set("Cache-Control", "no-store").json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function bindBrowserThreadToObservedConversation(threadId, conversationId, { now = Date.now() } = {}) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (typeof conversationId !== "string" || !conversationId.trim() || conversationId.length > 512) {
    throw new Error("conversationId is required");
  }

  const nextConversationKey = conversationKey(conversationId.trim());
  recentWebConversations = recentWebConversations.filter((item) => item && now - item.at <= BIND_INTENT_WINDOW_MS);
  const observed = recentWebConversations.some((item) => item.conversationKey === nextConversationKey);
  if (!observed) return { bound: false, observed: false };

  return bindBrowserThreadToConversationKey(normalizedThreadId, nextConversationKey, {
    now,
    source: "browser-mcp-observed",
  });
}

export function issueBrowserBindingToken(conversationId, { now = Date.now() } = {}) {
  if (typeof conversationId !== "string" || !conversationId.trim()) return null;
  pruneBrowserBindingTokens(now);
  const token = crypto.randomBytes(24).toString("base64url");
  browserBindingTokens.set(token, {
    conversationKey: conversationKey(conversationId.trim()),
    expiresAt: now + BROWSER_BIND_TOKEN_TTL_MS,
    boundThreadKey: null,
  });
  while (browserBindingTokens.size > MAX_BROWSER_BIND_TOKENS) {
    browserBindingTokens.delete(browserBindingTokens.keys().next().value);
  }
  return token;
}

export function bindBrowserThreadWithToken(threadId, token, { now = Date.now() } = {}) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{24,128}$/.test(token)) {
    throw new Error("invalid browser binding token");
  }
  pruneBrowserBindingTokens(now);
  const entry = browserBindingTokens.get(token);
  if (!entry) return { bound: false, expired: true };

  const threadKey = sha256(normalizedThreadId);
  if (entry.boundThreadKey && entry.boundThreadKey !== threadKey) {
    return { bound: false, conflict: true, reason: "token-already-bound" };
  }

  const result = bindBrowserThreadToConversationKey(normalizedThreadId, entry.conversationKey, {
    now,
    source: "browser-binding-token",
  });
  if (result.bound) entry.boundThreadKey = threadKey;
  return result;
}

function bindBrowserThreadToConversationKey(threadId, nextConversationKey, { now = Date.now(), source } = {}) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!CONVERSATION_KEY_RE.test(String(nextConversationKey || ""))) throw new Error("invalid conversation key");

  const threadKey = sha256(normalizedThreadId);
  const bindings = readBindings();
  const existing = bindings[threadKey] || null;
  if (existing && existing.conversationKey === nextConversationKey) {
    const state = readConversationStateByKey(nextConversationKey);
    return { bound: true, unchanged: true, updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : null };
  }

  const owner = Object.entries(bindings).find(([key, value]) => key !== threadKey && value?.conversationKey === nextConversationKey);
  if (owner) return { bound: false, conflict: true, reason: "conversation-already-bound" };

  bindings[threadKey] = {
    conversationKey: nextConversationKey,
    boundAt: new Date(now).toISOString(),
    source: source || "explicit-conversation-binding",
  };
  writeBindings(bindings);
  pendingBrowserIntents.delete(threadKey);
  recentWebConversations = recentWebConversations.filter((item) => item.conversationKey !== nextConversationKey);

  const state = readConversationStateByKey(nextConversationKey);
  return { bound: true, updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : null };
}

function pruneBrowserBindingTokens(now = Date.now()) {
  for (const [token, entry] of browserBindingTokens) {
    if (!entry || entry.expiresAt <= now) browserBindingTokens.delete(token);
  }
}

export function recordRecentWebConversationFromBody(body, now = Date.now()) {
  const conversationId = conversationIdFromBody(body);
  if (!conversationId) return false;

  const meta = requestMetaFromBody(body);
  const userAgent = String(meta?.["openai/userAgent"] || "");
  if (!/Mozilla\//i.test(userAgent)) return false;

  const entry = {
    conversationKey: conversationKey(conversationId),
    at: now,
  };
  recentWebConversations = recentWebConversations
    .filter((item) => item && now - item.at <= BIND_INTENT_WINDOW_MS)
    .filter((item) => !(item.conversationKey === entry.conversationKey && item.at === entry.at));
  recentWebConversations.push(entry);
  if (recentWebConversations.length > MAX_RECENT_WEB_CONVERSATIONS) {
    recentWebConversations = recentWebConversations.slice(-MAX_RECENT_WEB_CONVERSATIONS);
  }
  attemptPendingBrowserIntentBinding(now);
  return true;
}

export function registerBrowserThreadIntent(threadId, { sentAt, now = Date.now() } = {}) {
  const normalizedThreadId = normalizeThreadId(threadId);
  const normalizedSentAt = Number(sentAt);
  if (!Number.isFinite(normalizedSentAt) || normalizedSentAt <= 0) {
    throw new Error("sentAt is required");
  }
  if (normalizedSentAt > now + BIND_CLOCK_TOLERANCE_MS || now - normalizedSentAt > BIND_INTENT_WINDOW_MS) {
    return { registered: false, bound: false, expired: true };
  }

  const threadKey = sha256(normalizedThreadId);
  const bindings = readBindings();
  const existing = bindings[threadKey] || null;
  if (existing && CONVERSATION_KEY_RE.test(String(existing.conversationKey || ""))) {
    return { registered: false, bound: true };
  }

  prunePendingBrowserIntents(now);
  pendingBrowserIntents.delete(threadKey);
  pendingBrowserIntents.set(threadKey, {
    threadId: normalizedThreadId,
    threadKey,
    sentAt: normalizedSentAt,
    registeredAt: now,
  });
  while (pendingBrowserIntents.size > MAX_PENDING_BROWSER_INTENTS) {
    pendingBrowserIntents.delete(pendingBrowserIntents.keys().next().value);
  }

  const result = attemptPendingBrowserIntentBinding(now);
  if (result?.threadKey === threadKey && result.bound) {
    return { registered: true, bound: true };
  }
  return { registered: true, bound: false, ambiguous: result?.ambiguous === true };
}

function attemptPendingBrowserIntentBinding(now = Date.now()) {
  prunePendingBrowserIntents(now);
  if (!pendingBrowserIntents.size || !recentWebConversations.length) return null;

  const bindings = readBindings();
  const ownedConversationKeys = new Set(
    Object.values(bindings)
      .map((value) => value?.conversationKey)
      .filter((value) => CONVERSATION_KEY_RE.test(String(value || ""))),
  );

  recentWebConversations = recentWebConversations.filter((item) => (
    item && now - item.at <= BIND_INTENT_WINDOW_MS && !ownedConversationKeys.has(item.conversationKey)
  ));

  const intents = [...pendingBrowserIntents.values()].filter((intent) => !bindings[intent.threadKey]);
  const conversations = new Map();
  for (const item of recentWebConversations) {
    const previous = conversations.get(item.conversationKey);
    if (!previous || item.at > previous.at) conversations.set(item.conversationKey, item);
  }

  const matches = [];
  for (const intent of intents) {
    for (const conversation of conversations.values()) {
      if (conversation.at + BIND_CLOCK_TOLERANCE_MS < intent.sentAt) continue;
      if (conversation.at - intent.sentAt > BIND_INTENT_WINDOW_MS) continue;
      matches.push({ intent, conversation });
    }
  }

  const candidateThreads = new Set(matches.map((match) => match.intent.threadKey));
  const candidateConversations = new Set(matches.map((match) => match.conversation.conversationKey));
  if (candidateThreads.size !== 1 || candidateConversations.size !== 1) {
    return matches.length ? { bound: false, ambiguous: true } : null;
  }

  const match = matches[0];
  const binding = {
    conversationKey: match.conversation.conversationKey,
    boundAt: new Date(now).toISOString(),
    source: "browser-send-mcp-match",
  };
  bindings[match.intent.threadKey] = binding;
  writeBindings(bindings);
  pendingBrowserIntents.delete(match.intent.threadKey);
  recentWebConversations = recentWebConversations.filter((item) => item.conversationKey !== binding.conversationKey);
  return { bound: true, threadKey: match.intent.threadKey, conversationKey: binding.conversationKey };
}

function prunePendingBrowserIntents(now) {
  for (const [key, intent] of pendingBrowserIntents) {
    if (!intent || now - intent.sentAt > BIND_INTENT_WINDOW_MS) pendingBrowserIntents.delete(key);
  }
}

export function resolveBrowserThreadTodos(threadId) {
  const resolved = resolveBrowserThreadState(threadId);
  if (!resolved.bound) {
    return { ok: true, bound: false, todos: [], updatedAt: null };
  }

  return {
    ok: true,
    bound: true,
    todos: normalizeTodos(resolved.state?.todos),
    updatedAt: typeof resolved.state?.updatedAt === "string" ? resolved.state.updatedAt : null,
  };
}

export function resolveBrowserThreadState(threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  const threadKey = sha256(normalizedThreadId);
  const bindings = readBindings();
  const binding = bindings[threadKey] || null;

  if (!binding || !CONVERSATION_KEY_RE.test(String(binding.conversationKey || ""))) {
    return { bound: false, state: null, conversationKey: null };
  }

  const state = readConversationStateByKey(binding.conversationKey);
  return { bound: true, state, conversationKey: binding.conversationKey };
}

export function bindBrowserThreadToRecentConversation(threadId, { sentAt, now = Date.now() } = {}) {
  const normalizedThreadId = normalizeThreadId(threadId);
  const normalizedSentAt = Number(sentAt);
  if (!Number.isFinite(normalizedSentAt) || normalizedSentAt <= 0) {
    throw new Error("sentAt is required");
  }
  if (normalizedSentAt > now + BIND_CLOCK_TOLERANCE_MS || now - normalizedSentAt > BIND_INTENT_WINDOW_MS) {
    return { bound: false, updatedAt: null };
  }

  const threadKey = sha256(normalizedThreadId);
  const bindings = readBindings();
  const existing = bindings[threadKey] || null;
  if (existing && CONVERSATION_KEY_RE.test(String(existing.conversationKey || ""))) {
    const state = readConversationStateByKey(existing.conversationKey);
    return {
      bound: true,
      updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : null,
    };
  }

  const plausible = recentWebConversations.filter((item) => (
    item
    && now - item.at <= RECENT_BIND_WINDOW_MS
    && item.at + BIND_CLOCK_TOLERANCE_MS >= normalizedSentAt
  ));
  if (!plausible.length) return { bound: false, updatedAt: null };

  const ownedConversationKeys = new Set(
    Object.entries(bindings)
      .filter(([key, value]) => key !== threadKey && CONVERSATION_KEY_RE.test(String(value?.conversationKey || "")))
      .map(([, value]) => value.conversationKey),
  );
  const candidates = new Map();
  for (const item of plausible) {
    if (ownedConversationKeys.has(item.conversationKey)) continue;
    const previous = candidates.get(item.conversationKey);
    if (!previous || item.at > previous.at) candidates.set(item.conversationKey, item);
  }

  if (!candidates.size) {
    return { bound: false, updatedAt: null, conflict: true };
  }
  if (candidates.size > 1) {
    return { bound: false, updatedAt: null, ambiguous: true };
  }

  const recent = candidates.values().next().value;

  const binding = {
    conversationKey: recent.conversationKey,
    boundAt: new Date(now).toISOString(),
    source: "explicit-local-system-use",
  };
  bindings[threadKey] = binding;
  writeBindings(bindings);
  recentWebConversations = recentWebConversations.filter((item) => item.conversationKey !== binding.conversationKey);

  const state = readConversationStateByKey(binding.conversationKey);
  return {
    bound: true,
    updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : null,
  };
}

function requestMetaFromBody(body) {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const meta = message?.params?._meta;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) return meta;
  }
  return null;
}

function normalizeThreadId(threadId) {
  if (typeof threadId !== "string") throw new Error("threadId is required");
  const normalized = threadId.trim();
  if (!THREAD_ID_RE.test(normalized)) throw new Error("invalid ChatGPT thread id");
  return normalized;
}

function normalizeTodos(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => typeof item.id === "string" && item.id.length > 0)
    .filter((item) => typeof item.content === "string" && item.content.length <= 200)
    .filter((item) => VALID_STATUSES.has(item.status))
    .map((item) => ({ id: item.id, content: item.content, status: item.status }));
}

function readBindings() {
  ensureStateDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(BINDINGS_FILE, "utf8"));
    if (parsed?.version !== BINDINGS_VERSION) return {};
    return parsed?.bindings && typeof parsed.bindings === "object" && !Array.isArray(parsed.bindings)
      ? { ...parsed.bindings }
      : {};
  } catch {
    return {};
  }
}

function writeBindings(bindings) {
  ensureStateDirs();
  const tmp = `${BINDINGS_FILE}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const body = `${JSON.stringify({ version: BINDINGS_VERSION, bindings }, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, BINDINGS_FILE);
  fs.chmodSync(BINDINGS_FILE, 0o600);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

