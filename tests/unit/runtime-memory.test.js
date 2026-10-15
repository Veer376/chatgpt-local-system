import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-system-runtime-memory-"));
process.env.BRIDGE_STATE_DIR = stateDir;

const { runWithConversationId } = await import("../../src/lib/conversation.js");
const { loadState, saveState } = await import("../../src/lib/config.js");
const {
  clearRuntimeMemory,
  loadRuntimeMemory,
  RUNTIME_MEMORY_MAX_CHARS,
  writeRuntimeMemory,
} = await import("../../src/lib/runtime-memory.js");
const { registerPolicy } = await import("../../src/tools/policy.js");
const { registerRuntimeMemory, RUNTIME_MEMORY_DESCRIPTION } = await import("../../src/tools/runtime-memory.js");

function fakeServer() {
  const handlers = new Map();
  const definitions = new Map();
  return {
    handlers,
    definitions,
    registerTool(name, definition, handler) {
      definitions.set(name, definition);
      handlers.set(name, handler);
    },
  };
}

function structuredContent(result) {
  const text = result?.content?.find((item) => item?.type === "text")?.text || "";
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  return match ? JSON.parse(match[1]) : null;
}

test("runtime memory writes, reads, replaces, and clears one coherent snapshot", () => {
  runWithConversationId("runtime-memory-basic", () => {
    assert.equal(loadRuntimeMemory(), null);
    assert.equal(writeRuntimeMemory("objective: inspect current failure"), "objective: inspect current failure");
    assert.equal(loadRuntimeMemory(), "objective: inspect current failure");
    assert.equal(writeRuntimeMemory("objective: verify the fix\nnext: run tests"), "objective: verify the fix\nnext: run tests");
    assert.equal(loadRuntimeMemory(), "objective: verify the fix\nnext: run tests");
    assert.equal(clearRuntimeMemory(), null);
    assert.equal(loadRuntimeMemory(), null);
  });
});

test("runtime memory is isolated between conversations", () => {
  runWithConversationId("runtime-memory-a", () => writeRuntimeMemory("alpha"));
  runWithConversationId("runtime-memory-b", () => writeRuntimeMemory("beta"));
  assert.equal(runWithConversationId("runtime-memory-a", () => loadRuntimeMemory()), "alpha");
  assert.equal(runWithConversationId("runtime-memory-b", () => loadRuntimeMemory()), "beta");
});

test("workspace changes preserve runtime memory in the same conversation record", () => {
  runWithConversationId("runtime-memory-workspace", () => {
    writeRuntimeMemory("keep this working state");
    const state = loadState();
    state.currentWorkspace = "/tmp/runtime-memory-example";
    saveState(state);
    assert.equal(loadRuntimeMemory(), "keep this working state");
    assert.equal(loadState().currentWorkspace, "/tmp/runtime-memory-example");
  });
});

test("runtime memory enforces the approved 1 to 6000 character write limit", () => {
  runWithConversationId("runtime-memory-limits", () => {
    assert.throws(() => writeRuntimeMemory(""), /requires content/i);
    assert.equal(writeRuntimeMemory("x".repeat(RUNTIME_MEMORY_MAX_CHARS)).length, RUNTIME_MEMORY_MAX_CHARS);
    assert.throws(
      () => writeRuntimeMemory("x".repeat(RUNTIME_MEMORY_MAX_CHARS + 1)),
      /6000 characters or fewer/i,
    );
  });
});

test("runtime_memory tool implements the approved read/write/clear contract", async () => {
  const server = fakeServer();
  registerRuntimeMemory(server);
  const definition = server.definitions.get("runtime_memory");
  const handler = server.handlers.get("runtime_memory");
  assert.equal(definition.description, RUNTIME_MEMORY_DESCRIPTION);

  await runWithConversationId("runtime-memory-tool", async () => {
    const written = await handler({ action: "write", content: "objective: finish the current checkpoint" });
    assert.equal(written.isError, undefined);
    assert.equal(structuredContent(written).runtimeMemory, "objective: finish the current checkpoint");

    const read = await handler({ action: "read" });
    assert.equal(structuredContent(read).runtimeMemory, "objective: finish the current checkpoint");

    const invalidRead = await handler({ action: "read", content: "should not be accepted" });
    assert.equal(invalidRead.isError, true);
    assert.match(invalidRead.content[0].text, /only valid for write/i);

    const cleared = await handler({ action: "clear" });
    assert.equal(cleared.isError, undefined);
    assert.equal(structuredContent(cleared).runtimeMemory, null);
    assert.equal(loadRuntimeMemory(), null);
  });
});

test("bridge_context automatically returns the conversation runtime memory", async () => {
  const server = fakeServer();
  registerPolicy(server);
  const handler = server.handlers.get("bridge_context");

  await runWithConversationId("runtime-memory-bridge", async () => {
    writeRuntimeMemory("state: implementation complete\nnext: verify live tool discovery");
    const result = await handler({}, {});
    const context = structuredContent(result);
    assert.equal(context.runtimeMemory, "state: implementation complete\nnext: verify live tool discovery");
  });
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
