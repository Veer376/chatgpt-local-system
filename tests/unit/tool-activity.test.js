import assert from "node:assert/strict";
import test from "node:test";
import { conversationKey } from "../../src/lib/conversation.js";
import {
  bridgeActivityStatus,
  clearToolActivityForTests,
  listToolActivity,
  listToolActivityPage,
  recordToolCompleted,
  recordToolFailed,
  recordToolQueued,
  recordToolStarted,
} from "../../src/lib/local-tool-activity.js";
import { CONNECTOR_TOOL_CALL_EXPIRY_MS } from "../../src/lib/config.js";

test.beforeEach(() => clearToolActivityForTests());

test("activity pages include bounded redacted details and compact tool duration", () => {
  const conversationId = "v1/tool-activity-a";
  const key = conversationKey(conversationId);
  recordToolQueued({
    conversationId,
    requestId: "req_a",
    tool: "execute_command",
    args: { command: "echo hello", token: "very-secret-token-value" },
    at: 1_000,
  });
  assert.equal(listToolActivity(key)[0]?.status, "queued");

  recordToolStarted({
    conversationId,
    requestId: "req_a",
    tool: "execute_command",
    args: { command: "echo hello", token: "very-secret-token-value" },
    at: 1_100,
  });
  assert.equal(listToolActivity(key)[0]?.status, "running");

  recordToolCompleted({
    conversationId,
    requestId: "req_a",
    result: {
      content: [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: "x".repeat(500) },
      ],
      structuredContent: { ok: true },
    },
    at: 1_450,
    durationMs: 350,
  });

  const call = listToolActivityPage(key).calls[0];
  assert.equal(call.status, "completed");
  assert.equal(call.arguments.command, "echo hello");
  assert.equal(call.arguments.token, "[REDACTED]");
  assert.equal(call.result.content[0].text, "hello");
  assert.deepEqual(call.result.content[1], { type: "image", mimeType: "image/png", encodedChars: 500 });
  assert.equal(call.durationMs, 350);
  for (const field of ["queuedAt", "startedAt", "finishedAt", "turnStartedAt"]) {
    assert.equal(field in call, false, `${field} belongs to turn-level timing, not the tool row`);
  }
});

test("activity pages return newest five, total count, and stable cursor pagination while new calls arrive", () => {
  const conversationId = "v1/tool-activity-pages";
  const key = conversationKey(conversationId);
  recordToolStarted({ conversationId, requestId: "bridge", tool: "bridge_context", args: {}, at: 1_000 });
  recordToolCompleted({ conversationId, requestId: "bridge", result: { content: [] }, at: 1_010 });
  for (let index = 0; index < 11; index += 1) {
    const requestId = `req_${index}`;
    recordToolStarted({ conversationId, requestId, tool: "workspace", args: { index }, at: 2_000 + index * 10 });
    recordToolCompleted({ conversationId, requestId, result: { content: [] }, at: 2_005 + index * 10 });
  }

  const first = listToolActivityPage(key);
  assert.equal(first.calls.length, 5);
  assert.equal(first.totalCount, 12);
  assert.deepEqual(first.calls.map((call) => call.id), ["req_10", "req_9", "req_8", "req_7", "req_6"]);
  assert.ok(first.nextCursor);

  recordToolStarted({ conversationId, requestId: "req_new", tool: "execute_command", args: {}, at: 3_000 });
  const second = listToolActivityPage(key, { cursor: first.nextCursor });
  assert.equal(second.totalCount, 13);
  assert.deepEqual(second.calls.map((call) => call.id), ["req_5", "req_4", "req_3", "req_2", "req_1"]);
  assert.ok(second.nextCursor);

  const third = listToolActivityPage(key, { cursor: second.nextCursor });
  assert.deepEqual(third.calls.map((call) => call.id), ["req_0", "bridge"]);
  assert.equal(third.nextCursor, null);
});

