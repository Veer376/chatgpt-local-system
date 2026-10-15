/* global CSS, Element, Highlight, LocalHighlighter, NodeFilter, chrome, document, location, parent, requestAnimationFrame */

const UI_VISIBILITY_STORAGE_KEY = globalThis.LocalSystemSharedRuntime.UI_VISIBILITY_STORAGE_KEY;
const DEFAULT_UI_VISIBILITY = globalThis.LocalSystemSharedRuntime.DEFAULT_UI_VISIBILITY;
const pageParams = new URLSearchParams(location.search);
const threadId = pageParams.get("threadId") || "";
const PRESENTATION = pageParams.get("presentation") === "standalone" ? "standalone" : "embedded";
const HOST_MODE = pageParams.get("host") === "sidepanel" ? "sidepanel" : "page";
const LOCAL_FILE_DRAG_MIME = "application/x-local-system-file";
let mobileStandalone = pageParams.get("mobile") === "1";
document.documentElement.dataset.presentation = PRESENTATION;
document.documentElement.dataset.host = HOST_MODE;
document.documentElement.dataset.mobileStandalone = mobileStandalone ? "true" : "false";
const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_HIGHLIGHT_CHARS = 900_000;
const MAX_LIVE_HIGHLIGHT_CHARS = 300_000;
const DEFAULT_CODE_LINE_HEIGHT = 22.5;
const TREE_RESTORE_OPEN_ANIMATION_MS = 150;
const WORKSPACE_CONTENT_SCALE = 0.94;
const AUTO_SAVE_DELAY_MS = 700;
const EDITOR_PREFERENCES_STORAGE_KEY = "localSystemEditorPreferencesV1";
const COMPLETION_SOUND_ENABLED_STORAGE_KEY = "localSystemCompletionSoundEnabledV1";
const DEFAULT_EDITOR_PREFERENCES = Object.freeze({
  autoSave: false,
});
const HIGHLIGHT_NAME = "local-file-annotations";
const FILE_FIND_ALL_HIGHLIGHT = "local-file-find-all";
const FILE_FIND_CURRENT_HIGHLIGHT = "local-file-find-current";
const TEXT_EXTENSIONS = new Set([
  "txt","md","markdown","mdx","json","jsonl","csv","tsv","js","mjs","cjs","jsx","ts","tsx","html","htm","css","scss","less","xml","svg","yaml","yml","py","pyw","sh","zsh","bash","sql","java","cs","c","h","cc","cpp","cxx","hpp","go","rs","kt","kts","swift","rb","php","ini","toml","conf","env","dockerfile","gitignore","properties","gradle","vue","svelte",
]);
const TEXT_DOTFILES = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".npmrc",
  ".yarnrc",
  ".prettierrc",
  ".eslintrc",
  ".editorconfig",
  ".dockerignore",
]);
const DEFAULT_WRAP_EXTENSIONS = new Set([
  "txt","md","markdown","mdx","rst","adoc","asciidoc","log","csv","tsv",
]);

const elements = {
  workspace: document.getElementById("workspace"),
  workspaceToolbar: document.getElementById("workspace-toolbar"),
  workspaceColumns: document.getElementById("workspace-columns"),
  resizeHandle: document.getElementById("resize-handle"),
  projectName: document.getElementById("project-name"),
  treePane: document.getElementById("tree-pane"),
  treeToggle: document.getElementById("tree-pane-toggle"),
  treeBody: document.getElementById("tree-body"),
  treeMessage: document.getElementById("project-tree-message"),
  projectTree: document.getElementById("project-tree"),
  gitChangesSection: document.getElementById("git-changes-section"),
  gitChangesToggle: document.getElementById("git-changes-toggle"),
  gitChangesCount: document.getElementById("git-changes-count"),
  gitBranch: document.getElementById("git-branch"),
  gitChangesBody: document.getElementById("git-changes-body"),
  leftFilesPanel: document.getElementById("left-files-panel"),
  leftGitPanel: document.getElementById("left-git-panel"),
  leftSearchPanel: document.getElementById("left-search-panel"),
  leftModeFiles: document.getElementById("left-mode-files"),
  leftModeGit: document.getElementById("left-mode-git"),
  leftGitBadge: document.getElementById("left-git-badge"),
  filesSearchInput: document.getElementById("files-search-input"),
  filesSearchResults: document.getElementById("files-search-results"),
  filesSearchStatus: document.getElementById("files-search-status"),
  filesSearchList: document.getElementById("files-search-list"),
  workspaceSearchInput: document.getElementById("workspace-search-input"),
  workspaceSearchStatus: document.getElementById("workspace-search-status"),
  workspaceSearchResults: document.getElementById("workspace-search-results"),
  paneSplitter: document.getElementById("pane-splitter"),
  editorPane: document.getElementById("editor-pane"),
  editorBody: document.getElementById("editor-body"),
  tabs: document.getElementById("tabs"),
  fullTextSearch: document.getElementById("full-text-search"),
  projectEdit: document.getElementById("project-edit"),
  uiSettingsToggle: document.getElementById("ui-settings-toggle"),
  uiSettingsPopover: document.getElementById("ui-settings-popover"),
  autoSaveSetting: document.getElementById("auto-save-setting"),
  completionSoundSetting: document.getElementById("completion-sound-setting"),
  checkpointInjectionSetting: document.getElementById("checkpoint-injection-setting"),
  checkpointMinutesSetting: document.getElementById("checkpoint-minutes-setting"),
  sidePanelSiteSettings: document.getElementById("side-panel-site-settings"),
  currentSiteName: document.getElementById("current-site-name"),
  hideCurrentSite: document.getElementById("hide-current-site"),
  hiddenSitesList: document.getElementById("hidden-sites-list"),
  hiddenSitesEmpty: document.getElementById("hidden-sites-empty"),
  closeSidebar: document.getElementById("close-sidebar"),
  fileActionBar: document.getElementById("file-action-bar"),
  editStatus: document.getElementById("file-edit-status"),
  cancelFileEdit: document.getElementById("cancel-file-edit"),
  saveFileEdit: document.getElementById("save-file-edit"),
  refreshFile: document.getElementById("refresh-file"),
  copyAnnotations: document.getElementById("copy-annotations"),
  fileFindBar: document.getElementById("file-find-bar"),
  fileFindInput: document.getElementById("file-find-input"),
  fileFindCount: document.getElementById("file-find-count"),
  fileFindPrevious: document.getElementById("file-find-previous"),
  fileFindNext: document.getElementById("file-find-next"),
  fileFindClose: document.getElementById("file-find-close"),
  previewFile: document.getElementById("preview-file"),
  wrapText: document.getElementById("wrap-text"),
  copyPath: document.getElementById("copy-path"),
  viewer: document.getElementById("viewer"),
  loading: document.getElementById("loading"),
  fileLoadingSkeleton: document.getElementById("file-loading-skeleton"),
  textViewer: document.getElementById("text-viewer"),
  scroll: document.getElementById("scroll"),
  lineNumbers: document.getElementById("line-numbers"),
  code: document.getElementById("code"),
  editViewer: document.getElementById("edit-viewer"),
  gitGutter: document.getElementById("git-gutter"),
  editLineNumbers: document.getElementById("edit-line-numbers"),
  lineWrapMeasure: document.getElementById("line-wrap-measure"),
  editHighlight: document.getElementById("edit-highlight"),
  editCode: document.getElementById("edit-code"),
  fileEditor: document.getElementById("file-editor"),
  markers: document.getElementById("annotation-markers"),
  markdownRendered: document.getElementById("markdown-rendered"),
  htmlRendered: document.getElementById("html-rendered"),
  diffViewer: document.getElementById("diff-viewer"),
  mediaViewer: document.getElementById("media-viewer"),
  annotateSelection: document.getElementById("annotate-selection"),
  annotationEditor: document.getElementById("annotation-editor"),
  annotationComment: document.getElementById("annotation-comment"),
  saveAnnotation: document.getElementById("save-annotation"),
  existingActions: document.getElementById("annotation-existing-actions"),
  deleteAnnotation: document.getElementById("delete-annotation"),
  cancelAnnotation: document.getElementById("cancel-annotation"),
  saveExistingAnnotation: document.getElementById("save-existing-annotation"),
  annotationTooltip: document.getElementById("annotation-tooltip"),
};

const state = {
  currentWorkspace: "",
  workspace: {
    openPaths: [], activePath: "", sidebarOpen: false, width: 476,
    activeScrollTop: 0, leftMode: "files",
    previewViewByPath: {},
    treeCollapsed: true, treeHeight: 257, annotations: [], mediaNotes: [],
  },
  files: new Map(),
  scrollByPath: new Map(),
  activeText: "",
  activeDescriptor: null,
  selectionDraft: null,
  selectionRect: null,
  editingAnnotation: null,
  editorSource: null,
  fileEdit: null,
  editHighlightFrame: 0,
  resizeStart: null,
  treeLoadSequence: 0,
  loadSequence: 0,
  hostActive: true,
  wrapText: false,
  wrapOverrideByPath: new Map(),
  previewByPath: new Map(),
  revealLineByPath: new Map(),
  editLineNumberFrame: 0,
  annotationMarkerFrame: 0,
  pendingAnnotationMarkers: null,
  codeLineHeight: DEFAULT_CODE_LINE_HEIGHT,
  pendingLineNumberText: "",
  editResizeObserver: null,
  markdownPreviewTimer: 0,
  pendingMarkdownPreviewText: "",
  pendingMarkdownPreviewPath: "",
  htmlPreviewSequence: 0,
  markdownBlockEdit: null,
  leftMode: "files",
  scrollPersistTimer: 0,
  restoringScroll: false,
  scrollRestoreSequence: 0,
  search: {
    query: "",
    results: [],
    sequence: 0,
    timer: 0,
    controller: null,
  },
  fileSearch: {
    query: "",
    results: [],
    activeIndex: 0,
    sequence: 0,
    timer: 0,
    controller: null,
  },
  diff: {
    path: "",
    active: false,
    payload: null,
    sequence: 0,
  },
  git: {
    status: null,
    renderKey: "",
    loadedAt: 0,
    statusSequence: 0,
    changesPath: "",
    ranges: [],
    changesSequence: 0,
    gutterFrame: 0,
    expanded: true,
  },
  fileFind: {
    query: "",
    matches: [],
    activeIndex: -1,
  },
  codeNavigation: {
    back: [],
    forward: [],
    restoring: false,
    busy: false,
  },
  mediaSeek: {
    direction: 0,
    holdStartedAt: 0,
    lastAppliedAt: 0,
  },
  mobileLeftOpen: false,
  hydrated: false,
  restoreOpenTimer: 0,
  uiVisibility: { ...DEFAULT_UI_VISIBILITY },
  editorPreferences: { ...DEFAULT_EDITOR_PREFERENCES },
  completionSoundEnabled: true,
  turnCheckpoint: {
    enabled: true,
    intervalMinutes: 20,
  },
  fileSave: {
    autoSaveTimer: 0,
    inFlight: false,
    pendingMode: "",
  },
};

const paneHover = globalThis.LocalSystemWorkspacePaneHover?.createPaneHoverController({
  elements,
  isHydrated: () => state.hydrated,
  isMobileStandalone,
  isCollapsed: () => state.workspace.treeCollapsed === true,
  currentWorkspace: () => state.currentWorkspace,
  loadProjectRoot,
});
if (!paneHover) throw new Error("Local System workspace pane hover controller failed to load");

const liveSync = globalThis.LocalSystemWorkspaceLiveSync?.createWorkspaceLiveSync({
  poll: ({ since, signal }) => workspaceRequest("watch", { since }, { signal, timeoutMs: 30_000 }),
  onChange: handleWorkspaceWatchChange,
});
if (!liveSync) throw new Error("Local System workspace live sync failed to load");

installListeners();
void loadUiVisibilitySettings();
void loadEditorPreferences();
void loadCompletionSoundSetting();
void loadTurnCheckpointSettings();
initialize();

async function initialize() {
  if (!threadId) return setVisible(false);
  try {
    const payload = await workspaceRequest("get", {});
    state.currentWorkspace = String(payload.currentWorkspace || "");
    restoreWorkspaceUiState(payload.workspace);
    postAnnotations();
    renderProjectHeader();
    applyPaneLayout();
    renderLeftMode();
    renderTabs();
    setVisible(workspaceShouldBeVisible(state.workspace));
    void loadGitStatus();
    if (state.currentWorkspace && !state.workspace.treeCollapsed && (PRESENTATION === "standalone" || state.workspace.sidebarOpen)) {
      await loadProjectRoot();
    }
    if (state.workspace.activePath) await showPath(state.workspace.activePath);
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error));
    setVisible(false);
  }
  parent.postMessage({
    source: "local-system-file-workspace",
    action: "ready",
    currentWorkspace: state.currentWorkspace,
  }, "*");
  if (HOST_MODE !== "sidepanel") revealHydratedWorkspace();
  syncLiveWatchState({ reset: true });
}

async function refreshProjectContext({ openFiles = false } = {}) {
  const sequence = ++state.treeLoadSequence;
  try {
    const payload = await workspaceRequest("get", {});
    if (sequence !== state.treeLoadSequence) return;
    for (const file of state.files.values()) {
      if (file?.objectUrl) URL.revokeObjectURL(file.objectUrl);
    }
    state.files.clear();
    state.fileEdit = null;
    state.activeText = "";
    state.activeDescriptor = null;
    state.git.status = null;
    state.git.loadedAt = 0;
    state.git.changesPath = "";
    state.git.ranges = [];
    state.currentWorkspace = String(payload.currentWorkspace || "");
    syncLiveWatchState({ reset: true });
    restoreWorkspaceUiState(payload.workspace);
    clearFilesSearch();
    elements.projectTree.replaceChildren();
    renderProjectHeader();
    applyPaneLayout();
    renderLeftMode();
    renderTabs();
    postAnnotations();
    if (!state.currentWorkspace) {
      renderGitChanges();
      elements.treeMessage.hidden = false;
      elements.treeMessage.textContent = "Open a project to browse files.";
      showMessage("Open a project to browse files.");
      setVisible(false);
      return;
    }
    void loadGitStatus({ force: true });
    if (workspaceShouldBeVisible(state.workspace)) setVisible(true);
    if (openFiles) {
      await openWorkspaceMode("files");
    } else if (!state.workspace.treeCollapsed && (PRESENTATION === "standalone" || state.workspace.sidebarOpen)) {
      await loadProjectRoot();
    }
    if (state.workspace.activePath) await showPath(state.workspace.activePath);
    else showMessage("Select a file from the project tree or use ⌘P.");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error));
  }
}

function renderProjectHeader() {
  const normalized = state.currentWorkspace.replace(/[\\/]+$/, "");
  elements.projectName.textContent = normalized ? normalized.split(/[\\/]/).pop() || normalized : "No project";
  elements.projectName.title = state.currentWorkspace ? `Choose project\n${state.currentWorkspace}` : "Choose project";
}

function restoreWorkspaceUiState(workspace) {
  state.workspace = workspace || state.workspace;
  state.leftMode = new Set(["files", "git", "search"]).has(state.workspace.leftMode)
    ? state.workspace.leftMode
    : "files";
  state.scrollByPath.clear();
  if (state.workspace.activePath) {
    state.scrollByPath.set(state.workspace.activePath, Math.max(0, Number(state.workspace.activeScrollTop) || 0));
  }
  state.previewByPath.clear();
  for (const [filePath, mode] of Object.entries(state.workspace.previewViewByPath || {})) {
    if (mode === "raw" || mode === "rendered") state.previewByPath.set(filePath, mode === "rendered");
  }
}

async function loadUiVisibilitySettings() {
  state.uiVisibility = await globalThis.LocalSystemSharedRuntime.loadUiVisibility();
  renderUiVisibilitySettings();
}

function renderUiVisibilitySettings() {
  for (const input of elements.uiSettingsPopover?.querySelectorAll("[data-ui-setting]") || []) {
    input.checked = state.uiVisibility[input.dataset.uiSetting] !== false;
  }
}

async function updateUiVisibilitySetting(key, value) {
  if (!(key in DEFAULT_UI_VISIBILITY)) return;
  state.uiVisibility = { ...state.uiVisibility, [key]: value === true };
  renderUiVisibilitySettings();
  try {
    state.uiVisibility = await globalThis.LocalSystemSharedRuntime.saveUiVisibility(state.uiVisibility);
  } catch {
    // The direct parent message below still updates the current page even if
    // browser storage is temporarily unavailable.
  }
  parent.postMessage({
    source: "local-system-file-workspace",
    action: "ui-visibility",
    key,
    value: value === true,
  }, "*");
}

async function loadEditorPreferences() {
  try {
    const stored = await chrome.storage.local.get(EDITOR_PREFERENCES_STORAGE_KEY);
    state.editorPreferences = normalizeEditorPreferences(stored?.[EDITOR_PREFERENCES_STORAGE_KEY]);
  } catch {
    state.editorPreferences = { ...DEFAULT_EDITOR_PREFERENCES };
  }
  renderEditorPreferences();
  if (state.editorPreferences.autoSave) scheduleAutoSave();
}

function normalizeEditorPreferences(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    autoSave: source.autoSave === true,
  };
}

function renderEditorPreferences() {
  if (elements.autoSaveSetting) elements.autoSaveSetting.checked = state.editorPreferences.autoSave === true;
  renderFileEditSaveChrome();
}

async function updateEditorPreference(key, value) {
  if (!(key in DEFAULT_EDITOR_PREFERENCES)) return;
  state.editorPreferences = {
    ...state.editorPreferences,
    [key]: value === true,
  };
  renderEditorPreferences();
  try {
    await chrome.storage.local.set({
      [EDITOR_PREFERENCES_STORAGE_KEY]: state.editorPreferences,
    });
  } catch {
    // Keep the current workspace preference even if browser storage is briefly unavailable.
  }
  if (key === "autoSave") {
    if (state.editorPreferences.autoSave) {
      scheduleAutoSave();
    } else {
      cancelAutoSaveTimer();
    }
    renderFileEditSaveChrome();
  }
}

async function loadCompletionSoundSetting() {
  try {
    const stored = await chrome.storage.local.get(COMPLETION_SOUND_ENABLED_STORAGE_KEY);
    state.completionSoundEnabled = stored?.[COMPLETION_SOUND_ENABLED_STORAGE_KEY] !== false;
  } catch {
    state.completionSoundEnabled = true;
  }
  renderCompletionSoundSetting();
}

function renderCompletionSoundSetting() {
  if (elements.completionSoundSetting) {
    elements.completionSoundSetting.checked = state.completionSoundEnabled !== false;
  }
}

async function updateCompletionSoundSetting(value) {
  state.completionSoundEnabled = value === true;
  renderCompletionSoundSetting();
  try {
    await chrome.storage.local.set({
      [COMPLETION_SOUND_ENABLED_STORAGE_KEY]: state.completionSoundEnabled,
    });
  } catch {
    // Keep the current workspace setting even if browser storage is briefly unavailable.
  }
}

async function loadTurnCheckpointSettings() {
  try {
    state.turnCheckpoint = normalizeTurnCheckpointSettings(
      await bridgeRequest("/local-ui/turn-checkpoint", { action: "get" }, { timeoutMs: 2_500 }),
    );
  } catch {
    state.turnCheckpoint = normalizeTurnCheckpointSettings(state.turnCheckpoint);
  }
  renderTurnCheckpointSettings();
}

function normalizeTurnCheckpointSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const minutes = Number(source.intervalMinutes);
  return {
    enabled: source.enabled !== false,
    intervalMinutes: Number.isFinite(minutes) ? Math.min(240, Math.max(1, Math.round(minutes))) : 20,
  };
}

function renderTurnCheckpointSettings() {
  if (elements.checkpointInjectionSetting) {
    elements.checkpointInjectionSetting.checked = state.turnCheckpoint.enabled !== false;
  }
  if (elements.checkpointMinutesSetting) {
    elements.checkpointMinutesSetting.value = String(state.turnCheckpoint.intervalMinutes);
    elements.checkpointMinutesSetting.disabled = state.turnCheckpoint.enabled === false;
  }
}

async function updateTurnCheckpointSettings(patch) {
  const previous = { ...state.turnCheckpoint };
  state.turnCheckpoint = normalizeTurnCheckpointSettings({ ...state.turnCheckpoint, ...patch });
  renderTurnCheckpointSettings();
  try {
    state.turnCheckpoint = normalizeTurnCheckpointSettings(await bridgeRequest(
      "/local-ui/turn-checkpoint",
      {
        action: "update",
        enabled: state.turnCheckpoint.enabled,
        intervalMinutes: state.turnCheckpoint.intervalMinutes,
      },
      { timeoutMs: 2_500 },
    ));
    renderTurnCheckpointSettings();
  } catch {
    state.turnCheckpoint = previous;
    renderTurnCheckpointSettings();
  }
}

function setUiSettingsOpen(open) {
  if (!elements.uiSettingsPopover || !elements.uiSettingsToggle) return;
  elements.uiSettingsPopover.hidden = !open;
  elements.uiSettingsToggle.setAttribute("aria-expanded", open ? "true" : "false");
  elements.uiSettingsToggle.classList.toggle("active", open);
  if (open) {
    void loadSidePanelSiteSettings();
    void loadTurnCheckpointSettings();
  }
}

async function extensionWorkspaceRequest(action, extra = {}) {
  const response = await chrome.runtime.sendMessage({
    source: "local-system-workspace",
    action,
    ...extra,
  });
  if (!response?.ok) throw new Error(response?.error || "Extension settings unavailable");
  return response.payload || {};
}

async function loadSidePanelSiteSettings() {
  if (!elements.sidePanelSiteSettings) return;
  if (HOST_MODE !== "sidepanel") {
    elements.sidePanelSiteSettings.hidden = true;
    return;
  }

  elements.sidePanelSiteSettings.hidden = false;
  elements.currentSiteName.textContent = "Loading…";
  elements.hideCurrentSite.disabled = true;
  try {
    const payload = await extensionWorkspaceRequest("side-panel-site-settings");
    renderSidePanelSiteSettings(payload);
  } catch (error) {
    elements.currentSiteName.textContent = "Unavailable";
    elements.hideCurrentSite.disabled = true;
    elements.hiddenSitesList.replaceChildren();
    elements.hiddenSitesEmpty.hidden = false;
    elements.hiddenSitesEmpty.textContent = error instanceof Error ? error.message : "Website settings unavailable";
  }
}

function renderSidePanelSiteSettings(payload = {}) {
  const currentSite = String(payload.currentSite || "");
  const hiddenSites = Array.isArray(payload.hiddenSites)
    ? payload.hiddenSites.map((site) => String(site || "")).filter(Boolean)
    : [];
  elements.currentSiteName.textContent = currentSite || "This browser page";
  elements.hideCurrentSite.disabled = payload.canHideCurrentSite !== true;
  elements.hideCurrentSite.hidden = payload.canHideCurrentSite !== true;
  elements.hiddenSitesList.replaceChildren();

  for (const site of hiddenSites) {
    const row = document.createElement("div");
    row.className = "workspace-hidden-site";
    const name = document.createElement("span");
    name.className = "workspace-hidden-site-name";
    name.textContent = site;
    const button = document.createElement("button");
    button.className = "workspace-site-action";
    button.type = "button";
    button.dataset.enableSite = site;
    button.textContent = "Enable";
    row.append(name, button);
    elements.hiddenSitesList.append(row);
  }
  elements.hiddenSitesEmpty.hidden = hiddenSites.length > 0;
  elements.hiddenSitesEmpty.textContent = "No hidden websites";
}

async function hideSidePanelOnCurrentSite() {
  if (elements.hideCurrentSite.disabled) return;
  elements.hideCurrentSite.disabled = true;
  elements.hideCurrentSite.textContent = "Hiding…";
  try {
    await extensionWorkspaceRequest("hide-side-panel-on-current-site");
  } catch {
    elements.hideCurrentSite.textContent = "Hide here";
    await loadSidePanelSiteSettings();
  }
}

