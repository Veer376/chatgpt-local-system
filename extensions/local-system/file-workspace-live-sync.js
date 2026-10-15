(() => {
  const RETRY_BASE_MS = 700;
  const RETRY_MAX_MS = 5_000;

  function createWorkspaceLiveSync({ poll, onChange }) {
    let enabled = false;
    let generation = 0;
    let controller = null;
    let version = 0;
    let workspace = "";

    function setEnabled(nextEnabled, { reset = false } = {}) {
      const next = nextEnabled === true;
      if (reset) {
        version = 0;
        workspace = "";
      }
      if (next === enabled && !reset) return;
      enabled = next;
      generation += 1;
      controller?.abort();
      controller = null;
      if (enabled) void run(generation);
    }

    function reset() {
      setEnabled(enabled, { reset: true });
    }

    function stop() {
      setEnabled(false);
    }

    async function run(runGeneration) {
      let failures = 0;
      while (enabled && runGeneration === generation) {
        const requestController = new AbortController();
        controller = requestController;
        try {
          const payload = await poll({
            since: version,
            signal: requestController.signal,
          });
          if (!enabled || runGeneration !== generation || requestController.signal.aborted) return;
          controller = null;
          failures = 0;

          const watch = payload?.watch;
          if (!watch || typeof watch !== "object") continue;
          const nextWorkspace = String(watch.workspace || "");
          if (workspace && nextWorkspace && nextWorkspace !== workspace) {
            workspace = nextWorkspace;
            version = 0;
            continue;
          }
          if (nextWorkspace) workspace = nextWorkspace;
          const nextVersion = Number(watch.version);
          if (Number.isSafeInteger(nextVersion) && nextVersion >= 0) version = nextVersion;
          if (watch.changed === true && watch.event) await onChange(watch);
        } catch (error) {
          if (!enabled || runGeneration !== generation || requestController.signal.aborted || error?.name === "AbortError") return;
          controller = null;
          failures += 1;
          const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(3, failures - 1)));
          await delay(backoff);
        }
      }
    }

    return Object.freeze({
      setEnabled,
      reset,
      stop,
    });
  }

  function delay(ms) {
    return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
  }

  globalThis.LocalSystemWorkspaceLiveSync = Object.freeze({
    createWorkspaceLiveSync,
  });
})();
