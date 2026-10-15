import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseNumstatZ,
  parsePorcelainV1Z,
  parseUnifiedZeroDiff,
} from "../../src/lib/local-git.js";

const localGitSource = readFileSync(new URL("../../src/lib/local-git.js", import.meta.url), "utf8");

test("parsePorcelainV1Z classifies staged, unstaged, untracked, and renamed files", () => {
  const files = parsePorcelainV1Z([
    " M src/changed.js",
    "A  src/added.js",
    "?? src/new.js",
    "R  src/renamed.js",
    "src/original.js",
    "",
  ].join("\0"));

  assert.deepEqual(files.map((file) => ({
    path: file.path,
    kind: file.kind,
    staged: file.staged,
    unstaged: file.unstaged,
    untracked: file.untracked,
    originalPath: file.originalPath || null,
  })), [
    { path: "src/changed.js", kind: "modified", staged: false, unstaged: true, untracked: false, originalPath: null },
    { path: "src/added.js", kind: "added", staged: true, unstaged: false, untracked: false, originalPath: null },
    { path: "src/new.js", kind: "untracked", staged: false, unstaged: false, untracked: true, originalPath: null },
    { path: "src/renamed.js", kind: "renamed", staged: true, unstaged: false, untracked: false, originalPath: "src/original.js" },
  ]);
});

test("parseNumstatZ preserves text counts and binary markers", () => {
  const stats = parseNumstatZ("12\t3\tsrc/a.js\0-\t-\tassets/image.png\0");
  assert.deepEqual(stats.get("src/a.js"), { additions: 12, deletions: 3, binary: false });
  assert.deepEqual(stats.get("assets/image.png"), { additions: null, deletions: null, binary: true });
});

test("parseUnifiedZeroDiff maps zero-context hunks to current-file gutter ranges", () => {
  const ranges = parseUnifiedZeroDiff([
    "@@ -3,0 +4,2 @@",
    "+one",
    "+two",
    "@@ -8,2 +10,0 @@",
    "-old one",
    "-old two",
    "@@ -12,2 +12,3 @@",
    "-before",
    "+after",
    "",
  ].join("\n"));

  assert.deepEqual(ranges, [
    { type: "added", start: 4, end: 5 },
    { type: "deleted", line: 10, count: 2 },
    { type: "modified", start: 12, end: 14 },
  ]);
});

test("read-only Git inspection disables optional locks so status cannot feed filesystem watchers", () => {
  assert.match(localGitSource, /GIT_OPTIONAL_LOCKS:\s*"0"/);
});
