(() => {
  const DISABLE_KEY = "local-system:thread-hard-navigation";
  const THREAD_PATH = /^(?:\/c\/[^/?#]+|\/g\/[^/?#]+\/c\/[^/?#]+)\/?$/;

  function enabled() {
    try {
      return globalThis.localStorage?.getItem(DISABLE_KEY) !== "off";
    } catch {
      return true;
    }
  }

  function conversationUrlForClick(event) {
    if (!enabled() || event.defaultPrevented || event.button !== 0) return null;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;

    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    const anchor = path.find((node) => node?.tagName === "A" && typeof node.href === "string");
    if (!anchor || anchor.download) return null;
    if (anchor.target && anchor.target !== "_self") return null;

    let url;
    try {
      url = new URL(anchor.href, globalThis.location?.href || "https://chatgpt.com/");
    } catch {
      return null;
    }
    if (url.origin !== "https://chatgpt.com" || !THREAD_PATH.test(url.pathname)) return null;
    if (url.pathname === globalThis.location?.pathname && url.search === globalThis.location?.search) return null;
    return url;
  }

  globalThis.addEventListener("click", (event) => {
    const url = conversationUrlForClick(event);
    if (!url) return;

    event.preventDefault();
    event.stopPropagation();
    globalThis.location.replace(url.toString());
  }, true);
})();