async function enableHiddenSidePanelSite(site, button) {
  if (!site) return;
  if (button) {
    button.disabled = true;
    button.textContent = "Enabling…";
  }
  try {
    await extensionWorkspaceRequest("unhide-side-panel-site", { site });
  } finally {
    await loadSidePanelSiteSettings();
  }
}

function persistedSidebarOpen(requested) {
  return PRESENTATION === "standalone" ? state.workspace.sidebarOpen : requested === true;
}

function workspaceShouldBeVisible(workspace = state.workspace) {
  if (!state.currentWorkspace) return false;
  return PRESENTATION === "standalone" ? true : workspace?.sidebarOpen === true;
}

function isMobileStandalone() {
  return PRESENTATION === "standalone" && mobileStandalone;
}

function closeMobileLeftPane() {
  if (!isMobileStandalone() || !state.mobileLeftOpen) return;
  state.mobileLeftOpen = false;
  applyPaneLayout();
}

function applyPaneLayout() {
  if (isMobileStandalone()) {
    const open = state.mobileLeftOpen === true;
    elements.workspace.classList.toggle("mobile-left-open", open);
    elements.treePane.classList.toggle("tree-collapsed", !open);
    elements.treeToggle.setAttribute("aria-expanded", open ? "true" : "false");
    elements.treeToggle.setAttribute("aria-pressed", open ? "true" : "false");
    updatePaneSplitterAria();
    return;
  }
  const treeCollapsed = !state.hydrated || state.workspace.treeCollapsed === true;
  if (!treeCollapsed) paneHover.reset();
  elements.workspace.classList.toggle("tree-collapsed", treeCollapsed);
  elements.treePane.classList.toggle("tree-collapsed", treeCollapsed);
  elements.treeToggle.setAttribute("aria-expanded", treeCollapsed ? "false" : "true");
  elements.treeToggle.setAttribute("aria-pressed", treeCollapsed ? "false" : "true");
  const bounds = paneSizeBounds();
  const storedWidth = Math.max(bounds.min, Number(state.workspace.treeHeight) || 190);
  const leftWidth = Math.max(bounds.min, Math.min(bounds.max, storedWidth));
  elements.workspace.style.setProperty("--tree-width", `${leftWidth}px`);
  updatePaneSplitterAria(leftWidth, bounds);
}

function revealHydratedWorkspace() {
  if (state.hydrated) return;
  const restoreOpen = !isMobileStandalone() && state.workspace.treeCollapsed !== true;
  state.hydrated = true;
  elements.workspace.classList.remove("workspace-hydrating");
  if (restoreOpen) elements.workspace.classList.add("workspace-restoring-open");
  applyPaneLayout();
  if (restoreOpen) {
    globalThis.clearTimeout(state.restoreOpenTimer);
    state.restoreOpenTimer = globalThis.setTimeout(() => {
      state.restoreOpenTimer = 0;
      elements.workspace.classList.remove("workspace-restoring-open");
    }, TREE_RESTORE_OPEN_ANIMATION_MS + 30);
  }
  if (
    PRESENTATION === "standalone"
    && HOST_MODE === "sidepanel"
    && !state.workspace.treeCollapsed
    && state.leftMode === "files"
  ) {
    focusFilesSearch({ select: true });
  }
}

function paneSizeBounds() {
  const columnsWidth = Math.max(
    1,
    elements.workspaceColumns?.getBoundingClientRect().width
      || elements.workspace.getBoundingClientRect().width
      || globalThis.innerWidth
      || 1,
  );
  const sash = 9;
  const available = Math.max(1, columnsWidth - sash);
  const min = Math.min(180, Math.max(120, Math.round(available * 0.28)));
  const minEditor = Math.min(320, Math.max(180, Math.round(available * 0.42)));
  const max = Math.max(min, Math.min(620, available - minEditor));
  return { min, max, available };
}

function updatePaneSplitterAria(leftWidth = null, bounds = null) {
  if (!elements.paneSplitter) return;
  if (isMobileStandalone() || state.workspace.treeCollapsed) {
    elements.paneSplitter.tabIndex = -1;
    elements.paneSplitter.setAttribute("aria-valuenow", "0");
    elements.paneSplitter.setAttribute("aria-valuetext", state.workspace.treeCollapsed ? "Project panel collapsed" : "Project panel drawer");
    return;
  }
  elements.paneSplitter.tabIndex = 0;
  const resolvedBounds = bounds || paneSizeBounds();
  const width = Number.isFinite(leftWidth)
    ? leftWidth
    : Math.max(resolvedBounds.min, Math.min(resolvedBounds.max, Number(state.workspace.treeHeight) || 300));
  const span = Math.max(1, resolvedBounds.max - resolvedBounds.min);
  const percent = Math.round(((width - resolvedBounds.min) / span) * 100);
  elements.paneSplitter.setAttribute("aria-valuemin", "0");
  elements.paneSplitter.setAttribute("aria-valuemax", "100");
  elements.paneSplitter.setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, percent))));
  elements.paneSplitter.setAttribute("aria-valuetext", state.workspace.treeCollapsed ? "Project panel collapsed" : `${Math.round(width)} pixels`);
}

async function toggleTreePane() {
  if (isMobileStandalone()) {
    state.mobileLeftOpen = !state.mobileLeftOpen;
    applyPaneLayout();
    if (state.mobileLeftOpen && state.currentWorkspace && !elements.projectTree.children.length) await loadProjectRoot();
    return;
  }
  state.workspace = await persistWorkspace({
    treeCollapsed: !state.workspace.treeCollapsed,
    treeHeight: state.workspace.treeHeight,
  });
  applyPaneLayout();
  if (!state.workspace.treeCollapsed && state.currentWorkspace && !elements.projectTree.children.length) await loadProjectRoot();
  if (!state.workspace.treeCollapsed && state.leftMode === "files") focusFilesSearch();
}

async function ensureLeftPane(mode = state.leftMode, { open = true } = {}) {
  state.leftMode = new Set(["files", "git", "search"]).has(mode) ? mode : "files";
  if (isMobileStandalone()) {
    state.workspace = await persistWorkspace({ leftMode: state.leftMode });
    state.mobileLeftOpen = true;
    renderLeftMode();
    applyPaneLayout();
    if (state.leftMode === "files" && state.currentWorkspace && !elements.projectTree.children.length) await loadProjectRoot();
    if (state.leftMode === "git") void loadGitStatus({ force: true });
    if (state.leftMode === "files") focusFilesSearch();
    if (state.leftMode === "search") requestAnimationFrame(() => elements.workspaceSearchInput?.focus());
    return;
  }
  state.workspace = await persistWorkspace({
    leftMode: state.leftMode,
    treeCollapsed: open ? false : state.workspace.treeCollapsed,
    treeHeight: state.workspace.treeHeight,
  });
  renderLeftMode();
  applyPaneLayout();
  if (state.leftMode === "files" && state.currentWorkspace && !elements.projectTree.children.length) await loadProjectRoot();
  if (state.leftMode === "git") void loadGitStatus({ force: true });
  if (state.leftMode === "files") focusFilesSearch();
  if (state.leftMode === "search") requestAnimationFrame(() => elements.workspaceSearchInput?.focus());
}

function renderLeftMode() {
  const mode = state.leftMode;
  elements.leftFilesPanel.hidden = mode !== "files";
  elements.leftGitPanel.hidden = mode !== "git";
  elements.leftSearchPanel.hidden = mode !== "search";
  elements.leftModeFiles.classList.toggle("active", mode === "files");
  elements.leftModeGit.classList.toggle("active", mode === "git");
  elements.fullTextSearch.classList.toggle("active", mode === "search");
  elements.leftModeFiles.setAttribute("aria-pressed", mode === "files" ? "true" : "false");
  elements.leftModeGit.setAttribute("aria-pressed", mode === "git" ? "true" : "false");
  elements.fullTextSearch.setAttribute("aria-pressed", mode === "search" ? "true" : "false");
}

function startPaneResize(event) {
  if (event.button !== 0 || state.workspace.treeCollapsed || isMobileStandalone()) return;
  event.preventDefault();
  elements.paneSplitter.setPointerCapture?.(event.pointerId);
  const startX = event.clientX;
  const startWidth = elements.treePane.getBoundingClientRect().width;
  const bounds = paneSizeBounds();
  let nextWidth = startWidth;
  elements.paneSplitter.classList.add("dragging");

  const onMove = (moveEvent) => {
    if (!(moveEvent.buttons & 1)) return finish(false);
    nextWidth = Math.max(bounds.min, Math.min(bounds.max, startWidth + (moveEvent.clientX - startX)));
    state.workspace.treeHeight = Math.round(nextWidth);
    elements.workspace.style.setProperty("--tree-width", `${state.workspace.treeHeight}px`);
    updatePaneSplitterAria(state.workspace.treeHeight, bounds);
    if (state.wrapText && state.fileEdit?.path === state.workspace.activePath) scheduleEditLineNumbers(elements.fileEditor.value);
  };
  const finish = async (persist = true) => {
    globalThis.removeEventListener("pointermove", onMove);
    globalThis.removeEventListener("pointerup", onUp);
    globalThis.removeEventListener("pointercancel", onCancel);
    elements.paneSplitter.classList.remove("dragging");
    if (!persist) return;
    state.workspace = await persistWorkspace({ treeHeight: state.workspace.treeHeight });
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  globalThis.addEventListener("pointermove", onMove);
  globalThis.addEventListener("pointerup", onUp);
  globalThis.addEventListener("pointercancel", onCancel);
}

function handlePaneSplitterKeydown(event) {
  if (isMobileStandalone()) return;
  if (event.key === "Enter") {
    event.preventDefault();
    void toggleTreePane();
    return;
  }
  if (state.workspace.treeCollapsed) return;
  const bounds = paneSizeBounds();
  let next = Number(state.workspace.treeHeight) || elements.treePane.getBoundingClientRect().width || 190;
  if (event.key === "ArrowLeft") next -= event.shiftKey ? 48 : 16;
  else if (event.key === "ArrowRight") next += event.shiftKey ? 48 : 16;
  else if (event.key === "Home") next = bounds.min;
  else if (event.key === "End") next = bounds.max;
  else return;
  event.preventDefault();
  next = Math.max(bounds.min, Math.min(bounds.max, Math.round(next)));
  state.workspace.treeHeight = next;
  elements.workspace.style.setProperty("--tree-width", `${next}px`);
  updatePaneSplitterAria(next, bounds);
  void persistWorkspace({ treeHeight: next }).then((workspace) => {
    state.workspace = workspace;
    applyPaneLayout();
  });
}

async function loadProjectRoot() {
  const sequence = ++state.treeLoadSequence;
  elements.treeMessage.hidden = false;
  elements.treeMessage.textContent = "Loading project…";
  elements.projectTree.replaceChildren();
  try {
    const payload = await workspaceRequest("list_directory", {});
    if (sequence !== state.treeLoadSequence) return;
    state.currentWorkspace = String(payload.currentWorkspace || state.currentWorkspace);
    renderProjectHeader();
    elements.treeMessage.hidden = true;
    renderTreeEntries(elements.projectTree, payload.entries || [], 0, payload.truncated === true);
  } catch (error) {
    if (sequence !== state.treeLoadSequence) return;
    elements.treeMessage.hidden = false;
    elements.treeMessage.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function refreshProjectFiles({ open = true } = {}) {
  await ensureLeftPane("files", { open });
  if (!state.currentWorkspace) return;
  await loadProjectRoot();
}

function syncLiveWatchState({ reset = false } = {}) {
  const enabled = Boolean(
    threadId
    && state.currentWorkspace
    && state.hostActive
    && document.visibilityState !== "hidden"
  );
  liveSync.setEnabled(enabled, { reset });
}

async function handleWorkspaceWatchChange(watch) {
  const event = watch?.event;
  if (!event || !state.currentWorkspace) return;

  const gitRefresh = loadGitStatus({ force: true });
  if (event.gitOnly !== true && event.kind === "rename") {
    await refreshProjectTreeForWatchEvent(event);
  }
  if (event.gitOnly !== true) {
    await refreshActiveFileForWatchEvent(event);
  }
  await gitRefresh;
}

async function refreshProjectTreeForWatchEvent(event) {
  if (!elements.projectTree.children.length) return;
  const paths = Array.isArray(event.paths) ? event.paths.filter(Boolean) : [];
  if (event.overflow === true || paths.length === 0) {
    await loadProjectRoot();
    return;
  }

  const root = normalizeWorkspacePath(state.currentWorkspace);
  const parentDirectories = new Set(paths.map(parentWorkspacePath).filter(Boolean));
  if (parentDirectories.has(root)) {
    await loadProjectRoot();
    return;
  }

  for (const directoryPath of parentDirectories) {
    await refreshLoadedTreeDirectory(directoryPath);
  }
}

async function refreshLoadedTreeDirectory(directoryPath) {
  const normalizedDirectory = normalizeWorkspacePath(directoryPath);
  const row = [...elements.projectTree.querySelectorAll('.tree-row[data-type="dir"]')]
    .find((candidate) => normalizeWorkspacePath(candidate.dataset.path) === normalizedDirectory);
  if (!row?.classList.contains("expanded")) return;
  const children = row.nextElementSibling;
  if (!children?.classList.contains("tree-children") || children.dataset.loaded !== "true") return;

  const depth = Number(row.style.getPropertyValue("--tree-depth")) || 0;
  try {
    const payload = await workspaceRequest("list_directory", { path: row.dataset.path });
    children.replaceChildren();
    renderTreeEntries(children, payload.entries || [], depth + 1, payload.truncated === true);
    children.dataset.loaded = "true";
  } catch {
    // Keep the existing loaded branch if a transient filesystem race occurs.
  }
}

async function refreshActiveFileForWatchEvent(event) {
  const activePath = state.workspace.activePath;
  if (!activePath || state.fileEdit?.dirty) return;
  const normalizedActive = normalizeWorkspacePath(activePath);
  const paths = Array.isArray(event.paths) ? event.paths.map(normalizeWorkspacePath).filter(Boolean) : [];
  const activeChanged = event.overflow === true
    || paths.length === 0
    || paths.some((candidate) => (
      candidate === normalizedActive
      || normalizedActive.startsWith(`${candidate}/`)
    ));
  if (!activeChanged) return;

  const cached = state.files.get(activePath);
  if (cached?.descriptor && await fileDescriptorStillMatches(activePath, cached.descriptor)) return;
  if (cached?.objectUrl) URL.revokeObjectURL(cached.objectUrl);
  state.files.delete(activePath);
  await showPath(activePath);
}

async function fileDescriptorStillMatches(path, descriptor) {
  try {
    const current = await bridgeRequest("/local-ui/files/resolve", {
      threadId,
      path,
      active: state.hostActive,
    });
    return Number(current?.bytes) === Number(descriptor?.bytes)
      && Number(current?.lastModified) === Number(descriptor?.lastModified);
  } catch {
    return false;
  }
}

function normalizeWorkspacePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+$/, "");
}

function parentWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  const separator = normalized.lastIndexOf("/");
  if (separator <= 0) return normalized;
  if (/^[A-Za-z]:$/.test(normalized.slice(0, separator))) return normalized.slice(0, separator) + "/";
  return normalized.slice(0, separator);
}

async function loadGitStatus({ force = false } = {}) {
  if (!threadId || !state.currentWorkspace) {
    state.git.status = null;
    state.git.renderKey = "";
    state.git.loadedAt = 0;
    renderGitChanges();
    return;
  }
  const sequence = ++state.git.statusSequence;
  try {
    const payload = await bridgeRequest("/local-ui/git", {
      threadId,
      action: "status",
      force,
      active: state.hostActive,
    });
    if (sequence !== state.git.statusSequence) return;
    const renderKey = gitStatusRenderKey(payload);
    const shouldRender = renderKey !== state.git.renderKey;
    state.git.status = payload;
    state.git.renderKey = renderKey;
    state.git.loadedAt = Date.now();
    if (shouldRender) renderGitChanges();
    if (state.workspace.activePath) void loadActiveGitChanges(state.workspace.activePath);
  } catch {
    if (sequence !== state.git.statusSequence) return;
    const shouldRender = state.git.renderKey !== "";
    state.git.status = null;
    state.git.renderKey = "";
    state.git.loadedAt = 0;
    if (shouldRender) renderGitChanges();
  }
}

function gitStatusRenderKey(status) {
  if (status?.repository !== true) return "";
  const files = Array.isArray(status.files) ? status.files : [];
  return JSON.stringify({
    branch: String(status.branch || ""),
    files: files.map((file) => [
      String(file.absolutePath || file.path || ""),
      String(file.kind || ""),
      file.staged === true,
      file.unstaged === true,
      file.untracked === true,
      file.conflicted === true,
      Number.isInteger(file.additions) ? file.additions : null,
      Number.isInteger(file.deletions) ? file.deletions : null,
    ]),
  });
}

function renderGitChanges() {
  const status = state.git.status;
  const repository = status?.repository === true;
  elements.gitChangesSection.hidden = !repository;
  if (!repository) {
    elements.gitChangesBody.replaceChildren();
    elements.gitChangesCount.textContent = "0";
    elements.gitBranch.textContent = "";
    return;
  }

  const files = Array.isArray(status.files) ? status.files : [];
  elements.gitChangesCount.textContent = String(files.length);
  elements.leftGitBadge.textContent = files.length > 99 ? "99+" : String(files.length);
  elements.leftGitBadge.hidden = files.length === 0;
  elements.gitBranch.textContent = String(status.branch || "");
  elements.gitBranch.title = String(status.branch || "");
  elements.gitChangesToggle.setAttribute("aria-expanded", state.git.expanded ? "true" : "false");
  elements.gitChangesBody.hidden = !state.git.expanded;
  elements.gitChangesBody.replaceChildren();
  if (!state.git.expanded) return;

  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "git-change-empty";
    empty.textContent = "Working tree clean";
    elements.gitChangesBody.appendChild(empty);
    return;
  }

  const groups = [
    ["Staged", files.filter((file) => file.staged)],
    ["Changes", files.filter((file) => file.unstaged && !file.untracked)],
    ["Untracked", files.filter((file) => file.untracked)],
  ];
  for (const [label, entries] of groups) {
    if (!entries.length) continue;
    const group = document.createElement("section");
    group.className = "git-change-group";
    const title = document.createElement("div");
    title.className = "git-change-group-title";
    title.textContent = `${label} · ${entries.length}`;
    group.appendChild(title);
    for (const file of entries) group.appendChild(gitChangeRow(file));
    elements.gitChangesBody.appendChild(group);
  }
}

function gitChangeRow(file) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "git-change-row ls-ui-list-row";
  const displayPath = workspaceRelativeGitPath(file);
  const displayName = basename(displayPath) || displayPath;
  row.title = displayPath;
  row.setAttribute("aria-label", displayPath ? `Open changes for ${displayPath}` : "Open file changes");

  const code = document.createElement("span");
  code.className = "git-change-code";
  code.textContent = file.untracked ? "U" : file.kind === "added" ? "A" : file.kind === "deleted" ? "D" : file.kind === "renamed" ? "R" : file.conflicted ? "!" : "M";
  const name = document.createElement("span");
  name.className = "git-change-path";
  name.textContent = displayName;
  name.title = displayPath;
  const stats = document.createElement("span");
  stats.className = "git-change-stats";
  if (Number.isInteger(file.additions) && file.additions > 0) {
    const add = document.createElement("span");
    add.className = "git-change-add";
    add.textContent = `+${file.additions}`;
    stats.appendChild(add);
  }
  if (Number.isInteger(file.deletions) && file.deletions > 0) {
    const del = document.createElement("span");
    del.className = "git-change-del";
    del.textContent = `−${file.deletions}`;
    stats.appendChild(del);
  }
  row.append(code, name, stats);
  if (file.absolutePath) {
    makeFileDraggable(row, file.absolutePath, basename(file.absolutePath));
    row.addEventListener("click", () => void openGitDiff(file));
  }
  return row;
}

async function openGitDiff(file) {
  const path = String(file?.absolutePath || "").trim();
  if (!path || !prepareToLeaveFileEdit()) return;
  state.diff.active = true;
  state.diff.path = path;
  state.diff.payload = null;
  state.workspace = await persistWorkspace({
    openPaths: state.workspace.openPaths,
    activePath: state.workspace.activePath,
    sidebarOpen: persistedSidebarOpen(true),
    width: state.workspace.width,
    treeCollapsed: state.workspace.treeCollapsed,
    treeHeight: state.workspace.treeHeight,
  });
  applyPaneLayout();
  setVisible(true);
  closeMobileLeftPane();
  renderTabs();
  await showGitDiff(path);
}

async function showGitDiff(path) {
  const sequence = ++state.diff.sequence;
  elements.fileActionBar.hidden = true;
  elements.fileFindBar.hidden = true;
  hideSelectionAction();
  hideAnnotationEditor();
  showMessage("Loading changes…");
  try {
    const payload = await bridgeRequest("/local-ui/git", {
      threadId,
      action: "file_diff",
      path,
      active: state.hostActive,
    });
    if (sequence !== state.diff.sequence || !state.diff.active || state.diff.path !== path) return;
    state.diff.payload = payload;
    renderGitDiff(payload);
  } catch (error) {
    if (sequence !== state.diff.sequence) return;
    showMessage(error instanceof Error ? error.message : String(error));
  }
}

function renderGitDiff(payload) {
  elements.fileLoadingSkeleton.hidden = true;
  elements.loading.hidden = true;
  elements.textViewer.hidden = true;
  elements.mediaViewer.hidden = true;
  elements.diffViewer.hidden = false;
  elements.diffViewer.replaceChildren();
  const diff = String(payload?.diff || "");
  if (!diff) {
    const empty = document.createElement("div");
    empty.className = "diff-empty";
    empty.textContent = payload?.changed ? "No textual diff is available for this file." : "No Git changes.";
    elements.diffViewer.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  let oldLine = null;
  let newLine = null;
  for (const rawLine of diff.split("\n")) {
    const row = document.createElement("div");
    row.className = "diff-line";
    const oldNumber = document.createElement("span");
    oldNumber.className = "diff-line-number";
    const newNumber = document.createElement("span");
    newNumber.className = "diff-line-number";
    const code = document.createElement("span");
    code.className = "diff-line-code";
    code.textContent = rawLine || " ";

    const hunk = rawLine.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      row.classList.add("hunk");
    } else if (rawLine.startsWith("diff --git ") || rawLine.startsWith("index ") || rawLine.startsWith("--- ") || rawLine.startsWith("+++ ") || rawLine.startsWith("new file mode ") || rawLine.startsWith("deleted file mode ")) {
      row.classList.add("meta");
    } else if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      row.classList.add("added");
      newNumber.textContent = String(newLine ?? "");
      if (newLine !== null) newLine += 1;
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      row.classList.add("deleted");
      oldNumber.textContent = String(oldLine ?? "");
      if (oldLine !== null) oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      oldNumber.textContent = String(oldLine ?? "");
      newNumber.textContent = String(newLine ?? "");
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
    } else {
      row.classList.add("meta");
    }
    row.append(oldNumber, newNumber, code);
    fragment.appendChild(row);
  }
  elements.diffViewer.appendChild(fragment);
  if (payload?.truncated) {
    const note = document.createElement("div");
    note.className = "diff-truncated";
    note.textContent = "Diff truncated to keep the workspace responsive.";
    elements.diffViewer.appendChild(note);
  }
}

function workspaceRelativeGitPath(file) {
  const absolute = String(file?.absolutePath || "").replaceAll("\\", "/");
  const root = String(state.currentWorkspace || "").replaceAll("\\", "/").replace(/\/+$/, "");
  if (absolute && root && absolute.startsWith(`${root}/`)) return absolute.slice(root.length + 1);
  return String(file?.path || absolute || "");
}

