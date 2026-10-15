/* global document */
import { createLiteApp } from "./mcp-lite.js";
import { classifyUnifiedLines, splitUnifiedDiff } from "./apply-patch-parser.js";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("yaml", yaml);

const root = document.getElementById("root");
let payload = null;
let selectedFile = 0;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resultText(result) {
  return result?.content?.find((item) => item?.type === "text")?.text || "";
}

function highlightLine(line, language, kind) {
  if (kind === "file-header" || kind === "hunk" || kind === "meta") return escapeHtml(line);
  const code = line.replace(/^[ + -]/, "");
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function renderDiff(file) {
  let oldLine = null;
  let newLine = null;
  const rows = [];

  for (const { line, kind } of classifyUnifiedLines(file.lines)) {
    if (kind === "hunk") {
      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[3]) : null;
      rows.push(diffRow({ kind, oldNumber: "", newNumber: "", marker: "", code: escapeHtml(line) }));
      continue;
    }

    if (kind === "file-header" || kind === "meta") {
      rows.push(diffRow({ kind, oldNumber: "", newNumber: "", marker: "", code: escapeHtml(line) }));
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

    rows.push(diffRow({
      kind,
      oldNumber,
      newNumber,
      marker,
      code: highlightLine(line, file.language, kind),
    }));
  }
  return rows.join("");
}

function diffRow({ kind, oldNumber, newNumber, marker, code }) {
  return `<code class="line ${kind}"><span class="line-no">${oldNumber}</span><span class="line-no">${newNumber}</span><span class="marker" aria-hidden="true">${marker}</span><span class="code">${code}</span></code>`;
}

function render() {
  const files = splitUnifiedDiff(payload?.diff);
  if (!payload) {
    root.innerHTML = '<main class="shell"><div class="empty">Waiting for patch result…</div></main>';
    return;
  }
  if (!files.length) {
    const message = payload.error || "Patch result has no displayable diff.";
    root.innerHTML = `<main class="shell"><div class="error">${escapeHtml(message)}</div></main>`;
    return;
  }

  if (selectedFile >= files.length) selectedFile = 0;
  const selected = files[selectedFile];
  const tabs = files.map((file, index) => {
    const active = index === selectedFile ? " active" : "";
    const additions = file.additions > 0 ? `<span class="tab-add">+${file.additions}</span>` : "";
    const deletions = file.deletions > 0 ? `<span class="tab-del">−${file.deletions}</span>` : "";
    return `<button class="tab${active}" type="button" data-file-index="${index}" title="${escapeHtml(file.path)}"><span class="tab-name">${escapeHtml(file.name)}</span>${additions}${deletions}</button>`;
  }).join("");

  root.innerHTML = `<main class="shell">
    <section class="card" aria-label="Applied patch diff">
      <nav class="tabs" aria-label="Changed files">${tabs}</nav>
      <div class="diff-wrap" role="region" aria-label="Diff for ${escapeHtml(selected.path)}" tabindex="0">
        <pre class="diff">${renderDiff(selected)}</pre>
      </div>
    </section>
  </main>`;

  root.querySelectorAll("[data-file-index]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedFile = Number(button.dataset.fileIndex) || 0;
      render();
    });
  });
}

const app = createLiteApp({
  name: "Apply Patch Diff",
  version: "1.0.0",
  onToolResult: (result) => {
    payload = result?.structuredContent?.diff
      ? result.structuredContent
      : { error: resultText(result) || "Patch result unavailable." };
    selectedFile = 0;
    render();
  },
  onError: (error) => {
    payload = { error: error.message || String(error) };
    render();
  },
});

render();
app.connect().catch(() => {});
