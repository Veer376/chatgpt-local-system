import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { configuredProjectRoots, currentScratchDir, SCRATCH_ROOT } from "./config.js";
import { toolEnvironment } from "./exec.js";
import { effectiveBrowserProject } from "./local-project-context.js";
import { assertAllowed, assertInWorkspace, canonicalPath, isWithin } from "./paths.js";
import { resolveBrowserThreadState } from "./local-todos.js";

const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const INDEX_TTL_MS = 20_000;
const SCRATCH_HISTORY_TTL_MS = 5 * 60_000;
const MAX_INDEX_FILES = 30_000;
const MAX_SCRATCH_HISTORY_FILES = 150_000;
const MAX_RESULTS = 16;
const MAX_CONTENT_RESULTS = 100;
const MAX_CONTENT_QUERY_LENGTH = 300;
const CONTENT_SEARCH_TIMEOUT_MS = 1_500;
const CONTENT_SEARCH_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_STREAM_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const MEDIA_TTL_MS = 60 * 60 * 1_000;
const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const HTML_PREVIEW_TTL_MS = 60 * 60 * 1_000;
const EDITABLE_TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "json", "jsonl", "csv", "tsv",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "html", "htm", "css", "scss", "less",
  "xml", "svg", "yaml", "yml", "py", "pyw", "sh", "zsh", "bash", "sql", "java",
  "cs", "c", "h", "cc", "cpp", "cxx", "hpp", "go", "rs", "kt", "kts", "swift",
  "rb", "php", "ini", "toml", "conf", "env", "dockerfile", "gitignore", "properties",
  "gradle", "vue", "svelte",
]);
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "Pods",
  "Carthage",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".dart_tool",
  ".swiftpm",
  ".cache",
  ".parcel-cache",
  ".yarn",
  ".expo",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "target",
  "DerivedData",
]);

const MIME_TYPES = Object.freeze({
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".jsx": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".zip": "application/zip",
});

const indexCache = new Map();
let scratchHistoryCache = null;

