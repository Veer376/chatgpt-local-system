/* global document */
import { createLiteApp } from "./mcp-lite.js";

const root = document.getElementById("root");
let result = null;

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function imageBlock(toolResult) {
  return (toolResult?.content || []).find((item) => item?.type === "image" && item.data && item.mimeType);
}

function toolError(toolResult) {
  return (toolResult?.content || []).map((item) => item?.type === "text" ? item.text || "" : "").filter(Boolean).join("\n");
}

function render() {
  if (!result) {
    root.innerHTML = '<main class="shell"><div class="empty">Waiting for image…</div></main>';
    return;
  }

  if (result.isError) {
    root.innerHTML = `<main class="shell"><div class="empty">${esc(toolError(result) || "Image could not be viewed")}</div></main>`;
    return;
  }

  const image = result?.structuredContent?.image;
  const block = imageBlock(result);
  if (!image || !block) {
    root.innerHTML = '<main class="shell"><div class="empty">Image data is unavailable.</div></main>';
    return;
  }

  root.innerHTML = `<main class="shell">
    <figure class="item">
      <div class="image-slot" data-image-slot aria-label="${esc(image.name)}">Loading…</div>
      <figcaption title="${esc(image.displayPath || image.name)}">${esc(image.name)}</figcaption>
    </figure>
  </main>`;

  const slot = root.querySelector("[data-image-slot]");
  const element = document.createElement("img");
  element.alt = image.name;
  element.loading = "eager";
  element.decoding = "async";
  element.src = `data:${block.mimeType};base64,${block.data}`;
  slot?.replaceWith(element);
}

const app = createLiteApp({
  name: "Image Preview",
  version: "3.0.0",
  onToolResult: (toolResult) => {
    result = toolResult || null;
    render();
  },
  onError: (error) => {
    result = { isError: true, content: [{ type: "text", text: error.message || String(error) }] };
    render();
  },
});

render();
app.connect().catch(() => {});
