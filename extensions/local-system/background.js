/* global chrome */

const BRIDGE_ORIGINS = ["http://127.0.0.1:8765"];
const LOCAL_API_SOURCE = "local-system-extension-api";
const LOCAL_API_PATHS = new Set([
  "/local-ui/activity",
  "/local-ui/annotations",
  "/local-ui/file-workspace",
  "/local-ui/files/content-search",
  "/local-ui/files/html-preview",
  "/local-ui/files/resolve",
  "/local-ui/files/search",
  "/local-ui/turn-checkpoint",
  "/local-ui/files/write",
  "/local-ui/git",
  "/local-ui/interactions",
  "/local-ui/skills",
  "/local-ui/thread-bind",
  "/local-ui/thread-bind-intent",
  "/local-ui/thread-bind-observed",
  "/local-ui/thread-bind-token",
  "/local-ui/thread-performance",
  "/local-ui/todos",
  "/local-ui/workspace-trace",
]);
const localApiControllers = new Map();
let localApiSession = null;
const SIDE_PANEL_HIDDEN_SITES_KEY = "localSystemSidePanelHiddenSitesV1";
const COMPLETION_WATCHES_STORAGE_KEY = "localSystemCompletionWatchesV1";
const NOTIFICATION_TARGET_STORAGE_PREFIX = "localSystemNotificationTargetV1:";
const COMPLETION_SOUND_ENABLED_STORAGE_KEY = "localSystemCompletionSoundEnabledV1";
const COMPLETION_WATCH_ALARM = "local-system-completion-watch";
const COMPLETION_WATCH_PERIOD_MINUTES = 0.5;
const COMPLETION_WATCH_MAX_AGE_MS = 2 * 60 * 60_000;
const notificationTargets = new Map();
const completionSoundEvents = new Map();
const COMPLETION_SOUND_DEDUPE_MS = 10 * 60_000;
const OFFSCREEN_AUDIO_URL = "offscreen-audio.html";
let offscreenAudioCreation = null;
let completionWatchMutation = Promise.resolve();

configureSidePanelAction();
ensureCompletionWatchAlarm();
chrome.runtime.onInstalled?.addListener?.(configureSidePanelAction);
chrome.runtime.onStartup?.addListener?.(configureSidePanelAction);
chrome.runtime.onInstalled?.addListener?.(ensureCompletionWatchAlarm);
chrome.runtime.onStartup?.addListener?.(ensureCompletionWatchAlarm);
chrome.runtime.onInstalled?.addListener?.(() => void refreshAllSidePanelAvailability());
chrome.runtime.onStartup?.addListener?.(() => void refreshAllSidePanelAvailability());
chrome.tabs?.onActivated?.addListener?.(({ tabId }) => void refreshSidePanelForTabId(tabId));
chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") void applySidePanelAvailability(tab || { id: tabId });
});
chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName === "local" && SIDE_PANEL_HIDDEN_SITES_KEY in changes) {
    void refreshAllSidePanelAvailability();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source === LOCAL_API_SOURCE) {
    if (message.action === "cancel") {
      cancelLocalApiRequest(message.requestId);
      sendResponse({ ok: true });
      return false;
    }
    if (message.action !== "request") return undefined;
    proxyLocalApiRequest(message, sender)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }
  if (message?.source === "local-system-popup" && message.action === "api-request") {
    postLocalApiRequest(String(message.path || ""), message.body && typeof message.body === "object" ? message.body : {})
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }
  if (message?.source === "local-system-workspace") {
    const request = message.action === "side-panel-site-settings"
      ? getSidePanelSiteSettings()
      : message.action === "hide-side-panel-on-current-site"
        ? hideSidePanelOnCurrentSite()
        : message.action === "unhide-side-panel-site"
          ? unhideSidePanelSite(message.site)
          : null;
    if (!request) return undefined;
    request
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }
  if (message?.source !== "local-system-content") return undefined;
  const request = message.action === "open-side-panel"
    ? openNativeSidePanelForSender(sender)
    : message.action === "bind-thread"
    ? bindThread(message.threadId, message.sentAt)
    : message.action === "register-bind-intent"
      ? registerBindIntent(message.threadId, message.sentAt)
      : message.action === "bind-thread-observed"
        ? bindThreadObserved(message.threadId, message.conversationId)
      : message.action === "bind-thread-token"
        ? bindThreadWithToken(message.threadId, message.token)
        : message.action === "watch-thread-completion"
          ? registerCompletionWatch(message, sender)
        : message.action === "play-completion-sound"
          ? handleCompletionSignal(message, sender)
        : message.action === "notify"
          ? createLocalSystemNotification(message, sender)
          : message.action === "thread-performance"
            ? recordThreadPerformance(message.sample, sender)
            : message.action === "workspace-state-changed"
              ? broadcastWorkspaceStateChanged(message, sender)
            : null;
  if (!request) return undefined;

  request
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
});

