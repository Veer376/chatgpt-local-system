import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-exec-test-"));
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.BRIDGE_SCRATCH_DIR = path.join(base, "scratch");
process.env.WORKSPACE_ROOTS = base;
const extraBinOne = path.join(base, "extra-bin-one");
const extraBinTwo = path.join(base, "extra-bin-two");
fs.mkdirSync(extraBinOne);
fs.mkdirSync(extraBinTwo);
process.env.TOOL_EXTRA_PATH = [extraBinOne, extraBinTwo].join(path.delimiter);
const exec = await import("../../src/lib/exec.js");
const { currentScratchDir } = await import("../../src/lib/config.js");
const { runWithConversationId } = await import("../../src/lib/conversation.js");

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("tool child environments strip secret-like variables by default", () => {
  process.env.BRIDGE_TEST_API_KEY = "must-not-leak";
  process.env.CONTROL_PLANE_API_KEY = "tunnel-secret";
  process.env.BRIDGE_TEST_NORMAL = "visible";
  const childEnv = exec.toolEnvironment();
  assert.equal(childEnv.BRIDGE_TEST_API_KEY, undefined);
  assert.equal(childEnv.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(childEnv.BRIDGE_TEST_NORMAL, "visible");
  delete process.env.BRIDGE_TEST_API_KEY;
  delete process.env.CONTROL_PLANE_API_KEY;
  delete process.env.BRIDGE_TEST_NORMAL;
});

test("tool child environments prepend configured executable directories without replacing PATH", () => {
  const inherited = path.join(base, "inherited-bin");
  const childEnv = exec.toolEnvironment({ PATH: [inherited, extraBinOne].join(path.delimiter) });
  const entries = childEnv.PATH.split(path.delimiter);
  assert.deepEqual(entries.slice(0, 3), [extraBinOne, extraBinTwo, inherited]);
  if (process.platform === "darwin") {
    for (const candidate of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (fs.existsSync(candidate)) assert.ok(entries.includes(candidate), `expected ${candidate} in tool PATH`);
    }
  }
});

test("tool child environments use the calling conversation's scratch directory", () => {
  const outputDir = runWithConversationId("v1/tool-env", () => exec.toolEnvironment().MAC_CONTROL_OUT_DIR);
  const expected = runWithConversationId("v1/tool-env", () => currentScratchDir());
  assert.equal(outputDir, expected);
});

test("conversation identity overrides inherited identity without mutating process.env", () => {
  const previous = process.env.LOCAL_SYSTEM_CONVERSATION_ID;
  process.env.LOCAL_SYSTEM_CONVERSATION_ID = "stale-server-identity";
  try {
    const overrides = { LOCAL_SYSTEM_CONVERSATION_ID: "override", CODEX_THREAD_ID: "server-thread", CODEX_SESSION_ID: "server-session" };
    const env = runWithConversationId("request-a", () => exec.toolEnvironment(overrides));
    assert.equal(env.LOCAL_SYSTEM_CONVERSATION_ID, "request-a");
    assert.equal(env.CODEX_THREAD_ID, undefined);
    assert.equal(env.CODEX_SESSION_ID, undefined);
    assert.equal(process.env.LOCAL_SYSTEM_CONVERSATION_ID, "stale-server-identity");
    assert.equal(exec.toolEnvironment().LOCAL_SYSTEM_CONVERSATION_ID, undefined);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_SYSTEM_CONVERSATION_ID;
    else process.env.LOCAL_SYSTEM_CONVERSATION_ID = previous;
  }
});

test("concurrent conversation identities reach bounded and managed subprocesses", async () => {
  const command = [process.execPath, "-e", "console.log(process.env.LOCAL_SYSTEM_CONVERSATION_ID || 'missing')"];
  const results = await Promise.all(["conversation-a", "conversation-b"].map((id) =>
    runWithConversationId(id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const bounded = await exec.runCommand(command, { cwd: base, shell: false });
      const managed = exec.startProcess(command, { cwd: base, shell: false });
      const completed = await exec.waitProcess(managed.id, { waitMs: 3_000 });
      assert.equal(bounded.code, 0);
      assert.equal(completed.exitCode, 0);
      assert.equal(bounded.stdout.trim(), id);
      assert.equal(completed.stdout.trim(), id);
      return id;
    })));
  assert.deepEqual(results, ["conversation-a", "conversation-b"]);
  const unscoped = await exec.runCommand(command, { cwd: base, shell: false });
  assert.equal(unscoped.stdout.trim(), "missing");
});

test("AbortSignal cancels bounded commands", async () => {
  const controller = new AbortController();
  const running = exec.runCommand([process.execPath, "-e", "setTimeout(()=>{}, 4000)"], { cwd: base, signal: controller.signal, timeoutMs: 10_000 });
  setTimeout(() => controller.abort(), 100);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
});

test("bounded POSIX commands terminate their descendant process group on timeout", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  const result = await exec.runCommand("sleep 4 & wait", { cwd: base, timeoutMs: 250 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3_000, `timeout took ${Date.now() - started}ms`);
});

