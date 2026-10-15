import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contentScript = readFileSync(
  new URL("../../extensions/local-system/content.js", import.meta.url),
  "utf8",
);
const viewerScript = readFileSync(
  new URL("../../extensions/local-system/viewer.js", import.meta.url),
  "utf8",
);
const workspaceScript = readFileSync(
  new URL("../../extensions/local-system/file-workspace.js", import.meta.url),
  "utf8",
);
const extensionApiScript = readFileSync(
  new URL("../../extensions/local-system/extension-api.js", import.meta.url),
  "utf8",
);
const backgroundScript = readFileSync(
  new URL("../../extensions/local-system/background.js", import.meta.url),
  "utf8",
);
const annotationsScript = readFileSync(
  new URL("../../extensions/local-system/annotations-content.js", import.meta.url),
  "utf8",
);
const composerContextScript = readFileSync(
  new URL("../../extensions/local-system/composer-context.js", import.meta.url),
  "utf8",
);
const viewerCss = readFileSync(
  new URL("../../extensions/local-system/viewer.css", import.meta.url),
  "utf8",
);

function filePathRegex() {
  const end = contentScript.indexOf("const DIRECTORY_PATH_RE");
  assert.ok(end > 0, "expected file-path regex declarations near the top of content.js");
  const declarations = contentScript.slice(0, end);
  return new Function(`${declarations}\nreturn FILE_PATH_RE;`)();
}

test("inline file detection covers code, markdown, PDF, images, and common extensionless project files", () => {
  const pattern = filePathRegex();
  const matches = (value) => {
    pattern.lastIndex = 0;
    return [...value.matchAll(pattern)].map((match) => match[0]);
  };

  assert.deepEqual(matches("src/components/App.tsx"), ["src/components/App.tsx"]);
  assert.deepEqual(matches("/Users/me/My Project/tools/build.py"), ["/Users/me/My Project/tools/build.py"]);
  assert.deepEqual(matches("README.md"), ["README.md"]);
  assert.deepEqual(matches("docs/spec.pdf"), ["docs/spec.pdf"]);
  assert.deepEqual(matches("assets/preview.webp"), ["assets/preview.webp"]);
  assert.deepEqual(matches("exports/report.docx"), ["exports/report.docx"]);
  assert.deepEqual(matches("Dockerfile"), ["Dockerfile"]);
  assert.deepEqual(matches(".env.local"), [".env.local"]);
});

