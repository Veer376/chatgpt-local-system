#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

const requested = process.env.BRIDGE_ENV_FILE || defaultRuntimeEnv();
const candidates = [requested];
if (!process.env.BRIDGE_ENV_FILE) candidates.push(path.resolve(".env"));
const selected = candidates.find((candidate) => fs.existsSync(candidate));

if (selected) {
  const parsed = dotenv.parse(fs.readFileSync(selected));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  process.env.BRIDGE_ENV_FILE = selected;
} else {
  process.env.BRIDGE_ENV_FILE ||= requested;
}

await import("../src/doctor.js");

function defaultRuntimeEnv() {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "chatgpt-local-system", "runtime.env")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "chatgpt-local-system", "runtime.env");
}
