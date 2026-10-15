import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Pruning limits are read at import time, so they are tightened here rather
// than in the main conversation suite.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-conversation-prune-"));
process.env.BRIDGE_STATE_DIR = stateDir;
process.env.BRIDGE_SCRATCH_DIR = path.join(stateDir, "scratch");
process.env.MAX_CONVERSATION_STATE_FILES = "10";
process.env.CONVERSATION_STATE_TTL_MS = "60000";
delete process.env.DEFAULT_WORKSPACE;

const {
  loadState,
  saveState,
  pruneConversationStates,
  CONVERSATION_DIR,
  STATE_FILE,
} = await import("../../src/lib/config.js");
const { conversationKey, runWithConversationId } = await import("../../src/lib/conversation.js");

function openWorkspace(target) {
  const state = loadState();
  state.currentWorkspace = target;
  saveState(state);
}

function fileFor(id) {
  return path.join(CONVERSATION_DIR, `${conversationKey(id)}.json`);
}

function conversationFiles() {
  return fs.existsSync(CONVERSATION_DIR)
    ? fs.readdirSync(CONVERSATION_DIR).filter((name) => name.endsWith(".json"))
    : [];
}

function setMtime(id, msAgo) {
  const when = new Date(Date.now() - msAgo);
  fs.utimesSync(fileFor(id), when, when);
}

test("pruning an empty or missing directory is a safe no-op", () => {
  assert.equal(pruneConversationStates({ force: true }), 0);
  fs.rmSync(CONVERSATION_DIR, { recursive: true, force: true });
  assert.equal(pruneConversationStates({ force: true }), 0, "missing directory does not throw");
});

test("expired conversation state is removed while fresh state and global state survive", () => {
  openWorkspace("/tmp/global-keep");
  runWithConversationId("old-chat", () => openWorkspace("/tmp/ws-old"));
  runWithConversationId("new-chat", () => openWorkspace("/tmp/ws-new"));

  setMtime("old-chat", 10 * 60 * 1000); // 10 minutes old, TTL is 60s
  const removed = pruneConversationStates({ force: true });

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(fileFor("old-chat")), false, "expired conversation removed");
  assert.equal(fs.existsSync(fileFor("new-chat")), true, "fresh conversation kept");
  assert.equal(fs.existsSync(STATE_FILE), true, "global state file is never pruned");
  assert.equal(loadState().currentWorkspace, "/tmp/global-keep");

  // An expired conversation falls back to having no project selected.
  assert.equal(runWithConversationId("old-chat", () => loadState().currentWorkspace), "");
  assert.equal(runWithConversationId("new-chat", () => loadState().currentWorkspace), "/tmp/ws-new");
});

test("the file cap removes the oldest conversations first", () => {
  fs.rmSync(CONVERSATION_DIR, { recursive: true, force: true });
  const ids = Array.from({ length: 24 }, (_, index) => `capped-${index}`);
  for (const id of ids) runWithConversationId(id, () => openWorkspace(`/tmp/${id}`));
  assert.equal(conversationFiles().length, 24);

  // Newest last: capped-0 is oldest, capped-23 is newest. All within TTL.
  ids.forEach((id, index) => setMtime(id, (ids.length - index) * 1_000));

  const removed = pruneConversationStates({ force: true });
  assert.equal(removed, 14);
  assert.equal(conversationFiles().length, 10);
  for (const id of ids.slice(0, 14)) {
    assert.equal(fs.existsSync(fileFor(id)), false, `${id} (oldest) pruned`);
  }
  for (const id of ids.slice(14)) {
    assert.equal(fs.existsSync(fileFor(id)), true, `${id} (newest) kept`);
    assert.equal(runWithConversationId(id, () => loadState().currentWorkspace), `/tmp/${id}`);
  }
});

test("pruning is rate limited unless forced", () => {
  fs.rmSync(CONVERSATION_DIR, { recursive: true, force: true });
  runWithConversationId("rate-a", () => openWorkspace("/tmp/rate-a"));
  setMtime("rate-a", 10 * 60 * 1000);

  // saveState's internal prune already ran, so an unforced call is suppressed.
  assert.equal(pruneConversationStates(), 0, "unforced prune inside the interval is skipped");
  assert.equal(fs.existsSync(fileFor("rate-a")), true);

  assert.equal(pruneConversationStates({ force: true }), 1, "forced prune still runs");
  assert.equal(fs.existsSync(fileFor("rate-a")), false);
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
