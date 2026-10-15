import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionUrl = (file) => new URL(`../../extensions/local-system/${file}`, import.meta.url);
const manifest = JSON.parse(readFileSync(extensionUrl("manifest.json"), "utf8"));
const foundation = readFileSync(extensionUrl("ui-foundation.css"), "utf8");

test("all primary Local System surfaces load the shared UI foundation", () => {
  for (const file of [
    "file-workspace.html",
    "side-panel.html",
    "file-quick-open.html",
    "files.html",
    "skills.html",
    "todos.html",
    "activity-popup.html",
    "viewer.html",
  ]) {
    const html = readFileSync(extensionUrl(file), "utf8");
    assert.match(html, /href="ui-foundation\.css"/, `${file} should load ui-foundation.css`);
  }

  const chatgpt = manifest.content_scripts.find((entry) => entry.js?.includes("composer-context.js"));
  assert.ok(chatgpt);
  assert.equal(chatgpt.css[0], "ui-foundation.css", "shared tokens should load before injected component styles");
});

test("UI foundation owns the shared minimalist visual primitives", () => {
  for (const token of [
    "--ls-ui-font-family",
    "--ls-ui-fallback-surface",
    "--ls-ui-fallback-text",
    "--ls-ui-surface",
    "--ls-ui-text",
    "--ls-ui-surface-subtle",
    "--ls-ui-control-bg",
    "--ls-ui-control-text",
    "--ls-ui-control-hover",
    "--ls-ui-primary-bg",
    "--ls-ui-primary-text",
    "--ls-ui-success",
    "--ls-ui-danger",
    "--ls-ui-warning",
    "--ls-ui-info",
    "--ls-ui-accent",
    "--ls-ui-git-added",
    "--ls-ui-git-modified",
    "--ls-ui-git-deleted",
    "--ls-ui-icon-size",
    "--ls-ui-icon-button-size",
    "--ls-ui-hover",
    "--ls-ui-active",
    "--ls-ui-radius-control",
    "--ls-ui-radius-row",
    "--ls-ui-radius-surface",
    "--ls-ui-radius-floating",
    "--ls-ui-radius-annotation",
    "--ls-ui-radius-annotation-editing",
    "--ls-ui-radius-annotation-tooltip",
    "--ls-ui-radius-button",
    "--ls-ui-annotation-editor-width",
    "--ls-ui-shadow-floating",
    "--ls-ui-shadow-dialog",
    "--ls-ui-transition-fast",
  ]) {
    assert.match(foundation, new RegExp(token.replaceAll("-", "\\-")));
  }

  for (const primitive of [
    ".ls-ui-floating-surface",
    ".ls-ui-dialog-surface",
    ".ls-ui-backdrop",
    ".ls-ui-search-field",
    ".ls-ui-list-row",
    ".ls-ui-icon-button",
    ".ls-ui-button",
    ".ls-ui-scroll",
  ]) {
    assert.ok(foundation.includes(primitive), `missing shared primitive ${primitive}`);
  }
  assert.match(foundation, /--ls-ui-radius-control:\s*8px/);
  assert.match(foundation, /--ls-ui-radius-button:\s*14px/);
  assert.match(foundation, /\.ls-ui-icon-button\s*\{[^}]*border-radius:\s*var\(--ls-ui-radius-control\)/s);
  assert.match(foundation, /\.ls-ui-button\s*\{[^}]*border-radius:\s*var\(--ls-ui-radius-button\)/s);
});

test("theme foundation follows ChatGPT first and has explicit light and dark fallbacks", () => {
  assert.match(foundation, /--ls-ui-surface:\s*var\(--main-surface-primary,\s*var\(--ls-ui-fallback-surface\)\)/);
  assert.match(foundation, /--ls-ui-text:\s*var\(--text-primary,\s*var\(--ls-ui-fallback-text\)\)/);
  assert.match(foundation, /--ls-ui-fallback-surface:\s*#ffffff/);
  assert.match(foundation, /--ls-ui-fallback-text:\s*#0d0d0d/);
  assert.match(foundation, /@media \(prefers-color-scheme: dark\)[\s\S]*--ls-ui-fallback-surface:\s*#212121[\s\S]*--ls-ui-fallback-text:\s*#f4f4f4/);
  assert.doesNotMatch(foundation, /--ls-ui-(?:surface|text|muted|faint|hover|active|separator):[^;]*(?:CanvasText|\bCanvas\b)/);
});

test("shared search fields rely on the caret instead of an active focus ring", () => {
  assert.match(foundation, /\.ls-ui-search-field\s*\{[^}]*appearance:\s*none[^}]*border:\s*0[^}]*outline:\s*0/s);
  assert.match(foundation, /\.ls-ui-search-field:focus,[\s\S]*?\.ls-ui-search-field:focus-visible\s*\{[^}]*box-shadow:\s*none/s);
  assert.doesNotMatch(foundation, /\.ls-ui-search-field:focus,[\s\S]*?box-shadow:\s*0 0 0 2px/s);
});