if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (chrome.sidePanel?.open && Number.isInteger(tab?.windowId)) {
      try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      } catch {
        // setPanelBehavior also handles supported Chrome action clicks.
      }
      return;
    }
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        source: "local-system-extension-command",
        action: "toggle-standalone-workspace",
      });
    } catch {
      // Ignore pages where the fallback content script is unavailable.
    }
  });
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener(async (notificationId) => {
    const target = await takeNotificationTarget(notificationId);
    try { await chrome.notifications.clear(notificationId); } catch {}
    if (!target?.tabId && !target?.url) return;
    try {
      if (target.windowId) await chrome.windows.update(target.windowId, { focused: true });
      if (target.tabId) {
        const update = { active: true };
        if (target.url) update.url = target.url;
        await chrome.tabs.update(target.tabId, update);
      } else if (target.url) {
        await chrome.tabs.create({ url: target.url, active: true, windowId: target.windowId || undefined });
      }
    } catch {
      if (target.url) {
        try {
          await chrome.tabs.create({ url: target.url, active: true, windowId: target.windowId || undefined });
        } catch {}
      }
    }
  });
}

if (chrome.notifications?.onClosed) {
  chrome.notifications.onClosed.addListener((notificationId) => {
    void forgetNotificationTarget(notificationId);
  });
}

chrome.alarms?.onAlarm?.addListener?.((alarm) => {
  if (alarm?.name === COMPLETION_WATCH_ALARM) void pollCompletionWatches();
});

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return;
      if (command === "toggle-standalone-workspace" && chrome.sidePanel?.open && Number.isInteger(tab.windowId)) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        return;
      }
      const action = command === "toggle-file-workspace"
        ? "toggle-file-workspace"
        : (command === "toggle-standalone-workspace" ? "toggle-standalone-workspace" : "");
      if (!action) return;
      await chrome.tabs.sendMessage(tab.id, {
        source: "local-system-extension-command",
        action,
      });
    } catch {
      // Ignore tabs where the content script is not available yet.
    }
  });
}

function configureSidePanelAction() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

function siteKeyFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function hiddenSidePanelSites() {
  const stored = await chrome.storage.local.get(SIDE_PANEL_HIDDEN_SITES_KEY);
  const value = stored?.[SIDE_PANEL_HIDDEN_SITES_KEY];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((site) => String(site || "").trim().toLowerCase()).filter(Boolean))].sort();
}

async function setHiddenSidePanelSites(sites) {
  const normalized = [...new Set((Array.isArray(sites) ? sites : [])
    .map((site) => String(site || "").trim().toLowerCase())
    .filter(Boolean))].sort();
  await chrome.storage.local.set({ [SIDE_PANEL_HIDDEN_SITES_KEY]: normalized });
  return normalized;
}

async function activeBrowserTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function getSidePanelSiteSettings() {
  const [tab, hiddenSites] = await Promise.all([activeBrowserTab(), hiddenSidePanelSites()]);
  const currentSite = siteKeyFromUrl(tab?.url);
  return {
    currentSite,
    currentUrl: String(tab?.url || ""),
    canHideCurrentSite: Boolean(currentSite),
    hiddenSites,
  };
}