export function registerLocalFileRoutes(app, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const tickets = new Map();

  app.post("/local-ui/files/search", (req, res) => {
    if (!extensionAuthorized(req)) return res.status(403).json({ error: "Local System extension header required" });
    try {
      const result = searchFilesForBrowserThread(req.body?.threadId, req.body?.query, {
        workspaceOnly: req.body?.workspaceOnly === true,
      });
      return res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      return res.status(statusForFileError(error)).set("Cache-Control", "no-store").json({ error: messageOf(error) });
    }
  });

  app.post("/local-ui/files/content-search", async (req, res) => {
    if (!extensionAuthorized(req)) return res.status(403).json({ error: "Local System extension header required" });
    const controller = new AbortController();
    const abortSearch = () => controller.abort();
    res.once("close", abortSearch);
    try {
      const result = await searchWorkspaceTextForBrowserThread(req.body?.threadId, req.body?.query, { signal: controller.signal });
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return undefined;
      return res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError" || res.destroyed || res.writableEnded) return undefined;
      return res.status(statusForFileError(error)).set("Cache-Control", "no-store").json({ error: messageOf(error) });
    } finally {
      res.off("close", abortSearch);
    }
  });

  app.post("/local-ui/files/resolve", (req, res) => {
    if (!extensionAuthorized(req)) return res.status(403).json({ error: "Local System extension header required" });
    try {
      cleanup(tickets);
      const resolvedThread = resolveOptionalBrowserThread(req.body?.threadId);
      const workspaceRoot = effectiveBrowserProject(req.body?.threadId, resolvedThread);
      const file = validateThreadFile(req.body?.path, resolvedThread, {
        workspaceRoot,
      });
      const token = crypto.randomBytes(24).toString("base64url");
      const expiresAt = Date.now() + (isStreamMedia(file.mimeType) ? Math.max(ttlMs, MEDIA_TTL_MS) : ttlMs);
      tickets.set(token, { ...file, expiresAt });
      const origin = `${req.protocol}://${req.get("host")}`;
      return res.set("Cache-Control", "no-store").json({
        url: `${origin}/local-file/${token}`,
        path: file.path,
        name: path.basename(file.path),
        mimeType: file.mimeType,
        bytes: file.bytes,
        lastModified: file.lastModified,
      });
    } catch (error) {
      return res.status(statusForFileError(error)).set("Cache-Control", "no-store").json({ error: messageOf(error) });
    }
  });

  app.post("/local-ui/files/html-preview", (req, res) => {
    if (!extensionAuthorized(req)) return res.status(403).json({ error: "Local System extension header required" });
    try {
      cleanup(tickets);
      const resolvedThread = resolveOptionalBrowserThread(req.body?.threadId);
      const workspaceRoot = effectiveBrowserProject(req.body?.threadId, resolvedThread);
      const file = validateThreadFile(req.body?.path, resolvedThread, { maxBytes: MAX_EDIT_BYTES, workspaceRoot });
      if (!/\.html?$/i.test(file.path)) throw new Error("HTML preview requires an .html or .htm file");
      const content = req.body?.content;
      if (typeof content !== "string") throw new Error("content must be a string");
      if (Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES) throw new Error("HTML preview exceeds 5 MiB limit");

      const token = crypto.randomBytes(24).toString("base64url");
      const previewRoot = previewRootForFile(file.path, workspaceRoot);
      const entryPath = path.relative(previewRoot, file.path);
      const expiresAt = Date.now() + Math.max(ttlMs, HTML_PREVIEW_TTL_MS);
      tickets.set(token, { ...file, previewRoot, htmlContent: content, expiresAt });
      const origin = `${req.protocol}://${req.get("host")}`;
      return res.set("Cache-Control", "no-store").json({
        url: `${origin}/local-preview/${token}/${encodePreviewRoutePath(entryPath)}`,
        expiresAt,
      });
    } catch (error) {
      return res.status(statusForFileError(error)).set("Cache-Control", "no-store").json({ error: messageOf(error) });
    }
  });

  app.get("/local-preview/:token/*assetPath", (req, res) => {
    cleanup(tickets);
    const token = String(req.params.token || "");
    const ticket = tickets.get(token);
    if (!ticket?.previewRoot) return res.status(404).end();

    const rawAssetPath = Array.isArray(req.params.assetPath)
      ? req.params.assetPath.join("/")
      : String(req.params.assetPath || "");
    if (!rawAssetPath || rawAssetPath.includes("\u0000")) return res.status(404).end();

    const previewRoot = ticket.previewRoot;
    const requested = path.resolve(previewRoot, ...rawAssetPath.split("/").filter(Boolean));
    if (!isWithin(requested, previewRoot)) return res.status(404).end();

    let resolved;
    let stat;
    try {
      resolved = assertAllowed(requested);
      if (!isWithin(resolved, previewRoot)) return res.status(404).end();
      stat = fs.statSync(resolved);
    } catch {
      return res.status(404).end();
    }
    if (!stat.isFile()) return res.status(404).end();

    ticket.expiresAt = Date.now() + Math.max(ttlMs, ticket.htmlContent === undefined ? ttlMs : HTML_PREVIEW_TTL_MS);
    const mimeType = MIME_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream";
    if (typeof ticket.htmlContent === "string" && resolved === ticket.path) {
      const content = Buffer.from(ticket.htmlContent, "utf8");
      res.set({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(content.length),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(content);
    }
    res.set({
      "Content-Type": mimeType,
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    const stream = fs.createReadStream(resolved);
    stream.on("error", () => {
      if (!res.headersSent) res.status(404);
      res.end();
    });
    stream.pipe(res);
    return undefined;
  });

  app.post("/local-ui/files/write", (req, res) => {
    if (!extensionAuthorized(req)) return res.status(403).json({ error: "Local System extension header required" });
    try {
      const resolvedThread = resolveOptionalBrowserThread(req.body?.threadId);

      const file = validateThreadFile(req.body?.path, resolvedThread, { maxBytes: MAX_EDIT_BYTES });
      if (!isEditableTextFile(file.path, file.mimeType)) throw new Error("file type is not editable as text");

      const content = req.body?.content;
      if (typeof content !== "string") throw new Error("content must be a string");
      if (content.includes("\u0000")) throw new Error("text content cannot contain NUL bytes");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_EDIT_BYTES) throw new Error("edited file exceeds 5 MiB limit");

      const expectedLastModified = Number(req.body?.expectedLastModified);
      const expectedBytes = Number(req.body?.expectedBytes);
      if (!Number.isFinite(expectedLastModified) || !Number.isInteger(expectedBytes) || expectedBytes < 0) {
        throw new Error("expectedLastModified and expectedBytes are required");
      }
      if (file.lastModified !== Math.floor(expectedLastModified) || file.bytes !== expectedBytes) {
        const error = new Error("file changed on disk; reload it before saving");
        error.code = "FILE_CONFLICT";
        throw error;
      }

      fs.writeFileSync(file.path, content, { encoding: "utf8", flag: "w" });
      const stat = fs.statSync(file.path);
      return res.set("Cache-Control", "no-store").json({
        ok: true,
        path: file.path,
        mimeType: file.mimeType,
        bytes: stat.size,
        lastModified: Math.floor(stat.mtimeMs),
      });
    } catch (error) {
      return res.status(statusForFileError(error)).set("Cache-Control", "no-store").json({ error: messageOf(error) });
    }
  });

  app.get("/local-file/:token", (req, res) => {
    cleanup(tickets);
    const token = String(req.params.token || "");
    const ticket = tickets.get(token);
    if (!ticket) return res.status(404).end();

    let stat;
    try {
      stat = fs.statSync(ticket.path);
    } catch {
      tickets.delete(token);
      return res.status(404).end();
    }
    if (!stat.isFile() || stat.size !== ticket.bytes) {
      tickets.delete(token);
      return res.status(404).end();
    }

    const isMedia = isStreamMedia(ticket.mimeType);
    const range = isMedia ? mediaByteRange(req.get("range"), stat.size) : null;
    res.set({
      "Content-Type": ticket.mimeType,
      "Accept-Ranges": isMedia ? "bytes" : "none",
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    if (range?.invalid) {
      return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
    }
    if (range) {
      res.status(206).set({
        "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
        "Content-Length": String(range.end - range.start + 1),
      });
    } else {
      res.set("Content-Length", String(stat.size));
    }
    const stream = fs.createReadStream(ticket.path, range ? { start: range.start, end: range.end } : {});
    res.on("close", () => stream.destroy());
    stream.on("error", () => {
      if (!res.headersSent) res.status(404);
      res.end();
    });
    stream.pipe(res);
    return undefined;
  });

  return { tickets };
}

function isStreamMedia(mimeType) {
  return mimeType.startsWith("video/") || mimeType.startsWith("audio/");
}

function mediaByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

export function searchFilesForBrowserThread(threadId, query = "", { workspaceOnly = false } = {}) {
  const resolvedThread = resolveOptionalBrowserThread(threadId);
  const workspace = effectiveBrowserProject(threadId, resolvedThread);

  const normalizedQuery = normalizeSearch(query);
  const { primaryRoots, secondaryRoots } = rootsForThread(resolvedThread, workspace);
  const canonicalWorkspace = workspace ? canonicalPath(workspace) : "";
  const visiblePrimaryRoots = workspaceOnly
    ? primaryRoots.filter((entry) => entry.source === "workspace" && entry.root === canonicalWorkspace)
    : primaryRoots;
  const hasCurrentWorkspace = Boolean(workspace);
  const seen = new Set();
  const candidates = [];

  collectCandidates(visiblePrimaryRoots, candidates, seen);
  let ranked = rankFiles(candidates, normalizedQuery);

  // Match VS Code's workspace-first feel while still allowing a typed query to
  // find any file under the other explicitly authorized Local System roots.
  // Empty-query recents stay workspace/scratch scoped when a workspace exists.
  // Without a current workspace, scratch alone must not make @@ / quick-open
  // look empty: browse the authorized project roots as the fallback surface.
  if (!workspaceOnly && (normalizedQuery || !hasCurrentWorkspace)) {
    collectCandidates(secondaryRoots, candidates, seen);
    // Quick Open is an explicit user search. Include older generated scratch files
    // here, but never use this history as a fallback for inline relative paths.
    if (normalizedQuery.length >= 2) {
      for (const entry of searchScratchHistory(normalizedQuery)) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        candidates.push(entry);
      }
    }
    ranked = rankFiles(candidates, normalizedQuery);
  }

  const files = ranked.slice(0, MAX_RESULTS).map(({ entry }) => ({
    name: entry.name,
    path: entry.path,
    displayPath: entry.displayPath,
    bytes: entry.bytes,
    lastModified: entry.lastModified,
    source: entry.source,
  }));

  return {
    ok: true,
    bound: resolvedThread.bound === true,
    currentWorkspace: workspace,
    total: ranked.length,
    files,
  };
}

export async function searchWorkspaceTextForBrowserThread(threadId, query = "", { signal } = {}) {
  const resolvedThread = resolveOptionalBrowserThread(threadId);
  const workspace = effectiveBrowserProject(threadId, resolvedThread);
  const normalizedQuery = String(query || "").trim().slice(0, MAX_CONTENT_QUERY_LENGTH);
  if (!workspace || !normalizedQuery) {
    return {
      ok: true,
      bound: resolvedThread.bound === true,
      currentWorkspace: workspace || "",
      query: normalizedQuery,
      total: 0,
      matches: [],
      truncated: false,
    };
  }

  const root = canonicalPath(workspace);
  if (!pathIsInConfiguredProjectRoots(root)) throw new Error("workspace is outside configured project roots");
  const args = [
    "--json",
    "--line-number",
    "--column",
    "--fixed-strings",
    "--ignore-case",
    "--hidden",
    "--max-filesize", "2M",
    ...[...IGNORED_DIRS].flatMap((name) => ["--glob", `!${name}/**`]),
    "--",
    normalizedQuery,
    ".",
  ];
  const searchResult = await runRipgrepSearch({ root, args, signal, query: normalizedQuery });

  return {
    ok: true,
    bound: resolvedThread.bound === true,
    currentWorkspace: root,
    query: normalizedQuery,
    total: searchResult.total,
    matches: searchResult.matches,
    truncated: searchResult.truncated,
    ...(searchResult.timedOut ? { timedOut: true } : {}),
  };
}

function runRipgrepSearch({ root, args, signal, query }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());

    const child = spawn("rg", args, {
      cwd: root,
      env: toolEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const matches = [];
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let intentionallyStopped = false;
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve({ matches, total, truncated, timedOut });
    };
    const stop = () => {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    };
    const onAbort = () => {
      intentionallyStopped = true;
      stop();
      finish(abortError());
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      truncated = true;
      intentionallyStopped = true;
      stop();
    }, CONTENT_SEARCH_TIMEOUT_MS);

    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (error) => {
      if (error?.code === "ENOENT") finish(new Error("full-text search requires ripgrep (rg)"));
      else finish(error);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer, "utf8") > CONTENT_SEARCH_MAX_BUFFER) {
        truncated = true;
        intentionallyStopped = true;
        stop();
        return;
      }
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const match = parseRipgrepMatch(line, root, query);
        if (!match) continue;
        total += 1;
        if (matches.length < MAX_CONTENT_RESULTS) matches.push(match);
        else {
          truncated = true;
          intentionallyStopped = true;
          stop();
          break;
        }
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      if (stdoutBuffer && !truncated) {
        const match = parseRipgrepMatch(stdoutBuffer, root, query);
        if (match) {
          total += 1;
          if (matches.length < MAX_CONTENT_RESULTS) matches.push(match);
          else truncated = true;
        }
      }
      if (intentionallyStopped || code === 0 || code === 1) return finish();
      finish(new Error(stderr.trim() || `full-text search failed with exit code ${code}`));
    });
  });
}

