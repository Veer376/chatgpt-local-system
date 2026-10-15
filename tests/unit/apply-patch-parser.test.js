import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyUnifiedLines, splitUnifiedDiff } from "../../src/apps/apply-patch-parser.js";
import { normalizePatchInput } from "../../src/tools/files.js";

test("splitUnifiedDiff separates plain multi-file unified diffs", () => {
  const diff = [
    "--- a/scripts/video/base.py",
    "+++ b/scripts/video/base.py",
    "@@ -1 +1 @@",
    "-old_base",
    "+new_base",
    "===================================================================",
    "--- a/scripts/video/flow.py",
    "+++ b/scripts/video/flow.py",
    "@@ -2 +2 @@",
    "-old_flow",
    "+new_flow",
    "--- a/scripts/resolve_prompt.py",
    "+++ b/scripts/resolve_prompt.py",
    "@@ -3 +3 @@",
    "-old_prompt",
    "+new_prompt",
    "",
  ].join("\n");

  const files = splitUnifiedDiff(diff);
  assert.deepEqual(files.map((file) => file.path), [
    "scripts/video/base.py",
    "scripts/video/flow.py",
    "scripts/resolve_prompt.py",
  ]);
  assert.deepEqual(files.map(({ additions, deletions }) => ({ additions, deletions })), [
    { additions: 1, deletions: 1 },
    { additions: 1, deletions: 1 },
    { additions: 1, deletions: 1 },
  ]);
});

test("splitUnifiedDiff separates git multi-file diffs", () => {
  const diff = [
    "diff --git a/one.js b/one.js",
    "--- a/one.js",
    "+++ b/one.js",
    "@@ -1 +1 @@",
    "-const one = 1;",
    "+const one = 10;",
    "diff --git a/two.py b/two.py",
    "--- a/two.py",
    "+++ b/two.py",
    "@@ -1 +1 @@",
    "-two = 2",
    "+two = 20",
    "",
  ].join("\n");

  assert.deepEqual(splitUnifiedDiff(diff).map((file) => file.path), ["one.js", "two.py"]);
});

test("splitUnifiedDiff does not treat header-like changed code inside a hunk as a file boundary", () => {
  const diff = [
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1,2 +1,2 @@",
    "--- old-looking-code",
    "+++ new-looking-code",
    " context",
    "",
  ].join("\n");

  const files = splitUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "example.txt");
  assert.equal(files[0].deletions, 1);
  assert.equal(files[0].additions, 1);
});

test("common multi-update patches normalize into independently parsed files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-patch-parser-test-"));
  const oldRoots = process.env.WORKSPACE_ROOTS;
  process.env.WORKSPACE_ROOTS = root;
  try {
    fs.writeFileSync(path.join(root, "one.js"), "const one = 1;\n");
    fs.writeFileSync(path.join(root, "two.py"), "two = 2\n");
    const input = [
      "*** Begin Patch",
      "*** Update File: one.js",
      "@@",
      "-const one = 1;",
      "+const one = 10;",
      "*** Update File: two.py",
      "@@",
      "-two = 2",
      "+two = 20",
      "*** End Patch",
    ].join("\n");

    const normalized = normalizePatchInput(input, root);
    assert.deepEqual(splitUnifiedDiff(normalized).map((file) => file.path), ["one.js", "two.py"]);
  } finally {
    if (oldRoots == null) delete process.env.WORKSPACE_ROOTS;
    else process.env.WORKSPACE_ROOTS = oldRoots;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("splitUnifiedDiff decodes Git-quoted UTF-8 paths", () => {
  const diff = [
    'diff --git "a/unicod\\303\\251.py" "b/unicod\\303\\251.py"',
    '--- "a/unicod\\303\\251.py"',
    '+++ "b/unicod\\303\\251.py"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");

  const files = splitUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "unicodé.py");
  assert.equal(files[0].name, "unicodé.py");
  assert.equal(files[0].language, "python");
});

test("classifyUnifiedLines keeps header-like changed code inside the hunk", () => {
  const classified = classifyUnifiedLines([
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1,2 +1,2 @@",
    "--- old-looking-code",
    "+++ new-looking-code",
    " context",
  ]);

  assert.deepEqual(classified.map(({ kind }) => kind), [
    "file-header",
    "file-header",
    "hunk",
    "removed",
    "added",
    "context",
  ]);
});


test("splitUnifiedDiff preserves Git-quoted special filename characters", () => {
  const cases = [
    [String.raw`"a/quote\"name.txt"`, String.raw`"b/quote\"name.txt"`, 'quote"name.txt'],
    [String.raw`"a/back\\slash.md"`, String.raw`"b/back\\slash.md"`, 'back\\slash.md'],
    [String.raw`"a/tab\tname.json"`, String.raw`"b/tab\tname.json"`, 'tab\tname.json'],
  ];

  for (const [oldPath, newPath, expected] of cases) {
    const diff = [
      `diff --git ${oldPath} ${newPath}`,
      `--- ${oldPath}`,
      `+++ ${newPath}`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const [file] = splitUnifiedDiff(diff);
    assert.equal(file.path, expected);
    assert.equal(file.name, expected);
  }
});
