/* global document, window */

(() => {
  "use strict";

  const state = {
    counter: 0,
    notes: [],
    events: 0,
    filter: "all",
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const activitySeed = Array.from({ length: 36 }, (_, index) => {
    const statuses = ["pass", "info", "pass", "warn", "pass", "info"];
    const status = statuses[index % statuses.length];
    const actions = [
      "relative stylesheet resolved",
      "sandboxed script executed",
      "nested scroll retained focus",
      "native control accepted input",
      "DOM mutation rendered",
      "local SVG asset decoded",
    ];
    return {
      id: index + 1,
      status,
      message: actions[index % actions.length],
      time: `${String(9 + Math.floor(index / 6)).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}`,
    };
  });

  function updateClock() {
    $("#clock").textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function updateViewport() {
    $("#viewport-label").textContent = `${window.innerWidth} × ${window.innerHeight}`;
  }

  function renderCounter(message = "Counter state updated by JavaScript.") {
    $("#counter-value").textContent = String(state.counter);
    $("#counter-message").textContent = message;
  }

  function renderNotes() {
    const list = $("#note-list");
    $("#note-count").textContent = String(state.notes.length);
    list.replaceChildren();

    if (!state.notes.length) {
      const empty = document.createElement("li");
      empty.className = "empty-note";
      empty.textContent = "No notes yet.";
      list.append(empty);
      return;
    }

    state.notes.forEach((note) => {
      const item = document.createElement("li");
      item.textContent = note.text;
      const time = document.createElement("time");
      time.dateTime = note.iso;
      time.textContent = note.label;
      item.append(time);
      list.append(item);
    });
  }

  function addNote() {
    const input = $("#note-input");
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    const now = new Date();
    state.notes.unshift({
      text,
      iso: now.toISOString(),
      label: `Added ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
    });
    input.value = "";
    $("#character-count").textContent = "0 characters";
    renderNotes();
    input.focus();
  }

  function renderActivity() {
    const feed = $("#activity-feed");
    const rows = activitySeed.filter((item) => state.filter === "all" || item.status === state.filter);
    feed.replaceChildren();

    rows.forEach((item) => {
      const row = document.createElement("article");
      row.className = "activity-row";
      row.dataset.status = item.status;
      row.innerHTML = `
        <span class="activity-index">#${String(item.id).padStart(2, "0")}</span>
        <span class="activity-status ${item.status}">${item.status}</span>
        <code>${item.message}</code>
        <time>${item.time}</time>
      `;
      feed.append(row);
    });
  }

  function setFilter(filter) {
    state.filter = filter;
    $$(".chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.filter === filter));
    renderActivity();
  }

  function updateSlider() {
    const value = Number($("#load-slider").value);
    $("#progress-fill").style.width = `${value}%`;
    $("#slider-value").textContent = `${value}%`;
  }

  function setTab(tab) {
    const copy = {
      dom: "DOM tab: this text was selected by data attributes and replaced without a page navigation.",
      events: "Events tab: buttons, input, submit, resize, range, and keyboard listeners are all active.",
      sandbox: "Sandbox tab: this fixture expects script execution but no access to the Local System parent DOM.",
    };
    $$(".tab").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    $("#tab-panel").textContent = copy[tab];
  }

  function resetState() {
    state.counter = 0;
    state.notes = [];
    state.events = 0;
    state.filter = "all";
    $("#event-count").textContent = "0";
    $("#load-slider").value = "42";
    $("#note-input").value = "";
    $("#character-count").textContent = "0 characters";
    renderCounter("Regression state reset.");
    renderNotes();
    updateSlider();
    setFilter("all");
    setTab("dom");
  }

  $("#increment").addEventListener("click", () => {
    state.counter += 1;
    renderCounter("Increment button executed successfully.");
  });

  $("#decrement").addEventListener("click", () => {
    state.counter -= 1;
    renderCounter("Decrement button executed successfully.");
  });

  $("#burst").addEventListener("click", () => {
    state.counter += 10;
    renderCounter("Burst action added ten in one event.");
  });

  $("#theme-toggle").addEventListener("click", () => {
    document.body.classList.toggle("high-contrast");
  });

  $("#load-slider").addEventListener("input", updateSlider);
  $("#reset-state").addEventListener("click", resetState);
  $("#add-note").addEventListener("click", addNote);
  $("#clear-notes").addEventListener("click", () => {
    state.notes = [];
    renderNotes();
  });

  $("#note-input").addEventListener("input", (event) => {
    const length = event.currentTarget.value.length;
    $("#character-count").textContent = `${length} character${length === 1 ? "" : "s"}`;
  });

  $("#note-input").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      addNote();
    }
  });

  $$(".tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
  $$(".chip").forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));

  $("#capture-form").addEventListener("click", () => {
    const data = new FormData($("#profile-form"));
    state.events += 1;
    $("#event-count").textContent = String(state.events);
    $("#form-output").textContent = `Captured “${data.get("displayName") || "Anonymous"}” · ${data.get("scenario")}`;
  });

  window.addEventListener("resize", updateViewport);
  window.setInterval(updateClock, 1000);

  const today = new Date();
  $("#regression-date").value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  updateClock();
  updateViewport();
  updateSlider();
  renderActivity();
  renderNotes();
  setTab("dom");

  $("#runtime-status").textContent = "JavaScript ready";
  $("#runtime-status").classList.add("ready");
  $("#ready-marker").textContent = "Regression fixture ready";
  $("#ready-marker").classList.add("ready");

  window.__htmlPreviewRegression = {
    ready: true,
    version: "1.0",
    getState: () => ({ ...state, notes: [...state.notes] }),
  };
})();
