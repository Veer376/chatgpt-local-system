/* global chrome, DataTransfer, document, DragEvent, getComputedStyle, IntersectionObserver, location, MutationObserver, Node, NodeFilter, requestAnimationFrame */

const LOCAL_FILE_EXTENSION_PATTERN = "(?:png|jpe?g|gif|webp|avif|svg|md|markdown|mdx|pdf|txt|log|rst|adoc|asciidoc|jsonl?|ya?ml|toml|ini|conf|env|csv|tsv|js|mjs|cjs|jsx|ts|tsx|html?|css|scss|sass|less|xml|py|pyw|sh|bash|zsh|fish|sql|java|cs|c|h|cc|cpp|cxx|hpp|go|rs|kt|kts|swift|rb|php|gradle|vue|svelte|properties|docx?|xlsx?|pptx?|zip|mp3|wav|m4a|mp4|mov|webm)";
const LOCAL_SPECIAL_FILE_PATTERN = "(?:Dockerfile|Makefile|Gemfile|Rakefile|Procfile|\\.gitignore|\\.env(?:\\.[A-Za-z0-9_.-]+)?)";
const LOCAL_FILE_NAME_PATTERN = `(?:[A-Za-z0-9_.@()+-]+\\.${LOCAL_FILE_EXTENSION_PATTERN}|${LOCAL_SPECIAL_FILE_PATTERN})`;
const LOCAL_FILE_BOUNDARY_PATTERN = "(?=$|[\\s\\u0060'\"<>)\\]}.,;:!?])";
const FILE_PATH_RE = new RegExp(`(?:[A-Za-z]:\\\\[^\\r\\n\u0060'"<>]*?${LOCAL_FILE_NAME_PATTERN}|\\/[^\\r\\n\u0060'"<>]*?${LOCAL_FILE_NAME_PATTERN}|(?:\\.{1,2}[\\\\/])?(?:[A-Za-z0-9_.@()+-]+[\\\\/])+${LOCAL_FILE_NAME_PATTERN}|${LOCAL_FILE_NAME_PATTERN})${LOCAL_FILE_BOUNDARY_PATTERN}`, "gi");
const DIRECTORY_PATH_RE = /(?:[A-Za-z]:\\[^\r\n`'"<>]+[\\/]|\/[^\s`'"<>]+\/|(?:\.{1,2}[\\/])?(?:[A-Za-z0-9_.@()+-]+[\\/])+)(?=$|[\s`'"<>)\]}])/g;
const CHATGPT_DISCLAIMER_TEXT = "ChatGPT can make mistakes. Check important info.";
const ENABLE_FILE_WORKSPACE = true;
const UI_VISIBILITY_STORAGE_KEY = globalThis.LocalSystemSharedRuntime.UI_VISIBILITY_STORAGE_KEY;
const DEFAULT_UI_VISIBILITY = globalThis.LocalSystemSharedRuntime.DEFAULT_UI_VISIBILITY;
const MESSAGE_ROLE_SELECTOR = '[data-message-author-role="assistant"], [data-message-author-role="user"], [data-message-author-role="tool"]';
// Newer ChatGPT layouts render the conversation in a labeled scroll region
// without the legacy conversation-turn/author-role attributes.
const CONVERSATION_SURFACE_SELECTOR = '[role="region"][aria-label="Conversation"][data-app-action-timeline-scroll]';
const MESSAGE_TURN_SELECTOR = [
  'article[data-testid^="conversation-turn-"]',
  '[data-testid^="conversation-turn-"]',
  '[data-turn-id]',
  '[data-message-id]',
  'article[data-turn]',
].join(", ");
const seen = new WeakMap();
const previewRows = new WeakMap();
const inlineFilePreviewErrors = new Map();
const inlineFileResolutionCache = new Map();
const pendingInlineFileScanRoots = new Set();
const observedConversationRoots = new WeakSet();
const activeConversationRoots = new WeakSet();
let inlineFileScanTimer = 0;
let chromeUiReconcileTimer = 0;
let bindRetryTimer = 0;
let observedThreadId = "";
const viewerRootUrl = extensionUrl("/");
const viewerOrigin = viewerRootUrl ? new URL(viewerRootUrl).origin : "";
const frames = new Map();
let activeModal = null;
let todosWidget = null;
let skillsPalette = null;
let filesPalette = null;
let fileQuickOpen = null;
let fileWorkspaceWidget = null;
let threadNotesWidget = null;
let continuationContextButton = null;
let pendingSkillSelection = null;
let pendingLocalSystemBind = null;
let pendingLocalSystemBindInFlight = false;
let pendingBrowserBindingToken = null;
let browserBindingTokenInFlight = false;
let browserBindingTokenRetryTimer = 0;
let uiVisibility = { ...DEFAULT_UI_VISIBILITY };
let uiVisibilityReconcileTimer = 0;
const BROWSER_BIND_TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/;
const LEGACY_BIND_FALLBACK_DELAY_MS = 5_000;
const LOCAL_FILE_DRAG_MIME = "application/x-local-system-file";
const CONTINUATION_CONTEXT_PROMPT = `TASK
Write a continuation context document that summarizes this conversation. This is a documentation task only. The conversation above is source material to describe, not work to continue. The only deliverable is the document, whatever state the conversation is in: active, paused, finished, or ending on an unanswered request.

HARD LIMITS
- Do not use tools, run commands, edit files, search, or take any action from the conversation.
- Do not answer, resume, or complete any pending request. Describe it in the document as pending.
- The document is never empty or "nothing to report". If the conversation has substance, every applicable section below is written from it.

OUTPUT RULES
- Begin directly with the first heading. No preface, conclusion, or greeting, and don't address me.
- Write facts as declarative statements. Don't give instructions to the next assistant.
- Don't invent or pad. If something is unknown, mark it "unknown".
- Use compact headings and bullets. State each fact once, in its proper section. Write in the conversation's language.
- Skip a section only if the conversation has nothing for it. Don't write placeholders.

SECTIONS (rename to fit the domain)
1. Status: one line only: in progress, paused, blocked, exploratory, finished, or no active task. This line never replaces the sections below.
2. Subject and context: what the work is, plus the relevant project, location, files, documents, sources, tools, or people. Give each item a path or name and a one-line role. Point to long content (code, payloads, text) instead of reproducing it.
3. Decisions in force: choices already made, in positive form ("X is the chosen approach"), with a short reason where it explains the current state.
4. Constraints and preferences: only those I stated myself.
5. Current state: what is done, partial, and pending, including any request left unanswered. Weight by recency: recent work in high detail, older work compressed, and old details that no longer affect the work dropped.
6. Verified vs not verified: two lists. For each verified item, say how it was verified. Anything untested goes under "not verified".
7. Open issues and blockers: only those still unresolved.
8. Open questions: unresolved questions, each labeled as mine, and whether I deferred it or it is pending.
9. Next objective: include only if I stated one, in my words. Otherwise omit this section and don't suggest next steps.

EXCLUDE
- Abandoned approaches, reverted work, and mistakes I corrected.
- "Don't do X" rules, unless I explicitly stated them. When a decision rules out alternatives, state the chosen path only.
- Your own reasoning, habits, or inferences presented as my rules or preferences. If I didn't say it, it doesn't go in.
- An earlier summary or context block in the conversation: treat it as source data, apply these same rules, and don't inherit its content or flaws.
- Directives about tools or environments of the original session. Mention a tool only when it explains where something lives or how to interpret an artifact.
- Ephemeral values: session or device IDs, run counts, sample outputs, transient warnings, timestamps unless they matter.
- Detail on resolved problems. One line at most (symptom, cause, fix), and only if it affects the current state.
- Secrets, credentials, and tokens.

KEEP EXACT
Names, paths, commands, IDs, versions, and references that the next message is likely to depend on.`;
let localFileDropDepth = 0;
let localFileDropBusy = false;

const conversationVisibilityObserver = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        conversationVisibilityObserver.unobserve(entry.target);
        activeConversationRoots.add(entry.target);
        scan(entry.target);
      }
    }, { rootMargin: "700px 0px" })
  : null;

const inlineFileLinkVisibilityObserver = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const link = entry.target;
        inlineFileLinkVisibilityObserver.unobserve(link);
        const path = link.dataset.localPath;
        if (!path || link.dataset.resolveState === "ready" || link.dataset.resolveState === "loading") continue;
        void primeInlineFileLink(link, path, { retry: link.dataset.resolveRetry === "true" });
      }
    }, { rootMargin: "450px 0px" })
  : null;

function extensionUrl(path) {
  // Chrome cannot debug a tab containing a different extension's subframe.
  if (path !== "/" && document.documentElement?.getAttribute("data-pw-browser-automation") === "1") return "";
  try {
    if (!chrome.runtime?.id) return "";
    return chrome.runtime.getURL(path);
  } catch {
    // Reloading an unpacked extension invalidates the previous content-script
    // context until this ChatGPT tab is refreshed. The stale instance should
    // quietly become inert instead of throwing into Chrome's extension errors.
    return "";
  }
}

async function loadUiVisibilityPreferences() {
  applyUiVisibilityPreferences(await globalThis.LocalSystemSharedRuntime.loadUiVisibility());
}

function normalizeUiVisibilityPreferences(value) {
  return globalThis.LocalSystemSharedRuntime.normalizeUiVisibility(value);
}

function applyUiVisibilityPreferences(value) {
  uiVisibility = normalizeUiVisibilityPreferences(value);
  if (uiVisibility.workspace === false && fileWorkspaceWidget) {
    fileWorkspaceWidget.forceVisibility = false;
    fileWorkspaceWidget.host?.removeAttribute("data-local-system-force-visible");
  }
  const rootAttributes = {
    skills: "data-local-system-hide-skills",
    todos: "data-local-system-hide-todos",
    workspace: "data-local-system-hide-embedded-workspace",
    annotations: "data-local-system-hide-annotations",
  };
  for (const [key, attribute] of Object.entries(rootAttributes)) {
    document.documentElement.toggleAttribute(attribute, uiVisibility[key] === false);
  }
  const selectors = {
    skills: ".ls-skill-chip-group, .ls-skill-popover",
    todos: ".local-system-todos-host",
    workspace: ".local-system-file-workspace-host",
    annotations: '[data-local-system-annotation-ui="true"]',
  };
  for (const [key, selector] of Object.entries(selectors)) {
    for (const node of document.querySelectorAll(selector)) {
      node.toggleAttribute("data-local-system-ui-pref-hidden", uiVisibility[key] === false);
    }
  }
  reconcileComposerRailVisibility();
}

function scheduleUiVisibilityReconcile() {
  clearTimeout(uiVisibilityReconcileTimer);
  uiVisibilityReconcileTimer = setTimeout(() => {
    uiVisibilityReconcileTimer = 0;
    applyUiVisibilityPreferences(uiVisibility);
  }, 0);
}

function reconcileComposerRailVisibility() {
  for (const rail of document.querySelectorAll(".local-system-composer-rail")) {
    const hasVisibleChild = [...rail.children].some((child) => (
      !child.hidden && child.getAttribute("data-local-system-ui-pref-hidden") !== "true"
    ));
    rail.toggleAttribute("data-local-system-ui-empty", !hasVisibleChild);
  }
}

injectStyle();
void loadUiVisibilityPreferences();
chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== "local" || !changes?.[UI_VISIBILITY_STORAGE_KEY]) return;
  applyUiVisibilityPreferences(changes[UI_VISIBILITY_STORAGE_KEY].newValue);
});
observedThreadId = currentThreadId();
registerConversationRoots(document.body);
hideChatGptDisclaimer(document.body);
ensureContinuationContextButton();
ensureThreadNotesWidget();
installLocalFileDropTarget();

globalThis.addEventListener("message", (event) => {
  if (event.source === globalThis && event.origin === location.origin && event.data?.source === "local-system-mcp-observer") {
    void bindObservedMcpConversation(event.data?.conversationId);
    return;
  }
  if (event.data?.source === "local-system-binding-app") {
    handleBrowserBindingTokenMessage(event);
    return;
  }
  if (event.origin !== viewerOrigin) return;
  if (event.data?.source === "local-system-todos") {
    handleTodosMessage(event);
    return;
  }
  if (event.data?.source === "local-system-skills") {
    handleSkillsMessage(event);
    return;
  }
  if (event.data?.source === "local-system-files") {
    handleFilesMessage(event);
    return;
  }
  if (event.data?.source === "local-system-file-quick-open") {
    handleFileQuickOpenMessage(event);
    return;
  }
  if (event.data?.source === "local-system-file-workspace") {
    handleFileWorkspaceMessage(event);
    return;
  }
  if (event.data?.source !== "local-system-inline-image") return;
  if (event.data.action === "close") {
    if (activeModal && event.source === activeModal.frame.contentWindow) closeModal();
    return;
  }
  const frame = frames.get(event.data.id);
  if (!frame || event.source !== frame.contentWindow) {
    if (activeModal && event.source === activeModal.frame.contentWindow && event.data.status === "ready") {
      activeModal.frame.contentWindow.postMessage({
        source: "local-system-host",
        theme: composerPaletteTheme(),
      }, viewerOrigin);
    }
    return;
  }
  if (event.data.status === "ready") {
    frame.contentWindow.postMessage({
      source: "local-system-host",
      theme: composerPaletteTheme(),
    }, viewerOrigin);
    const width = Number(event.data.naturalWidth);
    const height = Number(event.data.naturalHeight);
    if (width > 0 && height > 0) {
      const card = frame.closest(".local-system-inline-image");
      if (card) card.style.aspectRatio = `${width} / ${height}`;
    }
    const card = frame.closest(".local-system-inline-image");
    if (card?.dataset.localPath) clearInlineFilePathError(card.dataset.localPath);
  }
  if (event.data.status === "error") {
    const card = frame.closest(".local-system-inline-image");
    if (card) {
      renderInlineFileResolutionError(card, {
        path: typeof event.data.path === "string" && event.data.path ? event.data.path : card.dataset.localPath,
        message: typeof event.data.message === "string" && event.data.message
          ? event.data.message
          : "Local file preview could not be resolved",
      });
    }
    frames.delete(event.data.id);
    return;
  }
  if (event.data.action === "open" && typeof event.data.path === "string") {
    openModal(event.data.path);
  }
});

