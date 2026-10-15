/* global document */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "pdfjs-dist/build/pdf.worker.mjs";
import { getDocument } from "pdfjs-dist/build/pdf.mjs";
import { createLiteApp } from "./mcp-lite.js";
import { classifyUnifiedLines, splitUnifiedDiff } from "./apply-patch-parser.js";

for (const [name, grammar] of Object.entries({
  bash, cpp, css, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml,
})) hljs.registerLanguage(name, grammar);

const root = document.getElementById("root");
let payload = null;
let generation = 0;
let annotations = [];
let annotationsByFile = new Map();
let annotationFileKey = "";
let pendingQuote = "";
let selectedQuote = "";
let activeFileIndex = 0;
let selectedDiffFile = 0;

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function humanBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
}

function resourceContent(result) {
  return Array.isArray(result?.contents) ? result.contents[0] : null;
}

function toolContent(result) {
  if (result?.isError) {
    const message = toolErrorMessage(result, "Preview fallback tool failed");
    throw new Error(message);
  }
  for (const item of result?.content || []) {
    if (item?.type === "text") return { text: item.text || "", mimeType: "text/plain" };
    if (item?.type === "image" || item?.type === "audio") {
      return { blob: item.data || "", mimeType: item.mimeType || "application/octet-stream" };
    }
    if (item?.type === "resource" && item.resource) return item.resource;
  }
  return null;
}

function toolErrorMessage(result, fallback) {
  return (result?.content || []).map((item) => item?.text || "").filter(Boolean).join("\n") || fallback;
}

function isExpiredPreviewError(error) {
  const message = String(error?.message || error || "");
  return /unknown or expired|token expired|resource expired|preview resource is unknown|cloud preview url expired|preview session cannot be refreshed/i.test(message);
}

function friendlyPreviewError(error) {
  const message = String(error?.message || error || "");
  if (isExpiredPreviewError(error) || /internal server error.*fallback failed/i.test(message)) {
    return "This preview session expired and could not be renewed. Run display again.";
  }
  return message || "Preview is unavailable.";
}

async function refreshPreviewFile(file) {
  if (!file?.resumeToken) throw new Error("This preview session expired. Run display again.");
  const result = await app.callServerTool({
    name: "refresh_preview_file",
    arguments: { resumeToken: file.resumeToken },
  });
  if (result?.isError) throw new Error(toolErrorMessage(result, "Preview session could not be renewed"));
  const fresh = result?.structuredContent?.file;
  if (!fresh?.openToken) throw new Error("Preview session refresh returned no file session");
  replacePreviewFile(file, fresh);
  return fresh;
}

async function recoverExpiredPreview(file, expectedGeneration, error) {
  if (!file?.resumeToken || !isExpiredPreviewError(error)) return false;
  try {
    await refreshPreviewFile(file);
    if (expectedGeneration === generation) render();
  } catch (refreshError) {
    if (expectedGeneration === generation) {
      root.innerHTML = shell(file, `<section class="error"><strong>Could not load preview.</strong><p>${escapeHtml(friendlyPreviewError(refreshError))}</p></section>`);
    }
  }
  return true;
}

async function resolveCloudPreviewUrl(file) {
  if (!file?.cloud || !file.openToken) return "";
  const result = await app.callServerTool({
    name: "get_cloud_preview_url",
    arguments: { token: file.openToken },
  });
  if (result?.isError) {
    const message = (result.content || []).map((item) => item?.text || "").filter(Boolean).join("\n");
    throw new Error(message || "Cloud preview URL is unavailable");
  }
  const url = (result?.content || []).find((item) => item?.type === "text")?.text || "";
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Cloud preview URL must use HTTPS");
  return parsed.href;
}

