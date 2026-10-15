import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.js resolves its directories at import time, so the sandbox must be in
// place before the dynamic import below.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-conversation-state-"));
process.env.BRIDGE_STATE_DIR = stateDir;
process.env.BRIDGE_SCRATCH_DIR = path.join(stateDir, "scratch");
delete process.env.DEFAULT_WORKSPACE;

const { loadState, saveState, CONVERSATION_DIR, STATE_FILE } = await import("../../src/lib/config.js");
const {
  activeScopeKey,
  conversationIdFromBody,
  conversationIdFromMeta,
  conversationIdFromRequest,
  conversationKey,
  currentConversationId,
  isOpenAiConversation,
  resolveActiveScopeKey,
  runWithConversation,
  runWithConversationId,
} = await import("../../src/lib/conversation.js");

// Mirrors src/tools/workspace.js openWorkspace().
function openWorkspace(target) {
  const state = loadState();
  state.currentWorkspace = target;
  saveState(state);
}

// Mirrors src/tools/workspace.js saveWorkspace().
function saveProject(record) {
  const state = loadState();
  state.savedProjects = [...state.savedProjects, record];
  saveState(state);
}

function conversationFiles() {
  return fs.existsSync(CONVERSATION_DIR)
    ? fs.readdirSync(CONVERSATION_DIR).filter((name) => name.endsWith(".json"))
    : [];
}

test("without a conversation the global workspace behaves exactly as before", () => {
  openWorkspace("/tmp/global-one");
  assert.equal(loadState().currentWorkspace, "/tmp/global-one");
  assert.equal(conversationFiles().length, 0, "no conversation files are created for unscoped calls");
});

test("two conversations keep independent workspaces", () => {
  runWithConversationId("chat-A", () => openWorkspace("/tmp/ws-a"));
  runWithConversationId("chat-B", () => openWorkspace("/tmp/ws-b"));

  assert.equal(runWithConversationId("chat-A", () => loadState().currentWorkspace), "/tmp/ws-a");
  assert.equal(runWithConversationId("chat-B", () => loadState().currentWorkspace), "/tmp/ws-b");
});

test("a conversation never moves the global workspace or another conversation", () => {
  openWorkspace("/tmp/global-two");
  runWithConversationId("chat-C", () => openWorkspace("/tmp/ws-c"));

  assert.equal(loadState().currentWorkspace, "/tmp/global-two", "global pointer is preserved");
  assert.equal(runWithConversationId("chat-A", () => loadState().currentWorkspace), "/tmp/ws-a", "chat A untouched");
});

test("a new conversation starts with no project selected", () => {
  openWorkspace("/tmp/global-three");
  assert.equal(
    runWithConversationId("chat-fresh", () => loadState().currentWorkspace),
    "",
    "a fresh chat must not inherit whatever another caller left behind",
  );
  // Unscoped callers still see the global pointer.
  assert.equal(loadState().currentWorkspace, "/tmp/global-three");
});

test("a conversation keeps its own workspace even as the global pointer moves", () => {
  runWithConversationId("chat-pinned", () => openWorkspace("/tmp/ws-pinned"));
  openWorkspace("/tmp/global-moved-later");
  assert.equal(runWithConversationId("chat-pinned", () => loadState().currentWorkspace), "/tmp/ws-pinned");
  assert.equal(runWithConversationId("chat-still-fresh", () => loadState().currentWorkspace), "");
});

test("savedProjects stay shared across conversations and the global scope", () => {
  const record = { name: "shared", path: "/tmp/shared-project" };
  runWithConversationId("chat-A", () => saveProject(record));

  const names = (state) => state.savedProjects.map((item) => item.name);
  assert.ok(names(loadState()).includes("shared"), "visible globally");
  assert.ok(names(runWithConversationId("chat-B", () => loadState())).includes("shared"), "visible in another chat");
  // Saving shared config must not disturb workspaces.
  assert.equal(runWithConversationId("chat-A", () => loadState().currentWorkspace), "/tmp/ws-a");
  assert.equal(runWithConversationId("chat-B", () => loadState().currentWorkspace), "/tmp/ws-b");
});

