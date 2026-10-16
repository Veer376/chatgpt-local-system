#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { commandExists } from "./lib/exec.js";
import { httpUrl } from "./lib/net.js";
import { canonicalPath, isWithin } from "./lib/paths.js";
import { EXPECTED_TOOL_NAMES } from "./tool-contract.js";

const runtimeEnvFile = loadRuntimeEnvironment();
const {
  APP_NAME,
  APP_VERSION,
  DEFAULT_WORKSPACE,
  HOST,
  MCP_TOKEN,
  PORT,
  STATE_DIR,
  configuredProjectRoots,
  ensureStateDirs,
  validateRuntimeConfig,
} = await import("./lib/config.js");

const checks = [];
const check = (name, status, detail, required = false) => checks.push({
  name,
  status,
  detail: redactSecrets(String(detail ?? "")),
  required,
});

const major = Number(process.versions.node.split(".")[0]);
check("Node.js", major >= 20 ? "pass" : "fail", process.version, true);
checkRuntimeEnv();
try {
  validateRuntimeConfig();
  check("runtime config", "pass", `HOST=${HOST} PORT=${PORT} auth=${MCP_TOKEN ? "bearer" : "loopback-only"}`, true);
} catch (error) {
  check("runtime config", "fail", error.message, true);
}
try {
  ensureStateDirs();
  const probe = path.join(STATE_DIR, `.doctor-${process.pid}`);
  fs.writeFileSync(probe, "ok", { mode: 0o600 });
  fs.unlinkSync(probe);
  check("state directory", "pass", STATE_DIR, true);
} catch (error) {
  check("state directory", "fail", error.message, true);
}

const roots = configuredProjectRoots();
check("workspace roots", roots.length > 0 ? "pass" : "fail", roots.length ? roots.join(path.delimiter) : "none configured; set WORKSPACE_ROOTS", true);
if (DEFAULT_WORKSPACE) {
  let defaultValid = false;
  try {
    const target = canonicalPath(DEFAULT_WORKSPACE);
    defaultValid = roots.some((root) => isWithin(target, canonicalPath(root)));
  } catch {}
  check("default workspace", defaultValid ? "pass" : "fail", DEFAULT_WORKSPACE, true);
} else {
  check("default workspace", "warn", "not set; call workspace with action=open before project work");
}

for (const binary of ["git", "tunnel-client"]) {
  check(binary, commandExists(binary) ? "pass" : "fail", commandExists(binary) ? version(binary) : "not found", true);
}
for (const binary of ["rg", "codex", "interceptor"]) {
  check(binary, commandExists(binary) ? "pass" : "warn", commandExists(binary) ? version(binary) : "optional");
}

check("tool contract", EXPECTED_TOOL_NAMES.length > 0 ? "pass" : "fail", `${EXPECTED_TOOL_NAMES.length} exposed tools`, true);
check("host", "pass", `${os.hostname()} ${process.platform}/${process.arch}`);
const tunnelId = process.env.CONTROL_PLANE_TUNNEL_ID || "";
const tunnelKey = process.env.CONTROL_PLANE_API_KEY || "";
check("tunnel id", tunnelId && !tunnelId.includes("REPLACE_ME") ? "pass" : "warn", tunnelId ? "configured" : "not present in this environment");
check("tunnel key", tunnelKey && !tunnelKey.includes("REPLACE_ME") ? "pass" : "warn", tunnelKey ? "configured (redacted)" : "not present in this environment");
const tunnelMode = process.argv.includes("--tunnel");
const tunnelProfile = process.env.TUNNEL_PROFILE || "sol-local-bridge";
if (commandExists("tunnel-client")) {
  const profilesResult = spawnSync("tunnel-client", ["profiles", "list", "--json"], { encoding: "utf8", timeout: 10_000 });
  let profileFound = false;
  try {
    const profiles = JSON.parse(profilesResult.stdout || "[]");
    profileFound = profiles.some((item) => (typeof item === "string" ? item : item.name || item.profile) === tunnelProfile);
  } catch {}
  check("tunnel profile", profileFound ? "pass" : tunnelMode ? "fail" : "warn", profileFound ? tunnelProfile : `${tunnelProfile} not found`, tunnelMode);
  if (tunnelMode && profileFound) {
    const result = spawnSync("tunnel-client", ["doctor", "--profile", tunnelProfile, "--explain"], { encoding: "utf8", timeout: 60_000, env: process.env });
    check("tunnel doctor", result.status === 0 ? "pass" : "fail", (result.status === 0 ? result.stdout : result.stderr || result.stdout).trim().slice(0, 500), true);
  }
}

const extensionOrigins = String(process.env.LOCAL_EXTENSION_ORIGIN || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!extensionOrigins.length) {
  check("extension origin", "warn", "not configured; required only for the Chrome/Safari companion extension");
} else {
  const invalid = extensionOrigins.filter((origin) => !/^(?:chrome-extension:\/\/[a-p]{32}|safari-web-extension:\/\/[A-Za-z0-9.-]+)$/.test(origin));
  check("extension origin", invalid.length ? "fail" : "pass", invalid.length ? "invalid LOCAL_EXTENSION_ORIGIN value" : `${extensionOrigins.length} allowed origin(s)`, invalid.length > 0);
}

