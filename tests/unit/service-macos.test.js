import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(new URL("../../scripts/service-macos.sh", import.meta.url), "utf8");
function fixture(t, mode = "", ngrok = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lifecycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const script = path.join(dir, "service.sh");
  fs.writeFileSync(script, source
    .replace('ENV_FILE="${BRIDGE_ENV_FILE:-$HOME/.config/chatgpt-local-system/runtime.env}"', `ENV_FILE="${dir}/runtime.env"`)
    .replace('PLIST_DIR="$HOME/Library/LaunchAgents"', `PLIST_DIR="${dir}"`)
    .replace('STATE="$HOME/.chatgpt-local-system"', `STATE="${dir}/state"`));
  fs.writeFileSync(path.join(dir, "runtime.env"), "");
  const names = ngrok ? ["server", "tunnel", "ngrok"] : ["server", "tunnel"];
  for (const name of names) fs.writeFileSync(path.join(dir, `com.chatgpt-local-system.${name}.plist`), "fixture");
  const mock = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const dir = process.env.FIXTURE_DIR, args = process.argv.slice(2), tool = path.basename(process.argv[1]);
if (tool === "uname") { console.log("Darwin"); process.exit(0); }
if (tool === "plutil") process.exit(fs.existsSync(args[1]) ? 0 : 1);
if (tool === "node") {
 if (args[0].endsWith("runtime-value.mjs")) console.log({HOST:"127.0.0.1",PORT:"8765",TUNNEL_HEALTH_PORT:"8766"}[args[2]]);
 process.exit(0);
}
fs.appendFileSync(path.join(dir,"calls"), args.join(" ")+"\\n");
const target = args[0] === "bootstrap" ? path.basename(args[2],".plist") : args.at(-1).split("/").at(-1);
const marker = path.join(dir,target+".loaded");
if (args[0] === "print") process.exit(fs.existsSync(marker) ? 0 : 1);
if (args[0] === "bootstrap") fs.writeFileSync(marker, "loaded");
if (args[0] === "bootout") { fs.rmSync(marker,{force:true}); process.exit(0); }
if (args[0] === "kickstart" && process.env.FIXTURE_MODE === "fail") process.exit(7);
if (args[0] === "kickstart" && process.env.FIXTURE_MODE === "interrupt") { process.kill(process.ppid,"SIGTERM"); process.exit(0); }
`;
  for (const name of ["uname", "plutil", "node", "launchctl"]) fs.writeFileSync(path.join(bin, name), mock, { mode: 0o755 });
  return {
    run: (action) => spawnSync("/bin/bash", [script, action], { encoding: "utf8", timeout: 5000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_DIR: dir, FIXTURE_MODE: mode } }),
    calls: () => fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8") : "",
    loaded: () => names.every((name) => fs.existsSync(path.join(dir, `com.chatgpt-local-system.${name}.loaded`))),
    load: () => { for (const name of names) fs.writeFileSync(path.join(dir, `com.chatgpt-local-system.${name}.loaded`), "loaded"); },
  };
}

test("restart restores missing jobs and never unloads either job", (t) => {
  const f = fixture(t);
  const result = f.run("restart");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.loaded(), true);
  assert.doesNotMatch(f.calls(), /bootout/);
  assert.match(f.calls(), /kickstart -k/);
});

test("failed and interrupted restarts retain supervision", (t) => {
  for (const mode of ["fail", "interrupt"]) {
    const f = fixture(t, mode);
    f.load();
    assert.notEqual(f.run("restart").status, 0);
    assert.equal(f.loaded(), true);
    assert.doesNotMatch(f.calls(), /bootout|bootstrap/);
  }
});

test("stop and uninstall require explicit downtime acknowledgement", (t) => {
  const f = fixture(t);
  f.load();
  for (const action of ["stop", "uninstall"]) {
    const result = f.run(action);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--confirm-downtime/);
  }
  assert.equal(f.calls(), "");
  assert.equal(f.loaded(), true);
});

test("install preserves existing descriptors and jobs", (t) => {
  const f = fixture(t);
  f.load();
  assert.equal(f.run("install").status, 2);
  assert.equal(f.calls(), "");
  assert.equal(f.loaded(), true);
});

test("installed ngrok participates in start and restart without unloading", (t) => {
  const f = fixture(t, "", true);
  for (const action of ["start", "restart"]) {
    const result = f.run(action);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.loaded(), true);
  }
  assert.match(f.calls(), /kickstart -k gui\/\d+\/com.chatgpt-local-system.ngrok/);
  assert.doesNotMatch(f.calls(), /bootout/);
});

test("restart recovery restores optional ngrok after another service fails", (t) => {
  const f = fixture(t, "fail", true);
  assert.notEqual(f.run("restart").status, 0);
  assert.equal(f.loaded(), true);
  assert.doesNotMatch(f.calls(), /bootout/);
});
