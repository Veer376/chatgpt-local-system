import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH_ROOT, configuredProjectRoots } from "./config.js";
import { assertAllowed, canonicalPath, isWithin } from "./paths.js";
import { resolveBrowserThreadState } from "./local-todos.js";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const REQUIRED_HEADER = "x-local-system-image";
const REQUIRED_HEADER_VALUE = "1";

const IMAGE_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});

export function registerLocalImageRoutes(app, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const tickets = new Map();

  app.get("/local-image/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true });
  });

  app.post("/local-image/resolve", (req, res) => {
    if (req.get(REQUIRED_HEADER) !== REQUIRED_HEADER_VALUE) {
      return res.status(403).json({ error: "local image resolver requires the extension header" });
    }

    try {
      cleanup(tickets);
      const image = validateLocalImage(req.body?.path, req.body?.threadId);
      const token = crypto.randomBytes(24).toString("base64url");
      tickets.set(token, { ...image, expiresAt: Date.now() + ttlMs });
      const origin = `${req.protocol}://${req.get("host")}`;
      return res.set("Cache-Control", "no-store").json({
        url: `${origin}/local-image/${token}`,
        mimeType: image.mimeType,
        bytes: image.bytes,
        expiresInMs: ttlMs,
      });
    } catch (error) {
      return res.status(statusForLocalImageError(error)).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/local-image/:token", (req, res) => {
    cleanup(tickets);
    const ticket = tickets.get(String(req.params.token || ""));
    if (!ticket) return res.status(404).end();

    let stat;
    try {
      stat = fs.statSync(ticket.path);
    } catch {
      tickets.delete(req.params.token);
      return res.status(404).end();
    }
    if (!stat.isFile() || stat.size !== ticket.bytes) {
      tickets.delete(req.params.token);
      return res.status(404).end();
    }

    res.set({
      "Content-Type": ticket.mimeType,
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    const stream = fs.createReadStream(ticket.path);
    stream.on("error", () => {
      if (!res.headersSent) res.status(404);
      res.end();
    });
    stream.pipe(res);
    return undefined;
  });

  return { tickets };
}

function validateLocalImage(input, threadId) {
  if (typeof input !== "string" || !input.trim()) throw new Error("path is required");
  if (input.length > 8_192) throw new Error("path is too long");
  const raw = input.trim();
  const requested = resolveImageCandidate(raw, threadId);
  const resolved = assertAllowed(requested);

  const roots = [...configuredProjectRoots(), SCRATCH_ROOT].map((root) => {
    try { return canonicalPath(root); } catch { return path.resolve(root); }
  });
  if (!roots.some((root) => isWithin(resolved, root))) {
    throw new Error("image path is outside authorized project roots and Local System scratch");
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("image path is not a file");
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB limit`);

  const ext = path.extname(resolved).toLowerCase();
  const mimeType = IMAGE_TYPES[ext];
  if (!mimeType) throw new Error("only PNG, JPEG, GIF, and WebP images are supported");

  return { path: resolved, mimeType, bytes: stat.size };
}

function resolveImageCandidate(input, threadId) {
  if (path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) return path.resolve(input);

  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    throw new Error("relative image cannot resolve because the ChatGPT thread id is unavailable");
  }
  const resolvedThread = resolveBrowserThreadState(normalizedThreadId);
  if (!resolvedThread.bound) {
    throw new Error("relative image cannot resolve because this ChatGPT thread is not bound to Local System");
  }

  const bases = [];
  const workspace = typeof resolvedThread.state?.currentWorkspace === "string"
    ? resolvedThread.state.currentWorkspace
    : "";
  if (workspace) bases.push(workspace);
  if (resolvedThread.conversationKey) bases.push(path.join(SCRATCH_ROOT, resolvedThread.conversationKey));

  for (const base of bases) {
    let root;
    try { root = canonicalPath(base); } catch { continue; }
    const candidate = path.resolve(root, input);
    if (!isWithin(candidate, root)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next scoped base.
    }
  }

  if (!workspace) {
    throw new Error("relative image was not found in conversation scratch and no current workspace is set");
  }
  throw new Error(`relative image was not found in current workspace (${workspace}) or conversation scratch`);
}

function cleanup(tickets) {
  const now = Date.now();
  for (const [token, ticket] of tickets) {
    if (!ticket || ticket.expiresAt <= now) tickets.delete(token);
  }
}

function statusForLocalImageError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/outside authorized/i.test(message)) return 403;
  if (/supported|exceeds/i.test(message)) return 415;
  if (/path is required|path is too long/i.test(message)) return 400;
  if (/ENOENT|not a file/i.test(message)) return 404;
  return 400;
}
