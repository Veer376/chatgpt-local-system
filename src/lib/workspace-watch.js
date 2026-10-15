import fs from "node:fs";
import path from "node:path";

const DEFAULT_WAIT_MS = 25_000;
const MAX_WAIT_MS = 30_000;
const DEBOUNCE_MS = 90;
const IDLE_CLOSE_MS = 60_000;
const MAX_EVENT_PATHS = 32;

const workspaceWatchers = new Map();

export async function waitForWorkspaceChange(workspaceRoot, {
  since = 0,
  signal,
  timeoutMs = DEFAULT_WAIT_MS,
} = {}) {
  const entry = watcherFor(workspaceRoot);
  const normalizedSince = normalizeVersion(since);
  touch(entry);
  if (entry.version > normalizedSince) return snapshot(entry, { changed: true });
  if (signal?.aborted) throw abortError();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => settle(snapshot(entry, { changed: false, timedOut: true })), clampWait(timeoutMs));
    const abort = () => settle(null, abortError());
    const waiter = {
      since: normalizedSince,
      notify() {
        if (entry.version > normalizedSince) settle(snapshot(entry, { changed: true }));
      },
      cancel() {
        settle(null, abortError());
      },
    };

    function settle(value, error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
      entry.waiters.delete(waiter);
      scheduleIdleClose(entry);
      if (error) reject(error);
      else resolve(value);
    }

    entry.waiters.add(waiter);
    signal?.addEventListener?.("abort", abort, { once: true });
    touch(entry);
  });
}

export function closeWorkspaceWatchersForTests() {
  for (const entry of workspaceWatchers.values()) closeEntry(entry);
  workspaceWatchers.clear();
}

function watcherFor(workspaceRoot) {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const existing = workspaceWatchers.get(root);
  if (existing && !existing.closed) return existing;

  const entry = {
    root,
    watcher: null,
    version: 0,
    lastEvent: null,
    pending: null,
    debounceTimer: 0,
    idleTimer: 0,
    waiters: new Set(),
    closed: false,
  };
  entry.watcher = fs.watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
    queueEvent(entry, eventType, filename);
  });
  entry.watcher.on("error", () => {
    queueEvent(entry, "rename", null, { overflow: true });
  });
  workspaceWatchers.set(root, entry);
  return entry;
}

function queueEvent(entry, eventType, filename, { overflow = false } = {}) {
  if (entry.closed) return;
  const relativePath = normalizeRelativePath(filename);
  const indexLock = relativePath === ".git/index.lock";
  const rootMarker = relativePath === path.basename(entry.root);
  const absolutePath = relativePath ? path.resolve(entry.root, relativePath) : "";
  const insideRoot = !absolutePath || isWithinRoot(absolutePath, entry.root);

  if (!entry.pending) {
    entry.pending = {
      kind: eventType === "rename" ? "rename" : "change",
      overflow: overflow || !insideRoot,
      gitOnly: true,
      concrete: false,
      unknownRoot: false,
      sawIndexLock: false,
      paths: new Set(),
      relativePaths: new Set(),
    };
  } else {
    if (eventType === "rename") entry.pending.kind = "rename";
    entry.pending.overflow ||= overflow || !insideRoot;
  }

  if (indexLock) {
    entry.pending.sawIndexLock = true;
  } else if (!relativePath || rootMarker) {
    entry.pending.unknownRoot = true;
  } else if (insideRoot && absolutePath && entry.pending.paths.size < MAX_EVENT_PATHS) {
    entry.pending.concrete = true;
    entry.pending.gitOnly &&= isGitMetadataPath(relativePath);
    entry.pending.paths.add(absolutePath);
    entry.pending.relativePaths.add(relativePath);
  } else if (absolutePath) {
    entry.pending.overflow = true;
  }

  clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(() => flushPending(entry), DEBOUNCE_MS);
  touch(entry);
}

function flushPending(entry) {
  entry.debounceTimer = 0;
  if (entry.closed || !entry.pending) return;
  const pending = entry.pending;
  entry.pending = null;
  const substantiveRelativePaths = [...pending.relativePaths].filter((value) => value !== ".git");
  if (pending.sawIndexLock && pending.gitOnly && substantiveRelativePaths.length === 0) return;
  entry.version += 1;
  entry.lastEvent = {
    version: entry.version,
    kind: pending.kind,
    overflow: pending.overflow || (pending.unknownRoot && !pending.concrete),
    gitOnly: pending.concrete && pending.gitOnly,
    paths: [...pending.paths],
    relativePaths: [...pending.relativePaths],
    at: Date.now(),
  };
  for (const waiter of [...entry.waiters]) waiter.notify();
  scheduleIdleClose(entry);
}

function snapshot(entry, { changed, timedOut = false }) {
  return {
    workspace: entry.root,
    version: entry.version,
    changed,
    timedOut,
    event: changed ? entry.lastEvent : null,
  };
}

function touch(entry) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = 0;
}

function scheduleIdleClose(entry) {
  if (entry.closed || entry.waiters.size || entry.idleTimer) return;
  entry.idleTimer = setTimeout(() => {
    if (entry.waiters.size) return;
    workspaceWatchers.delete(entry.root);
    closeEntry(entry);
  }, IDLE_CLOSE_MS);
  entry.idleTimer.unref?.();
}

function closeEntry(entry) {
  if (!entry || entry.closed) return;
  entry.closed = true;
  clearTimeout(entry.debounceTimer);
  clearTimeout(entry.idleTimer);
  try { entry.watcher?.close(); } catch {}
  for (const waiter of [...entry.waiters]) {
    try { waiter.cancel(); } catch {}
  }
  entry.waiters.clear();
}

function canonicalWorkspaceRoot(value) {
  const root = path.resolve(String(value || ""));
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error("workspace root is not a directory");
  return fs.realpathSync(root);
}

function normalizeRelativePath(filename) {
  if (filename == null) return "";
  const value = Buffer.isBuffer(filename) ? filename.toString("utf8") : String(filename);
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function isGitMetadataPath(relativePath) {
  return relativePath === ".git" || relativePath.startsWith(".git/");
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeVersion(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function clampWait(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_WAIT_MS;
  return Math.max(250, Math.min(MAX_WAIT_MS, Math.round(parsed)));
}

function abortError() {
  const error = new Error("workspace watch cancelled");
  error.name = "AbortError";
  return error;
}