const observer = new MutationObserver((mutations) => {
  let reconcileChromeUi = false;
  for (const mutation of mutations) {
    if (mutation.type === "characterData") {
      hideChatGptDisclaimer(mutation.target?.parentElement);
      scheduleInlineFileScan(mutation.target);
      continue;
    }
    for (const node of mutation.addedNodes) {
      registerConversationRoots(node);
      // New conversation UI streams completed text nodes as childList inserts,
      // not only as characterData mutations. Scan newly inserted content too.
      scheduleInlineFileScan(node);
      hideChatGptDisclaimer(node);
      if (node.nodeType === Node.ELEMENT_NODE) reconcileChromeUi = true;
    }
  }
  detectThreadChange();
  if (reconcileChromeUi) scheduleChromeUiReconcile();
  if (reconcileChromeUi) scheduleUiVisibilityReconcile();
});
observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
globalThis.addEventListener("focus", sendTodosHostState);
globalThis.addEventListener("blur", sendTodosHostState);
globalThis.addEventListener("local-system-skill-attach-result", handleSkillAttachResult);
globalThis.addEventListener("local-system-ui-visibility-change", (event) => {
  const key = event.detail?.key;
  if (!(key in DEFAULT_UI_VISIBILITY)) return;
  applyUiVisibilityPreferences({ ...uiVisibility, [key]: event.detail?.value === true });
});
document.addEventListener("visibilitychange", sendTodosHostState);
document.addEventListener("focusin", handleComposerActivation, true);
document.addEventListener("input", handleComposerPickerInput, true);
document.addEventListener("keydown", handleComposerPickerKeydown, true);
document.addEventListener("selectionchange", handleComposerPickerSelectionChange, true);
document.addEventListener("keydown", captureLocalSystemBindIntentFromKeydown, true);
document.addEventListener("click", captureLocalSystemBindIntentFromClick, true);
document.addEventListener("keydown", handleSidebarShortcuts, true);
document.addEventListener("pointerdown", handleThreadNotesOutsidePointerDown, true);
document.addEventListener("keydown", handleThreadNotesKeydown, true);
if (ENABLE_FILE_WORKSPACE) document.addEventListener("keydown", handleFileWorkspaceShortcut, true);
document.addEventListener("keydown", handleNativeSidebarShortcut, true);
document.addEventListener("pointerdown", handleTodosOutsidePointerDown, true);
document.addEventListener("pointerdown", handleFileQuickOpenOutsidePointerDown, true);
if (ENABLE_FILE_WORKSPACE) {
  globalThis.addEventListener("local-system-file-workspace-toggle-request", toggleFileWorkspace);
  globalThis.addEventListener("local-system-file-workspace-mode-request", (event) => {
    openFileWorkspaceMode(event.detail?.mode);
  });
  globalThis.addEventListener("local-system-standalone-quick-open", (event) => {
    openFileQuickOpen(
      event.detail?.mode === "text" ? "text" : "files",
      typeof event.detail?.query === "string" ? event.detail.query : "",
      "standalone",
    );
  });
  globalThis.addEventListener("local-system-standalone-toggle-left-sidebar", toggleChatGPTLeftSidebar);
  globalThis.addEventListener("local-system-open-file", (event) => {
    if (typeof event.detail?.path === "string") {
      void openFileFromChatGpt(
        event.detail.path,
        event.detail.line,
        event.detail.column,
        event.detail.length,
        { source: event.detail.source || "event" },
      );
    }
  });
  globalThis.addEventListener("local-system-project-changed", (event) => {
    inlineFileResolutionCache.clear();
    refreshInlineFileLinks();
    if (event.detail?.source !== "native-side-panel") void notifyNativeWorkspaceStateChanged();
    if (!fileWorkspaceWidget?.ready || !fileWorkspaceWidget.frame?.contentWindow) return;
    fileWorkspaceWidget.frame.contentWindow.postMessage({
      source: "local-system-host",
      action: "project-changed",
      openFiles: event.detail?.openFiles === true,
      active: document.visibilityState === "visible" && document.hasFocus(),
      theme: composerPaletteTheme(),
    }, viewerOrigin);
  });
  globalThis.addEventListener("local-system-file-annotations-refresh", () => {
    if (!fileWorkspaceWidget?.ready || !fileWorkspaceWidget.frame?.contentWindow) return;
    fileWorkspaceWidget.frame.contentWindow.postMessage({
      source: "local-system-host",
      action: "refresh-annotations",
    }, viewerOrigin);
  });
}
globalThis.addEventListener("resize", positionSkillsPalette);
globalThis.addEventListener("resize", positionFilesPalette);
globalThis.addEventListener("resize", positionThreadNotesPopover);
if (ENABLE_FILE_WORKSPACE) {
  globalThis.addEventListener("resize", () => {
    if (fileWorkspaceWidget?.visible) applyFileWorkspaceVisibility();
  });
}
function scan(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  // scanTextNode() can replace the current text node with a link fragment.
  // Mutating the DOM while advancing a live TreeWalker can make later text
  // nodes in the same ChatGPT message get skipped. Snapshot first so every
  // file reference in a response is processed deterministically.
  for (const textNode of textNodes) {
    if (textNode?.isConnected) scanTextNode(textNode);
  }
  enhanceLocalFileAnchors(root);
}

function scheduleInlineFileScan(node) {
  const root = conversationContentRootFor(node);
  const surface = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)
    ?.closest?.(CONVERSATION_SURFACE_SELECTOR);
  if (!root || (!activeConversationRoots.has(root) && !(surface && activeConversationRoots.has(surface)))) return;
  pendingInlineFileScanRoots.add(root);
  clearTimeout(inlineFileScanTimer);
  inlineFileScanTimer = setTimeout(flushInlineFileScans, 120);
}

function registerConversationRoots(root) {
  const element = root?.nodeType === Node.ELEMENT_NODE ? root : root?.parentElement;
  if (!element) return;
  const candidates = new Set();
  if (element.matches?.(MESSAGE_TURN_SELECTOR)) candidates.add(element);
  if (element.matches?.(CONVERSATION_SURFACE_SELECTOR)) candidates.add(element);
  const closest = element.closest?.(MESSAGE_TURN_SELECTOR);
  if (closest) candidates.add(closest);
  const surface = element.closest?.(CONVERSATION_SURFACE_SELECTOR);
  if (surface) candidates.add(surface);
  for (const candidate of element.querySelectorAll?.(MESSAGE_TURN_SELECTOR) || []) candidates.add(candidate);
  for (const candidate of element.querySelectorAll?.(CONVERSATION_SURFACE_SELECTOR) || []) candidates.add(candidate);
  for (const candidate of candidates) {
    if (observedConversationRoots.has(candidate)) continue;
    observedConversationRoots.add(candidate);
    if (conversationVisibilityObserver) {
      conversationVisibilityObserver.observe(candidate);
    } else {
      activeConversationRoots.add(candidate);
      scan(candidate);
    }
  }
}

function hideChatGptDisclaimer(root) {
  const element = root?.nodeType === Node.ELEMENT_NODE ? root : root?.parentElement;
  if (!element) return;
  const candidates = new Set();
  if (element.tagName === "DIV") candidates.add(element);
  for (const candidate of element.querySelectorAll?.("div") || []) candidates.add(candidate);
  for (const candidate of candidates) {
    if ((candidate.textContent || "").trim() !== CHATGPT_DISCLAIMER_TEXT) continue;
    candidate.style.setProperty("display", "none", "important");
    candidate.dataset.localSystemHidden = "chatgpt-disclaimer";
  }
}

function scheduleChromeUiReconcile() {
  if (chromeUiReconcileTimer) return;
  chromeUiReconcileTimer = setTimeout(() => {
    chromeUiReconcileTimer = 0;
    ensureContinuationContextButton();
    ensureThreadNotesWidget();
    ensureTodosWidget();
    if (ENABLE_FILE_WORKSPACE && fileWorkspaceWidget) ensureFileWorkspaceWidget();
  }, 120);
}

function handleComposerActivation(event) {
  if (!globalThis.LocalSystemSharedRuntime?.closestComposerEditor?.(event.target)) return;
  ensureTodosWidget();
}

function detectThreadChange() {
  const nextThreadId = currentThreadId();
  if (nextThreadId === observedThreadId) return;
  const previousThreadId = observedThreadId;
  observedThreadId = nextThreadId;
  pendingInlineFileScanRoots.clear();
  inlineFileResolutionCache.clear();
  removeTodosWidget();
  removeContinuationContextButton();
  removeThreadNotesWidget();
  if (ENABLE_FILE_WORKSPACE) removeFileWorkspaceWidget();
  registerConversationRoots(document.body);
  scheduleChromeUiReconcile();
  globalThis.dispatchEvent(new CustomEvent("local-system-thread-changed", {
    detail: { previousThreadId, threadId: nextThreadId },
  }));
  if (pendingBrowserBindingToken) scheduleBrowserBindingTokenRetry(0);
}

function flushInlineFileScans() {
  inlineFileScanTimer = 0;
  const roots = [...pendingInlineFileScanRoots];
  pendingInlineFileScanRoots.clear();
  for (const root of roots) {
    if (root?.isConnected) scan(root);
  }
}

function conversationContentRootFor(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  if (!element?.closest) return null;
  if (element.closest(
    "#prompt-textarea, form, [data-local-system-composer-ui], .local-system-composer-rail, .local-system-inline-image, .local-system-inline-file-path",
  )) return null;

  const selectedMarkdown = element.closest(".markdown");
  if (selectedMarkdown?.closest("main")) return selectedMarkdown;

  const roleNode = element.closest(MESSAGE_ROLE_SELECTOR);
  if (roleNode && isConversationMessageContent(roleNode)) {
    return roleNode.querySelector(".markdown") || roleNode;
  }

  const turn = element.closest(MESSAGE_TURN_SELECTOR);
  if (turn?.closest("main")) {
    return turn.querySelector(".markdown") || turn.querySelector(MESSAGE_ROLE_SELECTOR) || turn;
  }

  const surface = element.closest(CONVERSATION_SURFACE_SELECTOR);
  if (!surface?.closest("main")) return null;
  // The composer is a sibling inside this region, not a conversation message.
  // Do not enhance paths in the composer, menus, or the extension's own UI.
  if (element.closest('[data-thread-scroll-footer], [contenteditable="true"], [data-local-system-ui-pref-hidden], [data-local-system-file-workspace-host], button, [role="button"], [role="menu"], [role="dialog"]')) return null;
  return element.closest("p, li, pre, blockquote") || element;
}

function isConversationMessageContent(element) {
  if (!element?.closest?.("main")) return false;
  if (element.closest("#prompt-textarea, form, [data-local-system-composer-ui], .local-system-composer-rail")) return false;
  return Boolean(
    element.matches?.(".markdown")
    || element.closest(MESSAGE_ROLE_SELECTOR)
    || element.closest(MESSAGE_TURN_SELECTOR)
  );
}

function scanTextNode(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(".local-system-inline-image, .local-system-inline-file-path")) return;
  if (parent.closest("script,style,textarea,input,a[href]")) return;

  if (parent.tagName === "DIV" && (parent.textContent || "").trim() === CHATGPT_DISCLAIMER_TEXT) {
    parent.style.setProperty("display", "none", "important");
    parent.dataset.localSystemHidden = "chatgpt-disclaimer";
    return;
  }

  if (!conversationContentRootFor(node)) return;

  const text = node.nodeValue || "";
  const references = [...text.matchAll(FILE_PATH_RE)]
    .map((match) => {
      const displayPath = cleanPath(match[0]);
      if (!displayPath) return null;
      return {
        displayPath,
        path: contextualFilePath(node, displayPath),
        start: Number(match.index) || 0,
        end: (Number(match.index) || 0) + displayPath.length,
      };
    })
    .filter(Boolean);
  if (!references.length) return;

  const previous = seen.get(parent) || new Set();
  seen.set(parent, previous);
  for (const reference of references) {
    const previewKind = previewKindForPath(reference.path);
    if (!previewKind || previous.has(reference.path)) continue;
    previous.add(reference.path);
    addPreview(parent, reference.path, previewKind);
  }
  wrapLocalFilePaths(node, references);
}

function localFilePathFromAnchor(anchor) {
  const rawHref = anchor?.getAttribute?.("href");
  // Only explicit filesystem paths qualify. Ordinary web links and relative
  // website routes must continue to use ChatGPT's native navigation.
  if (!rawHref || !isAbsoluteLocalFilePath(rawHref) || rawHref.startsWith("//")) return "";
  let path;
  try {
    path = decodeURIComponent(rawHref);
  } catch {
    return "";
  }
  const match = [...path.matchAll(FILE_PATH_RE)][0];
  return match?.index === 0 && match[0] === path ? path : "";
}

function enhanceLocalFileAnchors(root) {
  const element = root?.nodeType === Node.ELEMENT_NODE ? root : root?.parentElement;
  if (!element) return;
  const anchors = [
    ...(element.matches?.("a[href]") ? [element] : []),
    ...(element.querySelectorAll?.("a[href]") || []),
  ];
  for (const anchor of anchors) {
    if (anchor.dataset.localSystemFileAnchor || !conversationContentRootFor(anchor)) continue;
    const path = localFilePathFromAnchor(anchor);
    if (!path) continue;
    anchor.dataset.localSystemFileAnchor = "true";
    anchor.dataset.localPath = path;
    anchor.dataset.originalText = anchor.textContent || path;
    anchor.classList.add("local-system-inline-file-path");
    const baseTitle = `Open ${path} in Local System workspace`;
    anchor.dataset.baseTitle = baseTitle;
    anchor.title = baseTitle;
    anchor.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      void traceWorkspace("content.inline-file.anchor-click", { path });
      const nativePanelRequest = requestNativeSidePanel();
      const descriptor = anchor.dataset.resolveState === "ready" && anchor.dataset.resolvedPath
        ? { path: anchor.dataset.resolvedPath }
        : await primeInlineFileLink(anchor, path, { retry: true });
      if (!descriptor?.path) return;
      await switchWorkspaceForResolvedFile(descriptor.path);
      void openFileFromChatGpt(descriptor.path, null, null, null, { nativePanelRequest, source: "inline-file" });
    }, true);
    scheduleInlineFileLinkResolution(anchor, path);
  }
}

function contextualFilePath(node, filePath) {
  const clean = String(filePath || "").trim();
  if (!clean || /[\\/]/.test(clean)) return clean;

  const parent = node?.parentElement;
  const messageRoot = parent?.closest?.('[data-message-author-role="assistant"], [data-testid^="conversation-turn"], article');
  if (!messageRoot) return clean;

  const walker = document.createTreeWalker(messageRoot, NodeFilter.SHOW_TEXT);
  let cursor;
  let preceding = "";
  while ((cursor = walker.nextNode())) {
    if (cursor === node) break;
    const owner = cursor.parentElement;
    if (!owner || owner.closest(".local-system-inline-image, .local-system-inline-file-path, script, style, textarea, input")) continue;
    preceding += cursor.nodeValue || "";
    if (preceding.length > 6_000) preceding = preceding.slice(-6_000);
  }

  const directories = [...preceding.matchAll(DIRECTORY_PATH_RE)]
    .map((match) => cleanDirectoryPath(match[0]))
    .filter(Boolean);
  const directory = directories.at(-1);
  if (!directory) return clean;

  const separator = directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return `${directory}${directory.endsWith("/") || directory.endsWith("\\") ? "" : separator}${clean}`;
}

function previewKindForPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  if (/\.(?:png|jpe?g|gif|webp|avif|svg)$/.test(lower)) return "image";
  if (/\.(?:mp4|mov|webm)$/.test(lower)) return "video";
  if (/\.pdf$/.test(lower)) return "pdf";
  return "";
}

function wrapLocalFilePaths(node, references) {
  if (!node?.parentNode || !references.length) return;
  const original = node.nodeValue || "";
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const reference of references) {
    if (reference.start < cursor || reference.end > original.length) continue;
    if (reference.start > cursor) fragment.append(document.createTextNode(original.slice(cursor, reference.start)));
    const link = document.createElement("span");
    link.className = "local-system-inline-file-path";
    link.setAttribute("role", "button");
    link.setAttribute("tabindex", "0");
    link.dataset.localPath = reference.path;
    link.dataset.originalText = original.slice(reference.start, reference.end);
    link.textContent = link.dataset.originalText;
    const baseTitle = `Open ${reference.displayPath} in Local System workspace`;
    link.dataset.baseTitle = baseTitle;
    link.title = baseTitle;
    link.setAttribute("aria-label", `Open ${reference.displayPath} in Local System workspace`);
    const previewError = inlineFilePreviewErrors.get(reference.path);
    if (previewError) applyInlineFilePathError(link, previewError);
    const open = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      void traceWorkspace("content.inline-file.click", { path: reference.path });
      const nativePanelRequest = requestNativeSidePanel();
      const descriptor = link.dataset.resolveState === "ready" && link.dataset.resolvedPath
        ? { path: link.dataset.resolvedPath }
        : await primeInlineFileLink(link, reference.path, { retry: true });
      if (!descriptor?.path) return;
      await switchWorkspaceForResolvedFile(descriptor.path);
      void openFileFromChatGpt(descriptor.path, null, null, null, { nativePanelRequest, source: "inline-file" });
    };
    link.addEventListener("click", open);
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    });
    fragment.append(link);
    scheduleInlineFileLinkResolution(link, reference.path);
    cursor = reference.end;
  }
  if (cursor < original.length) fragment.append(document.createTextNode(original.slice(cursor)));
  node.replaceWith(fragment);
}

function scheduleInlineFileLinkResolution(link, path, { retry = false } = {}) {
  if (!link?.isConnected && !link?.parentNode) return;
  link.dataset.resolveState = "deferred";
  if (retry) link.dataset.resolveRetry = "true";
  else delete link.dataset.resolveRetry;
  if (inlineFileLinkVisibilityObserver) {
    inlineFileLinkVisibilityObserver.observe(link);
    return;
  }
  void primeInlineFileLink(link, path, { retry });
}

async function primeInlineFileLink(link, path, { retry = false } = {}) {
  inlineFileLinkVisibilityObserver?.unobserve(link);
  delete link.dataset.resolveRetry;
  link.dataset.resolveState = "loading";
  try {
    const descriptor = await resolveInlineFileReference(path, { retry });
    if (descriptor?.path) {
      link.dataset.resolvedPath = descriptor.path;
      link.dataset.resolveState = "ready";
      // Preserve the caption and nested elements of genuine response links.
      if (link.tagName !== "A") link.textContent = localFileName(descriptor.path) || localFileName(path) || link.dataset.originalText || path;
      clearInlineFilePathError(path);
    }
    return descriptor;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    link.dataset.resolveState = "error";
    if (link.tagName !== "A") link.textContent = link.dataset.originalText || path;
    markInlineFilePathError(path, [
      "Local file could not be resolved",
      path ? `Path: ${path}` : "",
      message ? `Reason: ${message}` : "",
    ].filter(Boolean).join("\n"));
    return null;
  }
}

function localFileName(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || String(value || "");
}

async function resolveInlineFileReference(path, { retry = false } = {}) {
  const threadId = currentThreadId();
  if (!threadId) throw new Error("ChatGPT thread id is unavailable");
  const normalizedPath = String(path || "").trim();
  if (!normalizedPath) throw new Error("file path is empty");
  const key = `${threadId}\u0000${normalizedPath}`;
  if (!retry && inlineFileResolutionCache.has(key)) return inlineFileResolutionCache.get(key);

  const promise = resolveInlineFileReferenceUncached(threadId, normalizedPath);
  inlineFileResolutionCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    if (inlineFileResolutionCache.get(key) === promise) inlineFileResolutionCache.delete(key);
    throw error;
  }
}

async function resolveInlineFileReferenceUncached(threadId, filePath) {
  const descriptor = await localSystemApiRequest("/local-ui/files/resolve", {
    threadId,
    path: filePath,
    active: false,
  });
  if (!descriptor?.path) throw new Error("local file could not be resolved");
  return descriptor;
}

async function localSystemApiRequest(path, body) {
  const api = globalThis.LocalSystemExtensionApi;
  if (!api?.request) throw new Error("Local System extension API unavailable");
  return api.request(path, body, { timeoutMs: 8_000 });
}

function isAbsoluteLocalFilePath(value) {
  const input = String(value || "");
  return input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input);
}

async function switchWorkspaceForResolvedFile(filePath) {
  const threadId = currentThreadId();
  if (!threadId || !isAbsoluteLocalFilePath(filePath)) return;
  try {
    const context = await localSystemApiRequest("/local-ui/file-workspace", {
      threadId,
      action: "projects",
      active: false,
    });
    const normalizedFile = String(filePath).replaceAll("\\", "/");
    const projects = (Array.isArray(context?.projects) ? context.projects : [])
      .filter((project) => {
        const root = String(project?.path || "").replaceAll("\\", "/").replace(/\/+$/, "");
        return root && (normalizedFile === root || normalizedFile.startsWith(`${root}/`));
      })
      .sort((a, b) => String(b.path || "").length - String(a.path || "").length);
    const project = projects[0];
    if (!project?.path || project.path === context.currentWorkspace) return;
    const opened = await localSystemApiRequest("/local-ui/file-workspace", {
      threadId,
      action: "select_project",
      path: project.path,
      active: true,
    });
    globalThis.dispatchEvent(new CustomEvent("local-system-project-changed", {
      detail: {
        previousWorkspace: context.currentWorkspace || "",
        currentWorkspace: opened.currentWorkspace || project.path,
        bound: opened.bound === true,
        source: "inline-file-open",
      },
    }));
  } catch {
    // Opening the absolute file can still succeed even if project sync fails.
  }
}

function refreshInlineFileLinks() {
  for (const link of document.querySelectorAll(".local-system-inline-file-path")) {
    const path = link.dataset.localPath;
    if (!path) continue;
    delete link.dataset.resolvedPath;
    scheduleInlineFileLinkResolution(link, path, { retry: true });
  }
}

function cleanDirectoryPath(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned || cleaned.includes("...") || cleaned.includes("…")) return "";
  if (cleaned.startsWith("//") || /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) return "";
  return cleaned;
}

async function addPreview(anchor, path, previewKind) {
  const card = document.createElement("figure");
  card.className = "local-system-inline-image";
  card.dataset.localPath = path;
  card.dataset.previewKind = previewKind;
  card.classList.add(`local-system-inline-image--${previewKind}`);
  card.innerHTML = `<div class="local-system-inline-image__status">Loading local ${previewKind} preview…</div>`;
  const insertionPoint = anchor.closest("pre,p,li,div") || anchor;
  let row = previewRows.get(insertionPoint);
  if (!row?.isConnected) {
    row = document.createElement("div");
    row.className = "local-system-inline-image-row";
    insertionPoint.insertAdjacentElement("beforebegin", row);
    previewRows.set(insertionPoint, row);
  }
  row.appendChild(card);

  const id = crypto.randomUUID();
  const frame = document.createElement("iframe");
  frame.className = "local-system-inline-image__frame";
  frame.title = path.split(/[\\/]/).pop() || "Local file preview";
  const viewerUrl = extensionUrl("viewer.html");
  if (!viewerUrl) {
    card.remove();
    return;
  }
  frame.src = `${viewerUrl}?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}&threadId=${encodeURIComponent(currentThreadId())}&preview=${encodeURIComponent(previewKind)}`;
  frames.set(id, frame);
  card.replaceChildren(frame);
}

function renderInlineFileResolutionError(card, { path, message }) {
  const detail = [
    "Local file preview could not be resolved",
    path ? `Path: ${path}` : "",
    message ? `Reason: ${message}` : "",
  ].filter(Boolean).join("\n");
  markInlineFilePathError(path, detail);
  card.remove();
}

function markInlineFilePathError(path, detail) {
  const normalized = String(path || "");
  if (!normalized) return;
  const message = detail || "Local file preview could not be resolved";
  inlineFilePreviewErrors.set(normalized, message);
  for (const link of document.querySelectorAll(".local-system-inline-file-path")) {
    if (link.dataset.localPath !== normalized) continue;
    applyInlineFilePathError(link, message);
  }
}

function applyInlineFilePathError(link, message) {
  link.dataset.previewError = "true";
  link.dataset.previewErrorMessage = message;
  const baseTitle = link.dataset.baseTitle || link.title || "Open file in Local System workspace";
  link.title = `${baseTitle}\n${message}`;
}

function clearInlineFilePathError(path) {
  const normalized = String(path || "");
  if (!normalized) return;
  inlineFilePreviewErrors.delete(normalized);
  for (const link of document.querySelectorAll(".local-system-inline-file-path")) {
    if (link.dataset.localPath !== normalized) continue;
    delete link.dataset.previewError;
    delete link.dataset.previewErrorMessage;
    if (link.dataset.baseTitle) link.title = link.dataset.baseTitle;
  }
}

function cleanPath(value) {
  const cleaned = String(value || "").replace(/[),.;:!?]+$/, "").trim();
  if (cleaned.includes("...") || cleaned.includes("…")) return "";
  if (cleaned.startsWith("//") || /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) return "";
  return cleaned;
}

function handleTodosMessage(event) {
  if (!todosWidget || event.source !== todosWidget.frame.contentWindow) return;
  if (event.data.action === "bound") {
    if (event.data.bound === true) pendingLocalSystemBind = null;
    return;
  }
  if (event.data.action === "visibility") {
    todosWidget.host.hidden = event.data.visible !== true;
    if (todosWidget.host.hidden && todosWidget.expanded) setTodosExpanded(false);
    scheduleUiVisibilityReconcile();
    return;
  }
  if (event.data.action === "toggle") {
    setTodosExpanded(!todosWidget.expanded);
    return;
  }
  if (event.data.action === "resize") {
    const height = Math.max(40, Math.min(320, Number(event.data.height) || 40));
    todosWidget.frame.style.height = `${height}px`;
  }
}

function ensureTodosWidget() {
  const threadId = currentThreadId();
  const composer = findComposer();
  if (!threadId || !composer) {
    removeTodosWidget();
    return;
  }

  if (todosWidget?.threadId === threadId && todosWidget.host.isConnected) {
    const rail = ensureComposerRail(composer);
    if (todosWidget.host.parentElement !== rail) rail.appendChild(todosWidget.host);
    sendTodosHostState();
    return;
  }

  removeTodosWidget();
  const rail = ensureComposerRail(composer);
  const host = document.createElement("div");
  host.className = "local-system-todos-host";
  host.hidden = true;
  const frame = document.createElement("iframe");
  frame.className = "local-system-todos-frame";
  frame.title = "Local System todos";
  const todosUrl = extensionUrl("todos.html");
  if (!todosUrl) return;
  frame.src = `${todosUrl}?threadId=${encodeURIComponent(threadId)}`;
  host.appendChild(frame);
  rail.appendChild(host);
  todosWidget = { threadId, host, frame, expanded: false, ready: false };
  frame.addEventListener("load", () => {
    if (!todosWidget || todosWidget.frame !== frame) return;
    todosWidget.ready = true;
    sendTodosHostState();
  }, { once: true });
}

function replaceComposerDraft(text) {
  const editor = findComposerEditor();
  if (!editor) return false;
  editor.focus();
  const selection = globalThis.getSelection?.();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  const inserted = document.execCommand("insertText", false, String(text || ""));
  if (!inserted) return false;
  const end = document.createRange();
  end.selectNodeContents(editor);
  end.collapse(false);
  selection.removeAllRanges();
  selection.addRange(end);
  return true;
}

function ensureContinuationContextButton() {
  const threadId = currentThreadId();
  const mount = globalThis.LocalSystemSharedRuntime?.ensureComposerRailActionsHost?.();
  const host = mount?.host;
  if (!threadId || !host) {
    removeContinuationContextButton();
    return;
  }

  if (continuationContextButton?.threadId === threadId && continuationContextButton.button.isConnected) {
    const { button } = continuationContextButton;
    button.className = "composer-icon-button local-system-rail-action local-system-continuation-context-button";
    button.disabled = false;
    button.removeAttribute("disabled");
    button.removeAttribute("aria-disabled");
    button.removeAttribute("inert");
    button.tabIndex = 0;
    button.style.order = "10";
    if (button.parentElement !== host) host.appendChild(button);
    return;
  }

  removeContinuationContextButton();

  const button = globalThis.LocalSystemSharedRuntime?.ComposerIconButton?.({
    className: "local-system-continuation-context-button",
    label: "Prepare continuation context",
    order: 10,
    dataset: { localSystemContinuationContext: "true" },
    icon: `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" class="icon">
        <path d="M5 6h6v5H5zM13 13h6v5h-6zM11 8.5h2a3 3 0 0 1 3 3V13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `,
  });
  if (!button) return;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    replaceComposerDraft(CONTINUATION_CONTEXT_PROMPT);
  });

  host.appendChild(button);
  continuationContextButton = { threadId, button };
}

function removeContinuationContextButton() {
  continuationContextButton?.button?.remove();
  continuationContextButton = null;
}

