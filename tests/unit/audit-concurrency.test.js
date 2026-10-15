import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-audit-capacity-"));
process.env.BRIDGE_STATE_DIR = stateDir;
process.env.MAX_CONCURRENT_TOOLS = "8";

const { instrumentServer } = await import("../../src/lib/audit.js");

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

function waitUntil(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("condition timeout"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("normal tool saturation queues work within the global budget while reserved subagent control capacity remains available", async () => {
  const server = instrumentServer(fakeServer());
  const releases = [];
  let entered = 0;

  server.registerTool("worker_tool", {}, async () => {
    entered += 1;
    await new Promise((resolve) => releases.push(resolve));
    return { content: [{ type: "text", text: "worker done" }] };
  });
  server.registerTool("subagents", {}, async () => ({
    content: [{ type: "text", text: "control ok" }],
  }));

  const firstSix = Array.from({ length: 6 }, () => server.handlers.get("worker_tool")({}, {}));
  await waitUntil(() => entered === 6);

  const seventh = server.handlers.get("worker_tool")({}, {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(entered, 6, "normal calls must leave the reserved control capacity unused");

  const control = await Promise.race([
    server.handlers.get("subagents")({}, {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("control lane blocked")), 500)),
  ]);
  assert.equal(control.isError, undefined);
  assert.equal(control.content[0].text, "control ok");

  releases.shift()();
  await waitUntil(() => entered === 7);
  for (const release of releases.splice(0)) release();
  await Promise.all([...firstSix, seventh]);
});