async function hideSidePanelOnCurrentSite() {
  const tab = await activeBrowserTab();
  const currentSite = siteKeyFromUrl(tab?.url);
  if (!currentSite) throw new Error("This page cannot be hidden by website.");
  const hiddenSites = await hiddenSidePanelSites();
  if (!hiddenSites.includes(currentSite)) hiddenSites.push(currentSite);
  const saved = await setHiddenSidePanelSites(hiddenSites);
  if (Number.isInteger(tab?.id) && chrome.sidePanel?.setOptions) {
    await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
  }
  return { currentSite, hiddenSites: saved };
}

async function unhideSidePanelSite(site) {
  const normalizedSite = String(site || "").trim().toLowerCase().replace(/^www\./, "");
  if (!normalizedSite) throw new Error("Website is required.");
  const hiddenSites = await hiddenSidePanelSites();
  const saved = await setHiddenSidePanelSites(hiddenSites.filter((item) => item !== normalizedSite));
  await refreshAllSidePanelAvailability();
  return { hiddenSites: saved };
}

async function applySidePanelAvailability(tab) {
  if (!chrome.sidePanel?.setOptions || !Number.isInteger(tab?.id)) return;
  let resolvedTab = tab;
  if (!resolvedTab.url) {
    try { resolvedTab = await chrome.tabs.get(tab.id); } catch { return; }
  }
  const site = siteKeyFromUrl(resolvedTab?.url);
  const hiddenSites = await hiddenSidePanelSites();
  const enabled = !site || !hiddenSites.includes(site);
  try {
    await chrome.sidePanel.setOptions({ tabId: resolvedTab.id, enabled });
  } catch {
    // Chrome-owned pages and browser internals may reject tab-scoped side panel options.
  }
}

async function refreshSidePanelForTabId(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await applySidePanelAvailability(tab);
  } catch {
    // The tab may have closed between activation and lookup.
  }
}

async function refreshAllSidePanelAvailability() {
  if (!chrome.tabs?.query || !chrome.sidePanel?.setOptions) return;
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => applySidePanelAvailability(tab)));
}

async function openNativeSidePanelForSender(sender) {
  if (!chrome.sidePanel?.open || !Number.isInteger(sender.tab?.windowId)) {
    return { unsupported: true };
  }
  await chrome.sidePanel.open({ windowId: sender.tab.windowId });
  return { opened: true };
}

async function broadcastWorkspaceStateChanged(message, sender) {
  const tabId = Number(sender.tab?.id);
  if (!Number.isInteger(tabId)) return { relayed: false };
  try {
    await chrome.runtime.sendMessage({
      source: "local-system-background",
      action: "workspace-state-changed",
      tabId,
      threadId: String(message.threadId || ""),
      file: message.file && typeof message.file === "object" ? message.file : null,
    });
  } catch {
    // If the side panel is still loading, its workspace will hydrate from the
    // already-persisted thread state when the frame becomes ready.
  }
  return { relayed: true };
}


async function bindThread(threadId, sentAt) {
  return postBindingRequest("/local-ui/thread-bind", { threadId, sentAt });
}

async function registerBindIntent(threadId, sentAt) {
  return postBindingRequest("/local-ui/thread-bind-intent", { threadId, sentAt });
}

async function bindThreadObserved(threadId, conversationId) {
  return postBindingRequest("/local-ui/thread-bind-observed", { threadId, conversationId });
}

async function bindThreadWithToken(threadId, token) {
  return postBindingRequest("/local-ui/thread-bind-token", { threadId, token });
}

async function recordThreadPerformance(sample, sender) {
  return postBindingRequest("/local-ui/thread-performance", {
    action: "record",
    tabId: sender.tab?.id ?? null,
    windowId: sender.tab?.windowId ?? null,
    sample,
  });
}