function ensureThreadNotesWidget() {
  const threadId = currentThreadId();
  const mount = globalThis.LocalSystemSharedRuntime?.ensureComposerRailActionsHost?.();
  const host = mount?.host;
  if (!threadId || !host) {
    removeThreadNotesWidget();
    return;
  }

  if (threadNotesWidget?.threadId === threadId && threadNotesWidget.button.isConnected) {
    const { button } = threadNotesWidget;
    button.className = "composer-icon-button local-system-rail-action local-system-thread-notes-button";
    button.disabled = false;
    button.removeAttribute("disabled");
    button.removeAttribute("aria-disabled");
    button.removeAttribute("inert");
    button.tabIndex = 0;
    button.style.order = "30";
    if (button.parentElement !== host) host.appendChild(button);
    if (!threadNotesWidget.popover.hidden) positionThreadNotesPopover();
    return;
  }

  removeThreadNotesWidget();

  const button = globalThis.LocalSystemSharedRuntime?.ComposerIconButton?.({
    className: "local-system-thread-notes-button",
    label: "Thread notes",
    order: 30,
    dataset: { localSystemThreadNotes: "true" },
    icon: `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" class="icon">
        <path d="M7 4.5h10v15l-5-3-5 3zM9.5 9h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `,
  });
  if (!button) return;
  button.setAttribute("aria-expanded", "false");

  const popover = document.createElement("section");
  popover.className = "local-system-thread-notes-popover ls-ui-floating-surface";
  popover.hidden = true;
  popover.dataset.localSystemThreadNotes = "true";
  popover.setAttribute("aria-label", "Thread notes editor");

  const textarea = document.createElement("textarea");
  textarea.className = "local-system-thread-notes-popover__textarea";
  textarea.placeholder = "Add a note…";
  textarea.spellcheck = true;

  const preview = document.createElement("div");
  preview.className = "local-system-thread-notes-popover__preview";
  preview.hidden = true;
  preview.tabIndex = 0;
  preview.setAttribute("role", "button");
  preview.setAttribute("aria-label", "Edit thread note");

  const status = document.createElement("span");
  status.className = "local-system-thread-notes-popover__status";
  status.setAttribute("aria-live", "polite");
  const saveButton = document.createElement("button");
  saveButton.className = "local-system-thread-notes-popover__save";
  saveButton.type = "button";
  saveButton.setAttribute("aria-label", "Save thread notes");
  saveButton.title = "Save notes";
  saveButton.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="m6.75 12.25 3.1 3.1 7.4-7.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
  popover.append(textarea, preview, status, saveButton);

  host.appendChild(button);
  document.body.appendChild(popover);
  threadNotesWidget = {
    threadId,
    button,
    popover,
    textarea,
    preview,
    status,
    saveButton,
    saved: "",
    dirty: false,
    loaded: false,
    loading: false,
    loadPromise: null,
    editing: true,
  };

  button.addEventListener("pointerenter", () => {
    const widget = threadNotesWidget;
    if (!widget || widget.button !== button) return;
    void ensureThreadNotesLoaded(widget);
  }, { once: true });
  button.addEventListener("click", () => {
    const widget = threadNotesWidget;
    if (!widget || widget.button !== button) return;
    const open = widget.popover.hidden;
    widget.popover.hidden = !open;
    widget.button.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) {
      returnThreadNotesToPreviewIfClean(widget);
      return;
    }
    if (open) {
      positionThreadNotesPopover();
      void ensureThreadNotesLoaded(widget).finally(() => {
        if (threadNotesWidget !== widget || widget.popover.hidden) return;
        if (widget.editing) {
          resizeThreadNotesTextarea(widget);
          widget.textarea.focus();
        }
      });
    }
  });
  textarea.addEventListener("input", () => {
    const widget = threadNotesWidget;
    if (!widget || widget.textarea !== textarea) return;
    widget.dirty = widget.textarea.value !== widget.saved;
    resizeThreadNotesTextarea(widget);
    updateThreadNotesUi(widget);
  });
  preview.addEventListener("click", () => enterThreadNotesEditMode(threadNotesWidget));
  preview.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    enterThreadNotesEditMode(threadNotesWidget);
  });
  saveButton.addEventListener("click", saveThreadNotes);
  updateThreadNotesUi(threadNotesWidget);
}

function removeThreadNotesWidget() {
  if (!threadNotesWidget) return;
  threadNotesWidget.button.remove();
  threadNotesWidget.popover.remove();
  threadNotesWidget = null;
}

function ensureThreadNotesLoaded(widget) {
  if (!widget || threadNotesWidget !== widget) return Promise.resolve();
  if (widget.loaded) return Promise.resolve();
  if (widget.loadPromise) return widget.loadPromise;

  widget.loading = true;
  updateThreadNotesUi(widget);
  widget.loadPromise = (async () => {
    try {
      if (!chrome.storage?.local) throw new Error("Chrome storage permission is unavailable");
      const key = threadNotesStorageKey(widget.threadId);
      const values = await chrome.storage.local.get(key);
      if (threadNotesWidget !== widget) return;
      const stored = values?.[key];
      const markdown = typeof stored?.markdown === "string" ? stored.markdown : "";
      widget.saved = markdown;
      widget.textarea.value = markdown;
      widget.dirty = false;
      widget.loaded = true;
      widget.loading = false;
      widget.editing = !markdown.trim();
      renderThreadNotesMarkdown(widget);
      resizeThreadNotesTextarea(widget);
      updateThreadNotesUi(widget);
    } catch (error) {
      if (threadNotesWidget !== widget) return;
      widget.loading = false;
      widget.status.textContent = error instanceof Error ? error.message : "Could not load notes";
      widget.status.dataset.error = "true";
      widget.saveButton.disabled = true;
      widget.textarea.disabled = true;
    } finally {
      if (threadNotesWidget === widget) widget.loadPromise = null;
    }
  })();
  return widget.loadPromise;
}

async function saveThreadNotes() {
  const widget = threadNotesWidget;
  if (!widget || !widget.loaded || widget.loading || widget.saveButton.disabled || !widget.dirty) return;
  const markdown = widget.textarea.value;
  widget.saveButton.disabled = true;
  widget.status.textContent = "Saving…";
  delete widget.status.dataset.error;
  try {
    const key = threadNotesStorageKey(widget.threadId);
    if (markdown) {
      await chrome.storage.local.set({
        [key]: { markdown, updatedAt: new Date().toISOString() },
      });
    } else {
      await chrome.storage.local.remove(key);
    }
    if (threadNotesWidget !== widget) return;
    widget.saved = markdown;
    widget.dirty = false;
    widget.editing = !markdown.trim();
    renderThreadNotesMarkdown(widget);
    updateThreadNotesUi(widget);
  } catch (error) {
    if (threadNotesWidget !== widget) return;
    widget.status.textContent = error instanceof Error ? error.message : "Could not save notes";
    widget.status.dataset.error = "true";
    widget.saveButton.disabled = false;
  }
}

function updateThreadNotesUi(widget) {
  widget.button.dataset.hasNote = widget.loaded && widget.saved.trim() ? "true" : "false";
  const canEdit = widget.loaded && !widget.loading && widget.editing;
  widget.popover.dataset.editing = canEdit ? "true" : "false";
  widget.textarea.hidden = !canEdit;
  widget.preview.hidden = !widget.loaded || widget.loading || widget.editing || !widget.saved.trim();
  widget.textarea.disabled = !canEdit;
  widget.saveButton.hidden = !canEdit;
  widget.saveButton.disabled = !canEdit || !widget.dirty;
  if (widget.loading) {
    widget.status.textContent = "Loading…";
  } else if (!widget.loaded) {
    widget.status.textContent = "Load on hover or click";
  } else if (widget.dirty) {
    widget.status.textContent = "Unsaved";
  } else {
    widget.status.textContent = "Saved locally for this thread";
  }
  delete widget.status.dataset.error;
}

function enterThreadNotesEditMode(widget) {
  if (!widget || threadNotesWidget !== widget || !widget.loaded || widget.loading) return;
  widget.editing = true;
  updateThreadNotesUi(widget);
  resizeThreadNotesTextarea(widget);
  widget.textarea.focus();
  widget.textarea.setSelectionRange(widget.textarea.value.length, widget.textarea.value.length);
}

function returnThreadNotesToPreviewIfClean(widget) {
  if (!widget || threadNotesWidget !== widget || widget.dirty || !widget.saved.trim()) return;
  widget.textarea.value = widget.saved;
  widget.editing = false;
  renderThreadNotesMarkdown(widget);
  updateThreadNotesUi(widget);
}

function resizeThreadNotesTextarea(widget) {
  if (!widget?.textarea || widget.textarea.hidden) return;
  const textarea = widget.textarea;
  const minHeight = 150;
  const maxHeight = Math.max(minHeight, Math.min(420, Math.floor(globalThis.innerHeight * 0.52)));
  textarea.style.height = "auto";
  const nextHeight = Math.min(maxHeight, Math.max(minHeight, textarea.scrollHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function renderThreadNotesMarkdown(widget) {
  if (!widget?.preview) return;
  widget.preview.innerHTML = renderLocalThreadMarkdown(widget.saved);
}

function renderLocalThreadMarkdown(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let listType = null;
  let inFence = false;
  let fenceLines = [];

  const closeList = () => {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = null;
  };
  const closeFence = () => {
    out.push(`<pre><code>${escapeThreadNotesHtml(fenceLines.join("\n"))}</code></pre>`);
    fenceLines = [];
    inFence = false;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList();
      if (inFence) closeFence();
      else inFence = true;
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        out.push(`<${listType}>`);
      }
      out.push(`<li>${renderThreadNotesInline((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();

    if (!line.trim()) {
      out.push('<div class="local-system-thread-notes-md-gap"></div>');
      continue;
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      out.push("<hr>");
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderThreadNotesInline(heading[2])}</h${level}>`);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(`<blockquote>${renderThreadNotesInline(quote[1])}</blockquote>`);
      continue;
    }
    out.push(`<p>${renderThreadNotesInline(line)}</p>`);
  }
  closeList();
  if (inFence) closeFence();
  return out.join("\n");
}

function renderThreadNotesInline(value) {
  let text = escapeThreadNotesHtml(value);
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  text = text.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  return text;
}

function escapeThreadNotesHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function positionThreadNotesPopover() {
  const widget = threadNotesWidget;
  if (!widget || widget.popover.hidden || !widget.button.isConnected) return;
  const rect = widget.button.getBoundingClientRect();
  const width = widget.popover.offsetWidth || Math.min(430, Math.max(0, globalThis.innerWidth - 24));
  const left = Math.max(12, Math.min(globalThis.innerWidth - width - 12, rect.right + 8));
  widget.popover.style.top = "auto";
  widget.popover.style.bottom = `${Math.max(8, Math.round(globalThis.innerHeight - rect.bottom))}px`;
  widget.popover.style.left = `${Math.round(left)}px`;
  widget.popover.style.right = "auto";
}

function handleThreadNotesOutsidePointerDown(event) {
  const widget = threadNotesWidget;
  if (!widget || widget.popover.hidden) return;
  if (widget.button.contains(event.target) || widget.popover.contains(event.target)) return;
  if (widget.dirty) return;
  returnThreadNotesToPreviewIfClean(widget);
  widget.popover.hidden = true;
  widget.button.setAttribute("aria-expanded", "false");
}

function handleThreadNotesKeydown(event) {
  const widget = threadNotesWidget;
  if (!widget || widget.popover.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (widget.dirty) {
      widget.textarea.value = widget.saved;
      widget.dirty = false;
    }
    returnThreadNotesToPreviewIfClean(widget);
    updateThreadNotesUi(widget);
    widget.popover.hidden = true;
    widget.button.setAttribute("aria-expanded", "false");
    widget.button.focus();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && widget.textarea === event.target) {
    event.preventDefault();
    event.stopPropagation();
    if (widget.dirty) void saveThreadNotes();
    else returnThreadNotesToPreviewIfClean(widget);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && widget.popover.contains(event.target)) {
    event.preventDefault();
    saveThreadNotes();
  }
}

function threadNotesStorageKey(threadId) {
  return `local-system-thread-note:${threadId}`;
}

function handleFileWorkspaceShortcut(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  const mode = key === "p" && !event.shiftKey
    ? "files"
    : (key === "f" && event.shiftKey ? "search" : "");
  if (!mode) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (mode === "search") openFileWorkspaceMode("search");
  else openFileQuickOpen("files");
}

function handleNativeSidebarShortcut(event) {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "l") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    chrome.runtime.sendMessage({
      source: "local-system-content",
      action: "open-side-panel",
    }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.ok && response.payload?.unsupported === true) {
        globalThis.dispatchEvent(new CustomEvent("local-system-standalone-workspace-toggle-request"));
      }
    });
  } catch {
    // The manifest command remains the primary path; this is a page-level fallback.
  }
}

function handleSidebarShortcuts(event) {
  if (!event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.key.toLowerCase() !== "b") return;

  event.preventDefault();
  event.stopImmediatePropagation();
  toggleChatGPTLeftSidebar();
}

