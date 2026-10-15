(() => {
  const MAX_TURNS = 3;
  const DISABLE_KEY = "local-system:thread-tail-clamp";
  const STATS_KEY = "local-system:thread-tail-stats";
  const THREAD_PATH = /^\/backend-api\/conversations\/[^/]+(?:\/messages)?$/;
  const originalFetch = globalThis.fetch;

  if (typeof originalFetch !== "function") return;

  function enabled() {
    try {
      return globalThis.localStorage?.getItem(DISABLE_KEY) !== "off";
    } catch {
      return true;
    }
  }

  function requestMethod(input, init) {
    return String(init?.method || input?.method || "GET").toUpperCase();
  }

  function rewriteUrl(value) {
    let url;
    try {
      url = new URL(String(value), globalThis.location?.href || "https://chatgpt.com/");
    } catch {
      return null;
    }

    if (url.origin !== "https://chatgpt.com" || !THREAD_PATH.test(url.pathname)) return null;
    if (!url.searchParams.has("num_turns")) return null;

    const current = Number.parseInt(url.searchParams.get("num_turns") || "", 10);
    if (!Number.isFinite(current) || current <= MAX_TURNS) return null;

    url.searchParams.set("num_turns", String(MAX_TURNS));
    return url;
  }

  function rewriteInput(input, init) {
    if (!enabled() || requestMethod(input, init) !== "GET") return input;

    const sourceUrl = input instanceof Request ? input.url : input;
    const rewritten = rewriteUrl(sourceUrl);
    if (!rewritten) return input;

    recordClamp(sourceUrl, rewritten);

    try {
      return input instanceof Request
        ? new Request(rewritten.toString(), input)
        : rewritten.toString();
    } catch {
      return input;
    }
  }

  function recordClamp(sourceUrl, rewritten) {
    try {
      const before = new URL(String(sourceUrl), globalThis.location?.href || "https://chatgpt.com/");
      const after = rewritten instanceof URL ? rewritten : new URL(String(rewritten));
      const previous = JSON.parse(globalThis.sessionStorage?.getItem(STATS_KEY) || "{}") || {};
      const isHistory = after.pathname.endsWith("/messages");
      const next = {
        total: Number(previous.total || 0) + 1,
        initial: Number(previous.initial || 0) + (isHistory ? 0 : 1),
        history: Number(previous.history || 0) + (isHistory ? 1 : 0),
        lastAt: new Date().toISOString(),
        lastPath: after.pathname,
        lastOriginalTurns: Number.parseInt(before.searchParams.get("num_turns") || "", 10) || null,
        lastAppliedTurns: Number.parseInt(after.searchParams.get("num_turns") || "", 10) || null,
      };
      globalThis.sessionStorage?.setItem(STATS_KEY, JSON.stringify(next));
    } catch {
      // Diagnostics must never affect request forwarding.
    }
  }

  async function observedBridgeConversationId(input, init) {
    if (requestMethod(input, init) !== "POST") return "";

    let url;
    try {
      const sourceUrl = input instanceof Request ? input.url : input;
      url = new URL(String(sourceUrl), globalThis.location?.href || "https://chatgpt.com/");
    } catch {
      return "";
    }
    if (url.pathname !== "/mcp") return "";

    let body = init?.body;
    if (body == null && input instanceof Request) {
      try {
        body = await input.clone().text();
      } catch {
        return "";
      }
    }
    if (typeof body !== "string") return "";

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return "";
    }

    for (const message of Array.isArray(payload) ? payload : [payload]) {
      if (message?.method !== "tools/call" || message?.params?.name !== "bridge_context") continue;
      const meta = message?.params?._meta;
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
      for (const key of ["openai/session", "threadId"]) {
        const value = meta[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
    return "";
  }

  globalThis.fetch = function localSystemThreadTailFetch(input, init) {
    const observedConversationId = observedBridgeConversationId(input, init);
    const responsePromise = originalFetch.call(this, rewriteInput(input, init), init);
    void observedConversationId.then((conversationId) => {
      if (!conversationId) return;
      responsePromise.then(() => {
        globalThis.postMessage({ source: "local-system-mcp-observer", conversationId }, globalThis.location.origin);
      }).catch(() => {});
    }).catch(() => {});
    return responsePromise;
  };
})();
