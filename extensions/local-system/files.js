/* global document, location, parent, requestAnimationFrame */

const threadId = new URLSearchParams(location.search).get("threadId") || "";
const panel = document.querySelector(".panel");
const results = document.getElementById("results");
const status = document.getElementById("status");
let files = [];
let activeIndex = 0;
let requestSequence = 0;
let debounceTimer = null;
let currentQuery = null;
let attaching = false;

globalThis.addEventListener("message", (event) => {
  if (event.data?.source !== "local-system-palette-host") return;
  applyTheme(event.data.theme);
  if (event.data.action === "query") {
    const query = typeof event.data.query === "string" ? event.data.query : "";
    if (query === currentQuery) return;
    currentQuery = query;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadFiles(query), 55);
    return;
  }
  if (event.data.action === "navigate") {
    moveActive(Number(event.data.delta) || 0);
    return;
  }
  if (event.data.action === "select-path-active" && files[activeIndex]) {
    parent.postMessage({
      source: "local-system-files",
      action: "select-path",
      path: files[activeIndex].path,
    }, "*");
    return;
  }
  if (event.data.action === "select-active" && files[activeIndex]) attach(files[activeIndex]);
});

async function loadFiles(query) {
  if (attaching) return;
  const sequence = ++requestSequence;
  if (!files.length) setStatus("Searching files…");
  try {
    const payload = await requestJson("/local-ui/files/search", {
      threadId,
      query,
      active: true,
    });
    if (sequence !== requestSequence) return;
    files = Array.isArray(payload.files) ? payload.files : [];
    activeIndex = Math.min(activeIndex, Math.max(0, files.length - 1));
    render();
  } catch (error) {
    if (sequence !== requestSequence) return;
    files = [];
    setStatus(error?.message || "Local System is unavailable.");
  }
}

async function attach(file) {
  if (attaching) return;
  attaching = true;
  setStatus(`Attaching ${file.name}…`);
  try {
    const descriptor = await requestJson("/local-ui/files/resolve", {
      threadId,
      path: file.path,
      active: true,
    });
    const response = await fetch(descriptor.url, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`File download failed with HTTP ${response.status}`);
    const blob = await response.blob();
    parent.postMessage({
      source: "local-system-files",
      action: "select",
      blob,
      name: descriptor.name || file.name,
      mimeType: descriptor.mimeType || blob.type,
      lastModified: descriptor.lastModified || file.lastModified,
    }, "*");
  } catch (error) {
    attaching = false;
    setStatus(error?.message || "Could not attach file.");
  }
}

async function requestJson(path, body) {
  const api = globalThis.LocalSystemExtensionApi;
  if (!api?.request) throw new Error("Local System extension API unavailable");
  return api.request(path, body, { timeoutMs: 2_000 });
}