async function loadActiveGitChanges(filePath) {
  const path = String(filePath || "");
  const status = state.git.status;
  if (!path || status?.repository !== true) {
    state.git.changesPath = "";
    state.git.ranges = [];
    scheduleGitGutterMarkers();
    return;
  }
  const sequence = ++state.git.changesSequence;
  try {
    const payload = await bridgeRequest("/local-ui/git", {
      threadId,
      action: "file_changes",
      path,
      active: state.hostActive,
    });
    if (sequence !== state.git.changesSequence || state.workspace.activePath !== path) return;
    state.git.changesPath = path;
    state.git.ranges = Array.isArray(payload.ranges) ? payload.ranges : [];
    scheduleGitGutterMarkers();
  } catch {
    if (sequence !== state.git.changesSequence) return;
    state.git.changesPath = path;
    state.git.ranges = [];
    scheduleGitGutterMarkers();
  }
}

function renderTreeEntries(container, entries, depth, truncated = false) {
  for (const entry of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-row ls-ui-list-row";
    row.style.setProperty("--tree-depth", String(depth));
    row.dataset.path = entry.path;
    row.dataset.type = entry.type;
    row.title = entry.path;

    if (entry.type === "dir") {
      row.innerHTML = `<svg class="tree-row__chevron" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>${folderTreeIconMarkup()}<span class="tree-row__name"></span>`;
      row.querySelector(".tree-row__name").textContent = entry.name;
      const children = document.createElement("div");
      children.className = "tree-children";
      children.hidden = true;
      row.addEventListener("click", async () => {
        if (row.classList.contains("expanded")) {
          row.classList.remove("expanded");
          children.hidden = true;
          return;
        }
        row.classList.add("expanded");
        children.hidden = false;
        if (children.dataset.loaded === "true") return;
        children.dataset.loaded = "true";
        const loading = document.createElement("div");
        loading.className = "tree-message";
        loading.textContent = "Loading…";
        children.appendChild(loading);
        try {
          const payload = await workspaceRequest("list_directory", { path: entry.path });
          children.replaceChildren();
          renderTreeEntries(children, payload.entries || [], depth + 1, payload.truncated === true);
        } catch (error) {
          children.replaceChildren();
          const message = document.createElement("div");
          message.className = "tree-message";
          message.textContent = error instanceof Error ? error.message : String(error);
          children.appendChild(message);
          children.dataset.loaded = "false";
        }
      });
      container.append(row, children);
      continue;
    }

    row.innerHTML = `<span class="tree-row__chevron"></span>${fileTreeIconMarkup(entry.name)}<span class="tree-row__name"></span>`;
    row.querySelector(".tree-row__name").textContent = entry.name;
    makeFileDraggable(row, entry.path, entry.name);
    row.addEventListener("click", () => openFile(entry.path));
    container.appendChild(row);
  }

  if (truncated) {
    const note = document.createElement("div");
    note.className = "tree-truncated";
    note.textContent = "More entries exist in this folder.";
    container.appendChild(note);
  }
}

function folderTreeIconMarkup() {
  return [
    '<svg class="tree-row__icon tree-row__folder-icon tree-row__folder-icon--closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 7.25A2.25 2.25 0 0 1 6 5h3.35l2.15 2.15H18A2.25 2.25 0 0 1 20.25 9.4v7.35A2.25 2.25 0 0 1 18 19H6a2.25 2.25 0 0 1-2.25-2.25Z"/></svg>',
    '<svg class="tree-row__icon tree-row__folder-icon tree-row__folder-icon--open" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 10V7.25A2.25 2.25 0 0 1 6 5h3.35l2.15 2.15H18A2.25 2.25 0 0 1 20.25 9.4v.6"/><path d="M4.25 18.75 6.45 12a2 2 0 0 1 1.9-1.38h11.9l-2.2 6.75a2 2 0 0 1-1.9 1.38Z"/></svg>',
  ].join("");
}

function fileTreeIconMarkup(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") {
    return '<svg class="tree-row__icon tree-row__icon--git" viewBox="0 0 24 24"><circle cx="7" cy="6" r="1.8"/><circle cx="17" cy="18" r="1.8"/><path d="M7 8v3a7 7 0 0 0 7 7h3M7 11a5 5 0 0 1 5-5h3"/></svg>';
  }
  if (lower === ".env" || lower.startsWith(".env.")) return '<span class="tree-row__file-badge tree-row__file-badge--env">ENV</span>';
  if (/\.(md|markdown|mdx)$/.test(lower)) return '<span class="tree-row__file-badge tree-row__file-badge--md">MD</span>';
  if (/\.py$/.test(lower)) return '<span class="tree-row__file-badge tree-row__file-badge--py">PY</span>';
  if (/\.(js|jsx|mjs|cjs)$/.test(lower)) return '<span class="tree-row__file-badge tree-row__file-badge--js">JS</span>';
  if (/\.(ts|tsx|mts|cts)$/.test(lower)) return '<span class="tree-row__file-badge tree-row__file-badge--ts">TS</span>';
  return '<svg class="tree-row__icon tree-row__file-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.75h6.5l3.5 3.5v13H7z"/><path d="M13.5 3.75v4h3.5"/></svg>';
}

function scheduleFilesSearch() {
  clearTimeout(state.fileSearch.timer);
  state.fileSearch.timer = setTimeout(() => void runFilesSearch(), 55);
}

async function runFilesSearch() {
  const query = String(elements.filesSearchInput.value || "").trim().slice(0, 300);
  state.fileSearch.query = query;
  state.fileSearch.controller?.abort();
  if (!query) {
    state.fileSearch.results = [];
    state.fileSearch.activeIndex = 0;
    renderFilesSearch();
    return;
  }

  const sequence = ++state.fileSearch.sequence;
  const controller = new AbortController();
  state.fileSearch.controller = controller;
  elements.filesSearchResults.hidden = false;
  elements.treeBody.hidden = true;
  elements.filesSearchStatus.textContent = "Searching…";
  elements.filesSearchList.replaceChildren();
  try {
    const payload = await bridgeRequest("/local-ui/files/search", {
      threadId,
      query,
      active: state.hostActive,
      workspaceOnly: true,
    }, { signal: controller.signal });
    if (sequence !== state.fileSearch.sequence || controller.signal.aborted) return;
    state.fileSearch.results = Array.isArray(payload.files) ? payload.files : [];
    state.fileSearch.activeIndex = 0;
    renderFilesSearch(payload);
  } catch (error) {
    if (controller.signal.aborted || sequence !== state.fileSearch.sequence) return;
    state.fileSearch.results = [];
    elements.filesSearchList.replaceChildren();
    elements.filesSearchResults.hidden = false;
    elements.treeBody.hidden = true;
    elements.filesSearchStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.fileSearch.controller === controller) state.fileSearch.controller = null;
  }
}

function renderFilesSearch(payload = null) {
  const query = state.fileSearch.query;
  const results = state.fileSearch.results;
  elements.filesSearchList.replaceChildren();
  if (!query) {
    elements.filesSearchResults.hidden = true;
    elements.treeBody.hidden = false;
    elements.filesSearchStatus.textContent = "";
    return;
  }

  elements.filesSearchResults.hidden = false;
  elements.treeBody.hidden = true;
  const total = Number(payload?.total);
  const count = Number.isFinite(total) ? total : results.length;
  elements.filesSearchStatus.textContent = results.length
    ? `${count} file${count === 1 ? "" : "s"}${payload?.truncated ? " · showing top matches" : ""}`
    : "No matching files";

  const fragment = document.createDocumentFragment();
  results.forEach((file, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "files-search-result ls-ui-list-row";
    row.classList.toggle("active", index === state.fileSearch.activeIndex);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === state.fileSearch.activeIndex ? "true" : "false");
    row.innerHTML = `${fileTreeIconMarkup(file.name)}<span class="files-search-result__copy"><span class="files-search-result__name"></span><span class="files-search-result__context"></span></span>`;
    row.querySelector(".files-search-result__name").textContent = file.name || basename(file.path);
    row.querySelector(".files-search-result__context").textContent = fileSearchContext(file);
    makeFileDraggable(row, file.path, file.name || basename(file.path));
    row.addEventListener("mouseenter", () => setActiveFilesSearchIndex(index));
    row.addEventListener("click", () => void openFile(file.path));
    fragment.appendChild(row);
  });
  elements.filesSearchList.appendChild(fragment);
}

function fileSearchContext(file) {
  const displayPath = String(file?.displayPath || "").replace(/\\/g, "/");
  const parts = displayPath.split("/").filter(Boolean);
  if (parts.length) parts.pop();
  return parts.join("/");
}

function makeFileDraggable(element, path, name = basename(path)) {
  if (!element || !path) return;
  element.draggable = true;
  element.classList.add("local-file-drag-source");
  element.addEventListener("dragstart", (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    transfer.effectAllowed = "copy";
    transfer.setData(LOCAL_FILE_DRAG_MIME, JSON.stringify({
      version: 1,
      threadId,
      path,
      name: name || basename(path),
      project: state.currentWorkspace || "",
    }));
    transfer.setData("text/plain", path);
    element.classList.add("dragging");
  });
  element.addEventListener("dragend", () => element.classList.remove("dragging"));
}

function setActiveFilesSearchIndex(index) {
  const results = state.fileSearch.results;
  if (!results.length) return;
  state.fileSearch.activeIndex = Math.max(0, Math.min(results.length - 1, index));
  [...elements.filesSearchList.children].forEach((row, rowIndex) => {
    const active = rowIndex === state.fileSearch.activeIndex;
    row.classList.toggle("active", active);
    row.setAttribute("aria-selected", active ? "true" : "false");
  });
  elements.filesSearchList.children[state.fileSearch.activeIndex]?.scrollIntoView({ block: "nearest" });
}

function moveFilesSearchSelection(delta) {
  if (!state.fileSearch.results.length) return;
  const next = (state.fileSearch.activeIndex + delta + state.fileSearch.results.length) % state.fileSearch.results.length;
  setActiveFilesSearchIndex(next);
}

function clearFilesSearch() {
  state.fileSearch.controller?.abort();
  state.fileSearch.controller = null;
  clearTimeout(state.fileSearch.timer);
  state.fileSearch.query = "";
  state.fileSearch.results = [];
  state.fileSearch.activeIndex = 0;
  elements.filesSearchInput.value = "";
  renderFilesSearch();
}

function focusFilesSearch({ select = false } = {}) {
  if (state.leftMode !== "files" || state.workspace.treeCollapsed || !elements.filesSearchInput) return;
  requestAnimationFrame(() => {
    if (state.leftMode !== "files" || state.workspace.treeCollapsed) return;
    elements.filesSearchInput.focus({ preventScroll: true });
    if (select && elements.filesSearchInput.value) elements.filesSearchInput.select();
  });
}

function scheduleWorkspaceSearch() {
  clearTimeout(state.search.timer);
  state.search.timer = setTimeout(() => void runWorkspaceSearch(), 170);
}

async function runWorkspaceSearch() {
  const query = String(elements.workspaceSearchInput.value || "").trim().slice(0, 300);
  state.search.query = query;
  state.search.controller?.abort();
  if (!query) {
    state.search.results = [];
    renderWorkspaceSearch();
    return;
  }
  const sequence = ++state.search.sequence;
  const controller = new AbortController();
  state.search.controller = controller;
  elements.workspaceSearchStatus.textContent = "Searching…";
  try {
    const payload = await bridgeRequest("/local-ui/files/content-search", {
      threadId,
      query,
      active: state.hostActive,
      workspaceOnly: true,
    }, { signal: controller.signal });
    if (sequence !== state.search.sequence || controller.signal.aborted) return;
    state.search.results = Array.isArray(payload.matches) ? payload.matches : [];
    renderWorkspaceSearch(payload);
  } catch (error) {
    if (controller.signal.aborted || sequence !== state.search.sequence) return;
    state.search.results = [];
    elements.workspaceSearchResults.replaceChildren();
    elements.workspaceSearchStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.search.controller === controller) state.search.controller = null;
  }
}

function renderWorkspaceSearch(payload = null) {
  const query = state.search.query;
  const results = state.search.results;
  elements.workspaceSearchResults.replaceChildren();
  if (!query) {
    elements.workspaceSearchStatus.textContent = "Type to search across project files.";
    return;
  }
  const total = Number(payload?.total);
  const count = Number.isFinite(total) ? total : results.length;
  elements.workspaceSearchStatus.textContent = results.length
    ? `${count} result${count === 1 ? "" : "s"}${payload?.truncated ? " · showing first matches" : ""}`
    : "No matches";
  const fragment = document.createDocumentFragment();
  for (const match of results) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "workspace-search-result ls-ui-list-row";
    const pathNode = document.createElement("span");
    pathNode.className = "workspace-search-result__path";
    pathNode.textContent = match.displayPath || match.relative || match.name || "";
    const lineNode = document.createElement("span");
    lineNode.className = "workspace-search-result__line";
    lineNode.textContent = `:${Number(match.line) || 1}`;
    const previewNode = document.createElement("span");
    previewNode.className = "workspace-search-result__preview";
    previewNode.textContent = match.preview || "";
    row.append(pathNode, lineNode, previewNode);
    row.addEventListener("click", () => {
      const length = typeof match.match === "string" ? match.match.length : null;
      openFile(match.path, match.line, match.column, length);
    });
    fragment.appendChild(row);
  }
  elements.workspaceSearchResults.appendChild(fragment);
}

function installListeners() {
  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes?.[UI_VISIBILITY_STORAGE_KEY]) {
      state.uiVisibility = globalThis.LocalSystemSharedRuntime.normalizeUiVisibility(changes[UI_VISIBILITY_STORAGE_KEY].newValue);
      renderUiVisibilitySettings();
    }
    if (changes?.[COMPLETION_SOUND_ENABLED_STORAGE_KEY]) {
      state.completionSoundEnabled = changes[COMPLETION_SOUND_ENABLED_STORAGE_KEY].newValue !== false;
      renderCompletionSoundSetting();
    }
  });

  globalThis.addEventListener("message", (event) => {
    if (event.data?.source !== "local-system-host") return;
    if (event.data.theme) applyTheme(event.data.theme);
    if (typeof event.data.active === "boolean") {
      const becameActive = event.data.active === true && state.hostActive !== true;
      state.hostActive = event.data.active;
      syncLiveWatchState();
      if (becameActive && Date.now() - state.git.loadedAt > 2_500) void loadGitStatus();
      if (becameActive && PRESENTATION === "standalone" && HOST_MODE === "sidepanel") focusFilesSearch({ select: true });
    }
    if (event.data.action === "host-width" && Number.isFinite(Number(event.data.width))) {
      state.workspace.width = Number(event.data.width);
    }
    if (event.data.action === "host-layout") {
      if (Number.isFinite(Number(event.data.width))) state.workspace.width = Number(event.data.width);
      if (typeof event.data.mobile === "boolean") {
        mobileStandalone = event.data.mobile === true;
        document.documentElement.dataset.mobileStandalone = mobileStandalone ? "true" : "false";
      }
      applyPaneLayout();
    }
    if (event.data.action === "reveal-workspace") revealHydratedWorkspace();
    if (event.data.action === "open-file" && typeof event.data.path === "string") {
      void traceWorkspace("workspace.open-file.message", {
        path: event.data.path,
        data: { line: event.data.line, column: event.data.column, length: event.data.length },
      });
      void openFile(
        event.data.path,
        event.data.line,
        event.data.column,
        event.data.length,
        { restoreFocus: event.data.restoreFocus === true },
      );
    }
    if (event.data.action === "restore-focus") restoreWorkspaceFocus();
    if (event.data.action === "open-search") void openWorkspaceMode("search");
    if (event.data.action === "open-mode") void openWorkspaceMode(event.data.mode);
    if (event.data.action === "close-sidebar") void closeSidebar();
    if (event.data.action === "toggle-sidebar") toggleSidebar();
    if (event.data.action === "toggle-project-pane") void toggleTreePane();
    if (event.data.action === "project-changed") {
      void refreshProjectContext({ openFiles: event.data.openFiles === true });
    }
    if (event.data.action === "refresh-annotations") refreshWorkspaceAnnotations();
  });

  globalThis.addEventListener("resize", applyPaneLayout);

  globalThis.addEventListener("keydown", (event) => {
    if (handleMediaSpaceShortcut(event)) return;
    if (handleMediaSeekShortcut(event)) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "-" || event.code === "Minus")) {
      event.preventDefault();
      event.stopPropagation();
      void navigateCodeHistory(event.shiftKey ? 1 : -1);
      return;
    }
    if (event.key === "F12" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) findReferencesAtCursor();
      else void goToDefinitionAtCursor();
      return;
    }
    if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s" && state.fileEdit?.path === state.workspace.activePath) {
      event.preventDefault();
      event.stopPropagation();
      saveFileEdit();
      return;
    }
    if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      openFileFind();
      return;
    }
    if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      event.stopImmediatePropagation();
      parent.postMessage({ source: "local-system-file-workspace", action: "toggle-left-sidebar" }, "*");
      return;
    }
    if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      event.stopPropagation();
      requestQuickOpen("files");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      void ensureLeftPane("search");
      return;
    }
    if (event.key === "Escape") {
      if (!elements.uiSettingsPopover.hidden) {
        event.preventDefault();
        setUiSettingsOpen(false);
        return;
      }
      if (!elements.fileFindBar.hidden) {
        event.preventDefault();
        closeFileFind();
        return;
      }
      if (state.markdownBlockEdit && elements.markdownRendered.contains(event.target)) {
        event.preventDefault();
        cancelMarkdownBlockEdit();
        return;
      }
      if (state.fileEdit?.path === state.workspace.activePath && state.fileEdit.dirty) {
        event.preventDefault();
        cancelFileEdit();
        return;
      }
      hideSelectionAction();
      hideAnnotationEditor();
    }
  }, true);

  elements.projectEdit.addEventListener("click", requestProjectPicker);
  elements.uiSettingsToggle.addEventListener("click", () => {
    setUiSettingsOpen(elements.uiSettingsPopover.hidden);
  });
  elements.uiSettingsPopover.addEventListener("change", (event) => {
    const input = event.target?.closest?.("[data-ui-setting]");
    if (input) {
      void updateUiVisibilitySetting(input.dataset.uiSetting, input.checked);
      return;
    }
    const editorInput = event.target?.closest?.("[data-editor-setting]");
    if (editorInput) {
      void updateEditorPreference(editorInput.dataset.editorSetting, editorInput.checked);
      return;
    }
    const completionInput = event.target?.closest?.("[data-completion-setting]");
    if (completionInput?.dataset.completionSetting === "sound") {
      void updateCompletionSoundSetting(completionInput.checked);
      return;
    }
    const checkpointInput = event.target?.closest?.("[data-checkpoint-setting]");
    if (checkpointInput?.dataset.checkpointSetting === "enabled") {
      void updateTurnCheckpointSettings({ enabled: checkpointInput.checked });
      return;
    }
    if (checkpointInput?.dataset.checkpointSetting === "intervalMinutes") {
      void updateTurnCheckpointSettings({ intervalMinutes: Number(checkpointInput.value) });
    }
  });
  elements.hideCurrentSite.addEventListener("click", () => void hideSidePanelOnCurrentSite());
  elements.hiddenSitesList.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-enable-site]");
    if (!button) return;
    void enableHiddenSidePanelSite(button.dataset.enableSite, button);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!elements.uiSettingsPopover.hidden) {
      if (!elements.uiSettingsPopover.contains(event.target) && !elements.uiSettingsToggle.contains(event.target)) {
        setUiSettingsOpen(false);
      }
    }
  }, true);

  elements.projectName.addEventListener("click", requestProjectPicker);
  elements.leftModeFiles.addEventListener("click", () => void refreshProjectFiles({ open: false }));
  elements.leftModeGit.addEventListener("click", () => void ensureLeftPane("git", { open: false }));
  elements.fullTextSearch.addEventListener("click", () => void ensureLeftPane("search", { open: false }));
  elements.filesSearchInput.addEventListener("input", scheduleFilesSearch);
  elements.filesSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      clearFilesSearch();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFilesSearchSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFilesSearchSelection(-1);
      return;
    }
    if (event.key === "Enter") {
      const file = state.fileSearch.results[state.fileSearch.activeIndex];
      if (!file) return;
      event.preventDefault();
      void openFile(file.path);
    }
  });
  elements.workspaceSearchInput.addEventListener("input", scheduleWorkspaceSearch);
  elements.workspaceSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    elements.workspaceSearchInput.value = "";
    state.search.query = "";
    state.search.results = [];
    renderWorkspaceSearch();
  });
  elements.closeSidebar.addEventListener("click", closeSidebar);
  elements.gitChangesToggle.addEventListener("click", () => {
    state.git.expanded = !state.git.expanded;
    renderGitChanges();
  });
  elements.treeToggle.addEventListener("click", toggleTreePane);
  paneHover.bind();
  elements.paneSplitter.addEventListener("pointerdown", startPaneResize);
  elements.paneSplitter.addEventListener("keydown", handlePaneSplitterKeydown);
  installHorizontalScrollTrap(elements.scroll);
  installHorizontalScrollTrap(elements.fileEditor);
  installHorizontalScrollTrap(elements.diffViewer);
  installHorizontalScrollTrap(elements.markdownRendered);
  elements.cancelFileEdit.addEventListener("click", cancelFileEdit);
  elements.saveFileEdit.addEventListener("click", saveFileEdit);
  elements.refreshFile.addEventListener("click", refreshActiveFile);
  elements.copyAnnotations.addEventListener("click", copyActiveFileAnnotations);
  elements.fileFindClose.addEventListener("click", closeFileFind);
  elements.fileFindPrevious.addEventListener("click", () => moveFileFind(-1));
  elements.fileFindNext.addEventListener("click", () => moveFileFind(1));
  elements.fileFindInput.addEventListener("input", updateFileFind);
  elements.fileFindInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveFileFind(event.shiftKey ? -1 : 1);
    }
  });
  elements.previewFile.addEventListener("click", togglePreview);
  elements.wrapText.addEventListener("click", toggleTextWrap);
  elements.copyPath.addEventListener("click", copyActivePath);
  elements.scroll.addEventListener("scroll", () => {
    rememberActiveScroll(elements.scroll.scrollTop);
    scheduleAnnotationMarkers();
    hideSelectionAction();
  }, { passive: true });
  elements.markdownRendered.addEventListener("click", handleMarkdownRenderedClick);
  elements.markdownRendered.addEventListener("keydown", handleMarkdownRenderedKeydown);
  elements.markdownRendered.addEventListener("scroll", () => {
    rememberActiveScroll(elements.markdownRendered.scrollTop);
    scheduleAnnotationMarkers();
    hideSelectionAction();
  }, { passive: true });
  elements.fileEditor.addEventListener("input", updateFileEdit);
  elements.fileEditor.addEventListener("scroll", () => {
    rememberActiveScroll(elements.fileEditor.scrollTop);
    syncEditMirrorScroll();
    scheduleGitGutterMarkers();
    scheduleAnnotationMarkers();
    hideSelectionAction();
  }, { passive: true });
  globalThis.addEventListener("pagehide", () => {
    flushActiveScrollPersistence();
    liveSync.stop();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushActiveScrollPersistence();
    syncLiveWatchState();
  });
  elements.fileEditor.addEventListener("mouseup", (event) => {
    handleEditorSelection(event);
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      event.preventDefault();
      void goToDefinitionAtCursor();
    }
  });
  elements.fileEditor.addEventListener("keyup", (event) => {
    if (event.shiftKey) handleEditorSelection();
  });
  elements.fileEditor.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const start = elements.fileEditor.selectionStart;
    const end = elements.fileEditor.selectionEnd;
    elements.fileEditor.setRangeText("  ", start, end, "end");
    updateFileEdit();
  });

  if (typeof globalThis.ResizeObserver === "function" && elements.fileEditor?.nodeType === 1) {
    state.editResizeObserver = new globalThis.ResizeObserver(() => {
      if (!state.wrapText || state.fileEdit?.path !== state.workspace.activePath) return;
      if (state.resizeStart) return;
      scheduleEditLineNumbers(elements.fileEditor.value);
      scheduleGitGutterMarkers();
      if (!state.fileEdit?.dirty) scheduleAnnotationMarkers();
    });
    state.editResizeObserver.observe(elements.fileEditor);
  }

  document.addEventListener("selectionchange", () => {
    clearTimeout(handleSelection.timer);
    handleSelection.timer = setTimeout(handleSelection, 80);
  });
  document.addEventListener("pointerdown", (event) => {
    if (elements.annotationEditor.contains(event.target) || elements.annotateSelection.contains(event.target) || event.target.closest?.(".annotation-marker")) return;
    hideSelectionAction();
    if (!elements.annotationEditor.hidden) hideAnnotationEditor();
  }, true);

  elements.annotateSelection.addEventListener("click", () => {
    if (state.selectionDraft) openAnnotationEditor({ draft: state.selectionDraft });
  });
  elements.saveAnnotation.addEventListener("click", saveAnnotation);
  elements.saveExistingAnnotation.addEventListener("click", saveAnnotation);
  elements.cancelAnnotation.addEventListener("click", hideAnnotationEditor);
  elements.deleteAnnotation.addEventListener("click", deleteEditingAnnotation);
  elements.annotationComment.addEventListener("input", () => resizeAnnotationInput(elements.annotationComment));
  elements.annotationComment.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideAnnotationEditor();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void saveAnnotation();
    }
  });

  elements.resizeHandle.addEventListener("pointerdown", startResize);
}

