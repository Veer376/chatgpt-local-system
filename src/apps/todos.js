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

const labels = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

function render() {
  if (!payload) {
    root.innerHTML = '<main class="shell"><section class="card loading">Updating todos…</section></main>';
    return;
  }

  const todos = Array.isArray(payload.todos) ? payload.todos : [];
  const completed = todos.filter((todo) => todo?.status === "completed").length;
  const active = todos.filter((todo) => todo?.status === "in_progress").length;
  const percent = todos.length ? Math.round((completed / todos.length) * 100) : 0;
  const rows = todos.map((todo) => {
    const status = labels[todo?.status] ? todo.status : "pending";
    return `<li class="todo ${esc(status)}">
      <span class="marker" aria-hidden="true"></span>
      <span class="content">${esc(todo?.content || todo?.id || "Untitled todo")}</span>
      <span class="status">${esc(labels[status])}</span>
    </li>`;
  }).join("");

  root.innerHTML = `<main class="shell">
    <section class="card" aria-label="Todo list">
      <header class="header">
        <div class="title-wrap">
          <div class="title">Todos</div>
          <div class="summary">${completed}/${todos.length} done${active ? ` · ${active} active` : ""}</div>
        </div>
        <div class="percent">${percent}%</div>
      </header>
      <div class="progress" aria-label="${percent}% complete"><span style="width:${percent}%"></span></div>
      ${todos.length ? `<ul class="list">${rows}</ul>` : '<div class="empty">No todos</div>'}
    </section>
  </main>`;
}

const app = createLiteApp({
  name: "Todos",
  version: "1.0.0",
  onToolResult: (result) => {
    payload = result?.structuredContent || { todos: [] };
    render();
  },
  onError: (error) => {
    root.innerHTML = `<main class="shell"><section class="card error">${esc(error.message || error)}</section></main>`;
  },
});

render();
app.connect().catch(() => {});