test("process supervisor tracks, logs, and stops only bridge-owned processes", async () => {
  const meta = exec.startProcess([process.execPath, "-e", "console.log('ready'); setInterval(()=>{}, 1000)"], { cwd: base, shell: false });
  try {
    await waitFor(() => exec.listProcesses().find((item) => item.id === meta.id)?.running, 3_000);
    await waitFor(() => exec.tailFile(meta.stdoutPath).includes("ready"), 3_000);
    assert.match(exec.tailFile(meta.stdoutPath), /ready/);
    const stopped = await exec.stopProcess(meta.id);
    assert.equal(stopped.id, meta.id);
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.running, false);
    await waitFor(() => !exec.isPidRunning(meta.pid), 4_000);
  } finally {
    if (exec.isPidRunning(meta.pid)) await exec.terminateProcessTree(meta.pid);
  }
  await assert.rejects(() => exec.stopProcess("not-managed"), /unknown bridge-managed process/);
});

test("waitProcess times out without terminating the process, then returns durable completion", async () => {
  const meta = exec.startProcess([
    process.execPath,
    "-e",
    "console.log('started'); setTimeout(() => { console.log('finished'); }, 450)",
  ], { cwd: base, shell: false });

  const first = await exec.waitProcess(meta.id, { waitMs: 100 });
  assert.equal(first.state, "running");
  assert.equal(first.running, true);
  assert.equal(first.waitTimedOut, true);
  assert.equal(exec.isPidRunning(meta.pid), true);

  const completed = await exec.waitProcess(meta.id, { waitMs: 3_000 });
  assert.equal(completed.state, "completed");
  assert.equal(completed.running, false);
  assert.equal(completed.waitTimedOut, false);
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.signal, null);
  assert.match(completed.stdout, /started/);
  assert.match(completed.stdout, /finished/);
  assert.equal(typeof completed.finishedAt, "string");
  assert.equal(typeof completed.durationMs, "number");
  assert.ok(completed.durationMs >= 0);

  const persisted = exec.listProcesses().find((item) => item.id === meta.id);
  assert.equal(persisted?.state, "completed");
  assert.equal(persisted?.exitCode, 0);
});

test("managed process stdin remains writable after the starter returns", async () => {
  const meta = exec.startProcess([
    process.execPath,
    "-e",
    "process.stdin.setEncoding('utf8'); process.stdin.once('data', data => { console.log('input:' + data.trim()); process.exit(0); });",
  ], { cwd: base, shell: false });
  try {
    await waitFor(() => exec.listProcesses().find((item) => item.id === meta.id)?.running, 3_000);
    await exec.sendProcessInput(meta.id, "hello-managed-task\n");
    const completed = await exec.waitProcess(meta.id, { waitMs: 3_000 });
    assert.equal(completed.state, "completed");
    assert.equal(completed.exitCode, 0);
    assert.match(completed.stdout, /input:hello-managed-task/);
  } finally {
    if (exec.isPidRunning(meta.pid)) await exec.terminateProcessTree(meta.pid);
  }
});

test("managed process failures retain their exit code", async () => {
  const meta = exec.startProcess([
    process.execPath,
    "-e",
    "console.error('expected failure'); process.exit(7)",
  ], { cwd: base, shell: false });
  const failed = await exec.waitProcess(meta.id, { waitMs: 3_000 });
  assert.equal(failed.state, "failed");
  assert.equal(failed.running, false);
  assert.equal(failed.exitCode, 7);
  assert.match(failed.stderr, /expected failure/);
});

test("managed process completion survives the process that started it", async () => {
  const execModuleUrl = pathToFileURL(path.resolve("src/lib/exec.js")).href;
  const starter = [
    `import { startProcess } from ${JSON.stringify(execModuleUrl)};`,
    `const meta = startProcess([process.execPath, "-e", "setTimeout(() => console.log('restart-safe'), 300)"], { cwd: ${JSON.stringify(base)}, shell: false });`,
    "console.log(meta.id);",
  ].join("\n");
  const launched = spawnSync(process.execPath, ["--input-type=module", "-e", starter], {
    cwd: path.resolve("."),
    env: process.env,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(launched.status, 0, launched.stderr);
  const id = launched.stdout.trim().split(/\r?\n/).at(-1);
  assert.match(id || "", /^p_[A-Za-z0-9_]+$/);

  const completed = await exec.waitProcess(id, { waitMs: 3_000 });
  assert.equal(completed.state, "completed");
  assert.equal(completed.exitCode, 0);
  assert.match(completed.stdout, /restart-safe/);
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition timed out");
}

test("runCommand with nonexistent cwd fails gracefully without throwing", async () => {
  const badCwd = path.join(os.tmpdir(), "nonexistent-" + Date.now());
  const result = await exec.runCommand("echo test", { cwd: badCwd });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /working directory does not exist/);
});

test("startProcess with nonexistent cwd rejects synchronously without crashing the process", () => {
  const badCwd = path.join(os.tmpdir(), "nonexistent-" + Date.now());
  assert.throws(
    () => exec.startProcess("echo test", { cwd: badCwd }),
    /working directory does not exist/
  );
});
