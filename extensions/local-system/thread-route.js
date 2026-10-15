(() => {
  "use strict";
  if (globalThis.LocalSystemThreadRoute) return;

  const PROVIDERS = Object.freeze([
    Object.freeze({
      id: "chatgpt",
      hosts: Object.freeze(["chatgpt.com"]),
      path: /^\/c\/([^/?#]+)/,
    }),
    Object.freeze({
      id: "claude",
      hosts: Object.freeze(["claude.ai", "www.claude.ai"]),
      path: /^\/chat\/([^/?#]+)/,
    }),
  ]);

  function parse(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      return null;
    }

    const host = url.hostname.toLowerCase();
    for (const provider of PROVIDERS) {
      if (!provider.hosts.includes(host)) continue;
      const match = url.pathname.match(provider.path);
      if (!match?.[1]) return null;
      return {
        provider: provider.id,
        threadId: decodeURIComponent(match[1]),
      };
    }
    return null;
  }

  function providerFromUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      return "";
    }
    const host = url.hostname.toLowerCase();
    return PROVIDERS.find((provider) => provider.hosts.includes(host))?.id || "";
  }

  function threadIdFromUrl(value) {
    return parse(value)?.threadId || "";
  }

  globalThis.LocalSystemThreadRoute = Object.freeze({
    parse,
    providerFromUrl,
    threadIdFromUrl,
  });
})();
