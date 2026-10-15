import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  APP_NAME,
  APP_VERSION,
  BODY_LIMIT,
  BYPASS_SECURITY,
  HOST,
  MCP_TOKEN,
  PORT,
  ensureStateDirs,
  isLoopbackHost,
  validateRuntimeConfig,
} from "./lib/config.js";
import { auditEvent, instrumentServer } from "./lib/audit.js";
import { runWithConversation } from "./lib/conversation.js";
import { registerLocalAnnotationRoutes } from "./lib/local-annotations.js";
import { registerLocalFileWorkspaceRoutes } from "./lib/local-file-workspace.js";
import { registerLocalFileRoutes } from "./lib/local-files.js";
import { registerLocalImageRoutes } from "./lib/local-images.js";
import { registerLocalInteractionRoutes } from "./lib/local-interactions.js";
import { registerLocalGitRoutes } from "./lib/local-git.js";
import { registerLocalSkillRoutes } from "./lib/local-skills.js";
import { registerLocalThreadPerformanceRoutes } from "./lib/local-thread-performance.js";
import { registerLocalToolActivityRoutes } from "./lib/local-tool-activity.js";
import { registerLocalTurnCheckpointRoutes } from "./lib/local-turn-checkpoint.js";
import { registerLocalWorkspaceTraceRoutes } from "./lib/local-workspace-trace.js";
import { recordRecentWebConversationFromBody, registerLocalTodoRoutes } from "./lib/local-todos.js";
import { httpUrl, normalizeHost } from "./lib/net.js";
import { platformSummary } from "./platform/index.js";
import { EXPECTED_TOOL_NAMES } from "./tool-contract.js";
import { registerFiles } from "./tools/files.js";
import { registerInteraction } from "./tools/interaction.js";
import { registerPolicy } from "./tools/policy.js";
import { registerProcess } from "./tools/process.js";
import { registerRuntimeMemory } from "./tools/runtime-memory.js";
import { registerSkills } from "./tools/skills.js";
import { registerTodos } from "./tools/todos.js";
import { registerWorkspace } from "./tools/workspace.js";

// The control-plane key belongs only to tunnel-client and must never reach tool children.
delete process.env.CONTROL_PLANE_API_KEY;

export function createServer() {
  const server = instrumentServer(new McpServer({
    name: APP_NAME,
    version: APP_VERSION,
    websiteUrl: "https://github.com/Veer376/chatgpt-local-system",
  }, {
    instructions: "Connected to this workstation through Local System.",
  }));
  registerPolicy(server);
  registerWorkspace(server);
  registerFiles(server);
  registerInteraction(server);
  registerTodos(server);
  registerRuntimeMemory(server);
  registerSkills(server);
  // Subagent tools are intentionally not registered in the model-facing contract.
  registerProcess(server);
  return server;
}