function installHorizontalScrollTrap(element) {
  if (!element) return;
  element.addEventListener("wheel", (event) => {
    const deltaX = Number(event.deltaX) || 0;
    const deltaY = Number(event.deltaY) || 0;
    if (Math.abs(deltaX) < 0.5 || Math.abs(deltaX) < Math.abs(deltaY)) return;
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    if (maxScrollLeft <= 0) return;
    event.preventDefault();
    element.scrollLeft = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft + deltaX));
  }, { passive: false });
}

function toggleTextWrap() {
  const next = !state.wrapText;
  if (state.workspace.activePath) state.wrapOverrideByPath.set(state.workspace.activePath, next);
  applyTextWrap(next);
}

function applyTextWrap(enabled) {
  state.wrapText = enabled === true;
  elements.workspace.classList.toggle("wrap-text", state.wrapText);
  elements.wrapText.setAttribute("aria-pressed", state.wrapText ? "true" : "false");
  elements.wrapText.title = state.wrapText ? "Disable text wrapping" : "Wrap text";
  elements.wrapText.setAttribute("aria-label", state.wrapText ? "Disable text wrapping" : "Wrap text");
  if (state.fileEdit?.path === state.workspace.activePath) scheduleEditLineNumbers(elements.fileEditor.value);
  if (state.workspace.activePath && !state.fileEdit?.dirty) scheduleAnnotationMarkers();
}

function defaultWrapForPath(filePath) {
  const ext = extensionFor(filePath);
  return DEFAULT_WRAP_EXTENSIONS.has(ext);
}

async function refreshWorkspaceAnnotations() {
  try {
    const payload = await workspaceRequest("get", {});
    if (!payload.bound) return false;
    state.workspace.annotations = Array.isArray(payload.workspace?.annotations) ? payload.workspace.annotations : [];
    renderActiveAnnotations();
    postAnnotations();
    return true;
  } catch {
    // Keep the current local view if the bridge briefly disappears.
    return false;
  }
}

async function copyActiveFileAnnotations() {
  const path = state.workspace.activePath;
  if (!path) return;
  const annotations = state.workspace.annotations.filter((item) => item.path === path);
  const mediaNotes = (state.workspace.mediaNotes || []).filter((item) => item.path === path);
  const count = annotations.length + mediaNotes.length;
  const originalTitle = elements.copyAnnotations.title;
  try {
    await navigator.clipboard.writeText(formatFileAnnotationsForClipboard(path, annotations, mediaNotes));
    showCopySuccess(
      elements.copyAnnotations,
      count ? `Copied ${count} annotation${count === 1 ? "" : "s"}` : "No annotations to copy",
      originalTitle,
    );
  } catch {
    // Clipboard access can be denied by browser policy; keep the viewer usable.
  }
}

function formatFileAnnotationsForClipboard(path, annotations, mediaNotes = []) {
  if (!annotations.length && !mediaNotes.length) return `[Annotations]\nFile: ${path}\nNo annotations.\n[/Annotations]`;
  const lines = ["[Annotations]", `File: ${path}`];
  let index = 0;
  annotations.forEach((annotation) => {
    index += 1;
    const start = annotation.start || {};
    const end = annotation.end || {};
    const location = start.line
      ? `L${start.line}:${start.column || 1}${end.line ? `-${end.line}:${end.column || 1}` : ""}`
      : "selected text";
    lines.push("");
    lines.push(`${index}. ${location}`);
    lines.push(`Selected text: ${JSON.stringify(annotation.quote || "")}`);
    lines.push(`Comment: ${annotation.comment || ""}`);
  });
  mediaNotes
    .slice()
    .sort((a, b) => Number(a.time) - Number(b.time))
    .forEach((note) => {
      index += 1;
      const timestamp = formatMediaTimestamp(note.time);
      lines.push("");
      lines.push(`Timestamp: ${timestamp}`);
      lines.push(`Comment: ${note.comment || ""}`);
    });
  lines.push("[/Annotations]");
  return lines.join("\n");
}

async function openFile(path, line = null, column = null, length = null, { restoreFocus = false } = {}) {
  let normalized = String(path || "").trim();
  if (!normalized) return;
  const wasDiff = state.diff.active;
  state.diff.active = false;
  if (!isAbsoluteFilePath(normalized)) {
    try {
      const descriptor = await bridgeRequest("/local-ui/files/resolve", {
        threadId,
        path: normalized,
        active: state.hostActive,
      });
      if (typeof descriptor.path === "string" && descriptor.path) normalized = descriptor.path;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Could not resolve local file.");
      return;
    }
  }
  const revealLine = Number(line);
  const revealColumn = Number(column);
  const revealLength = Number(length);
  if (!state.codeNavigation.restoring) {
    rememberCodeNavigationOrigin(normalized, revealLine, revealColumn);
  }
  if (Number.isInteger(revealLine) && revealLine > 0) {
    state.revealLineByPath.set(normalized, {
      line: revealLine,
      column: Number.isInteger(revealColumn) && revealColumn > 0 ? revealColumn : 1,
      length: Number.isInteger(revealLength) && revealLength > 0 ? revealLength : 0,
    });
  }
  if (normalized === state.workspace.activePath) {
    state.workspace = await persistWorkspace({
      openPaths: state.workspace.openPaths,
      activePath: normalized,
      sidebarOpen: persistedSidebarOpen(true),
      width: state.workspace.width,
    });
    applyPaneLayout();
    setVisible(true);
    closeMobileLeftPane();
    if (wasDiff || !state.fileEdit) await showPath(normalized);
    else revealPendingLine(normalized);
    if (restoreFocus) restoreWorkspaceFocus();
    return;
  }
  if (!prepareToLeaveFileEdit()) return;
  const openPaths = state.workspace.openPaths.filter((item) => item !== normalized);
  openPaths.push(normalized);
  while (openPaths.length > 12) {
    const removed = openPaths.shift();
    releaseFile(removed);
  }
  state.workspace = await persistWorkspace({
    openPaths,
    activePath: normalized,
    sidebarOpen: persistedSidebarOpen(true),
    width: state.workspace.width,
  });
  applyPaneLayout();
  setVisible(true);
  closeMobileLeftPane();
  renderTabs();
  markActiveTreeFile(normalized);
  await showPath(normalized);
  if (restoreFocus) restoreWorkspaceFocus();
}

function isAbsoluteFilePath(value) {
  const input = String(value || "");
  return input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input);
}

function captureCodeLocation() {
  const path = state.workspace.activePath;
  if (!path || state.fileEdit?.path !== path) return null;
  const text = elements.fileEditor.value;
  const start = Math.max(0, Math.min(text.length, Number(elements.fileEditor.selectionStart) || 0));
  const end = Math.max(start, Math.min(text.length, Number(elements.fileEditor.selectionEnd) || start));
  const position = positionForOffset(text, start);
  return { path, line: position.line, column: position.column, length: end - start };
}

function sameCodeLocation(a, b) {
  return Boolean(a && b && a.path === b.path && a.line === b.line && a.column === b.column);
}

function rememberCodeNavigationOrigin(targetPath, targetLine, targetColumn) {
  const current = captureCodeLocation();
  if (!current) return;
  const target = {
    path: targetPath,
    line: Number.isInteger(targetLine) && targetLine > 0 ? targetLine : null,
    column: Number.isInteger(targetColumn) && targetColumn > 0 ? targetColumn : null,
  };
  if (current.path === target.path && (!target.line || (current.line === target.line && current.column === target.column))) return;
  const last = state.codeNavigation.back.at(-1);
  if (!sameCodeLocation(last, current)) state.codeNavigation.back.push(current);
  if (state.codeNavigation.back.length > 120) state.codeNavigation.back.shift();
  state.codeNavigation.forward.length = 0;
}

async function navigateCodeHistory(direction) {
  if (state.codeNavigation.restoring) return;
  const backward = direction < 0;
  const source = backward ? state.codeNavigation.back : state.codeNavigation.forward;
  const destination = backward ? state.codeNavigation.forward : state.codeNavigation.back;
  const target = source.pop();
  if (!target) return;
  const current = captureCodeLocation();
  if (current && !sameCodeLocation(current, target)) destination.push(current);
  state.codeNavigation.restoring = true;
  try {
    await openFile(target.path, target.line, target.column, target.length || 0);
  } finally {
    state.codeNavigation.restoring = false;
  }
}

function identifierAtEditorCursor() {
  const text = elements.fileEditor.value;
  let start = Math.max(0, Math.min(text.length, Number(elements.fileEditor.selectionStart) || 0));
  let end = Math.max(start, Math.min(text.length, Number(elements.fileEditor.selectionEnd) || start));
  if (end > start) {
    const selected = text.slice(start, end).trim();
    return isCodeIdentifier(selected) ? selected : "";
  }
  if (start === text.length && start > 0) start -= 1;
  if (!isCodeIdentifierChar(text[start]) && start > 0 && isCodeIdentifierChar(text[start - 1])) start -= 1;
  if (!isCodeIdentifierChar(text[start])) return "";
  let left = start;
  let right = start + 1;
  while (left > 0 && isCodeIdentifierChar(text[left - 1])) left -= 1;
  while (right < text.length && isCodeIdentifierChar(text[right])) right += 1;
  const symbol = text.slice(left, right);
  return isCodeIdentifier(symbol) ? symbol : "";
}

function isCodeIdentifier(value) {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(String(value || ""));
}

function isCodeIdentifierChar(value) {
  return typeof value === "string" && value.length > 0 && /^[\p{L}\p{N}_$]$/u.test(value);
}

async function goToDefinitionAtCursor() {
  const symbol = identifierAtEditorCursor();
  if (!symbol || state.codeNavigation.busy || !state.currentWorkspace) return;
  state.codeNavigation.busy = true;
  setFileEditStatus(`Finding ${symbol}…`);
  try {
    const payload = await bridgeRequest("/local-ui/files/content-search", {
      threadId,
      query: symbol,
      active: state.hostActive,
      workspaceOnly: true,
    });
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    const target = bestDefinitionMatch(symbol, matches);
    if (!target) {
      setFileEditStatus(matches.length ? `No clear definition for ${symbol}` : `No definition for ${symbol}`);
      if (matches.length > 1) requestQuickOpen("text", symbol);
      return;
    }
    await openFile(target.path, target.line, target.column, String(target.match || symbol).length || symbol.length);
    setFileEditStatus("");
  } catch (error) {
    setFileEditStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.codeNavigation.busy = false;
  }
}

function findReferencesAtCursor() {
  const symbol = identifierAtEditorCursor();
  if (!symbol) return;
  requestQuickOpen("text", symbol);
}

