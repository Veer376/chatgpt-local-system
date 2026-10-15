import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { effectiveBrowserProject } from "./local-project-context.js";
import { resolveBrowserThreadState } from "./local-todos.js";
import { canonicalPath, isWithin } from "./paths.js";

const execFileAsync = promisify(execFile);
const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const STATUS_TTL_MS = 1_500;
const REPO_TTL_MS = 15_000;
const MAX_GIT_OUTPUT = 6 * 1024 * 1024;
const MAX_DIFF_RANGES = 2_000;
const MAX_DIFF_TEXT_BYTES = 2 * 1024 * 1024;
const statusCache = new Map();
const repoCache = new Map();

export function registerLocalGitRoutes(app) {
  app.post("/local-ui/git", async (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const threadId = String(req.body?.threadId || "").trim();
      if (!threadId) return res.set("Cache-Control", "no-store").json(emptyStatus());

      const resolved = resolveBrowserThreadState(threadId);
      const workspaceRoot = effectiveBrowserProject(threadId, resolved);
      if (!workspaceRoot) return res.set("Cache-Control", "no-store").json(emptyStatus());

      const repoRoot = await resolveRepositoryRoot(workspaceRoot);
      if (!repoRoot) return res.set("Cache-Control", "no-store").json(emptyStatus({ workspaceRoot }));

      const action = String(req.body?.action || "status");
      if (action === "status") {
        const status = await gitStatus(repoRoot, workspaceRoot, { force: req.body?.force === true });
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          repository: true,
          workspaceRoot,
          ...status,
        });
      }

      if (action === "file_changes") {
        const filePath = resolveRepositoryFile(repoRoot, req.body?.path);
        if (!isWithin(filePath, workspaceRoot)) throw new Error("file is outside the current workspace");
        const relativePath = gitRelativePath(repoRoot, filePath);
        const status = await gitStatus(repoRoot, workspaceRoot);
        const entry = status.files.find((file) => file.path === relativePath) || null;
        let ranges = [];
        if (entry?.untracked) {
          ranges = untrackedRanges(filePath);
        } else if (entry) {
          const head = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
          const diffArgs = head.ok
            ? ["diff", "--no-ext-diff", "--no-color", "--unified=0", "HEAD", "--", relativePath]
            : ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=0", "--", relativePath];
          ranges = parseUnifiedZeroDiff((await runGit(repoRoot, diffArgs, { allowFailure: true })).stdout);
        }
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          repository: true,
          workspaceRoot,
          repoRoot,
          path: filePath,
          relativePath,
          changed: Boolean(entry),
          status: entry,
          ranges: ranges.slice(0, MAX_DIFF_RANGES),
        });
      }

      if (action === "file_diff") {
        const filePath = resolveRepositoryFile(repoRoot, req.body?.path);
        if (!isWithin(filePath, workspaceRoot)) throw new Error("file is outside the current workspace");
        const relativePath = gitRelativePath(repoRoot, filePath);
        const status = await gitStatus(repoRoot, workspaceRoot);
        const entry = status.files.find((file) => file.path === relativePath) || null;
        if (!entry) {
          return res.set("Cache-Control", "no-store").json({
            ok: true,
            repository: true,
            workspaceRoot,
            repoRoot,
            path: filePath,
            relativePath,
            changed: false,
            status: null,
            diff: "",
            truncated: false,
            binary: false,
          });
        }

        const result = entry.untracked
          ? untrackedUnifiedDiff(filePath, relativePath)
          : await trackedUnifiedDiff(repoRoot, relativePath);
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          repository: true,
          workspaceRoot,
          repoRoot,
          path: filePath,
          relativePath,
          changed: true,
          status: entry,
          ...result,
        });
      }

      return res.status(400).set("Cache-Control", "no-store").json({ error: "unsupported git action" });
    } catch (error) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function invalidateGitCache(repoRoot = "") {
  if (!repoRoot) {
    statusCache.clear();
    repoCache.clear();
    return;
  }
  const prefix = `${path.resolve(repoRoot)}\0`;
  for (const key of statusCache.keys()) {
    if (key.startsWith(prefix)) statusCache.delete(key);
  }
}

