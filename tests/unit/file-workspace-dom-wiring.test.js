import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workspaceScript = readFileSync(
  new URL("../../extensions/local-system/file-workspace.js", import.meta.url),
  "utf8",
);
const paneHoverScript = readFileSync(
  new URL("../../extensions/local-system/file-workspace-pane-hover.js", import.meta.url),
  "utf8",
);
const liveSyncScript = readFileSync(
  new URL("../../extensions/local-system/file-workspace-live-sync.js", import.meta.url),
  "utf8",
);
const workspaceHtml = readFileSync(
  new URL("../../extensions/local-system/file-workspace.html", import.meta.url),
  "utf8",
);
const workspaceCss = readFileSync(
  new URL("../../extensions/local-system/file-workspace.css", import.meta.url),
  "utf8",
);
const contentScript = readFileSync(
  new URL("../../extensions/local-system/content.js", import.meta.url),
  "utf8",
);
const annotationsScript = readFileSync(
  new URL("../../extensions/local-system/annotations-content.js", import.meta.url),
  "utf8",
);
const quickOpenScript = readFileSync(
  new URL("../../extensions/local-system/file-quick-open.js", import.meta.url),
  "utf8",
);
const quickOpenHtml = readFileSync(
  new URL("../../extensions/local-system/file-quick-open.html", import.meta.url),
  "utf8",
);
const quickOpenCss = readFileSync(
  new URL("../../extensions/local-system/file-quick-open.css", import.meta.url),
  "utf8",
);
const workspaceServer = readFileSync(
  new URL("../../src/lib/local-file-workspace.js", import.meta.url),
  "utf8",
);

test("file workspace element references are declared DOM elements", () => {
  const objectMatch = workspaceScript.match(/const elements = \{([\s\S]*?)\n\};/);
  assert.ok(objectMatch, "expected file-workspace.js to declare an elements map");

  const declared = new Map();
  for (const match of objectMatch[1].matchAll(/^\s*([A-Za-z_$][\w$]*):\s*document\.getElementById\("([^"]+)"\),?$/gm)) {
    declared.set(match[1], match[2]);
  }

  const referenced = new Set(
    [...workspaceScript.matchAll(/\belements\.([A-Za-z_$][\w$]*)\b/g)].map((match) => match[1]),
  );
  for (const target of referenced) {
    assert.ok(declared.has(target), `elements.${target} is referenced but not declared`);
  }

  for (const [target, id] of declared) {
    assert.match(
      workspaceHtml,
      new RegExp(`\\bid=["']${id}["']`),
      `elements.${target} points to missing #${id} in file-workspace.html`,
    );
  }
});

test("file workspace typography follows the live ChatGPT typography contract", () => {
  assert.match(contentScript, /contentFontSize:\s*contentTypographyStyle\?\.fontSize/);
  assert.match(contentScript, /contentLineHeight:\s*contentTypographyStyle\?\.lineHeight/);
  assert.match(workspaceScript, /--workspace-ui-font-size/);
  assert.match(workspaceScript, /--workspace-secondary-font-size/);
  assert.match(workspaceScript, /--workspace-code-font-size/);
  assert.match(workspaceScript, /--workspace-code-line-height/);
  assert.match(workspaceScript, /WORKSPACE_CONTENT_SCALE\s*=\s*0\.94/);
  assert.match(workspaceScript, /scaledPixelValue\(contentFontSize, WORKSPACE_CONTENT_SCALE\)/);
  assert.match(workspaceScript, /scaledPixelValue\(contentLineHeight, WORKSPACE_CONTENT_SCALE\)/);
  assert.match(workspaceScript, /state\.codeLineHeight\s*=\s*parsed/);
  assert.match(workspaceCss, /--workspace-ui-font-size:\s*var\(--ls-ui-font-size\)/);
  assert.match(workspaceCss, /--workspace-secondary-font-size:\s*var\(--ls-ui-font-size-secondary\)/);
  assert.match(workspaceCss, /--workspace-code-font-size:\s*15px/);
  assert.match(workspaceCss, /--workspace-code-line-height:\s*22\.5px/);
});

