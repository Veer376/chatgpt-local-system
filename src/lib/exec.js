import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_TIMEOUT_MS,
  LOG_DIR,
  MAX_PROCESS_LOG_BYTES,
  MAX_PROCESS_RECORDS,
  MAX_STDERR_CHARS,
  MAX_STDOUT_CHARS,
  PROCESS_RETENTION_DAYS,
  PROC_DIR,
  TOOL_ENV_ALLOWLIST,
  TOOL_EXTRA_PATH,
  TOOL_ENV_INHERIT_SECRETS,
  atomicWriteJson,
  currentScratchDir,
  ensureStateDirs,
} from "./config.js";
import { clip, nowIso } from "./text.js";
import { currentConversationId } from "./conversation.js";

const PROCESS_RUNNER_PATH = fileURLToPath(new URL("./process-runner.mjs", import.meta.url));
const DEFAULT_PROCESS_WAIT_MS = 60_000;

export function runCommand(command, options = {}) {
  const cwd = options.cwd || currentScratchDir();
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const shell = options.shell ?? typeof command === "string";
  const env = toolEnvironment(options.env);
  const argv = normalizeCommand(command);

  return new Promise((resolve) => {
    if (!cwd || !fs.existsSync(cwd)) {
      return resolve({
        ok: false,
        code: null,
        signal: null,
        stdout: "",
        stderr: `working directory does not exist: ${cwd}`,
        timedOut: false,
        cancelled: false,
      });
    }
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawn(argv.file, argv.args, {
      cwd,
      env,
      shell,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const identity = getProcessIdentity(child.pid);
    const stdout = boundedCollector(options.maxStdout ?? MAX_STDOUT_CHARS);
    const stderr = boundedCollector(options.maxStderr ?? MAX_STDERR_CHARS);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        ok: result.code === 0 && !timedOut && !cancelled,
        code: result.code ?? null,
        signal: result.signal ?? null,
        timedOut,
        cancelled,
        stdout: stdout.value(),
        stderr: stderr.value(),
        cwd,
        command: displayCommand(command),
      });
    };

    const abort = async () => {
      cancelled = true;
      await terminateProcessTree(child.pid, { forceAfterMs: 500, expectedIdentity: identity });
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child.pid, { forceAfterMs: 2_000, expectedIdentity: identity });
    }, timeoutMs);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(`\n${error.message}`);
      finish({ code: null, signal: null });
    });
    child.on("close", (code, signal) => finish({ code, signal }));

    if (options.stdin != null) {
      child.stdin.end(options.stdin);
    }
  });
}