function parseRipgrepMatch(line, root, query) {
  if (!line) return null;
  let item;
  try { item = JSON.parse(line); } catch { return null; }
  if (item?.type !== "match") return null;
  const data = item.data || {};
  const relative = String(data.path?.text || "").replace(/^\.\//, "");
  const absolute = path.resolve(root, relative);
  if (!isWithin(absolute, root)) return null;
  const firstMatch = Array.isArray(data.submatches) ? data.submatches[0] : null;
  const preview = String(data.lines?.text || "").replace(/[\r\n]+$/, "");
  return {
    name: path.basename(absolute),
    path: absolute,
    relative,
    displayPath: relative,
    line: Number(data.line_number) || 1,
    column: Number(firstMatch?.start) + 1 || 1,
    preview: preview.slice(0, 700),
    match: String(firstMatch?.match?.text || query).slice(0, 300),
  };
}

function abortError() {
  const error = new Error("search cancelled");
  error.name = "AbortError";
  return error;
}

function resolveOptionalBrowserThread(threadId) {
  const normalized = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalized) return { bound: false, state: null, conversationKey: null };
  return resolveBrowserThreadState(normalized);
}

function collectCandidates(roots, candidates, seen) {
  for (const root of roots) {
    for (const entry of fileIndex(root)) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      candidates.push(entry);
    }
  }
}

