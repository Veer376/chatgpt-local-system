/* global cancelAnimationFrame, chrome, document, Element, getComputedStyle, MutationObserver, requestAnimationFrame */

(() => {
  const MOBILE_MEDIA = "(max-width: 720px), (hover: none) and (pointer: coarse) and (max-width: 900px)";
  const state = {
    root: null,
    shell: null,
    frame: null,
    ready: false,
    opening: false,
    width: 520,
    threadId: "",
    dockFrame: 0,
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.source !== "local-system-extension-command") return;
    if (message.action !== "toggle-standalone-workspace") return;
    const result = toggleStandaloneWorkspace();
    sendResponse?.(result);
    return true;
  });

  globalThis.addEventListener("message", handleWorkspaceMessage);
  globalThis.addEventListener("local-system-standalone-workspace-toggle-request", toggleStandaloneWorkspace);
  globalThis.addEventListener("focus", sendHostState);
  globalThis.addEventListener("blur", sendHostState);
  globalThis.addEventListener("resize", applyStandaloneLayout);
  globalThis.visualViewport?.addEventListener?.("resize", applyStandaloneLayout);
  globalThis.visualViewport?.addEventListener?.("scroll", applyStandaloneLayout);
  document.addEventListener("visibilitychange", sendHostState);
  globalThis.addEventListener("local-system-thread-changed", closeStandaloneWorkspace);
  globalThis.addEventListener("local-system-project-changed", () => postToWorkspace({ action: "project-changed" }));
  globalThis.addEventListener("local-system-file-annotations-refresh", () => postToWorkspace({ action: "refresh-annotations" }));
  globalThis.addEventListener("local-system-standalone-open-file", (event) => {
    if (!state.root?.isConnected || typeof event.detail?.path !== "string") return;
    postToWorkspace({
      action: "open-file",
      path: event.detail.path,
      line: event.detail.line,
      column: event.detail.column,
      length: event.detail.length,
      restoreFocus: event.detail.restoreFocus === true,
    });
  });
  globalThis.addEventListener("local-system-standalone-restore-focus", () => {
    postToWorkspace({ action: "restore-focus" });
  });

  const dockObserver = new MutationObserver(() => {
    if (!state.root?.isConnected) return;
    scheduleDockReconcile();
  });
  dockObserver.observe(document.documentElement, { childList: true, subtree: true });

  function toggleStandaloneWorkspace() {
    if (state.root?.isConnected) {
      requestWorkspaceClose();
      return { ok: true, open: false };
    }
    const threadId = currentThreadId();
    if (!threadId) {
      return { ok: false, reason: "no-thread" };
    }
    openStandaloneWorkspace(threadId);
    return { ok: true, open: true };
  }

  function openStandaloneWorkspace(threadId) {
    closeStandaloneWorkspace();
    const root = document.createElement("div");
    root.className = "local-system-standalone-workspace-root";
    root.setAttribute("data-local-system-ui", "standalone-workspace");
    const shadow = root.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: relative;
          z-index: 30;
          flex: 0 0 var(--ls-standalone-workspace-width);
          align-self: stretch;
          width: var(--ls-standalone-workspace-width);
          height: 100%;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          pointer-events: none;
          contain: layout style paint;
          --ls-standalone-workspace-width: 520px;
        }
        :host([data-awaiting-dock]) {
          display: none;
        }
        :host([data-mobile]) {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          width: 100vw !important;
          height: 100dvh;
          min-height: -webkit-fill-available;
          flex: none;
        }
        .panel {
          position: relative;
          width: 100%;
          height: 100%;
          overflow: hidden;
          border-left: 1px solid var(--ls-ui-separator);
          background: var(--ls-ui-surface);
          color: var(--ls-ui-text);
          pointer-events: auto;
          isolation: isolate;
        }
        .panel.resizing {
          transition: none;
          user-select: none;
        }
        iframe {
          display: block;
          width: 100%;
          height: 100%;
          border: 0;
          background: transparent;
        }
        :host([data-mobile]) .panel {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          border-left: 0;
        }
      </style>
      <section class="panel" aria-label="Local System workspace">
        <iframe title="Local System standalone workspace" allow="clipboard-write"></iframe>
      </section>
    `;
    const shell = shadow.querySelector(".panel");
    const frame = shadow.querySelector("iframe");
    const workspaceUrl = extensionUrl("file-workspace.html");
    if (!workspaceUrl || !shell || !frame) return;

    const mobile = globalThis.matchMedia?.(MOBILE_MEDIA)?.matches === true;
    frame.src = `${workspaceUrl}?threadId=${encodeURIComponent(threadId)}&presentation=standalone&host=page&mobile=${mobile ? "1" : "0"}`;
    state.root = root;
    state.shell = shell;
    state.frame = frame;
    state.ready = false;
    state.opening = true;
    state.threadId = threadId;
    applyStandaloneLayout();

    frame.addEventListener("load", () => {
      if (state.frame !== frame) return;
      sendHostState();
    }, { once: true });
  }

  function closeStandaloneWorkspace() {
    if (state.dockFrame) {
      cancelAnimationFrame(state.dockFrame);
      state.dockFrame = 0;
    }
    state.root?.remove();
    state.root = null;
    state.shell = null;
    state.frame = null;
    state.ready = false;
    state.opening = false;
    state.threadId = "";
  }

  function requestWorkspaceClose() {
    if (!state.ready) {
      closeStandaloneWorkspace();
      return;
    }
    postToWorkspace({ action: "close-sidebar" });
    globalThis.setTimeout(() => {
      if (state.root?.isConnected) closeStandaloneWorkspace();
    }, 350);
  }

  function handleWorkspaceMessage(event) {
    if (!state.frame || event.source !== state.frame.contentWindow) return;
    if (event.data?.source !== "local-system-file-workspace") return;
    const action = event.data.action;
    if (action === "ready") {
      state.ready = true;
      sendHostState();
      postToWorkspace({ action: "open-mode", mode: "files" });
      return;
    }
    if (action === "visibility") {
      if (Number.isFinite(Number(event.data.width))) state.width = Number(event.data.width);
      applyStandaloneLayout();
      if (event.data.visible === true) {
        state.opening = false;
      } else if (!state.opening) {
        closeStandaloneWorkspace();
      }
      return;
    }
    if (action === "resize") {
      if (Number.isFinite(Number(event.data.width))) state.width = Number(event.data.width);
      applyStandaloneLayout();
      return;
    }
    if (action === "resize-start") {
      state.shell?.classList.add("resizing");
      return;
    }
    if (action === "resize-end") {
      state.shell?.classList.remove("resizing");
      return;
    }
    if (action === "toggle-left-sidebar") {
      globalThis.dispatchEvent(new CustomEvent("local-system-standalone-toggle-left-sidebar"));
      return;
    }
    if (action === "quick-open") {
      globalThis.dispatchEvent(new CustomEvent("local-system-standalone-quick-open", {
        detail: {
          mode: event.data.mode === "text" ? "text" : "files",
          query: typeof event.data.query === "string" ? event.data.query : "",
        },
      }));
      return;
    }
    if (action === "ui-visibility") {
      globalThis.dispatchEvent(new CustomEvent("local-system-ui-visibility-change", {
        detail: {
          key: event.data.key,
          value: event.data.value === true,
        },
      }));
      return;
    }
    if (action === "project-picker") {
      globalThis.dispatchEvent(new CustomEvent("local-system-project-picker-request"));
      return;
    }
  }

  function postToWorkspace(command) {
    if (!state.frame?.contentWindow) return;
    state.frame.contentWindow.postMessage({
      source: "local-system-host",
      active: document.visibilityState === "visible" && document.hasFocus(),
      theme: pageTheme(),
      ...command,
    }, extensionOrigin());
  }

  function sendHostState() {
    if (!state.frame?.contentWindow) return;
    const mobile = globalThis.matchMedia?.(MOBILE_MEDIA)?.matches === true;
    postToWorkspace({
      action: "host-layout",
      width: Math.max(1, Math.round(globalThis.visualViewport?.width || globalThis.innerWidth || 1)),
      mobile,
    });
  }

  function applyStandaloneLayout() {
    if (!state.root || !state.shell) return;
    const mobile = globalThis.matchMedia?.(MOBILE_MEDIA)?.matches === true;
    const viewportWidth = Math.max(1, globalThis.visualViewport?.width || globalThis.innerWidth || 1);
    const width = mobile
      ? viewportWidth
      : clampStandaloneWidth(state.width || 520);
    state.root.style.setProperty("--ls-standalone-workspace-width", `${Math.round(width)}px`);
    state.root.toggleAttribute("data-mobile", mobile);
    ensureStandaloneParent(mobile);
    if (state.ready) {
      postToWorkspace({ action: "host-layout", width: Math.round(width), mobile });
    }
  }

  function scheduleDockReconcile() {
    if (state.dockFrame) return;
    state.dockFrame = requestAnimationFrame(() => {
      state.dockFrame = 0;
      if (!state.root?.isConnected) return;
      applyStandaloneLayout();
    });
  }

  function ensureStandaloneParent(mobile) {
    if (!state.root) return false;
    if (mobile) {
      state.root.removeAttribute("data-awaiting-dock");
      if (state.root.parentElement !== document.documentElement) {
        document.documentElement.appendChild(state.root);
      }
      return true;
    }
    const shell = findChatGPTSidePaneShell();
    if (!shell) {
      state.root.setAttribute("data-awaiting-dock", "true");
      if (!state.root.isConnected) document.documentElement.appendChild(state.root);
      return false;
    }
    state.root.removeAttribute("data-awaiting-dock");
    if (state.root.parentElement !== shell) shell.appendChild(state.root);
    return true;
  }

  function clampStandaloneWidth(requested) {
    const shell = findChatGPTSidePaneShell();
    const shellWidth = shell?.getBoundingClientRect().width || globalThis.innerWidth || 1_000;
    const embedded = shell?.querySelector(".local-system-file-workspace-host:not([hidden])");
    const embeddedWidth = embedded && getComputedStyle(embedded).display !== "none"
      ? embedded.getBoundingClientRect().width
      : 0;
    const available = Math.max(320, shellWidth - 420 - embeddedWidth);
    const minimum = Math.min(420, available);
    return Math.max(minimum, Math.min(1_000, available, Math.round(Number(requested) || 520)));
  }

  function findChatGPTSidePaneShell() {
    let node = document.querySelector("#thread") || globalThis.LocalSystemSharedRuntime?.findComposerEditor?.();
    while (node && node !== document.body) {
      if (node.classList?.contains("group/side-pane-shell-host")) return node;
      node = node.parentElement;
    }
    return null;
  }

  function pageTheme() {
    const reference = globalThis.LocalSystemSharedRuntime?.findComposerEditor?.() || document.body || document.documentElement;
    const style = reference ? getComputedStyle(reference) : null;
    const bodyStyle = document.body ? getComputedStyle(document.body) : style;
    return {
      surface: nearestSurface(reference) || (style?.backgroundColor || ""),
      text: style?.color || bodyStyle?.color || "",
      fontSize: style?.fontSize || "13px",
      contentFontSize: bodyStyle?.fontSize || style?.fontSize || "16px",
    };
  }

  function nearestSurface(start) {
    let node = start instanceof Element ? start : null;
    while (node && node !== document.documentElement) {
      const background = getComputedStyle(node).backgroundColor;
      if (background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)") return background;
      node = node.parentElement;
    }
    return "";
  }

  function currentThreadId() {
    return globalThis.LocalSystemSharedRuntime?.currentThreadId() || "";
  }

  function extensionUrl(path) {
    // Chrome cannot debug a tab containing a different extension's subframe.
    if (path !== "/" && document.documentElement?.getAttribute("data-pw-browser-automation") === "1") return "";
    try {
      if (!chrome.runtime?.id) return "";
      return chrome.runtime.getURL(path);
    } catch {
      return "";
    }
  }

  function extensionOrigin() {
    const root = extensionUrl("/");
    return root ? new URL(root).origin : "*";
  }
})();