test("annotation markers follow rendered range geometry for wrapped lines", () => {
  assert.match(workspaceScript, /function annotationMarkerTop\b/);
  assert.match(workspaceScript, /root === elements\.markdownRendered[\s\S]*?markdownRangeFromSourceOffsets\(offsets\.start, offsets\.end\)[\s\S]*?: rangeFromOffsets\(root, offsets\.start, offsets\.end\)/);
  assert.match(workspaceScript, /range\.getClientRects\(\)/);
  assert.match(workspaceScript, /const measuredTop = rangeRect\.top - markersRect\.top/);
  assert.match(workspaceScript, /const naturalTops = annotations\.map\(\(annotation\) => annotationMarkerTop\(annotation, root, scroller\)\)/);
  assert.match(workspaceScript, /function scheduleAnnotationMarkers\b/);
  assert.match(workspaceScript, /function layoutAnnotationMarkerTops\b/);
  assert.match(workspaceScript, /marker\.dataset\.offscreen = offscreen/);
  assert.match(workspaceScript, /marker\.addEventListener\("click",[\s\S]*?openAnnotationEditor\(\{ annotation, anchor: marker \}\)/);
  assert.match(workspaceCss, /\.annotation-marker[^{]*\{[^}]*pointer-events:auto/s);
  assert.match(workspaceCss, /\.annotation-markers[^{]*\{[^}]*position:absolute[^}]*contain:layout paint/s);
  assert.match(workspaceScript, /function positionAnnotationMarkerLayer\b/);
  assert.match(workspaceScript, /scroller\.clientWidth - width/);
  assert.doesNotMatch(workspaceScript, /if \(top < -24 \|\| top > viewportHeight - 4\) return/);
});

test("persistent annotation marker layout keeps offscreen markers visible without collisions", () => {
  const start = workspaceScript.indexOf("function layoutAnnotationMarkerTops(");
  const end = workspaceScript.indexOf("\nfunction annotationMarkerTop(", start);
  assert.ok(start >= 0 && end > start, "expected the pure marker layout helper");
  const source = workspaceScript.slice(start, end).trim();
  const layoutAnnotationMarkerTops = Function(`"use strict"; return (${source});`)();

  assert.deepEqual(layoutAnnotationMarkerTops([100], 400), [100]);
  assert.deepEqual(layoutAnnotationMarkerTops([-200, 900], 400), [4, 366]);
  assert.deepEqual(layoutAnnotationMarkerTops([-200, -100], 400), [4, 38]);
  assert.deepEqual(layoutAnnotationMarkerTops([900, 1_000], 400), [332, 366]);
});

test("annotation and supporting workspace text use normalized typography tokens", () => {
  assert.match(workspaceCss, /\.annotate-selection[^{]*\{[^}]*font-size:var\(--workspace-ui-font-size\)/s);
  assert.match(workspaceCss, /\.annotation-editor textarea[^{]*\{[^}]*font-size:var\(--workspace-code-font-size\)[^}]*line-height:var\(--workspace-code-line-height\)/s);
  assert.match(workspaceCss, /\.annotation-cancel[^{]*\{[^}]*font-size:var\(--workspace-ui-font-size\)/s);
  assert.match(workspaceCss, /\.annotation-tooltip[^{]*\{[^}]*font-size:var\(--workspace-ui-font-size\)/s);
  assert.match(workspaceCss, /\.tooltip-quote[^{]*\{[^}]*font:var\(--workspace-secondary-font-size\)/s);
  assert.match(workspaceCss, /\.file-edit-status[^{]*\{[^}]*font-size:var\(--workspace-secondary-font-size\)/s);
  assert.match(workspaceCss, /\.line-numbers[^{]*\{[^}]*font-size:var\(--workspace-secondary-font-size\)/s);
  assert.match(workspaceCss, /\.edit-line-numbers[^{]*\{[^}]*font-size:var\(--workspace-secondary-font-size\)/s);
  assert.doesNotMatch(workspaceCss, /font-size:(?:9\.5|10|10\.5|11\.5)px/);
});

test("file workspace exposes refresh, unified preview, and in-place rendered-markdown editing", () => {
  assert.match(workspaceHtml, /id="refresh-file"/);
  assert.match(workspaceHtml, /id="copy-annotations"/);
  assert.doesNotMatch(workspaceHtml, /id="sync-annotations"/);
  assert.match(workspaceHtml, /id="preview-file"[^>]*aria-pressed="false"/);
  assert.match(workspaceHtml, /id="markdown-rendered"[^>]*hidden/);
  assert.match(workspaceHtml, /id="html-rendered"[^>]*sandbox="allow-scripts"[^>]*hidden/);
  assert.doesNotMatch(workspaceHtml, /id="html-rendered"[^>]*allow-same-origin/);
  assert.match(workspaceHtml, /id="file-action-bar"[^>]*hidden/);
  assert.doesNotMatch(workspaceHtml, /id="breadcrumb"/);
  assert.match(workspaceCss, /\.file-action-bar[^{]*\{[^}]*justify-content:flex-end[^}]*height:34px/s);
  assert.doesNotMatch(workspaceCss, /\.file-action-bar[^{]*\{[^}]*position:absolute/s);
  assert.match(workspaceScript, /elements\.refreshFile\.addEventListener\("click", refreshActiveFile\)/);
  assert.match(workspaceScript, /elements\.copyAnnotations\.addEventListener\("click", copyActiveFileAnnotations\)/);
  assert.match(workspaceScript, /elements\.previewFile\.addEventListener\("click", togglePreview\)/);
  assert.match(workspaceScript, /async function refreshActiveFile\b/);
  assert.match(workspaceScript, /state\.files\.delete\(path\)/);
  assert.match(workspaceScript, /await showPath\(path\)/);
  assert.match(workspaceScript, /function togglePreview\b/);
  assert.match(workspaceScript, /function renderMarkdown\b/);
  assert.match(workspaceScript, /previewByPath/);
  assert.match(workspaceScript, /function isHtmlPath\b/);
  assert.match(workspaceScript, /function showHtmlPreview\b/);
  assert.match(workspaceScript, /"\/local-ui\/files\/html-preview"/);
  assert.match(workspaceScript, /function markdownPreviewEnabled\b/);
  assert.match(workspaceScript, /!state\.previewByPath\.has\(path\)/);
  assert.match(workspaceScript, /function scheduleMarkdownPreview\b/);
  assert.match(workspaceScript, /pendingMarkdownPreviewPath !== state\.workspace\.activePath/);
  assert.match(workspaceScript, /elements\.editViewer\.hidden = true/);
  assert.match(workspaceScript, /elements\.markers\.hidden = Boolean\(state\.fileEdit\?\.dirty\)/);
  assert.match(workspaceScript, /function beginMarkdownBlockEdit\b/);
  assert.match(workspaceScript, /className = "markdown-block-editor"/);
  assert.match(workspaceScript, /if \(!event\.altKey \|\| \(event\.key !== "Enter" && event\.key !== " "\)\) return/);
  assert.doesNotMatch(workspaceScript, /markdownSourceOffsetAtViewportPoint/);
  assert.match(workspaceScript, /function markdownInlineEditKind\b/);
  assert.match(workspaceScript, /function applyMarkdownInlineEditorStyle\b/);
  assert.match(workspaceScript, /textarea\.style\.fontFamily = blockStyle\.fontFamily/);
  assert.match(workspaceScript, /textarea\.setSelectionRange\(caret, caret\)/);
  assert.match(workspaceScript, /event\.key === "Escape"[\s\S]*cancelMarkdownBlockEdit\(\)/);
  assert.match(workspaceScript, /dataset\.markdownStart/);
  assert.match(workspaceScript, /dataset\.markdownEnd/);
  assert.match(workspaceScript, /syncFileEditDirtyUi\(dirty, \{ showAnnotations: false \}\)/);
  assert.match(workspaceScript, /function materializeMarkdownBlockEdit\b/);
  assert.match(workspaceScript, /const content = materializeMarkdownBlockEdit\(\)/);
  assert.match(workspaceCss, /\.markdown-editable-block/);
  assert.doesNotMatch(workspaceCss, /\.markdown-editable-block:hover/);
  assert.doesNotMatch(workspaceCss, /\.markdown-editable-block:focus-visible/);
  assert.match(workspaceCss, /\.markdown-block-editor/);
  assert.match(workspaceCss, /\.markdown-block-editor\s*\{[^}]*border:0[^}]*background:transparent[^}]*font:inherit/s);
  assert.match(workspaceCss, /\.markdown-block-edit-shell:focus-within/);
  assert.match(workspaceCss, /\[data-markdown-block-kind="blockquote"\]/);
  assert.match(workspaceCss, /\[data-markdown-block-kind="code"\]/);
  assert.doesNotMatch(workspaceCss, /\.text-viewer\.markdown-preview-active \.edit-viewer/);
});

test("workspace toolbar can copy the active file annotations without owning provider sync", () => {
  assert.doesNotMatch(workspaceScript, /syncActiveFileAnnotations|syncAnnotations:/);
  assert.match(workspaceScript, /async function copyActiveFileAnnotations\b/);
  assert.match(workspaceScript, /const mediaNotes = \(state\.workspace\.mediaNotes \|\| \[\]\)\.filter\(\(item\) => item\.path === path\)/);
  assert.match(workspaceScript, /navigator\.clipboard\.writeText\(formatFileAnnotationsForClipboard\(path, annotations, mediaNotes\)\)/);
  assert.match(workspaceScript, /function formatFileAnnotationsForClipboard\b/);
  assert.match(workspaceScript, /\[Annotations\]/);
  assert.match(workspaceScript, /\[\/Annotations\]/);
  assert.match(workspaceScript, /Selected text:/);
  assert.match(workspaceScript, /Timestamp:/);
  assert.match(workspaceScript, /Comment:/);
  assert.match(workspaceScript, /function showCopySuccess\b/);
  assert.match(workspaceScript, /button\.innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"\/><\/svg>'/);
});

test("Files tree uses a restrained engineering file icon set", () => {
  assert.match(workspaceScript, /function fileTreeIconMarkup\b/);
  assert.match(workspaceScript, /\.gitignore/);
  assert.match(workspaceScript, /tree-row__file-badge--env">ENV/);
  assert.match(workspaceScript, /tree-row__file-badge--md">MD/);
  assert.match(workspaceScript, /tree-row__file-badge--py">PY/);
  assert.match(workspaceScript, /tree-row__file-badge--js">JS/);
  assert.match(workspaceScript, /tree-row__file-badge--ts">TS/);
  assert.match(workspaceCss, /\.tree-row__file-badge\s*\{/);
  assert.match(workspaceCss, /\.tree-row__icon--git\s*\{[^}]*#f05032/);
  assert.match(workspaceCss, /\.tree-row__file-badge--env\s*\{[^}]*#c9ad12/);
  assert.match(workspaceCss, /\.tree-row__file-badge--md\s*\{[^}]*#519aba/);
  assert.match(workspaceCss, /\.tree-row__file-badge--py\s*\{[^}]*#3776ab/);
  assert.match(workspaceCss, /\.tree-row__file-badge--js\s*\{[^}]*#d6b900/);
  assert.match(workspaceCss, /\.tree-row__file-badge--ts\s*\{[^}]*#3178c6/);
  assert.doesNotMatch(workspaceCss, /\.tree-row__file-badge--(?:env|md|py|js|ts)\s*\{[^}]*background:/);
  assert.match(workspaceCss, /\.tree-row__file-badge\s*\{[^}]*font:650 9px\/1/);
});

test("Files tree keeps Git status out of Explorer presentation and swaps polished folder icons when expanded", () => {
  assert.doesNotMatch(workspaceScript, /classList\.toggle\("dotfile"/);
  assert.doesNotMatch(workspaceCss, /\.tree-row\.dotfile/);
  assert.doesNotMatch(workspaceScript, /untrackedPaths:\s*new Set\(\)/);
  assert.doesNotMatch(workspaceScript, /isGitUntrackedPath|refreshTreeGitDecorations/);
  assert.doesNotMatch(workspaceScript, /classList\.toggle\("untracked"/);
  assert.doesNotMatch(workspaceCss, /\.tree-row\.untracked|\.files-search-result\.untracked/);
  assert.match(workspaceScript, /function folderTreeIconMarkup\b/);
  assert.match(workspaceScript, /tree-row__folder-icon--closed/);
  assert.match(workspaceScript, /tree-row__folder-icon--open/);
  assert.match(workspaceScript, /tree-row__file-icon/);
  assert.match(workspaceScript, /M3\.75 7\.25A2\.25 2\.25/);
  assert.match(workspaceScript, /M4\.25 18\.75 6\.45 12/);
  assert.match(workspaceScript, /M7 3\.75h6\.5l3\.5 3\.5v13H7z/);
  assert.match(workspaceCss, /\.tree-row\.expanded \.tree-row__folder-icon--closed\s*\{[^}]*display:none/);
  assert.match(workspaceCss, /\.tree-row\.expanded \.tree-row__folder-icon--open\s*\{[^}]*display:block/);
});

test("editable files provide VS Code-style scroll-past-end space", () => {
  assert.match(workspaceCss, /--editor-scroll-past-end:\s*clamp\(140px,\s*32vh,\s*360px\)/);
  assert.match(workspaceCss, /\.file-editor\s*\{[^}]*padding:12px 50px var\(--editor-scroll-past-end\) 14px/s);
  assert.match(workspaceCss, /\.edit-highlight\s*\{[^}]*var\(--editor-scroll-past-end\)/s);
  assert.match(workspaceCss, /\.edit-line-numbers\s*\{[^}]*var\(--editor-scroll-past-end\)/s);
  assert.match(workspaceCss, /\.line-wrap-measure\s*\{[^}]*var\(--editor-scroll-past-end\)/s);
});

test("workspace files are draggable with a Local System file payload", () => {
  assert.match(workspaceScript, /const LOCAL_FILE_DRAG_MIME = "application\/x-local-system-file"/);
  assert.match(workspaceScript, /function makeFileDraggable\b/);
  assert.match(workspaceScript, /element\.draggable = true/);
  assert.match(workspaceScript, /transfer\.effectAllowed = "copy"/);
  assert.match(workspaceScript, /transfer\.setData\(LOCAL_FILE_DRAG_MIME, JSON\.stringify\(/);
  assert.match(workspaceScript, /transfer\.setData\("text\/plain", path\)/);
  assert.match(workspaceScript, /makeFileDraggable\(row, entry\.path, entry\.name\)/);
  assert.match(workspaceScript, /makeFileDraggable\(row, file\.path, file\.name \|\| basename\(file\.path\)\)/);
  assert.match(workspaceScript, /makeFileDraggable\(tab, path, basename\(path\)\)/);
  assert.match(workspaceScript, /makeFileDraggable\(row, file\.absolutePath, basename\(file\.absolutePath\)\)/);
  assert.match(workspaceCss, /\.local-file-drag-source\.dragging\s*\{[^}]*opacity:\.48/);
});

test("file loading uses an editor-shaped skeleton instead of loading text", () => {
  assert.match(workspaceHtml, /id="file-loading-skeleton"/);
  assert.match(workspaceHtml, /file-loading-skeleton__gutter/);
  assert.match(workspaceHtml, /file-loading-skeleton__code/);
  assert.match(workspaceScript, /function showFileLoadingSkeleton\b/);
  assert.match(workspaceScript, /showFileLoadingSkeleton\(\);[\s\S]*const file = await loadFile\(path\)/);
  assert.doesNotMatch(workspaceScript, /showMessage\("Loading file…"/);
  assert.match(workspaceScript, /elements\.fileLoadingSkeleton\.hidden = true;[\s\S]*elements\.loading\.hidden = false;[\s\S]*elements\.loading\.textContent = message/s);
  assert.match(workspaceCss, /\.file-loading-skeleton\s*\{/);
  assert.match(workspaceCss, /@keyframes file-loading-skeleton-pulse/);
});

test("common dotfiles render as text even when the server reports octet-stream", () => {
  assert.match(workspaceScript, /const TEXT_DOTFILES = new Set\(\[/);
  assert.match(workspaceScript, /"\.gitignore"/);
  assert.match(workspaceScript, /"\.npmrc"/);
  assert.match(workspaceScript, /name === "\.env" \|\| name\.startsWith\("\.env\."\)/);
  assert.match(workspaceScript, /if \(index === 0\) return name\.slice\(1\)\.toLowerCase\(\)/);
});

test("preview raw/rendered mode persists per file in workspace state", () => {
  assert.match(workspaceScript, /previewViewByPath:\s*\{\}/);
  assert.match(workspaceScript, /state\.previewByPath\.clear\(\)/);
  assert.match(workspaceScript, /Object\.entries\(state\.workspace\.previewViewByPath \|\| \{\}\)/);
  assert.match(workspaceScript, /\[path\]: next \? "rendered" : "raw"/);
  assert.match(workspaceScript, /async function persistPreviewViewModes\b/);
  assert.match(workspaceScript, /persistWorkspace\(\{[\s\S]*previewViewByPath:/);
});

test("rendered Markdown supports GFM-style tables and GitHub-like syntax colors", () => {
  assert.match(workspaceScript, /function markdownTableDefinition\b/);
  assert.match(workspaceScript, /function splitMarkdownTableRow\b/);
  assert.match(workspaceScript, /document\.createElement\("table"\)/);
  assert.match(workspaceScript, /document\.createElement\("thead"\)/);
  assert.match(workspaceScript, /document\.createElement\("tbody"\)/);
  assert.match(workspaceScript, /setMarkdownTableAlignment/);
  assert.match(workspaceCss, /\.markdown-rendered table\s*\{/);
  assert.match(workspaceCss, /\.markdown-rendered th,\.markdown-rendered td\s*\{/);
  assert.match(workspaceCss, /--md-syntax-keyword:#cf222e/);
  assert.match(workspaceCss, /--md-syntax-keyword:#ff7b72/);
  assert.match(workspaceCss, /\.markdown-rendered \.hljs-keyword/);
});

test("rendered Markdown keeps source mappings so selections can be annotated in preview", () => {
  assert.match(workspaceScript, /function markMarkdownTextRegion\b/);
  assert.match(workspaceScript, /data-markdown-text-start|markdownTextStart/);
  assert.match(workspaceScript, /function markdownProjectionTokens\b/);
  assert.match(workspaceScript, /function markdownSourceOffsetAtRenderedPoint\b/);
  assert.match(workspaceScript, /function markdownRangeFromSourceOffsets\b/);
  assert.match(workspaceScript, /function handleMarkdownRenderedSelection\b/);
  assert.match(workspaceScript, /sourceQuote = state\.activeText\.slice\(startOffset, endOffset\)/);
  assert.match(workspaceScript, /markdownPreviewVisible\(\)\) return handleMarkdownRenderedSelection\(\)/);
  assert.match(workspaceScript, /markdownRangeFromSourceOffsets\(offsets\.start, offsets\.end\)/);
});

test("in-place Markdown block editor can annotate unchanged source selections", () => {
  assert.match(workspaceScript, /function handleMarkdownBlockEditorSelection\b/);
  assert.match(workspaceScript, /edit\.changed\) return hideSelectionAction\(\)/);
  assert.match(workspaceScript, /edit\.start \+ start, edit\.start \+ end/);
  assert.match(workspaceScript, /textarea\.addEventListener\("mouseup", \(event\) => handleMarkdownBlockEditorSelection\(event\)\)/);
  assert.match(workspaceScript, /if \(event\.shiftKey\) handleMarkdownBlockEditorSelection\(\)/);
  assert.match(workspaceScript, /if \(!selection\?\.rangeCount \|\| selection\.isCollapsed\) return hideSelectionAction\(\)/);
});

test("file workspace annotation marker uses matching chat-bubble geometry", () => {
  assert.match(workspaceCss, /\.annotation-marker\s*\{[^}]*width:30px[^}]*height:30px/s);
  assert.match(workspaceCss, /\.annotation-marker::before\s*\{[^}]*background:var\(--ls-ui-primary-bg\)[^}]*transform:rotate\(30deg\)/s);
  assert.match(workspaceScript, /marker\.textContent = String\(index \+ 1\)/);
  assert.match(workspaceScript, /marker\.setAttribute\("aria-label", `Open annotation \$\{index \+ 1\}`\)/);
  assert.doesNotMatch(workspaceScript, /marker\.innerHTML = '<svg viewBox="0 0 24 24"/);
  assert.match(workspaceScript, /const markerHeight = 30/);
});

test("annotation markers show visual numbers while serialized prompt metadata stays unnumbered", () => {
  assert.match(annotationsScript, /marker\.textContent = String\(index \+ 1\)/);
  assert.match(annotationsScript, /marker\.setAttribute\("aria-label", `Open annotation \$\{index \+ 1\}`\)/);
  assert.match(annotationsScript, /lines\.push\(`- Selected text:/);
  assert.match(annotationsScript, /lines\.push\(`- File:/);
  assert.doesNotMatch(annotationsScript, /lines\.push\(`\$\{index \+ 1\}\. Selected text:/);
  assert.match(workspaceScript, /marker\.textContent = String\(index \+ 1\)/);
  assert.match(workspaceScript, /marker\.setAttribute\("aria-label", `Open annotation \$\{index \+ 1\}`\)/);
});

test("current-file find supports Cmd+F, match counts, and navigation", () => {
  assert.doesNotMatch(workspaceHtml, /id="find-in-file"/);
  assert.match(workspaceHtml, /id="file-find-bar"[^>]*hidden/);
  assert.match(workspaceHtml, /id="file-find-input"[^>]*type="search"/);
  assert.match(workspaceHtml, /id="file-find-previous"/);
  assert.match(workspaceHtml, /id="file-find-next"/);
  assert.match(workspaceHtml, /id="file-find-count"/);
  assert.match(workspaceScript, /event\.key\.toLowerCase\(\) === "f"/);
  assert.match(workspaceScript, /function openFileFind\b/);
  assert.match(workspaceScript, /function findLiteralMatches\b/);
  assert.match(workspaceScript, /function moveFileFind\b/);
  assert.match(workspaceScript, /function revealActiveFileFind\b/);
  assert.match(workspaceScript, /revealSourceRange\(match\.start, match\.end/);
  assert.match(workspaceScript, /markdownPreviewVisible\(\)/);
  assert.match(workspaceCss, /\.file-find-bar/);
  assert.match(workspaceCss, /::highlight\(local-file-find-current\)/);

  const start = workspaceScript.indexOf("function findLiteralMatches");
  const end = workspaceScript.indexOf("function moveFileFind", start);
  assert.ok(start >= 0 && end > start);
  const source = workspaceScript.slice(start, end).trim();
  const findLiteralMatches = Function(`"use strict"; return (${source});`)();
  assert.deepEqual(findLiteralMatches("Alpha beta ALPHA", "alpha"), [
    { start: 0, end: 5 },
    { start: 11, end: 16 },
  ]);
  assert.deepEqual(findLiteralMatches("anything", ""), []);
});

test("code navigation supports definition, references, and location history", () => {
  assert.match(workspaceScript, /event\.ctrlKey[^\n]+event\.code === "Minus"/);
  assert.match(workspaceScript, /navigateCodeHistory\(event\.shiftKey \? 1 : -1\)/);
  assert.match(workspaceScript, /event\.key === "F12"/);
  assert.match(workspaceScript, /goToDefinitionAtCursor\(\)/);
  assert.match(workspaceScript, /findReferencesAtCursor\(\)/);
  assert.match(workspaceScript, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(workspaceScript, /function rememberCodeNavigationOrigin\b/);
  assert.match(workspaceScript, /function captureCodeLocation\b/);
  assert.match(workspaceScript, /function bestDefinitionMatch\b/);
  assert.match(workspaceScript, /\/local-ui\/files\/content-search/);
  assert.match(workspaceScript, /requestQuickOpen\("text", symbol\)/);
  assert.match(contentScript, /openFileQuickOpen\(event\.data\.mode === "text" \? "text" : "files", event\.data\.query\)/);
  assert.match(contentScript, /query=\$\{encodeURIComponent\(String\(query \|\| ""\)\.slice\(0, 300\)\)\}/);
  assert.match(quickOpenScript, /const initialQuery=\(params\.get\("query"\)\|\|""\)\.slice\(0,300\)/);
  assert.match(quickOpenScript, /if\(initialQuery\)search\.value=initialQuery/);
});

test("workspace integrates full-text search in the left panel while keeping file quick-open", () => {
  assert.match(workspaceHtml, /id="full-text-search"/);
  assert.match(workspaceHtml, /id="left-search-panel"/);
  assert.match(workspaceHtml, /id="workspace-search-input"/);
  assert.match(workspaceHtml, /id="workspace-search-results"/);
  assert.match(quickOpenHtml, /id="mode-files"/);
  assert.match(quickOpenScript, /\/local-ui\/files\/search/);
  assert.match(workspaceScript, /function scheduleWorkspaceSearch\b/);
  assert.match(workspaceScript, /function runWorkspaceSearch\b/);
  assert.match(workspaceScript, /\/local-ui\/files\/content-search/);
  assert.match(workspaceScript, /state\.search\.controller\?\.abort\(\)/);
  assert.match(workspaceScript, /workspaceOnly:\s*true/);
  assert.match(workspaceScript, /openFile\(match\.path, match\.line, match\.column, length\)/);
  assert.match(contentScript, /openFileInWorkspace\([\s\S]*event\.data\.path,[\s\S]*\{ restoreFocus: true \},[\s\S]*\)/);
  assert.match(workspaceScript, /elements\.fileEditor\.setSelectionRange\(offset, selectionEnd\)/);
  assert.match(contentScript, /key === "f" && event\.shiftKey \? "search"/);
  assert.match(contentScript, /openFileWorkspaceMode\("search"\)/);
  assert.match(workspaceScript, /ensureLeftPane\("search"\)/);
  assert.match(workspaceCss, /\.search-panel/);
  assert.match(workspaceCss, /\.workspace-search-result/);
});

test("Files pane uses inline filename search while Cmd+P remains modal quick-open", () => {
  assert.match(workspaceHtml, /id="files-search-input"[^>]*placeholder="Search files"/);
  assert.match(workspaceHtml, /id="files-search-results"/);
  assert.match(workspaceHtml, /id="files-search-list"/);
  assert.doesNotMatch(workspaceHtml, /id="quick-open"/);
  assert.match(workspaceScript, /async function runFilesSearch\b/);
  assert.match(workspaceScript, /bridgeRequest\("\/local-ui\/files\/search"/);
  assert.match(workspaceScript, /workspaceOnly:\s*true/);
  assert.match(workspaceScript, /function fileSearchContext\b/);
  assert.match(workspaceScript, /return parts\.join\("\/"\)/);
  assert.doesNotMatch(workspaceScript, /const project = basename\(state\.currentWorkspace\)/);
  assert.match(workspaceScript, /moveFilesSearchSelection\(1\)/);
  assert.match(workspaceScript, /moveFilesSearchSelection\(-1\)/);
  assert.match(workspaceScript, /void openFile\(file\.path\)/);
  assert.match(workspaceScript, /requestQuickOpen\("files"\)/);
  assert.match(workspaceScript, /PRESENTATION === "standalone" && HOST_MODE === "sidepanel"[\s\S]*focusFilesSearch\(\{ select: true \}\)/);
  assert.match(workspaceCss, /#left-files-panel\s*\{[^}]*grid-template-rows:34px minmax\(0,1fr\)/);
  assert.match(workspaceCss, /\.files-search-result__context\s*\{/);
  assert.match(workspaceCss, /\.files-search-result__context:empty\s*\{\s*display:none/);
});

test("Cmd+P keeps the best match selected until the pointer actually moves", () => {
  assert.match(quickOpenScript, /let pointerBaseline=null; let pointerSelectionArmed=false/);
  assert.match(quickOpenScript, /function resetPointerActivation\(\)/);
  assert.match(quickOpenScript, /results\.addEventListener\("pointermove",handlePointerMove/);
  assert.match(quickOpenScript, /row\.addEventListener\("mouseenter",\(\)=>\{if\(pointerSelectionArmed\)setActive\(index\);\}\)/);
  assert.match(quickOpenCss, /html\[data-pointer-active="true"\] \.row:hover/);
  assert.doesNotMatch(quickOpenCss, /\.row\.active,\.row:hover/);
});

test("workspace uses horizontal panes with Files, Changes, and Search tools", () => {
  assert.match(workspaceHtml, /id="workspace" class="workspace tree-collapsed workspace-hydrating"/);
  assert.match(workspaceHtml, /id="tree-pane-toggle"[^>]*aria-expanded="false"[^>]*aria-pressed="false"/);
  assert.match(workspaceHtml, /id="tree-pane" class="pane tree-pane tree-collapsed"/);
  assert.match(workspaceHtml, /class="workspace-toolbar"/);
  assert.match(workspaceHtml, /class="workspace-columns"/);
  assert.match(workspaceHtml, /id="left-mode-files"/);
  assert.match(workspaceHtml, /id="left-mode-git"/);
  assert.match(workspaceHtml, /id="full-text-search"/);
  assert.match(workspaceScript, /elements\.leftModeFiles\.addEventListener\("click", \(\) => void refreshProjectFiles\(\{ open: false \}\)\)/);
  assert.match(workspaceScript, /elements\.leftModeGit\.addEventListener\("click", \(\) => void ensureLeftPane\("git", \{ open: false \}\)\)/);
  assert.match(workspaceScript, /elements\.fullTextSearch\.addEventListener\("click", \(\) => void ensureLeftPane\("search", \{ open: false \}\)\)/);
  assert.match(workspaceScript, /async function refreshProjectFiles\(\{ open = true \} = \{\}\) \{[\s\S]*await ensureLeftPane\("files", \{ open \}\);[\s\S]*await loadProjectRoot\(\);[\s\S]*\}/);
  assert.match(workspaceScript, /async function ensureLeftPane\(mode = state\.leftMode, \{ open = true \} = \{\}\)[\s\S]*treeCollapsed: open \? false : state\.workspace\.treeCollapsed/);
  assert.doesNotMatch(workspaceHtml, /id="editor-pane-toggle"/);
  assert.doesNotMatch(workspaceScript, /toggleEditorPane|editorToggle|editorCollapsed|editor-collapsed/);
  assert.match(workspaceCss, /--tree-width:\s*257px/);
  assert.match(workspaceCss, /\.workspace\s*\{[^}]*display:\s*block/s);
  assert.match(workspaceCss, /\.workspace-toolbar\s*\{[^}]*position:\s*absolute[^}]*top:\s*0[^}]*left:\s*0[^}]*width:\s*var\(--tree-width\)/s);
  assert.match(workspaceCss, /\.workspace-columns\s*\{[^}]*grid-template-columns:\s*var\(--tree-width\) 9px minmax\(0, 1fr\)/s);
  assert.match(workspaceCss, /\.workspace-columns\s*\{[^}]*height:\s*100%/s);
  assert.match(workspaceCss, /\.tree-pane\s*\{[^}]*padding-top:\s*38px/s);
  assert.match(workspaceCss, /\.workspace\.tree-collapsed \.workspace-columns\s*\{\s*grid-template-columns:\s*38px 0 minmax\(0, 1fr\)/);
  assert.doesNotMatch(workspaceCss, /\.workspace\.tree-collapsed\s*\{[^}]*grid-template-rows:/s);
  assert.match(workspaceCss, /\.pane-splitter\s*\{[^}]*cursor:\s*col-resize/s);
  assert.match(workspaceCss, /\.pane-splitter\s*\{[^}]*touch-action:\s*none/s);
  assert.match(workspaceHtml, /id="pane-splitter"[\s\S]*role="separator"[\s\S]*aria-orientation="vertical"/);
  assert.match(workspaceScript, /const startX = event\.clientX/);
  assert.match(workspaceScript, /const startWidth = elements\.treePane\.getBoundingClientRect\(\)\.width/);
  assert.match(workspaceScript, /function paneSizeBounds\b/);
  assert.match(workspaceScript, /function handlePaneSplitterKeydown\b/);
  assert.match(workspaceScript, /event\.key === "ArrowLeft"/);
  assert.match(workspaceScript, /event\.key === "ArrowRight"/);
  assert.match(workspaceScript, /event\.key === "Home"/);
  assert.match(workspaceScript, /event\.key === "End"/);
  assert.match(workspaceScript, /aria-valuenow/);
  assert.match(workspaceScript, /--tree-width/);
  assert.match(workspaceScript, /function ensureLeftPane\b/);
  assert.match(workspaceScript, /function renderLeftMode\b/);
});

test("collapsed Files pane previews from the whole sidebar strip while click remains the persistent toggle", () => {
  assert.match(workspaceHtml, /id="tree-pane-toggle"[^>]*aria-label="Toggle project panel"[\s\S]*?<rect x="3\.5" y="4" width="17" height="16" rx="2\.25"\/>/);
  assert.match(workspaceHtml, /<script src="file-workspace-pane-hover\.js"><\/script>/);
  assert.match(workspaceScript, /LocalSystemWorkspacePaneHover\?\.createPaneHoverController/);
  assert.match(paneHoverScript, /const OPEN_DELAY_MS = 150/);
  assert.match(paneHoverScript, /const CLOSE_DELAY_MS = 110/);
  assert.match(paneHoverScript, /return isHydrated\(\) && !isMobileStandalone\(\) && isCollapsed\(\)/);
  assert.match(workspaceScript, /elements\.treeToggle\.addEventListener\("click", toggleTreePane\)/);
  assert.match(workspaceScript, /state\.workspace = await persistWorkspace\(\{[\s\S]*treeCollapsed: !state\.workspace\.treeCollapsed/);
  assert.match(paneHoverScript, /function createPaneHoverController\b/);
  assert.match(paneHoverScript, /const hoverSurfaces = \[elements\.workspaceToolbar, elements\.treePane\]/);
  assert.match(paneHoverScript, /surface\.addEventListener\("pointerenter"/);
  assert.match(paneHoverScript, /document\.addEventListener\("pointerover"/);
  assert.match(workspaceScript, /paneHover\.bind\(\)/);
});

test("workspace hydrates collapsed first and restores the saved pane only after host reveal", () => {
  assert.match(workspaceScript, /hydrated:\s*false/);
  assert.match(workspaceScript, /const treeCollapsed = !state\.hydrated \|\| state\.workspace\.treeCollapsed === true/);
  assert.match(workspaceScript, /function revealHydratedWorkspace\b/);
  assert.match(workspaceScript, /state\.hydrated = true[\s\S]*classList\.remove\("workspace-hydrating"\)[\s\S]*applyPaneLayout\(\)/);
  assert.match(workspaceScript, /event\.data\.action === "reveal-workspace"[\s\S]*revealHydratedWorkspace\(\)/);
  assert.match(workspaceScript, /action: "ready",\s*currentWorkspace: state\.currentWorkspace/s);
  assert.match(workspaceCss, /\.workspace\.workspace-restoring-open \.workspace-columns\s*\{[^}]*transition:grid-template-columns 150ms/s);
});

test("workspace uses event-driven live filesystem sync and keeps Git-only events out of tree refresh", () => {
  assert.match(workspaceHtml, /<script src="file-workspace-live-sync\.js"><\/script>/);
  assert.match(liveSyncScript, /function createWorkspaceLiveSync\b/);
  assert.match(workspaceScript, /workspaceRequest\("watch", \{ since \}, \{ signal, timeoutMs: 30_000 \}\)/);
  assert.match(workspaceScript, /event\.gitOnly !== true && event\.kind === "rename"/);
  assert.match(workspaceScript, /state\.fileEdit\?\.dirty/);
  assert.match(workspaceScript, /syncLiveWatchState\(\{ reset: true \}\)/);
});

test("workspace auto save is a persisted debounced editor preference that reuses the guarded save path", () => {
  assert.match(workspaceHtml, /id="auto-save-setting"[^>]*data-editor-setting="autoSave"/);
  assert.match(workspaceScript, /const AUTO_SAVE_DELAY_MS = 700/);
  assert.match(workspaceScript, /EDITOR_PREFERENCES_STORAGE_KEY = "localSystemEditorPreferencesV1"/);
  assert.match(workspaceScript, /autoSave:\s*false/);
  assert.match(workspaceScript, /function scheduleAutoSave\b/);
  assert.match(workspaceScript, /function renderFileEditSaveChrome\b/);
  assert.match(workspaceScript, /manualControlsVisible = dirty && state\.editorPreferences\.autoSave !== true/);
  assert.match(workspaceScript, /function setRoutineFileSaveStatus\b/);
  assert.match(workspaceScript, /saveFileEdit\(\{ mode: "auto" \}\)/);
  assert.match(workspaceScript, /state\.fileSave\.inFlight/);
  assert.match(workspaceScript, /let saveSucceeded = false/);
  assert.match(workspaceScript, /if \(saveSucceeded && state\.fileEdit\?\.dirty\)/);
  assert.match(workspaceScript, /expectedLastModified: edit\.descriptor\.lastModified/);
  assert.match(workspaceScript, /expectedBytes: edit\.descriptor\.bytes/);
  assert.match(workspaceScript, /fileDescriptorStillMatches\(activePath, cached\.descriptor\)/);
  assert.match(workspaceScript, /current\?\.lastModified/);
});

test("workspace settings expose a persisted completion-sound toggle that defaults on", () => {
  assert.match(workspaceHtml, /id="completion-sound-setting"[^>]*data-completion-setting="sound"/);
  assert.match(workspaceHtml, />Completion sound</);
  assert.match(workspaceScript, /COMPLETION_SOUND_ENABLED_STORAGE_KEY = "localSystemCompletionSoundEnabledV1"/);
  assert.match(workspaceScript, /completionSoundEnabled:\s*true/);
  assert.match(workspaceScript, /stored\?\.\[COMPLETION_SOUND_ENABLED_STORAGE_KEY\] !== false/);
  assert.match(workspaceScript, /chrome\.storage\.local\.set\(\{[\s\S]*\[COMPLETION_SOUND_ENABLED_STORAGE_KEY\]: state\.completionSoundEnabled/);
  assert.match(workspaceScript, /data-completion-setting/);
});

test("workspace settings control checkpoint injection and interval through the Local System server", () => {
  assert.match(workspaceHtml, /id="checkpoint-injection-setting"[^>]*data-checkpoint-setting="enabled"/);
  assert.match(workspaceHtml, />Inject checkpoint message</);
  assert.match(workspaceHtml, /id="checkpoint-minutes-setting"[^>]*type="number"[^>]*min="1"[^>]*max="240"/);
  assert.match(workspaceScript, /bridgeRequest\("\/local-ui\/turn-checkpoint", \{ action: "get" \}/);
  assert.match(workspaceScript, /action: "update"/);
  assert.match(workspaceScript, /intervalMinutes: state\.turnCheckpoint\.intervalMinutes/);
  assert.match(workspaceScript, /checkpointMinutesSetting\.disabled = state\.turnCheckpoint\.enabled === false/);
});

test("workspace explicitly restores keyboard ownership and gives media standard playback plus accelerated seeking", () => {
  assert.match(workspaceHtml, /id="viewer" class="viewer" tabindex="-1"/);
  assert.match(workspaceScript, /event\.data\.action === "restore-focus"\) restoreWorkspaceFocus\(\)/);
  assert.match(workspaceScript, /\{ restoreFocus: event\.data\.restoreFocus === true \}/);
  assert.match(workspaceScript, /function restoreWorkspaceFocus\b/);
  assert.match(workspaceScript, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(workspaceScript, /function handleMediaSpaceShortcut\b/);
  assert.match(workspaceScript, /event\.key !== " " && event\.code !== "Space"/);
  assert.match(workspaceScript, /media\.paused \|\| media\.ended/);
  assert.match(workspaceScript, /media\.play\(\)/);
  assert.match(workspaceScript, /media\.pause\(\)/);
  assert.match(workspaceScript, /function handleMediaSeekShortcut\b/);
  assert.match(workspaceScript, /event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"/);
  assert.match(workspaceScript, /if \(!event\.repeat \|\| state\.mediaSeek\.direction !== direction\)/);
  assert.match(workspaceScript, /\(now - state\.mediaSeek\.lastAppliedAt\) < 200/);
  assert.match(workspaceScript, /heldFor >= 5000[\s\S]*\? 5[\s\S]*heldFor >= 1000[\s\S]*\? 1[\s\S]*: 0\.35/);
  assert.match(workspaceScript, /media\.currentTime = nextTime/);
  assert.match(workspaceScript, /keyboardTargetOwnsMediaShortcut/);
  assert.match(workspaceCss, /\.viewer:focus\s*\{\s*outline:none;\s*\}/);
});

test("hover preview overlays the editor with lightweight enter and exit motion", () => {
  assert.match(workspaceCss, /\.workspace-columns\s*\{[^}]*position:relative/s);
  assert.match(workspaceCss, /\.tree-pane\s*\{[^}]*grid-column:1/s);
  assert.match(workspaceCss, /\.pane-splitter\s*\{[^}]*grid-column:2/s);
  assert.match(workspaceCss, /\.editor-pane\s*\{[^}]*grid-column:3/s);
  assert.match(workspaceCss, /\.workspace\.tree-collapsed\.tree-hover-preview \.tree-pane,[\s\S]*?position:absolute[\s\S]*?width:var\(--tree-width\)[\s\S]*?grid-template-rows:minmax\(0,1fr\) 34px[\s\S]*?animation:tree-hover-panel-in 140ms/s);
  assert.match(workspaceCss, /\.workspace\.tree-collapsed\.tree-hover-preview-closing \.tree-pane,[\s\S]*?animation:tree-hover-panel-out 120ms/s);
  assert.match(workspaceCss, /@keyframes tree-hover-panel-in[\s\S]*translateX\(-5px\)[\s\S]*translateX\(0\)/);
  assert.match(workspaceCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:none/);
  assert.doesNotMatch(workspaceScript, /pointerenter[^\n]*elements\.workspace/);
});

test("file actions live in the editor header to the right of the tabs", () => {
  assert.match(workspaceHtml, /class="editor-pane-header"[\s\S]*?id="tabs"[\s\S]*?id="file-action-bar"[\s\S]*?<\/div>\s*<div id="editor-body"/);
  assert.doesNotMatch(workspaceHtml, /id="editor-body"[\s\S]*?id="file-action-bar"/);
  assert.match(workspaceCss, /\.editor-pane-header\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/s);
  assert.match(workspaceCss, /\.file-action-bar\s*\{[^}]*justify-content:flex-end[^}]*background:transparent/s);
});

test("project edit and bottom settings controls stay separate while the editor remains vertically full-height", () => {
  assert.match(workspaceHtml, /id="project-name"[\s\S]*id="project-edit"/);
  assert.match(workspaceHtml, /class="left-panel-toolbar"[\s\S]*id="ui-settings-toggle"[^>]*aria-haspopup="dialog"/);
  assert.match(workspaceHtml, /id="ui-settings-popover"[^>]*role="dialog"[^>]*aria-label="Local System settings"[^>]*hidden/);
  assert.doesNotMatch(workspaceHtml, /workspace-toolbar-spacer/);
  assert.doesNotMatch(workspaceHtml, /workspace-menu-popover|workspace-menu-toggle/);
  assert.match(workspaceScript, /elements\.projectEdit\.addEventListener\("click", requestProjectPicker\)/);
  assert.match(workspaceScript, /elements\.projectName\.addEventListener\("click", requestProjectPicker\)/);
  assert.match(workspaceScript, /elements\.uiSettingsToggle\.addEventListener\("click"[\s\S]*setUiSettingsOpen\(elements\.uiSettingsPopover\.hidden\)/);
  assert.match(workspaceCss, /\.workspace-settings-popover\s*\{[^}]*bottom:\s*40px[^}]*width:\s*min\(286px, calc\(100% - 12px\)\)/s);
  assert.match(workspaceCss, /\.left-settings-button\s*\{\s*margin-left:\s*auto;/);
});

test("workspace chrome is borderless except for the Files/editor pane separator", () => {
  assert.doesNotMatch(workspaceCss, /\.workspace-toolbar\s*\{[^}]*border-bottom:/s);
  assert.doesNotMatch(workspaceCss, /\.project-pane-header\s*\{[^}]*border-bottom:/s);
  assert.doesNotMatch(workspaceCss, /\.left-panel-header\s*\{[^}]*border-bottom:/s);
  assert.doesNotMatch(workspaceCss, /\.left-panel-toolbar\s*\{[^}]*border-top:/s);
  assert.doesNotMatch(workspaceCss, /\.editor-pane-header\s*\{[^}]*border-bottom:/s);
  assert.doesNotMatch(workspaceCss, /\.line-numbers\s*\{[^}]*border-right:/s);
  assert.doesNotMatch(workspaceCss, /\.edit-line-numbers\s*\{[^}]*border-right:/s);
  assert.doesNotMatch(workspaceCss, /\.diff-line-number\s*\{[^}]*border-right:/s);
  assert.doesNotMatch(workspaceCss, /\.file-loading-skeleton__gutter\s*\{[^}]*border-right:/s);
  assert.match(workspaceCss, /\.pane-splitter::before\s*\{[^}]*width:\s*1px[^}]*background:\s*var\(--line\)/s);
  assert.match(workspaceCss, /\.workspace\.tree-collapsed \.pane-splitter\s*\{[^}]*visibility:hidden[^}]*pointer-events:none/s);
});

test("Files list fills the pane and the bottom toolbar does not reserve duplicate space", () => {
  assert.match(workspaceCss, /\.tree-pane\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 34px/s);
  assert.match(workspaceCss, /\.tree-body\s*\{[^}]*height:\s*auto[^}]*padding:\s*5px 0 4px/s);
  assert.doesNotMatch(workspaceCss, /\.tree-body\s*\{[^}]*height:\s*calc\(100% - 34px\)/s);
  assert.match(workspaceCss, /\.project-tree\s*\{[^}]*width:max-content[^}]*min-width:100%/s);
  assert.match(workspaceCss, /\.left-panel-toolbar\s*\{[^}]*padding:\s*3px 6px/s);
});

test("workspace action and navigation icons use the shared icon size", () => {
  assert.match(workspaceCss, /\.toolbar-button svg,[\s\S]*?\.left-tool-button svg\s*\{[^}]*width:\s*var\(--ls-ui-icon-size\)[^}]*height:\s*var\(--ls-ui-icon-size\)/s);
  assert.match(workspaceCss, /\.tree-row__icon\s*\{[^}]*width:var\(--ls-ui-icon-size\)[^}]*height:var\(--ls-ui-icon-size\)/s);
  assert.match(workspaceCss, /\.files-search-icon\s*\{[^}]*width:var\(--ls-ui-icon-size\)[^}]*height:var\(--ls-ui-icon-size\)/s);
  assert.match(workspaceHtml, /id="workspace-search-input" class="ls-ui-search-field"/);
});

test("standalone mobile drawer behavior is explicit host state, not inferred from a narrow desktop iframe", () => {
  assert.match(workspaceScript, /let mobileStandalone = pageParams\.get\("mobile"\) === "1"/);
  assert.match(workspaceScript, /document\.documentElement\.dataset\.mobileStandalone/);
  assert.match(workspaceScript, /return PRESENTATION === "standalone" && mobileStandalone/);
  assert.doesNotMatch(workspaceScript, /MOBILE_STANDALONE_MEDIA/);
  assert.match(workspaceCss, /html\[data-presentation="standalone"\]\[data-mobile-standalone="true"\] \.tree-pane/);
  assert.match(workspaceCss, /html\[data-host="sidepanel"\] \.resize-handle/);
});

test("workspace traps horizontal trackpad scrolling inside file surfaces", () => {
  assert.match(workspaceCss, /html,body\s*\{[^}]*overscroll-behavior-x:none/s);
  assert.match(workspaceCss, /\.file-editor\s*\{[^}]*overscroll-behavior:contain/s);
  assert.match(workspaceCss, /\.diff-viewer\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(workspaceScript, /function installHorizontalScrollTrap\b/);
  assert.match(workspaceScript, /installHorizontalScrollTrap\(elements\.scroll\)/);
  assert.match(workspaceScript, /installHorizontalScrollTrap\(elements\.fileEditor\)/);
  assert.match(workspaceScript, /installHorizontalScrollTrap\(elements\.diffViewer\)/);
  assert.match(workspaceScript, /event\.preventDefault\(\)/);
  assert.match(workspaceScript, /element\.scrollLeft = Math\.max\(0, Math\.min\(maxScrollLeft, element\.scrollLeft \+ deltaX\)\)/);
});

test("Git Changes opens a read-only standard red-green diff while normal files keep gutter ranges", () => {
  assert.match(workspaceHtml, /id="diff-viewer"/);
  assert.match(workspaceScript, /action:\s*"file_diff"/);
  assert.match(workspaceScript, /function openGitDiff\b/);
  assert.match(workspaceScript, /function renderGitDiff\b/);
  assert.match(workspaceScript, /const displayPath = workspaceRelativeGitPath\(file\);[\s\S]*const displayName = basename\(displayPath\) \|\| displayPath;[\s\S]*row\.title = displayPath;[\s\S]*name\.textContent = displayName;[\s\S]*name\.title = displayPath;/);
  assert.match(workspaceCss, /#left-git-panel\s*\{[^}]*display:grid;[^}]*grid-template-rows:34px minmax\(0,1fr\)/s);
  assert.match(workspaceCss, /\.git-changes-section\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
  assert.match(workspaceCss, /data-mobile-standalone="true"\] #left-git-panel\s*\{[^}]*grid-template-rows:\s*42px minmax\(0, 1fr\)/s);
  assert.match(workspaceScript, /tabs\.push\(\{ path: state\.diff\.path, kind: "diff" \}\)/);
  assert.match(workspaceScript, /closeTab\(path, kind\)/);
  assert.match(workspaceScript, /activateTab\(path, kind\)/);
  assert.match(workspaceScript, /row\.classList\.add\("added"\)/);
  assert.match(workspaceScript, /row\.classList\.add\("deleted"\)/);
  assert.match(workspaceScript, /function renderGitGutterMarkers\b/);
  assert.match(workspaceScript, /git-gutter-marker \$\{type\}/);
  assert.match(workspaceCss, /\.diff-line\.added/);
  assert.match(workspaceCss, /\.diff-line\.deleted/);
  assert.match(workspaceCss, /\.git-gutter-marker\.added/);
  assert.match(workspaceCss, /\.git-gutter-marker\.deleted/);
  assert.doesNotMatch(workspaceScript, /animateGutterNext|animate-in/);
  assert.doesNotMatch(workspaceCss, /git-gutter-marker-enter|git-gutter-marker\.animate-in/);
  assert.match(workspaceCss, /\.git-gutter-marker\.added\s*\{\s*background:var\(--ls-ui-git-added\)/);
  assert.match(workspaceCss, /\.git-gutter-marker\.modified\s*\{\s*background:var\(--ls-ui-git-modified\)/);
});

test("unchanged Git status refreshes preserve Changes row DOM identity", () => {
  assert.match(workspaceScript, /renderKey:\s*""/);
  assert.match(workspaceScript, /function gitStatusRenderKey\b/);
  assert.match(workspaceScript, /const shouldRender = renderKey !== state\.git\.renderKey/);
  assert.match(workspaceScript, /if \(shouldRender\) renderGitChanges\(\)/);
});

test("workspace annotation controls use semantic light-dark tokens", () => {
  assert.match(workspaceCss, /\.annotation-marker\s*\{[^}]*background:var\(--ls-ui-primary-bg\)[^}]*color:var\(--ls-ui-primary-text\)/s);
  assert.match(workspaceCss, /\.annotate-selection\s*\{[^}]*background:var\(--ls-ui-control-bg\)[^}]*color:var\(--ls-ui-control-text\)/s);
  assert.match(workspaceCss, /\.annotation-save\s*\{[^}]*background:var\(--ls-ui-primary-bg\)[^}]*color:var\(--ls-ui-primary-text\)/s);
  assert.match(workspaceCss, /\.annotation-delete\s*\{[^}]*color:var\(--ls-ui-danger\)/s);
});

test("workspace annotation editor matches ChatGPT annotation corner geometry", () => {
  assert.match(workspaceCss, /\.annotate-selection\s*\{[^}]*height:32px[^}]*padding:0 12px[^}]*border-radius:var\(--ls-ui-radius-button,14px\)/s);
  assert.match(workspaceCss, /\.annotation-editor\s*\{[^}]*border-radius:var\(--ls-ui-radius-annotation,24px\)/s);
  assert.match(workspaceCss, /\.annotation-editor\.editing\s*\{[^}]*border-radius:var\(--ls-ui-radius-annotation-editing,22px\)/s);
  assert.match(workspaceCss, /\.annotation-tooltip\s*\{[^}]*border-radius:var\(--ls-ui-radius-annotation-tooltip,14px\)/s);
});

test("workspace annotation editor uses the shared 20 percent narrower width", () => {
  assert.match(workspaceCss, /\.annotation-editor\s*\{[^}]*width:min\(var\(--ls-ui-annotation-editor-width,336px\),calc\(100vw - 18px\)\)/s);
});

test("video annotations are manual-on-pause, reaction-time corrected, and stored separately from text annotations", () => {
  assert.match(workspaceScript, /video\.addEventListener\("pause", updatePauseCandidate\)/);
  assert.match(workspaceScript, /currentTime\) \|\| 0\) - 0\.25/);
  assert.match(workspaceScript, /annotate\.textContent = `Annotate · \$\{formatMediaTimestamp\(candidateTime\)\}`/);
  assert.match(workspaceScript, /annotate\.className = "annotate-selection media-annotate-button/);
  assert.match(workspaceScript, /composer\.className = "annotation-editor media-note-composer/);
  assert.match(workspaceScript, /event\.key === "Enter" && !event\.shiftKey && !event\.isComposing/);
  assert.match(workspaceScript, /workspaceRequest\("upsert_media_note"/);
  assert.match(workspaceScript, /workspaceRequest\("delete_media_note"/);
  assert.match(workspaceScript, /summary\.textContent = `Notes · \$\{items\.length\}`/);
  assert.match(workspaceScript, /notes\.hidden = items\.length === 0/);
  assert.match(workspaceServer, /mediaNotes:\s*\[\]/);
  assert.match(workspaceServer, /action === "upsert_media_note"/);
  assert.match(workspaceServer, /action === "delete_media_note"/);
  assert.match(workspaceServer, /media notes require a video file/);
  assert.match(workspaceCss, /\.media-video-shell\s*\{[^}]*align-self:center/s);
  assert.match(workspaceCss, /\.media-video-shell\.has-media-notes\s*\{[^}]*align-self:start/s);
  assert.match(workspaceCss, /\.media-annotate-button\s*\{/);
  assert.match(workspaceCss, /\.media-note-composer\.annotation-editor\s*\{/);
  assert.match(workspaceCss, /\.media-notes\s*\{/);
});
