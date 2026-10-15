import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-todos-"));
process.env.BRIDGE_STATE_DIR = stateDir;
process.env.BRIDGE_SCRATCH_DIR = path.join(stateDir, "scratch");
delete process.env.DEFAULT_WORKSPACE;

const { loadState, saveState } = await import("../../src/lib/config.js");
const { runWithConversationId } = await import("../../src/lib/conversation.js");
const { loadTodos, writeTodos } = await import("../../src/lib/todos.js");

const todo = (id, content, status = "pending") => ({ id, content, status });

test("replace writes the complete conversation todo list", () => {
  runWithConversationId("todo-replace", () => {
    writeTodos({ todos: [todo("a", "First"), todo("b", "Second", "in_progress")], merge: false });
    const result = writeTodos({ todos: [todo("c", "Replacement")], merge: false });
    assert.deepEqual(result, [todo("c", "Replacement")]);
    assert.deepEqual(loadTodos(), [todo("c", "Replacement")]);
  });
});

test("merge updates matching ids, preserves unmentioned items, and appends new ids", () => {
  runWithConversationId("todo-merge", () => {
    writeTodos({ todos: [todo("a", "First"), todo("b", "Second")], merge: false });
    const result = writeTodos({ todos: [todo("b", "Second done", "completed"), todo("c", "Third")], merge: true });
    assert.deepEqual(result, [todo("a", "First"), todo("b", "Second done", "completed"), todo("c", "Third")]);
  });
});

test("todo state is isolated between conversations", () => {
  runWithConversationId("todo-chat-a", () => writeTodos({ todos: [todo("a", "A")], merge: false }));
  runWithConversationId("todo-chat-b", () => writeTodos({ todos: [todo("b", "B")], merge: false }));
  assert.deepEqual(runWithConversationId("todo-chat-a", () => loadTodos()), [todo("a", "A")]);
  assert.deepEqual(runWithConversationId("todo-chat-b", () => loadTodos()), [todo("b", "B")]);
});

test("workspace saves preserve todos in the same conversation record", () => {
  runWithConversationId("todo-workspace", () => {
    writeTodos({ todos: [todo("a", "Keep me")], merge: false });
    const state = loadState();
    state.currentWorkspace = "/tmp/example";
    saveState(state);
    assert.deepEqual(loadTodos(), [todo("a", "Keep me")]);
    assert.equal(loadState().currentWorkspace, "/tmp/example");
  });
});

test("duplicate incoming ids are rejected", () => {
  assert.throws(
    () => runWithConversationId("todo-dupe", () => writeTodos({ todos: [todo("a", "One"), todo("a", "Two")], merge: false })),
    /duplicate todo id/i,
  );
});

test("write_todos scopes to active project workspace when no conversation id is present", () => {
  const state = loadState();
  state.currentWorkspace = "/tmp/proj-alpha";
  saveState(state);

  writeTodos({ todos: [todo("p1", "Alpha task")], merge: false });
  assert.deepEqual(loadTodos(), [todo("p1", "Alpha task")]);
});

test("two different project workspaces keep independent todos without conversation ids", () => {
  const state = loadState();

  state.currentWorkspace = "/tmp/proj-beta";
  saveState(state);
  writeTodos({ todos: [todo("b1", "Beta task")], merge: false });

  state.currentWorkspace = "/tmp/proj-gamma";
  saveState(state);
  writeTodos({ todos: [todo("g1", "Gamma task")], merge: false });

  state.currentWorkspace = "/tmp/proj-beta";
  saveState(state);
  assert.deepEqual(loadTodos(), [todo("b1", "Beta task")]);

  state.currentWorkspace = "/tmp/proj-gamma";
  saveState(state);
  assert.deepEqual(loadTodos(), [todo("g1", "Gamma task")]);
});

test("write_todos falls back to global scope when neither conversation nor workspace is present", () => {
  const state = loadState();
  state.currentWorkspace = "";
  saveState(state);

  writeTodos({ todos: [todo("g-init", "Global task")], merge: false });
  assert.deepEqual(loadTodos(), [todo("g-init", "Global task")]);
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
