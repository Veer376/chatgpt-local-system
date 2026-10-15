import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(
  new URL("../../extensions/local-system/manifest.json", import.meta.url),
  "utf8",
));
const standaloneScript = readFileSync(
  new URL("../../extensions/local-system/standalone-workspace.js", import.meta.url),
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
const workspaceHtml = readFileSync(
  new URL("../../extensions/local-system/file-workspace.html", import.meta.url),
  "utf8",
);
const workspaceScript = readFileSync(
  new URL("../../extensions/local-system/file-workspace.js", import.meta.url),
  "utf8",
);
const workspaceCss = readFileSync(
  new URL("../../extensions/local-system/file-workspace.css", import.meta.url),
  "utf8",
);
const safariPrepare = readFileSync(
  new URL("../../scripts/prepare-safari-ios.mjs", import.meta.url),
  "utf8",
);
const sidePanelHtml = readFileSync(
  new URL("../../extensions/local-system/side-panel.html", import.meta.url),
  "utf8",
);
const sidePanelScript = readFileSync(
  new URL("../../extensions/local-system/side-panel.js", import.meta.url),
  "utf8",
);
const sidePanelCss = readFileSync(
  new URL("../../extensions/local-system/side-panel.css", import.meta.url),
  "utf8",
);

test("in-page standalone remains as the Safari/fallback surface while legacy ChatGPT workspace remains", () => {
  const chatgptScripts = manifest.content_scripts
    .filter((entry) => entry.matches?.includes("https://chatgpt.com/*"))
    .flatMap((entry) => entry.js || []);
  assert.ok(chatgptScripts.includes("standalone-workspace.js"));
  assert.match(standaloneScript, /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(standaloneScript, /presentation=standalone/);
  assert.match(standaloneScript, /function findChatGPTSidePaneShell\b/);
  assert.match(standaloneScript, /shell\.appendChild\(state\.root\)/);
  assert.match(standaloneScript, /position: relative/);
  assert.match(standaloneScript, /flex: 0 0 var\(--ls-standalone-workspace-width\)/);
  assert.match(contentScript, /function findChatGPTSidePaneShell\b/);
  assert.match(contentScript, /shell\.appendChild\(host\)/);
  assert.match(contentScript, /function toggleFileWorkspace\b/);
});

test("fallback standalone passes explicit mobile state to keep iPhone drawer behavior without misclassifying narrow desktop panels", () => {
  assert.match(standaloneScript, /MOBILE_MEDIA = "\(max-width: 720px\), \(hover: none\) and \(pointer: coarse\) and \(max-width: 900px\)"/);
  assert.match(standaloneScript, /height: 100dvh/);
  assert.match(standaloneScript, /:host\(\[data-mobile\]\)[\s\S]*position: fixed/);
  assert.match(standaloneScript, /document\.documentElement\.appendChild\(state\.root\)/);
  assert.match(standaloneScript, /visualViewport\?\.addEventListener\?\.\("resize"/);
  assert.match(workspaceScript, /PRESENTATION = pageParams\.get\("presentation"\) === "standalone"/);
  assert.match(workspaceScript, /document\.documentElement\.dataset\.presentation = PRESENTATION/);
  assert.match(workspaceScript, /let mobileStandalone = pageParams\.get\("mobile"\) === "1"/);
  assert.match(standaloneScript, /&host=page&mobile=\$\{mobile \? "1" : "0"\}/);
  assert.match(workspaceScript, /function isMobileStandalone\b/);
  assert.match(workspaceScript, /mobileLeftOpen/);
  assert.match(workspaceScript, /function closeMobileLeftPane\b/);
  assert.match(workspaceCss, /html\[data-presentation="standalone"\]\[data-mobile-standalone="true"\]/);
  assert.match(workspaceCss, /@media \(max-width: 720px\), \(hover: none\) and \(pointer: coarse\) and \(max-width: 900px\)/);
  assert.match(workspaceCss, /safe-area-inset-bottom/);
  assert.match(workspaceCss, /\.workspace\.mobile-left-open \.tree-pane/);
  assert.match(workspaceCss, /min-width:\s*36px/);
  assert.match(workspaceCss, /min-height:\s*36px/);
});

test("fallback desktop standalone still docks into ChatGPT flow on browsers without the native side panel", () => {
  assert.match(standaloneScript, /ensureStandaloneParent\(mobile\)/);
  assert.match(standaloneScript, /state\.root\.parentElement !== shell/);
  assert.match(standaloneScript, /shell\.appendChild\(state\.root\)/);
  assert.match(standaloneScript, /clampStandaloneWidth/);
  assert.match(contentScript, /local-system-thread-notes-button/);
  assert.match(contentScript, /data-local-system-force-visible/);
  assert.match(contentScript, /local-system-standalone-workspace-root:not\(\[data-mobile\]\)/);
});

test("Chrome uses the native Side Panel for the main workspace while legacy embedded workspace remains separate", () => {
  assert.equal(manifest.action?.default_popup, undefined);
  assert.ok(manifest.permissions?.includes("sidePanel"));
  assert.ok(manifest.permissions?.includes("tabs"));
  assert.equal(manifest.side_panel?.default_path, "side-panel.html");
  assert.equal(manifest.commands?.["toggle-file-workspace"]?.suggested_key?.mac, "Command+Shift+E");
  assert.equal(manifest.commands?.["toggle-standalone-workspace"]?.suggested_key?.mac, "Command+Shift+L");
  assert.equal(manifest.commands?.["toggle-standalone-workspace"]?.description, "Open the Local System sidebar");
  assert.match(backgroundScript, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/);
  assert.match(backgroundScript, /chrome\.action\?\.onClicked/);
  assert.match(backgroundScript, /command === "toggle-file-workspace"/);
  assert.match(backgroundScript, /command === "toggle-standalone-workspace"/);
  assert.match(backgroundScript, /chrome\.sidePanel\?\.open/);
  assert.match(backgroundScript, /chrome\.sidePanel\.open\(\{ windowId: tab\.windowId \}\)/);
  assert.match(contentScript, /function handleNativeSidebarShortcut/);
  assert.match(contentScript, /event\.key\.toLowerCase\(\) !== "l"/);
  assert.match(contentScript, /action: "open-side-panel"/);
  assert.match(standaloneScript, /message\.action !== "toggle-standalone-workspace"/);
  assert.match(standaloneScript, /postToWorkspace\(\{ action: "close-sidebar" \}\)/);
  assert.match(workspaceScript, /event\.data\.action === "close-sidebar"/);
});

test("native side panel can be hidden per website and restored from workspace settings", () => {
  assert.match(backgroundScript, /SIDE_PANEL_HIDDEN_SITES_KEY = "localSystemSidePanelHiddenSitesV1"/);
  assert.match(backgroundScript, /function siteKeyFromUrl\b/);
  assert.match(backgroundScript, /chrome\.tabs\?\.onUpdated\?\.addListener/);
  assert.match(backgroundScript, /chrome\.tabs\?\.onActivated\?\.addListener/);
  assert.match(backgroundScript, /chrome\.sidePanel\.setOptions\(\{ tabId: tab\.id, enabled: false \}\)/);
  assert.match(backgroundScript, /message\.action === "side-panel-site-settings"/);
  assert.match(backgroundScript, /message\.action === "hide-side-panel-on-current-site"/);
  assert.match(backgroundScript, /message\.action === "unhide-side-panel-site"/);
  assert.match(workspaceHtml, /id="side-panel-site-settings"/);
  assert.match(workspaceHtml, /id="hide-current-site"[^>]*>Hide here</);
  assert.match(workspaceHtml, /id="hidden-sites-list"/);
  assert.match(workspaceScript, /extensionWorkspaceRequest\("hide-side-panel-on-current-site"\)/);
  assert.match(workspaceScript, /extensionWorkspaceRequest\("unhide-side-panel-site", \{ site \}\)/);
});

test("native side panel hosts the workspace and lets Chrome own the outer resize sash", () => {
  assert.match(sidePanelHtml, /id="workspace-frame"/);
  assert.match(sidePanelScript, /presentation=standalone&host=sidepanel&mobile=0/);
  assert.match(sidePanelScript, /new ResizeObserver\(\(\) => sendHostLayout\(\)\)/);
  assert.match(sidePanelScript, /action: "host-layout"/);
  assert.match(sidePanelScript, /message\.action === "resize"[\s\S]*Chrome owns the outer side-panel sash/);
  assert.match(sidePanelScript, /chrome\.tabs\.onActivated/);
  assert.match(sidePanelScript, /chrome\.tabs\.onUpdated/);
  assert.match(sidePanelCss, /\.workspace-frame[\s\S]*width:\s*100%[\s\S]*height:\s*100%/);
  assert.match(workspaceCss, /html\[data-host="sidepanel"\] #close-sidebar\s*\{[^}]*display:\s*none !important/);
  assert.match(workspaceHtml, /id="close-sidebar"/);
});

test("native side panel makes one bridge attempt and leaves reconnection to explicit Retry", () => {
  assert.match(sidePanelHtml, /id="workspace-skeleton"/);
  assert.match(sidePanelHtml, /id="workspace-empty-card"[^>]*hidden/);
  assert.doesNotMatch(sidePanelHtml, />Connecting to Local System…</);
  assert.match(sidePanelScript, /const loading = mode === "loading"/);
  assert.match(sidePanelScript, /elements\.empty\.classList\.toggle\("loading", loading\)/);
  assert.match(sidePanelScript, /elements\.emptySkeleton\.hidden = !loading/);
  assert.match(sidePanelScript, /elements\.emptyCard\.hidden = loading/);
  assert.match(sidePanelCss, /\.workspace-skeleton\s*\{/);
  assert.match(sidePanelCss, /\.workspace-skeleton__body\s*\{[^}]*grid-template-columns:38px minmax\(0,1fr\)/s);
  assert.match(sidePanelCss, /\.workspace-empty\.loading\s*\{[^}]*padding:0[^}]*place-items:stretch/);
  assert.match(sidePanelHtml, /id="retry-connection"/);
  assert.match(sidePanelScript, /elements\.retryConnection\.addEventListener\("click", \(\) => void refreshProjectContext\(\{ showLoading: true \}\)\)/);
  assert.match(sidePanelScript, /title: "Local System unavailable"/);
  assert.match(sidePanelScript, /Retry when you want to try again/);
  assert.doesNotMatch(sidePanelScript, /apiRequestWithRetry|scheduleReconnect|reconnectTimer/);
  assert.doesNotMatch(sidePanelScript, /document\.addEventListener\("visibilitychange"/);
  assert.doesNotMatch(sidePanelScript, /Retrying automatically|Reconnecting to Local System/);
  assert.match(sidePanelScript, /message\.action === "visibility" && message\.visible === false[\s\S]*?return;/);
  assert.doesNotMatch(
    sidePanelScript,
    /message\.action === "visibility" && message\.visible === false[\s\S]{0,220}closeNativeSidePanel/,
  );
});

test("new-thread resolution is attempted once and then becomes a terminal unsupported state", () => {
  assert.match(sidePanelScript, /attemptedNewThreadKey:\s*""/);
  assert.match(sidePanelScript, /const provisionalNewThread = workspaceKey\.startsWith\("browser-tab:"\)/);
  assert.match(sidePanelScript, /if \(changed && provisionalNewThread\) state\.attemptedNewThreadKey = ""/);
  assert.match(sidePanelScript, /const initialNewThreadResolution = provisionalNewThread[\s\S]*state\.attemptedNewThreadKey !== workspaceKey/);
  assert.match(sidePanelScript, /let payload = await apiRequest\("\/local-ui\/file-workspace"/);
  assert.match(sidePanelScript, /state\.attemptedNewThreadKey === workspaceKey[\s\S]*state\.connectionState === "unsupported"[\s\S]*return;/);
  assert.match(sidePanelScript, /showWorkspaceGate\("unsupported"\)/);
  assert.match(sidePanelScript, /This website doesn’t support Local System\./);
});

test("native side panel restores the thread pane state and only forces Files after explicit project selection", () => {
  assert.match(sidePanelScript, /syncWorkspaceProject\(\{ openFiles: false \}\)/);
  assert.match(sidePanelScript, /syncWorkspaceProject\(\{ openFiles: true, forceFiles: true \}\)/);
  assert.match(sidePanelScript, /openFiles:\s*shouldOpenFiles/);
  assert.match(workspaceScript, /refreshProjectContext\(\{ openFiles = false \} = \{\}\)/);
  assert.match(workspaceScript, /if \(openFiles\) \{\s*await openWorkspaceMode\("files"\)/s);
  assert.match(workspaceScript, /event\.data\.openFiles === true/);
  assert.match(workspaceScript, /activeScrollTop:\s*0, leftMode:\s*"files"/);
  assert.match(workspaceScript, /restoreWorkspaceUiState\(payload\.workspace\)/);
  assert.match(workspaceScript, /state\.leftMode = new Set\(\["files", "git", "search"\]\)/);
  assert.match(workspaceScript, /rememberActiveScroll\(elements\.scroll\.scrollTop\)/);
  assert.match(workspaceScript, /workspace:\s*\{ activeScrollTop: scrollTop \}/);
  assert.match(sidePanelScript, /workspaceFrameProject:\s*""/);
  assert.match(sidePanelScript, /state\.currentWorkspace !== state\.workspaceFrameProject/);
  assert.match(sidePanelScript, /postWorkspace\(\{ action: "reveal-workspace" \}\)/);
  assert.doesNotMatch(sidePanelScript, /postWorkspace\(\{ active: true \}\);\s*if \(state\.currentWorkspace\) syncWorkspaceProject\(\{ openFiles: false \}\)/s);
});

test("new-chat provisional project follows the tab when ChatGPT assigns a real thread id", () => {
  assert.match(sidePanelScript, /provisionalWorkspace:\s*""/);
  assert.match(sidePanelScript, /previousKey\.startsWith\("browser-tab:"\)/);
  assert.match(sidePanelScript, /!workspaceKey\.startsWith\("browser-tab:"\)/);
  assert.match(sidePanelScript, /state\.provisionalWorkspace = previousWorkspace/);
  assert.match(sidePanelScript, /action:\s*"select_project"[\s\S]*path:\s*state\.provisionalWorkspace/);
});

test("workspace Files pane uses the wider default width", () => {
  assert.match(workspaceScript, /treeCollapsed: true, treeHeight: 257/);
  assert.match(workspaceCss, /--tree-width:\s*257px/);
});

test("native side panel owns project selection and quick-open without depending on ChatGPT DOM", () => {
  assert.match(sidePanelHtml, /id="project-picker"/);
  assert.match(sidePanelHtml, /id="quick-open-frame"/);
  assert.match(sidePanelScript, /action: "projects"/);
  assert.match(sidePanelScript, /action: "select_project"/);
  assert.match(sidePanelScript, /file-quick-open\.html/);
  assert.match(sidePanelScript, /event\.data\.action === "resize"[\s\S]*elements\.quickFrame\.style\.height/);
  assert.match(sidePanelScript, /picker-backdrop"\)\?\.addEventListener\("pointerdown", closeProjectPicker\)/);
  assert.match(sidePanelScript, /picker-backdrop"\)\?\.addEventListener\("pointerdown", \(\) => closeQuickOpen\(\{ restoreFocus: true \}\)\)/);
  assert.match(sidePanelScript, /function restoreWorkspaceFocus\b/);
  assert.match(sidePanelScript, /elements\.frame\.focus\(\{ preventScroll: true \}\)/);
  assert.match(sidePanelScript, /postWorkspace\(\{ action: "restore-focus" \}\)/);
  assert.match(sidePanelScript, /restoreFocus:\s*true/);
  assert.match(sidePanelCss, /\.quick-open-frame\s*\{[^}]*height:\s*180px[^}]*max-height:\s*min\(70vh, 520px\)/s);
  assert.match(sidePanelScript, /workspaceKeyForTab/);
  assert.match(sidePanelScript, /"browser-tab:" \+ String\(tab\?\.id/);
  assert.doesNotMatch(sidePanelScript, /group\/side-pane-shell-host|#thread|#prompt-textarea/);
});

test("native side panel and extension frames follow the live ChatGPT theme", () => {
  assert.match(contentScript, /message\.action === "read-theme"[\s\S]*composerPaletteTheme\(\)/);
  assert.match(contentScript, /action:\s*"theme-changed"/);
  assert.match(contentScript, /function scheduleLocalSystemThemeSettle\b[\s\S]*setTimeout\([\s\S]*scheduleLocalSystemThemeBroadcast\(\)[\s\S]*120/);
  assert.match(contentScript, /function themeMutationAffectsComposer\b[\s\S]*target\.contains\(editor\)/);
  assert.match(contentScript, /localSystemThemeObserver\.observe\(document\.documentElement, \{[\s\S]*attributes:\s*true,[\s\S]*subtree:\s*true,[\s\S]*data-color-scheme/);
  assert.match(contentScript, /new MutationObserver\(\(mutations\) => \{[\s\S]*themeMutationAffectsComposer\(mutation, editor\)[\s\S]*scheduleLocalSystemThemeSettle\(\)/);
  assert.match(contentScript, /broadcastThemeToLocalFrames\(theme\)/);
  assert.match(sidePanelScript, /message\.action === "theme-changed"/);
  assert.match(sidePanelScript, /function refreshProviderTheme\b/);
  assert.match(sidePanelScript, /function applyProviderTheme\b/);
  assert.match(sidePanelScript, /LocalSystemSharedRuntime\?\.applyTheme\(theme\)/);
  assert.match(sidePanelScript, /LocalSystemSharedRuntime\?\.clearTheme\(\)/);
  assert.match(sidePanelScript, /theme:\s*state\.theme/);
  assert.match(standaloneScript, /background:\s*var\(--ls-ui-surface\)/);
  assert.match(standaloneScript, /color:\s*var\(--ls-ui-text\)/);
});

test("theme mutation filtering follows the composer ancestry without reacting to unrelated UI", () => {
  const start = contentScript.indexOf("function themeMutationAffectsComposer(");
  const end = contentScript.indexOf("\nfunction broadcastThemeToLocalFrames(", start);
  assert.ok(start >= 0 && end > start, "expected theme mutation helper");
  const source = contentScript.slice(start, end).trim();

  class MockElement {
    constructor(children = []) {
      this.children = new Set(children);
    }

    contains(node) {
      return this.children.has(node);
    }
  }

  const editor = new MockElement();
  const ancestor = new MockElement([editor]);
  const unrelated = new MockElement();
  const documentElement = new MockElement();
  const body = new MockElement();
  const themeMutationAffectsComposer = Function(
    "document",
    "globalThis",
    "findComposerEditor",
    `"use strict"; return (${source});`,
  )(
    { documentElement, body },
    { Element: MockElement },
    () => editor,
  );

  assert.equal(themeMutationAffectsComposer({ target: documentElement }), true);
  assert.equal(themeMutationAffectsComposer({ target: body }), true);
  assert.equal(themeMutationAffectsComposer({ target: editor }), true);
  assert.equal(themeMutationAffectsComposer({ target: ancestor }), true);
  assert.equal(themeMutationAffectsComposer({ target: unrelated }), false);
});

test("workspace settings live in the bottom project toolbar and persist visibility changes", () => {
  assert.match(workspaceHtml, /class="left-panel-toolbar"[\s\S]*id="ui-settings-toggle"/);
  assert.match(workspaceHtml, /id="ui-settings-toggle"/);
  assert.match(workspaceHtml, /id="ui-settings-popover"/);
  assert.match(workspaceHtml, /id="project-name"[\s\S]*id="project-edit"/);
  assert.doesNotMatch(workspaceHtml, /id="workspace-menu-toggle"|id="workspace-menu-popover"/);
  assert.doesNotMatch(workspaceScript, /setWorkspaceMenuOpen/);
  assert.doesNotMatch(workspaceHtml, /data-ui-setting="activeFile"|data-ui-setting="projectContext"/);
  assert.match(workspaceHtml, /data-ui-setting="workspace"/);
  assert.match(workspaceHtml, />Embedded workspace</);
  assert.match(workspaceScript, /LocalSystemSharedRuntime\.UI_VISIBILITY_STORAGE_KEY/);
  assert.match(workspaceScript, /LocalSystemSharedRuntime\.saveUiVisibility/);
  assert.match(workspaceScript, /action: "ui-visibility"/);
  assert.match(standaloneScript, /local-system-ui-visibility-change/);
  assert.match(contentScript, /local-system-ui-visibility-change/);
});

test("workspace project selection is initiated from the workspace toolbar in both hosts", () => {
  assert.match(workspaceHtml, /id="project-name"[^>]*type="button"[^>]*aria-label="Choose project"/);
  assert.match(workspaceScript, /elements\.projectName\.addEventListener\("click", requestProjectPicker\)/);
  assert.match(workspaceScript, /action: "project-picker"/);
  assert.match(sidePanelScript, /message\.action === "project-picker"[\s\S]*openProjectPicker\(\)/);
  assert.match(contentScript, /event\.data\.action === "project-picker"[\s\S]*local-system-project-picker-request/);
});

test("native project picker uses the shared search-first dialog pattern without a redundant title", () => {
  const pickerMarkup = sidePanelHtml.slice(
    sidePanelHtml.indexOf('id="project-picker"'),
    sidePanelHtml.indexOf('id="quick-open-host"'),
  );
  assert.doesNotMatch(pickerMarkup, /id="project-picker-title"|>Choose project<|Workspace for this browser tab/);
  assert.match(sidePanelHtml, /id="project-search"[\s\S]*id="project-list"/);
  assert.match(pickerMarkup, /ls-ui-backdrop/);
  assert.match(pickerMarkup, /ls-ui-dialog-surface/);
  assert.match(pickerMarkup, /ls-ui-search-field/);
  assert.match(pickerMarkup, /ls-ui-scroll/);
  assert.match(pickerMarkup, /id="project-include-hidden"/);
  assert.match(pickerMarkup, /Include hidden folders/);
  assert.match(sidePanelScript, /includeHidden:\s*state\.projectIncludeHidden/);
  assert.match(sidePanelScript, /elements\.projectSearch\.addEventListener\("keydown", handleProjectSearchKeydown\)/);
  assert.match(sidePanelScript, /event\.key === "Enter" && !event\.isComposing/);
  assert.match(sidePanelScript, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(sidePanelScript, /project = projects\[state\.projectActiveIndex\]/);
  assert.match(sidePanelScript, /function renderProjectChoices\b/);
  assert.match(sidePanelCss, /\.project-picker-option__switch/);
  assert.doesNotMatch(sidePanelCss, /\.project-search-bar\s*\{[^}]*border-top:/s);
  assert.match(sidePanelCss, /\.picker-card\s*\{[^}]*width:\s*min\(360px,\s*100%\)/s);
});

test("native workspace refreshes when ChatGPT opens a mapped file", () => {
  assert.match(sidePanelScript, /source !== "local-system-background" \|\| message\.action !== "workspace-state-changed"/);
  assert.match(sidePanelScript, /postWorkspace\(\{ action: "project-changed", openFiles: false \}\)/);
  assert.match(contentScript, /function openFileFromChatGpt\b/);
  assert.match(contentScript, /action:\s*"open_file"/);
  assert.match(contentScript, /action:\s*"open-side-panel"/);
  assert.match(contentScript, /action:\s*"workspace-state-changed"/);
  assert.match(sidePanelScript, /pendingOpenFile:\s*null/);
  assert.match(sidePanelScript, /function flushPendingOpenFile\b/);
  assert.match(sidePanelScript, /action:\s*"open-file"/);
});

test("native workspace close control asks Chrome to close the side panel", () => {
  assert.match(workspaceScript, /HOST_MODE === "sidepanel"[\s\S]*action: "close-sidebar"/);
  assert.match(sidePanelScript, /message\.action === "close-sidebar"[\s\S]*closeNativeSidePanel\(\)/);
});

test("standalone workspace does not take over the legacy ChatGPT workspace visibility state", () => {
  assert.match(workspaceScript, /function persistedSidebarOpen\b/);
  assert.match(workspaceScript, /PRESENTATION === "standalone" \? state\.workspace\.sidebarOpen/);
  assert.match(workspaceScript, /if \(PRESENTATION === "standalone"\) \{[\s\S]*HOST_MODE === "sidepanel"[\s\S]*setVisible\(false\);\s*return;/s);
  assert.match(workspaceScript, /function workspaceShouldBeVisible\b/);
  assert.match(workspaceScript, /PRESENTATION === "standalone" \? true : workspace\?\.sidebarOpen === true/);
});

test("native workspace flushes and restores active-file scroll across thread iframe replacement", () => {
  assert.match(workspaceScript, /globalThis\.addEventListener\("pagehide", \(\) => \{[\s\S]*flushActiveScrollPersistence\(\);[\s\S]*liveSync\.stop\(\);/);
  assert.match(workspaceScript, /if \(state\.restoringScroll\) return;/);
  assert.match(workspaceScript, /function scheduleActiveScrollRestore\b/);
  assert.match(workspaceScript, /elements\.markdownRendered\.scrollTop = value/);
  assert.match(workspaceScript, /workspace:\s*\{ activeScrollTop: scrollTop \}/);
  assert.match(workspaceScript, /keepalive:\s*true/);
});

test("standalone quick-open results route back to the standalone workspace instead of the legacy pane", () => {
  assert.match(contentScript, /openFileQuickOpen\([\s\S]*"standalone"/);
  assert.match(contentScript, /target: target === "standalone" \? "standalone" : "embedded"/);
  assert.match(contentScript, /local-system-standalone-open-file/);
  assert.match(contentScript, /local-system-standalone-restore-focus/);
  assert.match(contentScript, /closeFileQuickOpen\(\{ restoreFocus: true \}\)/);
  assert.match(standaloneScript, /local-system-standalone-restore-focus/);
  assert.match(standaloneScript, /postToWorkspace\(\{ action: "restore-focus" \}\)/);
  assert.match(standaloneScript, /local-system-standalone-open-file/);
  assert.match(standaloneScript, /action: "open-file"/);
});

test("Safari iOS packaging copies the standalone content script with the rest of the extension", () => {
  assert.match(safariPrepare, /fs\.cpSync\(sourceDir, outputDir, \{ recursive: true \}\)/);
  assert.match(safariPrepare, /value !== "sidePanel"/);
  assert.match(safariPrepare, /delete manifest\.side_panel/);
});
