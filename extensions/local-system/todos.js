/* global document, location, parent, requestAnimationFrame */

const params = new URLSearchParams(location.search);
const threadId = params.get("threadId") || "";
const panel = document.getElementById("panel");
const summary = document.getElementById("summary");
const summaryStatus = document.getElementById("summary-status");
const summaryCurrent = document.getElementById("summary-current");
const details = document.getElementById("details");
const summaryMeta = document.getElementById("summary-meta");
let hostActive = false;
let lastSignature = "";
let collapsedSummaryText = "Loading todos…";
let collapsedSummaryStatus = "pending";
let hostVisible = null;
let bindAfter = null;
let pollInFlight = false;

summary.addEventListener("click", () => {
  parent.postMessage({ source: "local-system-todos", action: "toggle" }, "*");
});

globalThis.addEventListener("message", (event) => {
  if (event.data?.source !== "local-system-host") return;
  if (typeof event.data.active === "boolean") hostActive = event.data.active;
  if (Number.isFinite(Number(event.data.bindAfter)) && Number(event.data.bindAfter) > 0) {
    bindAfter = Number(event.data.bindAfter);
  }
  if (event.data.theme) applyTheme(event.data.theme);
  if (typeof event.data.expanded === "boolean") setExpanded(event.data.expanded);
});

poll();
setInterval(poll, 1_000);

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollOnce();
  } finally {
    pollInFlight = false;
  }
}

async function pollOnce() {
  if (!threadId) return renderUnbound();
  try {
    if (bindAfter && Date.now() - bindAfter <= 120_000) {
      const binding = await fetchThreadBind(bindAfter);
      if (binding?.bound) {
        bindAfter = null;
        parent.postMessage({ source: "local-system-todos", action: "bound", bound: true }, "*");
      }
    } else if (bindAfter) {
      bindAfter = null;
    }
    const result = await fetchTodos();
    if (!result?.bound) return renderUnbound();
    renderTodos(Array.isArray(result.todos) ? result.todos : []);
  } catch {
    setHostVisible(false);
    setCollapsedSummary("Todos unavailable", "pending");
    summaryMeta.textContent = "offline";
  }
}

async function fetchThreadBind(sentAt) {
  const api = globalThis.LocalSystemExtensionApi;
  if (!api?.request) throw new Error("Local System extension API unavailable");
  return api.request("/local-ui/thread-bind", { threadId, sentAt }, { timeoutMs: 1_200 });
}

async function fetchTodos() {
  const api = globalThis.LocalSystemExtensionApi;
  if (!api?.request) throw new Error("Local System extension API unavailable");
  return api.request("/local-ui/todos", { threadId, active: hostActive }, { timeoutMs: 1_200 });
}

function renderTodos(todos) {
  const signature = JSON.stringify(todos);
  if (!todos.length) {
    lastSignature = signature;
    details.replaceChildren();
    summaryMeta.textContent = "";
    if (panel.classList.contains("expanded")) setExpanded(false);
    setHostVisible(false);
    return;
  }

  setHostVisible(true);
  const completed = todos.filter((item) => item.status === "completed").length;
  const current = todos.find((item) => item.status === "in_progress")
    || todos.find((item) => item.status === "pending")
    || null;

  if (current) {
    setCollapsedSummary(current.content, current.status);
  } else {
    setCollapsedSummary("All todos complete", "completed");
  }
  summaryMeta.textContent = `${completed}/${todos.length}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  details.replaceChildren();
  for (const item of todos) {
    const row = document.createElement("div");
    row.className = `todo ls-ui-list-row ${item.status}`;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = iconFor(item.status);
    const content = document.createElement("span");
    content.className = "content";
    content.textContent = item.content;
    row.append(status, content);
    details.appendChild(row);
  }
  resizeIfExpanded();
}

function renderUnbound() {
  setHostVisible(false);
  lastSignature = "";
  setCollapsedSummary("Waiting for Local System", "pending");
  summaryMeta.textContent = "";
  details.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = "This thread will bind after its next Local System action.";
  details.appendChild(empty);
  resizeIfExpanded();
}

function setHostVisible(visible) {
  if (hostVisible === visible) return;
  hostVisible = visible;
  parent.postMessage({
    source: "local-system-todos",
    action: "visibility",
    visible,
  }, "*");
}

function setExpanded(expanded, { force = false } = {}) {
  if (!force && panel.classList.contains("expanded") === expanded) return;
  panel.classList.toggle("expanded", expanded);
  summary.setAttribute("aria-expanded", expanded ? "true" : "false");
  renderSummaryPresentation();
  requestAnimationFrame(() => {
    const height = expanded ? Math.min(300, Math.ceil(panel.scrollHeight)) : 40;
    parent.postMessage({ source: "local-system-todos", action: "resize", height }, "*");
  });
}

function setCollapsedSummary(text, status) {
  collapsedSummaryText = text;
  collapsedSummaryStatus = status;
  renderSummaryPresentation();
}

function renderSummaryPresentation() {
  if (panel.classList.contains("expanded")) {
    summaryCurrent.textContent = "Todos";
    summaryStatus.textContent = "";
    summaryStatus.className = "summary-status";
    return;
  }
  summaryCurrent.textContent = collapsedSummaryText;
  summaryStatus.textContent = iconFor(collapsedSummaryStatus);
  summaryStatus.className = `summary-status ${collapsedSummaryStatus}`;
}

function resizeIfExpanded() {
  if (panel.classList.contains("expanded")) setExpanded(true, { force: true });
}

function applyTheme(theme) {
  globalThis.LocalSystemSharedRuntime?.applyTheme(theme, {
    aliases: true,
    composerTypography: true,
  });
}

function iconFor(status) {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  if (status === "cancelled") return "–";
  return "○";
}
