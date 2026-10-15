/* global __MCP_APP_PROTOCOL_VERSION__, document, requestAnimationFrame, ResizeObserver, window */

export function createLiteApp({
  name,
  version,
  onToolInput,
  onToolInputPartial,
  onToolResult,
  onToolCancelled,
  onError,
  autoResize = true,
}) {
  let nextId = 1;
  let resizeObserver = null;
  const pending = new Map();

  const send = (message) => window.parent.postMessage(message, "*");

  const notify = (method, params = {}) => {
    send({ jsonrpc: "2.0", method, params });
  };

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });

  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  function applyHostContext(context = {}) {
    const root = document.documentElement;
    if (context.theme === "light" || context.theme === "dark") {
      root.dataset.theme = context.theme;
      root.style.colorScheme = context.theme;
    }
    const variables = context.styles?.variables;
    if (variables && typeof variables === "object") {
      for (const [key, value] of Object.entries(variables)) {
        if (typeof value === "string") root.style.setProperty(key, value);
      }
    }
    const fonts = context.styles?.css?.fonts;
    if (typeof fonts === "string" && fonts) {
      let style = document.getElementById("__mcp-host-fonts");
      if (!style) {
        style = document.createElement("style");
        style.id = "__mcp-host-fonts";
        document.head.appendChild(style);
      }
      style.textContent = fonts;
    }
  }

  function setupResize() {
    let scheduled = false;
    let previousWidth = 0;
    let previousHeight = 0;
    const report = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const html = document.documentElement;
        const previousInlineHeight = html.style.height;
        html.style.height = "max-content";
        const height = Math.ceil(html.getBoundingClientRect().height);
        html.style.height = previousInlineHeight;
        const width = Math.ceil(window.innerWidth);
        if (width !== previousWidth || height !== previousHeight) {
          previousWidth = width;
          previousHeight = height;
          notify("ui/notifications/size-changed", { width, height });
        }
      });
    };
    report();
    resizeObserver = new ResizeObserver(report);
    resizeObserver.observe(document.documentElement);
    resizeObserver.observe(document.body);
  }

  function handleMessage(event) {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;

    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || "MCP App request failed"));
      else waiter.resolve(message.result);
      return;
    }

    if (message.method === "ui/notifications/tool-result") {
      const params = message.params;
      if (params && !params.structuredContent && Array.isArray(params.content)) {
        const text = params.content.find((b) => b?.type === "text")?.text;
        if (typeof text === "string") {
          const match = text.match(/```json\s*([\s\S]*?)\s*```/);
          if (match) {
            try {
              params.structuredContent = JSON.parse(match[1]);
            } catch {}
          }
        }
      }
      onToolResult?.(params);
      return;
    }

    if (message.method === "ui/notifications/tool-input") {
      onToolInput?.(message.params);
      return;
    }

    if (message.method === "ui/notifications/tool-input-partial") {
      onToolInputPartial?.(message.params);
      return;
    }

    if (message.method === "ui/notifications/tool-cancelled") {
      onToolCancelled?.(message.params);
      return;
    }

    if (message.method === "ui/notifications/host-context-changed") {
      applyHostContext(message.params);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      if (message.method === "ping" || message.method === "ui/resource-teardown") reply(message.id, {});
      else replyError(message.id, -32601, `Unsupported app method: ${message.method}`);
    }
  }

  window.addEventListener("message", handleMessage);

  return {
    async connect() {
      try {
        const initialized = await request("ui/initialize", {
          appInfo: { name, version },
          appCapabilities: {},
          protocolVersion: __MCP_APP_PROTOCOL_VERSION__,
        });
        applyHostContext(initialized?.hostContext);
        notify("ui/notifications/initialized", {});
        if (autoResize) setupResize();
        return initialized;
      } catch (error) {
        onError?.(error);
        throw error;
      }
    },

    callServerTool({ name: toolName, arguments: args = {} }) {
      return request("tools/call", { name: toolName, arguments: args });
    },

    readServerResource({ uri }) {
      return request("resources/read", { uri });
    },

    close() {
      resizeObserver?.disconnect();
      window.removeEventListener("message", handleMessage);
      for (const waiter of pending.values()) waiter.reject(new Error("MCP App closed"));
      pending.clear();
    },
  };
}