test("conversation ids containing path separators cannot escape the state directory", () => {
  const before = conversationFiles().length;
  const hostile = [
    "v1/2U25IcszcFRXmmEi0mAO8WtQdCoNCQZ0LJ6azI72DRdjUPvHnOGquGVRShBuqpSzCnD4eFMrw8I6",
    "../../etc/passwd",
    "..\\..\\windows\\system32",
    "a/b/c/../../../../escape",
  ];
  for (const id of hostile) runWithConversationId(id, () => openWorkspace(`/tmp/ws-${encodeURIComponent(id)}`));

  assert.equal(conversationFiles().length, before + hostile.length, "each id produced exactly one contained file");
  for (const name of conversationFiles()) {
    assert.match(name, /^[0-9a-f]{64}\.json$/, "filenames are hex digests");
  }
  assert.equal(fs.existsSync(path.join(stateDir, "etc")), false);
  // Each hostile id still round-trips to its own value.
  for (const id of hostile) {
    assert.equal(
      runWithConversationId(id, () => loadState().currentWorkspace),
      `/tmp/ws-${encodeURIComponent(id)}`,
    );
  }
});

test("blank and non-string conversation ids fall back to global state", () => {
  openWorkspace("/tmp/global-fallback");
  for (const id of ["", "   ", null, undefined, 42, {}, [], true]) {
    assert.equal(runWithConversationId(id, () => currentConversationId()), null, `id ${JSON.stringify(id)} is ignored`);
    assert.equal(runWithConversationId(id, () => loadState().currentWorkspace), "/tmp/global-fallback");
  }
});

test("conversation ids are read from openai/session, then codex threadId", () => {
  assert.equal(conversationIdFromMeta({ "openai/session": "s-1" }), "s-1");
  assert.equal(conversationIdFromMeta({ threadId: "t-1" }), "t-1");
  assert.equal(conversationIdFromMeta({ "openai/session": "s-1", threadId: "t-1" }), "s-1", "openai/session wins");
  assert.equal(conversationIdFromMeta({ "openai/session": "  padded  " }), "padded");
  assert.equal(conversationIdFromMeta({ "openai/session": 5 }), null);
  assert.equal(conversationIdFromMeta(null), null);
  assert.equal(conversationIdFromMeta("nope"), null);
});

test("conversation ids are extracted from single and batched JSON-RPC bodies", () => {
  assert.equal(conversationIdFromBody({ params: { _meta: { "openai/session": "s-2" } } }), "s-2");
  assert.equal(conversationIdFromBody([{ params: {} }, { params: { _meta: { "openai/session": "s-3" } } }]), "s-3");
  for (const body of [undefined, null, {}, { params: null }, { params: { _meta: null } }, [], "string", 7]) {
    assert.equal(conversationIdFromBody(body), null, `body ${JSON.stringify(body)} yields no id`);
  }
});

test("a corrupt conversation state file falls back to the global workspace", () => {
  openWorkspace("/tmp/global-corrupt");
  const id = "chat-corrupt";
  runWithConversationId(id, () => openWorkspace("/tmp/ws-corrupt"));
  fs.writeFileSync(path.join(CONVERSATION_DIR, `${conversationKey(id)}.json`), "{ not json");
  assert.equal(runWithConversationId(id, () => loadState().currentWorkspace), "", "unreadable state means no selection, not another chat's project");

  // A file that is valid JSON but the wrong shape also falls back.
  fs.writeFileSync(path.join(CONVERSATION_DIR, `${conversationKey(id)}.json`), JSON.stringify({ currentWorkspace: 42 }));
  assert.equal(runWithConversationId(id, () => loadState().currentWorkspace), "");
});

test("conversation context survives async boundaries and nesting", async () => {
  const seen = await runWithConversationId("chat-async", async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const inner = await Promise.resolve().then(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return currentConversationId();
    });
    return inner;
  });
  assert.equal(seen, "chat-async");

  // Nested scopes restore the outer conversation on exit.
  runWithConversationId("outer", () => {
    runWithConversationId("inner", () => assert.equal(currentConversationId(), "inner"));
    assert.equal(currentConversationId(), "outer");
  });
  assert.equal(currentConversationId(), null, "context does not leak outside the scope");
});

