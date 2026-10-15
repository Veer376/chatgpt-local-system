import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeWorkspaceWatchersForTests,
  waitForWorkspaceChange,
} from "../../src/lib/workspace-watch.js";

test.afterEach(() => {
  closeWorkspaceWatchersForTests();
});

test("workspace watcher emits debounced nested file changes with absolute and relative paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-system-watch-"));
  const nested = path.join(root, "src");
  fs.mkdirSync(nested);
  try {
    const pending = waitForWorkspaceChange(root, { since: 0, timeoutMs: 3_000 });
    await delay(60);
    const file = path.join(nested, "index.js");
    fs.writeFileSync(file, "export const value = 1;\n");
    const result = await pending;

    assert.equal(result.changed, true);
    assert.ok(result.version >= 1);
    assert.equal(result.workspace, fs.realpathSync(root));
    const reported = result.event.paths.map(normalize);
    const canonicalFile = normalize(fs.realpathSync(file));
    assert.ok(reported.some((candidate) => canonicalFile === candidate || canonicalFile.startsWith(candidate + "/")));
    assert.ok(result.event.relativePaths.some((value) => value === "src" || value === "src/index.js"));
    assert.equal(result.event.gitOnly, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace watcher classifies .git-only changes separately from project files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-system-watch-git-"));
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(gitDir);
  try {
    const pending = waitForWorkspaceChange(root, { since: 0, timeoutMs: 3_000 });
    await delay(60);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    const result = await pending;

    assert.equal(result.changed, true);
    assert.equal(result.event.gitOnly, true);
    assert.ok(result.event.relativePaths.some((value) => value === ".git" || value.startsWith(".git/")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace watcher ignores transient Git index lock churn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-system-watch-git-lock-"));
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(gitDir);
  try {
    const pending = waitForWorkspaceChange(root, { since: 0, timeoutMs: 350 });
    await delay(60);
    const lock = path.join(gitDir, "index.lock");
    fs.writeFileSync(lock, "");
    fs.rmSync(lock, { force: true });
    const result = await pending;
    assert.equal(result.changed, false);
    assert.equal(result.timedOut, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace watcher long-poll can be cancelled without leaving a live watcher waiter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-system-watch-abort-"));
  const controller = new AbortController();
  try {
    const pending = waitForWorkspaceChange(root, {
      since: 0,
      signal: controller.signal,
      timeoutMs: 3_000,
    });
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === "AbortError");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function normalize(value) {
  return String(value).replaceAll("\\", "/");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
