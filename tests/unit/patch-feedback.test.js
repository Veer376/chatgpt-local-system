import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-patch-feedback-"));
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.BRIDGE_SCRATCH_DIR = path.join(base, "scratch");

const { isMalformedPatchError, patchFailureContext, renderPatchFailure } = await import("../../src/lib/patch-feedback.js");

const root = path.join(base, "repo");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(base, "outside"), { recursive: true });
fs.writeFileSync(path.join(base, "outside", "secret.txt"), "TOP SECRET\n");

function diffFor(file, startLine, { body = " context\n-old\n+new" } = {}) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${startLine},3 +${startLine},3 @@\n${body}\n`;
}

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("a patch against a missing file says so instead of guessing", () => {
  const context = patchFailureContext(diffFor("src/nope.js", 4), root);
  assert.equal(context.length, 1);
  assert.equal(context[0].exists, false);
  assert.match(renderPatchFailure("patch does not apply", context), /does not exist/);
});

test("an existing file reports the real content at the failed hunk, with line numbers", () => {
  fs.writeFileSync(path.join(root, "src", "app.js"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
  const context = patchFailureContext(diffFor("src/app.js", 12), root);

  assert.equal(context[0].exists, true);
  assert.equal(context[0].lineCount, 30);
  const [hunk] = context[0].hunks;
  assert.equal(hunk.expectedStart, 12);
  assert.ok(hunk.actual.includes("12: line 12"), "the targeted line is present and numbered");
  assert.ok(hunk.actual.includes("4: line 4"), "context above is included");
  assert.ok(hunk.actual.includes("20: line 20"), "context below is included");

  const rendered = renderPatchFailure("patch does not apply", context);
  assert.match(rendered, /src\/app\.js around line 12 actually contains/);
  assert.match(rendered, /12: line 12/);
});

test("a hunk past the end of the file is called out explicitly", () => {
  fs.writeFileSync(path.join(root, "src", "short.js"), "one\ntwo\n");
  const context = patchFailureContext(diffFor("src/short.js", 900), root);
  assert.equal(context[0].hunks[0].beyondEndOfFile, true);
  assert.match(renderPatchFailure("nope", context), /past the end/);
});

test("a patch escaping the workspace is refused, not read", () => {
  const context = patchFailureContext(diffFor("../outside/secret.txt", 1), root);
  assert.equal(context[0].outsideWorkspace, true);
  assert.equal(context[0].exists, false);
  const rendered = renderPatchFailure("nope", context);
  assert.match(rendered, /outside the workspace/);
  assert.doesNotMatch(rendered, /TOP SECRET/, "content outside the workspace never leaks");
});

test("very long lines are clipped so one file cannot flood the response", () => {
  fs.writeFileSync(path.join(root, "src", "long.js"), `${"x".repeat(5_000)}\nsecond\n`);
  const context = patchFailureContext(diffFor("src/long.js", 1), root);
  const [first] = context[0].hunks[0].actual;
  assert.ok(first.length < 260, `line clipped, got ${first.length}`);
  assert.match(first, /…$/);
});

test("CRLF files report clean line numbers", () => {
  fs.writeFileSync(path.join(root, "src", "crlf.js"), "alpha\r\nbeta\r\ngamma\r\n");
  const context = patchFailureContext(diffFor("src/crlf.js", 2), root);
  assert.ok(context[0].hunks[0].actual.includes("2: beta"), "no stray carriage returns");
});

test("multiple files and hunks are reported, and both are capped", () => {
  for (let i = 0; i < 8; i += 1) {
    fs.writeFileSync(path.join(root, "src", `many${i}.js`), Array.from({ length: 200 }, (_, n) => `l${n + 1}`).join("\n"));
  }
  const diff = Array.from({ length: 8 }, (_, i) => diffFor(`src/many${i}.js`, 5)).join("");
  assert.equal(patchFailureContext(diff, root).length, 5, "at most 5 files");

  const hunks = Array.from({ length: 8 }, (_, i) => `@@ -${(i + 1) * 10},3 +${(i + 1) * 10},3 @@\n context\n-old\n+new`).join("\n");
  const manyHunks = `diff --git a/src/many0.js b/src/many0.js\n--- a/src/many0.js\n+++ b/src/many0.js\n${hunks}\n`;
  assert.equal(patchFailureContext(manyHunks, root)[0].hunks.length, 5, "at most 5 hunks per file");
});

test("malformed, empty, and non-string diffs return nothing rather than throwing", () => {
  for (const bad of ["", "not a diff at all", "@@ garbage @@", null, undefined, 42, {}]) {
    assert.deepEqual(patchFailureContext(bad, root), [], `input ${JSON.stringify(bad)}`);
  }
  assert.equal(typeof renderPatchFailure("err", []), "string");
});

test("the rendered message always leads with the underlying git error", () => {
  const context = patchFailureContext(diffFor("src/app.js", 12), root);
  assert.match(renderPatchFailure("error: patch failed: src/app.js:12", context), /^error: patch failed/);
});

test("a malformed patch is never reported as a context mismatch", () => {
  const context = patchFailureContext(diffFor("src/app.js", 12), root);
  for (const error of ["error: corrupt patch at line 7", "unrecognized input", "patch fragment without header"]) {
    assert.equal(isMalformedPatchError(error), true, error);
    const rendered = renderPatchFailure(error, context);
    assert.match(rendered, /patch text is malformed/);
    assert.doesNotMatch(rendered, /actually contains/, "file content must not be presented as the cause");
    assert.match(rendered, /Targeted: src\/app\.js/, "the targeted file is still named");
  }
});

test("a genuine apply failure still reports file content", () => {
  assert.equal(isMalformedPatchError("error: src/app.js: patch does not apply"), false);
  const rendered = renderPatchFailure("error: src/app.js: patch does not apply", patchFailureContext(diffFor("src/app.js", 12), root));
  assert.match(rendered, /actually contains/);
});
