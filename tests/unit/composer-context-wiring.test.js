import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(
  new URL("../../extensions/local-system/manifest.json", import.meta.url),
  "utf8",
));
const composerContext = readFileSync(
  new URL("../../extensions/local-system/composer-context.js", import.meta.url),
  "utf8",
);
const annotationsContent = readFileSync(
  new URL("../../extensions/local-system/annotations-content.js", import.meta.url),
  "utf8",
);
const sharedComposerCss = readFileSync(
  new URL("../../extensions/local-system/composer-shared.css", import.meta.url),
  "utf8",
);
const composerContextCss = readFileSync(
  new URL("../../extensions/local-system/composer-context.css", import.meta.url),
  "utf8",
);
const contentScriptSource = readFileSync(
  new URL("../../extensions/local-system/content.js", import.meta.url),
  "utf8",
);

test("composer context loads before annotation integration", () => {
  const contentScript = manifest.content_scripts?.find((entry) => entry.js?.includes("composer-context.js"));
  assert.ok(contentScript, "expected ChatGPT content-script entry");
  const composerIndex = contentScript.js?.indexOf("composer-context.js") ?? -1;
  const annotationsIndex = contentScript.js?.indexOf("annotations-content.js") ?? -1;
  assert.ok(composerIndex >= 0, "composer-context.js must be loaded");
  assert.ok(annotationsIndex > composerIndex, "composer-context.js must load before annotations-content.js");
  assert.ok(contentScript.css?.includes("ui-foundation.css"), "shared Local System UI foundation must load in the ChatGPT page");
  assert.ok(contentScript.css.indexOf("ui-foundation.css") < contentScript.css.indexOf("composer-shared.css"), "UI foundation must load before composer styles");
  assert.ok(contentScript.css?.includes("composer-shared.css"), "shared composer typography must load in the ChatGPT page");
  assert.ok(contentScript.css?.includes("composer-context.css"), "composer-context.css must load in the ChatGPT page");
});

