/* global chrome */

(() => {
  if (globalThis.LocalSystemExtensionApi) return;

  const SOURCE = "local-system-extension-api";
  const DEFAULT_TIMEOUT_MS = 8_000;

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        try {
          chrome.runtime.sendMessage(message, (response) => {
            if (settled) return;
            settled = true;
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              reject(new Error(runtimeError.message || "Local System extension runtime unavailable"));
              return;
            }
            callback(response);
          });
        } catch (error) {
          settled = true;
          reject(error);
        }
      };
      finish((response) => resolve(response));
    });
  }

  async function request(path, body = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (signal?.aborted) throw abortError();
    const requestId = crypto.randomUUID();
    let timeout = 0;
    let abortHandler = null;

    const requestPromise = runtimeMessage({
      source: SOURCE,
      action: "request",
      requestId,
      path,
      body,
      timeoutMs,
    }).then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Local System unavailable");
      return response.payload;
    });

    const cancellationPromise = new Promise((_, reject) => {
      const cancel = (error) => {
        void runtimeMessage({ source: SOURCE, action: "cancel", requestId }).catch(() => {});
        reject(error);
      };
      abortHandler = () => cancel(abortError());
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeout = globalThis.setTimeout(() => cancel(new Error("Local System request timed out")), timeoutMs + 250);
      }
    });

    try {
      return await Promise.race([requestPromise, cancellationPromise]);
    } finally {
      if (timeout) globalThis.clearTimeout(timeout);
      if (abortHandler) signal?.removeEventListener?.("abort", abortHandler);
    }
  }

  function abortError() {
    const error = new Error("Local System request cancelled");
    error.name = "AbortError";
    return error;
  }

  globalThis.LocalSystemExtensionApi = Object.freeze({ request });
})();
