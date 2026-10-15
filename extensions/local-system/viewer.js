/* global document, location, parent */

const root = document.getElementById("root");
const params = new URLSearchParams(location.search);
const id = params.get("id") || "";
const path = params.get("path") || "";
const threadId = params.get("threadId") || "";
const requestedPreview = params.get("preview") || "";
const mode = params.get("mode") === "modal" ? "modal" : "thumbnail";
const MAX_MARKDOWN_PREVIEW_BYTES = 2 * 1024 * 1024;
let objectUrl = "";

globalThis.addEventListener("message", (event) => {
  if (event.data?.source !== "local-system-host") return;
  applyTheme(event.data.theme);
});

render().catch((error) => {
  const message = error?.message || String(error);
  root.className = "error";
  root.textContent = message;
  report("error", { message, path, threadId });
});

globalThis.addEventListener("unload", () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

async function render() {
  if (!path) throw new Error("Missing local file path");
  document.documentElement.classList.add(mode);
  document.body.classList.add(mode);
  root.textContent = "Contacting Local System…";
  root.className = "status";

  const descriptor = await resolvePath(path);
  const previewKind = previewKindFor(descriptor);
  if (!previewKind) throw new Error("This file type does not have an inline preview");
  if (requestedPreview && requestedPreview !== previewKind) throw new Error("Local file preview type changed while loading");

  root.textContent = `Loading ${previewKind} preview…`;
  if (previewKind === "video") {
    renderVideo(descriptor);
    installInteraction();
    report("ready", { previewKind });
    return;
  }
  const response = await fetch(descriptor.url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Local file fetch failed with HTTP ${response.status}`);
  const blob = await response.blob();

  let readyDetails = { previewKind };
  if (previewKind === "image") readyDetails = { ...readyDetails, ...(await renderImage(blob)) };
  else if (previewKind === "markdown") await renderMarkdown(blob, descriptor);
  else if (previewKind === "pdf") await renderPdf(blob);

  installInteraction();
  report("ready", readyDetails);
}

async function renderImage(blob) {
  if (!blob.type.startsWith("image/")) throw new Error("Local bridge response is not an image");
  objectUrl = URL.createObjectURL(blob);
  const image = document.createElement("img");
  image.alt = fileName(path) || "Local image";
  const figure = document.createElement("figure");
  figure.className = "image-preview";
  figure.append(image);
  root.className = "preview-root image-root";
  root.replaceChildren(figure);

  await new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", () => reject(new Error("Browser could not decode the local image")), { once: true });
    image.src = objectUrl;
  });
  return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
}

function renderVideo(descriptor) {
  const video = document.createElement("video");
  video.className = "video-preview";
  video.preload = "metadata";
  video.playsInline = true;
  video.controls = mode === "modal";
  video.muted = mode === "thumbnail";
  video.addEventListener("error", () => {
    const message = "Browser could not preview the local video";
    root.className = "error";
    root.textContent = message;
    report("error", { message, path, threadId });
  }, { once: true });
  video.src = descriptor.url;
  root.className = "preview-root video-root";
  root.replaceChildren(video);
}

async function renderMarkdown(blob, descriptor) {
  if (Number(descriptor.bytes) > MAX_MARKDOWN_PREVIEW_BYTES || blob.size > MAX_MARKDOWN_PREVIEW_BYTES) {
    throw new Error("Markdown preview exceeds the 2 MiB inline preview limit");
  }
  const text = await blob.text();
  const article = document.createElement("article");
  article.className = "markdown-preview";
  article.innerHTML = markdownToHtml(text);
  root.className = "preview-root markdown-root";
  root.replaceChildren(article);
}

async function renderPdf(blob) {
  if (blob.type && blob.type !== "application/pdf") throw new Error("Local bridge response is not a PDF");
  objectUrl = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.className = "pdf-preview";
  frame.title = fileName(path) || "Local PDF";
  root.className = "preview-root pdf-root";
  root.replaceChildren(frame);
  await new Promise((resolve) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.src = objectUrl;
    setTimeout(resolve, 600);
  });
}

function installInteraction() {
  if (mode === "thumbnail") {
    root.classList.add("clickable-preview");
    root.title = `Open ${fileName(path) || "file"} preview`;
    root.addEventListener("click", () => {
      parent.postMessage({ source: "local-system-inline-image", id, action: "open", path }, "*");
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      root.click();
    });
    root.setAttribute("role", "button");
    root.setAttribute("tabindex", "0");
    return;
  }

  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.setAttribute("aria-label", "Close preview");
  close.textContent = "×";
  close.addEventListener("click", reportClose);
  document.body.appendChild(close);
  globalThis.addEventListener("keydown", (event) => {
    if (event.key === "Escape") reportClose();
  });
}

function applyTheme(theme) {
  globalThis.LocalSystemSharedRuntime?.applyTheme(theme);
}

function previewKindFor(descriptor) {
  const mimeType = String(descriptor?.mimeType || "").toLowerCase();
  const lower = String(descriptor?.name || path).toLowerCase();
  if (mimeType.startsWith("image/") && /\.(?:png|jpe?g|gif|webp|avif|svg)$/.test(lower)) return "image";
  if (mimeType.startsWith("video/") && /\.(?:mp4|mov|webm)$/.test(lower)) return "video";
  if (mimeType === "application/pdf" || /\.pdf$/.test(lower)) return "pdf";
  return "";
}

async function resolvePath(localPath) {
  const api = globalThis.LocalSystemExtensionApi;
  if (!api?.request) throw new Error("Local System extension API unavailable");
  const descriptor = await api.request(
    "/local-ui/files/resolve",
    { path: localPath, threadId, active: true },
    { timeoutMs: 2_500 },
  );
  if (!descriptor?.url) throw new Error("Local file bridge did not return a file URL");
  return descriptor;
}

function markdownToHtml(value) {
  const lines = String(value || "").replaceAll("\r\n", "\n").split("\n");
  const output = [];
  let listType = "";
  let inFence = false;
  let fenceLanguage = "";
  let fenceLines = [];

  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = "";
  };
  const closeFence = () => {
    output.push(`<pre><code${fenceLanguage ? ` data-language="${escapeHtml(fenceLanguage)}"` : ""}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
    inFence = false;
    fenceLanguage = "";
    fenceLines = [];
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([^\s`]*)/);
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
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) closeList();
      if (!listType) {
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${renderMarkdownInline((unordered || ordered)[1])}</li>`);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeList();
      output.push(`<blockquote>${renderMarkdownInline(quote[1])}</blockquote>`);
      continue;
    }
    closeList();
    output.push(`<p>${renderMarkdownInline(line)}</p>`);
  }
  closeList();
  if (inFence) closeFence();
  return output.join("\n");
}

function renderMarkdownInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 <span class=\"markdown-link\">($2)</span>");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fileName(value) {
  return String(value || "").split(/[\\/]/).pop() || "";
}

function report(status, details = {}) {
  parent.postMessage({ source: "local-system-inline-image", id, status, ...details }, "*");
}

function reportClose() {
  parent.postMessage({ source: "local-system-inline-image", id, action: "close" }, "*");
}