test("interleaved concurrent conversations never observe each other's workspace", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `race-${index}`);
  const results = await Promise.all(ids.map((id) => runWithConversationId(id, async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 25)));
    openWorkspace(`/tmp/race/${id}`);
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 25)));
    return loadState().currentWorkspace;
  })));
  assert.deepEqual(results, ids.map((id) => `/tmp/race/${id}`));

  // And they are still correct after the storm settles.
  for (const id of ids) {
    assert.equal(runWithConversationId(id, () => loadState().currentWorkspace), `/tmp/race/${id}`);
  }
});

test("concurrent writes inside one conversation never corrupt its state file", async () => {
  const id = "chat-hammer";
  await Promise.all(Array.from({ length: 40 }, (_, index) => runWithConversationId(id, async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 10)));
    openWorkspace(`/tmp/hammer-${index}`);
  })));
  const finalValue = runWithConversationId(id, () => loadState().currentWorkspace);
  assert.match(finalValue, /^\/tmp\/hammer-\d+$/, "state file is valid JSON with a coherent value");
});

test("very long and unicode conversation ids produce fixed-length safe filenames", () => {
  const ids = ["x".repeat(20_000), "чат-Ω-🙂", "id with spaces\nand\tnewlines"];
  for (const id of ids) {
    runWithConversationId(id, () => openWorkspace(`/tmp/u-${ids.indexOf(id)}`));
    const file = path.join(CONVERSATION_DIR, `${conversationKey(id)}.json`);
    assert.equal(fs.existsSync(file), true);
    assert.equal(path.basename(file).length, 69, "64 hex chars + .json");
    assert.equal(runWithConversationId(id, () => loadState().currentWorkspace), `/tmp/u-${ids.indexOf(id)}`);
  }
});

test("opening a workspace in a conversation does not rewrite shared global state", () => {
  openWorkspace("/tmp/global-untouched");
  const before = fs.statSync(STATE_FILE).mtimeMs;
  const beforeContents = fs.readFileSync(STATE_FILE, "utf8");

  runWithConversationId("chat-no-global-write", () => openWorkspace("/tmp/ws-isolated"));

  assert.equal(fs.readFileSync(STATE_FILE, "utf8"), beforeContents, "shared file is byte-identical");
  assert.equal(fs.statSync(STATE_FILE).mtimeMs, before, "shared file was not rewritten at all");
});

test("a project saved concurrently by another chat is not lost by a workspace open", async () => {
  const record = { name: "concurrent-project", path: "/tmp/concurrent-project" };
  await Promise.all([
    runWithConversationId("writer-chat", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      saveProject(record);
    }),
    ...Array.from({ length: 10 }, (_, index) => runWithConversationId(`opener-${index}`, async () => {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 12)));
      openWorkspace(`/tmp/opener-${index}`);
    })),
  ]);

  const names = loadState().savedProjects.map((item) => item.name);
  assert.ok(names.includes("concurrent-project"), "the saved project survived concurrent workspace opens");
  for (let index = 0; index < 10; index += 1) {
    assert.equal(
      runWithConversationId(`opener-${index}`, () => loadState().currentWorkspace),
      `/tmp/opener-${index}`,
    );
  }
});

test("the global state file remains valid and readable throughout", () => {
  const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  assert.equal(typeof parsed.currentWorkspace, "string");
  assert.equal(Array.isArray(parsed.savedProjects), true);
  assert.equal(parsed.version, 2);
});

test("extended meta keys are recognized for other MCP clients", () => {
  assert.equal(conversationIdFromMeta({ sessionId: "claude-sess-1" }), "claude-sess-1");
  assert.equal(conversationIdFromMeta({ conversation_id: "conv-2" }), "conv-2");
  assert.equal(conversationIdFromMeta({ session_id: "sess-3" }), "sess-3");
  assert.equal(conversationIdFromMeta({ chat_id: "chat-4" }), "chat-4");
});

