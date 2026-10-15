import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-system-turn-checkpoint-"));
process.env.BRIDGE_STATE_DIR = stateDir;
process.env.TURN_CHECKPOINT_MS = String(20 * 60_000);

const { instrumentServer } = await import("../../src/lib/audit.js");
const { TURN_CHECKPOINT_MESSAGE } = await import("../../src/lib/turn-checkpoint.js");
const { runWithConversationId } = await import("../../src/lib/conversation.js");

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
      return handler;
    },
  };
}

test("audit instrumentation starts at bridge_context and appends one assistant-only checkpoint later", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const server = instrumentServer(fakeServer());
    server.registerTool("bridge_context", {}, async () => ({
      content: [{ type: "text", text: "context" }],
    }));
    server.registerTool("worker", {}, async () => ({
      content: [{ type: "text", text: "worker done" }],
    }));

    await runWithConversationId("thread-checkpoint", () => (
      server.handlers.get("bridge_context")({}, {})
    ));

    now += 20 * 60_000 - 1;
    const before = await runWithConversationId("thread-checkpoint", () => (
      server.handlers.get("worker")({}, {})
    ));
    assert.deepEqual(before.content, [{ type: "text", text: "worker done" }]);

    now += 1;
    const reached = await runWithConversationId("thread-checkpoint", () => (
      server.handlers.get("worker")({}, {})
    ));
    assert.equal(reached.content.at(-1).text, TURN_CHECKPOINT_MESSAGE);
    assert.deepEqual(reached.content.at(-1).annotations?.audience, ["assistant"]);
    assert.equal(reached.content.at(-1).annotations?.priority, 1);

    now += 60_000;
    const once = await runWithConversationId("thread-checkpoint", () => (
      server.handlers.get("worker")({}, {})
    ));
    assert.deepEqual(once.content, [{ type: "text", text: "worker done" }]);
  } finally {
    Date.now = originalNow;
  }
});
