import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";

const base = fs.mkdtempSync(path.join(os.homedir(), ".sol-patch-feedback-int-"));
const roots = path.join(base, "projects");
const repo = path.join(roots, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });

// `git apply` needs a work tree.
for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"]]) {
  spawnSync("git", args, { cwd: repo });
}
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "repo", scripts: { test: "node --test" } }));
fs.writeFileSync(path.join(repo, "src", "app.js"), ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n") + "\n");
spawnSync("git", ["add", "-A"], { cwd: repo });
spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });

process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.BRIDGE_SCRATCH_DIR = path.join(base, "scratch");
process.env.WORKSPACE_ROOTS = roots;
process.env.DEFAULT_WORKSPACE = "";
process.env.MCP_TOKEN = "patch-secret";
process.env.HOST = "127.0.0.1";
process.env.FILE_PREVIEW_CLOUD_ENABLED = "false";

const { startHttpServer } = await import("../../src/server.js");
const runtime = startHttpServer({ host: "127.0.0.1", port: 0 });
if (!runtime.httpServer.listening) await once(runtime.httpServer, "listening");
const url = `http://127.0.0.1:${runtime.httpServer.address().port}/mcp`;

let nextId = 1;
const meta = { "openai/session": "v1/patch-feedback" };

async function callTool(name, args) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer patch-secret",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args, _meta: meta } }),
  });
  const text = await response.text();
  const line = text.split("\n").find((item) => item.startsWith("data: "));
  const result = JSON.parse(line ? line.slice(6) : text).result;
  if (result && !result.structuredContent && Array.isArray(result.content)) {
    const contentText = result.content.find((b) => b?.type === "text")?.text;
    if (typeof contentText === "string") {
      const match = contentText.match(/```json\s*([\s\S]*?)\s*```/);
      if (match) {
        try {
          result.structuredContent = JSON.parse(match[1]);
        } catch {}
      }
    }
  }
  return result;
}

const textOf = (result) => (result.content || []).map((item) => item.text).join("\n");

test.after(async () => {
  await runtime.shutdown("test");
  fs.rmSync(base, { recursive: true, force: true });
});

test("workspace opens before patching", async () => {
  const opened = await callTool("workspace", { action: "open", path: repo });
  assert.equal(opened.structuredContent.currentProjectWorkspace, fs.realpathSync(repo));
});

test("a failing patch returns the file's real content, so a retry needs no extra call", async () => {
  // Context claims "const b = 99;" but the file says "const b = 2;".
  const badPatch = [
    "diff --git a/src/app.js b/src/app.js",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -2,2 +2,2 @@",
    "-const b = 99;",
    "+const b = 42;",
    " const c = 3;",
    "",
  ].join("\n");

  const result = await callTool("apply_patch", { input: badPatch });
  assert.equal(result.isError, true, "the patch is rejected");

  const message = textOf(result);
  assert.match(message, /src\/app\.js around line 2 actually contains/, "says where it looked");
  assert.match(message, /2: const b = 2;/, "and what is actually there, with the line number");

  assert.equal(result.structuredContent.status, "failed");
  assert.equal(result.structuredContent.files[0].exists, true);
  assert.equal(result.structuredContent.files[0].hunks[0].expectedStart, 2);

  // Nothing was written.
  assert.match(fs.readFileSync(path.join(repo, "src", "app.js"), "utf8"), /const b = 2;/);
});

test("the reported content is enough to build a patch that applies", async () => {
  // Built only from what the previous failure reported.
  const goodPatch = [
    "diff --git a/src/app.js b/src/app.js",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -2,2 +2,2 @@",
    "-const b = 2;",
    "+const b = 42;",
    " const c = 3;",
    "",
  ].join("\n");

  const result = await callTool("apply_patch", { input: goodPatch });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(result.structuredContent.status, "applied");
  assert.match(fs.readFileSync(path.join(repo, "src", "app.js"), "utf8"), /const b = 42;/);
});

test("a successful patch reports how to verify it", async () => {
  const result = await callTool("apply_patch", {
    input: [
      "diff --git a/src/app.js b/src/app.js",
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "@@ -4 +4 @@",
      "-const d = 4;",
      "+const d = 5;",
      "",
    ].join("\n"),
  });
  assert.notEqual(result.isError, true, textOf(result));
  assert.match(result.structuredContent.verifyWith, /^npm run test/, "the project's own test script is reported");
  assert.match(textOf(result), /Verify with: npm run test/, "the command is in the text, not only the structured payload");
});

test("a patch against a missing file explains that rather than failing opaquely", async () => {
  const result = await callTool("apply_patch", {
    input: [
      "diff --git a/src/ghost.js b/src/ghost.js",
      "--- a/src/ghost.js",
      "+++ b/src/ghost.js",
      "@@ -1,2 +1,2 @@",
      "-gone",
      "+here",
      " tail",
      "",
    ].join("\n"),
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.malformed, false, "this patch is well-formed; the file is the problem");
  assert.match(textOf(result), /src\/ghost\.js: does not exist/);
});

test("a malformed patch is reported as malformed, not as a context mismatch", async () => {
  // Header claims 3 old lines but supplies 1; the context line itself is correct.
  const result = await callTool("apply_patch", {
    input: [
      "diff --git a/src/app.js b/src/app.js",
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "@@ -1,3 +1,3 @@",
      "-const a = 1;",
      "+const a = 9;",
      "",
    ].join("\n"),
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.malformed, true);
  const message = textOf(result);
  assert.match(message, /patch text is malformed/);
  assert.doesNotMatch(message, /actually contains/, "must not blame the file's context, which is correct here");
});

test("a long command returns a managed task instead of being killed", async () => {
  const result = await callTool("execute_command", { command: "sleep 5", cwd: repo, waitMs: 0 });
  assert.equal(result.structuredContent.running, true);
  const taskId = result.structuredContent.taskId;
  assert.match(taskId || "", /^p_[A-Za-z0-9_]+$/);
  try {
    const message = textOf(result);
    assert.match(message, /still running as task/i);
  } finally {
    await callTool("manage_task", { action: "kill", taskId });
  }
});

test("a failing command still reports its exit code and stderr", async () => {
  const result = await callTool("execute_command", {
    command: "node -e \"console.error('detail'); process.exit(3)\"",
    cwd: repo,
  });
  assert.equal(result.structuredContent.exitCode, 3);
  assert.equal(result.structuredContent.ok, false);
  assert.match(result.structuredContent.stderr, /detail/);
  assert.match(textOf(result), /exit code 3/);
});
