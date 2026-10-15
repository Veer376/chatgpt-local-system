import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../extensions/local-system/manifest.json", import.meta.url), "utf8"));
const dashboard = readFileSync(new URL("../../extensions/local-system/thread-dashboard.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../extensions/local-system/thread-dashboard.css", import.meta.url), "utf8");
const content = readFileSync(new URL("../../extensions/local-system/content.js", import.meta.url), "utf8");
const composerSharedCss = readFileSync(new URL("../../extensions/local-system/composer-shared.css", import.meta.url), "utf8");
const background = readFileSync(new URL("../../extensions/local-system/background.js", import.meta.url), "utf8");

test("thread dashboard loads after the shared background-owned Local System API", () => {
  const content = manifest.content_scripts.find((item) => item.js?.includes("thread-dashboard.js"));
  assert.ok(content);
  assert.ok(content.js.indexOf("extension-api.js") < content.js.indexOf("annotations-content.js"));
  assert.ok(content.js.indexOf("thread-dashboard.js") > content.js.indexOf("annotations-content.js"));
  assert.ok(content.css.includes("thread-dashboard.css"));
  assert.match(background, /"\/local-ui\/activity"/);
});

test("thread dashboard lazily loads annotation recovery and tool activity only after opening", () => {
  assert.match(dashboard, /function openPanel\(\)[\s\S]*?void refreshPanel/);
  assert.match(dashboard, /action:\s*"latest"/);
  assert.match(dashboard, /action:\s*"list"/);
  assert.match(dashboard, /if \(!state\.open \|\| document\.visibilityState !== "visible"\) return/);
  assert.doesNotMatch(dashboard.slice(0, dashboard.indexOf("function openPanel")), /loadActivityList\(\)|loadLatestAnnotation\(\)/);
});

