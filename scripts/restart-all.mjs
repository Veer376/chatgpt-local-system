#!/usr/bin/env node
/**
 * restart-all.mjs
 *
 * Idempotent restart for the full chatgpt-local-system stack (server + tunnel).
 *
 * On macOS with installed LaunchAgents, delegate to service-macos.sh restart.
 * This preserves supervision and never enters the foreground cleanup below.
 * Behaviour without installed LaunchAgents:
 *   - If nothing is running  → start everything (same as start-all.mjs).
 *   - If already running     → gracefully kill all existing server/tunnel
 *     processes and all processes holding the server port, then start fresh.
 *
 * Killing strategy (defense-in-depth, works even if the parent start-all.mjs
 * process is gone):
 *   1. SIGTERM any process whose command line contains "src/server.js",
 *      "run-tunnel.mjs", "start-all.mjs", or whose binary is "tunnel-client".
 *   2. SIGTERM any process listening on the configured PORT.
 *   3. Wait up to 4 s for the port to free; then SIGKILL stragglers if needed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { delegateToLaunchAgents } from "./macos-supervision.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supervised = delegateToLaunchAgents(repo, "restart");
if (supervised !== null) process.exit(supervised);
const envFile = process.env.BRIDGE_ENV_FILE || defaultEnvPath();
if (!fs.existsSync(envFile)) throw new Error(`runtime env file not found: ${envFile}`);
verifySecretFile(envFile);
const env = { ...process.env, ...dotenv.parse(fs.readFileSync(envFile)) };
const port = Number(env.PORT || 8765);
const profile = env.TUNNEL_PROFILE || "sol-local-bridge";
const serverEnv = { ...env };
delete serverEnv.CONTROL_PLANE_API_KEY;

// ─── Step 1: kill existing system processes ──────────────────────────────────

console.log("→ Stopping any running chatgpt-local-system processes…");

const killed = new Set();

/** Send signal to a PID. Returns true if the process existed and was signalled. */
function signalPid(pid, signal = "SIGTERM") {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Find PIDs by port (lsof -ti TCP:<port>)
function pidsOnPort(p) {
  if (process.platform === "win32") return pidsOnPortWindows(p);
  const result = spawnSync("lsof", ["-ti", `TCP:${p}`], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  return result.stdout
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

function pidsOnPortWindows(p) {
  const result = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const pids = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.includes(`:${p} `) && line.includes("LISTENING")) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid > 0) pids.add(pid);
    }
  }
  return [...pids];
}

// Find PIDs matching a command-line pattern (pgrep -f)
function pgrepF(pattern) {
  if (process.platform === "win32") return [];
  const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  return result.stdout
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

const patterns = [
  "src/server.js",
  "src/stdio.js",
  "scripts/run-tunnel.mjs",
  "scripts/start-all.mjs",
  "tunnel-client run --profile",
  "ngrok.*chatgpt-local-system",
  "ngrok.*8765",
];

for (const pattern of patterns) {
  for (const pid of pgrepF(pattern)) {
    if (!killed.has(pid)) {
      console.log(`  sending SIGTERM to PID ${pid} (matched: ${pattern})`);
      signalPid(pid, "SIGTERM");
      killed.add(pid);
    }
  }
}

for (const pid of pidsOnPort(port)) {
  if (!killed.has(pid)) {
    console.log(`  sending SIGTERM to PID ${pid} (holding port ${port})`);
    signalPid(pid, "SIGTERM");
    killed.add(pid);
  }
}

if (killed.size === 0) {
  console.log("  nothing was running – starting fresh.");
} else {
  console.log(`  sent SIGTERM to ${killed.size} process(es); waiting for port ${port} to clear…`);
}

// ─── Step 2: wait for port to free, SIGKILL if stubborn ──────────────────────

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portIsFree(p) {
  return pidsOnPort(p).length === 0;
}

const deadline = Date.now() + 4_000;
while (!portIsFree(port) && Date.now() < deadline) {
  await sleep(250);
}

if (!portIsFree(port)) {
  console.log(`  port ${port} still occupied; sending SIGKILL to stragglers…`);
  for (const pid of pidsOnPort(port)) {
    console.log(`  SIGKILL → PID ${pid}`);
    signalPid(pid, "SIGKILL");
  }
  await sleep(500);
}

if (!portIsFree(port)) {
  throw new Error(`port ${port} is still in use after kill attempts; aborting`);
}

console.log(`✓ port ${port} is free`);

// ─── Step 3: start server + tunnel (same as start-all.mjs) ───────────────────

console.log("→ Starting chatgpt-local-system…\n");

function findNgrokBin() {
  if (process.env.NGROK_BIN && fs.existsSync(process.env.NGROK_BIN)) return process.env.NGROK_BIN;
  const candidates = [
    "/opt/homebrew/bin/ngrok",
    "/usr/local/bin/ngrok",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "ngrok";
}

const ngrokConfigFile = path.join(os.homedir(), ".config", "chatgpt-local-system", "ngrok.yml");

const children = [
  {
    name: "server",
    proc: spawn(process.execPath, [path.join(repo, "src", "server.js")], {
      cwd: repo,
      env: serverEnv,
      stdio: "inherit",
      shell: false,
    }),
  },
  {
    name: "tunnel",
    proc: spawn(
      process.execPath,
      [
        path.join(repo, "scripts", "run-tunnel.mjs"),
        env.TUNNEL_CLIENT_BIN || "tunnel-client",
      ],
      {
        cwd: repo,
        env: { ...env, TUNNEL_PROFILE: profile },
        stdio: "inherit",
        shell: false,
      },
    ),
  },
];

if (fs.existsSync(ngrokConfigFile)) {
  console.log("→ Starting dedicated ngrok tunnel (local-system)…");
  children.push({
    name: "ngrok",
    proc: spawn(
      findNgrokBin(),
      [
        "start",
        "--config", ngrokConfigFile,
        "local-system",
        "--log=stdout",
      ],
      {
        cwd: repo,
        env: process.env,
        stdio: "inherit",
        shell: false,
      },
    ),
  });
}

let closing = false;
const shutdown = (signal = "SIGTERM") => {
  if (closing) return;
  closing = true;
  for (const child of children) child.proc.kill(signal);
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => shutdown(signal));

for (const child of children) {
  child.proc.on("error", (error) => {
    console.error(`[restart-all] child [${child.name}] error: ${error.message}`);
    process.exitCode = 1;
    shutdown();
  });
  child.proc.on("exit", (code, signal) => {
    if (!closing) {
      console.error(`[restart-all] child [${child.name}] exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`);
      process.exitCode = code || 1;
      shutdown();
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function verifySecretFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${filePath} must be a regular, non-symlink file`);
  }
  if (
    typeof process.getuid === "function" &&
    (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
  ) {
    throw new Error(`${filePath} must be owned by the current user and mode 0600`);
  }
}

function defaultEnvPath() {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || os.homedir(),
      "chatgpt-local-system",
      "runtime.env",
    );
  }
  return path.join(os.homedir(), ".config", "chatgpt-local-system", "runtime.env");
}
