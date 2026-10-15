import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../../extensions/local-system/${file}`, import.meta.url), "utf8");
const content = read("content.js");
const annotations = read("annotations-content.js");
const composer = read("composer-context.js");
const workspace = read("file-workspace.js");
const background = read("background.js");
const manifest = JSON.parse(read("manifest.json"));

test("large attachment prompts are inserted cooperatively instead of in one blocking edit", () => {
  assert.match(annotations, /const COMPOSER_INSERT_YIELD_THRESHOLD = 12_000/);
  assert.match(annotations, /await replaceComposerTextCooperatively\(editor, combined\)/);
  assert.match(annotations, /function composerTextChunks\b/);
  assert.match(annotations, /await nextComposerFrame\(\)/);
  assert.doesNotMatch(annotations, /const combined = parts\.join\([\s\S]*?replaceComposerText\(editor, combined\)/);

  const start = annotations.indexOf("function composerTextChunks");
  const end = annotations.indexOf("function placeComposerCaretAtEnd", start);
  assert.ok(start >= 0 && end > start, "expected pure prompt chunking helper");
  const source = annotations.slice(start, end).trim();
  const composerTextChunks = Function(
    "COMPOSER_INSERT_CHUNK_SIZE",
    `"use strict"; return (${source});`,
  )(6_000);
  const sample = `alpha🙂beta-${"x".repeat(40)}`;
  const chunks = composerTextChunks(sample, 7);
  assert.equal(chunks.join(""), sample, "chunking must preserve the exact prompt text");
  assert.ok(chunks.every((chunk) => chunk.length <= 8), "a surrogate pair may extend a chunk by at most one code unit");
});

test("baseline extension surfaces avoid perpetual polling", () => {
  for (const [name, source] of [
    ["content", content],
    ["annotations", annotations],
    ["composer", composer],
    ["workspace", workspace],
    ["background", background],
  ]) {
    assert.doesNotMatch(source, /setInterval\(/, `${name} should not poll continuously`);
  }
  assert.match(content, /const conversationVisibilityObserver = typeof IntersectionObserver/);
  assert.match(content, /const inlineFileLinkVisibilityObserver = typeof IntersectionObserver/);
  assert.match(content, /inlineFileLinkVisibilityObserver\.observe\(link\)/);
  assert.match(content, /function handleComposerActivation\b[\s\S]*ensureTodosWidget\(\)/);
  assert.match(content, /function scheduleChromeUiReconcile\b[\s\S]*ensureThreadNotesWidget\(\);[\s\S]*ensureTodosWidget\(\);/);
  assert.match(content, /if \(ENABLE_FILE_WORKSPACE && fileWorkspaceWidget\) ensureFileWorkspaceWidget\(\)/);
});

test("browser binding changes propagate without a page reload", () => {
  assert.match(composer, /previousWorkspace !== context\.currentWorkspace/);
  assert.match(composer, /new CustomEvent\("local-system-project-changed"/);
  assert.match(content, /globalThis\.addEventListener\("local-system-project-changed"/);
  assert.match(content, /inlineFileResolutionCache\.clear\(\)/);
  assert.match(content, /refreshInlineFileLinks\(\)/);
});

test("extension notifications are permissioned and routed back to the originating ChatGPT tab", () => {
  assert.ok(manifest.permissions.includes("notifications"));
  assert.match(background, /message\.action === "notify"/);
  assert.match(background, /chrome\.notifications\.create/);
  assert.match(background, /chrome\.notifications\.onClicked\.addListener/);
  assert.match(background, /const update = \{ active: true \}/);
  assert.match(background, /chrome\.tabs\.update\(target\.tabId, update\)/);
});

test("ChatGPT disclaimer suppression is exact-text scoped", () => {
  assert.match(content, /const CHATGPT_DISCLAIMER_TEXT = "ChatGPT can make mistakes\. Check important info\."/);
  assert.match(content, /candidate\.textContent \|\| ""\)\.trim\(\) !== CHATGPT_DISCLAIMER_TEXT/);
  assert.match(content, /candidate\.style\.setProperty\("display", "none", "important"\)/);
});