export function startProcess(command, options = {}) {
  ensureStateDirs();
  const id = `p_${Date.now().toString(36)}_${cryptoRandom(6)}`;
  const cwd = options.cwd || currentScratchDir();
  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error(`working directory does not exist: ${cwd}`);
  }
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      throw new Error(`working directory is not a directory: ${cwd}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`working directory does not exist: ${cwd}`);
    }
    throw error;
  }
  const stdoutPath = path.join(LOG_DIR, `${id}.out.log`);
  const stderrPath = path.join(LOG_DIR, `${id}.err.log`);
  const metaPath = path.join(PROC_DIR, `${id}.json`);
  const invocationPath = path.join(PROC_DIR, `${id}.run.json`);
  const statusPath = path.join(PROC_DIR, `${id}.status.json`);
  const controlPath = processControlPath(id);
  const outFd = fs.openSync(stdoutPath, "a", 0o600);
  const errFd = fs.openSync(stderrPath, "a", 0o600);
  let child;
  try {
    fs.writeFileSync(invocationPath, `${JSON.stringify({
      command: Array.isArray(command) ? command : String(command),
      shell: options.shell ?? typeof command === "string",
      controlPath,
    })}\n`, { mode: 0o600, flag: "wx" });
    child = spawn(process.execPath, [PROCESS_RUNNER_PATH, invocationPath, statusPath], {
      cwd,
      env: toolEnvironment(options.env),
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, errFd],
    });
    child.on("error", (error) => {
      try {
        fs.appendFileSync(stderrPath, `\nfailed to spawn process runner: ${error.message}\n`);
      } catch {}
      writeProcessStatus(id, {
        state: "failed",
        exitCode: null,
        signal: null,
        finishedAt: nowIso(),
        error: error.message,
      });
    });
    if (!child.pid) throw new Error("process did not return a pid");
    child.unref();
  } catch (error) {
    try { fs.unlinkSync(invocationPath); } catch {}
    throw error;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const meta = {
    id,
    pid: child.pid,
    command: displayCommand(command),
    cwd,
    startedAt: nowIso(),
    platform: process.platform,
    identity: getProcessIdentity(child.pid),
    stdoutPath,
    stderrPath,
  };
  atomicWriteJson(metaPath, meta);
  return meta;
}

export function listProcesses() {
  ensureStateDirs();
  const records = fs.readdirSync(PROC_DIR)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const metaPath = path.join(PROC_DIR, name);
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (!/^p_[A-Za-z0-9_]+$/.test(meta.id) || !Number.isInteger(meta.pid)) return [];
        const expectedOut = path.join(LOG_DIR, `${meta.id}.out.log`);
        const expectedErr = path.join(LOG_DIR, `${meta.id}.err.log`);
        if (path.resolve(meta.stdoutPath) !== expectedOut || path.resolve(meta.stderrPath) !== expectedErr) return [];
        capLogFile(expectedOut);
        capLogFile(expectedErr);
        const statusPath = path.join(PROC_DIR, `${meta.id}.status.json`);
        const invocationPath = path.join(PROC_DIR, `${meta.id}.run.json`);
        const terminal = readProcessStatus(statusPath);
        const running = !terminal && isSameProcess(meta);
        const durationMs = terminal?.finishedAt ? elapsedMs(meta.startedAt, terminal.finishedAt) : null;
        return [{
          ...meta,
          ...(terminal || {}),
          ...(durationMs != null ? { durationMs } : {}),
          state: terminal?.state || (running ? "running" : "unknown"),
          running,
          _metaPath: metaPath,
          _statusPath: statusPath,
          _invocationPath: invocationPath,
        }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const cutoff = Date.now() - PROCESS_RETENTION_DAYS * 86_400_000;
  const kept = [];
  for (const [index, record] of records.entries()) {
    const expired = Date.parse(record.startedAt) < cutoff || index >= MAX_PROCESS_RECORDS;
    if (expired && !record.running) {
      for (const target of [record._metaPath, record._statusPath, record._invocationPath, record.stdoutPath, record.stderrPath, processControlPath(record.id)]) {
        try { fs.unlinkSync(target); } catch {}
      }
    } else {
      const publicRecord = { ...record };
      delete publicRecord._metaPath;
      delete publicRecord._statusPath;
      delete publicRecord._invocationPath;
      kept.push(publicRecord);
    }
  }
  return kept;
}

export async function waitProcess(id, { waitMs = DEFAULT_PROCESS_WAIT_MS, lines = 80, signal } = {}) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const match = listProcesses().find((item) => item.id === id);
    if (!match) throw new Error(`unknown bridge-managed process ${id}`);
    if (!match.running) return { ...withProcessLogs(match, lines), waitTimedOut: false };
    if (signal?.aborted) return { ...withProcessLogs(match, lines), waitTimedOut: false, waitCancelled: true };
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const latest = listProcesses().find((item) => item.id === id) || match;
      return { ...withProcessLogs(latest, lines), waitTimedOut: latest.running };
    }
    await delay(Math.min(150, remaining));
  }
}

export function isPidRunning(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopProcess(id) {
  const match = listProcesses().find((item) => item.id === id);
  if (!match) throw new Error(`unknown bridge-managed process ${id}`);
  if (!match.running) return match;
  if (isPidRunning(match.pid) && !isSameProcess(match)) {
    throw new Error(`PID ${match.pid} was reused; refusing to stop an unrelated process`);
  }
  if (isSameProcess(match)) await terminateProcessTree(match.pid, { expectedIdentity: match.identity });
  if (process.platform !== "win32") {
    try { fs.unlinkSync(processControlPath(id)); } catch {}
  }
  writeProcessStatus(id, {
    state: "stopped",
    exitCode: null,
    signal: "SIGTERM",
    finishedAt: nowIso(),
  });
  return listProcesses().find((item) => item.id === id) || { ...match, state: "stopped", running: false, signal: "SIGTERM" };
}

export async function sendProcessInput(id, input, { timeoutMs = 2_000 } = {}) {
  const text = String(input ?? "");
  if (!text) throw new Error("input is required for managed task send_input");
  const deadline = Date.now() + timeoutMs;
  const endpoint = processControlPath(id);

  while (true) {
    const match = listProcesses().find((item) => item.id === id);
    if (!match) throw new Error(`unknown bridge-managed process ${id}`);
    if (!match.running) throw new Error(`managed task ${id} is not running`);
    try {
      await sendControlInput(endpoint, text, Math.max(100, deadline - Date.now()));
      return listProcesses().find((item) => item.id === id) || match;
    } catch (error) {
      const retryable = ["ENOENT", "ECONNREFUSED", "EPIPE"].includes(error?.code);
      if (!retryable || Date.now() >= deadline) throw error;
      await delay(40);
    }
  }
}

export async function terminateProcessTree(pid, { forceAfterMs = 2_000, expectedIdentity = "" } = {}) {
  if (!pid || !isPidRunning(pid)) return;
  if (expectedIdentity && getProcessIdentity(pid) !== expectedIdentity) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T"], { windowsHide: true, encoding: "utf8" });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }
  await delay(Math.min(forceAfterMs, 2_000));
  if (!isPidRunning(pid)) return;
  if (expectedIdentity && getProcessIdentity(pid) !== expectedIdentity) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

export function isSameProcess(meta) {
  if (!meta?.identity || !isPidRunning(meta.pid)) return false;
  return getProcessIdentity(meta.pid) === meta.identity;
}

function capLogFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_PROCESS_LOG_BYTES) return;
    const keepBytes = Math.floor(MAX_PROCESS_LOG_BYTES / 2);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(keepBytes);
    fs.readSync(fd, buffer, 0, keepBytes, stat.size - keepBytes);
    fs.closeSync(fd);
    fs.writeFileSync(filePath, Buffer.concat([Buffer.from("[older bridge log output truncated]\n"), buffer]), { mode: 0o600 });
  } catch {}
}

function withProcessLogs(record, lines) {
  return {
    ...record,
    stdout: tailFile(record.stdoutPath, lines),
    stderr: tailFile(record.stderrPath, lines),
  };
}

function readProcessStatus(statusPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (!["completed", "failed", "stopped"].includes(parsed.state)) return null;
    return {
      state: parsed.state,
      exitCode: Number.isInteger(parsed.exitCode) ? parsed.exitCode : null,
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
      finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null,
      ...(typeof parsed.error === "string" ? { error: clip(parsed.error, 2_000) } : {}),
    };
  } catch {
    return null;
  }
}

function writeProcessStatus(id, status) {
  const statusPath = path.join(PROC_DIR, `${id}.status.json`);
  const tempPath = path.join(PROC_DIR, `.${id}.status.${process.pid}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, statusPath);
}

