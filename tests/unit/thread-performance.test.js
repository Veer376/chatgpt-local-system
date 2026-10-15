import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { normalizeThreadPerformanceSample } from "../../src/lib/local-thread-performance.js";

const manifest = JSON.parse(readFileSync(new URL("../../extensions/local-system/manifest.json", import.meta.url), "utf8"));
const threadRouteScript = readFileSync(new URL("../../extensions/local-system/thread-route.js", import.meta.url), "utf8");
const sharedRuntimeScript = readFileSync(new URL("../../extensions/local-system/shared-runtime.js", import.meta.url), "utf8");
const script = readFileSync(new URL("../../extensions/local-system/thread-performance.js", import.meta.url), "utf8");

function loadReporter() {
  const messages = [];
  const listeners = new Map();
  const docListeners = new Map();
  const session = new Map([["local-system:thread-tail-stats", JSON.stringify({ total: 2, initial: 1, history: 1, lastAppliedTurns: 1 })]]);
  let uuid = 0;
  const document = {
    visibilityState: "visible",
    body: { innerText: "hello world" },
    querySelectorAll(selector) {
      if (selector.includes("conversation-turn")) return { length: 3 };
      if (selector.includes('="tool"')) return { length: 2 };
      if (selector.includes("data-message-author-role")) return { length: 7 };
      return { length: 0 };
    },
    getElementsByTagName(name) { return { length: name === "*" ? 321 : name === "iframe" ? 4 : 0 }; },
    addEventListener(type, callback) { docListeners.set(type, callback); },
  };
  const context = {
    document,
    location: {
      href: "https://chatgpt.com/c/thread-1?model=x",
      pathname: "/c/thread-1",
      search: "?model=x",
    },
    localStorage: { getItem: () => null },
    sessionStorage: {
      getItem: (key) => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, String(value)),
    },
    performance: {
      memory: { usedJSHeapSize: 123, totalJSHeapSize: 456, jsHeapSizeLimit: 789 },
      getEntriesByType: () => [{ type: "navigate", activationStart: 0, notRestoredReasons: null }],
    },
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    chrome: { runtime: { sendMessage(message) { messages.push(message); return Promise.resolve({ ok: true }); } } },
    addEventListener(type, callback) { listeners.set(type, callback); },
    setTimeout() { return 1; },
    clearTimeout() {},
    Date,
    Math,
    JSON,
  };
  context.globalThis = context;
  context.URL = URL;
  vm.runInNewContext(threadRouteScript, context, { filename: "thread-route.js" });
  vm.runInNewContext(sharedRuntimeScript, context, { filename: "shared-runtime.js" });
  vm.runInNewContext(script, context, { filename: "thread-performance.js" });
  return { messages, listeners, docListeners };
}

test("performance reporter is an isolated document-idle script", () => {
  const entry = manifest.content_scripts.find((item) => item.js?.includes("thread-performance.js"));
  assert.ok(entry);
  assert.equal(entry.run_at, "document_idle");
  assert.equal(entry.world, undefined);
});

test("performance reporter records heap, DOM, visible turns, and clamp activity", () => {
  const harness = loadReporter();
  assert.equal(harness.messages.length, 1);
  const sample = harness.messages[0].sample;
  assert.equal(sample.reason, "content-ready");
  assert.equal(sample.threadId, "thread-1");
  assert.equal(sample.memory.usedJSHeapSize, 123);
  assert.equal(sample.domNodes, 321);
  assert.equal(sample.conversationTurns, 3);
  assert.equal(sample.messageRoles, 7);
  assert.equal(sample.toolMessages, 2);
  assert.equal(sample.iframes, 4);
  assert.equal(sample.clamp.total, 2);
  assert.equal(sample.clamp.lastAppliedTurns, 1);
});

test("performance reporter marks BFCache restores explicitly", () => {
  const harness = loadReporter();
  harness.listeners.get("pageshow")({ persisted: true });
  assert.equal(harness.messages.at(-1).sample.reason, "pageshow-bfcache");
  assert.equal(harness.messages.at(-1).sample.persisted, true);
});

test("server-side telemetry normalization keeps only bounded diagnostic fields", () => {
  const sample = normalizeThreadPerformanceSample({
    id: "id-1",
    at: "2026-09-15T15:00:00.000Z",
    reason: "interval",
    sessionId: "session-1",
    threadId: "thread-1",
    path: "/c/thread-1",
    visibility: "visible",
    memory: { usedJSHeapSize: 10.4, totalJSHeapSize: 20.8, jsHeapSizeLimit: 100 },
    domNodes: 12,
    conversationTurns: 3,
    messageRoles: 6,
    toolMessages: 1,
    iframes: 2,
    bodyTextChars: 42,
    clamp: { total: 1, lastAppliedTurns: 1 },
    navigation: { type: "navigate" },
  }, { tabId: 7, windowId: 8 });
  assert.equal(sample.tabId, 7);
  assert.equal(sample.windowId, 8);
  assert.equal(sample.memory.usedJSHeapSize, 10);
  assert.equal(sample.conversationTurns, 3);
  assert.deepEqual(sample.clamp, { total: 1, lastAppliedTurns: 1 });
});