async function createLocalSystemNotification(message, sender) {
  if (!chrome.notifications?.create) {
    return { unsupported: true };
  }
  const title = String(message.title || "Local System").slice(0, 120);
  const body = String(message.message || "Needs your attention.").slice(0, 500);
  const notificationId = `local-system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("notification-icon.png"),
    title,
    message: body,
    priority: message.requireInteraction === true ? 2 : 1,
    requireInteraction: message.requireInteraction === true,
    silent: message.silent === true,
  });
  const target = normalizeNotificationTarget(message.target, sender);
  await rememberNotificationTarget(notificationId, target);
  return { notificationId };
}

async function handleCompletionSignal(message, sender) {
  const threadId = String(message.threadId || "").trim();
  if (threadId) await removeCompletionWatch(threadId);
  return playLocalSystemCompletionSound(message, sender);
}

async function playLocalSystemCompletionSound(message, sender) {
  const threadId = String(message.threadId || "").trim();
  const completionKey = String(message.completionKey || "").trim();
  if (!threadId || !completionKey) return { played: false, reason: "missing-key" };
  const threadUrl = completionThreadUrl(message.threadUrl || message.target?.url || sender?.tab?.url, threadId);

  const now = Date.now();
  for (const [key, at] of completionSoundEvents) {
    if (now - at > COMPLETION_SOUND_DEDUPE_MS) completionSoundEvents.delete(key);
  }
  const dedupeKey = `${threadId}::${completionKey}`;
  if (completionSoundEvents.has(dedupeKey)) return { played: false, deduped: true };
  completionSoundEvents.set(dedupeKey, now);

  const notificationMessage = completionNotificationMessage(message, threadId);
  const notification = await createLocalSystemNotification({
    title: "Local System finished",
    message: notificationMessage,
    silent: true,
    target: {
      ...(message.target && typeof message.target === "object" ? message.target : {}),
      url: threadUrl,
    },
  }, sender).catch(() => ({ unsupported: true }));

  let played = false;
  const soundEnabled = await isCompletionSoundEnabled();
  if (soundEnabled) {
    try {
      const ready = await ensureOffscreenAudioDocument();
      if (ready) {
        await chrome.runtime.sendMessage({
          source: "local-system-background",
          target: "local-system-offscreen-audio",
          action: "play-completion-chime",
        });
        played = true;
      }
    } catch {
      // The visual notification still identifies and links to the finished thread.
    }
  }
  return { played, soundEnabled, notificationId: notification?.notificationId || null };
}

async function isCompletionSoundEnabled() {
  try {
    const stored = await chrome.storage.local.get(COMPLETION_SOUND_ENABLED_STORAGE_KEY);
    return stored?.[COMPLETION_SOUND_ENABLED_STORAGE_KEY] !== false;
  } catch {
    return true;
  }
}

function completionNotificationMessage(message, threadId) {
  const threadTitle = compactLabel(message.threadTitle, 100);
  const projectName = compactLabel(message.projectName, 80);
  if (threadTitle && projectName && threadTitle.toLowerCase() !== projectName.toLowerCase()) {
    return `${threadTitle}\nProject: ${projectName}`;
  }
  return threadTitle || projectName || `Thread ${threadId.slice(0, 8)}`;
}

function compactLabel(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function ensureCompletionWatchAlarm() {
  if (!chrome.alarms?.create) return;
  chrome.alarms.create(COMPLETION_WATCH_ALARM, {
    delayInMinutes: COMPLETION_WATCH_PERIOD_MINUTES,
    periodInMinutes: COMPLETION_WATCH_PERIOD_MINUTES,
  });
}

async function registerCompletionWatch(message, sender) {
  const threadId = String(message.threadId || "").trim();
  if (!threadId) return { watching: false, reason: "missing-thread" };
  const now = Date.now();
  const threadUrl = completionThreadUrl(message.threadUrl || sender?.tab?.url, threadId);
  const threadTitle = compactLabel(message.threadTitle, 100);
  const projectName = compactLabel(message.projectName, 80);
  const lastActivityAt = String(message.lastActivityAt || "").trim();

  await mutateCompletionWatches((watches) => {
    const previous = watches[threadId] || {};
    watches[threadId] = {
      threadId,
      threadUrl: threadUrl || previous.threadUrl || "",
      threadTitle: threadTitle || previous.threadTitle || "",
      projectName: projectName || previous.projectName || "",
      tabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : previous.tabId ?? null,
      windowId: Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : previous.windowId ?? null,
      wasActive: previous.wasActive === true || message.active === true,
      lastActivityAt: lastActivityAt || previous.lastActivityAt || "",
      registeredAt: Number(previous.registeredAt) || now,
      refreshedAt: now,
    };
  });
  ensureCompletionWatchAlarm();
  return { watching: true };
}

async function removeCompletionWatch(threadId) {
  const key = String(threadId || "").trim();
  if (!key) return;
  await mutateCompletionWatches((watches) => {
    delete watches[key];
  });
}

async function pollCompletionWatches() {
  await mutateCompletionWatches(async (watches) => {
    const now = Date.now();
    for (const [threadId, watch] of Object.entries(watches)) {
      if (!watch || now - Number(watch.refreshedAt || watch.registeredAt || 0) > COMPLETION_WATCH_MAX_AGE_MS) {
        delete watches[threadId];
        continue;
      }

      let payload;
      try {
        payload = await postLocalApiRequest("/local-ui/activity", {
          threadId,
          action: "status",
        }, { timeoutMs: 3_000 });
      } catch {
        continue;
      }

      if (payload?.bound !== true) {
        delete watches[threadId];
        continue;
      }

      const active = payload?.bridgeActive === true;
      const lastActivityAt = String(payload?.lastToolAt || payload?.lastBridgeAt || watch.lastActivityAt || "").trim();
      if (active) {
        watch.wasActive = true;
        if (lastActivityAt) watch.lastActivityAt = lastActivityAt;
        continue;
      }
      if (watch.wasActive !== true) continue;

      const completionKey = lastActivityAt || watch.lastActivityAt || String(now);
      await playLocalSystemCompletionSound({
        threadId,
        completionKey,
        threadTitle: watch.threadTitle,
        projectName: watch.projectName,
        target: {
          tabId: watch.tabId,
          windowId: watch.windowId,
          url: watch.threadUrl,
        },
      }, null);
      delete watches[threadId];
    }
  });
}

function mutateCompletionWatches(mutator) {
  const run = completionWatchMutation.then(async () => {
    const area = extensionSessionStorage();
    if (!area) return;
    const stored = await area.get(COMPLETION_WATCHES_STORAGE_KEY);
    const watches = stored?.[COMPLETION_WATCHES_STORAGE_KEY];
    const next = watches && typeof watches === "object" && !Array.isArray(watches) ? { ...watches } : {};
    await mutator(next);
    await area.set({ [COMPLETION_WATCHES_STORAGE_KEY]: next });
  });
  completionWatchMutation = run.catch(() => {});
  return run;
}

function completionThreadUrl(value, threadId) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "https:" && url.hostname === "chatgpt.com" && url.pathname.split("/").includes(threadId)) {
      return url.href;
    }
  } catch {}
  return `https://chatgpt.com/c/${encodeURIComponent(threadId)}`;
}

