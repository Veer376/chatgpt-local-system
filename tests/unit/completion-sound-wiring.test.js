import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(
  new URL("../../extensions/local-system/manifest.json", import.meta.url),
  "utf8",
));
const dashboard = readFileSync(
  new URL("../../extensions/local-system/thread-dashboard.js", import.meta.url),
  "utf8",
);
const background = readFileSync(
  new URL("../../extensions/local-system/background.js", import.meta.url),
  "utf8",
);
const dashboardCss = readFileSync(
  new URL("../../extensions/local-system/thread-dashboard.css", import.meta.url),
  "utf8",
);
const offscreenHtml = readFileSync(
  new URL("../../extensions/local-system/offscreen-audio.html", import.meta.url),
  "utf8",
);
const offscreenAudio = readFileSync(
  new URL("../../extensions/local-system/offscreen-audio.js", import.meta.url),
  "utf8",
);

test("Local System completion sound triggers only on a real active-to-inactive transition", () => {
  assert.match(dashboard, /const previousStatus = state\.bridgeStatus/);
  assert.match(dashboard, /previousStatus === "active" && nextStatus === "inactive"/);
  assert.match(dashboard, /const identity = completionIdentity\(\)/);
  assert.match(dashboard, /requestCompletionSignal\(lastActivityAt, identity\)/);
  assert.match(dashboard, /action:\s*"play-completion-sound"/);
  assert.match(dashboard, /completionKey:\s*String\(lastActivityAt\)/);
  assert.match(dashboard, /threadTitle:\s*identity\.threadTitle/);
  assert.match(dashboard, /projectName:\s*identity\.projectName/);
  assert.doesNotMatch(dashboard, /document\.visibilityState !== "visible"\) return;[\s\S]{0,120}loadBridgeStatus/);
});

test("completion feedback uses Chrome offscreen audio and one deduplicated clickable notification", () => {
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.ok(manifest.permissions.includes("alarms"));
  assert.match(background, /message\.action === "play-completion-sound"/);
  assert.match(background, /handleCompletionSignal\(message, sender\)/);
  assert.match(background, /const completionSoundEvents = new Map\(\)/);
  assert.match(background, /const dedupeKey = `\$\{threadId\}::\$\{completionKey\}`/);
  assert.match(background, /completionSoundEvents\.has\(dedupeKey\)/);
  assert.match(background, /title:\s*"Local System finished"/);
  assert.match(background, /silent:\s*true/);
  assert.match(background, /notificationTargets\.set\(notificationId, target\)/);
  assert.match(background, /Number\.isInteger\(sender\?\.tab\?\.id\)/);
  assert.match(background, /if \(target\.url\) update\.url = target\.url/);
  assert.match(background, /chrome\.tabs\.update\(target\.tabId, update\)/);
  assert.match(background, /chrome\.offscreen\.createDocument\(\{/);
  assert.match(background, /reasons:\s*\["AUDIO_PLAYBACK"\]/);
  assert.match(background, /target:\s*"local-system-offscreen-audio"/);
  assert.match(background, /action:\s*"play-completion-chime"/);
  assert.match(background, /COMPLETION_SOUND_ENABLED_STORAGE_KEY = "localSystemCompletionSoundEnabledV1"/);
  assert.match(background, /const soundEnabled = await isCompletionSoundEnabled\(\)/);
  assert.match(background, /if \(soundEnabled\) \{/);
  assert.match(background, /return stored\?\.\[COMPLETION_SOUND_ENABLED_STORAGE_KEY\] !== false/);
});

test("thread completion watches survive SPA navigation and are polled by the background worker", () => {
  assert.match(dashboard, /action:\s*"watch-thread-completion"/);
  assert.match(dashboard, /threadUrl:\s*globalThis\.location\?\.href/);
  assert.match(dashboard, /active:\s*active === true/);
  assert.match(background, /COMPLETION_WATCHES_STORAGE_KEY/);
  assert.match(background, /COMPLETION_WATCH_ALARM/);
  assert.match(background, /periodInMinutes:\s*COMPLETION_WATCH_PERIOD_MINUTES/);
  assert.match(background, /chrome\.alarms\?\.onAlarm/);
  assert.match(background, /pollCompletionWatches\(\)/);
  assert.match(background, /postLocalApiRequest\("\/local-ui\/activity"/);
  assert.match(background, /watch\.wasActive = true/);
  assert.match(background, /if \(watch\.wasActive !== true\) continue/);
  assert.match(background, /delete watches\[threadId\]/);
  assert.match(background, /chrome\.storage\?\.session \|\| chrome\.storage\?\.local/);
});

test("completion notification stores a durable exact-thread target and restores that URL on click", () => {
  assert.match(background, /completionThreadUrl\(message\.threadUrl \|\| message\.target\?\.url \|\| sender\?\.tab\?\.url, threadId\)/);
  assert.match(background, /url:\s*threadUrl/);
  assert.match(background, /notificationTargetStorageKey\(notificationId\)/);
  assert.match(background, /await area\.set\(\{ \[notificationTargetStorageKey\(notificationId\)\]: target \}\)/);
  assert.match(background, /const target = await takeNotificationTarget\(notificationId\)/);
  assert.match(background, /if \(target\.url\) update\.url = target\.url/);
  assert.match(background, /https:\/\/chatgpt\.com\/c\/\$\{encodeURIComponent\(threadId\)\}/);
});

test("offscreen document owns the unique synthesized completion chime", () => {
  assert.match(offscreenHtml, /<script src="offscreen-audio\.js"><\/script>/);
  assert.match(offscreenAudio, /globalThis\.AudioContext \|\| globalThis\.webkitAudioContext/);
  assert.match(offscreenAudio, /659\.25/);
  assert.match(offscreenAudio, /830\.61/);
  assert.match(offscreenAudio, /1046\.50/);
  assert.match(offscreenAudio, /frequency \* 2/);
  assert.match(offscreenAudio, /play-completion-chime/);
});

test("completion transition shows a small in-page visual and status-dot pulse", () => {
  assert.match(dashboard, /showCompletionVisual\(identity\)/);
  assert.match(dashboard, /Local System finished/);
  assert.match(dashboard, /label\.textContent = identity\.label/);
  assert.match(dashboard, /dataset\.completionPulse = "true"/);
  assert.match(dashboard, /2_600/);
  assert.match(dashboardCss, /\.ls-local-system-completion-toast\s*\{/);
  assert.match(dashboardCss, /top:\s*16px/);
  assert.match(dashboardCss, /right:\s*16px/);
  assert.match(dashboardCss, /data-completion-pulse="true"/);
  assert.match(dashboardCss, /@keyframes ls-local-system-completion-pulse/);
});

test("completion identity prefers thread title, then project name, then a shortened thread id", () => {
  assert.match(dashboard, /const threadTitle = normalizedThreadTitle\(\)/);
  assert.match(dashboard, /const projectName = workspaceName\(state\.currentWorkspace\)/);
  assert.match(dashboard, /label:\s*threadTitle \|\| projectName \|\| fallback/);
  assert.match(dashboard, /slice\(0, 8\)/);
  assert.match(dashboard, /document\.title/);
  assert.match(dashboard, /local-system-project-changed/);
  assert.match(dashboard, /action:\s*"context"/);
  assert.match(background, /completionNotificationMessage\(message, threadId\)/);
  assert.match(background, /Project: \$\{projectName\}/);
});
