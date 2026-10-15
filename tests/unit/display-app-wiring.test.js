import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync(
  new URL("../../src/apps/file-preview.js", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../../src/apps/file-preview.css", import.meta.url),
  "utf8",
);
const buildScript = readFileSync(
  new URL("../../scripts/build-apps.mjs", import.meta.url),
  "utf8",
);

test("Display app keeps the existing rich file preview mode", () => {
  assert.match(script, /function previewFiles\b/);
  assert.match(script, /renderPdfPages/);
  assert.match(script, /file\.category === "markdown"/);
  assert.match(script, /file\.category === "code"/);
  assert.match(script, /\["image", "audio", "video"\]/);
  assert.match(script, /open_preview_file/);
  assert.match(script, /name: "Display"/);
  assert.match(buildScript, /\{ name: "file-preview", title: "Display" \}/);
});

test("Display app renders changes and arbitrary diffs with standard changed-file tabs", () => {
  assert.match(script, /splitUnifiedDiff/);
  assert.match(script, /classifyUnifiedLines/);
  assert.match(script, /load_display_content/);
  assert.match(script, /refresh_display_content/);
  assert.match(script, /resumeToken/);
  assert.match(script, /payload\.type === "changes" \|\| payload\.type === "diff"/);
  assert.match(script, /data-display-diff-index/);
  assert.match(script, /display-diff-line/);
  assert.match(css, /\.display-diff-line\.added\{[^}]*#22c55e/s);
  assert.match(css, /\.display-diff-line\.removed\{[^}]*#ef4444/s);
  assert.match(css, /\.display-diff-tabs/);
  assert.match(css, /\.display-line-no/);
});

test("Display app renders Markdown and sandboxes static HTML artifacts", () => {
  assert.match(script, /payload\.type === "markdown"/);
  assert.match(script, /renderMarkdownDisplay/);
  assert.match(script, /payload\.type === "html"/);
  assert.match(script, /data-html-artifact sandbox/);
  assert.match(script, /default-src 'none'/);
  assert.match(script, /script-src|default-src 'none'/);
  assert.match(script, /form-action 'none'/);
  assert.match(script, /frame\.srcdoc = htmlArtifactDocument\(source\)/);
  assert.match(css, /\.html-artifact\{/);
});
