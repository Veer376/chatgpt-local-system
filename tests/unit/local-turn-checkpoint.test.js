import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-system-checkpoint-settings-"));
process.env.BRIDGE_STATE_DIR = stateDir;
process.env.TURN_CHECKPOINT_MS = String(20 * 60_000);

const { registerLocalTurnCheckpointRoutes } = await import("../../src/lib/local-turn-checkpoint.js");
const { loadTurnCheckpointSettings } = await import("../../src/lib/turn-checkpoint.js");

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function harness(body, extension = true) {
  let handler;
  registerLocalTurnCheckpointRoutes({
    post(pathname, fn) {
      assert.equal(pathname, "/local-ui/turn-checkpoint");
      handler = fn;
    },
  });
  let statusCode = 200;
  let payload;
  const req = {
    body,
    get(name) {
      return extension && name === "x-local-system-extension" ? "1" : "";
    },
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return value;
    },
  };
  handler(req, res);
  return { statusCode, payload };
}

test("checkpoint settings default on at the configured production interval", () => {
  const result = harness({ action: "get" });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.payload, { enabled: true, intervalMinutes: 20 });
});

test("checkpoint settings persist injection state and interval without a restart", () => {
  const update = harness({ action: "update", enabled: false, intervalMinutes: 35 });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.payload, { enabled: false, intervalMinutes: 35 });
  assert.deepEqual(loadTurnCheckpointSettings(), { enabled: false, intervalMs: 35 * 60_000 });

  const read = harness({ action: "get" });
  assert.deepEqual(read.payload, { enabled: false, intervalMinutes: 35 });
});

test("checkpoint settings reject invalid intervals and non-extension callers", () => {
  assert.equal(harness({ action: "update", intervalMinutes: 0 }).statusCode, 400);
  assert.equal(harness({ action: "get" }, false).statusCode, 403);
});
