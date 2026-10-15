import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "local-project-context-test-"));
process.env.BRIDGE_STATE_DIR = path.join(base, "state");

const projectContext = await import(`../../src/lib/local-project-context.js?test=${Date.now()}`);

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

test("unbound thread project persists and resolves as the fallback", () => {
  const threadId = "thread-unbound";
  const project = "/projects/thread-fallback";

  projectContext.saveBrowserThreadProject(threadId, project);
  assert.equal(projectContext.savedBrowserThreadProject(threadId), project);
  assert.equal(projectContext.effectiveBrowserProject(threadId, { bound: false, state: null }), project);

  const resolved = projectContext.resolveBrowserProjectContext(threadId, {
    bound: false,
    state: null,
    conversationKey: null,
  });
  assert.equal(resolved.bound, false);
  assert.equal(resolved.currentWorkspace, project);
  assert.equal(resolved.projectSource, "thread");
  assert.equal(resolved.threadWorkspace, project);

  const persisted = JSON.parse(
    fs.readFileSync(path.join(process.env.BRIDGE_STATE_DIR, "browser-thread-projects.json"), "utf8"),
  );
  assert.ok(Object.values(persisted.projects || {}).some((item) => item?.workspace === project));
});

test("bound currentWorkspace is authoritative and synchronizes the thread fallback", () => {
  const threadId = "thread-bound";
  projectContext.saveBrowserThreadProject(threadId, "/projects/stale");

  const resolved = projectContext.resolveBrowserProjectContext(threadId, {
    bound: true,
    conversationKey: crypto.createHash("sha256").update("bound-conversation").digest("hex"),
    state: { currentWorkspace: "/projects/bound" },
  });

  assert.equal(resolved.currentWorkspace, "/projects/bound");
  assert.equal(resolved.projectSource, "binding");
  assert.equal(resolved.threadWorkspace, "/projects/bound");
  assert.equal(projectContext.savedBrowserThreadProject(threadId), "/projects/bound");
});

test("thread fallback is promoted when a bound conversation has no currentWorkspace", () => {
  const threadId = "thread-promotion";
  const project = "/projects/fallback";
  const conversationKey = crypto.createHash("sha256").update("promotion-conversation").digest("hex");
  projectContext.saveBrowserThreadProject(threadId, project);

  const resolved = projectContext.resolveBrowserProjectContext(threadId, {
    bound: true,
    conversationKey,
    state: { currentWorkspace: "" },
  });

  assert.equal(resolved.bound, true);
  assert.equal(resolved.currentWorkspace, project);
  assert.equal(resolved.projectSource, "binding");
  assert.equal(resolved.promotedFromThread, true);
  assert.equal(resolved.resolvedThread.state.currentWorkspace, project);
  assert.equal(resolved.resolvedThread.state.workspaceSelection?.source, "thread-fallback");
});

test("picker selection changes the bound project when a binding exists", () => {
  const threadId = "thread-selection";
  const conversationKey = crypto.createHash("sha256").update("selection-conversation").digest("hex");
  const selected = "/projects/new-project";

  const result = projectContext.selectBrowserProject(threadId, {
    bound: true,
    conversationKey,
    state: { currentWorkspace: "/projects/old-project" },
  }, selected);

  assert.equal(result.bound, true);
  assert.equal(result.previousWorkspace, "/projects/old-project");
  assert.equal(result.currentWorkspace, selected);
  assert.equal(result.projectSource, "binding");
  assert.equal(result.resolvedThread.state.currentWorkspace, selected);
  assert.equal(result.resolvedThread.state.workspaceSelection?.source, "user");
  assert.equal(projectContext.savedBrowserThreadProject(threadId), selected);
});
