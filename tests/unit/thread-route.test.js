import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../extensions/local-system/thread-route.js", import.meta.url),
  "utf8",
);

function loadParser() {
  const sandbox = { URL };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "thread-route.js" });
  return sandbox.LocalSystemThreadRoute;
}

test("thread route parser keeps ChatGPT and Claude URL semantics isolated", () => {
  const parser = loadParser();

  assert.deepEqual(
    { ...parser.parse("https://chatgpt.com/c/chat-thread-123?foo=bar") },
    { provider: "chatgpt", threadId: "chat-thread-123" },
  );
  assert.deepEqual(
    { ...parser.parse("https://claude.ai/chat/claude-thread-456") },
    { provider: "claude", threadId: "claude-thread-456" },
  );
  assert.deepEqual(
    { ...parser.parse("https://www.claude.ai/chat/claude-thread-789") },
    { provider: "claude", threadId: "claude-thread-789" },
  );

  assert.equal(parser.parse("https://chatgpt.com/chat/not-chatgpt"), null);
  assert.equal(parser.parse("https://claude.ai/c/not-claude"), null);
  assert.equal(parser.parse("https://example.com/c/not-a-supported-provider"), null);
});

test("thread route parser returns empty thread ids for new-chat and invalid URLs", () => {
  const parser = loadParser();
  assert.equal(parser.threadIdFromUrl("https://chatgpt.com/"), "");
  assert.equal(parser.threadIdFromUrl("https://claude.ai/new"), "");
  assert.equal(parser.threadIdFromUrl("not-a-url"), "");
  assert.equal(parser.providerFromUrl("https://chatgpt.com/"), "chatgpt");
  assert.equal(parser.providerFromUrl("https://claude.ai/new"), "claude");
  assert.equal(parser.providerFromUrl("https://example.com/"), "");
});