function rootsForThread(resolvedThread, workspaceRoot = "") {
  const primaryRoots = [];
  const secondaryRoots = [];
  const added = new Set();

  const add = (target, collection, source) => {
    if (!target) return;
    let root;
    try { root = canonicalPath(target); } catch { return; }
    if (!fs.statSync(root).isDirectory() || added.has(root)) return;
    added.add(root);
    collection.push({ root, source });
  };

  if (workspaceRoot && pathIsInConfiguredProjectRoots(workspaceRoot)) {
    add(workspaceRoot, primaryRoots, "workspace");
  }

  const workspace = typeof resolvedThread.state?.currentWorkspace === "string"
    ? resolvedThread.state.currentWorkspace
    : "";
  if (workspace && pathIsInConfiguredProjectRoots(workspace)) add(workspace, primaryRoots, "workspace");

  for (const root of configuredProjectRoots()) add(root, secondaryRoots, path.basename(root) || "root");
  add(currentScratchDir(), secondaryRoots, "scratch");
  return { primaryRoots, secondaryRoots };
}

function pathIsInConfiguredProjectRoots(target) {
  let canonical;
  try { canonical = canonicalPath(target); } catch { return false; }
  return configuredProjectRoots().some((root) => {
    try { return isWithin(canonical, canonicalPath(root)); } catch { return false; }
  });
}

