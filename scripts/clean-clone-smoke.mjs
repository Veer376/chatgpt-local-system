#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const source = process.env.CLEAN_CLONE_SOURCE
  ? path.resolve(expandHome(process.env.CLEAN_CLONE_SOURCE))
  : path.resolve(scriptDir, "..");
const parent = process.env.CLEAN_CLONE_WORKSPACE
  ? path.resolve(expandHome(process.env.CLEAN_CLONE_WORKSPACE))
  : fs.mkdtempSync(path.join(os.tmpdir(), "local-system-clean-clone-"));
const createdParent = !process.env.CLEAN_CLONE_WORKSPACE;
const clone = path.join(parent, "repo");
const runtime = path.join(parent, "runtime.env");
const state = path.join(parent, "state");
const scratch = path.join(parent, "scratch");
const serverLog = path.join(parent, "server.log");
let server = null;

try {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  run("git", ["clone", "--quiet", "--no-local", "--depth", "1", source, clone], source);
  run(npmCommand(), ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], clone);
  run(npmCommand(), ["run", "build"], clone);

  const port = await freePort();
  const envText = [
    "HOST=127.0.0.1",
    `PORT=${port}`,
    `WORKSPACE_ROOTS=${clone}`,
    `DEFAULT_WORKSPACE=${clone}`,
    `BRIDGE_STATE_DIR=${state}`,
    `BRIDGE_SCRATCH_DIR=${scratch}`,
    "BYPASS_SECURITY=false",
    "",
  ].join("\n");
  fs.writeFileSync(runtime, envText, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(runtime, 0o600);

  const output = fs.openSync(serverLog, "a");
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: clone,
    env: { ...process.env, BRIDGE_ENV_FILE: runtime, ...parseEnv(envText) },
    stdio: ["ignore", output, output],
  });
  await waitForReady(port, server);
  run(npmCommand(), ["run", "smoke"], clone, { BRIDGE_ENV_FILE: runtime });
  console.log(`Clean-clone smoke passed: clone/install/build/server/MCP roundtrip (${process.platform}/${process.arch})`);
} finally {
  if (server && server.exitCode == null) {
    server.kill("SIGTERM");
    await waitForExit(server, 3_000);
    if (server.exitCode == null) server.kill("SIGKILL");
  }
  if (createdParent && process.env.CLEAN_CLONE_KEEP !== "1") fs.rmSync(parent, { recursive: true, force: true });
  else if (process.env.CLEAN_CLONE_KEEP === "1") console.log(`Clean-clone workspace kept at ${parent}`);
}

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout || ""}`.trim());
  }
  return result.stdout;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseEnv(text) {
  return Object.fromEntries(text.trim().split(/\r?\n/).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForReady(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`clean-clone server exited early; see ${serverLog}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`clean-clone server did not become ready; see ${serverLog}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