test("conversationIdFromRequest extracts ID from body, headers, or query", () => {
  assert.equal(
    conversationIdFromRequest({ body: { params: { _meta: { "openai/session": "from-body" } } } }),
    "from-body",
  );
  assert.equal(
    conversationIdFromRequest({ headers: { "x-conversation-id": "from-header-conv" } }),
    "from-header-conv",
  );
  assert.equal(
    conversationIdFromRequest({ headers: { "x-session-id": "from-header-sess" } }),
    "from-header-sess",
  );
  assert.equal(
    conversationIdFromRequest({ headers: { "mcp-session-id": "from-mcp-session" } }),
    "from-mcp-session",
  );
  assert.equal(
    conversationIdFromRequest({ query: { sessionId: "from-query-param" } }),
    "from-query-param",
  );
  assert.equal(
    conversationIdFromRequest({ query: { conversationId: "from-query-conv" } }),
    "from-query-conv",
  );
  assert.equal(conversationIdFromRequest(null), null);
  assert.equal(conversationIdFromRequest({}), null);
});

test("resolveActiveScopeKey handles Tier 1 (explicit conversation ID)", () => {
  const explicit = resolveActiveScopeKey({ conversationId: "tier-1-override" });
  assert.equal(explicit.type, "conversation");
  assert.equal(explicit.id, "tier-1-override");
  assert.equal(explicit.key, conversationKey("tier-1-override"));

  runWithConversationId("tier-1-als", () => {
    const scope = resolveActiveScopeKey();
    assert.equal(scope.type, "conversation");
    assert.equal(scope.id, "tier-1-als");
    assert.equal(scope.key, conversationKey("tier-1-als"));
    assert.equal(activeScopeKey(), conversationKey("tier-1-als"));
  });
});

test("resolveActiveScopeKey handles Tier 2 (active project workspace)", () => {
  openWorkspace("/tmp/tier-2-workspace");
  const scope = resolveActiveScopeKey();
  assert.equal(scope.type, "project");
  assert.equal(scope.id, "project:/tmp/tier-2-workspace");
  assert.equal(scope.workspace, "/tmp/tier-2-workspace");
  assert.equal(scope.key, conversationKey("project:/tmp/tier-2-workspace"));
  assert.equal(activeScopeKey(), conversationKey("project:/tmp/tier-2-workspace"));

  const explicitWs = resolveActiveScopeKey({ workspace: "/tmp/explicit-ws" });
  assert.equal(explicitWs.type, "project");
  assert.equal(explicitWs.id, "project:/tmp/explicit-ws");
  assert.equal(explicitWs.workspace, "/tmp/explicit-ws");
  assert.equal(explicitWs.key, conversationKey("project:/tmp/explicit-ws"));
});

test("resolveActiveScopeKey handles Tier 3 (global fallback)", () => {
  openWorkspace("");
  delete process.env.LOCAL_SYSTEM_CONVERSATION_ID;
  const scope = resolveActiveScopeKey();
  assert.equal(scope.type, "global");
  assert.equal(scope.id, "global");
  assert.equal(scope.key, conversationKey("global"));
  assert.equal(activeScopeKey(), conversationKey("global"));

  process.env.LOCAL_SYSTEM_CONVERSATION_ID = "custom-global-env";
  const customScope = resolveActiveScopeKey();
  assert.equal(customScope.type, "global");
  assert.equal(customScope.id, "custom-global-env");
  assert.equal(customScope.key, conversationKey("custom-global-env"));
  delete process.env.LOCAL_SYSTEM_CONVERSATION_ID;
});

test("isOpenAiConversation distinguishes openai/session from other clients", () => {
  // ChatGPT / OpenAI meta
  runWithConversation({ body: { params: { _meta: { "openai/session": "sess-openai" } } } }, () => {
    assert.equal(currentConversationId(), "sess-openai");
    assert.equal(isOpenAiConversation(), true);
  });

  // Claude / other client sending sessionId
  runWithConversation({ body: { params: { _meta: { sessionId: "sess-claude" } } } }, () => {
    assert.equal(currentConversationId(), "sess-claude");
    assert.equal(isOpenAiConversation(), false);
  });

  // Codex sending threadId
  runWithConversation({ body: { params: { _meta: { threadId: "thread-codex" } } } }, () => {
    assert.equal(currentConversationId(), "thread-codex");
    assert.equal(isOpenAiConversation(), false);
  });

  // Header without openai/session
  runWithConversation({ headers: { "x-conversation-id": "header-conv" } }, () => {
    assert.equal(currentConversationId(), "header-conv");
    assert.equal(isOpenAiConversation(), false);
  });

  // Unscoped
  assert.equal(isOpenAiConversation(), false);
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
