/* global chrome, document, requestAnimationFrame, ResizeObserver */

(() => {
  const elements = {
    frame: document.getElementById("workspace-frame"),
    empty: document.getElementById("workspace-empty"),
    emptySkeleton: document.getElementById("workspace-skeleton"),
    emptyCard: document.getElementById("workspace-empty-card"),
    emptyTitle: document.getElementById("workspace-empty-title"),
    emptyCopy: document.getElementById("workspace-empty-copy"),
    chooseProject: document.getElementById("choose-project"),
    retryConnection: document.getElementById("retry-connection"),
    projectPicker: document.getElementById("project-picker"),
    projectList: document.getElementById("project-list"),
    projectSearch: document.getElementById("project-search"),
    projectIncludeHidden: document.getElementById("project-include-hidden"),
    closeProjectPicker: document.getElementById("close-project-picker"),
    quickHost: document.getElementById("quick-open-host"),
    quickFrame: document.getElementById("quick-open-frame"),
  };
  const state = {
    tabId: null,
    windowId: null,
    workspaceKey: "",
    workspaceReady: false,
    workspaceFrameProject: "",
    currentWorkspace: "",
    contextSequence: 0,
    connectionState: "loading",
    filesOpenedForKey: "",
    provisionalWorkspace: "",
    attemptedNewThreadKey: "",
    projectChoices: [],
    projectActiveIndex: 0,
    projectIncludeHidden: false,
    projectLoadSequence: 0,
    pendingOpenFile: null,
    theme: null,
  };

  void refreshActiveTab();

  chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== state.tabId || (!changeInfo.url && changeInfo.status !== "complete")) return;
    void refreshActiveTab(tab);
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (
      message?.source === "local-system-content"
      && message.action === "theme-changed"
      && Number(sender?.tab?.id) === state.tabId
    ) {
      applyProviderTheme(message.theme);
      return;
    }
    if (message?.source !== "local-system-background" || message.action !== "workspace-state-changed") return;
    if (Number(message.tabId) !== state.tabId || String(message.threadId || "") !== state.workspaceKey) return;
    void traceWorkspace("side-panel.workspace-state-message", {
      path: message.file?.path || null,
      data: { workspaceReady: state.workspaceReady, hasFile: Boolean(message.file?.path) },
    });
    if (message.file?.path) state.pendingOpenFile = { ...message.file };
    if (state.workspaceReady) {
      postWorkspace({ action: "project-changed", openFiles: false });
      flushPendingOpenFile();
    }
  });
  globalThis.addEventListener("message", handleFrameMessage);
  elements.chooseProject.addEventListener("click", () => void openProjectPicker());
  elements.retryConnection.addEventListener("click", () => void refreshProjectContext({ showLoading: true }));
  elements.closeProjectPicker.addEventListener("click", closeProjectPicker);
  elements.projectPicker.querySelector(".picker-backdrop")?.addEventListener("pointerdown", closeProjectPicker);
  elements.projectSearch.addEventListener("input", () => {
    state.projectActiveIndex = 0;
    renderProjectChoices();
  });
  elements.projectSearch.addEventListener("keydown", handleProjectSearchKeydown);
  elements.projectIncludeHidden.addEventListener("change", () => {
    state.projectIncludeHidden = elements.projectIncludeHidden.checked === true;
    state.projectActiveIndex = 0;
    void loadProjectChoices();
  });
  elements.quickHost.querySelector(".picker-backdrop")?.addEventListener("pointerdown", () => closeQuickOpen({ restoreFocus: true }));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!elements.quickHost.hidden) closeQuickOpen({ restoreFocus: true });
    else if (!elements.projectPicker.hidden) closeProjectPicker();
  });
  const resizeObserver = new ResizeObserver(() => sendHostLayout());
  resizeObserver.observe(document.documentElement);

  async function refreshActiveTab(existingTab = null) {
    let tab = existingTab;
    if (!tab || tab.active !== true) {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (!tab?.id) return;
    const provider = globalThis.LocalSystemThreadRoute?.providerFromUrl(tab?.url || "") || "";
    if (!provider) {
      state.tabId = tab.id;
      state.windowId = Number.isInteger(tab.windowId) ? tab.windowId : null;
      state.workspaceKey = "";
      state.currentWorkspace = "";
      state.workspaceReady = false;
      state.workspaceFrameProject = "";
      state.filesOpenedForKey = "";
      clearProviderTheme();
      elements.frame.removeAttribute("src");
      closeQuickOpen();
      closeProjectPicker();
      showWorkspaceGate("unsupported");
      return;
    }
    const workspaceKey = workspaceKeyForTab(tab);
    const previousKey = state.workspaceKey;
    const previousWorkspace = state.currentWorkspace;
    const changed = workspaceKey !== state.workspaceKey;
    state.tabId = tab.id;
    state.windowId = Number.isInteger(tab.windowId) ? tab.windowId : null;
    state.workspaceKey = workspaceKey;
    void refreshProviderTheme(tab.id);
    const provisionalNewThread = workspaceKey.startsWith("browser-tab:");
    if (changed && provisionalNewThread) state.attemptedNewThreadKey = "";
    if (
      provisionalNewThread
      && state.attemptedNewThreadKey === workspaceKey
      && state.connectionState === "unsupported"
    ) return;
    if (changed || !elements.frame.src) {
      if (
        previousKey.startsWith("browser-tab:")
        && !workspaceKey.startsWith("browser-tab:")
        && previousWorkspace
      ) {
        state.provisionalWorkspace = previousWorkspace;
      }
      state.currentWorkspace = "";
      state.workspaceReady = false;
      state.workspaceFrameProject = "";
      state.filesOpenedForKey = "";
      state.pendingOpenFile = null;
      showWorkspaceGate("loading");
      elements.frame.src = chrome.runtime.getURL("file-workspace.html")
        + "?threadId=" + encodeURIComponent(workspaceKey)
        + "&presentation=standalone&host=sidepanel&mobile=0";
      closeQuickOpen();
      closeProjectPicker();
    }
    const initialNewThreadResolution = provisionalNewThread
      && state.attemptedNewThreadKey !== workspaceKey;
    if (initialNewThreadResolution) state.attemptedNewThreadKey = workspaceKey;
    await refreshProjectContext({
      showLoading: changed,
      initialNewThreadResolution,
    });
  }

  async function refreshProjectContext({
    showLoading = false,
    initialNewThreadResolution = false,
  } = {}) {
    if (!state.workspaceKey) return;
    const sequence = ++state.contextSequence;
    if (showLoading || state.connectionState === "error") showWorkspaceGate("loading");
    try {
      let payload = await apiRequest("/local-ui/file-workspace", {
        threadId: state.workspaceKey,
        action: "context",
        active: true,
      });
      if (sequence !== state.contextSequence) return;
      state.currentWorkspace = String(payload?.currentWorkspace || "");
      if (!state.currentWorkspace && state.provisionalWorkspace && !state.workspaceKey.startsWith("browser-tab:")) {
        payload = await apiRequest("/local-ui/file-workspace", {
          threadId: state.workspaceKey,
          action: "select_project",
          path: state.provisionalWorkspace,
          active: true,
        });
        if (sequence !== state.contextSequence) return;
        state.currentWorkspace = String(payload?.currentWorkspace || state.provisionalWorkspace);
      }
      if (state.currentWorkspace) state.provisionalWorkspace = "";
      state.connectionState = "ready";
      if (state.workspaceReady) {
        if (state.currentWorkspace) {
          elements.empty.hidden = true;
          if (state.currentWorkspace !== state.workspaceFrameProject) syncWorkspaceProject({ openFiles: false });
        } else {
          showWorkspaceGate("no-project");
        }
      }
    } catch (error) {
      if (sequence !== state.contextSequence) return;
      state.currentWorkspace = "";
      if (initialNewThreadResolution) {
        showWorkspaceGate("unsupported");
        return;
      }
      state.connectionState = "error";
      showWorkspaceGate("error", {
        copy: "Local System is temporarily unavailable. " + connectionErrorMessage(error),
      });
    }
  }

  async function openProjectPicker() {
    if (!state.workspaceKey) return;
    elements.projectPicker.hidden = false;
    elements.projectSearch.value = "";
    elements.projectIncludeHidden.checked = state.projectIncludeHidden;
    state.projectChoices = [];
    state.projectActiveIndex = 0;
    elements.projectList.innerHTML = '<div class="project-message">Loading projects…</div>';
    globalThis.requestAnimationFrame(() => elements.projectSearch.focus());
    await loadProjectChoices();
  }

  async function loadProjectChoices() {
    const sequence = ++state.projectLoadSequence;
    elements.projectList.innerHTML = '<div class="project-message">Loading projects…</div>';
    try {
      const payload = await apiRequest("/local-ui/file-workspace", {
        threadId: state.workspaceKey,
        action: "projects",
        includeHidden: state.projectIncludeHidden,
        active: true,
      });
      if (sequence !== state.projectLoadSequence) return;
      state.projectChoices = Array.isArray(payload?.projects) ? payload.projects : [];
      renderProjectChoices();
    } catch (error) {
      if (sequence !== state.projectLoadSequence) return;
      state.projectChoices = [];
      elements.projectList.innerHTML = '<div class="project-message"></div>';
      elements.projectList.firstElementChild.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  function filteredProjectChoices() {
    const query = elements.projectSearch.value.trim().toLowerCase();
    return state.projectChoices.filter((project) => {
      if (!query) return true;
      return `${project?.name || ""}\n${project?.path || ""}`.toLowerCase().includes(query);
    });
  }

  function renderProjectChoices() {
    const projects = filteredProjectChoices();
    elements.projectList.replaceChildren();
    if (!projects.length) {
      elements.projectList.innerHTML = `<div class="project-message">${state.projectChoices.length ? "No matching projects." : "No Local System projects were found."}</div>`;
      return;
    }
    state.projectActiveIndex = Math.max(0, Math.min(state.projectActiveIndex, projects.length - 1));
    projects.forEach((project, index) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `project-row ls-ui-list-row${index === state.projectActiveIndex ? " active" : ""}`;
        row.setAttribute("aria-selected", index === state.projectActiveIndex ? "true" : "false");
        row.innerHTML = '<span class="project-row__name"></span><span class="project-row__path"></span>';
        row.querySelector(".project-row__name").textContent = String(project?.name || basename(project?.path) || "Project");
        row.querySelector(".project-row__path").textContent = String(project?.path || "");
        row.addEventListener("pointermove", () => setProjectActiveIndex(index));
        row.addEventListener("focus", () => setProjectActiveIndex(index));
        row.addEventListener("click", () => void selectProject(project?.path));
        elements.projectList.append(row);
    });
  }

  function setProjectActiveIndex(index) {
    const projects = filteredProjectChoices();
    if (!projects.length) return;
    state.projectActiveIndex = Math.max(0, Math.min(Number(index) || 0, projects.length - 1));
    [...elements.projectList.querySelectorAll(".project-row")].forEach((row, rowIndex) => {
      const active = rowIndex === state.projectActiveIndex;
      row.classList.toggle("active", active);
      row.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function handleProjectSearchKeydown(event) {
    const projects = filteredProjectChoices();
    if (!projects.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setProjectActiveIndex((state.projectActiveIndex + delta + projects.length) % projects.length);
      elements.projectList.querySelectorAll(".project-row")[state.projectActiveIndex]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      const project = projects[state.projectActiveIndex];
      if (project?.path) void selectProject(project.path);
    }
  }

  async function selectProject(path) {
    const selected = String(path || "").trim();
    if (!selected || !state.workspaceKey) return;
    try {
      const payload = await apiRequest("/local-ui/file-workspace", {
        threadId: state.workspaceKey,
        action: "select_project",
        path: selected,
        active: true,
      });
      state.currentWorkspace = String(payload?.currentWorkspace || selected);
      state.connectionState = "ready";
      elements.empty.hidden = true;
      closeProjectPicker();
      syncWorkspaceProject({ openFiles: true, forceFiles: true });
      if (Number.isInteger(state.tabId)) {
        try {
          await chrome.tabs.sendMessage(state.tabId, {
            source: "local-system-extension-command",
            action: "workspace-state-changed",
          });
        } catch {
          // The provider tab may still be loading; its next context read will catch up.
        }
      }
    } catch (error) {
      elements.projectList.innerHTML = '<div class="project-message"></div>';
      elements.projectList.firstElementChild.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  function openQuickOpen(mode, query) {
    if (!state.workspaceKey) return;
    const url = chrome.runtime.getURL("file-quick-open.html")
      + "?threadId=" + encodeURIComponent(state.workspaceKey)
      + "&mode=" + encodeURIComponent(mode === "text" ? "text" : "files")
      + "&query=" + encodeURIComponent(String(query || "").slice(0, 300));
    elements.quickFrame.src = url;
    elements.quickFrame.style.height = "180px";
    elements.quickHost.hidden = false;
  }

  function closeQuickOpen({ restoreFocus = false } = {}) {
    elements.quickHost.hidden = true;
    elements.quickFrame.removeAttribute("src");
    if (restoreFocus) requestAnimationFrame(restoreWorkspaceFocus);
  }

  function restoreWorkspaceFocus() {
    if (!elements.frame?.contentWindow) return;
    elements.frame.focus({ preventScroll: true });
    postWorkspace({ action: "restore-focus" });
  }

  function closeProjectPicker() {
    elements.projectPicker.hidden = true;
    state.projectChoices = [];
  }

  function flushPendingOpenFile() {
    if (!state.workspaceReady || !state.pendingOpenFile?.path) return;
    const file = state.pendingOpenFile;
    state.pendingOpenFile = null;
    void traceWorkspace("side-panel.open-file.post", {
      path: file.path,
      data: { line: file.line, column: file.column, length: file.length },
    });
    postWorkspace({
      action: "open-file",
      path: file.path,
      line: file.line,
      column: file.column,
      length: file.length,
      restoreFocus: file.restoreFocus === true,
    });
  }

  function handleFrameMessage(event) {
    if (event.source === elements.frame.contentWindow && event.data?.source === "local-system-file-workspace") {
      handleWorkspaceMessage(event.data);
      return;
    }
    if (event.source === elements.quickFrame.contentWindow && event.data?.source === "local-system-file-quick-open") {
      if (event.data.action === "ready") {
        elements.quickFrame.contentWindow.postMessage({
          source: "local-system-host",
          active: document.visibilityState === "visible",
          theme: state.theme,
        }, "*");
      } else if (event.data.action === "resize") {
        const height = Math.max(110, Math.min(520, Number(event.data.height) || 180));
        elements.quickFrame.style.height = `${height}px`;
      } else if (event.data.action === "open-file" && typeof event.data.path === "string") {
        postWorkspace({
          action: "open-file",
          path: event.data.path,
          line: event.data.line,
          column: event.data.column,
          length: event.data.length,
          restoreFocus: true,
        });
        closeQuickOpen({ restoreFocus: true });
      } else if (event.data.action === "close") {
        closeQuickOpen({ restoreFocus: true });
      }
    }
  }

  function handleWorkspaceMessage(message) {
    if (message.action === "ready") {
      state.workspaceReady = true;
      state.workspaceFrameProject = String(message.currentWorkspace || "");
      if (!state.currentWorkspace && state.workspaceFrameProject) state.currentWorkspace = state.workspaceFrameProject;
      void traceWorkspace("side-panel.workspace-ready", { data: { currentWorkspace: state.currentWorkspace } });
      if (state.currentWorkspace) {
        elements.empty.hidden = true;
        if (state.currentWorkspace !== state.workspaceFrameProject) syncWorkspaceProject({ openFiles: false });
      } else if (state.connectionState === "ready") {
        showWorkspaceGate("no-project");
      }
      sendHostLayout();
      postWorkspace({ active: true });
      postWorkspace({ action: "reveal-workspace" });
      flushPendingOpenFile();
      return;
    }
    if (message.action === "visibility" && message.visible === false) {
      // A missing project or a workspace preference must never make Chrome
      // destroy the native side panel. The browser owns panel lifetime; the
      // extension renders loading/no-project state in-place instead.
      return;
    }
    if (message.action === "close-sidebar") {
      void closeNativeSidePanel();
      return;
    }
    if (message.action === "project-picker") {
      void openProjectPicker();
      return;
    }
    if (message.action === "quick-open") {
      openQuickOpen(message.mode, message.query);
      return;
    }
    if (message.action === "toggle-left-sidebar") {
      postWorkspace({ action: "toggle-project-pane" });
      return;
    }
    if (message.action === "resize" || message.action === "resize-start" || message.action === "resize-end") {
      // Chrome owns the outer side-panel sash. Ignore iframe attempts to resize it.
      return;
    }
  }

  function sendHostLayout() {
    if (!state.workspaceReady) return;
    postWorkspace({
      action: "host-layout",
      width: Math.max(1, Math.round(globalThis.innerWidth || document.documentElement.clientWidth || 1)),
      mobile: false,
      active: document.visibilityState === "visible",
      theme: state.theme,
    });
  }

  function postWorkspace(payload) {
    if (!elements.frame.contentWindow) return;
    elements.frame.contentWindow.postMessage({
      source: "local-system-host",
      theme: state.theme,
      ...payload,
    }, "*");
  }

  async function refreshProviderTheme(tabId = state.tabId) {
    if (!Number.isInteger(tabId)) return;
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        source: "local-system-extension-command",
        action: "read-theme",
      });
      if (tabId !== state.tabId) return;
      applyProviderTheme(response?.theme);
    } catch {
      // The page content script may still be loading. Its theme-changed event
      // will synchronize the panel as soon as it becomes available.
    }
  }

  function applyProviderTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    state.theme = theme;
    globalThis.LocalSystemSharedRuntime?.applyTheme(theme);
    if (state.workspaceReady) sendHostLayout();
    if (!elements.quickHost.hidden && elements.quickFrame.contentWindow) {
      elements.quickFrame.contentWindow.postMessage({
        source: "local-system-host",
        active: document.visibilityState === "visible",
        theme: state.theme,
      }, "*");
    }
  }

  function clearProviderTheme() {
    state.theme = null;
    globalThis.LocalSystemSharedRuntime?.clearTheme();
  }

  async function closeNativeSidePanel() {
    try {
      if (chrome.sidePanel?.close && Number.isInteger(state.windowId)) {
        await chrome.sidePanel.close({ windowId: state.windowId });
      }
    } catch {
      // The browser still exposes its native close control.
    }
  }

  async function apiRequest(path, body) {
    const response = await chrome.runtime.sendMessage({
      source: "local-system-popup",
      action: "api-request",
      path,
      body,
    });
    if (!response?.ok) throw new Error(response?.error || "Local System unavailable");
    return response.payload || {};
  }

  async function traceWorkspace(stage, { path = null, data = null } = {}) {
    if (!state.workspaceKey) return;
    try {
      await apiRequest("/local-ui/workspace-trace", {
        action: "record",
        event: { stage, threadId: state.workspaceKey, path, data },
      });
    } catch {
      // Diagnostics must never affect the side panel.
    }
  }

  function syncWorkspaceProject({ openFiles = false, forceFiles = false } = {}) {
    if (!state.workspaceReady || !state.currentWorkspace) return;
    const shouldOpenFiles = openFiles && (forceFiles || state.filesOpenedForKey !== state.workspaceKey);
    if (shouldOpenFiles) state.filesOpenedForKey = state.workspaceKey;
    postWorkspace({
      action: "project-changed",
      openFiles: shouldOpenFiles,
    });
  }

  function showWorkspaceGate(mode, { copy = "" } = {}) {
    const presets = {
      loading: { title: "", copy: "", choose: false, retry: false },
      "no-project": {
        title: "No project selected",
        copy: "Choose a Local System project for this thread.",
        choose: true,
        retry: false,
      },
      unsupported: {
        title: "This website doesn’t support Local System.",
        copy: "Local System could not resolve this new thread.",
        choose: false,
        retry: false,
      },
      error: {
        title: "Local System unavailable",
        copy: "The local bridge could not be reached. Retry when you want to try again.",
        choose: false,
        retry: true,
      },
    };
    const preset = presets[mode] || presets.loading;
    state.connectionState = mode === "no-project" ? "ready" : mode;
    elements.empty.hidden = false;
    const loading = mode === "loading";
    elements.empty.classList.toggle("loading", loading);
    elements.emptySkeleton.hidden = !loading;
    elements.emptyCard.hidden = loading;
    elements.emptyTitle.textContent = preset.title;
    elements.emptyCopy.textContent = copy || preset.copy;
    elements.chooseProject.hidden = !preset.choose;
    elements.retryConnection.hidden = !preset.retry;
  }

  function connectionErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (!message || /failed to fetch|network|timeout|timed out|unavailable/i.test(message)) {
      return "Start Local System, then use Retry.";
    }
    return message;
  }

  function workspaceKeyForTab(tab) {
    const threadId = threadIdFromUrl(tab?.url || "");
    if (threadId) return threadId;
    return "browser-tab:" + String(tab?.id || "unknown");
  }

  function threadIdFromUrl(value) {
    return globalThis.LocalSystemThreadRoute?.threadIdFromUrl(value) || "";
  }

  function basename(value) {
    return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
  }
})();