test("images, videos and PDFs receive inline previews, without code and markdown previews", () => {
  assert.match(contentScript, /if \(\/\\\.\(\?:png\|jpe\?g\|gif\|webp\|avif\|svg\)\$\/\.test\(lower\)\) return "image"/);
  assert.match(contentScript, /return "video"/);
  assert.match(contentScript, /return "pdf"/);
  assert.doesNotMatch(contentScript, /return "markdown"/);
  assert.match(contentScript, /if \(!previewKind \|\| previous\.has\(reference\.path\)\) continue/);
  assert.doesNotMatch(viewerScript, /mimeType === "text\/markdown"/);
  assert.match(viewerScript, /async function renderPdf\b/);
  assert.doesNotMatch(viewerScript, /function renderCode\b/);
  assert.match(viewerCss, /\.pdf-preview\s*\{/);
});

test("rendered file paths prefer the native workspace and retain the embedded fallback", () => {
  assert.match(contentScript, /function wrapLocalFilePaths\b/);
  assert.match(contentScript, /link\.className = "local-system-inline-file-path"/);
  assert.match(contentScript, /link\.dataset\.resolveState === "ready" && link\.dataset\.resolvedPath/);
  assert.match(contentScript, /\? \{ path: link\.dataset\.resolvedPath \}/);
  assert.match(contentScript, /primeInlineFileLink\(link, reference\.path/);
  assert.match(contentScript, /const nativePanelRequest = requestNativeSidePanel\(\)/);
  assert.match(contentScript, /openFileFromChatGpt\(descriptor\.path, null, null, null, \{ nativePanelRequest, source: "inline-file" \}\)/);
  assert.match(contentScript, /function requestNativeSidePanel\b/);
  assert.match(contentScript, /action:\s*"open_file"/);
  assert.match(contentScript, /action:\s*"open-side-panel"/);
  assert.match(contentScript, /action:\s*"workspace-state-changed"/);
  assert.match(contentScript, /catch \(error\) \{[\s\S]*openFileInWorkspace\(path, line, column, length\)/s);
  assert.match(contentScript, /switchWorkspaceForResolvedFile\(descriptor\.path\)/);
  assert.match(viewerScript, /action: "open", path/);
  assert.match(workspaceScript, /bridgeRequest\("\/local-ui\/files\/resolve"/);
  assert.match(workspaceScript, /if \(!isAbsoluteFilePath\(normalized\)\)/);
  const panelRequestIndex = contentScript.indexOf("const nativePanelRequest = requestNativeSidePanel();");
  const projectSwitchIndex = contentScript.indexOf("await switchWorkspaceForResolvedFile(descriptor.path);", panelRequestIndex);
  assert.ok(panelRequestIndex >= 0 && projectSwitchIndex > panelRequestIndex, "native panel opening must begin before awaited project routing");
});

test("video file references preview inline and stream in the workspace without full blob downloads", () => {
  assert.match(contentScript, /function previewKindForPath\b[\s\S]*?return "video"/);
  assert.match(viewerScript, /if \(previewKind === "video"\) \{[\s\S]*?renderVideo\(descriptor\)/);
  assert.match(viewerScript, /video\.src = descriptor\.url/);
  assert.match(viewerScript, /video\.controls = mode === "modal"/);
  assert.match(workspaceScript, /if \(kind === "video" \|\| kind === "audio"\)/);
  assert.match(workspaceScript, /objectUrl: descriptor\.url/);
});

test("native workspace file drags attach real local files to the ChatGPT composer", () => {
  assert.match(contentScript, /const LOCAL_FILE_DRAG_MIME = "application\/x-local-system-file"/);
  assert.match(contentScript, /installLocalFileDropTarget\(\)/);
  assert.match(contentScript, /document\.addEventListener\("drop", handleLocalFileDrop, true\)/);
  assert.match(contentScript, /event\.dataTransfer\?\.getData\(LOCAL_FILE_DRAG_MIME\)/);
  assert.match(contentScript, /const descriptor = await requestDraggedLocalFile\(payload\)/);
  assert.match(contentScript, /const file = new File\(\[descriptor\.buffer\]/);
  assert.match(contentScript, /attachFilesToComposer\(\[file\], findComposerEditor\(\)\)/);
  assert.match(contentScript, /form\[data-local-system-file-drop-state="ready"\]/);
  assert.match(annotationsScript, /globalThis\.LocalSystemFileRequest = bridgeFileRequest/);
  assert.match(annotationsScript, /bridgeRequest\("\/local-ui\/files\/resolve", body\)/);
  assert.match(annotationsScript, /const response = await fetch\(url/);
  assert.match(annotationsScript, /const buffer = await response\.arrayBuffer\(\)/);
  assert.match(extensionApiScript, /source:\s*SOURCE,[\s\S]*action:\s*"request"/);
  assert.match(backgroundScript, /"\/local-ui\/files\/resolve"/);
});

test("inline file links resolve lazily through the scoped resolver without cross-project search fallback", () => {
  assert.match(contentScript, /scheduleInlineFileLinkResolution\(link, reference\.path\)/);
  assert.match(contentScript, /const inlineFileLinkVisibilityObserver = typeof IntersectionObserver/);
  assert.match(contentScript, /inlineFileLinkVisibilityObserver\.observe\(link\)/);
  assert.doesNotMatch(contentScript, /fragment\.append\(link\);\s*void primeInlineFileLink\(link, reference\.path\)/);
  assert.match(contentScript, /async function resolveInlineFileReference\b/);
  assert.match(contentScript, /"\/local-ui\/files\/resolve"/);
  assert.doesNotMatch(contentScript, /"\/local-ui\/files\/search"/);
  assert.doesNotMatch(contentScript, /relative file path is ambiguous across/);
  assert.match(contentScript, /if \(!descriptor\?\.path\) throw new Error\("local file could not be resolved"\)/);
  assert.match(backgroundScript, /"\/local-ui\/files\/resolve"/);
  assert.match(backgroundScript, /"\/local-ui\/files\/search"/);
  assert.match(contentScript, /const api = globalThis\.LocalSystemExtensionApi/);
  assert.match(contentScript, /return api\.request\(path, body, \{ timeoutMs: 8_000 \}\)/);
  assert.doesNotMatch(contentScript, /typeof globalThis\.LocalSystemApiRequest/);
});

test("inline file resolution evicts rejected promises so transient Local System failures can recover", () => {
  assert.match(contentScript, /inlineFileResolutionCache\.set\(key, promise\)/);
  assert.match(contentScript, /if \(inlineFileResolutionCache\.get\(key\) === promise\) inlineFileResolutionCache\.delete\(key\)/);
  assert.doesNotMatch(contentScript, /if \(retry\) inlineFileResolutionCache\.delete\(key\)/);
});

test("inline file links use a blue hover underline and reveal preview errors only on hover or focus", () => {
  assert.match(contentScript, /text-decoration-color:\s*var\(--ls-ui-info\)/);
  assert.match(contentScript, /\.local-system-inline-file-path\[data-preview-error="true"\]:hover::after/);
  assert.match(contentScript, /\.local-system-inline-file-path\[data-preview-error="true"\]:focus-visible::after/);
  assert.match(contentScript, /function markInlineFilePathError\b/);
  assert.match(contentScript, /Local file could not be resolved/);
  assert.match(contentScript, /card\.remove\(\)/, "failed preview cards should disappear instead of leaving a permanent warning badge");
});

test("resolved inline file links collapse to a minimal theme-adaptive amber filename while unresolved links keep the original path", () => {
  assert.match(contentScript, /link\.dataset\.originalText = original\.slice\(reference\.start, reference\.end\)/);
  assert.match(contentScript, /link\.textContent = localFileName\(descriptor\.path\)/);
  assert.match(contentScript, /link\.textContent = link\.dataset\.originalText \|\| path/);
  assert.match(contentScript, /function localFileName\b/);
  assert.match(contentScript, /--ls-inline-file-accent:\s*color-mix\(in srgb, var\(--ls-ui-warning\) 84%, currentColor\)/);
  assert.match(contentScript, /\.local-system-inline-file-path\[data-resolve-state="ready"\]\s*\{[^}]*color:\s*var\(--ls-inline-file-accent\);[^}]*text-decoration:\s*none;/s);
  assert.match(contentScript, /\.local-system-inline-file-path\[data-resolve-state="ready"\]:hover,[\s\S]*text-decoration:\s*underline dotted var\(--ls-inline-file-accent\)/);
  assert.match(contentScript, /\.local-system-inline-file-path\[data-resolve-state="ready"\]:active[\s\S]*color:\s*var\(--ls-inline-file-accent\)/);
});

test("workspace context changes propagate to file links and the workspace iframe", () => {
  assert.match(composerContextScript, /previousWorkspace !== context\.currentWorkspace/);
  assert.match(composerContextScript, /source: "context-sync"/);
  assert.match(contentScript, /inlineFileResolutionCache\.clear\(\)/);
  assert.match(contentScript, /refreshInlineFileLinks\(\)/);
  assert.match(annotationsScript, /composerContext\.loadWorkspaceContext\(\)/);
});

test("inline file enhancement is scoped to conversation content and observes streamed text updates", () => {
  assert.match(contentScript, /function conversationContentRootFor\b/);
  assert.match(contentScript, /function isConversationMessageContent\b/);
  assert.match(contentScript, /if \(selectedMarkdown\?\.closest\("main"\)\) return selectedMarkdown/);
  assert.match(
    contentScript,
    /#prompt-textarea, form, \[data-local-system-composer-ui\], \.local-system-composer-rail/,
    "composer and Local System composer surfaces must be excluded from inline-file scanning",
  );
  assert.match(
    contentScript,
    /observer\.observe\(document\.documentElement, \{ childList: true, characterData: true, subtree: true \}\)/,
    "streaming characterData updates must be observed",
  );
  assert.match(contentScript, /mutation\.type === "characterData"/);
  assert.match(contentScript, /scheduleInlineFileScan\(mutation\.target\)/);
  assert.match(contentScript, /setTimeout\(flushInlineFileScans, 120\)/);
  assert.match(contentScript, /if \(!conversationContentRootFor\(node\)\) return/);
});

test("inline file scanning snapshots message text before wrapping links", () => {
  assert.match(contentScript, /const textNodes = \[\]/);
  assert.match(contentScript, /while \(\(node = walker\.nextNode\(\)\)\) textNodes\.push\(node\)/);
  assert.match(contentScript, /for \(const textNode of textNodes\)/);
  assert.match(contentScript, /if \(textNode\?\.isConnected\) scanTextNode\(textNode\)/);
  assert.doesNotMatch(
    contentScript,
    /while \(\(node = walker\.nextNode\(\)\)\) scanTextNode\(node\)/,
    "the TreeWalker must not be advanced while scanTextNode mutates the message DOM",
  );
});

test("the shared viewer resolves all previewable files through the scoped local-file endpoint", () => {
  assert.match(viewerScript, /\/local-ui\/files\/resolve/);
  assert.match(viewerScript, /globalThis\.LocalSystemExtensionApi/);
  assert.doesNotMatch(viewerScript, /x-local-system-extension/);
  assert.doesNotMatch(viewerScript, /\/local-image\/resolve/);
});

test("inline preview viewers receive live semantic theme colors from ChatGPT", () => {
  assert.match(viewerScript, /event\.data\?\.source !== "local-system-host"/);
  assert.match(viewerScript, /function applyTheme\b/);
  assert.match(viewerScript, /LocalSystemSharedRuntime\?\.applyTheme\(theme\)/);
  assert.match(contentScript, /function broadcastThemeToLocalFrames\b/);
  assert.match(contentScript, /for \(const frame of frames\.values\(\)\)/);
  assert.match(contentScript, /activeModal\?\.frame\?\.contentWindow\?\.postMessage/);
});