function bestDefinitionMatch(symbol, matches) {
  const escaped = escapeRegExp(symbol);
  const declaration = new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum|namespace|def|func|fn|struct|trait|protocol|record|module)\\s+${escaped}\\b`, "iu");
  const assigned = new RegExp(`\\b${escaped}\\s*(?::[^=\\n]+)?=`, "iu");
  const property = new RegExp(`\\b${escaped}\\s*:\\s*(?:function|async|\\([^)]*\\)\\s*=>)`, "iu");
  const exact = new RegExp(`(^|[^\\p{L}\\p{N}_$])${escaped}([^\\p{L}\\p{N}_$]|$)`, "iu");
  const current = captureCodeLocation();
  const ranked = matches.map((match) => {
    const preview = String(match.preview || "");
    let score = exact.test(preview) ? 10 : -100;
    if (declaration.test(preview)) score += 120;
    else if (assigned.test(preview) || property.test(preview)) score += 75;
    if (/^\s*(?:import|from|require\b)/iu.test(preview)) score -= 45;
    if (current && match.path === current.path && Number(match.line) === current.line) score -= 80;
    if (String(match.name || "").toLowerCase().includes(symbol.toLowerCase())) score += 4;
    return { ...match, score };
  }).filter((match) => match.score > -50).sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked[0].score >= 70) return ranked[0];
  return ranked.length === 1 ? ranked[0] : null;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function revealPendingLine(path) {
  const target = state.revealLineByPath.get(path);
  if (!target || state.fileEdit?.path !== path) return false;
  state.revealLineByPath.delete(path);
  const text = elements.fileEditor.value;
  const lines = text.split("\n");
  const lineIndex = Math.max(0, Math.min(lines.length - 1, target.line - 1));
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) offset += lines[index].length + 1;
  offset += Math.max(0, Math.min(lines[lineIndex]?.length || 0, target.column - 1));
  const selectionEnd = Math.min(text.length, offset + Math.max(0, Number(target.length) || 0));
  elements.fileEditor.setSelectionRange(offset, selectionEnd);
  const lineTop = lineIndex * state.codeLineHeight;
  elements.fileEditor.scrollTop = Math.max(0, lineTop - elements.fileEditor.clientHeight * 0.28);
  syncEditMirrorScroll();
  scheduleAnnotationMarkers();
  elements.fileEditor.focus({ preventScroll: true });
  return true;
}

function markdownPreviewVisible() {
  return markdownPreviewEnabled(state.workspace.activePath) && !elements.markdownRendered.hidden;
}

function revealSourceRange(start, end, { query = "", allMatches = [], focusEditor = false } = {}) {
  const text = elements.fileEditor.value;
  const safeStart = Math.max(0, Math.min(text.length, Number(start) || 0));
  const safeEnd = Math.max(safeStart, Math.min(text.length, Number(end) || safeStart));
  clearFileFindHighlights();

  if (markdownPreviewVisible()) {
    revealMarkdownSourceRange(text, safeStart, safeEnd, query, allMatches);
    return;
  }

  const allRanges = allMatches
    .map((match) => rangeFromOffsets(elements.editCode, match.start, match.end))
    .filter(Boolean);
  if (allRanges.length && CSS?.highlights) CSS.highlights.set(FILE_FIND_ALL_HIGHLIGHT, new Highlight(...allRanges));
  if (safeEnd > safeStart && CSS?.highlights) {
    const currentRange = rangeFromOffsets(elements.editCode, safeStart, safeEnd);
    if (currentRange) CSS.highlights.set(FILE_FIND_CURRENT_HIGHLIGHT, new Highlight(currentRange));
  }

  elements.fileEditor.setSelectionRange(safeStart, safeEnd);
  const { line } = positionForOffset(text, safeStart);
  const lineTop = Math.max(0, line - 1) * state.codeLineHeight;
  elements.fileEditor.scrollTop = Math.max(0, lineTop - elements.fileEditor.clientHeight * 0.28);
  syncEditMirrorScroll();
  scheduleAnnotationMarkers();
  if (focusEditor) elements.fileEditor.focus({ preventScroll: true });
}

function revealMarkdownSourceRange(text, start, end, query, allMatches) {
  if (query && allMatches.length && CSS?.highlights) {
    const renderedRanges = rangesForLiteralText(elements.markdownRendered, query, 1_500);
    if (renderedRanges.length) CSS.highlights.set(FILE_FIND_ALL_HIGHLIGHT, new Highlight(...renderedRanges));
  }

  const blocks = [...elements.markdownRendered.querySelectorAll(".markdown-editable-block")];
  let block = blocks.find((candidate) => {
    const blockStart = Number(candidate.dataset.markdownStart);
    const blockEnd = Number(candidate.dataset.markdownEnd);
    return Number.isInteger(blockStart) && Number.isInteger(blockEnd) && start >= blockStart && start <= blockEnd;
  });
  if (!block && blocks.length) {
    block = blocks.find((candidate) => Number(candidate.dataset.markdownStart) > start) || blocks.at(-1);
  }
  if (!block) return;

  block.classList.add("file-find-target");
  const needle = text.slice(start, end) || query;
  const currentRange = renderedRangeForSourceMatch(block, text, start, needle);
  if (currentRange && CSS?.highlights) {
    CSS.highlights.set(FILE_FIND_CURRENT_HIGHLIGHT, new Highlight(currentRange));
  }
  block.scrollIntoView({ block: "center", inline: "nearest" });
}

function renderedRangeForSourceMatch(block, source, sourceStart, needle) {
  const value = String(needle || "");
  if (!value) return null;
  const blockStart = Number(block.dataset.markdownStart);
  const blockEnd = Number(block.dataset.markdownEnd);
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return null;
  const sourceBlock = source.slice(blockStart, blockEnd).toLowerCase();
  const lowerNeedle = value.toLowerCase();
  const relativeStart = Math.max(0, sourceStart - blockStart);
  let ordinal = 0;
  let cursor = 0;
  while (cursor < relativeStart) {
    const found = sourceBlock.indexOf(lowerNeedle, cursor);
    if (found < 0 || found >= relativeStart) break;
    ordinal += 1;
    cursor = found + Math.max(1, lowerNeedle.length);
  }
  const renderedText = (block.textContent || "").toLowerCase();
  const renderedStart = nthLiteralIndex(renderedText, lowerNeedle, ordinal);
  if (renderedStart < 0) return null;
  return rangeFromOffsets(block, renderedStart, renderedStart + value.length);
}

function nthLiteralIndex(text, needle, ordinal) {
  if (!needle) return -1;
  let cursor = 0;
  for (let index = 0; index <= ordinal; index += 1) {
    const found = text.indexOf(needle, cursor);
    if (found < 0) return -1;
    if (index === ordinal) return found;
    cursor = found + Math.max(1, needle.length);
  }
  return -1;
}

function rangesForLiteralText(root, query, limit = 1_000) {
  const needle = String(query || "").toLowerCase();
  if (!needle) return [];
  const text = (root.textContent || "").toLowerCase();
  const ranges = [];
  let cursor = 0;
  while (cursor <= text.length && ranges.length < limit) {
    const index = text.indexOf(needle, cursor);
    if (index < 0) break;
    const range = rangeFromOffsets(root, index, index + needle.length);
    if (range) ranges.push(range);
    cursor = index + Math.max(1, needle.length);
  }
  return ranges;
}

function clearFileFindHighlights() {
  CSS?.highlights?.delete(FILE_FIND_ALL_HIGHLIGHT);
  CSS?.highlights?.delete(FILE_FIND_CURRENT_HIGHLIGHT);
  elements.markdownRendered.querySelectorAll(".file-find-target").forEach((node) => node.classList.remove("file-find-target"));
}

function openFileFind() {
  const path = state.workspace.activePath;
  const file = state.files.get(path);
  if (!path || file?.kind !== "text") return;

  if (state.markdownBlockEdit?.path === path) {
    const text = materializeMarkdownBlockEdit();
    syncFileEditState(text, { showAnnotations: false });
    state.markdownBlockEdit = null;
    if (markdownPreviewEnabled(path)) showMarkdownPreview(text);
  }

  elements.fileFindBar.hidden = false;
  elements.fileFindInput.value = state.fileFind.query;
  updateFileFind();
  elements.fileFindInput.focus({ preventScroll: true });
  elements.fileFindInput.select();
}

function closeFileFind() {
  elements.fileFindBar.hidden = true;
  clearFileFindHighlights();
}

function updateFileFind() {
  const query = elements.fileFindInput.value;
  const changed = query !== state.fileFind.query;
  state.fileFind.query = query;
  const text = elements.fileEditor.value;
  state.fileFind.matches = findLiteralMatches(text, query);
  if (!state.fileFind.matches.length) {
    state.fileFind.activeIndex = -1;
    elements.fileFindCount.textContent = "0/0";
    clearFileFindHighlights();
    return;
  }
  if (changed || state.fileFind.activeIndex < 0 || state.fileFind.activeIndex >= state.fileFind.matches.length) {
    state.fileFind.activeIndex = 0;
  }
  revealActiveFileFind();
}

function findLiteralMatches(text, query, limit = 5_000) {
  const needle = String(query || "").toLowerCase();
  if (!needle) return [];
  const haystack = String(text || "").toLowerCase();
  const matches = [];
  let cursor = 0;
  while (cursor <= haystack.length && matches.length < limit) {
    const start = haystack.indexOf(needle, cursor);
    if (start < 0) break;
    matches.push({ start, end: start + needle.length });
    cursor = start + Math.max(1, needle.length);
  }
  return matches;
}

function moveFileFind(delta) {
  if (elements.fileFindBar.hidden) {
    openFileFind();
    return;
  }
  const matches = state.fileFind.matches;
  if (!matches.length) return;
  state.fileFind.activeIndex = (state.fileFind.activeIndex + delta + matches.length) % matches.length;
  revealActiveFileFind();
}

function revealActiveFileFind() {
  const matches = state.fileFind.matches;
  if (!matches.length || state.fileFind.activeIndex < 0) return;
  const match = matches[state.fileFind.activeIndex];
  elements.fileFindCount.textContent = `${state.fileFind.activeIndex + 1}/${matches.length}`;
  revealSourceRange(match.start, match.end, {
    query: state.fileFind.query,
    allMatches: matches,
    focusEditor: false,
  });
}

async function closeTab(path, kind = "file") {
  if (!path) return;
  if (kind === "diff" && state.diff.path === path) {
    const wasActive = state.diff.active;
    state.diff.active = false;
    state.diff.path = "";
    state.diff.payload = null;
    renderTabs();
    if (wasActive) {
      if (state.workspace.activePath) await showPath(state.workspace.activePath);
      else showMessage("Select a file from Files or use ⌘P.");
    }
    return;
  }
  const scrollTop = activeFileScrollTop();
  if (state.fileEdit?.path === path && !prepareToLeaveFileEdit()) return;
  if (path === state.workspace.activePath) state.scrollByPath.set(path, scrollTop);
  const openPaths = state.workspace.openPaths.filter((item) => item !== path);
  const index = state.workspace.openPaths.indexOf(path);
  const activePath = path === state.workspace.activePath
    ? (openPaths[Math.min(index, Math.max(0, openPaths.length - 1))] || "")
    : state.workspace.activePath;
  state.workspace = await persistWorkspace({
    openPaths,
    activePath,
    sidebarOpen: state.workspace.sidebarOpen,
    width: state.workspace.width,
  });
  releaseFile(path);
  renderTabs();
  if (!openPaths.length) {
    clearViewer();
    showMessage("Select a file from the project tree or use ⌘P.");
    setVisible(workspaceShouldBeVisible(state.workspace));
  } else if (activePath) {
    await showPath(activePath);
  }
}

async function activateTab(path, kind = "file") {
  if (!path) return;
  if (kind === "diff" && state.diff.path === path) {
    if (!prepareToLeaveFileEdit()) return;
    state.diff.active = true;
    renderTabs();
    await showGitDiff(path);
    return;
  }
  state.diff.active = false;
  if (path === state.workspace.activePath) {
    await showPath(path);
    return;
  }
  const scrollTop = activeFileScrollTop();
  if (!prepareToLeaveFileEdit()) return;
  if (state.workspace.activePath) state.scrollByPath.set(state.workspace.activePath, scrollTop);
  state.workspace = await persistWorkspace({
    openPaths: state.workspace.openPaths,
    activePath: path,
    sidebarOpen: persistedSidebarOpen(true),
    width: state.workspace.width,
  });
  applyPaneLayout();
  renderTabs();
  markActiveTreeFile(path);
  await showPath(path);
}

function markActiveTreeFile(path) {
  for (const row of elements.projectTree.querySelectorAll(".tree-row.active")) row.classList.remove("active");
  if (!path) return;
  for (const row of elements.projectTree.querySelectorAll(".tree-row[data-type=\"file\"]")) {
    if (row.dataset.path === path) {
      row.classList.add("active");
      break;
    }
  }
}

function activeFileScrollTop() {
  if (state.diff.active && !elements.diffViewer.hidden) return elements.diffViewer.scrollTop;
  if (!elements.markdownRendered.hidden && markdownPreviewEnabled(state.workspace.activePath)) {
    return elements.markdownRendered.scrollTop;
  }
  if (state.fileEdit?.path === state.workspace.activePath && !elements.editViewer.hidden) {
    return elements.fileEditor.scrollTop;
  }
  return elements.scroll.scrollTop;
}

function renderTabs() {
  elements.tabs.replaceChildren();
  const tabs = state.workspace.openPaths.map((path) => ({ path, kind: "file" }));
  if (state.diff.path) tabs.push({ path: state.diff.path, kind: "diff" });
  for (const { path, kind } of tabs) {
    const tab = document.createElement("div");
    const diffTab = kind === "diff";
    const active = diffTab
      ? state.diff.active && state.diff.path === path
      : !state.diff.active && path === state.workspace.activePath;
    tab.className = `tab ls-ui-list-row${active ? " active" : ""}${diffTab ? " diff-tab" : ""}`;
    if (!diffTab && state.fileEdit?.path === path && state.fileEdit.dirty) tab.classList.add("dirty");
    tab.setAttribute("role", "tab");
    tab.tabIndex = 0;
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.title = diffTab ? `${path} · Changes` : path;
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = diffTab ? `${basename(path)} · Changes` : basename(path);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.setAttribute("aria-label", diffTab ? `Close ${basename(path)} changes` : `Close ${basename(path)}`);
    close.title = "Close file";
    close.innerHTML = '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>';
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeTab(path, kind);
    });
    tab.append(name, close);
    if (!diffTab) makeFileDraggable(tab, path, basename(path));
    tab.addEventListener("click", () => activateTab(path, kind));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activateTab(path, kind);
    });
    elements.tabs.appendChild(tab);
  }
  elements.tabs.querySelector(".tab.active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

async function showPath(path) {
  state.diff.active = false;
  const sequence = ++state.loadSequence;
  const restoreScrollTop = state.scrollByPath.get(path) || 0;
  const restoreSequence = ++state.scrollRestoreSequence;
  state.restoringScroll = true;
  state.workspace.activePath = path;
  renderTabs();
  elements.fileActionBar.hidden = false;
  hideSelectionAction();
  hideAnnotationEditor();
  showFileLoadingSkeleton();
  try {
    const file = await loadFile(path);
    if (sequence !== state.loadSequence) return;
    state.activeDescriptor = file;
    if (file.kind === "text") {
      const wrap = state.wrapOverrideByPath.has(path)
        ? state.wrapOverrideByPath.get(path)
        : defaultWrapForPath(path);
      applyTextWrap(wrap);
      elements.wrapText.hidden = false;
      elements.previewFile.hidden = !isPreviewablePath(path);
      syncPreviewButton();
      renderTextFile(file);
      const revealed = revealPendingLine(path);
      if (revealed) finishScrollRestore(restoreSequence);
      else scheduleActiveScrollRestore(path, restoreScrollTop, restoreSequence);
    } else {
      elements.wrapText.hidden = true;
      elements.previewFile.hidden = true;
      renderMediaFile(file);
      finishScrollRestore(restoreSequence);
    }
  } catch (error) {
    if (sequence !== state.loadSequence) return;
    finishScrollRestore(restoreSequence);
    showMessage(error instanceof Error ? error.message : String(error));
  }
}

function scheduleActiveScrollRestore(path, scrollTop, restoreSequence) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (restoreSequence !== state.scrollRestoreSequence || path !== state.workspace.activePath) return;
      const value = Math.max(0, Number(scrollTop) || 0);
      if (!elements.markdownRendered.hidden && markdownPreviewEnabled(path)) {
        elements.markdownRendered.scrollTop = value;
      } else if (state.fileEdit?.path === path && !elements.editViewer.hidden) {
        elements.fileEditor.scrollTop = value;
        syncEditMirrorScroll();
      } else if (!elements.scroll.hidden) {
        elements.scroll.scrollTop = value;
      }
      requestAnimationFrame(() => finishScrollRestore(restoreSequence));
    });
  });
}

function finishScrollRestore(restoreSequence) {
  if (restoreSequence !== state.scrollRestoreSequence) return;
  state.restoringScroll = false;
}

async function loadFile(path) {
  const cached = state.files.get(path);
  if (cached) return cached;
  const descriptor = await bridgeRequest("/local-ui/files/resolve", { threadId, path, active: state.hostActive });
  const ext = extensionFor(path);
  const mime = descriptor.mimeType || "application/octet-stream";
  const kind = mediaKind(mime);
  if (kind === "video" || kind === "audio") {
    // Native media elements request byte ranges as needed; never buffer an entire video in JS.
    const file = { kind, path, descriptor, objectUrl: descriptor.url, mime };
    state.files.set(path, file);
    return file;
  }
  if (descriptor.bytes > 100 * 1024 * 1024) throw new Error("File is too large to preview.");
  const response = await fetch(descriptor.url, { cache: "no-store", signal: AbortSignal.timeout(6_000) });
  if (!response.ok) throw new Error(`File preview failed (HTTP ${response.status}).`);
  const blob = await response.blob();
  let file;
  if (isTextLike(path, mime)) {
    if (descriptor.bytes > MAX_TEXT_PREVIEW_BYTES) {
      file = { kind: "binary", path, descriptor, message: `Text file is ${(descriptor.bytes / (1024 * 1024)).toFixed(1)} MB. Preview is limited to 5 MB to keep ChatGPT responsive.` };
    } else {
      const text = await blob.text();
      file = { kind: "text", path, descriptor, text, language: languageFor(path, ext) };
    }
  } else {
    const objectUrl = URL.createObjectURL(blob);
    file = { kind: mediaKind(mime), path, descriptor, objectUrl, mime };
  }
  state.files.set(path, file);
  return file;
}

function renderTextFile(file) {
  state.activeText = file.text;
  elements.fileLoadingSkeleton.hidden = true;
  elements.loading.hidden = true;
  elements.diffViewer.hidden = true;
  elements.diffViewer.replaceChildren();
  elements.mediaViewer.hidden = true;
  elements.textViewer.hidden = false;
  elements.scroll.hidden = true;
  elements.editViewer.hidden = false;
  elements.markers.hidden = true;
  elements.mediaViewer.replaceChildren();
  elements.markdownRendered.hidden = true;
  stopHtmlPreview();
  elements.cancelFileEdit.hidden = true;
  elements.saveFileEdit.hidden = true;
  setFileEditStatus("");
  const lineCount = Math.max(1, file.text.split("\n").length);
  elements.lineNumbers.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");
  if (file.text.length <= MAX_HIGHLIGHT_CHARS && globalThis.LocalHighlighter) {
    elements.code.innerHTML = LocalHighlighter.highlight(file.text, file.language).html;
  } else {
    elements.code.textContent = file.text;
  }
  beginFileEdit(file);
  if (previewEnabled(file.path)) {
    showPreview(file, elements.fileEditor.value);
  } else {
    elements.textViewer.classList.remove("markdown-preview-active");
  }
  if (!elements.fileFindBar.hidden) updateFileFind();
}

function isMarkdownPath(path) {
  return /\.(?:md|markdown|mdx)$/i.test(String(path || ""));
}

function isHtmlPath(path) {
  return /\.(?:html|htm)$/i.test(String(path || ""));
}

function isPreviewablePath(path) {
  return isMarkdownPath(path) || isHtmlPath(path);
}

function previewEnabled(path) {
  if (!isPreviewablePath(path)) return false;
  return !state.previewByPath.has(path) || state.previewByPath.get(path) === true;
}

function markdownPreviewEnabled(path) {
  return isMarkdownPath(path) && previewEnabled(path);
}

function syncPreviewButton() {
  const path = state.workspace.activePath;
  const active = Boolean(path && previewEnabled(path));
  elements.previewFile.setAttribute("aria-pressed", String(active));
  elements.previewFile.title = active ? "Edit source" : "Show preview";
  elements.previewFile.setAttribute("aria-label", elements.previewFile.title);
}

function togglePreview() {
  const path = state.workspace.activePath;
  if (!path || !isPreviewablePath(path)) return;
  const next = !previewEnabled(path);
  state.previewByPath.set(path, next);
  state.workspace.previewViewByPath = {
    ...(state.workspace.previewViewByPath || {}),
    [path]: next ? "rendered" : "raw",
  };
  void persistPreviewViewModes();
  syncPreviewButton();
  if (next) {
    const file = state.files.get(path);
    if (file?.kind === "text") showPreview(file, state.fileEdit?.path === path ? elements.fileEditor.value : state.activeText);
  } else {
    showSourceView(path);
  }
  if (!elements.fileFindBar.hidden) revealActiveFileFind();
}

function showPreview(file, text) {
  if (isMarkdownPath(file.path)) {
    showMarkdownPreview(text);
    return;
  }
  if (isHtmlPath(file.path)) void showHtmlPreview(file, text);
}

function showSourceView(path) {
  stopHtmlPreview();
  clearTimeout(state.markdownPreviewTimer);
  state.markdownPreviewTimer = 0;
  if (isMarkdownPath(path)) materializeMarkdownBlockEdit();
  state.markdownBlockEdit = null;
  elements.markdownRendered.classList.remove("markdown-block-editing");
  elements.textViewer.classList.remove("markdown-preview-active");
  elements.markdownRendered.hidden = true;
  elements.editViewer.hidden = false;
  elements.markers.hidden = Boolean(state.fileEdit?.dirty);
  scheduleEditLineNumbers(elements.fileEditor.value);
  const file = state.files.get(path);
  if (file?.kind === "text") renderEditHighlight(elements.fileEditor.value, file.language);
  if (!state.fileEdit?.dirty) scheduleAnnotationMarkers();
  elements.fileEditor.scrollTop = state.scrollByPath.get(path) || 0;
  syncEditMirrorScroll();
  elements.fileEditor.focus({ preventScroll: true });
}

function showMarkdownPreview(text) {
  const path = state.workspace.activePath;
  stopHtmlPreview();
  const scrollTop = elements.markdownRendered.hidden
    ? (state.scrollByPath.get(path) || 0)
    : elements.markdownRendered.scrollTop;
  state.markdownBlockEdit = null;
  elements.markdownRendered.classList.remove("markdown-block-editing");
  elements.markdownRendered.replaceChildren(renderMarkdown(String(text || "")));
  elements.markdownRendered.hidden = false;
  elements.textViewer.classList.add("markdown-preview-active");
  elements.editViewer.hidden = true;
  elements.scroll.hidden = true;
  elements.markers.hidden = Boolean(state.fileEdit?.dirty);
  requestAnimationFrame(() => {
    if (path === state.workspace.activePath && !elements.markdownRendered.hidden) {
      elements.markdownRendered.scrollTop = scrollTop;
      if (!state.fileEdit?.dirty) renderActiveAnnotations();
    }
  });
  hideSelectionAction();
  hideAnnotationEditor();
}

async function showHtmlPreview(file, text) {
  const path = file.path;
  const sequence = ++state.htmlPreviewSequence;
  elements.markdownRendered.hidden = true;
  elements.markdownRendered.classList.remove("markdown-block-editing");
  elements.textViewer.classList.remove("markdown-preview-active");
  elements.editViewer.hidden = true;
  elements.scroll.hidden = true;
  elements.markers.hidden = true;
  elements.htmlRendered.removeAttribute("srcdoc");
  elements.htmlRendered.hidden = false;
  elements.htmlRendered.title = `Preview ${basename(path)}`;
  hideSelectionAction();
  hideAnnotationEditor();

  try {
    const preview = await bridgeRequest("/local-ui/files/html-preview", {
      threadId,
      path,
      content: String(text || ""),
      active: state.hostActive,
    });
    if (
      sequence !== state.htmlPreviewSequence
      || path !== state.workspace.activePath
      || !previewEnabled(path)
      || !isHtmlPath(path)
    ) return;
    requestAnimationFrame(() => {
      if (
        sequence !== state.htmlPreviewSequence
        || path !== state.workspace.activePath
        || !previewEnabled(path)
        || !isHtmlPath(path)
      ) return;
      elements.htmlRendered.src = preview.url;
    });
  } catch (error) {
    if (sequence !== state.htmlPreviewSequence || path !== state.workspace.activePath) return;
    elements.htmlRendered.srcdoc = `<p style="font:14px system-ui;padding:20px;color:#666">${escapeHtmlText(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

function escapeHtmlText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stopHtmlPreview() {
  state.htmlPreviewSequence += 1;
  elements.htmlRendered.hidden = true;
  elements.htmlRendered.removeAttribute("src");
  elements.htmlRendered.srcdoc = "";
}

function scheduleMarkdownPreview(text) {
  state.pendingMarkdownPreviewText = String(text || "");
  state.pendingMarkdownPreviewPath = state.workspace.activePath;
  clearTimeout(state.markdownPreviewTimer);
  state.markdownPreviewTimer = setTimeout(() => {
    state.markdownPreviewTimer = 0;
    if (state.pendingMarkdownPreviewPath !== state.workspace.activePath) return;
    if (!markdownPreviewEnabled(state.workspace.activePath)) return;
    showMarkdownPreview(state.pendingMarkdownPreviewText);
  }, 80);
}

function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const rows = markdownSourceRows(source);
  let index = 0;

  while (index < rows.length) {
    const line = rows[index].text;
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      const start = index;
      const language = fence[1] || "";
      const body = [];
      index += 1;
      const bodyStart = index;
      while (index < rows.length && !/^```\s*$/.test(rows[index].text)) body.push(rows[index++].text);
      const bodyEnd = index;
      if (index < rows.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const raw = body.join("\n");
      if (language && globalThis.LocalHighlighter) {
        try { code.innerHTML = LocalHighlighter.highlight(raw, language).html; }
        catch { code.textContent = raw; }
      } else code.textContent = raw;
      if (bodyEnd > bodyStart) {
        markMarkdownTextRegion(code, rows[bodyStart].start, rows[bodyEnd - 1].end, "literal");
      }
      pre.append(code);
      fragment.append(markMarkdownBlock(pre, rows, start, index));
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const node = document.createElement(`h${heading[1].length}`);
      appendMarkdownInline(node, heading[2]);
      const textStart = rows[index].start + line.indexOf(heading[2], heading[1].length);
      markMarkdownTextRegion(node, textStart, textStart + heading[2].length);
      fragment.append(markMarkdownBlock(node, rows, index, index + 1));
      index += 1;
      continue;
    }
    const tableDefinition = markdownTableDefinition(rows, index);
    if (tableDefinition) {
      const start = index;
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      tableDefinition.headerCells.forEach((cellDefinition, columnIndex) => {
        const cell = document.createElement("th");
        setMarkdownTableAlignment(cell, tableDefinition.alignments[columnIndex]);
        appendMarkdownInline(cell, cellDefinition.text);
        markMarkdownTextRegion(
          cell,
          rows[index].start + cellDefinition.start,
          rows[index].start + cellDefinition.end,
        );
        headRow.append(cell);
      });
      head.append(headRow);
      table.append(head);
      index += 2;

      const body = document.createElement("tbody");
      while (index < rows.length && rows[index].text.trim()) {
        const rawRow = rows[index].text;
        if (!rawRow.includes("|") || markdownTableDefinition(rows, index)) break;
        const cells = markdownTableCells(rawRow);
        if (!cells.length) break;
        const row = document.createElement("tr");
        for (let columnIndex = 0; columnIndex < tableDefinition.headers.length; columnIndex += 1) {
          const cell = document.createElement("td");
          setMarkdownTableAlignment(cell, tableDefinition.alignments[columnIndex]);
          const cellDefinition = cells[columnIndex];
          appendMarkdownInline(cell, cellDefinition?.text || "");
          if (cellDefinition) {
            markMarkdownTextRegion(
              cell,
              rows[index].start + cellDefinition.start,
              rows[index].start + cellDefinition.end,
            );
          }
          row.append(cell);
        }
        body.append(row);
        index += 1;
      }
      if (body.children.length) table.append(body);
      fragment.append(markMarkdownBlock(table, rows, start, index));
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      fragment.append(markMarkdownBlock(document.createElement("hr"), rows, index, index + 1));
      index += 1;
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const start = index;
      const block = document.createElement("blockquote");
      while (index < rows.length) {
        const row = rows[index];
        const match = row.text.match(/^>\s?(.*)$/);
        if (!match) break;
        if (index > start) appendMarkdownSourceGap(block, rows[index - 1].end, row.start);
        const span = document.createElement("span");
        appendMarkdownInline(span, match[1]);
        const prefixLength = match[0].length - match[1].length;
        markMarkdownTextRegion(span, row.start + prefixLength, row.end);
        block.append(span);
        index += 1;
      }
      fragment.append(markMarkdownBlock(block, rows, start, index));
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const start = index;
      const tag = ordered ? "ol" : "ul";
      const list = document.createElement(tag);
      while (index < rows.length) {
        const current = rows[index].text;
        const itemMatch = tag === "ol"
          ? current.match(/^\s*\d+[.)]\s+(.+)$/)
          : current.match(/^\s*[-*+]\s+(.+)$/);
        if (!itemMatch) break;
        const item = document.createElement("li");
        appendMarkdownInline(item, itemMatch[1]);
        const prefixLength = itemMatch[0].length - itemMatch[1].length;
        markMarkdownTextRegion(item, rows[index].start + prefixLength, rows[index].end);
        list.append(item);
        index += 1;
      }
      fragment.append(markMarkdownBlock(list, rows, start, index));
      continue;
    }

    const start = index;
    const paragraphRows = [rows[index]];
    index += 1;
    while (
      index < rows.length
      && rows[index].text.trim()
      && !startsMarkdownBlock(rows[index].text)
      && !markdownTableDefinition(rows, index)
    ) {
      paragraphRows.push(rows[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    paragraphRows.forEach((row, rowIndex) => {
      if (rowIndex > 0) appendMarkdownSourceGap(paragraph, paragraphRows[rowIndex - 1].end, row.start);
      const value = row.text.trim();
      const leading = row.text.indexOf(value);
      const span = document.createElement("span");
      appendMarkdownInline(span, value);
      markMarkdownTextRegion(span, row.start + leading, row.start + leading + value.length);
      paragraph.append(span);
    });
    fragment.append(markMarkdownBlock(paragraph, rows, start, index));
  }
  return fragment;
}

function markdownSourceRows(source) {
  const rows = [];
  const newline = /\r?\n/g;
  let start = 0;
  for (const match of source.matchAll(newline)) {
    rows.push({ text: source.slice(start, match.index), start, end: match.index });
    start = match.index + match[0].length;
  }
  rows.push({ text: source.slice(start), start, end: source.length });
  return rows;
}

function startsMarkdownBlock(line) {
  return /^(?:#{1,6}\s+|```|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(line)
    || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line);
}


function markdownTableDefinition(rows, index) {
  const headerLine = rows[index]?.text;
  const delimiterLine = rows[index + 1]?.text;
  if (!headerLine || !delimiterLine || !headerLine.includes("|") || !delimiterLine.includes("-")) return null;
  const headerCells = markdownTableCells(headerLine);
  const headers = headerCells.map((cell) => cell.text);
  const delimiters = splitMarkdownTableRow(delimiterLine);
  if (!headers.length || delimiters.length !== headers.length) return null;
  const alignments = [];
  for (const rawDelimiter of delimiters) {
    const delimiter = rawDelimiter.trim();
    if (!/^:?-{3,}:?$/.test(delimiter)) return null;
    const left = delimiter.startsWith(":");
    const right = delimiter.endsWith(":");
    alignments.push(left && right ? "center" : (right ? "right" : (left ? "left" : "")));
  }
  return { headers, headerCells, alignments };
}

function splitMarkdownTableRow(line) {
  return markdownTableCells(line).map((cell) => cell.text);
}

function markdownTableCells(line) {
  const source = String(line || "");
  if (!source.includes("|")) return [];
  let contentStart = 0;
  let contentEnd = source.length;
  while (contentStart < contentEnd && /\s/.test(source[contentStart])) contentStart += 1;
  while (contentEnd > contentStart && /\s/.test(source[contentEnd - 1])) contentEnd -= 1;
  if (source[contentStart] === "|") contentStart += 1;
  if (source[contentEnd - 1] === "|" && source[contentEnd - 2] !== "\\") contentEnd -= 1;

  const cells = [];
  let cellStart = contentStart;
  let escaped = false;
  let inCode = false;
  const pushCell = (startOffset, endOffset) => {
    while (startOffset < endOffset && /\s/.test(source[startOffset])) startOffset += 1;
    while (endOffset > startOffset && /\s/.test(source[endOffset - 1])) endOffset -= 1;
    const raw = source.slice(startOffset, endOffset);
    cells.push({
      text: raw.replace(/\\([\\|])/g, "$1"),
      start: startOffset,
      end: endOffset,
    });
  };

  for (let index = contentStart; index < contentEnd; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      const next = source[index + 1];
      if (next === "|" || next === "\\") {
        escaped = true;
        continue;
      }
      continue;
    }
    if (character === "`") {
      inCode = !inCode;
      continue;
    }
    if (character === "|" && !inCode) {
      pushCell(cellStart, index);
      cellStart = index + 1;
    }
  }
  pushCell(cellStart, contentEnd);
  return cells;
}

function setMarkdownTableAlignment(cell, alignment) {
  if (alignment) cell.dataset.align = alignment;
}

function markMarkdownTextRegion(node, start, end, projection = "markdown") {
  if (!node || !Number.isInteger(start) || !Number.isInteger(end) || end < start) return node;
  node.dataset.markdownTextStart = String(start);
  node.dataset.markdownTextEnd = String(end);
  node.dataset.markdownProjection = projection;
  return node;
}

function appendMarkdownSourceGap(parent, start, end) {
  const gap = document.createElement("span");
  gap.textContent = " ";
  markMarkdownTextRegion(gap, start, end, "gap");
  parent.append(gap);
}


function markMarkdownBlock(node, rows, startIndex, endIndex) {
  const startRow = rows[startIndex];
  const endRow = rows[Math.max(startIndex, endIndex - 1)];
  if (!startRow || !endRow) return node;
  node.classList.add("markdown-editable-block");
  node.dataset.markdownStart = String(startRow.start);
  node.dataset.markdownEnd = String(endRow.end);
  return node;
}

function markdownProjectionTokens(source) {
  const value = String(source || "");
  const tokens = [];
  const emitLiteral = (start, end) => {
    for (let index = start; index < end; index += 1) {
      tokens.push({ start: index, end: index + 1 });
    }
  };

  let index = 0;
  while (index < value.length) {
    const strongMarker = value.startsWith("**", index)
      ? "**"
      : (value.startsWith("__", index) ? "__" : "");
    if (strongMarker) {
      const close = value.indexOf(strongMarker, index + 2);
      if (close > index + 2) {
        emitLiteral(index + 2, close);
        index = close + 2;
        continue;
      }
    }

    if (value[index] === "`") {
      const close = value.indexOf("`", index + 1);
      if (close > index + 1) {
        emitLiteral(index + 1, close);
        index = close + 1;
        continue;
      }
    }

    if (value[index] === "[") {
      const labelEnd = value.indexOf("](", index + 1);
      const targetEnd = labelEnd >= 0 ? value.indexOf(")", labelEnd + 2) : -1;
      if (labelEnd > index + 1 && targetEnd > labelEnd + 2) {
        emitLiteral(index + 1, labelEnd);
        index = targetEnd + 1;
        continue;
      }
    }

    if (value[index] === "\\" && (value[index + 1] === "|" || value[index + 1] === "\\")) {
      tokens.push({ start: index + 1, end: index + 2 });
      index += 2;
      continue;
    }

    tokens.push({ start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

function markdownSourceOffsetAtRenderedPoint(node, offset) {
  const element = node?.nodeType === 3 ? node.parentElement : node;
  const region = element?.closest?.("[data-markdown-text-start][data-markdown-text-end]");
  if (!region || !elements.markdownRendered.contains(region)) return -1;
  const sourceStart = Number(region.dataset.markdownTextStart);
  const sourceEnd = Number(region.dataset.markdownTextEnd);
  const visibleOffset = textOffsetAt(region, node, offset);
  if (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd) || visibleOffset < 0) return -1;
  return markdownSourceOffsetFromVisibleOffset(region, visibleOffset, sourceStart, sourceEnd);
}

function markdownSourceOffsetFromVisibleOffset(region, visibleOffset, sourceStart, sourceEnd) {
  const projection = region.dataset.markdownProjection || "markdown";
  if (projection === "gap") return visibleOffset <= 0 ? sourceStart : sourceEnd;
  const source = state.activeText.slice(sourceStart, sourceEnd);
  if (projection === "literal") {
    return sourceStart + Math.max(0, Math.min(source.length, visibleOffset));
  }
  const tokens = markdownProjectionTokens(source);
  if (!tokens.length) return sourceStart;
  const index = Math.max(0, Math.min(tokens.length, visibleOffset));
  if (index === 0) return sourceStart + tokens[0].start;
  if (index >= tokens.length) return sourceStart + tokens[tokens.length - 1].end;
  return sourceStart + tokens[index].start;
}

function markdownVisibleOffsetForSourceOffset(region, sourceOffset) {
  const sourceStart = Number(region.dataset.markdownTextStart);
  const sourceEnd = Number(region.dataset.markdownTextEnd);
  if (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd)) return -1;
  const projection = region.dataset.markdownProjection || "markdown";
  if (projection === "gap") return sourceOffset <= sourceStart ? 0 : 1;
  const source = state.activeText.slice(sourceStart, sourceEnd);
  const relative = Math.max(0, Math.min(source.length, sourceOffset - sourceStart));
  if (projection === "literal") return relative;
  const tokens = markdownProjectionTokens(source);
  if (!tokens.length) return 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (relative <= tokens[index].start) return index;
    if (relative < tokens[index].end) return index + 1;
  }
  return tokens.length;
}

function textPointAtOffset(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  let cursor = 0;
  while ((node = walker.nextNode())) {
    const next = cursor + node.nodeValue.length;
    if (offset <= next) return { node, offset: Math.max(0, offset - cursor) };
    cursor = next;
  }
  return null;
}

function markdownRegionForSourceOffset(sourceOffset, preferEnd = false) {
  const regions = [...elements.markdownRendered.querySelectorAll("[data-markdown-text-start][data-markdown-text-end]")];
  let boundary = null;
  for (const region of regions) {
    const start = Number(region.dataset.markdownTextStart);
    const end = Number(region.dataset.markdownTextEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (sourceOffset > start && sourceOffset < end) return region;
    if (sourceOffset === start && !preferEnd) return region;
    if (sourceOffset === end) {
      boundary = region;
      if (preferEnd) return region;
    }
  }
  return boundary;
}

function markdownRangeFromSourceOffsets(start, end) {
  const startRegion = markdownRegionForSourceOffset(start, false);
  const endRegion = markdownRegionForSourceOffset(end, true);
  if (!startRegion || !endRegion) return null;
  const startVisible = markdownVisibleOffsetForSourceOffset(startRegion, start);
  const endVisible = markdownVisibleOffsetForSourceOffset(endRegion, end);
  if (startVisible < 0 || endVisible < 0) return null;
  const startPoint = textPointAtOffset(startRegion, startVisible);
  const endPoint = textPointAtOffset(endRegion, endVisible);
  if (!startPoint || !endPoint) return null;
  try {
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
  } catch {
    return null;
  }
}

async function persistPreviewViewModes() {
  try {
    const workspace = await persistWorkspace({
      previewViewByPath: state.workspace.previewViewByPath || {},
    });
    state.workspace.previewViewByPath = workspace.previewViewByPath || {};
  } catch {
    // Keep the local choice if the bridge is briefly unavailable.
  }
}

function handleMarkdownRenderedClick(event) {
  if (!markdownPreviewEnabled(state.workspace.activePath) || state.markdownBlockEdit) return;
  if (event.target.closest?.("a")) return;
}

function handleMarkdownRenderedKeydown(event) {
  if (event.target.matches?.(".markdown-block-editor")) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      saveFileEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelMarkdownBlockEdit();
    }
    return;
  }
  if (!event.altKey || (event.key !== "Enter" && event.key !== " ")) return;
  const block = event.target.closest?.(".markdown-editable-block");
  if (!block || state.markdownBlockEdit) return;
  event.preventDefault();
  beginMarkdownBlockEdit(block);
}

function beginMarkdownBlockEdit(block, { sourceOffset = -1 } = {}) {
  const path = state.workspace.activePath;
  if (!path || !markdownPreviewEnabled(path) || state.markdownBlockEdit) return;
  const start = Number(block.dataset.markdownStart);
  const end = Number(block.dataset.markdownEnd);
  const baseText = elements.fileEditor.value;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > baseText.length) return;

  const shell = document.createElement("div");
  shell.className = "markdown-block-edit-shell";
  shell.dataset.markdownBlockKind = markdownInlineEditKind(block);
  const blockStyle = globalThis.getComputedStyle?.(block);
  if (blockStyle) {
    shell.style.marginTop = blockStyle.marginTop;
    shell.style.marginBottom = blockStyle.marginBottom;
  }
  const textarea = document.createElement("textarea");
  textarea.className = "markdown-block-editor";
  textarea.value = baseText.slice(start, end);
  textarea.setAttribute("aria-label", "Edit Markdown block");
  textarea.spellcheck = block.tagName !== "PRE";
  applyMarkdownInlineEditorStyle(textarea, blockStyle);
  shell.append(textarea);
  block.replaceWith(shell);
  state.markdownBlockEdit = {
    path,
    start,
    end,
    baseText,
    originalBlockText: textarea.value,
    shell,
    textarea,
    changed: false,
  };
  elements.markdownRendered.classList.add("markdown-block-editing");
  textarea.addEventListener("input", updateMarkdownBlockEdit);
  textarea.addEventListener("mouseup", (event) => handleMarkdownBlockEditorSelection(event));
  textarea.addEventListener("keyup", (event) => {
    if (event.shiftKey) handleMarkdownBlockEditorSelection();
  });
  textarea.addEventListener("blur", () => {
    setTimeout(() => {
      const edit = state.markdownBlockEdit;
      if (edit?.textarea === textarea && !edit.changed) cancelMarkdownBlockEdit();
    }, 0);
  });
  resizeMarkdownBlockEditor(textarea);
  textarea.focus({ preventScroll: true });
  const caret = Number.isInteger(sourceOffset) && sourceOffset >= start && sourceOffset <= end
    ? sourceOffset - start
    : textarea.value.length;
  textarea.setSelectionRange(caret, caret);
}

