import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(
  new URL("../../extensions/local-system/manifest.json", import.meta.url),
  "utf8",
));
const popupHtml = readFileSync(
  new URL("../../extensions/local-system/activity-popup.html", import.meta.url),
  "utf8",
);
const popupScript = readFileSync(
  new URL("../../extensions/local-system/activity-popup.js", import.meta.url),
  "utf8",
);
const popupCss = readFileSync(
  new URL("../../extensions/local-system/activity-popup.css", import.meta.url),
  "utf8",
);
const contentScript = readFileSync(
  new URL("../../extensions/local-system/content.js", import.meta.url),
  "utf8",
);
const backgroundScript = readFileSync(
  new URL("../../extensions/local-system/background.js", import.meta.url),
  "utf8",
);

test("extension action opens the native Local System sidebar directly", () => {
  assert.equal(manifest.action?.default_popup, undefined);
  assert.equal(manifest.side_panel?.default_path, "side-panel.html");
  assert.match(backgroundScript, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/);
  assert.match(backgroundScript, /chrome\.action\?\.onClicked/);
});

test("legacy popup assets remain available while workspace controls live in the sidebar", () => {
  assert.match(popupHtml, /id="app"/);
  assert.match(popupHtml, /href="ui-foundation\.css"/);
  assert.match(popupHtml, /src="activity-popup\.js"/);
});

test("extension popup has exactly the workspace summary/open flow and UI controls as its primary sections", () => {
  assert.match(popupScript, />Workspace</);
  assert.match(popupScript, />Open workspace</);
  assert.match(popupScript, />UI controls</);
  assert.match(popupScript, /"\/local-ui\/file-workspace"/);
  assert.match(popupScript, /action:\s*"context"/);
  assert.match(popupScript, /action:\s*"get"/);
  assert.match(popupScript, /currentWorkspace/);
  assert.match(popupScript, /workspace\.activePath/);
  assert.match(popupScript, /workspace\.openPaths/);
  assert.match(popupScript, /action:\s*"toggle-standalone-workspace"/);
  assert.match(popupScript, /source:\s*"local-system-popup"/);
  assert.match(popupScript, /action:\s*"api-request"/);
  assert.match(backgroundScript, /message\?\.source === "local-system-popup"/);
  assert.match(backgroundScript, /postLocalApiRequest\(String\(message\.path/);
  assert.doesNotMatch(popupScript, />Recent activity</);
  assert.doesNotMatch(popupScript, />Last turn</);
});

test("extension popup exposes persistent visibility controls for Local System surfaces", () => {
  assert.match(popupHtml, /<script src="shared-runtime\.js"><\/script>/);
  assert.match(popupScript, /LocalSystemSharedRuntime\.loadUiVisibility/);
  assert.match(popupScript, /LocalSystemSharedRuntime\.saveUiVisibility/);
  assert.match(popupScript, />UI controls</);
  assert.match(popupScript, /Current file pill/);
  assert.match(popupScript, /Project \+ Git pills/);
  assert.match(popupScript, /Skill pills/);
  assert.match(popupScript, /uiSetting\("todos", "Todos"\)/);
  assert.match(popupScript, /uiSetting\("workspace", "Embedded workspace"\)/);
  assert.match(popupScript, /uiSetting\("annotations", "Annotations"\)/);
  assert.match(popupCss, /\.ls-popup-setting__switch/);
  assert.match(popupCss, /--ls-popup-surface:\s*var\(--ls-ui-surface\)/);
  assert.doesNotMatch(popupCss, /\.ls-popup-setting \+ \.ls-popup-setting\s*\{[^}]*border-top:/s);
  assert.doesNotMatch(popupScript, /uiSetting\("threadNotes"/);
  assert.doesNotMatch(popupScript, /uiSetting\("activity"/);
});

test("content UI visibility preferences hide surfaces without removing their state", () => {
  assert.match(contentScript, /LocalSystemSharedRuntime\.UI_VISIBILITY_STORAGE_KEY/);
  assert.match(contentScript, /LocalSystemSharedRuntime\.loadUiVisibility/);
  assert.match(contentScript, /data-local-system-ui-pref-hidden/);
  assert.match(contentScript, /\.local-system-file-workspace-host/);
  assert.match(contentScript, /\.local-system-todos-host/);
  assert.match(contentScript, /\[data-local-system-annotation-ui="true"\]/);
  assert.match(contentScript, /reconcileComposerRailVisibility/);
  assert.match(contentScript, /data-local-system-ui-empty/);
  assert.match(contentScript, /data-local-system-hide-embedded-workspace/);
  assert.match(contentScript, /data-local-system-hide-annotations/);
  assert.doesNotMatch(contentScript, /data-local-system-hide-thread-notes/);
  assert.doesNotMatch(contentScript, /data-local-system-hide-activity/);
});