export function createApp({ host = HOST } = {}) {
  validateRuntimeConfig(host);
  ensureStateDirs();
  const app = express();
  const activeTransports = new Set();
  app.disable("x-powered-by");
  app.use(hostHeaderGuardFor(host));
  app.use(localExtensionCors);
  app.use(remoteUiAuthGuard);
  app.use("/mcp", (req, res, next) => {
    if (authorized(req)) return next();
    auditEvent("http.unauthorized", { ip: req.ip, path: req.path });
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
  });
  app.use(express.json({ limit: BODY_LIMIT, strict: true }));
  const extensionSession = createLocalExtensionSession();
  app.post("/local-ui/auth/session", (req, res) => {
    const origin = String(req.get("origin") || "");
    if (!isAllowedExtensionOrigin(origin)) {
      auditEvent("http.extension_session_denied", { origin: origin || null, ip: req.ip });
      return res.status(403).set("Cache-Control", "no-store").json({ error: "Local System extension origin required" });
    }
    const session = extensionSession.issue();
    return res.set("Cache-Control", "no-store").json(session);
  });
  app.use("/local-ui", (req, res, next) => {
    if (req.method === "OPTIONS" || req.path === "/auth/session") return next();
    const token = String(req.get("x-local-system-session") || "");
    if (!extensionSession.verify(token)) {
      auditEvent("http.extension_session_unauthorized", { path: req.path, ip: req.ip });
      return res.status(401).set("Cache-Control", "no-store").json({ error: "Local System extension session required" });
    }
    // Legacy route handlers still inspect this internal marker. It is set only
    // after the real session check and is no longer accepted from the client.
    req.headers["x-local-system-extension"] = "1";
    return next();
  });
  registerLocalImageRoutes(app);
  registerLocalTodoRoutes(app);
  registerLocalSkillRoutes(app);
  registerLocalFileRoutes(app);
  registerLocalFileWorkspaceRoutes(app);
  registerLocalGitRoutes(app);
  registerLocalAnnotationRoutes(app);
  registerLocalInteractionRoutes(app);
  registerLocalThreadPerformanceRoutes(app);
  registerLocalToolActivityRoutes(app);
  registerLocalTurnCheckpointRoutes(app);
  registerLocalWorkspaceTraceRoutes(app);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: APP_NAME, version: APP_VERSION, platform: platformSummary(), pid: process.pid });
  });
  app.get("/readyz", (_req, res) => {
    res.json({ ready: true, toolCount: EXPECTED_TOOL_NAMES.length, tools: EXPECTED_TOOL_NAMES });
  });

  app.post("/mcp", async (req, res) => {
    recordRecentWebConversationFromBody(req.body);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    activeTransports.add(transport);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      activeTransports.delete(transport);
      await Promise.allSettled([transport.close(), server.close()]);
    };
    res.once("finish", close);
    res.once("close", close);
    try {
      await runWithConversation(req, async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    } catch (error) {
      auditEvent("http.mcp_failed", { error: error.message });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal MCP error" }, id: null });
      }
    }
    return undefined;
  });

  app.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "stateless MCP endpoint accepts POST only" }));
  app.use((error, _req, res, _next) => {
    auditEvent("http.error", { error: error.message });
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "request body too large" });
    return res.status(400).json({ error: "invalid request" });
  });

  return { app, activeTransports };
}