function fileIndex({ root, source }) {
  const cached = indexCache.get(root);
  const now = Date.now();
  let rootMtimeMs = 0;
  try { rootMtimeMs = Math.floor(fs.statSync(root).mtimeMs); } catch { /* handled by the index walk below */ }
  if (cached && now - cached.indexedAt <= INDEX_TTL_MS && cached.rootMtimeMs === rootMtimeMs) {
    return cached.entries.map((entry) => ({ ...entry, source }));
  }

  const entries = [];
  const stack = [root];
  while (stack.length && entries.length < MAX_INDEX_FILES) {
    const dir = stack.pop();
    let children;
    try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    children.sort((a, b) => b.name.localeCompare(a.name));
    for (const child of children) {
      if (entries.length >= MAX_INDEX_FILES) break;
      if (child.isSymbolicLink()) continue;
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (!IGNORED_DIRS.has(child.name)) stack.push(full);
        continue;
      }
      if (!child.isFile()) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const relative = path.relative(root, full) || child.name;
      entries.push({
        name: child.name,
        path: full,
        relative,
        displayPath: source === "workspace" ? relative : `${path.basename(root)}/${relative}`,
        bytes: stat.size,
        lastModified: Math.floor(stat.mtimeMs),
      });
    }
  }

  indexCache.set(root, { indexedAt: now, rootMtimeMs, entries });
  return entries.map((entry) => ({ ...entry, source }));
}