export function tailFile(filePath, lines = 80, maxBytes = 256_000) {
  if (!fs.existsSync(filePath)) return "";
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const bytes = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
    return buffer.toString("utf8").split(/\r?\n/).slice(-lines).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

function processControlPath(id) {
  if (process.platform === "win32") return `\\\\.\\pipe\\chatgpt-sol-${id}`;
  const key = crypto.createHash("sha256").update(`${PROC_DIR}\0${id}`).digest("hex").slice(0, 24);
  const socketRoot = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return path.join(socketRoot, `chatgpt-sol-${key}.sock`);
}

function sendControlInput(endpoint, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = "";
    const socket = net.createConnection(endpoint);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (response !== "ok") reject(new Error(response || "managed task rejected input"));
      else resolve();
    };
    const timer = setTimeout(() => {
      const error = new Error(`managed task input channel timed out after ${timeoutMs} ms`);
      error.code = "ETIMEDOUT";
      finish(error);
    }, timeoutMs);
    socket.on("connect", () => socket.end(input));
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); });
    socket.on("end", () => finish());
    socket.on("error", finish);
  });
}

export function commandExists(command) {
  const probe = process.platform === "win32"
    ? spawnSync("where.exe", [command], { windowsHide: true, encoding: "utf8" })
    : spawnSync("/bin/sh", ["-lc", `command -v -- ${shellQuote(command)}`], { encoding: "utf8" });
  return probe.status === 0;
}