async function resolveRepositoryRoot(workspaceRoot) {
  const key = path.resolve(workspaceRoot);
  const cached = repoCache.get(key);
  if (cached && Date.now() - cached.at < REPO_TTL_MS) return cached.root;
  const result = await runGit(key, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  const root = result.ok ? String(result.stdout || "").trim() : "";
  const canonical = root ? canonicalPath(root) : "";
  repoCache.set(key, { at: Date.now(), root: canonical });
  return canonical;
}

async function gitStatus(repoRoot, workspaceRoot, { force = false } = {}) {
  const key = `${path.resolve(repoRoot)}\0${path.resolve(workspaceRoot)}`;
  const cached = statusCache.get(key);
  if (!force && cached?.value && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  if (!force && cached?.pending) return cached.pending;

  const pending = buildStatus(repoRoot, workspaceRoot).then((value) => {
    statusCache.set(key, { at: Date.now(), value });
    return value;
  }).catch((error) => {
    statusCache.delete(key);
    throw error;
  });
  statusCache.set(key, { at: Date.now(), pending });
  return pending;
}

async function buildStatus(repoRoot, workspaceRoot) {
  const scope = gitRelativePath(repoRoot, workspaceRoot) || ".";
  const [statusResult, branchResult, headResult] = await Promise.all([
    runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=dirty", "--", scope]),
    runGit(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFailure: true }),
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], { allowFailure: true }),
  ]);
  const files = parsePorcelainV1Z(statusResult.stdout);
  const statsResult = headResult.ok
    ? await runGit(repoRoot, ["diff", "--numstat", "-z", "HEAD", "--", scope], { allowFailure: true })
    : await runGit(repoRoot, ["diff", "--cached", "--numstat", "-z", "--", scope], { allowFailure: true });
  const stats = parseNumstatZ(statsResult.stdout);

  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const absolutePath = path.resolve(repoRoot, file.path);
    file.absolutePath = absolutePath;
    let fileStats = stats.get(file.path);
    if (!fileStats && file.untracked) fileStats = untrackedStats(absolutePath);
    file.additions = fileStats?.additions ?? null;
    file.deletions = fileStats?.deletions ?? null;
    file.binary = fileStats?.binary === true;
    if (Number.isInteger(file.additions)) additions += file.additions;
    if (Number.isInteger(file.deletions)) deletions += file.deletions;
  }

  const branch = String(branchResult.stdout || "").trim() || (headResult.ok ? "detached" : "unborn");
  return {
    repoRoot,
    branch,
    clean: files.length === 0,
    files,
    totals: {
      files: files.length,
      staged: files.filter((file) => file.staged).length,
      unstaged: files.filter((file) => file.unstaged).length,
      untracked: files.filter((file) => file.untracked).length,
      additions,
      deletions,
    },
    generatedAt: new Date().toISOString(),
  };
}

export function parsePorcelainV1Z(raw) {
  const tokens = String(raw || "").split("\0");
  const files = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (!record || record.length < 3) continue;
    const x = record[0];
    const y = record[1];
    const relativePath = record.slice(3);
    if (!relativePath) continue;
    const renamed = x === "R" || y === "R" || x === "C" || y === "C";
    const originalPath = renamed ? String(tokens[++index] || "") : "";
    const untracked = x === "?" && y === "?";
    const conflicted = isConflictCode(`${x}${y}`);
    files.push({
      path: relativePath.replaceAll("\\", "/"),
      ...(originalPath ? { originalPath: originalPath.replaceAll("\\", "/") } : {}),
      code: `${x}${y}`,
      kind: gitKind(x, y, { untracked, conflicted }),
      staged: !untracked && x !== " " && x !== "?",
      unstaged: !untracked && y !== " " && y !== "?",
      untracked,
      conflicted,
      additions: null,
      deletions: null,
      binary: false,
    });
  }
  return files;
}

export function parseNumstatZ(raw) {
  const tokens = String(raw || "").split("\0");
  const map = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const firstTab = token.indexOf("\t");
    const secondTab = firstTab >= 0 ? token.indexOf("\t", firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const addedRaw = token.slice(0, firstTab);
    const deletedRaw = token.slice(firstTab + 1, secondTab);
    let filePath = token.slice(secondTab + 1);
    if (!filePath) {
      index += 1; // preimage path for rename/copy
      filePath = String(tokens[++index] || ""); // postimage path
    }
    if (!filePath) continue;
    map.set(filePath.replaceAll("\\", "/"), {
      additions: addedRaw === "-" ? null : Number.parseInt(addedRaw, 10),
      deletions: deletedRaw === "-" ? null : Number.parseInt(deletedRaw, 10),
      binary: addedRaw === "-" || deletedRaw === "-",
    });
  }
  return map;
}