function toggleChatGPTLeftSidebar() {
  const isVisible = (button) => {
    if (!button || button.hidden || button.getAttribute("aria-hidden") === "true") return false;
    if (typeof button.checkVisibility === "function" && !button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const style = getComputedStyle(button);
    return style.display !== "none" && style.visibility !== "hidden" && button.getClientRects().length > 0;
  };
  // ChatGPT currently keeps both controls mounted while the sidebar is open.
  // Query them independently so DOM order cannot make us click "Open sidebar"
  // repeatedly when the close control is available.
  const closeButton = [...document.querySelectorAll(
    'button[data-testid="close-sidebar-button"], button[aria-label="Close sidebar"]',
  )].find(isVisible);
  if (closeButton) {
    closeButton.click();
    return;
  }
  const openButton = [...document.querySelectorAll('button[aria-label="Open sidebar"]')].find(isVisible);
  openButton?.click();
}

function toggleFileWorkspace() {
  ensureFileWorkspaceWidget();
  if (!fileWorkspaceWidget?.ready || !fileWorkspaceWidget.frame?.contentWindow) {
    if (fileWorkspaceWidget) fileWorkspaceWidget.pendingToggle = true;
    return;
  }
  fileWorkspaceWidget.pendingToggle = false;
  const hiddenOnlyByPreference = fileWorkspaceWidget.visible === true
    && uiVisibility.workspace === false
    && fileWorkspaceWidget.forceVisibility !== true;
  if (hiddenOnlyByPreference) {
    forceEmbeddedWorkspaceVisible();
    applyFileWorkspaceVisibility();
    return;
  }
  const opening = fileWorkspaceWidget.visible !== true;
  if (opening) forceEmbeddedWorkspaceVisible();
  else {
    fileWorkspaceWidget.forceVisibility = false;
    fileWorkspaceWidget.host.removeAttribute("data-local-system-force-visible");
  }
  fileWorkspaceWidget.frame.contentWindow.postMessage({
    source: "local-system-host",
    action: "toggle-sidebar",
    active: document.visibilityState === "visible" && document.hasFocus(),
    theme: composerPaletteTheme(),
  }, viewerOrigin);
}

function openFileWorkspaceMode(mode) {
  const normalizedMode = new Set(["files", "git", "search"]).has(mode) ? mode : "files";
  ensureFileWorkspaceWidget();
  if (!fileWorkspaceWidget?.ready || !fileWorkspaceWidget.frame?.contentWindow) {
    if (fileWorkspaceWidget) fileWorkspaceWidget.pendingMode = normalizedMode;
    return;
  }
  fileWorkspaceWidget.pendingMode = "";
  forceEmbeddedWorkspaceVisible();
  fileWorkspaceWidget.frame.contentWindow.postMessage({
    source: "local-system-host",
    action: "open-mode",
    mode: normalizedMode,
    active: document.visibilityState === "visible" && document.hasFocus(),
    theme: composerPaletteTheme(),
  }, viewerOrigin);
}

function openFileQuickOpen(mode = "files", query = "", target = "embedded") {
  const threadId = currentThreadId();
  if (!threadId) return;
  closeFileQuickOpen();
  const host = document.createElement("div");
  host.className = "local-system-file-quick-open-host";
  const frame = document.createElement("iframe");
  frame.className = "local-system-file-quick-open-frame";
  frame.title = "Quick open Local System file";
  const quickOpenUrl = extensionUrl("file-quick-open.html");
  if (!quickOpenUrl) return;
  frame.src = `${quickOpenUrl}?threadId=${encodeURIComponent(threadId)}&mode=${mode === "text" ? "text" : "files"}&query=${encodeURIComponent(String(query || "").slice(0, 300))}`;
  host.appendChild(frame);
  document.documentElement.appendChild(host);
  fileQuickOpen = {
    host,
    frame,
    ready: false,
    target: target === "standalone" ? "standalone" : "embedded",
  };
  frame.addEventListener("load", () => {
    if (!fileQuickOpen || fileQuickOpen.frame !== frame) return;
    fileQuickOpen.ready = true;
    sendFileQuickOpenHostState();
  }, { once: true });
}

function closeFileQuickOpen({ restoreFocus = false } = {}) {
  const target = fileQuickOpen?.target || "";
  fileQuickOpen?.host?.remove();
  fileQuickOpen = null;
  if (restoreFocus) requestAnimationFrame(() => restoreFileWorkspaceFocus(target));
}

function restoreFileWorkspaceFocus(target = "embedded") {
  if (target === "standalone") {
    globalThis.dispatchEvent(new CustomEvent("local-system-standalone-restore-focus"));
    return;
  }
  const frame = fileWorkspaceWidget?.frame;
  if (!frame?.contentWindow) return;
  frame.focus({ preventScroll: true });
  frame.contentWindow.postMessage({
    source: "local-system-host",
    action: "restore-focus",
    active: document.visibilityState === "visible" && document.hasFocus(),
    theme: composerPaletteTheme(),
  }, viewerOrigin);
}

function handleFileQuickOpenOutsidePointerDown() {
  // Pointer events originating inside the quick-open iframe do not bubble into
  // this document, so any pointerdown seen here while it is open is outside it.
  if (fileQuickOpen) closeFileQuickOpen({ restoreFocus: true });
}

function handleFileQuickOpenMessage(event) {
  if (!fileQuickOpen || event.source !== fileQuickOpen.frame.contentWindow) return;
  if (event.data.action === "ready") {
    fileQuickOpen.ready = true;
    sendFileQuickOpenHostState();
    return;
  }
  if (event.data.action === "resize") {
    const height = Math.max(110, Math.min(560, Number(event.data.height) || 180));
    fileQuickOpen.frame.style.height = `${height}px`;
    return;
  }
  if (event.data.action === "close") {
    closeFileQuickOpen({ restoreFocus: true });
    return;
  }
  if (event.data.action === "open-file" && typeof event.data.path === "string") {
    if (fileQuickOpen.target === "standalone") {
      globalThis.dispatchEvent(new CustomEvent("local-system-standalone-open-file", {
        detail: {
          path: event.data.path,
          line: event.data.line,
          column: event.data.column,
          length: event.data.length,
          restoreFocus: true,
        },
      }));
    } else {
      openFileInWorkspace(
        event.data.path,
        event.data.line,
        event.data.column,
        event.data.length,
        { restoreFocus: true },
      );
    }
    closeFileQuickOpen({ restoreFocus: true });
  }
}

function sendFileQuickOpenHostState() {
  if (!fileQuickOpen?.ready || !fileQuickOpen.frame?.contentWindow) return;
  fileQuickOpen.frame.contentWindow.postMessage({
    source: "local-system-host",
    active: document.visibilityState === "visible" && document.hasFocus(),
    theme: composerPaletteTheme(),
  }, viewerOrigin);
}

function ensureFileWorkspaceWidget() {
  const threadId = currentThreadId();
  if (!threadId) {
    removeFileWorkspaceWidget();
    return;
  }
  const shell = findChatGPTSidePaneShell();
  if (!shell) return;
  if (fileWorkspaceWidget?.threadId === threadId && fileWorkspaceWidget.host.isConnected) {
    if (fileWorkspaceWidget.host.parentElement !== shell) shell.appendChild(fileWorkspaceWidget.host);
    sendFileWorkspaceHostState();
    if (fileWorkspaceWidget.visible) applyFileWorkspaceVisibility();
    return;
  }
  removeFileWorkspaceWidget();
  const host = document.createElement("div");
  host.className = "local-system-file-workspace-host";
  host.hidden = true;
  const frame = document.createElement("iframe");
  frame.className = "local-system-file-workspace-frame";
  frame.title = "Local System file workspace";
  const workspaceUrl = extensionUrl("file-workspace.html");
  if (!workspaceUrl) return;
  frame.src = `${workspaceUrl}?threadId=${encodeURIComponent(threadId)}`;
  host.appendChild(frame);
  shell.appendChild(host);
  fileWorkspaceWidget = {
    threadId,
    host,
    frame,
    ready: false,
    visible: false,
    width: 476,
    pendingPaths: [],
    pendingToggle: false,
    pendingMode: "",
    forceVisibility: false,
  };
  frame.addEventListener("load", () => {
    if (!fileWorkspaceWidget || fileWorkspaceWidget.frame !== frame) return;
    fileWorkspaceWidget.ready = true;
    sendFileWorkspaceHostState();
    flushPendingWorkspaceFiles();
    flushPendingWorkspaceToggle();
    flushPendingWorkspaceMode();
  }, { once: true });
}

function removeFileWorkspaceWidget() {
  fileWorkspaceWidget?.host?.remove();
  fileWorkspaceWidget = null;
}

function handleFileWorkspaceMessage(event) {
  if (!fileWorkspaceWidget || event.source !== fileWorkspaceWidget.frame.contentWindow) return;
  if (event.data.action === "ready") {
    fileWorkspaceWidget.ready = true;
    sendFileWorkspaceHostState();
    flushPendingWorkspaceFiles();
    flushPendingWorkspaceToggle();
    return;
  }
  if (event.data.action === "visibility") {
    fileWorkspaceWidget.visible = event.data.visible === true;
    if (!fileWorkspaceWidget.visible) {
      fileWorkspaceWidget.forceVisibility = false;
      fileWorkspaceWidget.host.removeAttribute("data-local-system-force-visible");
    }
    if (Number.isFinite(Number(event.data.width))) fileWorkspaceWidget.width = Number(event.data.width);
    applyFileWorkspaceVisibility();
    scheduleUiVisibilityReconcile();
    return;
  }
  if (event.data.action === "resize") {
    fileWorkspaceWidget.width = Math.max(420, Math.min(1_000, Number(event.data.width) || fileWorkspaceWidget.width));
    applyFileWorkspaceVisibility();
    return;
  }
  if (event.data.action === "resize-start") {
    fileWorkspaceWidget.host.classList.add("local-system-file-workspace-resizing");
    return;
  }
  if (event.data.action === "resize-end") {
    fileWorkspaceWidget.host.classList.remove("local-system-file-workspace-resizing");
    return;
  }
  if (event.data.action === "toggle-left-sidebar") {
    toggleChatGPTLeftSidebar();
    return;
  }
  if (event.data.action === "quick-open") {
    openFileQuickOpen(event.data.mode === "text" ? "text" : "files", event.data.query);
    return;
  }
  if (event.data.action === "ui-visibility") {
    const key = event.data.key;
    if (key in DEFAULT_UI_VISIBILITY) {
      applyUiVisibilityPreferences({ ...uiVisibility, [key]: event.data.value === true });
    }
    return;
  }
  if (event.data.action === "project-picker") {
    globalThis.dispatchEvent(new CustomEvent("local-system-project-picker-request"));
    return;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.source !== "local-system-extension-command") return;
  if (message.action === "read-theme") {
    sendResponse?.({ theme: composerPaletteTheme() });
    return;
  }
  if (message.action === "toggle-file-workspace" && ENABLE_FILE_WORKSPACE) toggleFileWorkspace();
  if (message.action === "workspace-state-changed") {
    globalThis.dispatchEvent(new CustomEvent("local-system-project-changed", {
      detail: { source: "native-side-panel", openFiles: false },
    }));
  }
});

let lastBroadcastThemeSignature = "";
let themeBroadcastFrame = 0;
let themeSettleTimer = 0;
function scheduleLocalSystemThemeBroadcast() {
  if (themeBroadcastFrame) return;
  themeBroadcastFrame = globalThis.requestAnimationFrame(() => {
    themeBroadcastFrame = 0;
    const theme = composerPaletteTheme();
    const signature = `${theme.surface}\\n${theme.text}`;
    if (signature === lastBroadcastThemeSignature) return;
    lastBroadcastThemeSignature = signature;
    broadcastThemeToLocalFrames(theme);
    try {
      chrome.runtime.sendMessage({
        source: "local-system-content",
        action: "theme-changed",
        theme,
      }, () => void chrome.runtime.lastError);
    } catch {
      // Extension context can disappear during reload/navigation.
    }
  });
}

function scheduleLocalSystemThemeSettle() {
  scheduleLocalSystemThemeBroadcast();
  clearTimeout(themeSettleTimer);
  themeSettleTimer = setTimeout(() => {
    themeSettleTimer = 0;
    scheduleLocalSystemThemeBroadcast();
  }, 120);
}

function themeMutationAffectsComposer(mutation, editor = findComposerEditor()) {
  const target = mutation?.target;
  if (target === document.documentElement || target === document.body) return true;
  return Boolean(
    editor
    && target instanceof globalThis.Element
    && (target === editor || target.contains(editor))
  );
}

function broadcastThemeToLocalFrames(theme) {
  const active = document.visibilityState === "visible" && document.hasFocus();
  for (const surface of [todosWidget, skillsPalette, filesPalette, fileQuickOpen, fileWorkspaceWidget]) {
    if (!surface?.ready || !surface.frame?.contentWindow) continue;
    surface.frame.contentWindow.postMessage({
      source: "local-system-host",
      active,
      theme,
    }, viewerOrigin);
  }
  for (const frame of frames.values()) {
    frame.contentWindow?.postMessage({
      source: "local-system-host",
      theme,
    }, viewerOrigin);
  }
  activeModal?.frame?.contentWindow?.postMessage({
    source: "local-system-host",
    theme,
  }, viewerOrigin);
}
const localSystemThemeObserver = new MutationObserver((mutations) => {
  const editor = findComposerEditor();
  if (!mutations.some((mutation) => themeMutationAffectsComposer(mutation, editor))) return;
  scheduleLocalSystemThemeSettle();
});
localSystemThemeObserver.observe(document.documentElement, {
  attributes: true,
  subtree: true,
  attributeFilter: ["class", "style", "data-theme", "data-color-scheme", "data-mode"],
});
globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", scheduleLocalSystemThemeSettle);
scheduleLocalSystemThemeSettle();

function openFileInWorkspace(path, line = null, column = null, length = null, { restoreFocus = false } = {}) {
  ensureFileWorkspaceWidget();
  if (!fileWorkspaceWidget) return;
  if (!fileWorkspaceWidget.ready || !fileWorkspaceWidget.frame?.contentWindow) {
    fileWorkspaceWidget.pendingPaths.push({ path, line, column, length, restoreFocus });
    return;
  }
  forceEmbeddedWorkspaceVisible();
  fileWorkspaceWidget.frame.contentWindow.postMessage({
    source: "local-system-host",
    action: "open-file",
    path,
    line,
    column,
    length,
    restoreFocus,
    active: document.visibilityState === "visible" && document.hasFocus(),
    theme: composerPaletteTheme(),
  }, viewerOrigin);
}