function getProcessIdentity(pid) {
  try {
    if (process.platform === "win32") {
      const script = `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const binary = commandExists("pwsh") ? "pwsh" : "powershell.exe";
      const result = spawnSync(binary, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, encoding: "utf8" });
      return result.status === 0 ? result.stdout.trim() : "";
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

export function toolEnvironment(overrides = {}) {
  // Tools that write an image for the caller to see must put it somewhere the
  // bridge is allowed to read, and the system temp dir is not. Default them at
  // the scratch directory rather than widening the read boundary.
  const env = { ...process.env, MAC_CONTROL_OUT_DIR: currentScratchDir(), ...(overrides || {}) };
  // Request-local identity must never leak from the server's inherited environment.
  delete env.LOCAL_SYSTEM_CONVERSATION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  const conversationId = currentConversationId();
  if (conversationId) env.LOCAL_SYSTEM_CONVERSATION_ID = conversationId;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const inherited = String(env[pathKey] || "").split(path.delimiter).filter(Boolean);
  const platformFallbacks = platformExecutablePaths().filter(isDirectory);
  env[pathKey] = [...new Set([...TOOL_EXTRA_PATH, ...inherited, ...platformFallbacks])].join(path.delimiter);
  if (TOOL_ENV_INHERIT_SECRETS) return env;
  for (const key of Object.keys(env)) {
    if (TOOL_ENV_ALLOWLIST.has(key)) continue;
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:$|_)/i.test(key)
      || ["MCP_TOKEN", "CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)) {
      delete env[key];
    }
  }
  return env;
}

function platformExecutablePaths() {
  if (process.platform === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin"];
  if (process.platform === "linux") return ["/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
  return [];
}

function isDirectory(candidate) {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

function normalizeCommand(command) {
  if (Array.isArray(command)) {
    if (!command.length) throw new Error("command array is empty");
    return { file: command[0], args: command.slice(1) };
  }
  if (!String(command).trim()) throw new Error("command is empty");
  return { file: String(command), args: [] };
}

function displayCommand(command) {
  return Array.isArray(command) ? command.map(shellQuote).join(" ") : String(command);
}

function boundedCollector(maxChars) {
  let text = "";
  let omitted = 0;
  return {
    push(chunk) {
      text += chunk.toString();
      const hardLimit = maxChars * 2;
      if (text.length > hardLimit) {
        omitted += text.length - maxChars;
        text = text.slice(-maxChars);
      }
    },
    value() {
      const result = clip(text, maxChars, { tail: omitted > 0 });
      return omitted > 0 ? `${result}\n… ${omitted} earlier chars discarded while streaming` : result;
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function cryptoRandom(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function elapsedMs(startedAt, finishedAt) {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;
  return Math.max(0, finish - start);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