function render() {
  results.replaceChildren();
  status.classList.remove("visible");
  if (!files.length) return setStatus(currentQuery?.trim() ? "No matching files" : "No files found in this workspace");
  const fragment = document.createDocumentFragment();
  files.forEach((file, index) => {
    const row = document.createElement("div");
    row.className = `file ls-ui-list-row${index === activeIndex ? " active" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === activeIndex ? "true" : "false");

    const icon = document.createElement("div");
    const type = fileType(file.name);
    icon.className = "file-icon";
    icon.dataset.kind = type.kind;
    icon.textContent = type.label;
    icon.title = type.title;
    const content = document.createElement("div");
    content.className = "file-content";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = file.name;
    const filePath = document.createElement("div");
    filePath.className = "path";
    filePath.textContent = file.displayPath || file.path;
    content.append(name, filePath);
    const meta = document.createElement("div");
    meta.className = "file-meta";
    const source = document.createElement("div");
    source.className = "source-tag";
    source.dataset.source = sourceKind(file.source);
    source.textContent = sourceLabel(file.source);
    const size = document.createElement("div");
    size.className = "size";
    size.textContent = formatBytes(file.bytes);
    meta.append(source, size);
    row.append(icon, content, meta);
    row.addEventListener("mouseenter", () => setActive(index));
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => attach(file));
    fragment.appendChild(row);
  });
  results.appendChild(fragment);
  setActive(activeIndex);
  reportSize();
}

function setActive(index) {
  if (!files.length) return;
  activeIndex = Math.max(0, Math.min(files.length - 1, index));
  [...results.children].forEach((row, rowIndex) => {
    row.classList.toggle("active", rowIndex === activeIndex);
    row.setAttribute("aria-selected", rowIndex === activeIndex ? "true" : "false");
  });
  results.children[activeIndex]?.scrollIntoView({ block: "nearest" });
}

function moveActive(delta) {
  if (!files.length || !delta) return;
  setActive((activeIndex + delta + files.length) % files.length);
}

function setStatus(message) {
  results.replaceChildren();
  status.textContent = message;
  status.classList.add("visible");
  reportSize();
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function sourceKind(value) {
  const source = String(value || "").trim().toLowerCase();
  if (source === "workspace") return "workspace";
  if (source === "scratch") return "scratch";
  return "root";
}

function sourceLabel(value) {
  const source = String(value || "").trim();
  if (!source) return "Root";
  if (source.toLowerCase() === "workspace") return "Workspace";
  if (source.toLowerCase() === "scratch") return "Scratch";
  return source;
}

function fileType(name) {
  const base = String(name || "").trim();
  const lower = base.toLowerCase();
  if (/^dockerfile(?:\..+)?$/i.test(base)) return { kind: "docker", label: "D", title: "Dockerfile" };
  if (/^\.env(?:\..+)?$/i.test(base)) return { kind: "config", label: "⚙", title: "Environment file" };
  const index = lower.lastIndexOf(".");
  const ext = index > 0 ? lower.slice(index + 1) : "";
  const types = {
    html: ["html", "</>", "HTML"], htm: ["html", "</>", "HTML"],
    py: ["python", "Py", "Python"], pyw: ["python", "Py", "Python"],
    js: ["javascript", "JS", "JavaScript"], jsx: ["javascript", "JS", "JavaScript"], mjs: ["javascript", "JS", "JavaScript"], cjs: ["javascript", "JS", "JavaScript"],
    ts: ["typescript", "TS", "TypeScript"], tsx: ["typescript", "TS", "TypeScript"],
    css: ["css", "#", "CSS"], scss: ["css", "#", "Stylesheet"], sass: ["css", "#", "Stylesheet"], less: ["css", "#", "Stylesheet"],
    json: ["json", "{}", "JSON"], jsonc: ["json", "{}", "JSON"],
    md: ["markdown", "MD", "Markdown"], mdx: ["markdown", "MD", "Markdown"], markdown: ["markdown", "MD", "Markdown"],
    sh: ["shell", "$", "Shell"], bash: ["shell", "$", "Shell"], zsh: ["shell", "$", "Shell"], fish: ["shell", "$", "Shell"],
    java: ["java", "J", "Java"], kt: ["kotlin", "K", "Kotlin"], kts: ["kotlin", "K", "Kotlin"], swift: ["swift", "S", "Swift"],
    go: ["go", "Go", "Go"], rs: ["rust", "Rs", "Rust"], rb: ["ruby", "Rb", "Ruby"], php: ["php", "P", "PHP"],
    sql: ["sql", "DB", "SQL"], xml: ["xml", "<>", "XML"], svg: ["xml", "<>", "SVG"],
    yml: ["yaml", "Y", "YAML"], yaml: ["yaml", "Y", "YAML"], toml: ["config", "⚙", "TOML"], ini: ["config", "⚙", "Config"], conf: ["config", "⚙", "Config"],
    png: ["image", "◈", "Image"], jpg: ["image", "◈", "Image"], jpeg: ["image", "◈", "Image"], gif: ["image", "◈", "Image"], webp: ["image", "◈", "Image"],
  };
  const type = types[ext];
  if (type) return { kind: type[0], label: type[1], title: type[2] };
  return { kind: "generic", label: ext ? ext.slice(0, 2).toUpperCase() : "•", title: ext ? `${ext.toUpperCase()} file` : "File" };
}

function applyTheme(theme) {
  globalThis.LocalSystemSharedRuntime?.applyTheme(theme, {
    aliases: true,
    composerTypography: true,
    mainFontSizeVariable: "--ls-file-picker-font-size",
  });
}

function reportSize() {
  requestAnimationFrame(() => {
    parent.postMessage({
      source: "local-system-files",
      action: "resize",
      height: Math.ceil(panel.getBoundingClientRect().height),
    }, "*");
  });
}