test("turn summary exposes overall start, end, duration, total tools and active count", () => {
  const conversationId = "v1/tool-activity-turn-summary";
  const key = conversationKey(conversationId);
  recordToolStarted({ conversationId, requestId: "bridge", tool: "bridge_context", args: {}, at: 1_000 });
  recordToolCompleted({ conversationId, requestId: "bridge", result: { content: [] }, at: 1_100 });
  recordToolStarted({ conversationId, requestId: "work", tool: "execute_command", args: {}, at: 1_200 });

  const active = listToolActivityPage(key);
  assert.equal(active.turn.startedAt, new Date(1_000).toISOString());
  assert.equal(active.turn.endedAt, null);
  assert.equal(active.turn.toolCount, 2);
  assert.equal(active.turn.activeCount, 1);
  assert.equal(active.activeCount, 1);
  assert.equal(active.totalCount, 2);

  recordToolCompleted({ conversationId, requestId: "work", result: { content: [] }, at: 1_700 });
  const complete = listToolActivityPage(key);
  assert.equal(complete.turn.endedAt, new Date(1_700).toISOString());
  assert.equal(complete.turn.durationMs, 700);
  assert.equal(complete.turn.toolCount, 2);
  assert.equal(complete.turn.activeCount, 0);
});

test("failed tool activity keeps bounded error detail in the page", () => {
  const conversationId = "v1/tool-activity-failure";
  const key = conversationKey(conversationId);
  recordToolStarted({ conversationId, requestId: "req_fail", tool: "apply_patch", args: {}, at: 1_000 });
  recordToolFailed({ conversationId, requestId: "req_fail", error: new Error("patch failed"), at: 1_050, durationMs: 50 });
  const call = listToolActivityPage(key).calls[0];
  assert.equal(call.status, "failed");
  assert.equal(call.error, "patch failed");
});

test("bridge_context starts a new activity turn and pages only the latest turn", () => {
  const conversationId = "v1/tool-activity-turns";
  const key = conversationKey(conversationId);

  recordToolStarted({ conversationId, requestId: "req_turn1_bridge", tool: "bridge_context", args: {}, at: 1_000 });
  recordToolCompleted({ conversationId, requestId: "req_turn1_bridge", result: { content: [] }, at: 1_010 });
  recordToolStarted({ conversationId, requestId: "req_turn1_work", tool: "execute_command", args: {}, at: 1_020 });
  recordToolCompleted({ conversationId, requestId: "req_turn1_work", result: { content: [] }, at: 1_030 });

  recordToolStarted({ conversationId, requestId: "req_turn2_bridge", tool: "bridge_context", args: {}, at: 2_000 });
  recordToolCompleted({ conversationId, requestId: "req_turn2_bridge", result: { content: [] }, at: 2_010 });
  recordToolStarted({ conversationId, requestId: "req_turn2_work", tool: "apply_patch", args: {}, at: 2_020 });

  const page = listToolActivityPage(key, { limit: 20 });
  assert.deepEqual(page.calls.map((call) => call.id), ["req_turn2_work", "req_turn2_bridge"]);
  assert.equal(page.turn.startedAt, new Date(2_000).toISOString());
  assert.equal(page.turn.toolCount, 2);
});

test("bridge activity expires from the latest Local System activity timestamp", () => {
  const conversationId = "v1/tool-activity-bridge-status";
  const key = conversationKey(conversationId);
  const startedAt = 10_000;
  const finishedAt = startedAt + 10;
  recordToolStarted({ conversationId, requestId: "req_bridge", tool: "bridge_context", args: {}, at: startedAt });
  recordToolCompleted({ conversationId, requestId: "req_bridge", result: { content: [] }, at: finishedAt, durationMs: 10 });

  const active = bridgeActivityStatus(key, finishedAt + CONNECTOR_TOOL_CALL_EXPIRY_MS - 1);
  assert.equal(active.bridgeActive, true);
  assert.equal(active.connectorExpiryMs, CONNECTOR_TOOL_CALL_EXPIRY_MS);

  const expired = bridgeActivityStatus(key, finishedAt + CONNECTOR_TOOL_CALL_EXPIRY_MS);
  assert.equal(expired.bridgeActive, false);
  assert.equal(expired.toolAgeMs, CONNECTOR_TOOL_CALL_EXPIRY_MS);
});

test("a running tool keeps Local System active even when bridge_context itself is old", () => {
  const conversationId = "v1/tool-activity-recent-work";
  const key = conversationKey(conversationId);
  recordToolStarted({ conversationId, requestId: "req_bridge", tool: "bridge_context", args: {}, at: 1_000 });
  recordToolCompleted({ conversationId, requestId: "req_bridge", result: { content: [] }, at: 1_010 });
  recordToolStarted({ conversationId, requestId: "req_work", tool: "execute_command", args: {}, at: 121_000 });

  const status = bridgeActivityStatus(key, 121_500);
  assert.equal(status.bridgeActive, true);
  assert.equal(status.lastToolAt, new Date(121_000).toISOString());
  assert.equal(status.toolAgeMs, 500);
});