function createLocalExtensionSession() {
  let token = "";
  let expiresAt = 0;
  const issue = () => {
    const now = Date.now();
    if (!token || expiresAt <= now + 60_000) {
      token = crypto.randomBytes(32).toString("base64url");
      expiresAt = now + LOCAL_EXTENSION_SESSION_TTL_MS;
    }
    return { token, expiresAt };
  };
  const verify = (candidate) => {
    if (!token || expiresAt <= Date.now()) return false;
    return timingSafeCompare(candidate, token);
  };
  return { issue, verify };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFARI_EXTENSION_ORIGIN = /^safari-web-extension:\/\/[A-Za-z0-9.-]+$/;
const ALLOWED_CORS_HEADERS = "Content-Type, X-Local-System-Session, X-Local-System-Image, Authorization, Ngrok-Skip-Browser-Warning";
const LOCAL_EXTENSION_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

function isAllowedExtensionOrigin(origin) {
  if (!origin) return false;
  if (SAFARI_EXTENSION_ORIGIN.test(origin)) return true;
  const allowedOrigins = String(process.env.LOCAL_EXTENSION_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowedOrigins.includes(origin);
}

function localExtensionCors(req, res, next) {
  const isLocalUiRoute = req.path.startsWith("/local-ui/") || req.path.startsWith("/local-image/") || req.path.startsWith("/local-file/");
  if (!isLocalUiRoute) return next();

  const origin = String(req.get("origin") || "");
  const capabilityRoute = /^\/local-(?:file|image)\/[A-Za-z0-9_-]{20,}$/.test(req.path);
  const allowed = isAllowedExtensionOrigin(origin) || (capabilityRoute && origin === "https://chatgpt.com");

  if (origin && allowed) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", ALLOWED_CORS_HEADERS);
    res.set("Access-Control-Max-Age", "600");
  }

  if (req.method === "OPTIONS") {
    if (!origin || !allowed) return res.sendStatus(403);
    return res.sendStatus(204);
  }
  return next();
}

function remoteUiAuthGuard(req, res, next) {
  if (!req.path.startsWith("/local-ui/")) return next();
  if (req.method === "OPTIONS") return next();
  const isRemote = Boolean(req.headers["x-forwarded-for"] || req.headers["x-ngrok-agent-ips"]);
  if (!isRemote) return next();

  const username = String(process.env.SAFARI_BRIDGE_USERNAME || "local-system").trim() || "local-system";
  const password = getSafariBridgePassword();
  if (!password) {
    auditEvent("http.remote_ui_unconfigured", { path: req.path, ip: req.ip });
    return res.status(503).json({ error: "remote Local System authentication is not configured" });
  }

  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const actual = String(req.headers.authorization || "");
  if (!timingSafeCompare(actual, expected)) {
    auditEvent("http.remote_ui_unauthorized", { path: req.path, ip: req.ip });
    return res.status(401).set("WWW-Authenticate", 'Basic realm="local-system-mobile"').json({ error: "authentication required" });
  }
  return next();
}

function timingSafeCompare(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getSafariBridgePassword() {
  if (Object.hasOwn(process.env, "SAFARI_BRIDGE_PASSWORD")) return String(process.env.SAFARI_BRIDGE_PASSWORD || "").trim();
  const passwordFile = path.join(repoRoot, ".safari-ios", "ngrok-password");
  if (fs.existsSync(passwordFile)) {
    try {
      return fs.readFileSync(passwordFile, "utf8").trim();
    } catch {}
  }
  return null;
}

export function startHttpServer({ host = HOST, port = PORT } = {}) {
  const { app, activeTransports } = createApp({ host });
  const sockets = new Set();
  const httpServer = app.listen(port, host, (error) => {
    // Express 5 forwards listen errors to this callback instead of leaving
    // them as unhandled Server errors. Re-emit so callers cannot mistake a
    // failed bind for a successful, long-running server.
    if (error) {
      httpServer.emit("error", error);
      return;
    }
    const address = httpServer.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`${APP_NAME} ${APP_VERSION} listening on ${httpUrl(host, actualPort, "/mcp")}`);
    console.log(`${EXPECTED_TOOL_NAMES.length} tools | platform=${platformSummary().adapter} | human confirmation ${BYPASS_SECURITY ? "bypassed" : "enabled"}`);
    auditEvent("server.started", { host, port: actualPort, platform: platformSummary() });
  });

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const shutdown = async (signal = "shutdown") => {
    auditEvent("server.stopping", { signal });
    await Promise.race([
      Promise.allSettled([...activeTransports].map((transport) => transport.close())),
      delay(2_000),
    ]);
    const closed = new Promise((resolve) => httpServer.close(resolve));
    await Promise.race([closed, delay(5_000)]);
    if (httpServer.listening || sockets.size) {
      httpServer.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await Promise.race([closed, delay(500)]);
    }
  };
  return { app, httpServer, shutdown };
}

function authorized(req) {
  if (!MCP_TOKEN) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(MCP_TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function hostHeaderGuardFor(host) {
  return (req, res, next) => {
  if (!isLoopbackHost(host)) return next();
  const raw = String(req.headers.host || "");
  const hostname = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
  if (!["127.0.0.1", "localhost", "::1"].includes(normalizeHost(hostname).toLowerCase())) {
    auditEvent("http.invalid_host", { host: raw });
    return res.status(403).json({ error: "invalid Host header" });
  }
  return next();
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const runtime = startHttpServer();
  let closing = false;
  const gracefulShutdown = async (signal) => {
    if (closing) return;
    closing = true;
    await runtime.shutdown(signal);
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => gracefulShutdown(signal));
  }

  process.on("uncaughtException", (error) => {
    console.error("[server] Uncaught exception:", error);
    auditEvent("server.crash", { kind: "uncaughtException", error: error?.stack || error?.message || String(error) });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[server] Unhandled rejection:", reason);
    auditEvent("server.crash", { kind: "unhandledRejection", error: reason?.stack || reason?.message || String(reason) });
  });
}
