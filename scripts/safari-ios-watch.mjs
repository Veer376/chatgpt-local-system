import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(repoRoot, "extensions", "local-system");
const refreshScript = path.join(repoRoot, "scripts", "safari-ios-refresh.mjs");
const DEBOUNCE_MS = 450;

let debounceTimer = null;
let refreshProcess = null;
let refreshQueued = false;
let shuttingDown = false;

console.log("[safari-ios-watch] watching extensions/local-system");
console.log("[safari-ios-watch] save an extension file; after install completes, reload the Safari tab on iPhone");

const watcher = fs.watch(extensionDir, { recursive: true }, (_eventType, filename) => {
  if (!filename || shouldIgnore(filename)) return;
  refreshQueued = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runQueuedRefresh, DEBOUNCE_MS);
});

scheduleInitialRefresh();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    clearTimeout(debounceTimer);
    watcher.close();
    refreshProcess?.kill("SIGTERM");
  });
}

function scheduleInitialRefresh() {
  refreshQueued = true;
  debounceTimer = setTimeout(runQueuedRefresh, 50);
}

function runQueuedRefresh() {
  debounceTimer = null;
  if (shuttingDown || !refreshQueued) return;
  if (refreshProcess) return;

  refreshQueued = false;
  const startedAt = Date.now();
  console.log("[safari-ios-watch] refreshing iPhone Safari extension…");
  refreshProcess = spawn(process.execPath, [refreshScript, "--no-launch"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  refreshProcess.on("error", (error) => {
    console.error(`[safari-ios-watch] refresh failed to start: ${error.message}`);
  });

  refreshProcess.on("exit", (code, signal) => {
    refreshProcess = null;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (code === 0) {
      console.log(`[safari-ios-watch] installed in ${seconds}s — reload Safari to use the new extension`);
    } else {
      console.error(`[safari-ios-watch] refresh failed (${signal || `exit ${code}`}) after ${seconds}s`);
    }
    if (refreshQueued && !shuttingDown) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runQueuedRefresh, DEBOUNCE_MS);
    }
  });
}

function shouldIgnore(filename) {
  const normalized = String(filename).replaceAll("\\", "/");
  return normalized.endsWith("/.DS_Store") || normalized === ".DS_Store";
}