function normalizeNotificationTarget(explicitTarget, sender) {
  const source = explicitTarget && typeof explicitTarget === "object" ? explicitTarget : {};
  return {
    tabId: Number.isInteger(source.tabId) ? source.tabId : (Number.isInteger(sender?.tab?.id) ? sender.tab.id : null),
    windowId: Number.isInteger(source.windowId) ? source.windowId : (Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : null),
    url: typeof source.url === "string" && source.url ? source.url : "",
  };
}

function notificationTargetStorageKey(notificationId) {
  return `${NOTIFICATION_TARGET_STORAGE_PREFIX}${notificationId}`;
}

async function rememberNotificationTarget(notificationId, target) {
  if (!target?.tabId && !target?.url) return;
  notificationTargets.set(notificationId, target);
  const area = extensionSessionStorage();
  if (!area) return;
  await area.set({ [notificationTargetStorageKey(notificationId)]: target });
}

async function takeNotificationTarget(notificationId) {
  const cached = notificationTargets.get(notificationId);
  notificationTargets.delete(notificationId);
  const area = extensionSessionStorage();
  if (!area) return cached || null;
  const key = notificationTargetStorageKey(notificationId);
  const stored = await area.get(key);
  await area.remove(key);
  return cached || stored?.[key] || null;
}