function searchScratchHistory(query) {
  const now = Date.now();
  if (!scratchHistoryCache || now - scratchHistoryCache.indexedAt > SCRATCH_HISTORY_TTL_MS) {
    const entries = [];
    let root;
    try { root = canonicalPath(SCRATCH_ROOT); } catch { return []; }
    const stack = [root];
    // Cache names rather than stat-ing every media file in a potentially huge scratch.
    while (stack.length && entries.length < MAX_SCRATCH_HISTORY_FILES) {
      const dir = stack.pop();
      let children;
      try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        const full = path.join(dir, child.name);
        if (child.isDirectory()) {
          if (!IGNORED_DIRS.has(child.name)) stack.push(full);
        } else if (child.isFile()) {
          const relative = path.relative(root, full);
          entries.push({
            name: child.name, path: full, relative,
            displayPath: `scratch/${relative}`, source: "scratch",
          });
          if (entries.length >= MAX_SCRATCH_HISTORY_FILES) break;
        }
      }
    }
    scratchHistoryCache = { indexedAt: now, entries };
  }
  return rankFiles(scratchHistoryCache.entries, query).slice(0, MAX_RESULTS * 4)
    .flatMap((entry) => {
      try {
        const stat = fs.statSync(entry.entry.path);
        return stat.isFile() ? [{
          ...entry.entry,
          bytes: stat.size,
          lastModified: Math.floor(stat.mtimeMs),
        }] : [];
      } catch {
        return [];
      }
    });
}

function rankFiles(entries, query) {
  if (!query) {
    return entries
      .map((entry) => ({ entry, score: (entry.lastModified || 0) + sourcePriority(entry) }))
      .sort((a, b) => b.score - a.score || a.entry.displayPath.localeCompare(b.entry.displayPath));
  }

  return entries
    .map((entry) => {
      const matchScore = scoreFile(entry, query);
      return { entry, matchScore, score: matchScore + sourcePriority(entry) };
    })
    .filter(({ matchScore }) => matchScore > 0)
    .sort((a, b) => b.score - a.score || a.entry.displayPath.length - b.entry.displayPath.length || a.entry.displayPath.localeCompare(b.entry.displayPath));
}

function sourcePriority(entry) {
  if (entry.source === "workspace") return 300;
  if (entry.source === "scratch") return 120;
  return 0;
}

function scoreFile(entry, query) {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length > 1) {
    let total = 0;
    for (const term of terms) {
      const termScore = scoreSingleTerm(entry, term);
      if (termScore <= 0) return 0;
      total += termScore;
    }
    return total + 500;
  }
  return scoreSingleTerm(entry, query);
}

function scoreSingleTerm(entry, query) {
  const name = normalizeSearch(entry.name);
  const relative = normalizeSearch(entry.relative);
  if (name === query) return 10_000;
  if (name.startsWith(query)) return 9_000 - Math.min(500, name.length - query.length);
  if (relative.startsWith(query)) return 8_000 - Math.min(500, relative.length - query.length);
  const nameIndex = name.indexOf(query);
  if (nameIndex >= 0) return 7_000 - nameIndex * 20;
  const pathIndex = relative.indexOf(query);
  if (pathIndex >= 0) return 6_000 - pathIndex * 10;

  const fuzzyName = subsequenceScore(name, query);
  if (fuzzyName > 0) return 5_000 + fuzzyName;
  const fuzzyPath = subsequenceScore(relative, query);
  if (fuzzyPath > 0) return 4_000 + fuzzyPath;
  return 0;
}

