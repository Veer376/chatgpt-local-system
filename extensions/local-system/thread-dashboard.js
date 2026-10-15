/* global chrome, MutationObserver, document */

(() => {
  const state = {
    threadId: currentThreadId(),
    button: null,
    panel: null,
    open: false,
    pollTimer: 0,
    statusTimer: 0,
    reconcileTimer: 0,
    listSequence: 0,
    annotationSequence: 0,
    calls: [],
    turn: null,
    totalCount: 0,
    activeCount: 0,
    nextCursor: null,
    loadedMore: false,
    expandedId: "",
    latestAnnotations: [],
    annotationTurn: null,
    currentWorkspace: "",
    bound: false,
    bridgeStatus: "checking",
    refreshing: false,
    completionToast: null,
    completionVisualTimer: 0,
  };

  reconcile();
  startStatusPolling();
  void loadWorkspaceIdentity();
  const observer = new MutationObserver(scheduleReconcile);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  globalThis.addEventListener("local-system-thread-changed", (event) => {
    const threadId = String(event.detail?.threadId || currentThreadId());
    if (threadId === state.threadId) return;
    state.threadId = threadId;
    resetThreadState();
    state.bridgeStatus = "checking";
    closePanel();
    removeButton();
    scheduleReconcile();
    void loadBridgeStatus();
    void loadWorkspaceIdentity();
  });
  globalThis.addEventListener("local-system-project-changed", (event) => {
    if (typeof event.detail?.currentWorkspace === "string") {
      state.currentWorkspace = event.detail.currentWorkspace;
    }
  });
  globalThis.addEventListener("resize", positionPanel, { passive: true });
  document.addEventListener("pointerdown", handleOutsidePointerDown, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.open) closePanel();
  });
  document.addEventListener("visibilitychange", () => {
    void loadBridgeStatus();
  });

  function scheduleReconcile() {
    if (state.reconcileTimer) return;
    state.reconcileTimer = setTimeout(() => {
      state.reconcileTimer = 0;
      const threadId = currentThreadId();
      if (threadId !== state.threadId) {
        state.threadId = threadId;
        resetThreadState();
        closePanel();
        removeButton();
      }
      reconcile();
    }, 140);
  }

  function resetThreadState() {
    if (state.completionVisualTimer) clearTimeout(state.completionVisualTimer);
    state.completionVisualTimer = 0;
    state.completionToast?.remove();
    state.completionToast = null;
    if (state.button?.isConnected) delete state.button.dataset.completionPulse;
    state.calls = [];
    state.turn = null;
    state.totalCount = 0;
    state.activeCount = 0;
    state.nextCursor = null;
    state.loadedMore = false;
    state.expandedId = "";
    state.latestAnnotations = [];
    state.annotationTurn = null;
    state.currentWorkspace = "";
    state.bound = false;
    state.bridgeStatus = "checking";
  }

  function reconcile() {
    const mount = globalThis.LocalSystemSharedRuntime?.ensureComposerRailActionsHost?.();
    const host = mount?.host;
    if (!state.threadId || !host) {
      removeButton();
      return;
    }
    if (state.button?.isConnected) {
      makeHeaderButtonInteractive(state.button);
      state.button.style.order = "20";
      applyBridgeStatusToButton();
      if (state.button.parentElement !== host) host.appendChild(state.button);
      if (state.open) positionPanel();
      return;
    }

    const button = globalThis.LocalSystemSharedRuntime?.ComposerIconButton?.({
      className: "local-system-dashboard-button",
      label: "Local System activity",
      order: 20,
      dataset: { localSystemDashboard: "true" },
      icon: `
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" class="icon">
          <path d="M8 7l-3 5 3 5M16 7l3 5-3 5M13.5 5l-3 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `,
    });
    if (!button) return;
    makeHeaderButtonInteractive(button);
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.open) closePanel(); else openPanel();
    });
    host.appendChild(button);
    state.button = button;
    applyBridgeStatusToButton();
    void loadBridgeStatus();
  }

  function makeHeaderButtonInteractive(button) {
    if (!button) return;
    button.disabled = false;
    button.removeAttribute("disabled");
    button.removeAttribute("aria-disabled");
    button.removeAttribute("inert");
    button.tabIndex = 0;
  }

  function removeButton() {
    state.button?.remove();
    state.button = null;
  }

  function ensurePanel() {
    if (state.panel?.isConnected) return state.panel;
    const panel = document.createElement("section");
    panel.className = "ls-thread-dashboard";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Local System thread activity");
    panel.innerHTML = `
      <header class="ls-thread-dashboard__head">
        <span class="ls-thread-dashboard__title">Local System</span>
        <span class="ls-thread-dashboard__state" data-slot="system-state">Checking…</span>
        <span class="ls-thread-dashboard__spacer"></span>
        <span data-slot="refresh-button"></span>
        <button type="button" class="ls-thread-dashboard__icon-button" data-action="close" aria-label="Close" title="Close">
          <svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>
        </button>
      </header>
      <div class="ls-thread-dashboard__scroll">
        <section class="ls-thread-dashboard__section">
          <div class="ls-thread-dashboard__section-head">
            <span class="ls-thread-dashboard__section-title">Turn</span>
            <span class="ls-thread-dashboard__count" data-slot="turn-count"></span>
          </div>
          <div class="ls-thread-dashboard__turn" data-slot="turn"><div class="ls-thread-dashboard__loading">Loading turn…</div></div>
        </section>
        <section class="ls-thread-dashboard__section">
          <div class="ls-thread-dashboard__section-head">
            <span class="ls-thread-dashboard__section-title">Recent activity</span>
            <span class="ls-thread-dashboard__count" data-slot="activity-count"></span>
          </div>
          <div class="ls-thread-dashboard__activity" data-slot="activity"><div class="ls-thread-dashboard__loading">Loading activity…</div></div>
          <button type="button" class="ls-thread-dashboard__load-more" data-action="load-more" hidden>Load more</button>
        </section>
        <section class="ls-thread-dashboard__section">
          <div class="ls-thread-dashboard__section-head">
            <span class="ls-thread-dashboard__section-title">Last turn</span>
            <span class="ls-thread-dashboard__count" data-slot="annotation-count"></span>
          </div>
          <div data-slot="annotation"><div class="ls-thread-dashboard__loading">Loading annotations…</div></div>
        </section>
      </div>
    `;
    const refreshButton = globalThis.LocalSystemSharedRuntime?.ComposerIconButton?.({
      className: "ls-thread-dashboard__refresh-button",
      label: "Refresh",
      dataset: { action: "refresh" },
      icon: `
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 8a7 7 0 1 0 1 5"/><path d="M19 4v4h-4"/>
        </svg>
      `,
    });
    const refreshSlot = panel.querySelector('[data-slot="refresh-button"]');
    if (refreshButton) refreshSlot?.replaceWith(refreshButton);
    else refreshSlot?.remove();
    panel.querySelector('[data-action="close"]').addEventListener("click", closePanel);
    refreshButton?.addEventListener("click", () => void refreshPanel({ showLoading: true }));
    panel.querySelector('[data-action="load-more"]').addEventListener("click", () => void loadMoreActivity());
    document.body.append(panel);
    state.panel = panel;
    syncTheme();
    return panel;
  }

  function openPanel() {
    if (!state.threadId || !state.button) return;
    const panel = ensurePanel();
    state.open = true;
    panel.hidden = false;
    state.button.setAttribute("aria-expanded", "true");
    syncTheme();
    positionPanel();
    void refreshPanel({ showLoading: true });
    startPolling();
  }

  function closePanel() {
    state.open = false;
    if (state.panel) state.panel.hidden = true;
    state.button?.setAttribute("aria-expanded", "false");
    stopPolling();
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (!state.open || document.visibilityState !== "visible") return;
      void loadActivityList();
    }, 1_000);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }

  function startStatusPolling() {
    if (state.statusTimer) clearInterval(state.statusTimer);
    state.statusTimer = setInterval(() => {
      void loadBridgeStatus();
    }, 15_000);
  }

  async function loadBridgeStatus() {
    if (!state.threadId || !state.button?.isConnected) return;
    try {
      const payload = await apiRequest("/local-ui/activity", {
        threadId: state.threadId,
        action: "status",
      });
      applyBridgePayload(payload);
    } catch {
      setBridgeStatus("inactive");
    }
  }

  async function loadWorkspaceIdentity() {
    const threadId = state.threadId;
    if (!threadId) return;
    try {
      const payload = await apiRequest("/local-ui/file-workspace", {
        threadId,
        action: "context",
        active: false,
      });
      if (threadId !== state.threadId) return;
      state.currentWorkspace = typeof payload?.currentWorkspace === "string"
        ? payload.currentWorkspace
        : state.currentWorkspace;
    } catch {
      // Thread title remains a sufficient completion identifier.
    }
  }

  function applyBridgePayload(payload) {
    const previousStatus = state.bridgeStatus;
    state.bound = payload?.bound === true;
    const nextStatus = !state.bound ? "unbound" : payload?.bridgeActive === true ? "active" : "inactive";
    const lastActivityAt = payload?.lastToolAt || payload?.lastBridgeAt || null;
    setBridgeStatus(nextStatus, lastActivityAt);
    if (state.bound) {
      requestCompletionWatchRegistration(lastActivityAt, nextStatus === "active");
    }
    if (previousStatus === "active" && nextStatus === "inactive") {
      const identity = completionIdentity();
      showCompletionVisual(identity);
      requestCompletionSignal(lastActivityAt, identity);
    }
  }

  function requestCompletionWatchRegistration(lastActivityAt, active) {
    if (!state.threadId) return;
    const identity = completionIdentity();
    try {
      const request = chrome.runtime.sendMessage({
        source: "local-system-content",
        action: "watch-thread-completion",
        threadId: state.threadId,
        threadUrl: globalThis.location?.href || "",
        threadTitle: identity.threadTitle,
        projectName: identity.projectName,
        lastActivityAt: lastActivityAt ? String(lastActivityAt) : "",
        active: active === true,
      });
      request?.catch?.(() => {});
    } catch {
      // Background monitoring is best-effort during extension reloads.
    }
  }

  function showCompletionVisual(identity) {
    if (state.completionVisualTimer) clearTimeout(state.completionVisualTimer);
    state.completionToast?.remove();
    state.completionToast = null;

    if (state.button?.isConnected) {
      state.button.dataset.completionPulse = "true";
    }

    if (document.visibilityState === "visible") {
      const toast = document.createElement("div");
      toast.className = "ls-local-system-completion-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      toast.innerHTML = `
        <span class="ls-local-system-completion-toast__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="m7 12.5 3.2 3.2L17.5 8.5"/></svg>
        </span>
        <span class="ls-local-system-completion-toast__copy">
          <strong>Local System finished</strong>
          <span class="ls-local-system-completion-toast__label"></span>
        </span>
      `;
      const label = toast.querySelector(".ls-local-system-completion-toast__label");
      if (label) label.textContent = identity.label;
      document.body.appendChild(toast);
      state.completionToast = toast;
      globalThis.requestAnimationFrame(() => toast.dataset.visible = "true");
    }

    state.completionVisualTimer = setTimeout(() => {
      if (state.button?.isConnected) delete state.button.dataset.completionPulse;
      const toast = state.completionToast;
      if (toast?.isConnected) {
        delete toast.dataset.visible;
        setTimeout(() => toast.remove(), 180);
      }
      state.completionToast = null;
      state.completionVisualTimer = 0;
    }, 2_600);
  }

  function requestCompletionSignal(lastActivityAt, identity) {
    if (!state.threadId || !lastActivityAt) return;
    try {
      const request = chrome.runtime.sendMessage({
        source: "local-system-content",
        action: "play-completion-sound",
        threadId: state.threadId,
        completionKey: String(lastActivityAt),
        threadUrl: globalThis.location?.href || "",
        threadTitle: identity.threadTitle,
        projectName: identity.projectName,
      });
      request?.catch?.(() => {});
    } catch {
      // The extension may be reloading; completion feedback is best-effort.
    }
  }

  function completionIdentity() {
    const threadTitle = normalizedThreadTitle();
    const projectName = workspaceName(state.currentWorkspace);
    const fallback = `Thread ${String(state.threadId || "").slice(0, 8) || "unknown"}`;
    return {
      threadTitle,
      projectName,
      label: threadTitle || projectName || fallback,
    };
  }

  function normalizedThreadTitle() {
    const raw = String(document.title || "").trim();
    const title = raw.replace(/\s*(?:\||-|–|—)\s*ChatGPT\s*$/i, "").trim();
    if (!title || /^(?:chatgpt|new chat)$/i.test(title)) return "";
    return title.slice(0, 100);
  }

  function workspaceName(workspace) {
    const normalized = String(workspace || "").replaceAll("\\", "/").replace(/\/+$/, "");
    return normalized.split("/").filter(Boolean).at(-1)?.slice(0, 80) || "";
  }

  function setBridgeStatus(status, lastBridgeAt = null) {
    state.bridgeStatus = status === "active"
      ? "active"
      : status === "inactive"
        ? "inactive"
        : status === "unbound"
          ? "unbound"
          : "checking";
    applyBridgeStatusToButton(lastBridgeAt);
  }

  function applyBridgeStatusToButton(lastBridgeAt = null) {
    if (!state.button) return;
    state.button.dataset.bridgeStatus = state.bridgeStatus;
    const label = state.bridgeStatus === "active"
      ? "In this turn"
      : state.bridgeStatus === "inactive"
        ? "Last turn"
        : state.bridgeStatus === "unbound"
          ? "Not bound"
          : "Checking";
    const suffix = lastBridgeAt ? ` · last activity ${relativeTime(lastBridgeAt)}` : "";
    state.button.title = `Local System · ${label}${suffix}`;
    state.button.setAttribute("aria-label", `Local System · ${label}`);
    const panelState = state.panel?.querySelector('[data-slot="system-state"]');
    if (panelState) {
      panelState.textContent = label;
      panelState.dataset.status = state.bridgeStatus;
    }
  }

  async function refreshPanel({ showLoading = false } = {}) {
    if (!state.open || state.refreshing) return;
    state.refreshing = true;
    const refreshButton = state.panel?.querySelector('[data-action="refresh"]');
    if (refreshButton) refreshButton.dataset.loading = "true";
    if (showLoading) {
      renderAnnotationLoading();
      renderActivityLoading();
      renderTurnLoading();
    }
    await Promise.allSettled([loadLatestAnnotation(), loadActivityList({ resetPage: true })]);
    state.refreshing = false;
    if (refreshButton) delete refreshButton.dataset.loading;
  }

  async function loadLatestAnnotation() {
    const sequence = ++state.annotationSequence;
    try {
      const payload = await apiRequest("/local-ui/annotations", {
        threadId: state.threadId,
        action: "latest",
        active: document.visibilityState === "visible",
      });
      if (sequence !== state.annotationSequence || !state.open) return;
      state.bound = payload?.bound === true;
      state.latestAnnotations = Array.isArray(payload?.annotations)
        ? payload.annotations
        : payload?.annotation
          ? [payload.annotation]
          : [];
      state.annotationTurn = payload?.turn || null;
      renderAnnotation();
    } catch (error) {
      if (sequence !== state.annotationSequence || !state.open) return;
      renderAnnotationError(error);
    }
  }

  async function loadActivityList({ resetPage = false } = {}) {
    const sequence = ++state.listSequence;
    try {
      const payload = await apiRequest("/local-ui/activity", {
        threadId: state.threadId,
        action: "list",
        limit: 5,
      });
      if (sequence !== state.listSequence || !state.open) return;
      state.bound = payload?.bound === true;
      applyBridgePayload(payload);
      const nextTurn = payload?.turn || null;
      const turnChanged = Boolean(state.turn?.id && nextTurn?.id && state.turn.id !== nextTurn.id);
      const nextCalls = Array.isArray(payload?.calls) ? payload.calls : [];
      if (resetPage || turnChanged || !state.loadedMore) {
        state.calls = nextCalls;
        state.nextCursor = payload?.nextCursor || null;
        state.loadedMore = false;
      } else {
        const seen = new Set(nextCalls.map((call) => call.id));
        state.calls = [...nextCalls, ...state.calls.filter((call) => !seen.has(call.id))];
      }
      state.turn = nextTurn;
      state.totalCount = Number(payload?.totalCount) || 0;
      state.activeCount = Number(payload?.activeCount) || 0;
      if (state.button) state.button.dataset.activeTools = state.activeCount > 0 ? "true" : "false";
      renderTurn();
      renderActivity();
    } catch (error) {
      if (sequence !== state.listSequence || !state.open) return;
      renderTurnError(error);
      renderActivityError(error);
    }
  }

  async function loadMoreActivity() {
    const cursor = state.nextCursor;
    if (!cursor || !state.open) return;
    const button = state.panel?.querySelector('[data-action="load-more"]');
    if (button) {
      button.disabled = true;
      button.textContent = "Loading…";
    }
    try {
      const payload = await apiRequest("/local-ui/activity", {
        threadId: state.threadId,
        action: "list",
        limit: 5,
        cursor,
      });
      if (!state.open) return;
      if (payload?.staleCursor) {
        state.loadedMore = false;
        await loadActivityList({ resetPage: true });
        return;
      }
      const incoming = Array.isArray(payload?.calls) ? payload.calls : [];
      const seen = new Set(state.calls.map((call) => call.id));
      state.calls.push(...incoming.filter((call) => !seen.has(call.id)));
      state.nextCursor = payload?.nextCursor || null;
      state.totalCount = Number(payload?.totalCount) || state.totalCount;
      state.activeCount = Number(payload?.activeCount) || 0;
      state.turn = payload?.turn || state.turn;
      state.loadedMore = true;
      renderTurn();
      renderActivity();
    } catch (error) {
      renderActivityError(error);
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = "Load more";
      }
    }
  }

  function renderAnnotationLoading() {
    const slot = state.panel?.querySelector('[data-slot="annotation"]');
    if (slot) slot.innerHTML = '<div class="ls-thread-dashboard__loading">Loading annotations…</div>';
  }

  function renderAnnotation() {
    const slot = state.panel?.querySelector('[data-slot="annotation"]');
    if (!slot) return;
    const annotations = state.latestAnnotations;
    const count = state.panel?.querySelector('[data-slot="annotation-count"]');
    if (count) count.textContent = annotations.length ? `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}` : "";
    if (!state.bound) {
      slot.innerHTML = '<div class="ls-thread-dashboard__empty">This thread is not bound to Local System yet.</div>';
      return;
    }
    if (!annotations.length) {
      slot.innerHTML = '<div class="ls-thread-dashboard__empty">No recovered annotations for a previous turn yet.</div>';
      return;
    }
    slot.replaceChildren();
    const list = document.createElement("div");
    list.className = "ls-thread-dashboard__annotation-list";
    annotations.forEach((annotation) => {
      const source = annotation.kind === "file"
        ? `${basename(annotation.path)}${annotation.start?.line ? ` · line ${annotation.start.line}` : ""}`
        : `${annotation.role || "chat"} message`;
      const card = document.createElement("article");
      card.className = "ls-thread-dashboard__annotation";
      card.innerHTML = `
        <div class="ls-thread-dashboard__annotation-meta">
          <span class="ls-thread-dashboard__annotation-source" title="${escapeHtml(annotation.path || source)}">${escapeHtml(source)}</span>
          <span>·</span><span>${escapeHtml(relativeTime(annotation.updatedAt))}</span>
          <span class="ls-thread-dashboard__annotation-spacer"></span>
          <button type="button" class="ls-thread-dashboard__copy" aria-label="Copy annotation" title="Copy annotation">${copyIcon()}</button>
        </div>
        <p class="ls-thread-dashboard__annotation-quote">${escapeHtml(annotation.quote || "")}</p>
        <p class="ls-thread-dashboard__annotation-comment">${escapeHtml(annotation.comment || "")}</p>
      `;
      const copy = card.querySelector(".ls-thread-dashboard__copy");
      copy.addEventListener("click", async () => {
        const ok = await copyText(annotation.copyText || fallbackAnnotationText(annotation));
        copy.innerHTML = ok ? checkIcon() : copyIcon();
        copy.dataset.copyState = ok ? "success" : "failed";
        setTimeout(() => {
          if (!copy.isConnected) return;
          copy.innerHTML = copyIcon();
          delete copy.dataset.copyState;
        }, 1_200);
      });
      list.append(card);
    });
    slot.append(list);
  }

  function renderAnnotationError(error) {
    const slot = state.panel?.querySelector('[data-slot="annotation"]');
    if (slot) slot.innerHTML = `<div class="ls-thread-dashboard__error">${escapeHtml(errorMessage(error))}</div>`;
  }

  function renderActivityLoading() {
    const slot = state.panel?.querySelector('[data-slot="activity"]');
    if (slot) slot.innerHTML = '<div class="ls-thread-dashboard__loading">Loading tool activity…</div>';
  }

  function renderTurnLoading() {
    const slot = state.panel?.querySelector('[data-slot="turn"]');
    if (slot) slot.innerHTML = '<div class="ls-thread-dashboard__loading">Loading turn…</div>';
  }

  function renderTurn() {
    const slot = state.panel?.querySelector('[data-slot="turn"]');
    const count = state.panel?.querySelector('[data-slot="turn-count"]');
    if (!slot) return;
    const turn = state.turn;
    if (count) count.textContent = turn?.toolCount ? `${turn.toolCount} tool${turn.toolCount === 1 ? "" : "s"}` : "";
    if (!state.bound) {
      slot.innerHTML = '<div class="ls-thread-dashboard__empty">This thread is not bound to Local System yet.</div>';
      return;
    }
    if (!turn?.startedAt) {
      slot.innerHTML = '<div class="ls-thread-dashboard__empty">No Local System turn recorded yet.</div>';
      return;
    }
    const endLabel = turn.endedAt ? clockTime(turn.endedAt) : "now";
    const active = Number(turn.activeCount) > 0;
    slot.innerHTML = `
      <div class="ls-thread-dashboard__turn-times">
        <span>${escapeHtml(clockTime(turn.startedAt))}</span>
        <span class="ls-thread-dashboard__turn-arrow">→</span>
        <span>${escapeHtml(endLabel)}</span>
      </div>
      <div class="ls-thread-dashboard__turn-meta">
        <span>${escapeHtml(duration(turn.durationMs || 0))}</span>
        <span>·</span>
        <span>${escapeHtml(`${turn.toolCount || 0} tool${turn.toolCount === 1 ? "" : "s"}`)}</span>
        ${active ? `<span>·</span><span class="ls-thread-dashboard__turn-active">${escapeHtml(`${turn.activeCount} active`)}</span>` : ""}
      </div>
    `;
  }

  function renderTurnError(error) {
    const slot = state.panel?.querySelector('[data-slot="turn"]');
    if (slot) slot.innerHTML = `<div class="ls-thread-dashboard__error">${escapeHtml(errorMessage(error))}</div>`;
  }

  function renderActivity() {
    const slot = state.panel?.querySelector('[data-slot="activity"]');
    const count = state.panel?.querySelector('[data-slot="activity-count"]');
    const loadMore = state.panel?.querySelector('[data-action="load-more"]');
    if (!slot) return;
    const scrollState = captureActivityScrollState(slot);
    if (count) count.textContent = state.totalCount ? `${state.totalCount} total` : "";
    if (loadMore) loadMore.hidden = !state.nextCursor;
    if (!state.bound) {
      slot.innerHTML = '<div class="ls-thread-dashboard__empty">This thread is not bound to Local System yet.</div>';
      return;
    }
    if (!state.calls.length) {
      slot.innerHTML = '<div class="ls-thread-dashboard__empty">No Local System tool calls recorded in this bridge process yet.</div>';
      return;
    }
    slot.replaceChildren();
    for (const call of state.calls) {
      const wrap = document.createElement("div");
      wrap.className = "ls-thread-dashboard__tool-wrap";
      wrap.dataset.callId = call.id;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ls-thread-dashboard__tool";
      button.setAttribute("aria-expanded", state.expandedId === call.id ? "true" : "false");
      button.innerHTML = `
        <span class="ls-thread-dashboard__status-dot" data-status="${escapeHtml(call.status || "completed")}"></span>
        <span class="ls-thread-dashboard__tool-name">${escapeHtml(call.tool || "tool")}</span>
        <span class="ls-thread-dashboard__tool-meta">${escapeHtml(toolMeta(call))}</span>
      `;
      const detail = document.createElement("div");
      detail.className = "ls-thread-dashboard__detail";
      detail.hidden = state.expandedId !== call.id;
      button.addEventListener("click", () => {
        const opening = state.expandedId !== call.id;
        state.expandedId = opening ? call.id : "";
        for (const node of slot.querySelectorAll(".ls-thread-dashboard__detail")) node.hidden = true;
        for (const row of slot.querySelectorAll(".ls-thread-dashboard__tool")) row.setAttribute("aria-expanded", "false");
        if (!opening) return;
        button.setAttribute("aria-expanded", "true");
        detail.hidden = false;
        renderToolDetail(detail, call);
      });
      wrap.append(button, detail);
      slot.append(wrap);
      if (state.expandedId === call.id) renderToolDetail(detail, call);
    }
    restoreActivityScrollState(slot, scrollState);
  }

  function renderActivityError(error) {
    const slot = state.panel?.querySelector('[data-slot="activity"]');
    if (slot) slot.innerHTML = `<div class="ls-thread-dashboard__error">${escapeHtml(errorMessage(error))}</div>`;
  }

  function renderToolDetail(target, call) {
    const args = pretty(call.arguments ?? {});
    const result = call.result !== undefined ? pretty(call.result) : "";
    const error = call.error ? String(call.error) : "";
    target.hidden = false;
    target.innerHTML = `
      <div class="ls-thread-dashboard__detail-label">Input</div><pre>${escapeHtml(args)}</pre>
      ${result ? `<div class="ls-thread-dashboard__detail-label">Output</div><pre>${escapeHtml(result)}</pre>` : ""}
      ${error ? `<div class="ls-thread-dashboard__detail-label">Error</div><pre>${escapeHtml(error)}</pre>` : ""}
    `;
  }

  function captureActivityScrollState(slot) {
    const outer = state.panel?.querySelector(".ls-thread-dashboard__scroll")?.scrollTop || 0;
    const detail = {};
    for (const wrap of slot.querySelectorAll(".ls-thread-dashboard__tool-wrap[data-call-id]")) {
      const id = wrap.dataset.callId;
      if (!id) continue;
      detail[id] = [...wrap.querySelectorAll(".ls-thread-dashboard__detail pre")].map((node) => node.scrollTop);
    }
    return { outer, detail };
  }

  function restoreActivityScrollState(slot, snapshot) {
    globalThis.requestAnimationFrame(() => {
      const outer = state.panel?.querySelector(".ls-thread-dashboard__scroll");
      if (outer) outer.scrollTop = snapshot.outer;
      for (const [id, offsets] of Object.entries(snapshot.detail || {})) {
        const wrap = [...slot.querySelectorAll(".ls-thread-dashboard__tool-wrap[data-call-id]")]
          .find((node) => node.dataset.callId === id);
        if (!wrap) continue;
        [...wrap.querySelectorAll(".ls-thread-dashboard__detail pre")].forEach((node, index) => {
          node.scrollTop = offsets[index] || 0;
        });
      }
    });
  }

  function syncTheme() {
    if (!state.panel) return;
    // Keep the panel on ChatGPT's canonical opaque surface. Sampling ancestor
    // backgrounds is unreliable because header/composer layers can be translucent.
    state.panel.style.removeProperty("--ls-dashboard-surface");
    state.panel.style.removeProperty("--ls-dashboard-text");
  }

  function positionPanel() {
    if (!state.open || !state.panel || !state.button?.isConnected) return;
    const rect = state.button.getBoundingClientRect();
    const width = Math.min(430, globalThis.innerWidth - 24);
    const left = Math.max(8, Math.min(globalThis.innerWidth - width - 8, rect.right - width));
    state.panel.style.width = `${width}px`;
    state.panel.style.left = `${left}px`;
    state.panel.style.top = "auto";
    state.panel.style.bottom = `${Math.max(8, Math.round(globalThis.innerHeight - rect.top + 8))}px`;
  }

  function handleOutsidePointerDown(event) {
    if (!state.open) return;
    if (state.panel?.contains(event.target) || state.button?.contains(event.target)) return;
    closePanel();
  }

  async function apiRequest(path, body) {
    const deadline = Date.now() + 2_500;
    while (typeof globalThis.LocalSystemApiRequest !== "function" && Date.now() < deadline) await delay(25);
    if (typeof globalThis.LocalSystemApiRequest !== "function") throw new Error("Local System API bridge is unavailable");
    return globalThis.LocalSystemApiRequest(path, body);
  }

  async function copyText(text) {
    const value = String(text || "");
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    }
  }

  function fallbackAnnotationText(annotation) {
    if (annotation.kind === "file") {
      return `[Annotations]\n- File: ${JSON.stringify(annotation.path || "")}\n  Selected text: ${JSON.stringify(annotation.quote || "")}\n  Comment: ${annotation.comment || ""}\n[/Annotations]`;
    }
    return `[Annotations]\n- Selected text: ${JSON.stringify(annotation.quote || "")}\n  Comment: ${annotation.comment || ""}\n[/Annotations]`;
  }

  function copyIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>';
  }

  function checkIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 12.5 3.4 3.4 7.6-8"/></svg>';
  }

  function toolMeta(call) {
    const durationMs = Number(call?.durationMs);
    if (Number.isFinite(durationMs)) return `${Math.max(0, Math.round(durationMs))} ms`;
    const status = String(call?.status || "");
    return status === "completed" ? "" : status;
  }

  function duration(ms) {
    const value = Number(ms) || 0;
    if (value < 1_000) return `${Math.max(0, Math.round(value))} ms`;
    if (value < 10_000) return `${(value / 1_000).toFixed(1)} s`;
    if (value < 60_000) return `${Math.round(value / 1_000)} s`;
    const totalSeconds = Math.round(value / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${seconds}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function clockTime(value) {
    const date = new Date(String(value || ""));
    if (Number.isNaN(date.getTime())) return String(value || "");
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function relativeTime(value) {
    const time = Date.parse(String(value || ""));
    if (!Number.isFinite(time)) return "recently";
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1_000));
    if (seconds < 5) return "now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
  }

  function basename(value) {
    return String(value || "").split(/[\\/]/).filter(Boolean).pop() || String(value || "file");
  }

  function pretty(value) {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error || "Local System unavailable");
  }

  function currentThreadId() {
    return globalThis.LocalSystemSharedRuntime?.currentThreadId() || "";
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