async function forgetNotificationTarget(notificationId) {
  notificationTargets.delete(notificationId);
  const area = extensionSessionStorage();
  if (area) await area.remove(notificationTargetStorageKey(notificationId));
}

function extensionSessionStorage() {
  return chrome.storage?.session || chrome.storage?.local || null;
}

async function ensureOffscreenAudioDocument() {
  if (!chrome.offscreen?.createDocument) return false;
  if (offscreenAudioCreation) {
    await offscreenAudioCreation;
    return true;
  }

  const documentUrl = chrome.runtime.getURL(OFFSCREEN_AUDIO_URL);
  const hasDocument = async () => {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [documentUrl],
      });
      return contexts.length > 0;
    }
    if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
    return false;
  };

  if (await hasDocument()) return true;
  offscreenAudioCreation = chrome.offscreen.createDocument({
    url: OFFSCREEN_AUDIO_URL,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play a Local System completion chime when thread activity stops.",
  });
  try {
    await offscreenAudioCreation;
  } finally {
    offscreenAudioCreation = null;
  }
  return true;
}

async function postBindingRequest(path, body) {
  return postLocalApiRequest(path, body, { timeoutMs: 1_500 });
}

async function proxyLocalApiRequest(message, sender) {
  if (sender?.id !== chrome.runtime.id) throw new Error("Untrusted Local System extension sender");
  const requestId = String(message.requestId || "");
  const path = String(message.path || "");
  if (!requestId) throw new Error("Local System request id required");
  if (!LOCAL_API_PATHS.has(path)) throw new Error("Unsupported Local System API path");
  const controller = new AbortController();
  localApiControllers.set(requestId, controller);
  try {
    return await postLocalApiRequest(path, message.body && typeof message.body === "object" ? message.body : {}, {
      signal: controller.signal,
      timeoutMs: clampLocalApiTimeout(message.timeoutMs),
    });
  } finally {
    localApiControllers.delete(requestId);
  }
}

function cancelLocalApiRequest(requestId) {
  const id = String(requestId || "");
  const controller = localApiControllers.get(id);
  if (!controller) return;
  localApiControllers.delete(id);
  controller.abort();
}

function clampLocalApiTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 8_000;
  return Math.max(500, Math.min(65_000, Math.round(parsed)));
}

async function postLocalApiRequest(path, body, { signal, timeoutMs = 8_000 } = {}) {
  if (!LOCAL_API_PATHS.has(path)) throw new Error("Unsupported Local System API path");
  let lastError = null;
  for (const origin of BRIDGE_ORIGINS) {
    try {
      return await requestLocalApiOrigin(origin, path, body, { signal, timeoutMs });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("Local System unavailable");
}

async function requestLocalApiOrigin(origin, path, body, { signal, timeoutMs }) {
  let session = await localApiSessionFor(origin);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener?.("abort", abort, { once: true });
    try {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-system-session": session.token,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        localApiSession = null;
        session = await localApiSessionFor(origin, { force: true });
        continue;
      }
      throw new Error(payload.error || `HTTP ${response.status}`);
    } finally {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
    }
  }
  throw new Error("Local System authentication failed");
}

async function localApiSessionFor(origin, { force = false } = {}) {
  const now = Date.now();
  if (!force && localApiSession?.origin === origin && localApiSession.expiresAt > now + 5_000) {
    return localApiSession;
  }
  const response = await fetch(`${origin}/local-ui/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.token !== "string" || !payload.token) {
    throw new Error(payload.error || "Local System extension authentication failed");
  }
  localApiSession = {
    origin,
    token: payload.token,
    expiresAt: Number(payload.expiresAt) || (Date.now() + 60_000),
  };
  return localApiSession;
}