test("tool details are carried by paginated activity and expanded without a second API", () => {
  assert.doesNotMatch(dashboard, /action:\s*"detail"/);
  assert.doesNotMatch(dashboard, /function loadToolDetail\(/);
  assert.match(dashboard, /button\.addEventListener\("click",[\s\S]*?renderToolDetail\(detail, call\)/);
  assert.match(dashboard, /ls-thread-dashboard__detail-label">Input/);
  assert.match(dashboard, /ls-thread-dashboard__detail-label">Output/);
});

test("dashboard exposes durable annotation copy and ChatGPT-like lightweight styling", () => {
  assert.match(dashboard, /Copy annotation/);
  assert.match(dashboard, /function copyIcon\(/);
  assert.doesNotMatch(dashboard, />Copy annotation<\/button>/);
  assert.match(dashboard, />Last turn</);
  assert.doesNotMatch(dashboard, /Previous annotations/);
  assert.match(dashboard, /navigator\.clipboard\.writeText/);
  assert.match(css, /border-radius:\s*var\(--ls-ui-radius-floating,\s*14px\)/);
  assert.match(css, /box-shadow:\s*var\(--ls-ui-shadow-dialog/);
  assert.doesNotMatch(css, /\.ls-thread-dashboard\s*\{[^}]*border:\s*1px/s);
  assert.match(css, /color-mix\(/);
  assert.match(css, /\.ls-thread-dashboard__status-dot\[data-status="running"\]/);
});

test("Local System, Notes, and continuation controls share the rail as icon buttons", () => {
  assert.match(dashboard, /function makeHeaderButtonInteractive\(/);
  assert.match(dashboard, /ensureComposerRailActionsHost/);
  assert.match(content, /ensureComposerRailActionsHost/);
  assert.match(dashboard, /ComposerIconButton/);
  assert.match(content, /ComposerIconButton/);
  assert.match(dashboard, /const refreshButton = globalThis\.LocalSystemSharedRuntime\?\.ComposerIconButton\?\.\(\{/);
  assert.match(dashboard, /className:\s*"ls-thread-dashboard__refresh-button"/);
  assert.doesNotMatch(dashboard, /class="ls-thread-dashboard__icon-button" data-action="refresh"/);
  assert.match(dashboard, /className:\s*"local-system-dashboard-button"/);
  assert.match(content, /className:\s*"local-system-continuation-context-button"/);
  assert.match(content, /className:\s*"local-system-thread-notes-button"/);
  assert.doesNotMatch(dashboard, /findHeaderActionButton/);
  assert.doesNotMatch(content, /findHeaderActionButton/);
  assert.doesNotMatch(dashboard, /ls-dashboard-label/);
  assert.match(content, /documentation task only/);
  assert.match(content, /Do not use tools, run commands, edit files, search/);
  assert.match(content, /This line never replaces the sections below/);
  assert.match(content, /no active task/);
  assert.match(content, /Weight by recency/);
  assert.match(content, /Verified vs not verified/);
  assert.match(content, /KEEP EXACT/);
  assert.match(composerSharedCss, /\.composer-icon-button\s*\{[^}]*cursor:\s*pointer[^}]*pointer-events:\s*auto/s);
  assert.match(composerSharedCss, /\.composer-icon-button\s*\{[\s\S]*?background:\s*var\(--ls-ui-control-bg\)/);
  assert.doesNotMatch(css, /\.local-system-dashboard-button\s*\{/);
  assert.doesNotMatch(content, /\.local-system-thread-notes-button\s*\{[\s\S]*?pointer-events:/);
});

test("Local System dashboard omits the old UI controls section", () => {
  assert.doesNotMatch(dashboard, />UI controls</);
  assert.doesNotMatch(dashboard, /uiSetting\(/);
  assert.doesNotMatch(dashboard, /loadUiVisibilitySettings|renderUiVisibilitySettings|handleUiVisibilityChange/);
  assert.doesNotMatch(css, /\.ls-thread-dashboard__settings|\.ls-thread-dashboard__setting-switch/);
});

test("Local System status indicator uses lightweight bridge activity polling", () => {
  assert.match(dashboard, /action:\s*"status"/);
  assert.match(dashboard, /15_000/);
  assert.match(dashboard, /payload\?\.bridgeActive === true/);
  assert.match(dashboard, /!state\.bound \? "unbound"/);
  assert.match(dashboard, /"Not bound"/);
  assert.match(css, /data-bridge-status="active"/);
  assert.match(css, /data-bridge-status="inactive"/);
  assert.match(css, /data-bridge-status="unbound"[^}]*var\(--ls-ui-warning\)/s);
  assert.match(css, /data-status="unbound"[^}]*var\(--ls-ui-warning\)/s);
});

test("thread dashboard uses ChatGPT's opaque primary surface instead of sampling translucent ancestors", () => {
  assert.match(css, /--ls-dashboard-surface:\s*var\(--main-surface-primary,\s*var\(--ls-ui-surface\)\)/);
  assert.match(css, /background:\s*var\(--ls-dashboard-surface\)\s*!important/);
  assert.match(css, /background-color:\s*var\(--ls-dashboard-surface\)\s*!important/);
  assert.match(css, /backdrop-filter:\s*none\s*!important/);
  assert.doesNotMatch(dashboard, /getComputedStyle\(node\)\.backgroundColor/);
  assert.doesNotMatch(dashboard, /style\.setProperty\("--ls-dashboard-surface"/);
});

test("thread dashboard shows turn timing, recent-five pagination, and explicit live refresh", () => {
  assert.match(dashboard, /limit:\s*5/);
  assert.match(dashboard, /function loadMoreActivity\(/);
  assert.match(dashboard, /state\.totalCount/);
  assert.match(dashboard, /turn\.startedAt/);
  assert.match(dashboard, /turn\.endedAt/);
  assert.match(dashboard, /turn\.durationMs/);
  assert.match(dashboard, /In this turn/);
  assert.match(dashboard, /Last turn/);
  assert.match(dashboard, /Number\(call\?\.durationMs\)/);
  assert.match(dashboard, /Math\.round\(durationMs\).* ms/);
  assert.match(dashboard, /status === "completed" \? "" : status/);
  assert.doesNotMatch(dashboard, /function timingRows\(/);
  assert.doesNotMatch(dashboard, /activitySignature/);
  assert.match(dashboard, /refreshPanel\(\{ showLoading: true \}\)/);
  assert.match(dashboard, /captureActivityScrollState/);
  assert.match(dashboard, /restoreActivityScrollState/);
  assert.match(css, /ls-thread-dashboard__load-more/);
  assert.match(css, /ls-thread-dashboard__turn-times/);
});
