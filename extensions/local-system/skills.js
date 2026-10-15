/* global document, location, parent, requestAnimationFrame */

const threadId = new URLSearchParams(location.search).get("threadId") || "";
const panel = document.querySelector(".panel");
const results = document.getElementById("results");
const status = document.getElementById("status");
let skills = [];
let activeIndex = 0;
let requestSequence = 0;
let debounceTimer = null;
let currentQuery = null;

globalThis.addEventListener("message", (event) => {
  if (event.data?.source !== "local-system-palette-host") return;
  applyTheme(event.data.theme);
  if (event.data.action === "query") {
    const query = typeof event.data.query === "string" ? event.data.query : "";
    if (query === currentQuery) return;
    currentQuery = query;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadSkills(query), 55);
    return;
  }
  if (event.data.action === "navigate") {
    moveActive(Number(event.data.delta) || 0);
    return;
  }
  if (event.data.action === "busy") {
    const name = String(event.data.name || "skill");
    setStatus(`Attaching ${name}…`);
    return;
  }
  if (event.data.action === "error") {
    setStatus(String(event.data.message || "Could not attach skill."));
    return;
  }
  if (event.data.action === "select-active" && skills[activeIndex]) select(skills[activeIndex]);
});

async function loadSkills(query) {
  const sequence = ++requestSequence;
  if (!skills.length) setStatus("Searching skills…");
  try {
    const payload = await fetchSkills(query);
    if (sequence !== requestSequence) return;
    skills = Array.isArray(payload.skills) ? payload.skills : [];
    activeIndex = Math.min(activeIndex, Math.max(0, skills.length - 1));
    render();
  } catch {
    if (sequence !== requestSequence) return;
    skills = [];
    setStatus("Local System is unavailable.");
  }
}

async function fetchSkills(query) {
  const api = globalThis.LocalSystemExtensionApi;
  if (!api?.request) throw new Error("Local System extension API unavailable");
  return api.request("/local-ui/skills", { threadId, query, active: true }, { timeoutMs: 1_500 });
}

function render() {
  results.replaceChildren();
  status.classList.remove("visible");
  if (!skills.length) return setStatus("No matching skills");
  const fragment = document.createDocumentFragment();
  skills.forEach((skill, index) => {
    const row = document.createElement("div");
    row.className = `skill ls-ui-list-row${index === activeIndex ? " active" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = skill.name;
    const scope = document.createElement("div");
    scope.className = "scope";
    scope.textContent = skill.scope || "";
    const description = document.createElement("div");
    description.className = "description";
    description.textContent = skill.description || "";
    row.append(name, description, scope);
    row.addEventListener("mouseenter", () => setActive(index));
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => select(skill));
    fragment.appendChild(row);
  });
  results.appendChild(fragment);
  setActive(activeIndex);
  reportSize();
}

function setActive(index) {
  if (!skills.length) return;
  activeIndex = Math.max(0, Math.min(skills.length - 1, index));
  [...results.children].forEach((row, rowIndex) => {
    row.classList.toggle("active", rowIndex === activeIndex);
    row.setAttribute("aria-selected", rowIndex === activeIndex ? "true" : "false");
  });
  results.children[activeIndex]?.scrollIntoView({ block: "nearest" });
}

function moveActive(delta) {
  if (!skills.length || !delta) return;
  setActive((activeIndex + delta + skills.length) % skills.length);
}

function setStatus(message) {
  results.replaceChildren();
  status.textContent = message;
  status.classList.add("visible");
  reportSize();
}

function select(skill) {
  parent.postMessage({ source: "local-system-skills", action: "select", name: skill.name }, "*");
}

function applyTheme(theme) {
  globalThis.LocalSystemSharedRuntime?.applyTheme(theme, {
    aliases: true,
    composerTypography: true,
  });
}

function reportSize() {
  requestAnimationFrame(() => {
    parent.postMessage({
      source: "local-system-skills",
      action: "resize",
      height: Math.ceil(panel.getBoundingClientRect().height),
    }, "*");
  });
}