function markdownInlineEditKind(block) {
  const tag = String(block?.tagName || "").toLowerCase();
  if (/^h[1-6]$/.test(tag)) return tag;
  if (tag === "pre") return "code";
  if (tag === "blockquote") return "blockquote";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "table") return "table";
  return "prose";
}

function applyMarkdownInlineEditorStyle(textarea, blockStyle) {
  if (!textarea || !blockStyle) return;
  textarea.style.fontFamily = blockStyle.fontFamily;
  textarea.style.fontSize = blockStyle.fontSize;
  textarea.style.fontWeight = blockStyle.fontWeight;
  textarea.style.fontStyle = blockStyle.fontStyle;
  textarea.style.lineHeight = blockStyle.lineHeight;
  textarea.style.letterSpacing = blockStyle.letterSpacing;
  textarea.style.textAlign = blockStyle.textAlign;
  textarea.style.color = blockStyle.color;
}

function updateMarkdownBlockEdit() {
  const edit = state.markdownBlockEdit;
  if (!edit || edit.path !== state.workspace.activePath) return;
  const blockText = edit.textarea.value;
  edit.changed = blockText !== edit.originalBlockText;
  const dirty = edit.changed || edit.baseText !== state.fileEdit?.originalText;
  syncFileEditDirtyUi(dirty, { showAnnotations: false });
  resizeMarkdownBlockEditor(edit.textarea);
}

function materializeMarkdownBlockEdit() {
  const edit = state.markdownBlockEdit;
  if (!edit || edit.path !== state.workspace.activePath) return elements.fileEditor.value;
  const text = edit.changed
    ? `${edit.baseText.slice(0, edit.start)}${edit.textarea.value}${edit.baseText.slice(edit.end)}`
    : edit.baseText;
  elements.fileEditor.value = text;
  state.activeText = text;
  return text;
}

function cancelMarkdownBlockEdit() {
  const edit = state.markdownBlockEdit;
  if (!edit) return;
  elements.fileEditor.value = edit.baseText;
  syncFileEditState(edit.baseText, { showAnnotations: false });
  state.markdownBlockEdit = null;
  showMarkdownPreview(edit.baseText);
}

function resizeMarkdownBlockEditor(textarea) {
  textarea.style.height = "0px";
  textarea.style.height = `${Math.min(Math.max(28, textarea.scrollHeight), 480)}px`;
  textarea.style.overflowY = textarea.scrollHeight > 480 ? "auto" : "hidden";
}

function appendMarkdownInline(parent, text) {
  const source = String(text || "");
  const token = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^\s)]+\))/g;
  let cursor = 0;
  for (const match of source.matchAll(token)) {
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
    const value = match[0];
    if (value.startsWith("`")) {
      const code = document.createElement("code"); code.textContent = value.slice(1, -1); parent.append(code);
    } else if (value.startsWith("**") || value.startsWith("__")) {
      const strong = document.createElement("strong"); strong.textContent = value.slice(2, -2); parent.append(strong);
    } else {
      const link = value.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
      let url = null;
      try { url = new URL(link[2], "https://local.invalid/"); } catch {}
      if (url && ["http:", "https:", "mailto:"].includes(url.protocol)) {
        const anchor = document.createElement("a");
        anchor.textContent = link[1]; anchor.href = link[2]; anchor.target = "_blank"; anchor.rel = "noreferrer noopener"; parent.append(anchor);
      } else parent.append(document.createTextNode(value));
    }
    cursor = match.index + value.length;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

async function refreshActiveFile() {
  const path = state.workspace.activePath;
  if (!path) return;
  if (state.fileEdit?.path === path && state.fileEdit.dirty) {
    setFileEditStatus("Save or discard your edit before refreshing.", true);
    return;
  }
  const cached = state.files.get(path);
  if (cached?.objectUrl) URL.revokeObjectURL(cached.objectUrl);
  state.files.delete(path);
  state.fileEdit = null;
  setFileEditStatus("Refreshing…");
  await showPath(path);
}

function beginFileEdit(file = state.files.get(state.workspace.activePath)) {
  const path = state.workspace.activePath;
  if (!path || file?.kind !== "text") return;

  hideSelectionAction();
  hideAnnotationEditor();
  clearSelection();
  state.fileEdit = {
    path,
    originalText: file.text,
    dirty: false,
    descriptor: { ...file.descriptor },
  };
  elements.fileEditor.value = file.text;
  scheduleEditLineNumbers(file.text);
  renderEditHighlight(file.text, file.language);
  const scrollTop = state.scrollByPath.get(file.path) || 0;
  elements.fileEditor.scrollTop = scrollTop;
  elements.fileEditor.scrollLeft = 0;
  syncEditMirrorScroll();
  elements.scroll.hidden = true;
  elements.editViewer.hidden = false;
  elements.markers.hidden = false;
  elements.cancelFileEdit.hidden = true;
  elements.saveFileEdit.hidden = true;
  elements.saveFileEdit.disabled = true;
  setFileEditStatus("");
  renderTabs();
  requestAnimationFrame(renderActiveAnnotations);
}

function updateFileEdit() {
  if (state.fileEdit?.path !== state.workspace.activePath) return;
  const text = elements.fileEditor.value;
  syncFileEditState(text);
  scheduleEditLineNumbers(text);
  scheduleEditHighlight();
  if (markdownPreviewEnabled(state.workspace.activePath)) {
    scheduleMarkdownPreview(text);
  }
  if (!elements.fileFindBar.hidden) updateFileFind();
}

function syncFileEditState(text, { showAnnotations = true } = {}) {
  if (state.fileEdit?.path !== state.workspace.activePath) return;
  state.activeText = text;
  syncFileEditDirtyUi(text !== state.fileEdit.originalText, { showAnnotations });
}

function syncFileEditDirtyUi(dirty, { showAnnotations = true } = {}) {
  if (state.fileEdit?.path !== state.workspace.activePath) return;
  state.fileEdit.dirty = Boolean(dirty);
  elements.saveFileEdit.disabled = !state.fileEdit.dirty;
  if (state.fileEdit.dirty) {
    clearFileHighlights();
    hideSelectionAction();
  }
  elements.markers.hidden = !showAnnotations || state.fileEdit.dirty;
  if (showAnnotations && !state.fileEdit.dirty) requestAnimationFrame(renderActiveAnnotations);
  if (state.fileEdit.dirty) {
    if (state.fileSave.inFlight) setRoutineFileSaveStatus("Saving…");
    else setRoutineFileSaveStatus("Unsaved");
    scheduleAutoSave();
  } else {
    cancelAutoSaveTimer();
    if (!state.fileSave.inFlight) setRoutineFileSaveStatus("");
  }
  renderFileEditSaveChrome();
  renderTabs();
}

function renderFileEditSaveChrome() {
  const dirty = Boolean(
    state.fileEdit?.path === state.workspace.activePath
    && state.fileEdit.dirty
  );
  const manualControlsVisible = dirty && state.editorPreferences.autoSave !== true;
  elements.cancelFileEdit.hidden = !manualControlsVisible;
  elements.saveFileEdit.hidden = !manualControlsVisible;

  if (
    state.editorPreferences.autoSave === true
    && !elements.editStatus.classList.contains("error")
  ) {
    setFileEditStatus("");
  } else if (
    state.editorPreferences.autoSave !== true
    && dirty
    && !state.fileSave.inFlight
    && !elements.editStatus.classList.contains("error")
  ) {
    setFileEditStatus("Unsaved");
  }
}

function setRoutineFileSaveStatus(message) {
  if (state.editorPreferences.autoSave === true) {
    if (!elements.editStatus.classList.contains("error")) setFileEditStatus("");
    return;
  }
  setFileEditStatus(message);
}

function cancelAutoSaveTimer() {
  if (!state.fileSave.autoSaveTimer) return;
  clearTimeout(state.fileSave.autoSaveTimer);
  state.fileSave.autoSaveTimer = 0;
}

function scheduleAutoSave() {
  cancelAutoSaveTimer();
  const edit = state.fileEdit;
  if (
    state.editorPreferences.autoSave !== true
    || !edit?.dirty
    || edit.path !== state.workspace.activePath
  ) return;

  const path = edit.path;
  state.fileSave.autoSaveTimer = setTimeout(() => {
    state.fileSave.autoSaveTimer = 0;
    if (
      state.editorPreferences.autoSave !== true
      || !state.fileEdit?.dirty
      || state.fileEdit.path !== path
      || state.workspace.activePath !== path
    ) return;
    void saveFileEdit({ mode: "auto" });
  }, AUTO_SAVE_DELAY_MS);
}

function scheduleEditLineNumbers(text = elements.fileEditor.value) {
  state.pendingLineNumberText = String(text ?? "");
  if (state.editLineNumberFrame) return;
  state.editLineNumberFrame = requestAnimationFrame(() => {
    state.editLineNumberFrame = 0;
    updateEditLineNumbers(state.pendingLineNumberText);
  });
}

function updateEditLineNumbers(text) {
  const lines = String(text).split("\n");
  if (!lines.length) lines.push("");

  if (!state.wrapText) {
    elements.lineWrapMeasure.replaceChildren();
    elements.editLineNumbers.textContent = lines.map((_, index) => String(index + 1)).join("\n");
    return;
  }

  // Match the textarea's actual inner viewport width, including any width
  // consumed by a vertical scrollbar. This keeps gutter spacing identical to
  // the editor's real wrapping instead of estimating from the sidebar width.
  elements.lineWrapMeasure.style.width = `${Math.max(0, elements.fileEditor.clientWidth)}px`;
  const measureFragment = document.createDocumentFragment();
  for (const line of lines) {
    const measureLine = document.createElement("div");
    measureLine.className = "line-wrap-measure__line";
    measureLine.textContent = line || "\u200b";
    measureFragment.appendChild(measureLine);
  }
  elements.lineWrapMeasure.replaceChildren(measureFragment);

  const gutterFragment = document.createDocumentFragment();
  [...elements.lineWrapMeasure.children].forEach((measureLine, index) => {
    const row = document.createElement("div");
    row.className = "edit-line-number-row";
    row.textContent = String(index + 1);
    const measuredHeight = measureLine.getBoundingClientRect().height;
    const visualRows = Math.max(1, Math.round(measuredHeight / state.codeLineHeight));
    row.style.height = `${visualRows * state.codeLineHeight}px`;
    gutterFragment.appendChild(row);
  });
  elements.editLineNumbers.replaceChildren(gutterFragment);
  scheduleGitGutterMarkers();
}

function scheduleGitGutterMarkers() {
  if (state.git.gutterFrame) return;
  state.git.gutterFrame = requestAnimationFrame(() => {
    state.git.gutterFrame = 0;
    renderGitGutterMarkers();
  });
}

function renderGitGutterMarkers() {
  const gutter = elements.gitGutter;
  if (!gutter) return;
  gutter.replaceChildren();

  const activePath = state.workspace.activePath;
  if (
    !activePath
    || elements.editViewer.hidden
    || state.fileEdit?.path !== activePath
    || state.git.changesPath !== activePath
    || !Array.isArray(state.git.ranges)
    || state.git.ranges.length === 0
  ) return;
  const scrollTop = elements.fileEditor.scrollTop || 0;
  const viewportHeight = elements.fileEditor.clientHeight || elements.editViewer.clientHeight || 0;
  const lineCount = Math.max(1, String(elements.fileEditor.value || "").split("\n").length);

  const lineBox = (lineNumber) => {
    const line = Math.max(1, Math.min(lineCount, Number(lineNumber) || 1));
    if (state.wrapText) {
      const row = elements.editLineNumbers.children[line - 1];
      if (row) {
        return {
          top: row.offsetTop - scrollTop,
          height: Math.max(state.codeLineHeight, row.offsetHeight || state.codeLineHeight),
        };
      }
    }
    return {
      top: 12 + ((line - 1) * state.codeLineHeight) - scrollTop,
      height: state.codeLineHeight,
    };
  };

  const fragment = document.createDocumentFragment();
  for (const range of state.git.ranges) {
    const type = String(range?.type || "");
    if (!new Set(["added", "modified", "deleted"]).has(type)) continue;

    const marker = document.createElement("span");
    marker.className = `git-gutter-marker ${type}`;

    if (type === "deleted") {
      const box = lineBox(range.line);
      marker.style.top = `${Math.round(box.top + Math.max(0, (box.height - 8) / 2))}px`;
      if (box.top > viewportHeight || box.top + box.height < 0) continue;
    } else {
      const start = Math.max(1, Number(range.start) || 1);
      const end = Math.max(start, Number(range.end) || start);
      const first = lineBox(start);
      const last = lineBox(end);
      const top = first.top;
      const bottom = last.top + last.height;
      if (top > viewportHeight || bottom < 0) continue;
      marker.style.top = `${Math.round(top)}px`;
      marker.style.height = `${Math.max(2, Math.round(bottom - top))}px`;
    }
    fragment.appendChild(marker);
  }
  gutter.appendChild(fragment);
}

function scheduleEditHighlight() {
  if (state.editHighlightFrame) return;
  state.editHighlightFrame = requestAnimationFrame(() => {
    state.editHighlightFrame = 0;
    const file = state.files.get(state.workspace.activePath);
    if (file?.kind !== "text" || state.fileEdit?.path !== file.path) return;
    renderEditHighlight(elements.fileEditor.value, file.language);
  });
}

function renderEditHighlight(text, language) {
  const source = String(text || "");
  const displaySource = source.endsWith("\n") ? `${source} ` : source;
  if (displaySource.length <= MAX_LIVE_HIGHLIGHT_CHARS && globalThis.LocalHighlighter) {
    try {
      elements.editCode.innerHTML = LocalHighlighter.highlight(displaySource, language).html;
    } catch {
      elements.editCode.textContent = displaySource;
    }
  } else {
    elements.editCode.textContent = displaySource;
  }
  syncEditMirrorScroll();
}

function syncEditMirrorScroll() {
  const top = Math.round(elements.fileEditor.scrollTop);
  const left = Math.round(elements.fileEditor.scrollLeft);
  elements.editLineNumbers.scrollTop = top;
  elements.editHighlight.style.top = `${-top}px`;
  elements.editHighlight.style.left = `${-left}px`;
}

async function saveFileEdit({ mode = "manual" } = {}) {
  const edit = state.fileEdit;
  if (!edit || edit.path !== state.workspace.activePath) return;
  cancelAutoSaveTimer();

  if (state.fileSave.inFlight) {
    if (edit.dirty) {
      state.fileSave.pendingMode = mode === "manual"
        ? "manual"
        : (state.fileSave.pendingMode || "auto");
    }
    return;
  }
  if (!edit.dirty) return;

  state.fileSave.inFlight = true;
  elements.saveFileEdit.disabled = true;
  setRoutineFileSaveStatus("Saving…");
  const markdownEdit = state.markdownBlockEdit?.path === edit.path ? state.markdownBlockEdit : null;
  const markdownSnapshot = markdownEdit
    ? {
        start: markdownEdit.start,
        blockText: markdownEdit.textarea.value,
      }
    : null;
  const content = materializeMarkdownBlockEdit();
  let saveSucceeded = false;
  try {
    const saved = await bridgeRequest("/local-ui/files/write", {
      threadId,
      path: edit.path,
      content,
      expectedLastModified: edit.descriptor.lastModified,
      expectedBytes: edit.descriptor.bytes,
      active: state.hostActive,
    });
    const file = state.files.get(edit.path);
    if (!file || file.kind !== "text") return;
    const scrollTop = markdownPreviewEnabled(edit.path) && !elements.markdownRendered.hidden
      ? elements.markdownRendered.scrollTop
      : elements.fileEditor.scrollTop;
    file.text = content;
    file.descriptor = { ...file.descriptor, ...saved };
    state.activeDescriptor = file;
    state.scrollByPath.set(edit.path, scrollTop);

    if (state.fileEdit === edit && state.workspace.activePath === edit.path) {
      edit.descriptor = { ...edit.descriptor, ...saved };
      edit.originalText = content;
      const currentContent = materializeMarkdownBlockEdit();
      const hasNewerChanges = currentContent !== content;
      state.activeText = currentContent;

      if (markdownEdit && state.markdownBlockEdit === markdownEdit && markdownSnapshot) {
        const currentBlockText = markdownEdit.textarea.value;
        markdownEdit.baseText = content;
        markdownEdit.end = markdownSnapshot.start + markdownSnapshot.blockText.length;
        markdownEdit.originalBlockText = markdownSnapshot.blockText;
        markdownEdit.changed = currentBlockText !== markdownSnapshot.blockText;
      }

      if (mode === "manual" && !hasNewerChanges) {
        state.fileEdit = null;
        renderTabs();
        renderTextFile(file);
      } else {
        syncFileEditDirtyUi(hasNewerChanges, { showAnnotations: !state.markdownBlockEdit });
      }
    } else {
      state.activeText = content;
    }
    saveSucceeded = true;
    const stillDirty = state.fileEdit?.path === file.path && state.fileEdit.dirty;
    setRoutineFileSaveStatus(stillDirty ? "Unsaved" : "Saved");
    setTimeout(() => {
      if (
        state.fileEdit?.path === file.path
        && !state.fileEdit.dirty
        && !state.fileSave.inFlight
      ) setRoutineFileSaveStatus("");
    }, 1_200);
  } catch (error) {
    setFileEditStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.fileSave.inFlight = false;
    if (state.fileEdit) elements.saveFileEdit.disabled = !state.fileEdit.dirty;
    const pendingMode = state.fileSave.pendingMode;
    state.fileSave.pendingMode = "";
    if (saveSucceeded && state.fileEdit?.dirty) {
      if (pendingMode === "manual") void saveFileEdit({ mode: "manual" });
      else if (state.editorPreferences.autoSave) scheduleAutoSave();
    }
  }
}

function cancelFileEdit() {
  const edit = state.fileEdit;
  if (!edit) return;
  cancelAutoSaveTimer();
  const file = state.files.get(edit.path);
  const scrollTop = markdownPreviewEnabled(edit.path) && !elements.markdownRendered.hidden
    ? elements.markdownRendered.scrollTop
    : elements.fileEditor.scrollTop;
  state.scrollByPath.set(edit.path, scrollTop);
  state.fileEdit = null;
  resetFileEditUi();
  renderTabs();
  if (state.workspace.activePath === edit.path && file?.kind === "text") renderTextFile(file);
}

function prepareToLeaveFileEdit() {
  if (!state.fileEdit) return true;
  if (state.fileEdit.dirty) {
    setFileEditStatus("Save or cancel your edit first.", true);
    return false;
  }
  cancelAutoSaveTimer();
  state.fileEdit = null;
  resetFileEditUi();
  renderTabs();
  return true;
}

function resetFileEditUi() {
  state.markdownBlockEdit = null;
  elements.markdownRendered.classList.remove("markdown-block-editing");
  elements.editViewer.hidden = true;
  elements.scroll.hidden = false;
  elements.markers.hidden = false;
  elements.cancelFileEdit.hidden = true;
  elements.saveFileEdit.hidden = true;
  elements.saveFileEdit.disabled = true;
  setFileEditStatus("");
}

function setFileEditStatus(message, isError = false) {
  elements.editStatus.textContent = message;
  elements.editStatus.hidden = !message;
  elements.editStatus.classList.toggle("error", Boolean(message) && isError);
}

function renderMediaFile(file) {
  state.activeText = "";
  state.fileEdit = null;
  elements.diffViewer.hidden = true;
  elements.diffViewer.replaceChildren();
  elements.fileFindBar.hidden = true;
  clearFileFindHighlights();
  elements.fileLoadingSkeleton.hidden = true;
  elements.loading.hidden = true;
  elements.textViewer.hidden = true;
  elements.markdownRendered.hidden = true;
  stopHtmlPreview();
  elements.mediaViewer.hidden = false;
  elements.cancelFileEdit.hidden = true;
  elements.saveFileEdit.hidden = true;
  setFileEditStatus("");
  elements.mediaViewer.replaceChildren();
  let node;
  if (file.kind === "image") {
    node = document.createElement("img");
    node.src = file.objectUrl;
    node.alt = basename(file.path);
  } else if (file.kind === "pdf") {
    node = document.createElement("iframe");
    node.src = file.objectUrl;
    node.title = basename(file.path);
  } else if (file.kind === "video") {
    node = renderVideoFile(file);
  } else if (file.kind === "audio") {
    node = document.createElement("audio");
    node.src = file.objectUrl;
    node.controls = true;
    node.tabIndex = 0;
    node.setAttribute("aria-label", basename(file.path));
  } else {
    node = document.createElement("div");
    node.className = "binary-card";
    const title = document.createElement("strong");
    title.textContent = basename(file.path);
    const message = document.createElement("p");
    message.textContent = file.message || `This ${file.mime || "binary"} file cannot be rendered as code. It remains available for @@ attachment.`;
    node.append(title, message);
  }
  elements.mediaViewer.appendChild(node);
  clearFileHighlights();
  elements.markers.replaceChildren();
}

function renderVideoFile(file) {
  const shell = document.createElement("div");
  shell.className = "media-video-shell";

  const stage = document.createElement("div");
  stage.className = "media-video-stage";
  const video = document.createElement("video");
  video.src = file.objectUrl;
  video.controls = true;
  video.tabIndex = 0;
  video.setAttribute("aria-label", basename(file.path));

  const annotate = document.createElement("button");
  annotate.type = "button";
  annotate.className = "annotate-selection media-annotate-button ls-ui-button ls-ui-floating-surface";
  annotate.hidden = true;

  const composer = document.createElement("div");
  composer.className = "annotation-editor media-note-composer ls-ui-floating-surface";
  composer.hidden = true;
  const input = document.createElement("textarea");
  input.rows = 1;
  input.placeholder = "Add a comment…";
  input.setAttribute("aria-label", "Video annotation note");
  const save = document.createElement("button");
  save.type = "button";
  save.className = "annotation-save media-note-save";
  save.setAttribute("aria-label", "Save annotation");
  save.title = "Save annotation";
  save.innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';
  const existingActions = document.createElement("div");
  existingActions.className = "annotation-existing-actions media-note-existing-actions";
  existingActions.hidden = true;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "annotation-cancel media-note-cancel";
  cancel.textContent = "Cancel";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "annotation-delete media-note-delete";
  remove.setAttribute("aria-label", "Delete annotation");
  remove.title = "Delete annotation";
  remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>';
  const saveExisting = document.createElement("button");
  saveExisting.type = "button";
  saveExisting.className = "annotation-save annotation-save-existing media-note-save-existing";
  saveExisting.setAttribute("aria-label", "Save annotation");
  saveExisting.title = "Save annotation";
  saveExisting.innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';
  existingActions.append(remove, document.createElement("span"), cancel, saveExisting);
  composer.append(input, save, existingActions);

  const notes = document.createElement("details");
  notes.className = "media-notes";
  const summary = document.createElement("summary");
  const list = document.createElement("div");
  list.className = "media-notes-list";
  notes.append(summary, list);

  let candidateTime = 0;
  let editingNote = null;

  const notesForFile = () => (state.workspace.mediaNotes || [])
    .filter((note) => note.path === file.path)
    .sort((a, b) => Number(a.time) - Number(b.time));

  const renderNotes = () => {
    const items = notesForFile();
    shell.classList.toggle("has-media-notes", items.length > 0);
    summary.textContent = `Notes · ${items.length}`;
    notes.hidden = items.length === 0;
    list.replaceChildren();
    for (const note of items) {
      const row = document.createElement("div");
      row.className = "media-note-row";
      const seek = document.createElement("button");
      seek.type = "button";
      seek.className = "media-note-seek";
      seek.textContent = formatMediaTimestamp(note.time);
      seek.addEventListener("click", () => {
        video.currentTime = Math.max(0, Number(note.time) || 0);
        video.focus({ preventScroll: true });
      });
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "media-note-comment";
      edit.textContent = note.comment;
      edit.title = "Edit note";
      edit.addEventListener("click", () => openComposer(Number(note.time) || 0, note));
      row.append(seek, edit);
      list.append(row);
    }
  };

  const closeComposer = () => {
    composer.hidden = true;
    input.value = "";
    editingNote = null;
    composer.classList.remove("editing");
    existingActions.hidden = true;
  };

  const openComposer = (time, note = null) => {
    candidateTime = Math.max(0, Number(time) || 0);
    editingNote = note;
    input.value = note?.comment || "";
    input.placeholder = `Add a comment at ${formatMediaTimestamp(candidateTime)}…`;
    composer.classList.toggle("editing", Boolean(note));
    existingActions.hidden = !note;
    composer.hidden = false;
    resizeAnnotationInput(input);
    requestAnimationFrame(() => input.focus());
  };

  const updatePauseCandidate = () => {
    if (!video.paused || video.ended) {
      annotate.hidden = true;
      return;
    }
    candidateTime = Math.max(0, (Number(video.currentTime) || 0) - 0.25);
    annotate.textContent = `Annotate · ${formatMediaTimestamp(candidateTime)}`;
    annotate.hidden = false;
  };

  const saveNote = async () => {
    const comment = input.value.trim();
    if (!comment) return input.focus();
    save.disabled = true;
    saveExisting.disabled = true;
    try {
      const payload = await workspaceRequest("upsert_media_note", {
        note: {
          ...(editingNote?.id ? { id: editingNote.id } : {}),
          path: file.path,
          time: candidateTime,
          comment,
        },
      });
      state.workspace = payload.workspace;
      closeComposer();
      renderNotes();
    } catch (error) {
      input.setCustomValidity(error instanceof Error ? error.message : String(error));
      input.reportValidity();
      input.setCustomValidity("");
    } finally {
      save.disabled = false;
      saveExisting.disabled = false;
    }
  };

  const deleteNote = async () => {
    if (!editingNote?.id) return;
    remove.disabled = true;
    try {
      const payload = await workspaceRequest("delete_media_note", { id: editingNote.id });
      state.workspace = payload.workspace;
      closeComposer();
      renderNotes();
    } finally {
      remove.disabled = false;
    }
  };

  annotate.addEventListener("click", () => openComposer(candidateTime));
  save.addEventListener("click", saveNote);
  saveExisting.addEventListener("click", saveNote);
  cancel.addEventListener("click", () => {
    closeComposer();
    video.focus({ preventScroll: true });
  });
  remove.addEventListener("click", deleteNote);
  input.addEventListener("input", () => resizeAnnotationInput(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void saveNote();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeComposer();
      video.focus({ preventScroll: true });
    }
  });
  video.addEventListener("pause", updatePauseCandidate);
  video.addEventListener("seeked", updatePauseCandidate);
  video.addEventListener("play", () => {
    annotate.hidden = true;
    if (!input.value.trim()) closeComposer();
  });

  stage.append(video, annotate, composer);
  shell.append(stage, notes);
  renderNotes();
  return shell;
}

