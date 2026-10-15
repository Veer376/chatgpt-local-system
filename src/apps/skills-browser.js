/* global document */
import { createLiteApp } from "./mcp-lite.js";

const root = document.getElementById("root");
let payload = null;

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function render() {
  if (!payload) {
    root.innerHTML = '<main class="shell"><div class="loading">Discovering skills…</div></main>';
    return;
  }

  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  const total = Number(payload.total) || skills.length;
  const cards = skills.map((skill) => `<div class="skill" title="${esc(skill.description || skill.name)}">${esc(skill.name)}</div>`).join("");

  root.innerHTML = `<main class="shell">
    <section class="skills" aria-label="Discovered skills">
      <div class="meta"><b>Skills</b><span class="dot" aria-hidden="true"></span><span>${total}</span></div>
      ${skills.length ? `<div class="rail" tabindex="0">${cards}</div>` : '<div class="none">No matches</div>'}
    </section>
  </main>`;
}

const app = createLiteApp({
  name: "Skills",
  version: "2.2.0",
  onToolResult: (result) => {
    payload = result?.structuredContent || { skills: [], total: 0 };
    render();
  },
  onError: (error) => {
    root.innerHTML = `<main class="shell"><div class="error">${esc(error.message || error)}</div></main>`;
  },
});

render();
app.connect().catch(() => {});
