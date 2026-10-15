import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const manifest = JSON.parse(readFileSync(
  new URL("../../extensions/local-system/manifest.json", import.meta.url),
  "utf8",
));
const script = readFileSync(
  new URL("../../extensions/local-system/thread-tail-clamp.js", import.meta.url),
  "utf8",
);

function loadClamp({ disabled = false } = {}) {
  const calls = [];
  const messages = [];
  const storage = new Map(disabled ? [["local-system:thread-tail-clamp", "off"]] : []);
  const session = new Map();
  const context = {
    URL,
    Request,
    location: { href: "https://chatgpt.com/", origin: "https://chatgpt.com" },
    localStorage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
    },
    sessionStorage: {
      getItem(key) {
        return session.get(key) ?? null;
      },
      setItem(key, value) {
        session.set(key, String(value));
      },
    },
    fetch(input, init) {
      calls.push({ input, init });
      return Promise.resolve({ ok: true });
    },
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    },
  };
  context.globalThis = context;
  vm.runInNewContext(script, context, { filename: "thread-tail-clamp.js" });
  return { calls, fetch: context.fetch, messages, session };
}

function calledUrl(call) {
  return call.input instanceof Request ? call.input.url : String(call.input);
}

test("thread tail clamp loads in the main world at document_start before idle content scripts", () => {
  const entries = manifest.content_scripts?.filter((entry) => entry.matches?.includes("https://chatgpt.com/*")) ?? [];
  const clamp = entries.find((entry) => entry.js?.includes("thread-tail-clamp.js"));
  const idle = entries.find((entry) => entry.js?.includes("content.js"));
  assert.ok(clamp, "expected a dedicated ChatGPT thread-tail content script");
  assert.equal(clamp.run_at, "document_start");
  assert.equal(clamp.world, "MAIN");
  assert.ok(idle, "expected the existing Local System content scripts");
  assert.equal(idle.run_at, "document_idle");
});

test("initial conversation reads are clamped to three turns without changing other query parameters", async () => {
  const harness = loadClamp();
  await harness.fetch("https://chatgpt.com/backend-api/conversations/abc?include_has_versions=true&num_turns=10");
  assert.equal(harness.calls.length, 1);
  const url = new URL(calledUrl(harness.calls[0]));
  assert.equal(url.searchParams.get("num_turns"), "3");
  assert.equal(url.searchParams.get("include_has_versions"), "true");
});

test("older-history page reads keep the cursor and use the same three-turn page size", async () => {
  const harness = loadClamp();
  await harness.fetch("/backend-api/conversations/abc/messages?before=cursor-123&include_has_versions=true&num_turns=10");
  const url = new URL(calledUrl(harness.calls[0]));
  assert.equal(url.pathname, "/backend-api/conversations/abc/messages");
  assert.equal(url.searchParams.get("before"), "cursor-123");
  assert.equal(url.searchParams.get("num_turns"), "3");
});



test("clamped requests record lightweight session diagnostics", async () => {
  const harness = loadClamp();
  await harness.fetch("https://chatgpt.com/backend-api/conversations/abc?num_turns=10");
  await harness.fetch("https://chatgpt.com/backend-api/conversations/abc/messages?before=x&num_turns=10");
  const stats = JSON.parse(harness.session.get("local-system:thread-tail-stats"));
  assert.equal(stats.total, 2);
  assert.equal(stats.initial, 1);
  assert.equal(stats.history, 1);
  assert.equal(stats.lastOriginalTurns, 10);
  assert.equal(stats.lastAppliedTurns, 3);
});

test("authenticated Request objects preserve request metadata when only the URL is clamped", async () => {
  const harness = loadClamp();
  const request = new Request("https://chatgpt.com/backend-api/conversations/abc?num_turns=10", {
    method: "GET",
    headers: { authorization: "Bearer test", "x-test": "kept" },
    credentials: "include",
  });
  await harness.fetch(request);
  const forwarded = harness.calls[0].input;
  assert.ok(forwarded instanceof Request);
  assert.equal(new URL(forwarded.url).searchParams.get("num_turns"), "3");
  assert.equal(forwarded.headers.get("authorization"), "Bearer test");
  assert.equal(forwarded.headers.get("x-test"), "kept");
  assert.equal(forwarded.credentials, "include");
});

test("unrelated requests, writes, missing limits, and already-small pages pass through unchanged", async () => {
  const harness = loadClamp();
  const cases = [
    ["https://chatgpt.com/backend-api/conversations?offset=0&limit=28", undefined],
    ["https://chatgpt.com/backend-api/conversations/abc?include_has_versions=true", undefined],
    ["https://chatgpt.com/backend-api/conversations/abc?num_turns=1", undefined],
    ["https://chatgpt.com/backend-api/conversations/abc?num_turns=3", undefined],
    ["https://example.com/backend-api/conversations/abc?num_turns=10", undefined],
    ["https://chatgpt.com/backend-api/conversations/abc?num_turns=10", { method: "POST" }],
  ];
  for (const [input, init] of cases) {
    await harness.fetch(input, init);
    assert.equal(calledUrl(harness.calls.at(-1)), input);
  }
});

test("the localStorage kill switch disables request rewriting", async () => {
  const harness = loadClamp({ disabled: true });
  const input = "https://chatgpt.com/backend-api/conversations/abc?num_turns=10";
  await harness.fetch(input);
  assert.equal(calledUrl(harness.calls[0]), input);
});

test("bridge_context MCP requests expose their conversation id to the isolated extension without changing the request", async () => {
  const harness = loadClamp();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "bridge_context",
      arguments: {},
      _meta: {
        "openai/session": "v1/browser-observed-session",
        "openai/userAgent": "Mozilla/5.0",
      },
    },
  });

  await harness.fetch("http://127.0.0.1:8765/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].init.body, body, "observer must not modify the MCP request body");
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].message.source, "local-system-mcp-observer");
  assert.equal(harness.messages[0].message.conversationId, "v1/browser-observed-session");
  assert.equal(harness.messages[0].targetOrigin, "https://chatgpt.com");
});

test("non-bridge MCP calls do not emit browser binding observations", async () => {
  const harness = loadClamp();
  await harness.fetch("http://127.0.0.1:8765/mcp", {
    method: "POST",
    body: JSON.stringify({
      method: "tools/call",
      params: { name: "workspace", _meta: { "openai/session": "v1/not-bridge" } },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.messages, []);
});
