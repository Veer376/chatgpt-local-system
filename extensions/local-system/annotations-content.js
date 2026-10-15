/* global chrome, document, Node, NodeFilter, requestAnimationFrame */

(() => {
  "use strict";

  const extensionRootUrl = extensionUrl("/");
  const EXTENSION_ORIGIN = extensionRootUrl ? new URL(extensionRootUrl).origin : "";
  const HIGHLIGHT_NAME = "local-system-annotations";
  const SERIALIZED_START = "[Annotations]";
  const SERIALIZED_END = "[/Annotations]";
  const LEGACY_SERIALIZED_START = "[Local System annotations]";
  const LEGACY_SERIALIZED_END = "[/Local System annotations]";
  const UI_ATTR = "data-local-system-annotation-ui";
  const COMPOSER_INSERT_CHUNK_SIZE = 6_000;
  const COMPOSER_INSERT_YIELD_THRESHOLD = 12_000;
  const ICONS = {
    annotations: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10M7 12h7M6 18l-3 2v-4.5A7 7 0 0 1 5 2h10a7 7 0 0 1 0 14H8.5L6 18Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
    sync: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M18.2 10A7 7 0 0 0 6.5 6.5L4 9M5.8 14A7 7 0 0 0 17.5 17.5L20 15"/></svg>',
  };
  const MESSAGE_ROLE_SELECTOR = '[data-message-author-role="assistant"], [data-message-author-role="user"], [data-message-author-role="tool"]';
  const MESSAGE_CONTAINER_SELECTOR = [
    'article[data-testid^="conversation-turn-"]',
    '[data-testid^="conversation-turn-"]',
    '[data-turn-id]',
    '[data-message-id]',
    MESSAGE_ROLE_SELECTOR,
    'article[data-turn]',
    'article',
  ].join(", ");

  function extensionUrl(path) {
    try {
      if (!chrome.runtime?.id) return "";
      return chrome.runtime.getURL(path);
    } catch {
      // Reloading an unpacked extension invalidates the old content-script
      // context until this tab refreshes. Leave the stale instance inert.
      return "";
    }
  }

  const state = {
    threadId: currentThreadId(),
    bound: false,
    annotations: [],
    fileAnnotations: [],
    selectionDraft: null,
    selectionButton: null,
    editorPopover: null,
    tooltip: null,
    markers: new Map(),
    composerChip: null,
    composerSyncButton: null,
    sendProgress: null,
    composerList: null,
    composerListPinned: false,
    composerListHideTimer: null,
    sending: false,
    bypassNextSend: false,
    loadSequence: 0,
    fileLoadSequence: 0,
    selectionCaptureTimer: null,
    composerEditor: null,
  };

  const composerContext = globalThis.LocalSystemComposerContext?.createComposerContext({
    getThreadId: () => state.threadId,
    bridgeRequest,
    skillRequest,
  });
  if (!composerContext) throw new Error("Local System composer context failed to load");

  injectStyle();
  installListeners();
  globalThis.LocalSystemApiRequest = bridgeRequest;
  globalThis.LocalSystemFileRequest = bridgeFileRequest;
  refreshTheme();
  loadAnnotations({ active: true });
  loadFileAnnotations({ active: true });
  composerContext.loadAttachedSkills({ active: true });
  composerContext.loadWorkspaceContext();
  renderAll();

  function installListeners() {
    globalThis.addEventListener("message", handleFileWorkspaceAnnotations);
    globalThis.addEventListener("local-system-skill-attach-request", composerContext.handleSkillAttachRequest);
    globalThis.addEventListener("local-system-project-picker-request", () => composerContext.showProjectPopover());
    globalThis.addEventListener("local-system-thread-changed", (event) => {
      const nextThreadId = String(event.detail?.threadId || currentThreadId());
      if (nextThreadId === state.threadId) return;
      state.threadId = nextThreadId;
      state.annotations = [];
      state.fileAnnotations = [];
      composerContext.resetThreadContext();
      state.bound = false;
      closeTransientUi();
      clearRenderedAnnotations();
      refreshTheme();
      void loadAnnotations({ active: true });
      void loadFileAnnotations({ active: true });
      void composerContext.loadAttachedSkills({ active: true });
      void composerContext.loadWorkspaceContext();
    });
    globalThis.addEventListener("local-system-binding-changed", () => {
      void loadAnnotations({ active: true });
      void loadFileAnnotations({ active: true });
      void composerContext.loadAttachedSkills({ active: true });
      void composerContext.loadWorkspaceContext();
    });
    globalThis.addEventListener("local-system-project-changed", () => {
      state.fileAnnotations = [];
      renderComposerChip();
      void loadFileAnnotations({ active: true });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        loadFileAnnotations({ active: false });
        composerContext.loadAttachedSkills({ active: false });
        composerContext.loadWorkspaceContext();
      }
    });

    document.addEventListener("pointerup", (event) => {
      if (isAnnotationUiTarget(event.target)) return;
      setTimeout(captureCurrentSelection, 0);
    }, true);

    document.addEventListener("selectionchange", () => {
      clearTimeout(state.selectionCaptureTimer);
      state.selectionCaptureTimer = setTimeout(captureCurrentSelection, 90);
    });

    document.addEventListener("pointerdown", (event) => {
      if (isAnnotationUiTarget(event.target)) return;
      hideSelectionButton();
      if (state.editorPopover && !state.editorPopover.contains(event.target)) closeEditorPopover();
      composerContext.handleOutsidePointerDown(event);
      if (state.composerList && !state.composerList.contains(event.target) && !state.composerChip?.contains(event.target)) {
        state.composerListPinned = false;
        hideComposerList();
      }
    }, true);

    document.addEventListener("keydown", (event) => {
      const editor = globalThis.LocalSystemSharedRuntime?.closestComposerEditor?.(event.target);
      if (!editor || !hasPromptAttachments() || event.isComposing) return;
      if (event.key !== "Enter" || event.shiftKey) return;
      if (composerHasPickerTrigger(editor)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sendWithAttachments(editor);
    }, true);

    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label^="Send"]');
      if (!button || !button.closest("form") || !hasPromptAttachments()) return;
      if (state.bypassNextSend) {
        state.bypassNextSend = false;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const editor = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
      if (editor) sendWithAttachments(editor, button);
    }, true);

    globalThis.addEventListener("scroll", scheduleGeometryRender, true);
    globalThis.addEventListener("resize", scheduleGeometryRender);

    const nativeSelectionObserver = new globalThis.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.target?.nodeType === Node.ELEMENT_NODE) enhanceNativeSelectionActions(mutation.target);
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) enhanceNativeSelectionActions(node);
        }
      }
      reconcileComposerSurface();
    });
    nativeSelectionObserver.observe(document.documentElement, { childList: true, subtree: true });
    enhanceNativeSelectionActions(document.documentElement);
    reconcileComposerSurface();
  }

  function reconcileComposerSurface() {
    const editor = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
    if (editor === state.composerEditor) return;
    state.composerEditor = editor || null;
    refreshTheme();
    renderComposerSyncButton();
    renderComposerChip();
    composerContext.render();
    if (state.composerList) showComposerList(state.composerListPinned);
  }

  function enhanceNativeSelectionActions(root) {
    const selector = "div.shadow-long.flex.overflow-hidden.rounded-xl";
    const candidates = new Set();
    if (root.matches?.(selector)) candidates.add(root);
    const closest = root.closest?.(selector);
    if (closest) candidates.add(closest);
    if (root.querySelectorAll) {
      for (const candidate of root.querySelectorAll(selector)) candidates.add(candidate);
    }

    for (const candidate of candidates) {
      const buttons = [...candidate.children].filter((child) => child.tagName === "BUTTON");
      const byLabel = new Map(buttons.map((button) => [normalizedButtonLabel(button), button]));
      const askButton = byLabel.get("Ask ChatGPT");
      if (!askButton || !byLabel.has("Start writing") || !byLabel.has("Share highlighted")) continue;

      if (candidate.dataset.localSystemHidden === "selection-actions") {
        delete candidate.dataset.localSystemHidden;
        candidate.style.removeProperty("display");
      }

      let annotateButton = candidate.querySelector(':scope > button[data-local-system-native-annotate="true"]');
      if (!annotateButton) {
        annotateButton = document.createElement("button");
        annotateButton.type = "button";
        annotateButton.className = askButton.className;
        annotateButton.classList.add("ls-native-selection-annotate");
        annotateButton.dataset.localSystemNativeAnnotate = "true";
        annotateButton.setAttribute(UI_ATTR, "true");
        annotateButton.setAttribute("aria-label", "Annotate highlighted text");
        annotateButton.title = "Annotate highlighted text";
        annotateButton.textContent = "Annotate";
        annotateButton.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        annotateButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          captureCurrentSelection();
          const draft = state.selectionDraft;
          if (draft) openEditorPopover({ source: draft.source, range: draft.range });
          hideSelectionButton();
        });
      }

      if (annotateButton.nextElementSibling !== askButton) candidate.insertBefore(annotateButton, askButton);
      candidate.dataset.localSystemSelectionActions = "enhanced";
    }
  }

  function normalizedButtonLabel(button) {
    return String(button?.textContent || "").replace(/\s+/g, " ").trim();
  }

  let geometryFrame = null;
  function scheduleGeometryRender() {
    if (geometryFrame != null) return;
    geometryFrame = requestAnimationFrame(() => {
      geometryFrame = null;
      renderMarkersAndHighlights();
      positionComposerList();
      composerContext.positionTransientUi();
    });
  }

  async function loadAnnotations({ active = false } = {}) {
    if (!state.threadId) return false;
    const sequence = ++state.loadSequence;
    try {
      const payload = await requestAnnotations({ action: "list", active });
      if (sequence !== state.loadSequence) return false;
      state.bound = payload.bound === true;
      state.annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
      renderAll();
      return true;
    } catch {
      // Keep the last local view if the loopback bridge briefly disappears.
      return false;
    }
  }

  async function loadFileAnnotations({ active = false } = {}) {
    if (!state.threadId) return false;
    const sequence = ++state.fileLoadSequence;
    try {
      const payload = await bridgeRequest("/local-ui/file-workspace", {
        threadId: state.threadId,
        action: "get",
        active,
      });
      if (sequence !== state.fileLoadSequence) return false;
      state.fileAnnotations = Array.isArray(payload.workspace?.annotations)
        ? payload.workspace.annotations
        : [];
      renderComposerChip();
      if (state.composerList) showComposerList(state.composerListPinned);
      return true;
    } catch {
      // Preserve the last known file annotation state during brief bridge interruptions.
      return false;
    }
  }







  async function requestAnnotations(body) {
    return bridgeRequest("/local-ui/annotations", { threadId: state.threadId, ...body });
  }

  async function skillRequest(body) {
    return bridgeRequest("/local-ui/skills", { threadId: state.threadId, ...body });
  }

  function handleFileWorkspaceAnnotations(event) {
    if (!EXTENSION_ORIGIN) return;
    if (event.origin !== EXTENSION_ORIGIN) return;
    if (event.data?.source !== "local-system-file-workspace" || event.data.action !== "annotations-state") return;
    state.fileAnnotations = Array.isArray(event.data.annotations)
      ? event.data.annotations.filter((item) => item && typeof item === "object" && typeof item.path === "string")
      : [];
    renderComposerChip();
    if (state.composerList) showComposerList(state.composerListPinned);
  }

  async function bridgeRequest(path, body) {
    const api = globalThis.LocalSystemExtensionApi;
    if (!api?.request) throw new Error("Local System extension API unavailable");
    return api.request(path, body, { timeoutMs: 10_000 });
  }

  async function bridgeFileRequest(body) {
    const descriptor = await bridgeRequest("/local-ui/files/resolve", body);
    const url = String(descriptor?.url || "");
    if (!url) throw new Error("Local System did not return a file URL");
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Could not read local file (HTTP ${response.status})`);
    const buffer = await response.arrayBuffer();
    return {
      name: String(descriptor?.name || "file"),
      path: String(descriptor?.path || ""),
      mimeType: String(descriptor?.mimeType || "application/octet-stream"),
      bytes: buffer.byteLength,
      lastModified: Number(descriptor?.lastModified) || Date.now(),
      buffer,
    };
  }

  function captureCurrentSelection() {
    const selection = globalThis.getSelection?.();
    if (!selection?.rangeCount || selection.isCollapsed) return hideSelectionButton();
    const range = selection.getRangeAt(0);
    const text = range.toString();
    if (!text.trim()) return hideSelectionButton();

    const startElement = elementForNode(range.startContainer);
    const endElement = elementForNode(range.endContainer);
    if (
      !startElement
      || !endElement
      || globalThis.LocalSystemSharedRuntime?.closestComposerEditor?.(startElement)
      || globalThis.LocalSystemSharedRuntime?.closestComposerEditor?.(endElement)
      || isAnnotationUiTarget(startElement)
      || isAnnotationUiTarget(endElement)
    ) {
      return hideSelectionButton();
    }

    const segments = selectionSegmentsForRange(range);
    if (!segments?.length) return hideSelectionButton();
    const quote = segments.map((segment) => segment.source.quote).join("\n");
    if (!quote.trim() || quote.length > 4_000) return hideSelectionButton();

    const first = segments[0].source;
    const last = segments.at(-1).source;
    const source = segments.length === 1
      ? first
      : {
          ...first,
          quote,
          prefix: first.prefix,
          suffix: last.suffix,
          segments: segments.map((segment) => segment.source),
        };

    state.selectionDraft = {
      source,
      range: range.cloneRange(),
    };
    showSelectionButton(range, selection);
  }

  function showSelectionButton(range, selection = globalThis.getSelection?.()) {
    hideSelectionButton();
    const rect = selectionFocusRect(selection, range) || lastUsefulRect(range);
    if (!rect) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ls-annotation-add btn btn-secondary";
    button.setAttribute(UI_ATTR, "true");
    button.textContent = "Annotate";
    button.style.left = `${Math.max(8, Math.min(globalThis.innerWidth - 94, rect.right + 8))}px`;
    button.style.top = `${Math.max(8, rect.top - 4)}px`;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const draft = state.selectionDraft;
      if (draft) openEditorPopover({ source: draft.source, range: draft.range });
      hideSelectionButton();
    });
    document.documentElement.appendChild(button);
    state.selectionButton = button;
  }

  function selectionSegmentsForRange(range) {
    const roots = selectionTextRoots();
    const segments = [];
    const roles = new Set();
    for (const root of roots) {
      if (!rangeIntersectsNode(range, root)) continue;
      const message = findMessageContainer(root);
      if (!message) continue;
      const role = messageRole(message);
      if (role === "tool") continue;
      const clipped = clippedRangeForRoot(range, root);
      if (!clipped) continue;
      const offsets = offsetsForRange(root, clipped);
      if (!offsets) continue;
      const fullText = root.textContent || "";
      const quote = fullText.slice(offsets.start, offsets.end);
      if (!quote.trim()) continue;
      roles.add(role);
      const textRootIndex = Math.max(0, messageTextRoots(message).indexOf(root));
      segments.push({
        range: clipped,
        source: {
          messageKey: messageKeyFor(message),
          role,
          textRootIndex,
          quote,
          prefix: fullText.slice(Math.max(0, offsets.start - 180), offsets.start),
          suffix: fullText.slice(offsets.end, offsets.end + 180),
          start: offsets.start,
          end: offsets.end,
        },
      });
      if (segments.length > 24) return null;
    }
    if (!segments.length || roles.size !== 1) return null;
    return segments;
  }

  function selectionTextRoots() {
    const roots = new Set();
    for (const message of allMessageContainers()) {
      for (const root of messageTextRoots(message)) {
        if (root?.closest?.("main")) roots.add(root);
      }
    }
    return [...roots].sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function rangeIntersectsNode(range, node) {
    try {
      return range.intersectsNode(node);
    } catch {
      return false;
    }
  }

  function clippedRangeForRoot(selectionRange, root) {
    try {
      const clipped = document.createRange();
      clipped.selectNodeContents(root);
      if (root.contains(selectionRange.startContainer)) {
        clipped.setStart(selectionRange.startContainer, selectionRange.startOffset);
      }
      if (root.contains(selectionRange.endContainer)) {
        clipped.setEnd(selectionRange.endContainer, selectionRange.endOffset);
      }
      if (clipped.collapsed || !clipped.toString().trim()) return null;
      return clipped;
    } catch {
      return null;
    }
  }

  function selectionFocusRect(selection, range) {
    if (!selection?.focusNode) return null;
    try {
      const caret = document.createRange();
      caret.setStart(selection.focusNode, selection.focusOffset);
      caret.collapse(true);
      const rects = [...caret.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
      const caretRect = rects.at(-1) || caret.getBoundingClientRect?.();
      if (caretRect && (caretRect.width > 0 || caretRect.height > 0)) return caretRect;
    } catch {
      // Fall through to the selection direction based rect below.
    }
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
    if (!rects.length) return null;
    return selectionIsBackward(selection) ? rects[0] : rects.at(-1);
  }

  function selectionIsBackward(selection) {
    if (!selection?.anchorNode || !selection.focusNode) return false;
    if (selection.anchorNode === selection.focusNode) return selection.anchorOffset > selection.focusOffset;
    const position = selection.anchorNode.compareDocumentPosition(selection.focusNode);
    return Boolean(position & Node.DOCUMENT_POSITION_PRECEDING);
  }

  function hideSelectionButton() {
    state.selectionButton?.remove();
    state.selectionButton = null;
  }

  function openEditorPopover({ annotation = null, source = null, range = null } = {}) {
    closeEditorPopover();
    const popover = document.createElement("div");
    popover.className = "ls-annotation-editor";
    if (annotation) popover.classList.add("ls-annotation-editor--editing");
    popover.setAttribute(UI_ATTR, "true");

    const textarea = document.createElement("textarea");
    textarea.className = "ls-annotation-editor__input";
    textarea.placeholder = "Add a comment…";
    textarea.value = annotation?.comment || "";
    textarea.rows = 1;

    const save = document.createElement("button");
    save.type = "button";
    save.className = "ls-annotation-editor__save";
    save.setAttribute("aria-label", annotation ? "Save annotation" : "Add annotation");
    save.title = annotation ? "Save annotation" : "Add annotation";
    save.innerHTML = ICONS.check;
    save.addEventListener("click", () => saveEditorAnnotation({ annotation, source, textarea, save }));

    if (annotation) {
      const actions = document.createElement("div");
      actions.className = "ls-annotation-editor__actions";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ls-annotation-editor__delete";
      remove.setAttribute("aria-label", "Delete annotation");
      remove.title = "Delete annotation";
      remove.innerHTML = ICONS.trash;
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        await deleteAnnotation(annotation.id);
        closeEditorPopover();
      });

      const spacer = document.createElement("span");
      spacer.className = "ls-annotation-editor__spacer";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ls-annotation-editor__cancel";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", closeEditorPopover);

      actions.append(remove, spacer, cancel, save);
      popover.append(textarea, actions);
    } else {
      popover.append(textarea, save);
    }
    document.documentElement.appendChild(popover);
    state.editorPopover = popover;
    positionEditorPopover(popover, range || rangeForAnnotation(annotation));
    resizeEditorTextarea(textarea);
    textarea.addEventListener("input", () => resizeEditorTextarea(textarea));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditorPopover();
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        save.click();
      }
    });
    requestAnimationFrame(() => textarea.focus());
  }

  function resizeEditorTextarea(textarea) {
    textarea.style.height = "36px";
    const next = Math.min(150, Math.max(36, textarea.scrollHeight));
    textarea.style.height = `${next}px`;
    textarea.style.overflowY = textarea.scrollHeight > 150 ? "auto" : "hidden";
  }

  async function saveEditorAnnotation({ annotation, source, textarea, save }) {
    const comment = textarea.value.trim();
    if (!comment) {
      textarea.focus();
      return;
    }
    save.disabled = true;
    try {
      const payload = await requestAnnotations({
        action: "upsert",
        active: true,
        annotation: {
          ...(annotation?.id ? { id: annotation.id } : {}),
          comment,
          source: annotation?.source || source,
        },
      });
      state.bound = payload.bound === true;
      state.annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
      closeEditorPopover();
      clearSelection();
      renderAll();
      focusComposerAfterAnnotation();
    } catch (error) {
      save.disabled = false;
      textarea.setCustomValidity(error instanceof Error ? error.message : String(error));
      textarea.reportValidity();
      textarea.setCustomValidity("");
    }
  }

  function focusComposerAfterAnnotation() {
    requestAnimationFrame(() => {
      const editor = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
      if (!editor?.isConnected) return;
      try {
        editor.focus({ preventScroll: true });
      } catch {
        editor.focus();
      }
      const selection = globalThis.getSelection?.();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  }

  async function deleteAnnotation(id) {
    const payload = await requestAnnotations({ action: "delete", id, active: true });
    state.annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
    renderAll();
  }

  async function clearAnnotations() {
    const payload = await requestAnnotations({ action: "clear", active: true });
    state.annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
    renderAll();
  }

  async function deleteFileAnnotation(id) {
    const payload = await bridgeRequest("/local-ui/file-workspace", {
      threadId: state.threadId,
      action: "delete_annotation",
      id,
      active: true,
    });
    state.fileAnnotations = Array.isArray(payload.workspace?.annotations) ? payload.workspace.annotations : [];
    renderComposerChip();
    globalThis.dispatchEvent(new CustomEvent("local-system-file-annotations-refresh"));
  }

  async function clearFileAnnotations() {
    const payload = await bridgeRequest("/local-ui/file-workspace", {
      threadId: state.threadId,
      action: "clear_annotations",
      active: true,
    });
    state.fileAnnotations = Array.isArray(payload.workspace?.annotations) ? payload.workspace.annotations : [];
    globalThis.dispatchEvent(new CustomEvent("local-system-file-annotations-refresh"));
  }

  async function clearAllAnnotations() {
    await Promise.allSettled([
      clearAnnotations(),
      clearFileAnnotations(),
    ]);
    renderAll();
  }

  function totalAnnotationCount() {
    return state.annotations.length + state.fileAnnotations.length;
  }

  function hasPromptAttachments() {
    return totalAnnotationCount() > 0 || composerContext.hasPromptContext();
  }

  function closeEditorPopover() {
    state.editorPopover?.remove();
    state.editorPopover = null;
  }

  function positionEditorPopover(popover, range) {
    const rect = range ? lastUsefulRect(range) : null;
    const width = 420;
    const left = rect ? Math.max(8, Math.min(globalThis.innerWidth - width - 8, rect.left)) : Math.max(8, (globalThis.innerWidth - width) / 2);
    const preferBelow = rect ? rect.bottom + 190 < globalThis.innerHeight : true;
    popover.style.left = `${Math.round(left)}px`;
    if (rect && !preferBelow) {
      popover.style.top = "auto";
      popover.style.bottom = `${Math.round(globalThis.innerHeight - rect.top + 8)}px`;
    } else {
      popover.style.bottom = "auto";
      popover.style.top = `${Math.round(rect ? rect.bottom + 8 : 80)}px`;
    }
  }

  function renderAll() {
    renderMarkersAndHighlights();
    renderComposerSyncButton();
    renderComposerChip();
    composerContext.render();
  }

  function renderComposerSyncButton() {
    const editor = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
    if (!editor) {
      state.composerSyncButton?.remove();
      state.composerSyncButton = null;
      composerContext.cleanupComposerRail();
      return;
    }

    let button = state.composerSyncButton;
    if (!button) {
      button = globalThis.LocalSystemSharedRuntime?.ComposerIconButton?.({
        className: "ls-annotation-sync-button",
        label: "Sync annotations",
        order: 1000,
        icon: ICONS.sync,
      });
      if (!button) return;
      button.setAttribute(UI_ATTR, "true");
      button.title = "Sync annotations from this thread";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void syncComposerAnnotations();
      });
      state.composerSyncButton = button;
    }
    button.className = "composer-icon-button local-system-rail-action ls-annotation-sync-button";
    button.style.order = "1000";

    const rail = composerContext.ensureComposerRail(editor);
    if (rail && (button.parentElement !== rail || rail.lastElementChild !== button)) rail.appendChild(button);
  }

  async function syncComposerAnnotations() {
    const button = state.composerSyncButton;
    if (!button || button.disabled) return;
    button.disabled = true;
    button.classList.add("is-syncing");
    button.title = "Syncing annotations…";
    const [textSynced, fileSynced] = await Promise.all([
      loadAnnotations({ active: true }),
      loadFileAnnotations({ active: true }),
    ]);
    button.classList.remove("is-syncing");
    if (textSynced || fileSynced) {
      button.classList.add("is-success");
      button.innerHTML = ICONS.check;
      const total = totalAnnotationCount();
      button.title = `Synced ${total} annotation${total === 1 ? "" : "s"}`;
      setTimeout(() => {
        if (!button.isConnected) return;
        button.classList.remove("is-success");
        button.innerHTML = ICONS.sync;
        button.title = "Sync annotations from this thread";
      }, 1_200);
    } else {
      button.title = "Annotation sync failed";
      setTimeout(() => {
        if (button.isConnected) button.title = "Sync annotations from this thread";
      }, 1_500);
    }
    button.disabled = false;
  }








  function renderMarkersAndHighlights() {
    clearHighlight();
    if (!state.annotations.length) {
      for (const marker of state.markers.values()) marker.remove();
      state.markers.clear();
      return;
    }

    const ranges = [];
    const activeIds = new Set();
    state.annotations.forEach((annotation, index) => {
      const annotationRanges = rangesForAnnotation(annotation);
      if (!annotationRanges.length) return;
      ranges.push(...annotationRanges);
      const range = annotationRanges.at(-1);
      const rect = lastUsefulRect(range);
      if (!rect || rect.width === 0 && rect.height === 0) return;
      activeIds.add(annotation.id);
      let marker = state.markers.get(annotation.id);
      if (!marker) {
        marker = document.createElement("button");
        marker.type = "button";
        marker.className = "ls-annotation-marker";
        marker.setAttribute(UI_ATTR, "true");
        marker.dataset.annotationId = annotation.id;
        marker.addEventListener("mouseenter", () => {
          const current = annotationById(marker.dataset.annotationId);
          if (current) showTooltip(marker, current);
        });
        marker.addEventListener("mouseleave", hideTooltip);
        marker.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          hideTooltip();
          const current = annotationById(marker.dataset.annotationId);
          if (current) openEditorPopover({ annotation: current, range: rangeForAnnotation(current) });
        });
        document.documentElement.appendChild(marker);
        state.markers.set(annotation.id, marker);
      }
      marker.textContent = String(index + 1);
      marker.setAttribute("aria-label", `Open annotation ${index + 1}`);
      marker.style.left = `${Math.max(4, Math.min(globalThis.innerWidth - 34, rect.right - 9))}px`;
      marker.style.top = `${Math.max(4, rect.top - 18)}px`;
    });
    for (const [id, marker] of state.markers) {
      if (activeIds.has(id)) continue;
      marker.remove();
      state.markers.delete(id);
    }
    applyHighlight(ranges);
  }

  function applyHighlight(ranges) {
    if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== "function") return;
    if (!ranges.length) return;
    globalThis.CSS.highlights.set(HIGHLIGHT_NAME, new globalThis.Highlight(...ranges));
  }

  function clearHighlight() {
    globalThis.CSS?.highlights?.delete?.(HIGHLIGHT_NAME);
  }

  function clearRenderedAnnotations() {
    for (const marker of state.markers.values()) marker.remove();
    state.markers.clear();
    clearHighlight();
    state.composerChip?.remove();
    state.composerChip = null;
    hideComposerList();
  }

  function showTooltip(marker, annotation) {
    hideTooltip();
    const tooltip = document.createElement("div");
    tooltip.className = "ls-annotation-tooltip";
    tooltip.setAttribute(UI_ATTR, "true");
    const quote = document.createElement("div");
    quote.className = "ls-annotation-tooltip__quote";
    quote.textContent = `“${compact(annotation.source?.quote, 120)}”`;
    const comment = document.createElement("div");
    comment.className = "ls-annotation-tooltip__comment";
    comment.textContent = annotation.comment;
    tooltip.append(quote, comment);
    document.documentElement.appendChild(tooltip);
    const rect = marker.getBoundingClientRect();
    const width = 300;
    tooltip.style.left = `${Math.max(8, Math.min(globalThis.innerWidth - width - 8, rect.left - 8))}px`;
    tooltip.style.top = `${Math.max(8, rect.bottom + 6)}px`;
    state.tooltip = tooltip;
  }

  function hideTooltip() {
    state.tooltip?.remove();
    state.tooltip = null;
  }

  function renderComposerChip() {
    const editor = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
    const total = totalAnnotationCount();
    if (!editor || !total) {
      state.composerChip?.remove();
      state.composerChip = null;
      composerContext.cleanupComposerRail();
      hideComposerList();
      return;
    }

    let chip = state.composerChip;
    if (!chip) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ls-annotation-composer-chip";
      chip.setAttribute(UI_ATTR, "true");
      chip.addEventListener("mouseenter", () => showComposerList(false));
      chip.addEventListener("mouseleave", scheduleComposerListHide);
      chip.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.composerListPinned = !state.composerListPinned;
        if (state.composerListPinned) showComposerList(true);
        else hideComposerList();
      });
      state.composerChip = chip;
    }
    chip.replaceChildren();
    const chipIcon = document.createElement("span");
    chipIcon.className = "ls-annotation-chip-icon";
    chipIcon.innerHTML = ICONS.annotations;
    const chipCount = document.createElement("span");
    chipCount.className = "ls-annotation-chip-count";
    chipCount.textContent = String(total);
    chip.append(chipIcon, chipCount);
    chip.setAttribute("aria-label", `${total} annotation${total === 1 ? "" : "s"}`);
    chip.title = `${total} annotation${total === 1 ? "" : "s"}`;

    const rail = composerContext.ensureComposerRail(editor);
    if (rail && (chip.parentElement !== rail || rail.firstElementChild !== chip)) {
      rail.insertBefore(chip, rail.firstElementChild);
    }
  }








  function showAttachmentSendProgress(editor, label = "Preparing…") {
    const rail = composerContext.ensureComposerRail(editor);
    if (!rail) return;
    let indicator = state.sendProgress;
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "ls-send-progress";
      indicator.setAttribute(UI_ATTR, "true");
      const spinner = document.createElement("span");
      spinner.className = "ls-send-progress__spinner";
      const text = document.createElement("span");
      text.className = "ls-send-progress__label";
      indicator.append(spinner, text);
      state.sendProgress = indicator;
    }
    indicator.querySelector(".ls-send-progress__label").textContent = label;
    if (indicator.parentElement !== rail) rail.insertBefore(indicator, rail.firstElementChild);
  }

  function hideAttachmentSendProgress() {
    state.sendProgress?.remove();
    state.sendProgress = null;
    composerContext.cleanupComposerRail();
  }

  function waitForComposerPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function showComposerList(pin) {
    clearTimeout(state.composerListHideTimer);
    if (pin) state.composerListPinned = true;
    let list = state.composerList;
    if (!list) {
      list = document.createElement("div");
      list.className = "ls-annotation-composer-list";
      list.setAttribute(UI_ATTR, "true");
      list.addEventListener("mouseenter", () => clearTimeout(state.composerListHideTimer));
      list.addEventListener("mouseleave", scheduleComposerListHide);
      document.documentElement.appendChild(list);
      state.composerList = list;
    }
    list.replaceChildren();

    const header = document.createElement("div");
    header.className = "ls-annotation-composer-list__header";
    const title = document.createElement("span");
    const total = totalAnnotationCount();
    title.textContent = `${total} annotation${total === 1 ? "" : "s"}`;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "ls-annotation-icon-button ls-annotation-icon-button--small";
    copy.setAttribute("aria-label", "Copy all annotations");
    copy.title = "Copy all annotations";
    copy.innerHTML = ICONS.copy;
    copy.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await copyText(serializedAnnotationsBlock());
      copy.classList.add("is-success");
      copy.innerHTML = ICONS.check;
      setTimeout(() => {
        copy.classList.remove("is-success");
        copy.innerHTML = ICONS.copy;
      }, 1_200);
    });
    header.append(title, copy);
    list.appendChild(header);

    state.annotations.forEach((annotation, index) => {
      const row = document.createElement("div");
      row.className = "ls-annotation-composer-list__row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ls-annotation-composer-list__open";
      const badge = document.createElement("span");
      badge.className = "ls-annotation-list-number";
      badge.innerHTML = ICONS.annotations;
      const body = document.createElement("span");
      body.className = "ls-annotation-list-body";
      const comment = document.createElement("span");
      comment.className = "ls-annotation-list-comment";
      comment.textContent = annotation.comment;
      const quote = document.createElement("span");
      quote.className = "ls-annotation-list-quote";
      quote.textContent = compact(annotation.source?.quote, 140);
      body.append(comment, quote);
      open.append(badge, body);
      open.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.composerListPinned = false;
        hideComposerList();
        const range = rangeForAnnotation(annotation);
        openEditorPopover({ annotation, range });
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ls-annotation-row-delete";
      remove.setAttribute("aria-label", `Delete annotation ${index + 1}`);
      remove.title = "Delete annotation";
      remove.innerHTML = ICONS.trash;
      remove.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        remove.disabled = true;
        await deleteAnnotation(annotation.id);
        if (state.annotations.length) showComposerList(state.composerListPinned);
        else hideComposerList();
      });
      row.append(open, remove);
      list.appendChild(row);
    });

    state.fileAnnotations.forEach((annotation) => {
      const row = document.createElement("div");
      row.className = "ls-annotation-composer-list__row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ls-annotation-composer-list__open";
      open.title = `Open ${annotation.path}`;
      const badge = document.createElement("span");
      badge.className = "ls-annotation-list-number";
      badge.innerHTML = ICONS.annotations;
      const body = document.createElement("span");
      body.className = "ls-annotation-list-body";
      const comment = document.createElement("span");
      comment.className = "ls-annotation-list-comment";
      comment.textContent = annotation.comment;
      const quote = document.createElement("span");
      quote.className = "ls-annotation-list-quote";
      const lineLabel = annotation.start?.line ? `L${annotation.start.line}${annotation.end?.line && annotation.end.line !== annotation.start.line ? `–${annotation.end.line}` : ""}` : "file";
      quote.textContent = `${basename(annotation.path)} · ${lineLabel} · ${compact(annotation.quote, 100)}`;
      body.append(comment, quote);
      open.append(badge, body);
      open.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.composerListPinned = false;
        hideComposerList();
        const startOffset = Number(annotation.start?.offset);
        const endOffset = Number(annotation.end?.offset);
        globalThis.dispatchEvent(new CustomEvent("local-system-open-file", {
          detail: {
            source: "annotation",
            path: annotation.path,
            line: Number(annotation.start?.line) || null,
            column: Number(annotation.start?.column) || null,
            length: Number.isFinite(startOffset) && Number.isFinite(endOffset)
              ? Math.max(0, endOffset - startOffset)
              : null,
          },
        }));
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ls-annotation-row-delete";
      remove.setAttribute("aria-label", "Delete file annotation");
      remove.title = "Delete annotation";
      remove.innerHTML = ICONS.trash;
      remove.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        remove.disabled = true;
        await deleteFileAnnotation(annotation.id);
        if (totalAnnotationCount()) showComposerList(state.composerListPinned);
        else hideComposerList();
      });
      row.append(open, remove);
      list.appendChild(row);
    });

    const footer = document.createElement("div");
    footer.className = "ls-annotation-composer-list__footer";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "ls-annotation-icon-button ls-annotation-icon-button--small ls-annotation-icon-button--danger";
    clear.setAttribute("aria-label", "Clear all annotations");
    clear.title = "Clear all annotations";
    clear.innerHTML = ICONS.trash;
    clear.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await clearAllAnnotations();
      state.composerListPinned = false;
      hideComposerList();
    });
    footer.appendChild(clear);
    list.appendChild(footer);
    positionComposerList();
  }

  function scheduleComposerListHide() {
    clearTimeout(state.composerListHideTimer);
    if (state.composerListPinned) return;
    state.composerListHideTimer = setTimeout(hideComposerList, 180);
  }

  function hideComposerList() {
    state.composerList?.remove();
    state.composerList = null;
  }

  function positionComposerList() {
    if (!state.composerList || !state.composerChip?.isConnected) return;
    const rect = state.composerChip.getBoundingClientRect();
    const width = Math.min(440, Math.max(320, rect.width + 220));
    state.composerList.style.width = `${width}px`;
    state.composerList.style.left = `${Math.max(8, Math.min(globalThis.innerWidth - width - 8, rect.left))}px`;
    state.composerList.style.bottom = `${Math.max(8, globalThis.innerHeight - rect.top + 6)}px`;
  }

  async function sendWithAttachments(editor, sendButton = null) {
    if (state.sending || !hasPromptAttachments()) return;
    state.sending = true;
    closeTransientUi();
    showAttachmentSendProgress(editor, "Preparing…");
    await waitForComposerPaint();
    const skillsBlock = composerContext.serializedSkillsBlock();
    const original = composerContext.stripSerializedSkillBlock(
      stripSerializedBlock(editor.innerText || editor.textContent || ""),
      skillsBlock,
    );
    const parts = [];
    if (totalAnnotationCount()) parts.push(serializedAnnotationsBlock());
    if (original.trim()) parts.push(original.trimEnd());
    if (skillsBlock) parts.push(skillsBlock);
    const combined = parts.join("\n\n").trimEnd();
    await replaceComposerTextCooperatively(editor, combined);

    const button = sendButton || findSendButton();
    const liveButton = await waitForEnabledSendButton(button, 1_500);
    if (!liveButton) {
      await replaceComposerTextCooperatively(editor, original);
      hideAttachmentSendProgress();
      state.sending = false;
      return;
    }

    showAttachmentSendProgress(editor, "Sending…");
    state.bypassNextSend = true;
    liveButton.click();
    const sent = await waitForComposerClear(editor, 5_000);
    hideAttachmentSendProgress();
    if (sent) {
      state.annotations = [];
      state.fileAnnotations = [];
      renderAll();
      try {
        await Promise.allSettled([
          requestAnnotations({ action: "clear", active: true }),
          composerContext.clearAttachedSkills(),
          bridgeRequest("/local-ui/file-workspace", {
            threadId: state.threadId,
            action: "clear_annotations",
            active: true,
          }),
        ]);
        globalThis.dispatchEvent(new CustomEvent("local-system-file-annotations-refresh"));
      } catch {
        // ChatGPT already accepted the send. Keep the local draft cleared rather
        // than surfacing a duplicate queue because the loopback bridge vanished.
      }
    } else {
      await replaceComposerTextCooperatively(editor, original);
    }
    state.sending = false;
  }

  function serializedAnnotationsBlock() {
    const lines = [SERIALIZED_START];
    state.annotations.forEach((annotation) => {
      lines.push(`- Selected text: ${JSON.stringify(annotation.source?.quote || "")}`);
      lines.push(`  Comment: ${annotation.comment}`);
    });
    state.fileAnnotations.forEach((annotation) => {
      const start = annotation.start || {};
      const end = annotation.end || {};
      const location = start.line
        ? `lines ${start.line}:${start.column || 1}${end.line ? `-${end.line}:${end.column || 1}` : ""}`
        : "selected text";
      lines.push(`- File: ${JSON.stringify(annotation.path)} (${location})`);
      lines.push(`  Selected text: ${JSON.stringify(annotation.quote || "")}`);
      lines.push(`  Comment: ${annotation.comment}`);
    });
    lines.push(SERIALIZED_END);
    return lines.join("\n");
  }






  function stripSerializedBlock(text) {
    const value = String(text || "");
    for (const [startToken, endToken] of [
      [SERIALIZED_START, SERIALIZED_END],
      [LEGACY_SERIALIZED_START, LEGACY_SERIALIZED_END],
    ]) {
      const start = value.indexOf(startToken);
      const end = value.indexOf(endToken);
      if (start >= 0 && end >= start) {
        return `${value.slice(0, start)}${value.slice(end + endToken.length)}`.replace(/^\s+/, "");
      }
    }
    return value;
  }

  function basename(value) {
    return String(value || "").split(/[\\/]/).pop() || String(value || "");
  }

  function replaceComposerText(editor, text) {
    editor.focus();
    const selection = globalThis.getSelection?.();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, text);
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    selection.removeAllRanges();
    selection.addRange(end);
    return true;
  }

  async function replaceComposerTextCooperatively(editor, text) {
    const value = String(text || "");
    if (value.length <= COMPOSER_INSERT_YIELD_THRESHOLD) return replaceComposerText(editor, value);

    editor.focus();
    const selection = globalThis.getSelection?.();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    const chunks = composerTextChunks(value);
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) placeComposerCaretAtEnd(editor, selection);
      document.execCommand("insertText", false, chunks[index]);
      if (index < chunks.length - 1) await nextComposerFrame();
    }
    placeComposerCaretAtEnd(editor, selection);
    return true;
  }

  function composerTextChunks(text, chunkSize = COMPOSER_INSERT_CHUNK_SIZE) {
    const value = String(text || "");
    const size = Math.max(1, Number(chunkSize) || COMPOSER_INSERT_CHUNK_SIZE);
    const chunks = [];
    let start = 0;
    while (start < value.length) {
      let end = Math.min(value.length, start + size);
      if (end < value.length) {
        const previous = value.charCodeAt(end - 1);
        if (previous >= 0xD800 && previous <= 0xDBFF) end += 1;
      }
      chunks.push(value.slice(start, end));
      start = end;
    }
    return chunks;
  }

  function placeComposerCaretAtEnd(editor, selection = globalThis.getSelection?.()) {
    if (!selection) return;
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    selection.removeAllRanges();
    selection.addRange(end);
  }

  function nextComposerFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function findSendButton() {
    const composer = globalThis.LocalSystemSharedRuntime?.findComposer?.();
    return composer?.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label^="Send"]') || null;
  }

  async function waitForEnabledSendButton(initialButton, timeoutMs) {
    const started = Date.now();
    let button = initialButton;
    while (Date.now() - started < timeoutMs) {
      if (button?.isConnected && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
      await delay(50);
      button = findSendButton();
    }
    return null;
  }

  async function waitForComposerClear(editor, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await delay(80);
      if (!(editor.innerText || editor.textContent || "").trim()) return true;
    }
    return false;
  }

  function composerHasPickerTrigger(editor) {
    const before = textBeforeCaret(editor);
    return /(?:^|\s)(?:\/\/[^\s/]*|@@[^\n]*)$/.test(before || "");
  }

  function rangeForAnnotation(annotation) {
    const source = annotation?.source;
    if (!source) return null;
    const ranges = rangesForAnnotation(annotation);
    return ranges.at(-1) || null;
  }

  function rangesForAnnotation(annotation) {
    const source = annotation?.source;
    if (!source) return [];
    const segmentSources = Array.isArray(source.segments) && source.segments.length
      ? source.segments
      : [source];
    return segmentSources.map(rangeForSource).filter(Boolean);
  }

  function rangeForSource(source) {
    const message = findMessageByKey(source.messageKey, source.role, source.quote);
    if (!message) return null;
    const root = findMessageTextRootForSource(message, source);
    if (!root) return null;
    const text = root.textContent || "";

    if (source.start >= 0 && source.end <= text.length && text.slice(source.start, source.end) === source.quote) {
      return rangeFromOffsets(root, source.start, source.end);
    }

    const index = bestQuoteIndex(text, source);
    if (index < 0) return null;
    return rangeFromOffsets(root, index, index + source.quote.length);
  }

  function bestQuoteIndex(text, source) {
    if (!source.quote) return -1;
    const matches = [];
    let cursor = 0;
    while (cursor <= text.length) {
      const index = text.indexOf(source.quote, cursor);
      if (index < 0) break;
      let score = 0;
      if (source.prefix && text.slice(Math.max(0, index - source.prefix.length), index) === source.prefix) score += 2;
      if (source.suffix && text.slice(index + source.quote.length, index + source.quote.length + source.suffix.length) === source.suffix) score += 2;
      score -= Math.abs(index - Number(source.start || 0)) / 100_000;
      matches.push({ index, score });
      cursor = index + Math.max(1, source.quote.length);
    }
    matches.sort((a, b) => b.score - a.score);
    return matches[0]?.index ?? -1;
  }

  function findMessageByKey(key, role, quote) {
    for (const message of allMessageContainers()) {
      if (messageKeyFor(message) === key) return message;
    }
    for (const message of allMessageContainers()) {
      if (role !== "unknown" && messageRole(message) !== role) continue;
      const root = findMessageTextRoot(message);
      if ((root?.textContent || "").includes(quote)) return message;
    }
    return null;
  }

  function allMessageContainers() {
    const nodes = [
      ...document.querySelectorAll(MESSAGE_ROLE_SELECTOR),
      ...document.querySelectorAll(MESSAGE_CONTAINER_SELECTOR),
      ...document.querySelectorAll("main .markdown"),
    ];
    return [...new Set(nodes)].filter((node) => node.closest("main"));
  }

  function findMessageContainer(element) {
    if (!element?.closest) return null;
    const roleNode = element.closest(MESSAGE_ROLE_SELECTOR);
    if (roleNode?.closest("main")) return roleNode;
    const container = element.closest(MESSAGE_CONTAINER_SELECTOR);
    if (container?.closest("main")) return container;
    const markdown = element.closest(".markdown");
    return markdown?.closest("main") ? markdown : null;
  }

  function findMessageTextRoot(message, selectionElement = null) {
    const selectedMarkdown = selectionElement?.closest?.(".markdown");
    if (selectedMarkdown && message.contains(selectedMarkdown)) return selectedMarkdown;
    return message.querySelector(".markdown")
      || message.querySelector('[data-message-author-role]')
      || message;
  }

  function messageTextRoots(message) {
    if (!message) return [];
    if (message.matches?.(".markdown")) return [message];
    const markdownRoots = [...message.querySelectorAll?.(".markdown") || []];
    if (markdownRoots.length) return markdownRoots;
    return [message.querySelector?.('[data-message-author-role]') || message].filter(Boolean);
  }

  function findMessageTextRootForSource(message, source) {
    const roots = messageTextRoots(message);
    const index = Number(source?.textRootIndex);
    if (Number.isInteger(index) && index >= 0 && index < roots.length) return roots[index];
    if (source?.quote) {
      const matchingRoot = roots.find((root) => (root.textContent || "").includes(source.quote));
      if (matchingRoot) return matchingRoot;
    }
    return findMessageTextRoot(message);
  }

  function messageKeyFor(message) {
    const roleNode = message.matches?.(MESSAGE_ROLE_SELECTOR)
      ? message
      : message.querySelector?.(MESSAGE_ROLE_SELECTOR);
    const roleMessageId = roleNode?.getAttribute("data-message-id");
    if (roleMessageId) return `message:${roleMessageId}`;
    const roleTurnId = roleNode?.getAttribute("data-turn-id");
    if (roleTurnId) return `turn:${roleTurnId}`;
    const testId = message.getAttribute("data-testid");
    if (testId) return `testid:${testId}`;
    const turn = message.getAttribute("data-turn-id") || message.getAttribute("data-turn");
    if (turn) return `turn:${turn}`;
    if (message.id) return `id:${message.id}`;
    return `fallback:${messageRole(message)}:${hashText((findMessageTextRoot(message)?.textContent || "").slice(0, 800))}`;
  }

  function messageRole(message) {
    const roleNode = message.matches?.("[data-message-author-role]") ? message : message.querySelector?.("[data-message-author-role]");
    const role = roleNode?.getAttribute("data-message-author-role") || message.getAttribute("data-turn");
    if (role === "assistant" || role === "user" || role === "tool") return role;
    const label = (message.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("you")) return "user";
    return "assistant";
  }

  function offsetsForRange(root, range) {
    try {
      const beforeStart = document.createRange();
      beforeStart.selectNodeContents(root);
      beforeStart.setEnd(range.startContainer, range.startOffset);
      const beforeEnd = document.createRange();
      beforeEnd.selectNodeContents(root);
      beforeEnd.setEnd(range.endContainer, range.endOffset);
      return { start: beforeStart.toString().length, end: beforeEnd.toString().length };
    } catch {
      return null;
    }
  }

  function rangeFromOffsets(root, start, end) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    let offset = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    while ((node = walker.nextNode())) {
      const length = node.nodeValue?.length || 0;
      if (!startNode && start >= offset && start <= offset + length) {
        startNode = node;
        startOffset = start - offset;
      }
      if (end >= offset && end <= offset + length) {
        endNode = node;
        endOffset = end - offset;
        break;
      }
      offset += length;
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    } catch {
      return null;
    }
  }

  function lastUsefulRect(range) {
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
    return rects.at(-1) || range.getBoundingClientRect?.() || null;
  }

  function annotationById(id) {
    return state.annotations.find((item) => item.id === id) || null;
  }

  function elementForNode(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
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

  function currentThreadId() {
    return globalThis.LocalSystemSharedRuntime?.currentThreadId() || "";
  }

  function clearSelection() {
    const selection = globalThis.getSelection?.();
    selection?.removeAllRanges?.();
    state.selectionDraft = null;
  }

  function closeTransientUi() {
    hideSelectionButton();
    hideTooltip();
    closeEditorPopover();
    composerContext.closeTransientUi();
    state.composerListPinned = false;
    hideComposerList();
  }

  function isAnnotationUiTarget(target) {
    return Boolean(target?.closest?.(`[${UI_ATTR}], [data-local-system-composer-ui]`));
  }

  function compact(value, max) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function refreshTheme() {
    // Follow the shared semantic palette. Sampling an arbitrary composer
    // ancestor can freeze the wrong color when ChatGPT switches themes.
    document.documentElement.style.removeProperty("--ls-annotation-surface");
    document.documentElement.style.removeProperty("--ls-annotation-text");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.documentElement.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return ok;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function injectStyle() {
    if (document.getElementById("local-system-annotations-style")) return;
    const style = document.createElement("style");
    style.id = "local-system-annotations-style";
    style.textContent = `
      :root {
        --ls-annotation-surface: var(--ls-ui-surface);
        --ls-annotation-text: var(--ls-ui-text);
        --ls-annotation-muted: var(--ls-ui-muted);
        --ls-annotation-control-bg: var(--ls-ui-control-bg);
        --ls-annotation-control-hover: var(--ls-ui-control-hover);
        --ls-annotation-primary-bg: var(--ls-ui-primary-bg);
        --ls-annotation-primary-text: var(--ls-ui-primary-text);
        --ls-annotation-ui-font-size: var(--ls-composer-font-size, 13px);
        --ls-annotation-secondary-font-size: calc(var(--ls-annotation-ui-font-size) - 1px);
      }
      ::highlight(${HIGHLIGHT_NAME}) {
        background: color-mix(in srgb, var(--ls-ui-accent) 18%, transparent);
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, var(--ls-ui-accent) 50%, transparent);
        text-decoration-thickness: 1px;
      }
      .ls-annotation-add,
      .ls-annotation-marker,
      .ls-annotation-editor,
      .ls-annotation-tooltip,
      .ls-annotation-composer-list {
        position: fixed;
        z-index: 2147483646;
        box-sizing: border-box;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ls-annotation-text);
      }
      .ls-annotation-add {
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        min-width: 0;
        height: 32px;
        padding: 0 12px !important;
        border: 0 !important;
        border-radius: var(--ls-ui-radius-button, 14px) !important;
        background: var(--ls-annotation-control-bg) !important;
        color: var(--ls-annotation-text) !important;
        box-shadow: var(--ls-ui-shadow-floating);
        font-size: var(--ls-annotation-ui-font-size);
        font-weight: 500;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
      }
      .ls-annotation-marker {
        position: fixed;
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border: 0;
        border-radius: 48%;
        background: var(--ls-annotation-primary-bg);
        box-shadow: var(--ls-ui-shadow-floating);
        color: var(--ls-annotation-primary-text);
        font-size: var(--ls-annotation-secondary-font-size);
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        isolation: isolate;
      }
      .ls-annotation-marker::before {
        content: "";
        position: absolute;
        z-index: -1;
        left: 3px;
        bottom: 1px;
        width: 7px;
        height: 7px;
        border-radius: 3px;
        background: var(--ls-annotation-primary-bg);
        transform: rotate(30deg);
      }
      .ls-annotation-marker:hover {
        transform: scale(1.04);
      }
      .ls-annotation-marker svg,
      .ls-annotation-list-number svg {
        display: block;
        width: var(--ls-ui-icon-size, 16px);
        height: var(--ls-ui-icon-size, 16px);
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .ls-annotation-editor {
        position: fixed;
        width: min(var(--ls-ui-annotation-editor-width, 336px), calc(100vw - 16px));
        min-height: 52px;
        padding: 7px 52px 7px 14px;
        border: 0;
        border-radius: var(--ls-ui-radius-annotation, 24px);
        background: var(--ls-annotation-surface);
        box-shadow: var(--ls-ui-shadow-floating);
      }
      .ls-annotation-editor:focus-within {
        box-shadow: var(--ls-ui-shadow-dialog);
      }
      .ls-annotation-editor__input {
        display: block;
        width: 100%;
        height: 36px;
        min-height: 36px;
        max-height: 150px;
        -webkit-appearance: none !important;
        appearance: none !important;
        resize: none;
        overflow-y: hidden;
        padding: 5px 0;
        border: 0 !important;
        outline: none !important;
        box-shadow: none !important;
        background: transparent !important;
        color: var(--ls-annotation-text);
        font-family: var(--ls-composer-font-family, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-size: calc(var(--ls-annotation-ui-font-size) + 2px);
        font-weight: var(--ls-composer-main-font-weight, 400);
        line-height: 1.5;
      }
      .ls-annotation-editor__input:focus,
      .ls-annotation-editor__input:focus-visible {
        border: 0 !important;
        outline: none !important;
        box-shadow: none !important;
      }
      .ls-annotation-editor__input::placeholder {
        color: color-mix(in srgb, var(--ls-annotation-text) 45%, transparent);
      }
      .ls-annotation-editor__save {
        position: absolute;
        right: 7px;
        bottom: 7px;
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: var(--ls-annotation-primary-bg);
        color: var(--ls-annotation-primary-text);
        cursor: pointer;
      }
      .ls-annotation-editor__save:hover { opacity: .9; }
      .ls-annotation-editor__save:disabled { opacity: .35; cursor: default; }
      .ls-annotation-editor__save svg {
        width: var(--ls-ui-icon-size, 16px);
        height: var(--ls-ui-icon-size, 16px);
        fill: none;
        stroke: currentColor;
        stroke-width: 1.9;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .ls-annotation-editor--editing {
        padding: 10px 12px 9px 14px;
        border-radius: var(--ls-ui-radius-annotation-editing, 22px);
      }
      .ls-annotation-editor--editing .ls-annotation-editor__save {
        position: static;
        flex: 0 0 auto;
      }
      .ls-annotation-editor__actions {
        display: flex;
        align-items: center;
        gap: 7px;
        padding-top: 6px;
      }
      .ls-annotation-editor__spacer { flex: 1; }
      .ls-annotation-editor__delete,
      .ls-annotation-editor__cancel {
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      .ls-annotation-editor__delete {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        padding: 0;
        border-radius: 999px;
        color: var(--ls-ui-danger);
      }
      .ls-annotation-editor__delete:hover {
        background: color-mix(in srgb, var(--ls-ui-danger) 10%, transparent);
      }
      .ls-annotation-editor__delete svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .ls-annotation-editor__cancel {
        height: 34px;
        padding: 0 10px;
        border-radius: 10px;
        opacity: .68;
        font-size: var(--ls-annotation-ui-font-size);
        line-height: 1;
      }
      .ls-annotation-editor__cancel:hover {
        opacity: 1;
        background: color-mix(in srgb, var(--ls-annotation-text) 6%, transparent);
      }
      .ls-annotation-button,
      .ls-annotation-mini-action,
      .ls-annotation-icon-button {
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .ls-annotation-icon-button {
        display: inline-grid;
        place-items: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border-radius: 10px;
      }
      .ls-annotation-icon-button svg,
      .ls-annotation-chip-icon svg,
      .ls-annotation-row-delete svg {
        display: block;
        width: 17px;
        height: 17px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .ls-annotation-icon-button:hover {
        background: color-mix(in srgb, var(--ls-annotation-text) 6%, transparent);
      }
      .ls-annotation-icon-button--small {
        width: 28px;
        height: 28px;
        border-radius: 9px;
      }
      .ls-annotation-icon-button--small svg { width: var(--ls-ui-icon-size, 16px); height: var(--ls-ui-icon-size, 16px); }
      .ls-annotation-icon-button--primary {
        background: var(--ls-annotation-primary-bg);
        color: var(--ls-annotation-primary-text);
      }
      .ls-annotation-icon-button--primary:hover {
        background: color-mix(in srgb, var(--ls-annotation-primary-bg) 88%, transparent);
      }
      .ls-annotation-icon-button--danger { color: var(--ls-ui-danger); }
      .ls-annotation-icon-button.is-success { color: var(--ls-ui-success); }
      .ls-annotation-icon-button:disabled,
      .ls-annotation-row-delete:disabled {
        opacity: .35;
        cursor: default;
      }
      .ls-annotation-button {
        height: 30px;
        padding: 0 10px;
        border-radius: 9px;
        font-size: var(--ls-annotation-ui-font-size);
      }
      .ls-annotation-button:hover,
      .ls-annotation-mini-action:hover {
        background: color-mix(in srgb, var(--ls-annotation-text) 6%, transparent);
      }
      .ls-annotation-button--primary {
        background: var(--ls-annotation-primary-bg);
        color: var(--ls-annotation-primary-text);
      }
      .ls-annotation-button--primary:hover { opacity: .88; background: var(--ls-annotation-primary-bg); }
      .ls-annotation-button--danger,
      .ls-annotation-mini-action--danger { color: var(--ls-ui-danger); }
      .ls-annotation-tooltip {
        width: min(300px, calc(100vw - 16px));
        padding: 9px 10px;
        border: 0;
        border-radius: var(--ls-ui-radius-annotation-tooltip, 14px);
        background: var(--ls-annotation-surface);
        box-shadow: var(--ls-ui-shadow-floating);
        pointer-events: none;
      }
      .ls-annotation-tooltip__quote {
        margin-bottom: 5px;
        opacity: .5;
        font-size: var(--ls-annotation-secondary-font-size);
        line-height: 1.3;
      }
      .ls-annotation-tooltip__comment {
        font-size: var(--ls-annotation-ui-font-size);
        line-height: 1.4;
      }
      .ls-annotation-composer-chip {
        display: inline-flex;
        order: 30;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        width: 64px;
        min-width: 64px;
        height: 40px;
        margin: 0;
        padding: 0 12px;
        border: 0;
        border-radius: 18px;
        background: var(--ls-annotation-control-bg);
        color: var(--ls-annotation-text);
        font: var(--ls-composer-font);
        cursor: pointer;
        pointer-events: auto;
        gap: 6px;
      }
      .ls-annotation-composer-chip:hover { background: var(--ls-annotation-control-hover); }
      .ls-annotation-sync-button {
        margin: 0 0 0 auto;
      }
      .ls-annotation-sync-button svg { width: var(--ls-ui-icon-size, 16px); height: var(--ls-ui-icon-size, 16px); fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .ls-annotation-sync-button.is-syncing svg { animation:ls-annotation-sync-spin .8s linear infinite; }
      .ls-annotation-sync-button.is-success { color:var(--ls-ui-success); }
      .ls-annotation-sync-button:disabled { cursor:default; opacity:.68; }
      @keyframes ls-annotation-sync-spin { to { transform:rotate(360deg); } }
      .ls-send-progress {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        flex: 0 0 auto;
        height: 40px;
        padding: 0 12px;
        border: 0;
        border-radius: 18px;
        background: var(--ls-annotation-control-bg);
        color: var(--ls-annotation-text);
        font: var(--ls-composer-font);
        pointer-events: none;
      }
      .ls-send-progress__spinner {
        width: 14px;
        height: 14px;
        border: 2px solid color-mix(in srgb, var(--ls-ui-accent) 24%, transparent);
        border-top-color: color-mix(in srgb, var(--ls-ui-accent) 84%, var(--ls-annotation-text));
        border-radius: 999px;
        animation: ls-send-progress-spin .8s linear infinite;
      }
      @keyframes ls-send-progress-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        .ls-send-progress__spinner,
        .ls-annotation-sync-button.is-syncing svg { animation: none; }
      }
      .ls-annotation-chip-icon {
        display: grid;
        place-items: center;
        flex: 0 0 16px;
        overflow: visible;
      }
      .ls-annotation-chip-icon svg { display: block; width: var(--ls-ui-icon-size, 16px); height: var(--ls-ui-icon-size, 16px); overflow: visible; }
      .ls-annotation-chip-count {
        min-width: 14px;
        text-align: center;
        font: inherit;
      }
      .ls-annotation-composer-list {
        max-height: min(420px, 60vh);
        overflow: auto;
        padding: 6px;
        border: 0;
        border-radius: 18px;
        background: var(--ls-annotation-surface);
        box-shadow: var(--ls-ui-shadow-floating);
        font: var(--ls-composer-font);
      }
      .ls-annotation-composer-list button { font: inherit; }
      .ls-annotation-composer-list__header,
      .ls-annotation-composer-list__footer {
        display: flex;
        align-items: center;
        min-height: 34px;
        padding: 0 7px;
        font-size: var(--ls-annotation-ui-font-size);
        font-weight: 600;
      }
      .ls-annotation-composer-list__header { justify-content: space-between; }
      .ls-annotation-composer-list__footer {
        justify-content: flex-end;
        border-top: 1px solid color-mix(in srgb, var(--ls-annotation-text) 7%, transparent);
      }
      .ls-annotation-mini-action {
        padding: 5px 7px;
        border-radius: 8px;
        font: inherit;
      }
      .ls-annotation-composer-list__row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 4px;
        align-items: center;
        width: 100%;
        padding: 3px;
        border-radius: 11px;
        background: transparent;
        color: inherit;
      }
      .ls-annotation-composer-list__row:hover { background: color-mix(in srgb, var(--ls-annotation-text) 5%, transparent); }
      .ls-annotation-composer-list__open {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        gap: 8px;
        align-items: center;
        min-width: 0;
        width: 100%;
        padding: 5px 4px;
        border: 0;
        border-radius: 9px;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }
      .ls-annotation-row-delete {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--ls-ui-danger);
        opacity: .46;
        cursor: pointer;
      }
      .ls-annotation-row-delete svg { width: var(--ls-ui-icon-size, 16px); height: var(--ls-ui-icon-size, 16px); }
      .ls-annotation-composer-list__row:hover .ls-annotation-row-delete,
      .ls-annotation-row-delete:focus-visible { opacity: 1; }
      .ls-annotation-row-delete:hover { background: color-mix(in srgb, var(--ls-ui-danger) 9%, transparent); }
      .ls-annotation-list-number {
        display: grid;
        place-items: center;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        background: var(--ls-annotation-control-bg);
        color: var(--ls-annotation-text);
        font: inherit;
      }
      .ls-annotation-list-body { min-width: 0; display: grid; gap: 2px; }
      .ls-annotation-list-comment {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font: inherit;
      }
      .ls-annotation-list-quote {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        opacity: .46;
        font: inherit;
      }
    `;
    document.documentElement.appendChild(style);
  }
})();
