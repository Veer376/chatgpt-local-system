import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePatchInput, patchDeletesFile } from "../../src/tools/files.js";
import { detectCommand } from "../../src/tools/project.js";

test("patch deletion detection distinguishes edits from deletions", () => {
  assert.equal(patchDeletesFile("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n"), false);
  assert.equal(patchDeletesFile("diff --git a/a b/a\ndeleted file mode 100644\n--- a/a\n+++ /dev/null\n"), true);
});

test("natural patch input converts add, update, and delete directives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-patch-input-test-"));
  const oldRoots = process.env.WORKSPACE_ROOTS;
  process.env.WORKSPACE_ROOTS = root;
  try {
    fs.writeFileSync(path.join(root, "existing.txt"), "old\n");
    const update = normalizePatchInput("*** Begin Patch\n*** Update File: existing.txt\n@@\n-old\n+new\n*** End Patch", root);
    assert.match(update, /-old/);
    assert.match(update, /\+new/);
    const add = normalizePatchInput("*** Begin Patch\n*** Add File: added.txt\n+hello\n*** End Patch", root);
    assert.match(add, /new file mode 100644/);
    assert.match(add, /\+hello/);
    const removal = normalizePatchInput("*** Begin Patch\n*** Delete File: existing.txt\n*** End Patch", root);
    assert.equal(patchDeletesFile(removal), true);
  } finally {
    if (oldRoots == null) delete process.env.WORKSPACE_ROOTS;
    else process.env.WORKSPACE_ROOTS = oldRoots;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project command detection respects package manager and scripts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-project-test-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "vite build" } }));
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9'\n");
    const testCommand = detectCommand(dir, "test");
    assert.match(testCommand, /(?:pnpm|npm) run test/);
    assert.equal(detectCommand(dir, "lint"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