async function loadPreviewContent(file) {
  let resourceError = null;
  if (file.resourceUri) {
    try {
      const result = await app.readServerResource({ uri: file.resourceUri });
      const content = resourceContent(result);
      if (content) return content;
      resourceError = new Error("Preview resource returned no content");
    } catch (error) {
      resourceError = error;
    }
  }

  if (!file.openToken) throw resourceError || new Error("Preview content is unavailable");
  try {
    const fallback = await app.callServerTool({ name: "load_preview_file", arguments: { token: file.openToken } });
    const content = toolContent(fallback);
    if (content) return content;
    throw new Error("Preview fallback returned no content");
  } catch (fallbackError) {
    if (!resourceError) throw fallbackError;
    throw new Error(`${resourceError.message}; fallback failed: ${fallbackError.message}`);
  }
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function dataUriFrom(content, fallbackMimeType) {
  if (!content?.blob) throw new Error("Preview bytes are missing");
  const mimeType = content.mimeType || fallbackMimeType || "application/octet-stream";
  return `data:${mimeType};base64,${content.blob}`;
}

async function renderPdfPages(source, expectedGeneration) {
  const target = root.querySelector("[data-pdf-pages]");
  if (!target) throw new Error("PDF preview container is missing");

  const loadingTask = getDocument(typeof source === "string" ? { url: source } : { data: source });
  const pdf = await loadingTask.promise;
  if (expectedGeneration !== generation) {
    await loadingTask.destroy();
    return;
  }

  const maxPages = Math.min(pdf.numPages, 20);
  target.innerHTML = "";

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    if (expectedGeneration !== generation) break;
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(280, Math.min(target.clientWidth || 760, 1000));
    const scale = Math.min(2, availableWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(globalThis.devicePixelRatio || 1, 2);

    const wrapper = document.createElement("section");
    wrapper.className = "pdf-page";
    wrapper.innerHTML = `<div class="pdf-page-label">Page ${pageNumber} of ${pdf.numPages}</div>`;

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    wrapper.appendChild(canvas);
    target.appendChild(wrapper);

    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    }).promise;
  }

  if (pdf.numPages > maxPages && expectedGeneration === generation) {
    const note = document.createElement("div");
    note.className = "pdf-more";
    note.textContent = `Showing the first ${maxPages} of ${pdf.numPages} pages.`;
    target.appendChild(note);
  }

  await loadingTask.destroy();
}

function renderInlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  text = text.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  return text;
}

