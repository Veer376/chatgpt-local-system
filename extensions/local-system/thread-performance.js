/* global chrome */

(() => {
  const DISABLE_KEY = "local-system:thread-performance";
  const SESSION_KEY = "local-system:thread-performance-session";
  const CLAMP_STATS_KEY = "local-system:thread-tail-stats";
  const SAMPLE_MS = 30_000;
  let sampleTimer = null;

  function enabled() {
    try {
      return globalThis.localStorage?.getItem(DISABLE_KEY) !== "off";
    } catch {
      return true;
    }
  }

  function sessionId() {
    try {
      const existing = globalThis.sessionStorage?.getItem(SESSION_KEY);
      if (existing) return existing;
      const next = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      globalThis.sessionStorage?.setItem(SESSION_KEY, next);
      return next;
    } catch {
      return "unavailable";
    }
  }

  function currentThreadId() {
    return globalThis.LocalSystemSharedRuntime?.currentThreadId() || null;
  }

  function clampStats() {
    try {
      return JSON.parse(globalThis.sessionStorage?.getItem(CLAMP_STATS_KEY) || "null");
    } catch {
      return null;
    }
  }

  function navigationInfo() {
    const entry = globalThis.performance?.getEntriesByType?.("navigation")?.[0];
    return {
      type: entry?.type || null,
      activationStart: Number(entry?.activationStart) || 0,
      notRestoredReasons: entry?.notRestoredReasons || null,
    };
  }

  function memoryInfo() {
    const memory = globalThis.performance?.memory;
    return memory ? {
      usedJSHeapSize: Number(memory.usedJSHeapSize) || 0,
      totalJSHeapSize: Number(memory.totalJSHeapSize) || 0,
      jsHeapSizeLimit: Number(memory.jsHeapSizeLimit) || 0,
    } : null;
  }

  function buildSample(reason, extra = {}) {
    return {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      at: new Date().toISOString(),
      reason,
      sessionId: sessionId(),
      threadId: currentThreadId(),
      path: `${globalThis.location?.pathname || ""}${globalThis.location?.search || ""}`,
      visibility: globalThis.document?.visibilityState || null,
      memory: memoryInfo(),
      domNodes: globalThis.document?.getElementsByTagName?.("*")?.length || 0,
      conversationTurns: globalThis.document?.querySelectorAll?.('[data-testid^="conversation-turn-"]')?.length || 0,
      messageRoles: globalThis.document?.querySelectorAll?.("[data-message-author-role]")?.length || 0,
      toolMessages: globalThis.document?.querySelectorAll?.('[data-message-author-role="tool"]')?.length || 0,
      iframes: globalThis.document?.getElementsByTagName?.("iframe")?.length || 0,
      bodyTextChars: globalThis.document?.body?.innerText?.length || 0,
      clamp: clampStats(),
      navigation: navigationInfo(),
      ...extra,
    };
  }

  function report(reason, extra) {
    if (!enabled()) return;
    const sample = buildSample(reason, extra);
    try {
      const pending = chrome.runtime.sendMessage({
        source: "local-system-content",
        action: "thread-performance",
        sample,
      });
      pending?.catch?.(() => {});
    } catch {
      // Diagnostics must never affect ChatGPT.
    }
  }

  function scheduleVisibleSample() {
    if (sampleTimer != null) clearTimeout(sampleTimer);
    sampleTimer = null;
    if (!enabled() || globalThis.document?.visibilityState !== "visible") return;
    sampleTimer = globalThis.setTimeout(() => {
      report("interval");
      scheduleVisibleSample();
    }, SAMPLE_MS);
  }

  globalThis.addEventListener("pageshow", (event) => {
    report(event.persisted ? "pageshow-bfcache" : "pageshow", { persisted: event.persisted === true });
    scheduleVisibleSample();
  });
  globalThis.addEventListener("pagehide", (event) => {
    report("pagehide", { persisted: event.persisted === true });
    if (sampleTimer != null) clearTimeout(sampleTimer);
    sampleTimer = null;
  });
  globalThis.document?.addEventListener("visibilitychange", () => {
    report(`visibility-${globalThis.document.visibilityState}`);
    scheduleVisibleSample();
  });

  report("content-ready");
  scheduleVisibleSample();
})();