function formatMediaTimestamp(value) {
  const totalTenths = Math.max(0, Math.round((Number(value) || 0) * 10));
  const wholeSecondsTotal = Math.floor(totalTenths / 10);
  const wholeMinutes = Math.floor(wholeSecondsTotal / 60);
  const wholeSeconds = wholeSecondsTotal % 60;
  const tenths = totalTenths % 10;
  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${tenths}`;
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${tenths}`;
}

function restoreWorkspaceFocus({ preferMedia = true } = {}) {
  requestAnimationFrame(() => {
    const media = preferMedia ? activePlayableMedia() : null;
    const target = media || elements.viewer;
    if (!target?.isConnected) return;
    target.focus({ preventScroll: true });
  });
}

function activePlayableMedia() {
  if (elements.mediaViewer.hidden) return null;
  return elements.mediaViewer.querySelector("video, audio");
}

function handleMediaSpaceShortcut(event) {
  if (
    event.defaultPrevented
    || event.metaKey
    || event.ctrlKey
    || event.altKey
    || event.shiftKey
    || (event.key !== " " && event.code !== "Space")
  ) return false;

  const media = activePlayableMedia();
  if (!media || keyboardTargetOwnsMediaShortcut(event.target, media)) return false;

  event.preventDefault();
  event.stopPropagation();
  if (media.paused || media.ended) {
    const playback = media.play();
    playback?.catch?.(() => {});
  } else {
    media.pause();
  }
  return true;
}

function handleMediaSeekShortcut(event) {
  if (
    event.defaultPrevented
    || event.metaKey
    || event.ctrlKey
    || event.altKey
    || event.shiftKey
    || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
  ) return false;

  const media = activePlayableMedia();
  if (!media || media.tagName !== "VIDEO" || keyboardTargetOwnsMediaShortcut(event.target, media)) return false;

  const direction = event.key === "ArrowLeft" ? -1 : 1;
  const now = performance.now();
  if (!event.repeat || state.mediaSeek.direction !== direction) {
    state.mediaSeek.direction = direction;
    state.mediaSeek.holdStartedAt = now;
    state.mediaSeek.lastAppliedAt = now;
  } else if ((now - state.mediaSeek.lastAppliedAt) < 200) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  const heldFor = event.repeat ? Math.max(0, now - state.mediaSeek.holdStartedAt) : 0;
  const seconds = heldFor >= 5000
    ? 5
    : heldFor >= 4000
      ? 4
      : heldFor >= 3000
        ? 3
        : heldFor >= 2000
          ? 2
          : heldFor >= 1000
            ? 1
            : 0.35;
  const currentTime = Math.max(0, Number(media.currentTime) || 0);
  const duration = Number(media.duration);
  const upperBound = Number.isFinite(duration) && duration >= 0 ? duration : Number.POSITIVE_INFINITY;
  const nextTime = Math.round(
    Math.max(0, Math.min(upperBound, currentTime + (direction * seconds))) * 1000,
  ) / 1000;

  event.preventDefault();
  event.stopPropagation();
  media.currentTime = nextTime;
  state.mediaSeek.lastAppliedAt = now;
  return true;
}

function keyboardTargetOwnsMediaShortcut(target, media) {
  if (!(target instanceof Element) || target === media) return false;
  return Boolean(target.closest(
    'input, textarea, select, button, a[href], [contenteditable="true"], [role="textbox"]',
  ));
}

function clearViewer() {
  state.activeText = "";
  state.activeDescriptor = null;
  state.fileEdit = null;
  elements.fileFindBar.hidden = true;
  clearFileFindHighlights();
  elements.fileActionBar.hidden = true;
  elements.cancelFileEdit.hidden = true;
  elements.saveFileEdit.hidden = true;
  elements.editViewer.hidden = true;
  setFileEditStatus("");
  elements.fileLoadingSkeleton.hidden = true;
  elements.loading.hidden = false;
  elements.loading.textContent = "Open a file with ⌘P.";
  elements.textViewer.hidden = true;
  stopHtmlPreview();
  elements.diffViewer.hidden = true;
  elements.diffViewer.replaceChildren();
  elements.mediaViewer.hidden = true;
  elements.mediaViewer.replaceChildren();
  elements.code.replaceChildren();
  elements.lineNumbers.textContent = "";
  clearFileHighlights();
  elements.markers.replaceChildren();
}

function showFileLoadingSkeleton() {
  elements.fileFindBar.hidden = true;
  clearFileFindHighlights();
  elements.cancelFileEdit.hidden = true;
  elements.saveFileEdit.hidden = true;
  setFileEditStatus("");
  elements.loading.hidden = true;
  elements.fileLoadingSkeleton.hidden = false;
  elements.textViewer.hidden = true;
  stopHtmlPreview();
  elements.diffViewer.hidden = true;
  elements.diffViewer.replaceChildren();
  elements.mediaViewer.hidden = true;
}

function showMessage(message) {
  elements.fileFindBar.hidden = true;
  clearFileFindHighlights();
  elements.cancelFileEdit.hidden = true;
  elements.saveFileEdit.hidden = true;
  setFileEditStatus("");
  elements.fileLoadingSkeleton.hidden = true;
  elements.loading.hidden = false;
  elements.loading.textContent = message;
  elements.textViewer.hidden = true;
  stopHtmlPreview();
  elements.diffViewer.hidden = true;
  elements.diffViewer.replaceChildren();
  elements.mediaViewer.hidden = true;
}

function handleSelection() {
  if (!elements.annotationEditor.hidden) return;
  if (elements.textViewer.hidden || !state.workspace.activePath || !state.activeText) return hideSelectionAction();
  if (markdownPreviewVisible()) return handleMarkdownRenderedSelection();
  if (!elements.editViewer.hidden && document.activeElement === elements.fileEditor) {
    return handleEditorSelection();
  }
  const selection = globalThis.getSelection?.();
  if (!selection?.rangeCount || selection.isCollapsed) return hideSelectionAction();
  const range = selection.getRangeAt(0);
  if (!elements.code.contains(range.startContainer) || !elements.code.contains(range.endContainer)) return hideSelectionAction();
  const quote = range.toString();
  if (!quote.trim() || quote.length > 8_000) return hideSelectionAction();
  const startOffset = textOffsetAt(elements.code, range.startContainer, range.startOffset);
  const endOffset = textOffsetAt(elements.code, range.endContainer, range.endOffset);
  if (startOffset < 0 || endOffset <= startOffset) return hideSelectionAction();
  const rect = range.getBoundingClientRect();
  state.selectionDraft = annotationDraft(startOffset, endOffset, quote);
  showSelectionActionAtRect(rect);
}
handleSelection.timer = null;

function handleMarkdownRenderedSelection() {
  if (state.markdownBlockEdit) return;
  const selection = globalThis.getSelection?.();
  if (!selection?.rangeCount || selection.isCollapsed) return hideSelectionAction();
  const range = selection.getRangeAt(0);
  if (
    !elements.markdownRendered.contains(range.startContainer)
    || !elements.markdownRendered.contains(range.endContainer)
  ) return hideSelectionAction();
  const quote = range.toString();
  if (!quote.trim() || quote.length > 8_000) return hideSelectionAction();
  const startOffset = markdownSourceOffsetAtRenderedPoint(range.startContainer, range.startOffset);
  const endOffset = markdownSourceOffsetAtRenderedPoint(range.endContainer, range.endOffset);
  if (startOffset < 0 || endOffset <= startOffset) return hideSelectionAction();
  const sourceQuote = state.activeText.slice(startOffset, endOffset);
  state.selectionDraft = annotationDraft(startOffset, endOffset, quote, { sourceQuote });
  showSelectionActionAtRect(range.getBoundingClientRect());
}

function handleEditorSelection(event = null) {
  if (!elements.annotationEditor.hidden) return;
  if (state.fileEdit?.dirty) return hideSelectionAction();
  if (elements.editViewer.hidden || state.fileEdit?.path !== state.workspace.activePath) return hideSelectionAction();
  const startOffset = Number(elements.fileEditor.selectionStart);
  const endOffset = Number(elements.fileEditor.selectionEnd);
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) return hideSelectionAction();
  const quote = elements.fileEditor.value.slice(startOffset, endOffset);
  if (!quote.trim() || quote.length > 8_000) return hideSelectionAction();

  state.selectionDraft = annotationDraft(startOffset, endOffset, quote);
  elements.annotateSelection.hidden = false;
  const rect = elements.fileEditor.getBoundingClientRect();
  const width = 82;
  const left = event && Number.isFinite(event.clientX) ? event.clientX - width : rect.right - width - 12;
  const top = event && Number.isFinite(event.clientY) ? event.clientY + 8 : rect.top + 18;
  state.selectionRect = { left, right: left + width, top, bottom: top };
  elements.annotateSelection.style.left = `${Math.max(8, Math.min(globalThis.innerWidth - width - 8, left))}px`;
  elements.annotateSelection.style.top = `${Math.max(8, Math.min(globalThis.innerHeight - 38, top))}px`;
}