function requestNativeSidePanel() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({
        source: "local-system-content",
        action: "open-side-panel",
      }, (response) => {
        void traceWorkspace("content.side-panel.response", { data: response || null });
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(response || { ok: false });
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function openFileFromChatGpt(path, line = null, column = null, length = null, { nativePanelRequest = null, source = "event" } = {}) {
  const threadId = currentThreadId();
  if (!threadId) return openFileInWorkspace(path, line, column, length);
  void traceWorkspace("content.open-file.start", { threadId, path, data: { line, column, length, source } });
  const panelRequest = nativePanelRequest || requestNativeSidePanel();
  try {
    const openedState = await localSystemApiRequest("/local-ui/file-workspace", {
      threadId,
      action: "open_file",
      path,
      active: true,
    });
    void traceWorkspace("content.open-file.server-ok", {
      threadId,
      path,
      data: { activePath: openedState?.workspace?.activePath || "" },
    });
    const opened = await panelRequest;
    if (!opened?.ok || opened.payload?.unsupported === true) throw new Error("Native side panel unavailable");
    await notifyNativeWorkspaceStateChanged(threadId, { path, line, column, length });
    void traceWorkspace("content.open-file.relayed", { threadId, path });
  } catch (error) {
    void traceWorkspace("content.open-file.fallback", {
      threadId,
      path,
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    openFileInWorkspace(path, line, column, length);
  }
}

async function notifyNativeWorkspaceStateChanged(threadId = currentThreadId(), file = null) {
  if (!threadId) return;
  try {
    await chrome.runtime.sendMessage({
      source: "local-system-content",
      action: "workspace-state-changed",
      threadId,
      file,
    });
  } catch {
    // The native side panel may not be open; persisted workspace state is enough.
  }
}

async function traceWorkspace(stage, { threadId = currentThreadId(), path = null, data = null } = {}) {
  try {
    await localSystemApiRequest("/local-ui/workspace-trace", {
      action: "record",
      event: { stage, threadId, path, data },
    });
  } catch {
    // Diagnostics must never affect workspace behavior.
  }
}

function forceEmbeddedWorkspaceVisible() {
  if (!fileWorkspaceWidget?.host) return;
  fileWorkspaceWidget.forceVisibility = true;
  fileWorkspaceWidget.host.setAttribute("data-local-system-force-visible", "true");
}

function flushPendingWorkspaceFiles() {
  if (!fileWorkspaceWidget?.ready) return;
  const pending = fileWorkspaceWidget.pendingPaths.splice(0);
  for (const item of pending) {
    if (typeof item === "string") openFileInWorkspace(item);
    else openFileInWorkspace(
      item.path,
      item.line,
      item.column,
      item.length,
      { restoreFocus: item.restoreFocus === true },
    );
  }
}

function flushPendingWorkspaceToggle() {
  if (!fileWorkspaceWidget?.ready || !fileWorkspaceWidget.pendingToggle) return;
  fileWorkspaceWidget.pendingToggle = false;
  toggleFileWorkspace();
}

function flushPendingWorkspaceMode() {
  if (!fileWorkspaceWidget?.ready || !fileWorkspaceWidget.pendingMode) return;
  const mode = fileWorkspaceWidget.pendingMode;
  fileWorkspaceWidget.pendingMode = "";
  openFileWorkspaceMode(mode);
}

function sendFileWorkspaceHostState() {
  if (!fileWorkspaceWidget?.ready || !fileWorkspaceWidget.frame?.contentWindow) return;
  fileWorkspaceWidget.frame.contentWindow.postMessage({
    source: "local-system-host",
    active: document.visibilityState === "visible" && document.hasFocus(),
    theme: composerPaletteTheme(),
  }, viewerOrigin);
}

function applyFileWorkspaceVisibility() {
  if (!fileWorkspaceWidget) return;
  fileWorkspaceWidget.host.hidden = !fileWorkspaceWidget.visible;
  scheduleUiVisibilityReconcile();
  if (!fileWorkspaceWidget.visible) return;
  const shell = findChatGPTSidePaneShell();
  if (shell && fileWorkspaceWidget.host.parentElement !== shell) shell.appendChild(fileWorkspaceWidget.host);
  const width = clampFileWorkspaceWidth(fileWorkspaceWidget.width);
  fileWorkspaceWidget.width = width;
  fileWorkspaceWidget.host.style.width = `${width}px`;
  fileWorkspaceWidget.host.style.flexBasis = `${width}px`;
  fileWorkspaceWidget.frame.style.width = "100%";
  if (fileWorkspaceWidget.ready && fileWorkspaceWidget.frame.contentWindow) {
    fileWorkspaceWidget.frame.contentWindow.postMessage({
      source: "local-system-host",
      action: "host-width",
      width,
    }, viewerOrigin);
  }
}

function clampFileWorkspaceWidth(value) {
  const requested = Number(value) || 476;
  // Preserve a useful ChatGPT pane even on smaller laptop windows.
  const shell = findChatGPTSidePaneShell();
  const shellWidth = shell?.getBoundingClientRect().width || globalThis.innerWidth;
  const standalone = shell?.querySelector(".local-system-standalone-workspace-root:not([data-mobile])");
  const standaloneWidth = standalone && getComputedStyle(standalone).display !== "none"
    ? standalone.getBoundingClientRect().width
    : 0;
  const responsiveMax = Math.max(320, Math.min(1_000, shellWidth - 420 - standaloneWidth));
  const responsiveMin = Math.min(420, responsiveMax);
  return Math.max(responsiveMin, Math.min(responsiveMax, Math.round(requested)));
}

function findChatGPTSidePaneShell() {
  let node = document.querySelector("#thread") || findComposer();
  while (node && node !== document.body) {
    // Match the actual ChatGPT side-pane flex host, not descendants whose
    // Tailwind variant strings merely *mention* side-pane-shell-host (for
    // example group-data-[side-pane-shell-open]/side-pane-shell-host).
    if (node.classList?.contains("group/side-pane-shell-host")) return node;
    node = node.parentElement;
  }
  return null;
}

function removeTodosWidget() {
  if (!todosWidget) return;
  const rail = todosWidget.host.closest(".local-system-composer-rail");
  todosWidget.host.remove();
  todosWidget = null;
  if (rail && !rail.children.length) rail.remove();
}

function ensureComposerRail(composer = findComposer()) {
  if (!composer) return null;
  let rail = composer.previousElementSibling?.classList?.contains("local-system-composer-rail")
    ? composer.previousElementSibling
    : document.querySelector(".local-system-composer-rail");
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "local-system-composer-rail";
  }
  if (rail.nextElementSibling !== composer) composer.insertAdjacentElement("beforebegin", rail);
  return rail;
}

function setTodosExpanded(expanded) {
  if (!todosWidget) return;
  todosWidget.expanded = expanded;
  if (!todosWidget.ready || !todosWidget.frame?.contentWindow) return;
  todosWidget.frame.contentWindow.postMessage({
    source: "local-system-host",
    expanded,
  }, viewerOrigin);
}

function handleTodosOutsidePointerDown(event) {
  if (!todosWidget?.expanded) return;
  if (todosWidget.host.contains(event.target)) return;
  setTodosExpanded(false);
}

function sendTodosHostState() {
  if (!todosWidget?.ready || !todosWidget.frame?.contentWindow) return;
  if (pendingLocalSystemBind && pendingLocalSystemBind.expiresAt <= Date.now()) {
    pendingLocalSystemBind = null;
  }
  todosWidget.frame.contentWindow.postMessage({
    source: "local-system-host",
    active: document.visibilityState === "visible" && document.hasFocus(),
    expanded: todosWidget.expanded === true,
    theme: composerPaletteTheme(),
  }, viewerOrigin);
}

function captureLocalSystemBindIntentFromKeydown(event) {
  if (event.isComposing || event.key !== "Enter" || event.shiftKey) return;
  const editor = globalThis.LocalSystemSharedRuntime?.closestComposerEditor?.(event.target);
  if (editor) captureLocalSystemBindIntent(editor);
}

function captureLocalSystemBindIntentFromClick(event) {
  const button = event.target?.closest?.('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label^="Send"]');
  if (!button || !button.closest("form")) return;
  const editor = findComposerEditor();
  if (editor) captureLocalSystemBindIntent(editor);
}

function captureLocalSystemBindIntent(_editor) {
  const threadId = currentThreadId();
  if (!threadId) return;
  const now = Date.now();
  if (pendingLocalSystemBind && now - pendingLocalSystemBind.sentAt < 1_000) return;
  pendingLocalSystemBind = {
    threadId,
    sentAt: now,
    expiresAt: now + 120_000,
  };
  schedulePendingLocalSystemBindRetry(LEGACY_BIND_FALLBACK_DELAY_MS);
}

async function attemptPendingLocalSystemBind() {
  const pending = pendingLocalSystemBind;
  if (!pending || pendingLocalSystemBindInFlight) return;
  if (Date.now() - pending.sentAt < LEGACY_BIND_FALLBACK_DELAY_MS) {
    schedulePendingLocalSystemBindRetry(LEGACY_BIND_FALLBACK_DELAY_MS - (Date.now() - pending.sentAt));
    return;
  }
  if (pending.expiresAt <= Date.now() || currentThreadId() !== pending.threadId) {
    pendingLocalSystemBind = null;
    clearTimeout(bindRetryTimer);
    bindRetryTimer = 0;
    sendTodosHostState();
    return;
  }

  pendingLocalSystemBindInFlight = true;
  try {
    const response = await chrome.runtime.sendMessage({
      source: "local-system-content",
      action: "register-bind-intent",
      threadId: pending.threadId,
      sentAt: pending.sentAt,
    });
    if (pendingLocalSystemBind !== pending) return;
    if (response?.ok && response.payload?.bound === true) {
      pendingLocalSystemBind = null;
      clearTimeout(bindRetryTimer);
      bindRetryTimer = 0;
      globalThis.dispatchEvent(new CustomEvent("local-system-binding-changed", {
        detail: { threadId: pending.threadId, bound: true },
      }));
      return;
    }
    if (response?.ok && response.payload?.conflict === true) {
      pendingLocalSystemBind = null;
      clearTimeout(bindRetryTimer);
      bindRetryTimer = 0;
      console.warn("Local System direct thread binding conflict", response.payload.reason || "unknown");
      sendTodosHostState();
      return;
    }
  } catch {
    // The service worker or loopback bridge may be waking up. Keep retrying
    // for the explicit-bind window instead of coupling binding to todo UI.
  } finally {
    pendingLocalSystemBindInFlight = false;
    if (pendingLocalSystemBind === pending) schedulePendingLocalSystemBindRetry(900);
  }
}

function handleBrowserBindingTokenMessage(event) {
  const token = event.data?.token;
  if (typeof token !== "string" || !BROWSER_BIND_TOKEN_RE.test(token)) return;
  pendingBrowserBindingToken = { token, expiresAt: Date.now() + 120_000 };
  scheduleBrowserBindingTokenRetry(0);
}

async function bindObservedMcpConversation(conversationId) {
  if (typeof conversationId !== "string" || !conversationId.trim() || conversationId.length > 512) return;
  const threadId = currentThreadId();
  if (!threadId) return;
  try {
    const response = await chrome.runtime.sendMessage({
      source: "local-system-content",
      action: "bind-thread-observed",
      threadId,
      conversationId: conversationId.trim(),
    });
    if (response?.ok && response.payload?.bound === true) {
      pendingLocalSystemBind = null;
      clearTimeout(bindRetryTimer);
      bindRetryTimer = 0;
      globalThis.dispatchEvent(new CustomEvent("local-system-binding-changed", {
        detail: { threadId, bound: true, source: "observed-mcp" },
      }));
    }
  } catch {
    // The legacy send-time path remains available if the bridge is temporarily unavailable.
  }
}

async function attemptBrowserBindingToken() {
  const pending = pendingBrowserBindingToken;
  if (!pending || browserBindingTokenInFlight) return;
  if (pending.expiresAt <= Date.now()) {
    pendingBrowserBindingToken = null;
    return;
  }
  const threadId = currentThreadId();
  if (!threadId) {
    scheduleBrowserBindingTokenRetry(150);
    return;
  }
  browserBindingTokenInFlight = true;
  try {
    const response = await chrome.runtime.sendMessage({
      source: "local-system-content",
      action: "bind-thread-token",
      threadId,
      token: pending.token,
    });
    if (pendingBrowserBindingToken !== pending) return;
    if (response?.ok && response.payload?.bound === true) {
      pendingBrowserBindingToken = null;
      pendingLocalSystemBind = null;
      clearTimeout(bindRetryTimer);
      bindRetryTimer = 0;
      globalThis.dispatchEvent(new CustomEvent("local-system-binding-changed", {
        detail: { threadId, bound: true, source: "token" },
      }));
      return;
    }
    if (response?.ok && (response.payload?.expired === true || response.payload?.conflict === true)) {
      pendingBrowserBindingToken = null;
      return;
    }
  } catch {
    // The local bridge may be waking up. Retry while the short-lived token is valid.
  } finally {
    browserBindingTokenInFlight = false;
    if (pendingBrowserBindingToken === pending) scheduleBrowserBindingTokenRetry(300);
  }
}

function scheduleBrowserBindingTokenRetry(delayMs = 300) {
  if (!pendingBrowserBindingToken) return;
  clearTimeout(browserBindingTokenRetryTimer);
  browserBindingTokenRetryTimer = setTimeout(() => {
    browserBindingTokenRetryTimer = 0;
    void attemptBrowserBindingToken();
  }, Math.max(0, delayMs));
}

function schedulePendingLocalSystemBindRetry(delayMs = 900) {
  if (!pendingLocalSystemBind) return;
  clearTimeout(bindRetryTimer);
  bindRetryTimer = setTimeout(() => {
    bindRetryTimer = 0;
    void attemptPendingLocalSystemBind();
  }, Math.max(0, delayMs));
}

function currentThreadId() {
  return globalThis.LocalSystemSharedRuntime?.currentThreadId() || "";
}

function findComposer() {
  return globalThis.LocalSystemSharedRuntime?.findComposer?.() || null;
}

function findComposerEditor() {
  return globalThis.LocalSystemSharedRuntime?.findComposerEditor?.() || null;
}

function handleComposerPickerInput(event) {
  const editor = globalThis.LocalSystemSharedRuntime?.closestComposerEditor?.(event.target);
  if (!editor) return;
  if (handleComposerPickerInput.frame) globalThis.cancelAnimationFrame(handleComposerPickerInput.frame);
  handleComposerPickerInput.frame = globalThis.requestAnimationFrame(() => {
    handleComposerPickerInput.frame = 0;
    if (!editor.isConnected) {
      closeSkillsPalette();
      closeFilesPalette();
      return;
    }
    syncComposerPickers(editor);
  });
}
handleComposerPickerInput.frame = 0;

function handleComposerPickerSelectionChange() {
  if (!skillsPalette && !filesPalette) return;
  if (handleComposerPickerSelectionChange.frame) globalThis.cancelAnimationFrame(handleComposerPickerSelectionChange.frame);
  handleComposerPickerSelectionChange.frame = globalThis.requestAnimationFrame(() => {
    handleComposerPickerSelectionChange.frame = 0;
    const editor = findComposerEditor();
    const selection = globalThis.getSelection?.();
    if (!editor || !selection?.rangeCount || !selection.anchorNode || !editor.contains(selection.anchorNode) || !selection.isCollapsed) {
      closeSkillsPalette();
      closeFilesPalette();
      return;
    }
    syncComposerPickers(editor);
  });
}
handleComposerPickerSelectionChange.frame = 0;

function handleComposerPickerKeydown(event) {
  if (event.defaultPrevented || event.isComposing) return;
  const editor = globalThis.LocalSystemSharedRuntime?.closestComposerEditor?.(event.target);
  if (!editor) return;

  const trigger = currentComposerTrigger(editor);
  const palette = trigger?.type === "skills" ? skillsPalette : trigger?.type === "files" ? filesPalette : null;
  if (!trigger || !palette) return;

  if (event.key === "Enter" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && trigger.type === "files") {
    event.preventDefault();
    event.stopImmediatePropagation();
    postPaletteCommand(palette, { action: "select-path-active" });
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

  if (event.key === "Escape") {
    event.preventDefault();
    if (trigger.type === "skills") closeSkillsPalette();
    else closeFilesPalette();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    postPaletteCommand(palette, {
      action: "navigate",
      delta: event.key === "ArrowDown" ? 1 : -1,
    });
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    postPaletteCommand(palette, { action: "select-active" });
  }
}

function syncComposerPickers(editor) {
  const trigger = currentComposerTrigger(editor);
  if (!trigger) {
    closeSkillsPalette();
    closeFilesPalette();
    return;
  }

  if (trigger.type === "skills") {
    closeFilesPalette();
    const palette = openSkillsPalette(editor);
    syncPaletteQuery(palette, trigger);
    return;
  }

  closeSkillsPalette();
  const palette = openFilesPalette(editor);
  syncPaletteQuery(palette, trigger);
}

function currentComposerTrigger(editor) {
  const selection = globalThis.getSelection?.();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const before = textBeforeCaret(editor);
  if (before == null) return null;

  const skillMatch = before.match(/(?:^|\s)\/\/([^\s/]*)$/);
  if (skillMatch) {
    const query = skillMatch[1] || "";
    return { type: "skills", query, tokenLength: 2 + query.length };
  }

  const fileMatch = before.match(/(?:^|\s)@@([^\n]*)$/);
  if (fileMatch) {
    const query = fileMatch[1] || "";
    return { type: "files", query, tokenLength: 2 + query.length };
  }

  return null;
}

function syncPaletteQuery(palette, trigger) {
  if (!palette) return;
  palette.trigger = trigger;
  palette.savedRange = saveEditorRange(palette.editor);
  if (palette.query === trigger.query && palette.sentTheme) return;
  palette.query = trigger.query;
  const message = {
    source: "local-system-palette-host",
    action: "query",
    query: trigger.query,
    theme: composerPaletteTheme(),
  };
  palette.pendingMessage = message;
  if (palette.ready && palette.frame.contentWindow) {
    palette.frame.contentWindow.postMessage(message, viewerOrigin);
    palette.pendingMessage = null;
    palette.sentTheme = true;
  }
}

function postPaletteCommand(palette, command) {
  if (!palette?.ready || !palette.frame.contentWindow) return;
  palette.frame.contentWindow.postMessage({
    source: "local-system-palette-host",
    ...command,
  }, viewerOrigin);
}

function composerPaletteTheme() {
  const editor = findComposerEditor();
  const composer = findComposer();
  const typographyReference = editor;
  const contentTypographyReference = document.body;
  let surface = "";
  let node = editor?.parentElement || composer;
  while (node) {
    const style = getComputedStyle(node);
    const background = style.backgroundColor;
    if (background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)") {
      surface = background;
      break;
    }
    if (node === composer) break;
    node = node.parentElement;
  }
  const editorStyle = editor ? getComputedStyle(editor) : null;
  const typographyStyle = typographyReference ? getComputedStyle(typographyReference) : editorStyle;
  const contentTypographyStyle = contentTypographyReference ? getComputedStyle(contentTypographyReference) : editorStyle;
  return {
    surface,
    text: editorStyle?.color || "",
    fontFamily: typographyStyle?.fontFamily || "",
    fontSize: typographyStyle?.fontSize || "",
    fontWeight: typographyStyle?.fontWeight || "",
    lineHeight: typographyStyle?.lineHeight || "",
    mainFontSize: editorStyle?.fontSize || "",
    mainFontWeight: editorStyle?.fontWeight || "",
    contentFontSize: contentTypographyStyle?.fontSize || editorStyle?.fontSize || "",
    contentLineHeight: contentTypographyStyle?.lineHeight || editorStyle?.lineHeight || "",
  };
}

function replaceComposerTrigger(editor, trigger, replacement = "") {
  if (!editor || !trigger) return false;
  const selection = globalThis.getSelection?.();
  if (!selection?.rangeCount || typeof selection.modify !== "function") return false;
  for (let index = 0; index < trigger.tokenLength; index += 1) {
    selection.modify("extend", "backward", "character");
  }
  document.execCommand("insertText", false, replacement);
  return true;
}

function textBeforeCaret(editor) {
  const selection = globalThis.getSelection?.();
  if (!selection?.rangeCount || !selection.anchorNode || !editor.contains(selection.anchorNode)) return null;
  try {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString();
  } catch {
    return null;
  }
}

function attachFilesToComposer(files, editor = findComposerEditor()) {
  const target = editor || findComposer();
  if (!target || !files.length) return false;
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  target.dispatchEvent(new DragEvent("drop", {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
  }));
  return true;
}

function installLocalFileDropTarget() {
  document.addEventListener("dragenter", handleLocalFileDragEnter, true);
  document.addEventListener("dragover", handleLocalFileDragOver, true);
  document.addEventListener("dragleave", handleLocalFileDragLeave, true);
  document.addEventListener("drop", handleLocalFileDrop, true);
}

function isLocalSystemFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes(LOCAL_FILE_DRAG_MIME);
}

function composerForDropTarget(target) {
  return globalThis.LocalSystemSharedRuntime?.closestComposer?.(target) || null;
}

function handleLocalFileDragEnter(event) {
  if (!isLocalSystemFileDrag(event)) return;
  const composer = composerForDropTarget(event.target);
  if (!composer) return;
  event.preventDefault();
  localFileDropDepth += 1;
  composer.dataset.localSystemFileDropState = "ready";
}

function handleLocalFileDragOver(event) {
  if (!isLocalSystemFileDrag(event)) return;
  const composer = composerForDropTarget(event.target);
  if (!composer) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  composer.dataset.localSystemFileDropState = localFileDropBusy ? "loading" : "ready";
}

function handleLocalFileDragLeave(event) {
  if (!isLocalSystemFileDrag(event)) return;
  const composer = composerForDropTarget(event.target);
  if (!composer) return;
  localFileDropDepth = Math.max(0, localFileDropDepth - 1);
  if (localFileDropDepth > 0 && composer.contains(event.relatedTarget)) return;
  if (!localFileDropBusy) delete composer.dataset.localSystemFileDropState;
}

async function handleLocalFileDrop(event) {
  if (!isLocalSystemFileDrag(event) || localFileDropBusy) return;
  const composer = composerForDropTarget(event.target);
  if (!composer) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  localFileDropDepth = 0;

  let payload;
  try {
    payload = JSON.parse(event.dataTransfer?.getData(LOCAL_FILE_DRAG_MIME) || "null");
  } catch {
    payload = null;
  }
  if (!payload || payload.version !== 1 || typeof payload.path !== "string" || !payload.path) {
    delete composer.dataset.localSystemFileDropState;
    return;
  }

  localFileDropBusy = true;
  composer.dataset.localSystemFileDropState = "loading";
  try {
    const descriptor = await requestDraggedLocalFile(payload);
    if (!(descriptor?.buffer instanceof ArrayBuffer)) throw new Error("Local System returned invalid file data");
    const file = new File([descriptor.buffer], descriptor.name || payload.name || "file", {
      type: descriptor.mimeType || "application/octet-stream",
      lastModified: Number(descriptor.lastModified) || Date.now(),
    });
    const attached = attachFilesToComposer([file], findComposerEditor());
    if (!attached) throw new Error("ChatGPT composer is unavailable");
    composer.dataset.localSystemFileDropState = "success";
    setTimeout(() => {
      if (composer.dataset.localSystemFileDropState === "success") delete composer.dataset.localSystemFileDropState;
    }, 700);
  } catch (error) {
    console.warn("Local System file drop failed", error);
    composer.dataset.localSystemFileDropState = "error";
    setTimeout(() => {
      if (composer.dataset.localSystemFileDropState === "error") delete composer.dataset.localSystemFileDropState;
    }, 1_600);
  } finally {
    localFileDropBusy = false;
  }
}

async function requestDraggedLocalFile(payload) {
  const deadline = Date.now() + 3_000;
  while (typeof globalThis.LocalSystemFileRequest !== "function" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (typeof globalThis.LocalSystemFileRequest !== "function") throw new Error("Local System file bridge is unavailable");
  return globalThis.LocalSystemFileRequest({
    threadId: String(payload.threadId || currentThreadId()),
    path: payload.path,
    active: true,
  });
}

function openFilesPalette(editor) {
  closeSkillsPalette();
  if (filesPalette?.editor === editor && filesPalette.host.isConnected) return filesPalette;
  closeFilesPalette();
  const threadId = currentThreadId();

  const host = document.createElement("div");
  host.className = "local-system-files-host";
  const frame = document.createElement("iframe");
  frame.className = "local-system-files-frame";
  frame.title = "Local System files";
  const filesUrl = extensionUrl("files.html");
  if (!filesUrl) return null;
  frame.src = `${filesUrl}?threadId=${encodeURIComponent(threadId)}`;
  host.appendChild(frame);
  document.documentElement.appendChild(host);
  filesPalette = {
    host,
    frame,
    editor,
    savedRange: saveEditorRange(editor),
    trigger: null,
    query: null,
    ready: false,
    sentTheme: false,
    pendingMessage: null,
  };
  const palette = filesPalette;
  frame.addEventListener("load", () => {
    if (filesPalette !== palette) return;
    palette.ready = true;
    if (palette.pendingMessage && frame.contentWindow) {
      frame.contentWindow.postMessage(palette.pendingMessage, viewerOrigin);
      palette.pendingMessage = null;
      palette.sentTheme = true;
    }
  }, { once: true });
  positionFilesPalette();
  return filesPalette;
}

function handleFilesMessage(event) {
  if (!filesPalette || event.source !== filesPalette.frame.contentWindow) return;
  if (event.data.action === "resize") {
    const height = Math.max(48, Math.min(420, Number(event.data.height) || 48));
    filesPalette.frame.style.height = `${height}px`;
    return;
  }
  if (event.data.action === "close") {
    closeFilesPalette();
    return;
  }
  if (event.data.action === "select-path" && typeof event.data.path === "string") {
    const { editor, savedRange, trigger } = filesPalette;
    restoreEditorRange(editor, savedRange);
    replaceComposerTrigger(editor, trigger, event.data.path);
    closeFilesPalette();
    editor.focus();
    return;
  }
  if (event.data.action === "select" && event.data.blob && typeof event.data.blob.size === "number" && typeof event.data.name === "string") {
    const { editor, savedRange, trigger } = filesPalette;
    const file = new File([event.data.blob], event.data.name, {
      type: typeof event.data.mimeType === "string" ? event.data.mimeType : event.data.blob.type,
      lastModified: Number(event.data.lastModified) || Date.now(),
    });
    restoreEditorRange(editor, savedRange);
    replaceComposerTrigger(editor, trigger, "");
    closeFilesPalette();
    attachFilesToComposer([file], editor);
    editor.focus();
  }
}

function positionFilesPalette() {
  positionComposerPalette(filesPalette);
}

function closeFilesPalette() {
  if (!filesPalette) return;
  filesPalette.host.remove();
  filesPalette = null;
}

function openSkillsPalette(editor) {
  closeFilesPalette();
  if (skillsPalette?.editor === editor && skillsPalette.host.isConnected) return skillsPalette;
  closeSkillsPalette();
  const threadId = currentThreadId();

  const host = document.createElement("div");
  host.className = "local-system-skills-host";
  const frame = document.createElement("iframe");
  frame.className = "local-system-skills-frame";
  frame.title = "Local System skills";
  const skillsUrl = extensionUrl("skills.html");
  if (!skillsUrl) return null;
  frame.src = `${skillsUrl}?threadId=${encodeURIComponent(threadId)}`;
  host.appendChild(frame);
  document.documentElement.appendChild(host);
  skillsPalette = {
    host,
    frame,
    editor,
    savedRange: saveEditorRange(editor),
    trigger: null,
    query: null,
    ready: false,
    sentTheme: false,
    pendingMessage: null,
  };
  const palette = skillsPalette;
  frame.addEventListener("load", () => {
    if (skillsPalette !== palette) return;
    palette.ready = true;
    if (palette.pendingMessage && frame.contentWindow) {
      frame.contentWindow.postMessage(palette.pendingMessage, viewerOrigin);
      palette.pendingMessage = null;
      palette.sentTheme = true;
    }
  }, { once: true });
  positionSkillsPalette();
  return skillsPalette;
}

function handleSkillsMessage(event) {
  if (!skillsPalette || event.source !== skillsPalette.frame.contentWindow) return;
  if (event.data.action === "resize") {
    const height = Math.max(48, Math.min(390, Number(event.data.height) || 48));
    skillsPalette.frame.style.height = `${height}px`;
    return;
  }
  if (event.data.action === "close") {
    closeSkillsPalette();
    return;
  }
  if (event.data.action === "select" && typeof event.data.name === "string") {
    if (pendingSkillSelection) return;
    const { editor, savedRange, trigger } = skillsPalette;
    pendingSkillSelection = {
      name: event.data.name,
      editor,
      savedRange,
      trigger,
      palette: skillsPalette,
    };
    postPaletteCommand(skillsPalette, { action: "busy", name: event.data.name });
    globalThis.dispatchEvent(new CustomEvent("local-system-skill-attach-request", {
      detail: { name: event.data.name },
    }));
  }
}

function handleSkillAttachResult(event) {
  const pending = pendingSkillSelection;
  if (!pending || event.detail?.name !== pending.name) return;
  pendingSkillSelection = null;

  if (event.detail?.ok !== true) {
    if (skillsPalette === pending.palette) {
      postPaletteCommand(skillsPalette, {
        action: "error",
        message: String(event.detail?.error || "Could not attach skill."),
      });
    }
    pending.editor?.focus?.();
    return;
  }

  restoreEditorRange(pending.editor, pending.savedRange);
  replaceComposerTrigger(pending.editor, pending.trigger, `/${pending.name} `);
  if (skillsPalette === pending.palette) closeSkillsPalette();
  pending.editor.focus();
}

function saveEditorRange(editor) {
  const selection = globalThis.getSelection?.();
  if (!selection?.rangeCount || !selection.anchorNode || !editor.contains(selection.anchorNode)) return null;
  return selection.getRangeAt(0).cloneRange();
}

function restoreEditorRange(editor, savedRange) {
  editor.focus();
  const selection = globalThis.getSelection?.();
  if (!selection) return;
  selection.removeAllRanges();
  if (savedRange) {
    try {
      selection.addRange(savedRange);
      return;
    } catch {
      // ProseMirror may have rewritten the text node while the palette was open.
    }
  }
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.addRange(range);
}

function positionSkillsPalette() {
  positionComposerPalette(skillsPalette);
}

function positionComposerPalette(palette) {
  if (!palette) return;
  const composer = findComposer();
  if (!composer) return;
  const rect = composer.getBoundingClientRect();
  const width = Math.min(rect.width, globalThis.innerWidth - 16);
  palette.host.style.left = `${Math.max(8, Math.min(rect.left, globalThis.innerWidth - width - 8))}px`;
  palette.host.style.width = `${width}px`;
  palette.host.style.bottom = `${Math.max(8, globalThis.innerHeight - rect.top + 6)}px`;
}

function closeSkillsPalette() {
  if (!skillsPalette) return;
  skillsPalette.host.remove();
  skillsPalette = null;
}

function openModal(path) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "local-system-inline-image__overlay";

  const frame = document.createElement("iframe");
  frame.className = "local-system-inline-image__modal-frame";
  frame.title = path.split(/[\\/]/).pop() || "Local file preview";
  const modalViewerUrl = extensionUrl("viewer.html");
  if (!modalViewerUrl) return;
  frame.src = `${modalViewerUrl}?mode=modal&id=${encodeURIComponent(crypto.randomUUID())}&path=${encodeURIComponent(path)}&threadId=${encodeURIComponent(currentThreadId())}`;

  overlay.appendChild(frame);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal();
  });
  document.documentElement.appendChild(overlay);
  activeModal = { overlay, frame };
}

