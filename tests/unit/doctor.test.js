import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeKeys = [
  "HOST", "PORT", "WORKSPACE_ROOTS", "DEFAULT_WORKSPACE", "BRIDGE_STATE_DIR",
  "TUNNEL_PROFILE", "TUNNEL_HEALTH_PORT", "LOCAL_EXTENSION_ORIGIN",
  "CONTROL_PLANE_TUNNEL_ID", "CONTROL_PLANE_API_KEY", "MCP_TOKEN", "BYPASS_SECURITY",
];

function cleanEnv() {
  const env = { ...process.env };
  for (const key of runtimeKeys) delete env[key];
  return env;
}

test("doctor loads runtime.env and never prints configured secrets", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-system-doctor-"));
  try {
    const bin = path.join(dir, "bin");
    const workspace = path.join(dir, "workspace");
    const state = path.join(dir, "state");
    fs.mkdirSync(bin);
    fs.mkdirSync(workspace);
    const tunnel = path.join(bin, "tunnel-client");
    fs.writeFileSync(tunnel, `#!/bin/sh
if [ "$1" = "profiles" ]; then printf '["test-profile"]'; exit 0; fi
if [ "$1" = "doctor" ]; then printf 'doctor-ok'; exit 0; fi
printf 'tunnel-client test\n'
`, { mode: 0o755 });
    const secret = "test-secret-never-print-1234567890";
    const envFile = path.join(dir, "runtime.env");
    fs.writeFileSync(envFile, [
      "HOST=127.0.0.1",
      "PORT=49191",
      `WORKSPACE_ROOTS=${workspace}`,
      `DEFAULT_WORKSPACE=${workspace}`,
      `BRIDGE_STATE_DIR=${state}`,
      "TUNNEL_PROFILE=test-profile",
      "TUNNEL_HEALTH_PORT=49192",
      "LOCAL_EXTENSION_ORIGIN=chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_test",
      `CONTROL_PLANE_API_KEY=${secret}`,
      `MCP_TOKEN=${secret}`,
      "BYPASS_SECURITY=false",
      "",
    ].join("\n"), { mode: 0o600 });

    const result = spawnSync(process.execPath, ["scripts/doctor.mjs", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...cleanEnv(),
        BRIDGE_ENV_FILE: envFile,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    const report = JSON.parse(result.stdout);
    const byName = Object.fromEntries(report.checks.map((item) => [item.name, item]));
    assert.equal(byName["runtime.env"].status, "pass");
    assert.equal(byName["workspace roots"].status, "pass");
    assert.equal(byName["extension origin"].status, "pass");
    assert.equal(byName["bridge status"].status, "warn");
    assert.equal(byName["tunnel status"].status, "warn");
    assert.equal(byName["tunnel key"].detail, "configured (redacted)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor rejects a runtime.env readable by other users", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-system-doctor-mode-"));
  try {
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace);
    const envFile = path.join(dir, "runtime.env");
    fs.writeFileSync(envFile, `WORKSPACE_ROOTS=${workspace}\nDEFAULT_WORKSPACE=${workspace}\n`, { mode: 0o644 });
    fs.chmodSync(envFile, 0o644);
    const result = spawnSync(process.execPath, ["scripts/doctor.mjs", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...cleanEnv(), BRIDGE_ENV_FILE: envFile },
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    const config = report.checks.find((item) => item.name === "runtime.env");
    assert.equal(config.status, "fail");
    assert.match(config.detail, /must be owned by the current user/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