function handleMarkdownBlockEditorSelection(event = null) {
  if (!elements.annotationEditor.hidden) return;
  const edit = state.markdownBlockEdit;
  if (!edit || edit.path !== state.workspace.activePath || edit.changed) return hideSelectionAction();
  const start = Number(edit.textarea.selectionStart);
  const end = Number(edit.textarea.selectionEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return hideSelectionAction();
  const quote = edit.textarea.value.slice(start, end);
  if (!quote.trim() || quote.length > 8_000) return hideSelectionAction();
  state.selectionDraft = annotationDraft(edit.start + start, edit.start + end, quote);
  elements.annotateSelection.hidden = false;
  const rect = edit.textarea.getBoundingClientRect();
  const width = 82;
  const left = event && Number.isFinite(event.clientX) ? event.clientX - width : rect.right - width - 12;
  const top = event && Number.isFinite(event.clientY) ? event.clientY + 8 : rect.top + 18;
  state.selectionRect = { left, right: left + width, top, bottom: top };
  elements.annotateSelection.style.left = `${Math.max(8, Math.min(globalThis.innerWidth - width - 8, left))}px`;
  elements.annotateSelection.style.top = `${Math.max(8, Math.min(globalThis.innerHeight - 38, top))}px`;
}

function showSelectionActionAtRect(rect) {
  state.selectionRect = rect;
  elements.annotateSelection.hidden = false;
  const width = 82;
  elements.annotateSelection.style.left = `${Math.max(8, Math.min(globalThis.innerWidth - width - 8, rect.right - width))}px`;
  elements.annotateSelection.style.top = `${Math.max(8, Math.min(globalThis.innerHeight - 38, rect.bottom + 6))}px`;
}

function annotationDraft(startOffset, endOffset, quote, { sourceQuote = "" } = {}) {
  return {
    path: state.workspace.activePath,
    quote,
    ...(sourceQuote && sourceQuote !== quote ? { sourceQuote } : {}),
    prefix: state.activeText.slice(Math.max(0, startOffset - 160), startOffset),
    suffix: state.activeText.slice(endOffset, endOffset + 160),
    start: positionForOffset(state.activeText, startOffset),
    end: positionForOffset(state.activeText, endOffset),
  };
}

function openAnnotationEditor({ draft = null, annotation = null, anchor = null }) {
  const source = annotation || draft;
  if (!source) return;
  state.editingAnnotation = annotation || null;
  state.selectionDraft = draft || null;
  state.editorSource = {
    ...source,
    start: source.start ? { ...source.start } : source.start,
    end: source.end ? { ...source.end } : source.end,
  };
  elements.annotationComment.value = annotation?.comment || "";
  elements.annotationEditor.classList.toggle("editing", Boolean(annotation));
  elements.existingActions.hidden = !annotation;
  elements.annotationEditor.hidden = false;
  // Keep the selected-file draft alive while the editor is open. The previous
  // implementation called hideSelectionAction(), which also nulled the draft,
  // so clicking the ✓ button had nothing left to persist.
  elements.annotateSelection.hidden = true;
  const rect = anchor?.getBoundingClientRect?.() || state.selectionRect || activeSelectionRect();
  resizeAnnotationInput(elements.annotationComment);
  const width = 420;
  const left = Math.max(8, Math.min(globalThis.innerWidth - width - 8, (rect?.left ?? 20)));
  const topCandidate = (rect?.bottom ?? 80) + 8;
  elements.annotationEditor.style.left = `${left}px`;
  elements.annotationEditor.style.top = `${Math.max(8, Math.min(globalThis.innerHeight - 190, topCandidate))}px`;
  requestAnimationFrame(() => elements.annotationComment.focus());
}

function resizeAnnotationInput(textarea) {
  textarea.style.height = "36px";
  const next = Math.min(150, Math.max(36, textarea.scrollHeight));
  textarea.style.height = `${next}px`;
  textarea.style.overflowY = textarea.scrollHeight > 150 ? "auto" : "hidden";
}

async function saveAnnotation() {
  const comment = elements.annotationComment.value.trim();
  if (!comment) return elements.annotationComment.focus();
  const source = state.editorSource;
  if (!source) return;
  elements.saveAnnotation.disabled = true;
  elements.saveExistingAnnotation.disabled = true;
  try {
    const payload = await workspaceRequest("upsert_annotation", {
      annotation: {
        ...(state.editingAnnotation?.id ? { id: state.editingAnnotation.id } : {}),
        path: source.path,
        comment,
        quote: source.quote,
        ...(source.sourceQuote ? { sourceQuote: source.sourceQuote } : {}),
        prefix: source.prefix || "",
        suffix: source.suffix || "",
        start: source.start,
        end: source.end,
      },
    });
    state.workspace = payload.workspace;
    hideAnnotationEditor();
    clearSelection();
    renderActiveAnnotations();
    postAnnotations();
  } catch (error) {
    elements.annotationComment.setCustomValidity(error instanceof Error ? error.message : String(error));
    elements.annotationComment.reportValidity();
    elements.annotationComment.setCustomValidity("");
  } finally {
    elements.saveAnnotation.disabled = false;
    elements.saveExistingAnnotation.disabled = false;
  }
}

async function deleteEditingAnnotation() {
  if (!state.editingAnnotation?.id) return;
  elements.deleteAnnotation.disabled = true;
  try {
    const payload = await workspaceRequest("delete_annotation", { id: state.editingAnnotation.id });
    state.workspace = payload.workspace;
    hideAnnotationEditor();
    renderActiveAnnotations();
    postAnnotations();
  } finally {
    elements.deleteAnnotation.disabled = false;
  }
}

function renderActiveAnnotations() {
  const annotations = state.workspace.annotations.filter((item) => item.path === state.workspace.activePath);
  renderFileHighlights(annotations);
  scheduleAnnotationMarkers(annotations);
}

function renderFileHighlights(annotations) {
  clearFileHighlights();
  if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== "function") return;
  if (state.fileEdit?.dirty) return;
  const previewingMarkdown = markdownPreviewVisible() && !state.markdownBlockEdit;
  const root = previewingMarkdown
    ? elements.markdownRendered
    : (!elements.editViewer.hidden && state.fileEdit?.path === state.workspace.activePath
      ? elements.editCode
      : elements.code);
  const ranges = [];
  for (const annotation of annotations) {
    const offsets = resolveAnnotationOffsets(annotation);
    if (!offsets) continue;
    const range = previewingMarkdown
      ? markdownRangeFromSourceOffsets(offsets.start, offsets.end)
      : rangeFromOffsets(root, offsets.start, offsets.end);
    if (range) ranges.push(range);
  }
  if (ranges.length) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

function clearFileHighlights() {
  globalThis.CSS?.highlights?.delete?.(HIGHLIGHT_NAME);
}

function scheduleAnnotationMarkers(annotations = null) {
  if (annotations) state.pendingAnnotationMarkers = annotations;
  if (state.annotationMarkerFrame) return;
  state.annotationMarkerFrame = requestAnimationFrame(() => {
    state.annotationMarkerFrame = 0;
    const pending = state.pendingAnnotationMarkers;
    state.pendingAnnotationMarkers = null;
    renderAnnotationMarkers(pending || undefined);
  });
}

function renderAnnotationMarkers(annotations = state.workspace.annotations.filter((item) => item.path === state.workspace.activePath)) {
  elements.markers.replaceChildren();
  if (state.fileEdit?.dirty) return;
  const previewingMarkdown = markdownPreviewVisible() && !state.markdownBlockEdit;
  const editing = !elements.editViewer.hidden && state.fileEdit?.path === state.workspace.activePath;
  const scroller = previewingMarkdown ? elements.markdownRendered : (editing ? elements.fileEditor : elements.scroll);
  const root = previewingMarkdown ? elements.markdownRendered : (editing ? elements.editCode : elements.code);
  positionAnnotationMarkerLayer(scroller);
  const viewportHeight = scroller.clientHeight;
  const naturalTops = annotations.map((annotation) => annotationMarkerTop(annotation, root, scroller));
  const markerTops = layoutAnnotationMarkerTops(naturalTops, viewportHeight);
  annotations.forEach((annotation, index) => {
    const naturalTop = naturalTops[index];
    const top = markerTops[index];
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "annotation-marker";
    marker.textContent = String(index + 1);
    marker.setAttribute("aria-label", `Open annotation ${index + 1}`);
    marker.style.top = `${top}px`;
    const maxNaturalTop = Math.max(4, viewportHeight - 34);
    const offscreen = naturalTop < 4 ? "above" : naturalTop > maxNaturalTop ? "below" : "";
    if (offscreen) marker.dataset.offscreen = offscreen;
    const positionHint = offscreen ? `, ${offscreen} current view` : "";
    marker.setAttribute("aria-label", `Annotation ${index + 1}${positionHint}`);
    marker.title = offscreen ? `Annotation ${index + 1} (${offscreen})` : `Annotation ${index + 1}`;
    marker.addEventListener("mouseenter", () => showAnnotationTooltip(annotation, marker));
    marker.addEventListener("mouseleave", hideAnnotationTooltip);
    marker.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideAnnotationTooltip();
      openAnnotationEditor({ annotation, anchor: marker });
    });
    elements.markers.appendChild(marker);
  });
}

function positionAnnotationMarkerLayer(scroller) {
  const viewerRect = elements.textViewer.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const width = 30;
  const top = Math.max(0, scrollerRect.top - viewerRect.top);
  const left = Math.max(0, scrollerRect.left - viewerRect.left + scroller.clientWidth - width);
  elements.markers.style.top = `${top}px`;
  elements.markers.style.left = `${left}px`;
  elements.markers.style.width = `${width}px`;
  elements.markers.style.height = `${Math.max(0, scroller.clientHeight)}px`;
}

function layoutAnnotationMarkerTops(naturalTops, viewportHeight) {
  const markerHeight = 30;
  const gap = 4;
  const spacing = markerHeight + gap;
  const minTop = 4;
  const maxTop = Math.max(minTop, viewportHeight - markerHeight - 4);
  const entries = naturalTops.map((top, index) => ({
    index,
    desired: Math.max(minTop, Math.min(maxTop, Number.isFinite(top) ? top : minTop)),
  })).sort((a, b) => a.desired - b.desired || a.index - b.index);
  const result = Array(naturalTops.length).fill(minTop);
  if (!entries.length) return result;

  if ((entries.length - 1) * spacing > maxTop - minTop) {
    const step = entries.length > 1 ? (maxTop - minTop) / (entries.length - 1) : 0;
    entries.forEach((entry, index) => { result[entry.index] = minTop + step * index; });
    return result;
  }

  const positions = entries.map((entry) => entry.desired);
  for (let index = 1; index < positions.length; index += 1) {
    positions[index] = Math.max(positions[index], positions[index - 1] + spacing);
  }
  positions[positions.length - 1] = Math.min(positions[positions.length - 1], maxTop);
  for (let index = positions.length - 2; index >= 0; index -= 1) {
    positions[index] = Math.min(positions[index], positions[index + 1] - spacing);
  }
  if (positions[0] < minTop) {
    positions[0] = minTop;
    for (let index = 1; index < positions.length; index += 1) {
      positions[index] = Math.max(positions[index], positions[index - 1] + spacing);
    }
  }
  entries.forEach((entry, index) => { result[entry.index] = positions[index]; });
  return result;
}

function annotationMarkerTop(annotation, root, scroller) {
  const offsets = resolveAnnotationOffsets(annotation);
  if (offsets) {
    const range = root === elements.markdownRendered
      ? markdownRangeFromSourceOffsets(offsets.start, offsets.end)
      : rangeFromOffsets(root, offsets.start, offsets.end);
    if (range) {
      const rects = [...range.getClientRects()];
      const rangeRect = rects.find((rect) => rect.height > 0 || rect.width > 0) || range.getBoundingClientRect();
      const markersRect = elements.markers.getBoundingClientRect();
      const measuredTop = rangeRect.top - markersRect.top;
      if (Number.isFinite(measuredTop)) return measuredTop;
    }
  }

  const line = Math.max(1, Number(annotation.start?.line) || 1);
  return 12 + (line - 1) * state.codeLineHeight - scroller.scrollTop;
}

function showAnnotationTooltip(annotation, marker) {
  elements.annotationTooltip.replaceChildren();
  const quote = document.createElement("div");
  quote.className = "tooltip-quote";
  quote.textContent = compact(annotation.quote, 150);
  const comment = document.createElement("div");
  comment.textContent = annotation.comment;
  elements.annotationTooltip.append(quote, comment);
  elements.annotationTooltip.hidden = false;
  const rect = marker.getBoundingClientRect();
  const width = 310;
  elements.annotationTooltip.style.left = `${Math.max(8, Math.min(globalThis.innerWidth - width - 8, rect.left - width - 7))}px`;
  elements.annotationTooltip.style.top = `${Math.max(8, Math.min(globalThis.innerHeight - 100, rect.top))}px`;
}

function hideAnnotationTooltip() {
  elements.annotationTooltip.hidden = true;
}

function resolveAnnotationOffsets(annotation) {
  if (!annotation?.quote || !state.activeText) return null;
  const sourceQuote = typeof annotation.sourceQuote === "string" && annotation.sourceQuote
    ? annotation.sourceQuote
    : annotation.quote;
  const start = Number(annotation.start?.offset);
  const end = Number(annotation.end?.offset);
  if (
    Number.isInteger(start)
    && Number.isInteger(end)
    && start >= 0
    && end <= state.activeText.length
    && state.activeText.slice(start, end) === sourceQuote
  ) {
    return { start, end };
  }
  const candidates = [];
  let cursor = 0;
  while (cursor <= state.activeText.length) {
    const index = state.activeText.indexOf(sourceQuote, cursor);
    if (index < 0) break;
    let score = 0;
    if (annotation.prefix && state.activeText.slice(Math.max(0, index - annotation.prefix.length), index) === annotation.prefix) score += 2;
    if (annotation.suffix && state.activeText.slice(index + sourceQuote.length, index + sourceQuote.length + annotation.suffix.length) === annotation.suffix) score += 2;
    score -= Math.abs(index - (start || 0)) / Math.max(1, state.activeText.length);
    candidates.push({ start: index, end: index + sourceQuote.length, score });
    cursor = index + Math.max(1, sourceQuote.length);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function rangeFromOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  let cursor = 0;
  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;
  while ((node = walker.nextNode())) {
    const next = cursor + node.nodeValue.length;
    if (!startNode && start >= cursor && start <= next) {
      startNode = node;
      startOffset = start - cursor;
    }
    if (endNode === null && end >= cursor && end <= next) {
      endNode = node;
      endOffset = end - cursor;
      break;
    }
    cursor = next;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

function textOffsetAt(root, node, offset) {
  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return -1;
  }
}

function positionForOffset(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return { line, column: offset - lastNewline, offset };
}

function activeSelectionRect() {
  const selection = globalThis.getSelection?.();
  return selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
}

function hideSelectionAction() {
  elements.annotateSelection.hidden = true;
  state.selectionDraft = null;
  state.selectionRect = null;
}

function hideAnnotationEditor() {
  elements.annotationEditor.hidden = true;
  state.editingAnnotation = null;
  state.editorSource = null;
  state.selectionDraft = null;
  state.selectionRect = null;
  elements.annotationComment.value = "";
}

function clearSelection() {
  globalThis.getSelection?.()?.removeAllRanges?.();
}

async function closeSidebar() {
  if (PRESENTATION === "standalone") {
    if (HOST_MODE === "sidepanel") {
      parent.postMessage({ source: "local-system-file-workspace", action: "close-sidebar" }, "*");
      return;
    }
    setVisible(false);
    return;
  }
  state.workspace = await persistWorkspace({
    openPaths: state.workspace.openPaths,
    activePath: state.workspace.activePath,
    sidebarOpen: false,
    width: state.workspace.width,
  });
  setVisible(false);
}

async function toggleSidebar() {
  if (state.workspace.sidebarOpen) {
    await closeSidebar();
    return;
  }

  if (!state.currentWorkspace) {
    requestProjectPicker();
    return;
  }

  state.workspace = await persistWorkspace({
    openPaths: state.workspace.openPaths,
    activePath: state.workspace.activePath || state.workspace.openPaths.at(-1),
    sidebarOpen: persistedSidebarOpen(true),
    width: state.workspace.width,
  });
  setVisible(true);
  applyPaneLayout();
  if (!state.workspace.treeCollapsed && !elements.projectTree.children.length) await loadProjectRoot();
  renderTabs();
  if (state.workspace.activePath) await showPath(state.workspace.activePath);
  else showMessage("Select a file from the project tree or use ⌘P.");
}

async function openWorkspaceMode(mode) {
  if (!state.currentWorkspace) {
    requestProjectPicker();
    return;
  }
  state.workspace = await persistWorkspace({
    openPaths: state.workspace.openPaths,
    activePath: state.workspace.activePath,
    sidebarOpen: persistedSidebarOpen(true),
    width: state.workspace.width,
    treeCollapsed: state.workspace.treeCollapsed,
    treeHeight: state.workspace.treeHeight,
  });
  setVisible(true);
  applyPaneLayout();
  await ensureLeftPane(mode);
}

function requestQuickOpen(mode = "files", query = "") {
  if (!state.currentWorkspace) return requestProjectPicker();
  parent.postMessage({
    source: "local-system-file-workspace",
    action: "quick-open",
    mode: mode === "text" ? "text" : "files",
    query: String(query || "").slice(0, 300),
  }, "*");
}

function requestProjectPicker() {
  parent.postMessage({ source: "local-system-file-workspace", action: "project-picker" }, "*");
}

function setVisible(visible) {
  parent.postMessage({
    source: "local-system-file-workspace",
    action: "visibility",
    visible,
    width: state.workspace.width || 476,
  }, "*");
}

function postAnnotations() {
  parent.postMessage({
    source: "local-system-file-workspace",
    action: "annotations-state",
    annotations: state.workspace.annotations || [],
  }, "*");
}

async function persistWorkspace(patch) {
  const payload = await workspaceRequest("update", { workspace: patch });
  if (typeof payload.currentWorkspace === "string") state.currentWorkspace = payload.currentWorkspace;
  postWorkspaceVisibility(payload.workspace);
  return payload.workspace;
}

function rememberActiveScroll(scrollTop) {
  if (state.restoringScroll) return;
  const path = state.workspace.activePath;
  if (!path) return;
  const value = Math.max(0, Math.round(Number(scrollTop) || 0));
  state.scrollByPath.set(path, value);
  state.workspace.activeScrollTop = value;
  clearTimeout(state.scrollPersistTimer);
  state.scrollPersistTimer = setTimeout(() => {
    state.scrollPersistTimer = 0;
    void persistActiveScroll(path, value);
  }, 120);
}

function flushActiveScrollPersistence() {
  const path = state.workspace.activePath;
  if (!path) return;
  const value = state.restoringScroll
    ? Math.max(0, Math.round(Number(state.scrollByPath.get(path) ?? state.workspace.activeScrollTop) || 0))
    : Math.max(0, Math.round(Number(activeFileScrollTop()) || 0));
  state.scrollByPath.set(path, value);
  state.workspace.activeScrollTop = value;
  clearTimeout(state.scrollPersistTimer);
  state.scrollPersistTimer = 0;
  void persistActiveScroll(path, value, { keepalive: true });
}

async function persistActiveScroll(path, scrollTop, { keepalive = false } = {}) {
  if (!path || path !== state.workspace.activePath) return;
  try {
    const payload = await workspaceRequest("update", {
      workspace: { activeScrollTop: scrollTop },
    }, { keepalive });
    if (path === state.workspace.activePath && payload.workspace) {
      state.workspace.activeScrollTop = Math.max(0, Number(payload.workspace.activeScrollTop) || 0);
    }
  } catch {
    // Scroll persistence is best-effort; the in-memory position remains valid.
  }
}

async function traceWorkspace(stage, { path = null, data = null } = {}) {
  try {
    await bridgeRequest("/local-ui/workspace-trace", {
      action: "record",
      event: { stage, threadId, path, data },
    });
  } catch {
    // Diagnostics must never affect workspace behavior.
  }
}

function postWorkspaceVisibility(workspace) {
  parent.postMessage({
    source: "local-system-file-workspace",
    action: "visibility",
    visible: workspaceShouldBeVisible(workspace),
    width: workspace.width,
  }, "*");
}

async function workspaceRequest(action, extra, options = {}) {
  return bridgeRequest("/local-ui/file-workspace", { threadId, action, active: state.hostActive, ...extra }, options);
}

async function bridgeRequest(path, body, { signal, keepalive = false, timeoutMs = null } = {}) {
  const api = globalThis.LocalSystemExtensionApi;
  if (!api?.request) throw new Error("Local System extension API unavailable");
  return api.request(path, body, {
    signal,
    timeoutMs: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : (keepalive ? 8_000 : 2_500),
  });
}

function startResize(event) {
  if (event.button !== 0 || event.isPrimary === false) return;
  event.preventDefault();
  elements.resizeHandle.setPointerCapture?.(event.pointerId);
  // clientX is local to this iframe. Because the iframe is right-anchored, its
  // left edge moves while it is resized, which changes clientX during the same
  // drag and produces an oscillating/jittery width. screenX stays stable across
  // the iframe boundary and gives us a fixed coordinate system for the gesture.
  const start = { x: event.screenX, width: state.workspace.width || globalThis.innerWidth };
  let dragging = false;
  let pendingWidth = state.workspace.width;
  let resizeFrame = 0;
  const flushResize = () => {
    resizeFrame = 0;
    if (!Number.isFinite(pendingWidth)) return;
    state.workspace.width = Math.round(pendingWidth);
    parent.postMessage({ source: "local-system-file-workspace", action: "resize", width: state.workspace.width }, "*");
  };
  const onMove = (moveEvent) => {
    if (!(moveEvent.buttons & 1)) return finish(false);
    const delta = start.x - moveEvent.screenX;
    // Do not enter resize mode just because the pointer crossed the divider or
    // because a trackpad generated a tiny press. It must be an intentional drag.
    if (!dragging && Math.abs(delta) < 4) return;
    if (!dragging) {
      dragging = true;
      state.resizeStart = start;
      elements.resizeHandle.classList.add("dragging");
      parent.postMessage({ source: "local-system-file-workspace", action: "resize-start" }, "*");
    }
    pendingWidth = Math.max(420, Math.min(1_000, start.width + delta));
    if (!resizeFrame) resizeFrame = requestAnimationFrame(flushResize);
  };
  const finish = async (persist = true) => {
    globalThis.removeEventListener("pointermove", onMove);
    globalThis.removeEventListener("pointerup", onUp);
    globalThis.removeEventListener("pointercancel", onCancel);
    if (resizeFrame) globalThis.cancelAnimationFrame(resizeFrame);
    if (dragging) flushResize();
    if (dragging) {
      elements.resizeHandle.classList.remove("dragging");
      parent.postMessage({ source: "local-system-file-workspace", action: "resize-end" }, "*");
    }
    state.resizeStart = null;
    if (dragging && state.wrapText && state.fileEdit?.path === state.workspace.activePath) {
      scheduleEditLineNumbers(elements.fileEditor.value);
    }
    if (!dragging || !persist) return;
    state.workspace = await persistWorkspace({
      openPaths: state.workspace.openPaths,
      activePath: state.workspace.activePath,
      sidebarOpen: state.workspace.sidebarOpen,
      width: state.workspace.width,
    });
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  globalThis.addEventListener("pointermove", onMove);
  globalThis.addEventListener("pointerup", onUp);
  globalThis.addEventListener("pointercancel", onCancel);
}

async function copyActivePath() {
  if (!state.workspace.activePath) return;
  const originalTitle = elements.copyPath.title;
  try {
    await navigator.clipboard.writeText(state.workspace.activePath);
    showCopySuccess(elements.copyPath, "Copied", originalTitle);
  } catch {
    // Clipboard access can be denied by browser policy; keep the viewer usable.
  }
}

function showCopySuccess(button, successTitle, originalTitle = button.title, durationMs = 900) {
  if (!button) return;
  const originalMarkup = button.dataset.copyOriginalMarkup || button.innerHTML;
  button.dataset.copyOriginalMarkup = originalMarkup;
  const priorTimer = Number(button.dataset.copyFeedbackTimer || 0);
  if (priorTimer) clearTimeout(priorTimer);
  button.innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';
  button.title = successTitle;
  const timer = setTimeout(() => {
    button.innerHTML = originalMarkup;
    button.title = originalTitle;
    delete button.dataset.copyFeedbackTimer;
    delete button.dataset.copyOriginalMarkup;
  }, durationMs);
  button.dataset.copyFeedbackTimer = String(timer);
}

function applyTheme(theme) {
  globalThis.LocalSystemSharedRuntime?.applyTheme(theme, { aliases: true });
  if (theme?.fontSize) {
    document.documentElement.style.setProperty("--workspace-ui-font-size", theme.fontSize);
    const secondaryFontSize = scaledPixelValue(theme.fontSize, 0.92);
    if (secondaryFontSize) document.documentElement.style.setProperty("--workspace-secondary-font-size", secondaryFontSize);
  }
  const contentFontSize = theme?.contentFontSize || theme?.mainFontSize;
  const scaledContentFontSize = scaledPixelValue(contentFontSize, WORKSPACE_CONTENT_SCALE);
  if (scaledContentFontSize) document.documentElement.style.setProperty("--workspace-code-font-size", scaledContentFontSize);
  const contentLineHeight = theme?.contentLineHeight;
  const scaledContentLineHeight = scaledPixelValue(contentLineHeight, WORKSPACE_CONTENT_SCALE);
  if (scaledContentLineHeight) {
    document.documentElement.style.setProperty("--workspace-code-line-height", scaledContentLineHeight);
    const parsed = Number.parseFloat(scaledContentLineHeight);
    if (Number.isFinite(parsed) && parsed > 0) state.codeLineHeight = parsed;
  }
  if (state.wrapText && state.fileEdit?.path === state.workspace.activePath) scheduleEditLineNumbers(elements.fileEditor.value);
  if (state.workspace.activePath && !state.fileEdit?.dirty) scheduleAnnotationMarkers();
}

function scaledPixelValue(value, scale) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  const rounded = Math.round(parsed * scale * 2) / 2;
  return `${rounded}px`;
}

function releaseFile(path) {
  const file = state.files.get(path);
  if (file?.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(file.objectUrl);
  state.files.delete(path);
  state.scrollByPath.delete(path);
}

function isTextLike(path, mime) {
  if (mime.startsWith("text/")) return true;
  if (["application/json", "application/x-ndjson", "application/xml", "application/yaml", "application/javascript"].includes(mime)) return true;
  const name = basename(path).toLowerCase();
  if (TEXT_DOTFILES.has(name) || name === ".env" || name.startsWith(".env.")) return true;
  const ext = extensionFor(path);
  return TEXT_EXTENSIONS.has(ext) || basename(path).toLowerCase() === "dockerfile";
}

function mediaKind(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "binary";
}

function languageFor(path, ext = extensionFor(path)) {
  const name = basename(path).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  const map = {
    js:"javascript",mjs:"javascript",cjs:"javascript",jsx:"javascript",
    ts:"typescript",tsx:"typescript",py:"python",pyw:"python",
    html:"xml",htm:"xml",xml:"xml",svg:"xml",css:"css",
    sh:"bash",zsh:"bash",bash:"bash",sql:"sql",java:"java",cs:"csharp",
    c:"c",h:"cpp",cc:"cpp",cpp:"cpp",cxx:"cpp",hpp:"cpp",
    go:"go",rs:"rust",yaml:"yaml",yml:"yaml",md:"markdown",markdown:"markdown",mdx:"markdown",
    kt:"kotlin",kts:"kotlin",swift:"swift",rb:"ruby",php:"php",ini:"ini",toml:"ini",properties:"ini",
    json:"json",jsonl:"json",
  };
  return map[ext] || "plaintext";
}

function extensionFor(path) {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  if (index > 0) return name.slice(index + 1).toLowerCase();
  if (index === 0) return name.slice(1).toLowerCase();
  return name.toLowerCase();
}

function basename(path) {
  return String(path || "").split(/[\\/]/).pop() || String(path || "");
}

function compact(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