test("composer context keeps skills and project picking without workspace, Git, or active-file pills", () => {
  for (const symbol of [
    "showProjectPopover",
    "renderSkillChips",
    "serializedSkillsBlock",
  ]) {
    assert.match(composerContext, new RegExp(`\\bfunction ${symbol}\\b`), `${symbol} should live in composer-context.js`);
    assert.doesNotMatch(annotationsContent, new RegExp(`\\bfunction ${symbol}\\b`), `${symbol} should not remain defined in annotations-content.js`);
  }

  assert.doesNotMatch(composerContext, /function renderWorkspaceChip\b|function renderActiveFileChip\b|function renderGitStatusChip\b/);
  assert.doesNotMatch(composerContext, /serializedActiveFileBlock|activeFileContextEnabled|ls-active-file-chip|ls-workspace-chip|ls-git-status-chip/);
  assert.doesNotMatch(annotationsContent, /local-system-active-file-changed|local-system-git-status-changed/);
  assert.match(composerContext, /event\.key === "Enter" && visibleProjects\[activeIndex\]/, "project picker should select the active result with Enter");
  assert.match(composerContext, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/, "project picker should support keyboard navigation");
  assert.match(composerContextCss, /\.ls-project-popover\s*\{/, "project picker styling should live with composer context");
  assert.doesNotMatch(annotationsContent, /\.ls-project-popover\s*\{/, "project picker styling should not remain in annotation integration");
  assert.doesNotMatch(composerContextCss, /--ls-annotation-(?:surface|text)/, "composer styling should not depend on annotation theme variables");
});

test("workspace context hydrates project-picker state without rendering a composer project pill", () => {
  assert.match(composerContext, /workspaceResolved:\s*false/);
  assert.match(composerContext, /context\.currentWorkspace = typeof payload\.currentWorkspace === "string"/);
  assert.match(composerContext, /context\.workspaceResolved = true/);
  assert.doesNotMatch(composerContext, /renderWorkspaceChip|ls-workspace-chip/);
  assert.match(composerContext, /context\.workspaceResolved = false;[\s\S]*?context\.workspaceLoadSequence \+= 1/);
});

test("project picker uses one effective project and refreshes the workspace after selection", () => {
  assert.match(composerContext, /projectSource:\s*"none"/);
  assert.match(composerContext, /action:\s*"select_project"/);
  assert.match(composerContext, /context\.projectSource === "binding"/);
  assert.match(composerContext, /ls-project-popover__project-status/);
  assert.match(composerContext, /status\.textContent = context\.projectSource === "binding" \? "Bound" : "Saved"/);
  assert.match(composerContext, /source:\s*"project-selection"[\s\S]*?openFiles:\s*true/);
  assert.match(composerContext, /await loadWorkspaceContext\(\)/);
  assert.doesNotMatch(composerContext, /local-system-file-workspace-mode-request/);
  assert.match(composerContextCss, /\.ls-project-popover__project-status\s*\{/);
});

test("composer no longer owns Git status or active-file prompt context", () => {
  assert.doesNotMatch(composerContext, /async function loadGitStatus\b|handleGitStatusChanged|renderGitStatusChip/);
  assert.doesNotMatch(composerContext, /serializedActiveFileBlock|stripSerializedActiveFileBlock|activeFilePath|activeFileContextEnabled/);
  assert.doesNotMatch(annotationsContent, /local-system-git-status-changed|local-system-active-file-changed/);
  assert.doesNotMatch(annotationsContent, /serializedActiveFileBlock|stripSerializedActiveFileBlock/);
});

test("late or replaced ChatGPT composers reconcile Local System composer surfaces once per editor identity", () => {
  assert.match(annotationsContent, /composerEditor:\s*null/);
  assert.match(annotationsContent, /function reconcileComposerSurface\(\)[\s\S]*?if \(editor === state\.composerEditor\) return;[\s\S]*?renderComposerChip\(\);[\s\S]*?composerContext\.render\(\)/);
  assert.match(annotationsContent, /new globalThis\.MutationObserver\([\s\S]*?reconcileComposerSurface\(\);[\s\S]*?nativeSelectionObserver\.observe/);
});

test("composer surfaces share the workspace-pill typography token", () => {
  assert.match(sharedComposerCss, /--ls-composer-font-size:\s*var\(--ls-ui-font-size,\s*13px\)/, "shared composer font size should derive from the UI foundation");
  assert.match(sharedComposerCss, /--ls-composer-font-weight:\s*500/, "shared composer font weight should default to the workspace-pill weight");
  assert.match(sharedComposerCss, /--ls-composer-line-height:\s*1\.2/, "shared composer line height should default to the workspace-pill line height");
  assert.match(
    sharedComposerCss,
    /--ls-composer-font:\s*var\(--ls-composer-font-weight\) var\(--ls-composer-font-size\)\/var\(--ls-composer-line-height\) var\(--ls-composer-font-family\)/,
    "shared composer shorthand should derive from the synchronized typography tokens",
  );
  assert.match(composerContextCss, /\.ls-project-popover[\s\S]*?font:\s*var\(--ls-composer-font\)/, "project picker should use the shared workspace-pill font");
  assert.match(composerContextCss, /\.ls-project-popover\s*\{[\s\S]*?overflow:\s*hidden/, "project picker should clip content to its dialog boundary");
  assert.match(composerContextCss, /\.ls-project-popover__list\s*\{[\s\S]*?min-height:\s*0[\s\S]*?overflow-y:\s*auto/, "project results should scroll inside the dialog rather than bleed out");

  for (const file of ["todos.html", "skills.html", "files.html", "file-quick-open.html"]) {
    const html = readFileSync(new URL(`../../extensions/local-system/${file}`, import.meta.url), "utf8");
    assert.match(html, /href="ui-foundation\.css"/, `${file} should load the shared UI foundation`);
    assert.match(html, /href="composer-shared\.css"/, `${file} should load shared composer typography`);
  }
});

test("project picker consumes the shared dialog primitives", () => {
  assert.match(composerContext, /ls-project-popover ls-ui-floating-surface/);
  assert.match(composerContext, /ls-project-popover__search ls-ui-search-field/);
  assert.match(composerContext, /ls-project-popover__list ls-ui-scroll/);
  assert.match(composerContext, /ls-project-popover__project ls-ui-list-row/);
  assert.match(composerContextCss, /\.ls-project-popover\s*\{[^}]*border:\s*0[^}]*var\(--ls-ui-radius-floating\)[^}]*var\(--ls-ui-shadow-floating\)/s);
});

test("composer context does not render a duplicate text handoff control", () => {
  assert.doesNotMatch(composerContext, /THREAD_HANDOFF_PROMPT|renderThreadHandoffButton|ls-thread-handoff-button|button\.textContent = "Handoff"/);
  assert.doesNotMatch(composerContextCss, /\.ls-thread-handoff-button\s*\{/);
});

test("thread rail icon actions match the circular refresh-button treatment", () => {
  assert.match(contentScriptSource, /\.local-system-rail-actions\s*\{[^}]*display:\s*flex[^}]*height:\s*42px/s);
  assert.match(sharedComposerCss, /\.composer-icon-button\s*\{[^}]*display:\s*inline-grid[^}]*width:\s*42px[^}]*height:\s*42px[^}]*border-radius:\s*19px/s);
  assert.match(sharedComposerCss, /\.composer-icon-button\s*\{[^}]*background:\s*var\(--ls-ui-control-bg\)[^}]*color:\s*var\(--ls-ui-text\)/s);
  assert.match(sharedComposerCss, /\.composer-icon-button:hover\s*\{[^}]*background:\s*var\(--ls-ui-control-hover\)/s);
  assert.match(sharedComposerCss, /\.composer-icon-button svg\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/s);
});

test("thread notes popover is positioned to the right of its composer button", () => {
  assert.match(contentScriptSource, /function positionThreadNotesPopover\(\)/);
  assert.match(contentScriptSource, /rect\.right \+ 8/);
  assert.match(contentScriptSource, /popover\.style\.left =/);
  assert.match(contentScriptSource, /popover\.style\.right = "auto"/);
  assert.match(contentScriptSource, /innerHeight - rect\.bottom/);
});