function closeModal() {
  if (!activeModal) return;
  activeModal.overlay.remove();
  activeModal = null;
}

function injectStyle() {
  if (document.getElementById("local-system-inline-image-style")) return;
  const style = document.createElement("style");
  style.id = "local-system-inline-image-style";
  style.textContent = `
    .local-system-inline-image {
      margin: 8px 0;
      width: 30%;
      max-width: 246px;
      min-width: 120px;
      aspect-ratio: 16 / 9;
      border-radius: 12px;
      overflow: hidden;
    }
    .local-system-inline-image[data-preview-kind="pdf"] {
      flex: 0 1 520px;
      width: min(100%, 520px);
      max-width: 520px;
      min-width: min(280px, 100%);
      height: 228px;
      aspect-ratio: auto;
      border: 1px solid color-mix(in srgb, currentColor 9%, transparent);
      background: color-mix(in srgb, currentColor 2.5%, transparent);
    }
    .local-system-inline-image-row {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px;
      width: 100%;
      margin: 8px 0;
      overflow: hidden;
    }
    .local-system-inline-image-row > .local-system-inline-image {
      margin: 0;
    }
    .local-system-inline-image-row:has(> .local-system-inline-image--image + .local-system-inline-image--image) > .local-system-inline-image--image:not(.local-system-inline-image--failed) {
      flex: 1 1 0;
      width: auto;
      min-width: 0;
      max-width: 246px;
    }
    .local-system-inline-image-row > .local-system-inline-image--failed {
      flex: 0 0 auto;
    }
    .local-system-inline-image__frame {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      border-radius: 12px;
      background: transparent;
      overflow: hidden;
    }
    .local-system-inline-file-path {
      border-radius: 4px;
      color: inherit;
      cursor: pointer;
      text-decoration: underline dotted color-mix(in srgb, currentColor 48%, transparent);
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    .local-system-inline-file-path:hover,
    .local-system-inline-file-path:focus-visible {
      background: color-mix(in srgb, currentColor 7%, transparent);
      outline: none;
      text-decoration-style: solid;
      text-decoration-color: var(--ls-ui-info);
    }
    .local-system-inline-file-path[data-resolve-state="ready"] {
      --ls-inline-file-accent: color-mix(in srgb, var(--ls-ui-warning) 84%, currentColor);
      color: var(--ls-inline-file-accent);
      text-decoration: none;
    }
    .local-system-inline-file-path[data-resolve-state="ready"]:hover,
    .local-system-inline-file-path[data-resolve-state="ready"]:focus-visible,
    .local-system-inline-file-path[data-resolve-state="ready"]:active {
      background: transparent;
      color: var(--ls-inline-file-accent);
      text-decoration: underline dotted var(--ls-inline-file-accent);
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    .local-system-inline-file-path[data-preview-error="true"]:hover::after,
    .local-system-inline-file-path[data-preview-error="true"]:focus-visible::after {
      content: "!";
      display: inline-grid;
      place-items: center;
      width: 16px;
      height: 16px;
      margin-left: 5px;
      border: 1px solid color-mix(in srgb, var(--ls-ui-warning) 52%, transparent);
      border-radius: 999px;
      background: color-mix(in srgb, var(--ls-ui-warning) 13%, var(--ls-ui-surface));
      color: var(--ls-ui-warning);
      font: 700 10px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      vertical-align: 1px;
    }
    .local-system-inline-image__status { padding: 6px 0; border: 0; opacity: .7; font-size: 12px; }
    .local-system-inline-image.local-system-inline-image--failed {
      width: auto;
      max-width: none;
      min-width: 0;
      height: auto;
      aspect-ratio: auto;
      border: 0;
      background: transparent;
      overflow: visible;
      margin: 4px 0;
    }
    .local-system-inline-image__error-marker {
      display: inline-grid;
      place-items: center;
      width: 20px;
      height: 20px;
      border: 1px solid color-mix(in srgb, var(--ls-ui-warning) 48%, transparent);
      border-radius: 999px;
      background: color-mix(in srgb, var(--ls-ui-warning) 13%, var(--ls-ui-surface));
      color: var(--ls-ui-warning);
      font: 700 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: help;
      user-select: none;
    }
    .local-system-inline-image__overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(0, 0, 0, .72);
      backdrop-filter: blur(3px);
    }
    .local-system-inline-image__modal-frame {
      display: block;
      width: min(94vw, 1500px);
      height: 92vh;
      border: 0;
      background: transparent;
    }
    .local-system-rail-actions {
      display: flex;
      order: 10;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
      height: 42px;
      pointer-events: none;
    }
    .local-system-rail-action {
      position: relative;
      box-sizing: border-box;
      margin: 0;
      pointer-events: auto;
    }
    .local-system-composer-rail {
      position: relative;
      z-index: 25;
      display: flex;
      align-items: flex-end;
      gap: 8px;
      width: 100%;
      height: 42px;
      margin: 0 auto 6px;
      overflow: visible;
      background: transparent !important;
      font: var(--ls-composer-font, 500 13px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      pointer-events: none;
    }
    .local-system-composer-rail:not(:has(> :not([hidden]))) {
      height: 0;
      margin-bottom: 0;
    }
    .local-system-composer-rail[data-local-system-ui-empty="true"] {
      height: 0;
      margin-bottom: 0;
    }
    [data-local-system-ui-pref-hidden="true"] {
      display: none !important;
    }
    html[data-local-system-hide-skills] .ls-skill-chip-group,
    html[data-local-system-hide-skills] .ls-skill-popover,
    html[data-local-system-hide-todos] .local-system-todos-host,
    html[data-local-system-hide-embedded-workspace] .local-system-file-workspace-host:not([data-local-system-force-visible="true"]),
    html[data-local-system-hide-annotations] [data-local-system-annotation-ui="true"] {
      display: none !important;
    }
    .local-system-todos-host {
      position: relative;
      order: 20;
      flex: 1 1 auto;
      min-width: 0;
      height: 40px;
      overflow: visible;
      pointer-events: none;
      background: transparent !important;
    }
    .local-system-todos-frame {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      display: block;
      width: 100%;
      height: 40px;
      border: 0;
      border-radius: 18px;
      background: transparent !important;
      overflow: hidden;
      pointer-events: auto;
      transition: height 100ms ease-out;
    }
    .local-system-skills-host {
      position: fixed;
      z-index: 2147483646;
      height: 0;
      background: transparent;
      pointer-events: none;
    }
    .local-system-skills-frame {
      position: absolute;
      left: 0;
      bottom: 0;
      display: block;
      width: 100%;
      height: 56px;
      border: 0;
      border-radius: 18px;
      background: transparent;
      overflow: hidden;
      pointer-events: auto;
      filter: drop-shadow(0 6px 18px rgba(0, 0, 0, .10));
    }
    .local-system-files-host {
      position: fixed;
      z-index: 2147483646;
      height: 0;
      background: transparent;
      pointer-events: none;
    }
    .local-system-files-frame {
      position: absolute;
      left: 0;
      bottom: 0;
      display: block;
      width: 100%;
      height: 56px;
      border: 0;
      border-radius: 18px;
      background: transparent;
      overflow: hidden;
      pointer-events: auto;
      filter: drop-shadow(0 6px 18px rgba(0, 0, 0, .10));
      transition: height 80ms ease-out;
    }
    .local-system-file-quick-open-host {
      position: fixed;
      z-index: 2147483647;
      top: max(42px, 10vh);
      left: 50%;
      width: min(720px, calc(100vw - 28px));
      height: 0;
      transform: translateX(-50%);
      background: transparent;
      pointer-events: none;
    }
    .local-system-file-quick-open-frame {
      display: block;
      width: 100%;
      height: 180px;
      border: 0;
      border-radius: 18px;
      background: transparent;
      pointer-events: auto;
    }
    .local-system-thread-notes-button[data-has-note="true"]::after {
      content: "";
      position: absolute;
      top: 5px;
      right: 5px;
      width: 5px;
      height: 5px;
      border-radius: 999px;
      background: currentColor;
      opacity: .55;
    }
    .local-system-thread-notes-button > * {
      opacity: 1 !important;
      color: inherit !important;
    }
    .local-system-thread-notes-button svg,
    .local-system-thread-notes-button span {
      opacity: 1 !important;
      color: inherit !important;
    }
    .local-system-thread-notes-button svg {
      width: var(--ls-ui-icon-size, 16px) !important;
      height: var(--ls-ui-icon-size, 16px) !important;
    }
    .local-system-thread-notes-popover {
      position: fixed;
      z-index: 2147483646;
      width: min(430px, calc(100vw - 24px));
      padding: 14px 58px 14px 16px;
      border: 0;
      border-radius: var(--ls-ui-radius-floating, 14px);
      background: var(--main-surface-primary, var(--ls-ui-surface));
      color: var(--text-primary, var(--ls-ui-text));
      box-shadow: var(--ls-ui-shadow-floating, 0 10px 30px rgba(0,0,0,.10));
      font: 13.5px/1.55 var(--ls-ui-font-family, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    }
    .local-system-thread-notes-popover:focus-within {
      box-shadow: var(--ls-ui-shadow-dialog, 0 18px 54px rgba(0,0,0,.14));
    }
    .local-system-thread-notes-popover[data-editing="false"] {
      padding-right: 16px;
    }
    .local-system-thread-notes-popover[hidden] {
      display: none !important;
    }
    .local-system-thread-notes-popover__status {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      clip-path: inset(50%);
    }
    .local-system-thread-notes-popover__status[data-error="true"] {
      display: none;
    }
    .local-system-thread-notes-popover__textarea {
      box-sizing: border-box;
      display: block;
      width: 100%;
      min-height: 150px;
      max-height: min(52vh, 420px);
      resize: none;
      overflow-y: hidden;
      margin: 0;
      padding: 4px 0;
      border: 0 !important;
      outline: none !important;
      box-shadow: none !important;
      background: transparent !important;
      color: inherit;
      font: 13.5px/22px inherit;
    }
    .local-system-thread-notes-popover__textarea:focus {
      border: 0 !important;
      outline: none !important;
      box-shadow: none !important;
    }
    .local-system-thread-notes-popover__textarea::placeholder {
      color: color-mix(in srgb, currentColor 45%, transparent);
    }
    .local-system-thread-notes-popover__preview {
      box-sizing: border-box;
      width: 100%;
      min-height: 54px;
      max-height: min(52vh, 420px);
      overflow-y: auto;
      padding: 2px 0 4px;
      outline: none;
      cursor: text;
      overflow-wrap: anywhere;
      font: 13.5px/1.55 inherit;
    }
    .local-system-thread-notes-popover__preview[hidden] {
      display: none !important;
    }
    .local-system-thread-notes-popover__preview > :first-child {
      margin-top: 0;
    }
    .local-system-thread-notes-popover__preview > :last-child {
      margin-bottom: 0;
    }
    .local-system-thread-notes-popover__preview h1,
    .local-system-thread-notes-popover__preview h2,
    .local-system-thread-notes-popover__preview h3,
    .local-system-thread-notes-popover__preview h4,
    .local-system-thread-notes-popover__preview h5,
    .local-system-thread-notes-popover__preview h6 {
      margin: .72em 0 .32em;
      font-weight: 650;
      line-height: 1.25;
    }
    .local-system-thread-notes-popover__preview h1 { font-size: 1.55em; }
    .local-system-thread-notes-popover__preview h2 { font-size: 1.35em; }
    .local-system-thread-notes-popover__preview h3 { font-size: 1.18em; }
    .local-system-thread-notes-popover__preview p {
      margin: .42em 0;
    }
    .local-system-thread-notes-popover__preview ul,
    .local-system-thread-notes-popover__preview ol {
      margin: .42em 0;
      padding-left: 1.55em;
    }
    .local-system-thread-notes-popover__preview ul {
      list-style: disc outside !important;
    }
    .local-system-thread-notes-popover__preview ol {
      list-style: decimal outside !important;
    }
    .local-system-thread-notes-popover__preview li {
      display: list-item !important;
      margin: .16em 0;
    }
    .local-system-thread-notes-popover__preview li::marker {
      color: currentColor;
      opacity: 1;
    }
    .local-system-thread-notes-popover__preview blockquote {
      margin: .55em 0;
      padding: .12em 0 .12em .72em;
      border-left: 3px solid color-mix(in srgb, currentColor 22%, transparent);
      opacity: .82;
    }
    .local-system-thread-notes-popover__preview code {
      padding: .08em .3em;
      border-radius: 5px;
      background: color-mix(in srgb, currentColor 7%, transparent);
      font: .92em/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .local-system-thread-notes-popover__preview pre {
      margin: .55em 0;
      padding: 9px 10px;
      overflow: auto;
      border-radius: 8px;
      background: color-mix(in srgb, currentColor 6%, transparent);
    }
    .local-system-thread-notes-popover__preview pre code {
      padding: 0;
      background: transparent;
      white-space: pre;
    }
    .local-system-thread-notes-popover__preview hr {
      margin: .8em 0;
      border: 0;
      border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    }
    .local-system-thread-notes-md-gap {
      height: .25em;
    }
    .local-system-thread-notes-popover__save {
      position: absolute;
      right: 10px;
      bottom: 10px;
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: var(--ls-ui-primary-bg);
      color: var(--ls-ui-primary-text);
      cursor: pointer;
    }
    .local-system-thread-notes-popover__save:hover:not(:disabled) {
      opacity: .86;
    }
    .local-system-thread-notes-popover__save:disabled {
      opacity: .28;
      cursor: default;
    }
    form[data-local-system-file-drop-state="ready"] {
      outline: 2px solid color-mix(in srgb, var(--ls-ui-info) 72%, transparent);
      outline-offset: 2px;
    }
    form[data-local-system-file-drop-state="loading"] {
      outline: 2px solid color-mix(in srgb, var(--ls-ui-info) 72%, transparent);
      outline-offset: 2px;
      animation: local-system-file-drop-pulse .8s ease-in-out infinite alternate;
    }
    form[data-local-system-file-drop-state="success"] {
      outline: 2px solid color-mix(in srgb, var(--ls-ui-success) 70%, transparent);
      outline-offset: 2px;
    }
    form[data-local-system-file-drop-state="error"] {
      outline: 2px solid color-mix(in srgb, var(--ls-ui-danger) 70%, transparent);
      outline-offset: 2px;
    }
    @keyframes local-system-file-drop-pulse { from { opacity:.78; } to { opacity:1; } }
    .local-system-file-workspace-host {
      position: relative;
      z-index: 30;
      flex: 0 0 476px;
      align-self: stretch;
      width: 476px;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: transparent;
      pointer-events: none;
    }
    .local-system-file-workspace-host[hidden] {
      display: none !important;
    }
    .local-system-file-workspace-host.local-system-file-workspace-resizing {
      transition: none !important;
    }
    .local-system-file-workspace-frame {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: transparent;
      pointer-events: auto;
    }
  `;
  document.documentElement.appendChild(style);
}