function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let inFence = false;
  let fenceLanguage = "";
  let fenceLines = [];
  let listType = null;

  const closeList = () => {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = null;
  };

  const closeFence = () => {
    const code = fenceLines.join("\n");
    const language = normalizeHighlightLanguage(fenceLanguage);
    let highlighted;
    try {
      highlighted = language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language }).value
        : escapeHtml(code);
    } catch {
      highlighted = escapeHtml(code);
    }
    out.push(`<pre><code class="hljs">${highlighted}</code></pre>`);
    fenceLines = [];
    fenceLanguage = "";
    inFence = false;
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/);
    if (fence) {
      closeList();
      if (inFence) closeFence();
      else {
        inFence = true;
        fenceLanguage = fence[1] || "";
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        out.push(`<${listType}>`);
      }
      out.push(`<li>${renderInlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();

    if (!line.trim()) {
      out.push("<div class=\"md-gap\"></div>");
      continue;
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      out.push("<hr />");
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    out.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }
  closeList();
  if (inFence) closeFence();
  return out.join("\n");
}

function normalizeHighlightLanguage(value) {
  const language = String(value || "").toLowerCase();
  return ({
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", sh: "bash", shell: "bash", zsh: "bash",
    yml: "yaml", html: "xml", svg: "xml", xml: "xml",
    c: "cpp", cc: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp",
    md: "markdown",
  })[language] || language;
}

function highlightedCode(source, languageHint) {
  const language = normalizeHighlightLanguage(languageHint);
  try {
    if (language && hljs.getLanguage(language)) return hljs.highlight(String(source), { language }).value;
    return hljs.highlightAuto(String(source)).value;
  } catch {
    return escapeHtml(source);
  }
}

async function loadDisplayContent(token) {
  if (!token) throw new Error("Display content is unavailable.");
  try {
    return await loadDisplayContentOnce(token);
  } catch (error) {
    if (!payload?.resumeToken || !isExpiredDisplayError(error)) throw error;
    const refreshed = await refreshDisplayContent(payload.resumeToken);
    if (!refreshed.token) return "";
    return await loadDisplayContentOnce(refreshed.token);
  }
}

async function loadDisplayContentOnce(token) {
  const result = await app.callServerTool({
    name: "load_display_content",
    arguments: { token },
  });
  if (result?.isError) throw new Error(toolErrorMessage(result, "Display content is unavailable."));
  const text = (result?.content || []).find((item) => item?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Display content returned no text.");
  return text;
}

function isExpiredDisplayError(error) {
  const message = String(error?.message || error || "");
  return /display content is unknown or expired|display session cannot be refreshed|unknown or expired|token expired/i.test(message);
}

async function refreshDisplayContent(resumeToken) {
  const result = await app.callServerTool({
    name: "refresh_display_content",
    arguments: { resumeToken },
  });
  if (result?.isError) throw new Error(toolErrorMessage(result, "Display session could not be renewed"));
  const fresh = result?.structuredContent;
  if (!fresh?.kind || fresh.kind !== "display") throw new Error("Display session refresh returned no display payload");
  payload = fresh;
  selectedDiffFile = 0;
  return fresh;
}

function displayShell({ title, badge = "", meta = "", body }) {
  return '<main class="shell display-shell">'
    + '<header class="header display-header">'
    + '<div class="file-identity">'
    + '<div class="display-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + "</div>"
    + (meta ? '<span class="display-meta">' + escapeHtml(meta) + "</span>" : "")
    + "</div>"
    + (badge ? '<span class="badge">' + escapeHtml(badge) + "</span>" : "")
    + "</header>"
    + body
    + "</main>";
}

function highlightDiffLine(line, language, kind) {
  if (kind === "file-header" || kind === "hunk" || kind === "meta") return escapeHtml(line);
  const code = line.replace(/^[ + -]/, "");
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: normalizeHighlightLanguage(language), ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function displayDiffRow({ kind, oldNumber, newNumber, marker, code }) {
  return '<code class="display-diff-line ' + kind + '">'
    + '<span class="display-line-no">' + oldNumber + "</span>"
    + '<span class="display-line-no">' + newNumber + "</span>"
    + '<span class="display-marker" aria-hidden="true">' + marker + "</span>"
    + '<span class="display-code">' + code + "</span></code>";
}

function renderDisplayDiffFile(file) {
  let oldLine = null;
  let newLine = null;
  const rows = [];
  for (const { line, kind } of classifyUnifiedLines(file.lines)) {
    if (kind === "hunk") {
      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[3]) : null;
      rows.push(displayDiffRow({ kind, oldNumber: "", newNumber: "", marker: "", code: escapeHtml(line) }));
      continue;
    }
    if (kind === "file-header" || kind === "meta") {
      rows.push(displayDiffRow({ kind, oldNumber: "", newNumber: "", marker: "", code: escapeHtml(line) }));
      continue;
    }

    let oldNumber = "";
    let newNumber = "";
    let marker = " ";
    if (kind === "added") {
      newNumber = newLine ?? "";
      if (newLine != null) newLine += 1;
      marker = "+";
    } else if (kind === "removed") {
      oldNumber = oldLine ?? "";
      if (oldLine != null) oldLine += 1;
      marker = "−";
    } else {
      oldNumber = oldLine ?? "";
      newNumber = newLine ?? "";
      if (oldLine != null) oldLine += 1;
      if (newLine != null) newLine += 1;
    }

    rows.push(displayDiffRow({
      kind,
      oldNumber,
      newNumber,
      marker,
      code: highlightDiffLine(line, file.language, kind),
    }));
  }
  return rows.join("");
}

async function renderDiffDisplay(expectedGeneration) {
  if (payload?.clean === true) {
    root.innerHTML = displayShell({
      title: payload.title || "Changes",
      badge: "changes",
      meta: payload.branch || "",
      body: '<section class="display-empty">Working tree is clean.</section>',
    });
    return;
  }

  root.innerHTML = displayShell({
    title: payload?.title || (payload?.type === "changes" ? "Changes" : "Diff"),
    badge: payload?.type === "changes" ? "changes" : "diff",
    meta: payload?.branch || "",
    body: '<section class="loading">Loading diff…</section>',
  });
  const source = await loadDisplayContent(payload?.token);
  if (expectedGeneration !== generation) return;
  if (payload?.clean === true) {
    root.innerHTML = displayShell({
      title: payload.title || "Changes",
      badge: "changes",
      meta: payload.branch || "",
      body: '<section class="display-empty">Working tree is clean.</section>',
    });
    return;
  }
  const files = splitUnifiedDiff(source);
  if (!files.length) {
    root.innerHTML = displayShell({
      title: payload?.title || "Diff",
      badge: payload?.type === "changes" ? "changes" : "diff",
      meta: payload?.branch || "",
      body: '<section class="display-empty">No displayable diff hunks.</section>',
    });
    return;
  }

  if (selectedDiffFile >= files.length) selectedDiffFile = 0;
  const selected = files[selectedDiffFile];
  const tabs = files.map((file, index) => {
    const active = index === selectedDiffFile ? " active" : "";
    const additions = file.additions > 0 ? '<span class="display-tab-add">+' + file.additions + "</span>" : "";
    const deletions = file.deletions > 0 ? '<span class="display-tab-del">−' + file.deletions + "</span>" : "";
    return '<button class="display-diff-tab' + active + '" type="button" data-display-diff-index="' + index
      + '" title="' + escapeHtml(file.path) + '"><span class="display-diff-tab-name">'
      + escapeHtml(file.name) + "</span>" + additions + deletions + "</button>";
  }).join("");
  const truncated = payload?.truncated
    ? '<div class="display-notice">Diff was truncated to the safe display limit.</div>'
    : "";
  const fileLabel = files.length + " file" + (files.length === 1 ? "" : "s");
  root.innerHTML = displayShell({
    title: payload?.title || (payload?.type === "changes" ? "Changes" : "Diff"),
    badge: payload?.type === "changes" ? "changes" : "diff",
    meta: payload?.branch || fileLabel,
    body: truncated
      + '<section class="display-diff-card" aria-label="Code changes">'
      + '<nav class="display-diff-tabs" aria-label="Changed files">' + tabs + "</nav>"
      + '<div class="display-diff-wrap" role="region" aria-label="Diff for ' + escapeHtml(selected.path) + '" tabindex="0">'
      + '<pre class="display-diff">' + renderDisplayDiffFile(selected) + "</pre>"
      + "</div></section>",
  });
}

async function renderMarkdownDisplay(expectedGeneration) {
  root.innerHTML = displayShell({
    title: payload?.title || "Markdown",
    badge: "markdown",
    body: '<section class="loading">Loading document…</section>',
  });
  const source = await loadDisplayContent(payload?.token);
  if (expectedGeneration !== generation) return;
  root.innerHTML = displayShell({
    title: payload?.title || "Markdown",
    badge: "markdown",
    body: '<article class="markdown-view display-document">' + renderMarkdown(source) + "</article>",
  });
}

function htmlArtifactDocument(source) {
  const csp = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '">' + String(source || "");
}

async function renderHtmlDisplay(expectedGeneration) {
  root.innerHTML = displayShell({
    title: payload?.title || "HTML artifact",
    badge: "html",
    body: '<section class="loading">Loading artifact…</section>',
  });
  const source = await loadDisplayContent(payload?.token);
  if (expectedGeneration !== generation) return;
  root.innerHTML = displayShell({
    title: payload?.title || "HTML artifact",
    badge: "html",
    body: '<div class="html-artifact-wrap"><iframe class="html-artifact" data-html-artifact sandbox title="HTML artifact"></iframe></div>',
  });
  const frame = root.querySelector("[data-html-artifact]");
  if (frame) frame.srcdoc = htmlArtifactDocument(source);
}

function hexDump(bytes, limit = 4096) {
  const view = bytes.subarray(0, Math.min(bytes.length, limit));
  const lines = [];
  for (let offset = 0; offset < view.length; offset += 16) {
    const slice = view.subarray(offset, offset + 16);
    const hex = Array.from(slice, (byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = Array.from(slice, (byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}

function annotatableFile(file) {
  return ["text", "code", "markdown"].includes(file?.category);
}

function fileKey(file) {
  return `${file?.displayPath || file?.name || ""}:${file?.bytes || ""}`;
}

function previewFiles() {
  if (Array.isArray(payload?.files) && payload.files.length) return payload.files;
  return payload?.file ? [payload.file] : [];
}

function activeFile() {
  const files = previewFiles();
  if (!files.length) return null;
  activeFileIndex = Math.max(0, Math.min(activeFileIndex, files.length - 1));
  return files[activeFileIndex];
}

function replacePreviewFile(previous, fresh) {
  const files = previewFiles();
  const index = files.findIndex((file) => file.resumeToken === previous?.resumeToken);
  if (index < 0) return false;
  const nextFiles = [...files];
  nextFiles[index] = fresh;
  payload = {
    ...payload,
    file: nextFiles[0],
    ...(nextFiles.length > 1 ? { files: nextFiles } : {}),
  };
  return true;
}

function activateAnnotations(file) {
  if (annotationFileKey) annotationsByFile.set(annotationFileKey, annotations);
  annotationFileKey = fileKey(file);
  annotations = annotationsByFile.get(annotationFileKey) || [];
  annotationsByFile.set(annotationFileKey, annotations);
  pendingQuote = "";
  selectedQuote = "";
}

function navigateFiles(direction) {
  const files = previewFiles();
  const nextIndex = Math.max(0, Math.min(activeFileIndex + direction, files.length - 1));
  if (nextIndex === activeFileIndex) return;
  activeFileIndex = nextIndex;
  activateAnnotations(files[activeFileIndex]);
  render();
}

function fileNavigation() {
  const files = previewFiles();
  if (files.length <= 1) return "";
  const imageCount = files.filter((file) => file.category === "image").length;
  const label = imageCount === files.length
    ? `${imageCount} images`
    : `${files.length} files${imageCount > 1 ? ` · ${imageCount} images` : ""}`;
  return `<nav class="header" aria-label="File preview navigation">
    <button class="annotation-add annotation-copy" type="button" data-preview-previous aria-label="Previous file" title="Previous file" ${activeFileIndex === 0 ? "disabled" : ""}>←</button>
    <span class="badge" aria-live="polite">${activeFileIndex + 1} of ${files.length} · ${label}</span>
    <button class="annotation-add annotation-copy" type="button" data-preview-next aria-label="Next file" title="Next file" ${activeFileIndex === files.length - 1 ? "disabled" : ""}>→</button>
  </nav>`;
}

function annotationControls(file) {
  if (!annotatableFile(file)) return "";
  return `<div class="annotation-actions">
    <button class="annotation-add" type="button" data-add-note>Add note</button>
    <span class="annotation-count" data-annotation-count hidden></span>
    <button class="annotation-copy" type="button" data-copy-annotations aria-label="Copy annotations" title="Copy annotations" hidden>Copy</button>
  </div>`;
}

function shell(file, body) {
  const cloudTag = file.cloud
    ? (file.cloudUrl
      ? `<a class="badge cloud-badge" data-cloud-link href="${escapeHtml(file.cloudUrl)}" target="_blank" rel="noopener noreferrer" title="Open cloud preview">cloud</a>`
      : '<span class="badge cloud-badge">cloud</span>')
    : "";
  return `<main class="shell">
    <header class="header">
      <div class="file-identity">
        <button class="file-title" type="button" data-open-file title="Open ${escapeHtml(file.displayPath || file.name)} on this device">${escapeHtml(file.name)}</button>
        ${cloudTag}
      </div>
      <div class="header-actions">${annotationControls(file)}<span class="badge">${escapeHtml(file.category)}</span></div>
    </header>
    ${fileNavigation()}
    ${body}
    ${annotatableFile(file) ? `<section class="annotation-composer" data-annotation-composer hidden>
      <div class="annotation-quote" data-annotation-quote></div>
      <textarea data-annotation-note rows="3" placeholder="Add note…"></textarea>
      <div class="annotation-composer-actions">
        <button type="button" data-cancel-note>Cancel</button>
        <button type="button" data-save-note>Add</button>
      </div>
    </section>
    <section class="annotation-copy-fallback" data-copy-fallback hidden>
      <div>Clipboard access is blocked here. Copy the selected text below.</div>
      <textarea data-copy-fallback-text readonly rows="6"></textarea>
      <div class="annotation-composer-actions"><button type="button" data-close-copy>Done</button></div>
    </section>` : ""}
  </main>`;
}

function syncAnnotationUi() {
  const count = root.querySelector("[data-annotation-count]");
  const copy = root.querySelector("[data-copy-annotations]");
  const add = root.querySelector("[data-add-note]");
  if (!count || !copy || !add) return;
  const total = annotations.length;
  count.textContent = `${total} ${total === 1 ? "note" : "notes"}`;
  count.hidden = total === 0;
  copy.hidden = total === 0;
  add.classList.toggle("ready", Boolean(selectedQuote));
  add.title = selectedQuote ? "Add a note to the selected text" : "Select text, then add a note";
}

function selectedPreviewText() {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const quote = selection.toString().trim();
  if (!quote) return null;
  const range = selection.getRangeAt(0);
  const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const end = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
  const view = start?.closest?.(".text-view,.code-view,.markdown-view");
  if (!view || !view.contains(end)) return null;
  return { quote, rect: range.getBoundingClientRect() };
}

function updateSelectionAction() {
  if (root.querySelector("[data-annotation-composer]:not([hidden])")) return;
  const selected = selectedPreviewText();
  if (!selected) return;
  selectedQuote = selected.quote;
  syncAnnotationUi();
}

function openAnnotationComposer() {
  const selected = selectedPreviewText();
  pendingQuote = selected?.quote || selectedQuote;
  if (!pendingQuote) {
    const button = root.querySelector("[data-add-note]");
    if (button) {
      const original = button.textContent;
      button.textContent = "Select text first";
      setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1200);
    }
    return;
  }
  const composer = root.querySelector("[data-annotation-composer]");
  const quote = root.querySelector("[data-annotation-quote]");
  const note = root.querySelector("[data-annotation-note]");
  const add = root.querySelector("[data-add-note]");
  if (!composer || !quote || !note) return;
  quote.textContent = pendingQuote;
  composer.hidden = false;
  if (add) add.hidden = true;
  note.value = "";
  note.focus();
}

function closeAnnotationComposer() {
  const composer = root.querySelector("[data-annotation-composer]");
  if (composer) composer.hidden = true;
  pendingQuote = "";
  globalThis.getSelection?.()?.removeAllRanges?.();
}

function saveAnnotation() {
  const note = root.querySelector("[data-annotation-note]")?.value?.trim() || "";
  if (!pendingQuote || !note) return;
  annotations.push({ quote: pendingQuote, note });
  selectedQuote = "";
  closeAnnotationComposer();
  syncAnnotationUi();
}

function formattedAnnotations(file) {
  const lines = [`FILE: ${file?.displayPath || file?.name || "unknown"}`, ""];
  annotations.forEach((item, index) => {
    lines.push(
      `[ANNOTATION ${index + 1}]`,
      "SELECTED:",
      item.quote,
      "",
      "NOTE:",
      item.note,
      "",
    );
  });
  return lines.join("\n").trimEnd();
}

async function copyText(value) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
  } catch {
    textarea.focus();
  }
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {}
  textarea.remove();
  if (copied) return true;

  const policy = document.permissionsPolicy || document.featurePolicy;
  const clipboardAllowed = typeof policy?.allowsFeature === "function"
    ? policy.allowsFeature("clipboard-write")
    : true;
  if (clipboardAllowed && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}
  }
  return false;
}

function showManualCopy(value) {
  const panel = root.querySelector("[data-copy-fallback]");
  const textarea = root.querySelector("[data-copy-fallback-text]");
  if (!panel || !textarea) return;
  textarea.value = value;
  panel.hidden = false;
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
}

function fallbackToLocal(file) {
  if (activeFile()?.openToken !== file.openToken) return;
  replacePreviewFile(file, { ...file, cloud: false });
  render();
}

async function render() {
  const currentGeneration = ++generation;

  if (payload?.kind === "display" && payload.type !== "file") {
    try {
      if (payload.type === "changes" || payload.type === "diff") {
        await renderDiffDisplay(currentGeneration);
        return;
      }
      if (payload.type === "markdown") {
        await renderMarkdownDisplay(currentGeneration);
        return;
      }
      if (payload.type === "html") {
        await renderHtmlDisplay(currentGeneration);
        return;
      }
    } catch (error) {
      if (currentGeneration !== generation) return;
      root.innerHTML = displayShell({
        title: payload?.title || "Display",
        badge: payload?.type || "display",
        body: '<section class="error"><strong>Could not render display.</strong><p>' + escapeHtml(error?.message || String(error)) + "</p></section>",
      });
      return;
    }
  }

  if (!activeFile()) {
    root.innerHTML = `<main class="shell"><div class="empty">${escapeHtml(payload?.error || "Waiting for display…")}</div></main>`;
    return;
  }

  const file = activeFile();
  root.innerHTML = shell(file, '<section class="loading">Loading preview…</section>');

  if (file.cloud && ["image", "audio", "video", "pdf"].includes(file.category)) {
    try {
      const remoteUrl = file.cloudUrl || await resolveCloudPreviewUrl(file);
      if (currentGeneration !== generation) return;
      const cloudFile = { ...file, cloudUrl: remoteUrl };
      replacePreviewFile(file, cloudFile);

      if (file.category === "pdf") {
        root.innerHTML = shell(cloudFile, '<div class="pdf-pages" data-pdf-pages><div class="loading">Rendering PDF pages…</div></div>');
        await renderPdfPages(remoteUrl, currentGeneration);
        return;
      }

      const safeUrl = escapeHtml(remoteUrl);
      let body = "";
      if (file.category === "image") body = `<div class="media image"><img data-cloud-media src="${safeUrl}" alt="${escapeHtml(file.name)}" /></div>`;
      if (file.category === "audio") body = `<div class="media audio"><audio data-cloud-media controls preload="metadata" src="${safeUrl}"></audio></div>`;
      if (file.category === "video") body = `<div class="media video"><video data-cloud-media controls playsinline preload="metadata" src="${safeUrl}"></video></div>`;
      root.innerHTML = shell(cloudFile, body);
      root.querySelector("[data-cloud-media]")?.addEventListener("error", () => fallbackToLocal(cloudFile), { once: true });
      return;
    } catch (error) {
      if (currentGeneration !== generation) return;
      if (await recoverExpiredPreview(file, currentGeneration, error)) return;
      fallbackToLocal(file);
      return;
    }
  }

  if (!file.resourceUri) {
    root.innerHTML = shell(file, `<section class="unsupported">
      <strong>Inline bytes were not loaded.</strong>
      <p>${escapeHtml(file.reason || "This file exceeds the safe inline preview limit.")}</p>
    </section>`);
    return;
  }

  try {
    const content = await loadPreviewContent(file);
    if (currentGeneration !== generation) return;

    let body = "";
    if (["text", "code", "markdown"].includes(file.category)) {
      const text = typeof content.text === "string" ? content.text : new TextDecoder().decode(decodeBase64(content.blob || ""));
      if (file.category === "markdown") body = `<article class="markdown-view">${renderMarkdown(text)}</article>`;
      else if (file.category === "code") body = `<pre class="code-view"><code class="hljs">${highlightedCode(text, file.language)}</code></pre>`;
      else body = `<pre class="text-view">${escapeHtml(text)}</pre>`;
    } else if (["image", "audio", "video"].includes(file.category)) {
      const dataUri = dataUriFrom(content, file.mimeType);
      if (file.category === "image") body = `<div class="media image"><img src="${dataUri}" alt="${escapeHtml(file.name)}" /></div>`;
      if (file.category === "audio") body = `<div class="media audio"><audio controls preload="metadata" src="${dataUri}"></audio></div>`;
      if (file.category === "video") body = `<div class="media video"><video controls playsinline preload="metadata" src="${dataUri}"></video></div>`;
    } else if (file.category === "pdf") {
      if (!content.blob) throw new Error("PDF preview bytes are missing");
      body = '<div class="pdf-pages" data-pdf-pages><div class="loading">Rendering PDF pages…</div></div>';
      root.innerHTML = shell(file, body);
      await renderPdfPages(decodeBase64(content.blob), currentGeneration);
      return;
    } else {
      const bytes = content.blob ? decodeBase64(content.blob) : new TextEncoder().encode(content.text || "");
      body = `<section class="binary"><div class="binary-label">Binary preview · ${escapeHtml(humanBytes(bytes.length))} loaded</div><pre>${escapeHtml(hexDump(bytes))}</pre></section>`;
    }

    root.innerHTML = shell(file, body);
    syncAnnotationUi();
  } catch (error) {
    if (currentGeneration !== generation) return;
    if (await recoverExpiredPreview(file, currentGeneration, error)) return;
    root.innerHTML = shell(file, `<section class="error"><strong>Could not load preview.</strong><p>${escapeHtml(friendlyPreviewError(error))}</p></section>`);
  }
}

root.addEventListener("pointerup", () => setTimeout(updateSelectionAction, 0));
root.addEventListener("keyup", () => setTimeout(updateSelectionAction, 0));
document.addEventListener("selectionchange", () => setTimeout(updateSelectionAction, 0));

root.addEventListener("click", async (event) => {
  const diffTab = event.target.closest?.("[data-display-diff-index]");
  if (diffTab) {
    selectedDiffFile = Number(diffTab.dataset.displayDiffIndex) || 0;
    render();
    return;
  }
  if (event.target.closest?.("[data-preview-previous]")) {
    navigateFiles(-1);
    return;
  }
  if (event.target.closest?.("[data-preview-next]")) {
    navigateFiles(1);
    return;
  }
  if (event.target.closest?.("[data-add-note]")) {
    openAnnotationComposer();
    return;
  }
  if (event.target.closest?.("[data-cancel-note]")) {
    closeAnnotationComposer();
    return;
  }
  if (event.target.closest?.("[data-save-note]")) {
    saveAnnotation();
    return;
  }
  if (event.target.closest?.("[data-close-copy]")) {
    const panel = root.querySelector("[data-copy-fallback]");
    if (panel) panel.hidden = true;
    return;
  }
  const copyButton = event.target.closest?.("[data-copy-annotations]");
  if (copyButton) {
    if (!annotations.length || copyButton.disabled) return;
    copyButton.disabled = true;
    const original = copyButton.textContent;
    const value = formattedAnnotations(activeFile());
    try {
      const copied = await copyText(value);
      if (copied) copyButton.textContent = "Copied";
      else {
        copyButton.textContent = "Copy manually";
        showManualCopy(value);
      }
    } catch {
      copyButton.textContent = "Copy manually";
      showManualCopy(value);
    } finally {
      setTimeout(() => {
        if (!copyButton.isConnected) return;
        copyButton.disabled = false;
        copyButton.textContent = original;
      }, 1200);
    }
    return;
  }

  const openButton = event.target.closest?.("[data-open-file]");
  if (!openButton) return;
  const file = activeFile();
  if (!file?.openToken || openButton.disabled) return;
  openButton.disabled = true;
  const previousTitle = openButton.title;

  const openToken = async (token) => {
    const result = await app.callServerTool({ name: "open_preview_file", arguments: { token } });
    if (result?.isError) throw new Error(toolErrorMessage(result, "Could not open file on this device"));
  };

  try {
    try {
      await openToken(file.openToken);
    } catch (error) {
      if (!file.resumeToken || !isExpiredPreviewError(error)) throw error;
      const fresh = await refreshPreviewFile(file);
      await openToken(fresh.openToken);
    }
    openButton.title = "Opened on this device";
  } catch (error) {
    openButton.title = friendlyPreviewError(error);
  } finally {
    openButton.disabled = false;
    setTimeout(() => { if (openButton.isConnected) openButton.title = previousTitle; }, 1800);
  }
});

const app = createLiteApp({
  name: "Display",
  version: "2.0.0",
  onToolResult: (result) => {
    const nextPayload = result?.structuredContent || null;
    payload = nextPayload;
    activeFileIndex = 0;
    selectedDiffFile = 0;
    annotations = [];
    annotationsByFile = new Map();
    annotationFileKey = "";
    const file = activeFile();
    if (file) activateAnnotations(file);
    render();
  },
  onError: (error) => {
    payload = { error: error.message || String(error) };
    render();
  },
});

render();
app.connect().catch(() => {});