function subsequenceScore(value, query) {
  let cursor = 0;
  let score = 0;
  let lastMatch = -2;
  for (const char of query) {
    const index = value.indexOf(char, cursor);
    if (index < 0) return 0;
    score += index === lastMatch + 1 ? 14 : 5;
    const previous = value[index - 1] || "";
    if (index === 0 || previous === "/" || /[._-]/.test(previous)) score += 10;
    lastMatch = index;
    cursor = index + 1;
  }
  return score - Math.min(100, value.length - query.length);
}

export function validateThreadFile(input, resolvedThread, {
  maxBytes = MAX_ATTACHMENT_BYTES,
  workspaceRoot = "",
} = {}) {
  if (typeof input !== "string" || !input.trim()) throw new Error("path is required");
  if (input.length > 8_192) throw new Error("path is too long");
  const requested = input.trim();
  const absolute = path.isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested);
  const resolved = absolute
    ? assertInWorkspace(requested)
    : assertAllowed(resolveThreadFileCandidate(requested, resolvedThread, workspaceRoot));
  if (!absolute) {
    const { primaryRoots, secondaryRoots } = rootsForThread(resolvedThread, workspaceRoot);
    const roots = [...primaryRoots, ...secondaryRoots].map(({ root }) => root);
    if (!roots.some((root) => isWithin(resolved, root))) {
      throw new Error("file path is outside this thread's authorized roots");
    }
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("path is not a file");
  const mimeType = MIME_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream";
  const limit = isStreamMedia(mimeType) && maxBytes === MAX_ATTACHMENT_BYTES ? MAX_STREAM_MEDIA_BYTES : maxBytes;
  if (stat.size > limit) throw new Error(`file exceeds ${Math.round(limit / (1024 * 1024))} MiB local file limit`);
  return {
    path: resolved,
    mimeType,
    bytes: stat.size,
    lastModified: Math.floor(stat.mtimeMs),
  };
}

function resolveThreadFileCandidate(input, resolvedThread, workspaceRoot = "") {
  if (path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) return path.resolve(input);

  const { primaryRoots, secondaryRoots } = rootsForThread(resolvedThread, workspaceRoot);
  const relativeRoots = primaryRoots.length ? primaryRoots : secondaryRoots;
  for (const { root } of relativeRoots) {
    const candidate = path.resolve(root, input);
    if (!isWithin(candidate, root)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next authorized root.
    }
  }

  throw new Error("ENOENT: relative file was not found in the current workspace or conversation scratch");
}

function isEditableTextFile(filePath, mimeType) {
  if (String(mimeType || "").startsWith("text/")) return true;
  if (["application/json", "application/x-ndjson", "application/xml", "application/yaml"].includes(mimeType)) return true;
  const name = path.basename(filePath).toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : name.replace(/^\./, "");
  return EDITABLE_TEXT_EXTENSIONS.has(extension) || EDITABLE_TEXT_EXTENSIONS.has(name);
}

function extensionAuthorized(req) {
  return req.get(EXTENSION_HEADER) === EXTENSION_HEADER_VALUE;
}

function previewRootForFile(filePath, workspaceRoot = "") {
  if (workspaceRoot) {
    try {
      const root = canonicalPath(workspaceRoot);
      if (isWithin(filePath, root)) return root;
    } catch {
      // Fall back to the file's own directory below.
    }
  }
  return path.dirname(filePath);
}

function encodePreviewRoutePath(value) {
  return String(value || "")
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function cleanup(tickets) {
  const now = Date.now();
  for (const [token, ticket] of tickets) {
    if (!ticket || ticket.expiresAt <= now) tickets.delete(token);
  }
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase().replaceAll("\\", "/");
}

function statusForFileError(error) {
  const message = messageOf(error);
  if (error?.code === "FILE_CONFLICT" || /changed on disk/i.test(message)) return 409;
  if (/outside|protected path|authorized roots/i.test(message)) return 403;
  if (/exceeds/i.test(message)) return 413;
  if (/not editable as text/i.test(message)) return 415;
  if (/ENOENT|not a file/i.test(message)) return 404;
  return 400;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
