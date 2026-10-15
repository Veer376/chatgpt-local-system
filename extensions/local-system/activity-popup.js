/* global chrome, document */

(() => {
  const app = document.getElementById("app");
  const DEFAULT_UI_VISIBILITY = Object.freeze({
    activeFile: true,
    projectContext: true,
    ...globalThis.LocalSystemSharedRuntime.DEFAULT_UI_VISIBILITY,
  });
  const state = {
    tabId: null,
    windowId: null,
    threadId: "",
    workspaceKey: "",
    ui: { ...DEFAULT_UI_VISIBILITY },
  };

  void init();

  async function init() {
    const [tabs, storedUi] = await Promise.all([
      chrome.tabs.query({ active: true, lastFocusedWindow: true }),
      globalThis.LocalSystemSharedRuntime.loadUiVisibility(chrome.storage.local, DEFAULT_UI_VISIBILITY),
    ]);
    const [tab] = tabs;
    state.tabId = Number.isInteger(tab?.id) ? tab.id : null;
    state.windowId = Number.isInteger(tab?.windowId) ? tab.windowId : null;
    state.threadId = threadIdFromUrl(tab?.url || "");
    state.workspaceKey = state.threadId || (state.tabId ? `browser-tab:${state.tabId}` : "");
    state.ui = storedUi;
    renderShell();
    wireUiSettings();
    wireWorkspaceButton();
    if (!state.workspaceKey) {
      renderWorkspaceEmpty("Open a browser tab to use its Local System workspace.");
      return;
    }
    await loadWorkspace();
  }

  function renderShell() {
    app.innerHTML = `
      <section class="ls-popup" aria-label="Local System">
        <header class="ls-popup__head">
          <div>
            <div class="ls-popup__title">Local System</div>
            <div class="ls-popup__subtitle">Workspace and UI</div>
          </div>
        </header>
        <div class="ls-popup__body">
          <section class="ls-popup__section">
            <div class="ls-popup__section-head">
              <span class="ls-popup__section-title">Workspace</span>
              <span class="ls-popup__section-meta" data-slot="workspace-binding"></span>
            </div>
            <div class="ls-popup-workspace-card" data-slot="workspace-card">
              <div class="ls-popup-workspace-card__loading">Loading workspace…</div>
            </div>
            <button type="button" class="ls-popup-workspace-button" data-action="standalone-workspace" ${state.workspaceKey ? "" : "disabled"}>
              <span>Open workspace</span>
              <span class="ls-popup-workspace-button__hint">⌘⇧L</span>
            </button>
            <div class="ls-popup-workspace-status" data-slot="standalone-workspace-status" aria-live="polite"></div>
          </section>

          <section class="ls-popup__section">
            <div class="ls-popup__section-head">
              <span class="ls-popup__section-title">UI controls</span>
              <span class="ls-popup__section-meta">Saved globally</span>
            </div>
            <div class="ls-popup-settings__list">
              ${uiSetting("activeFile", "Current file pill")}
              ${uiSetting("projectContext", "Project + Git pills")}
              ${uiSetting("skills", "Skill pills")}
              ${uiSetting("todos", "Todos")}
              ${uiSetting("workspace", "Embedded workspace")}
              ${uiSetting("annotations", "Annotations")}
            </div>
          </section>
        </div>
      </section>
    `;
  }

  async function loadWorkspace() {
    try {
      const [context, workspacePayload] = await Promise.all([
        request("/local-ui/file-workspace", {
          threadId: state.workspaceKey,
          action: "context",
          active: false,
        }),
        request("/local-ui/file-workspace", {
          threadId: state.workspaceKey,
          action: "get",
          active: false,
        }),
      ]);
      renderWorkspace({
        ...workspacePayload,
        bound: context?.bound === true,
        currentWorkspace: context?.currentWorkspace || workspacePayload?.currentWorkspace || "",
      });
    } catch (error) {
      renderWorkspaceEmpty(error instanceof Error ? error.message : String(error), true);
    }
  }

  function renderWorkspace(payload) {
    const card = app.querySelector('[data-slot="workspace-card"]');
    const binding = app.querySelector('[data-slot="workspace-binding"]');
    if (!card) return;
    const projectPath = String(payload?.currentWorkspace || "");
    const workspace = payload?.workspace && typeof payload.workspace === "object" ? payload.workspace : {};
    const activePath = String(workspace.activePath || "");
    const openPaths = Array.isArray(workspace.openPaths) ? workspace.openPaths : [];
    if (binding) binding.textContent = payload?.bound === true ? "Bound" : "Local";
    card.innerHTML = `
      <div class="ls-popup-workspace-card__project">${escapeHtml(projectPath ? basename(projectPath) : "No project selected")}</div>
      <div class="ls-popup-workspace-card__path">${escapeHtml(projectPath || "Select a project from the workspace.")}</div>
      <div class="ls-popup-workspace-card__row">
        <span>Active file</span>
        <strong title="${escapeHtml(activePath)}">${escapeHtml(activePath ? basename(activePath) : "None")}</strong>
      </div>
      <div class="ls-popup-workspace-card__row">
        <span>Open files</span>
        <strong>${openPaths.length}</strong>
      </div>
    `;
  }

  function renderWorkspaceEmpty(message, isError = false) {
    const card = app.querySelector('[data-slot="workspace-card"]');
    if (!card) return;
    card.innerHTML = `<div class="${isError ? "ls-popup-workspace-card__error" : "ls-popup-workspace-card__empty"}">${escapeHtml(message)}</div>`;
  }

  function uiSetting(key, label) {
    const checked = state.ui[key] === false ? "" : " checked";
    return '<label class="ls-popup-setting"><span>'
      + escapeHtml(label)
      + '</span><input type="checkbox" data-ui-setting="'
      + key
      + '"'
      + checked
      + '><span class="ls-popup-setting__switch" aria-hidden="true"></span></label>';
  }

  function wireUiSettings() {
    for (const input of app.querySelectorAll("[data-ui-setting]")) {
      input.addEventListener("change", async () => {
        const key = input.dataset.uiSetting;
        if (!(key in DEFAULT_UI_VISIBILITY)) return;
        state.ui = { ...state.ui, [key]: input.checked };
        state.ui = await globalThis.LocalSystemSharedRuntime.saveUiVisibility(
          state.ui,
          chrome.storage.local,
          DEFAULT_UI_VISIBILITY,
        );
      });
    }
  }

  function wireWorkspaceButton() {
    app.querySelector('[data-action="standalone-workspace"]')?.addEventListener("click", async () => {
      const button = app.querySelector('[data-action="standalone-workspace"]');
      if (!button || !state.tabId || !state.workspaceKey) return;
      button.disabled = true;
      setWorkspaceStatus("Opening…");
      try {
        if (chrome.sidePanel?.open && Number.isInteger(state.windowId)) {
          await chrome.sidePanel.open({ windowId: state.windowId });
          setWorkspaceStatus("Workspace opened.");
          globalThis.setTimeout(() => globalThis.close(), 120);
          return;
        }
        const response = await chrome.tabs.sendMessage(state.tabId, {
          source: "local-system-extension-command",
          action: "toggle-standalone-workspace",
        });
        if (response?.ok) {
          setWorkspaceStatus(response.open === false ? "Workspace closed." : "Workspace opened.");
          if (response.open !== false) globalThis.setTimeout(() => globalThis.close(), 120);
        } else if (response?.reason === "no-thread") {
          setWorkspaceStatus("This page does not expose a fallback workspace yet.");
        } else {
          setWorkspaceStatus("Could not open workspace.");
        }
      } catch {
        setWorkspaceStatus("Refresh the ChatGPT tab, then try again.");
      } finally {
        button.disabled = !state.workspaceKey;
      }
    });
  }

  function setWorkspaceStatus(message) {
    const node = app.querySelector('[data-slot="standalone-workspace-status"]');
    if (node) node.textContent = String(message || "");
  }

  async function request(path, body) {
    const response = await chrome.runtime.sendMessage({
      source: "local-system-popup",
      action: "api-request",
      path,
      body,
    });
    if (!response?.ok) throw new Error(response?.error || "Local System unavailable");
    return response.payload || {};
  }

  function threadIdFromUrl(value) {
    return globalThis.LocalSystemThreadRoute?.threadIdFromUrl(value) || "";
  }

  function basename(value) {
    return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