const liveRequired = process.argv.includes("--live");
await checkBridgeStatus(liveRequired);
await checkTunnelStatus(tunnelMode);

const jsonMode = process.argv.includes("--json");
if (jsonMode) console.log(JSON.stringify({ name: APP_NAME, version: APP_VERSION, checks }, null, 2));
else {
  console.log(`${APP_NAME} doctor ${APP_VERSION}`);
  for (const item of checks) {
    const icon = item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "✗";
    console.log(`${icon} ${item.name.padEnd(24)} ${item.detail}`);
  }
}
const failed = checks.filter((item) => item.required && item.status === "fail");
if (failed.length) process.exitCode = 1;

function version(binary) {
  const probes = [["--version"], ["-version"], ["version"]];
  for (const args of probes) {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
    const text = `${result.stdout || ""}${result.stderr || ""}`.trim().split(/\r?\n/)[0];
    if (text) return text.slice(0, 160);
  }
  return "found";
}

function defaultRuntimeEnv() {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "chatgpt-local-system", "runtime.env")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "chatgpt-local-system", "runtime.env");
}

function loadRuntimeEnvironment() {
  const requested = process.env.BRIDGE_ENV_FILE || defaultRuntimeEnv();
  const candidates = [requested];
  if (!process.env.BRIDGE_ENV_FILE) candidates.push(path.resolve(".env"));
  const selected = candidates.find((candidate) => fs.existsSync(candidate));
  if (!selected) return requested;
  const parsed = dotenv.parse(fs.readFileSync(selected));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  process.env.BRIDGE_ENV_FILE ||= selected;
  return selected;
}

function checkRuntimeEnv() {
  if (!fs.existsSync(runtimeEnvFile)) {
    check("runtime.env", "fail", `missing ${runtimeEnvFile}; run the setup guide first`, true);
    return;
  }
  try {
    const stat = fs.statSync(runtimeEnvFile);
    if (!stat.isFile()) {
      check("runtime.env", "fail", `${runtimeEnvFile} is not a regular file`, true);
      return;
    }
    if (process.platform === "win32") {
      check("runtime.env", "pass", `${runtimeEnvFile} readable; Windows ACLs are not automatically audited`);
      return;
    }
    const mode = stat.mode & 0o777;
    const ownerOk = typeof process.getuid !== "function" || stat.uid === process.getuid();
    const privateMode = (mode & 0o077) === 0;
    check(
      "runtime.env",
      ownerOk && privateMode ? "pass" : "fail",
      ownerOk && privateMode
        ? `${runtimeEnvFile} permissions ${mode.toString(8).padStart(3, "0")}`
        : `${runtimeEnvFile} must be owned by the current user and not readable/writable by group or others`,
      true,
    );
  } catch (error) {
    check("runtime.env", "fail", error.message, true);
  }
}

async function checkBridgeStatus(required) {
  const url = httpUrl(HOST, PORT, "/readyz");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const body = await response.json();
    const valid = response.ok && body.toolCount === EXPECTED_TOOL_NAMES.length;
    check("bridge status", valid ? "pass" : "fail", valid ? `running on ${HOST}:${PORT}; ${body.toolCount} tools` : `unexpected readiness response on ${HOST}:${PORT}`, required || !valid);
  } catch {
    const occupied = await tcpListening(HOST, PORT);
    if (occupied) check("bridge status", "fail", `port ${PORT} is occupied but Local System readiness failed`, true);
    else check("bridge status", required ? "fail" : "warn", `not running on ${HOST}:${PORT}`, required);
  }
}

async function checkTunnelStatus(required) {
  const tunnelPort = integerEnv("TUNNEL_HEALTH_PORT", 8766);
  try {
    const response = await fetch(httpUrl("127.0.0.1", tunnelPort, "/readyz"), { signal: AbortSignal.timeout(2_000) });
    const text = (await response.text()).trim();
    const valid = response.ok && text === "ready";
    check("tunnel status", valid ? "pass" : "fail", valid ? `local tunnel client ready on 127.0.0.1:${tunnelPort}` : `unexpected health response on 127.0.0.1:${tunnelPort}`, required || !valid);
  } catch {
    const occupied = await tcpListening("127.0.0.1", tunnelPort);
    if (occupied) check("tunnel status", "fail", `health port ${tunnelPort} is occupied but tunnel readiness failed`, true);
    else check("tunnel status", required ? "fail" : "warn", `not running on 127.0.0.1:${tunnelPort}`, required);
  }
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
}

function tcpListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(900, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function redactSecrets(value) {
  let output = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (!/(?:TOKEN|KEY|SECRET|PASSWORD|AUTHTOKEN)/i.test(name) || !secret || secret.length < 6) continue;
    output = output.split(secret).join("<redacted>");
  }
  return output
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer <redacted>");
}