export function parseUnifiedZeroDiff(raw) {
  const ranges = [];
  const hunkPattern = /^@@\s+-\d+(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
  for (const line of String(raw || "").split("\n")) {
    const match = line.match(hunkPattern);
    if (!match) continue;
    const oldCount = match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
    const newStart = Number.parseInt(match[2], 10);
    const newCount = match[3] === undefined ? 1 : Number.parseInt(match[3], 10);
    if (oldCount === 0 && newCount > 0) {
      ranges.push({ type: "added", start: newStart, end: newStart + newCount - 1 });
    } else if (newCount === 0 && oldCount > 0) {
      ranges.push({ type: "deleted", line: Math.max(1, newStart), count: oldCount });
    } else if (newCount > 0) {
      ranges.push({ type: "modified", start: newStart, end: newStart + newCount - 1 });
    }
    if (ranges.length >= MAX_DIFF_RANGES) break;
  }
  return ranges;
}

function untrackedRanges(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return []; }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return [];
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (text.includes("\u0000")) return [];
    const lineCount = Math.max(1, text.split("\n").length);
    return [{ type: "added", start: 1, end: lineCount }];
  } catch {
    return [];
  }
}

function untrackedStats(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (text.includes("\u0000")) return { additions: null, deletions: null, binary: true };
    return { additions: Math.max(1, text.split("\n").length), deletions: 0, binary: false };
  } catch {
    return null;
  }
}

function resolveRepositoryFile(repoRoot, requested) {
  const raw = String(requested || "").trim();
  if (!raw) throw new Error("file path is required");
  const target = path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
  // Resolve existing path components while still allowing a deleted final file.
  const canonical = canonicalPath(target, { forWrite: true });
  if (!isWithin(canonical, repoRoot) || canonical === repoRoot) throw new Error("file is outside the repository");
  return canonical;
}

async function trackedUnifiedDiff(repoRoot, relativePath) {
  const head = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  const args = head.ok
    ? ["diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--", relativePath]
    : ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3", "--", relativePath];
  const result = await runGit(repoRoot, args, { allowFailure: true });
  return boundedDiff(result.stdout);
}

function untrackedUnifiedDiff(filePath, relativePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch {
    return { diff: "", truncated: false, binary: false };
  }
  if (!stat.isFile()) return { diff: "", truncated: false, binary: false };
  if (stat.size > MAX_DIFF_TEXT_BYTES) {
    return { diff: "", truncated: true, binary: false, tooLarge: true };
  }
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch {
    return { diff: "", truncated: false, binary: false };
  }
  if (text.includes("\u0000")) {
    return { diff: `Binary file ${relativePath} (untracked)\n`, truncated: false, binary: true };
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const diff = [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    "",
  ].join("\n");
  return boundedDiff(diff);
}

function boundedDiff(value) {
  const text = String(value || "");
  const binary = /(^|\n)Binary files? .* differ(?:\n|$)/.test(text);
  if (Buffer.byteLength(text, "utf8") <= MAX_DIFF_TEXT_BYTES) {
    return { diff: text, truncated: false, binary };
  }
  let end = Math.min(text.length, MAX_DIFF_TEXT_BYTES);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > MAX_DIFF_TEXT_BYTES) {
    end = Math.floor(end * 0.9);
  }
  const boundary = text.lastIndexOf("\n", end);
  const sliced = text.slice(0, boundary > 0 ? boundary + 1 : end);
  return { diff: sliced, truncated: true, binary };
}

function gitRelativePath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function emptyStatus(extra = {}) {
  return {
    ok: true,
    repository: false,
    branch: "",
    clean: true,
    files: [],
    totals: { files: 0, staged: 0, unstaged: 0, untracked: 0, additions: 0, deletions: 0 },
    ...extra,
  };
}

function gitKind(x, y, { untracked, conflicted }) {
  if (untracked) return "untracked";
  if (conflicted) return "conflicted";
  const code = x !== " " ? x : y;
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  return "modified";
}

function isConflictCode(code) {
  return new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]).has(code);
}

async function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout = "", stderr = "" } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 4_500,
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    if (allowFailure) {
      return {
        ok: false,
        stdout: String(error?.stdout || ""),
        stderr: String(error?.stderr || error?.message || ""),
      };
    }
    const message = String(error?.stderr || error?.message || "git command failed").trim();
    throw new Error(message.slice(0, 1_000));
  }
}
