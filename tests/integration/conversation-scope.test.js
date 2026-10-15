import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const base = fs.mkdtempSync(path.join(os.homedir(), ".sol-conversation-integration-"));
const roots = path.join(base, "projects");
const projectA = path.join(roots, "alpha");
const projectB = path.join(roots, "beta");
const projectC = path.join(roots, "gamma");
for (const dir of [roots, projectA, projectB, projectC]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(projectA, "AGENTS.md"), "Alpha rule: always run npm test before committing.\n");
const alphaSkills = path.join(projectA, ".agents", "skills", "alpha-only");
fs.mkdirSync(alphaSkills, { recursive: true });
fs.writeFileSync(path.join(alphaSkills, "SKILL.md"), "---\nname: alpha-only\ndescription: project scoped\n---\n");

process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.BRIDGE_SCRATCH_DIR = path.join(base, "scratch");
process.env.WORKSPACE_ROOTS = roots;
process.env.DEFAULT_WORKSPACE = "";
process.env.MCP_TOKEN = "conversation-secret";
process.env.HOST = "127.0.0.1";
process.env.FILE_PREVIEW_CLOUD_ENABLED = "false";

const { startHttpServer } = await import("../../src/server.js");
const { UserQuestionnaireManager, setQuestionnaireManagerForTests } = await import("../../src/lib/user-question.js");

const pendingQuestionnaires = [];
const testQuestionService = {
  askMany({ questions, onProgress }) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    pendingQuestionnaires.push({ questions, onProgress, resolve });
    return promise;
  },
};
setQuestionnaireManagerForTests(new UserQuestionnaireManager({
  serviceFactory: () => testQuestionService,
  waitTimeoutMs: 1_000,
}));

const runtime = startHttpServer({ host: "127.0.0.1", port: 0 });
if (!runtime.httpServer.listening) await once(runtime.httpServer, "listening");
const url = `http://127.0.0.1:${runtime.httpServer.address().port}/mcp`;

let nextId = 1;

// Raw JSON-RPC so the request is byte-shaped exactly like ChatGPT's, including
// `_meta`. ChatGPT never sends Mcp-Session-Id, so neither does this client.
async function callTool(name, args, meta) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer conversation-secret",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
    }),
  });
  const text = await response.text();
  const line = text.split("\n").find((item) => item.startsWith("data: "));
  const payload = JSON.parse(line ? line.slice(6) : text);
  assert.equal(payload.error, undefined, `tool ${name} returned a JSON-RPC error: ${JSON.stringify(payload.error)}`);
  const result = payload.result;
  if (result && !result.structuredContent && Array.isArray(result.content)) {
    const contentText = result.content.find((b) => b?.type === "text")?.text;
    if (typeof contentText === "string") {
      const match = contentText.match(/```json\s*([\s\S]*?)\s*```/);
      if (match) {
        try {
          result.structuredContent = JSON.parse(match[1]);
        } catch {}
      }
    }
  }
  return result;
}

const sessionMeta = (session) => ({
  "openai/session": session,
  "openai/subject": "v1/anonymous-subject",
  "openai/locale": "en-IN",
});

const openWorkspace = (target, meta) => callTool("workspace", { action: "open", path: target }, meta);
const contextFor = async (meta) => (await callTool("bridge_context", {}, meta)).structuredContent;

test("execute_command propagates each MCP conversation identity to its subprocess", async () => {
  const cases = [
    { meta: sessionMeta("v1/env-A"), expected: "v1/env-A" },
    { meta: sessionMeta("v1/env-B"), expected: "v1/env-B" },
    { meta: { threadId: "codex-env-C" }, expected: "codex-env-C" },
    { meta: undefined, expected: "missing" },
  ];
  await Promise.all(cases.map(async ({ meta, expected }) => {
    const cwd = (await contextFor(meta)).localScratchDir;
    const result = await callTool("execute_command", {
      command: "node -e 'process.stdout.write(process.env.LOCAL_SYSTEM_CONVERSATION_ID || \"missing\")'",
      cwd,
    }, meta);
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.stdout, expected);
  }));
});

test.after(async () => {
  await runtime.shutdown("test");
  fs.rmSync(base, { recursive: true, force: true });
});

test("two ChatGPT conversations hold independent workspaces over real MCP calls", async () => {
  // Real ChatGPT session ids contain a slash, which must not reach the filesystem.
  const chatA = sessionMeta("v1/2U25IcszcFRXmmEi0mAO8WtQdCoNCQZ0LJ6azI72DRdjUPvHnOGquGVRShBuqpSzC");
  const chatB = sessionMeta("v1/FG06dVYemDkQwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOpAsDfGhJkLzXcVbN");

  await openWorkspace(projectA, chatA);
  await openWorkspace(projectB, chatB);

  const contextA = await contextFor(chatA);
  const contextB = await contextFor(chatB);

  assert.equal(contextA.currentProjectWorkspace, fs.realpathSync(projectA));
  assert.equal(contextB.currentProjectWorkspace, fs.realpathSync(projectB));
  assert.equal(contextA.conversationScope, undefined);
  assert.equal(contextB.conversationScope, undefined);
  assert.equal(contextA.localScratchDir, contextB.localScratchDir);
  assert.equal(path.dirname(contextA.localScratchDir), fs.realpathSync(path.join(base, "scratch")));
  assert.match(path.basename(contextA.localScratchDir), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(fs.statSync(contextA.localScratchDir).isDirectory(), true);
});

test("request_user_input resumes one live question across real conversation-scoped MCP calls", async () => {
  const chat = sessionMeta("v1/resumable-ask-user");
  const otherChat = sessionMeta("v1/resumable-ask-user-other");
  const started = await callTool("request_user_input", {
    question: { question: "Continue?", options: ["Yes", "No"] },
  }, chat);
  const parseEmbedded = (toolResult) => {
    const match = toolResult.content?.[0]?.text?.match(/```json\n([\s\S]+?)\n```/);
    return match ? JSON.parse(match[1]) : toolResult.structuredContent || null;
  };

  const startedPayload = parseEmbedded(started);
  assert.equal(startedPayload?.status, "waiting");
  assert.match(startedPayload?.request_id || "", /^interrupt_/);
  assert.equal(pendingQuestionnaires.length, 1);

  const noCrossConversationResume = await callTool("request_user_input", {}, otherChat);
  assert.equal(noCrossConversationResume.isError, true);
  assert.match(JSON.stringify(noCrossConversationResume), /available to resume/i);

  const firstAnswer = {
    questionIndex: 0,
    question: "Continue?",
    answer: "Yes",
    answers: ["Yes"],
    source: "test",
    custom: false,
    optionIndex: 0,
    optionIndexes: [0],
    multiple: false,
  };
  pendingQuestionnaires[0].onProgress([firstAnswer]);
  const waitingAgain = await callTool("request_user_input", {}, chat);
  const waitingAgainPayload = parseEmbedded(waitingAgain);
  assert.equal(waitingAgainPayload?.request_id, startedPayload.request_id);
  assert.equal(waitingAgainPayload?.answered_count, 1);
  assert.deepEqual(waitingAgainPayload?.answers, [firstAnswer]);
  assert.equal(pendingQuestionnaires.length, 1, "resume did not send the questionnaire again");

  pendingQuestionnaires[0].resolve({ status: "answered", answers: [firstAnswer] });
  const answered = await callTool("request_user_input", {}, chat);
  const answeredPayload = parseEmbedded(answered);
  assert.equal(answeredPayload?.status, "answered");
  assert.equal(answeredPayload?.request_id, startedPayload.request_id);
  assert.deepEqual(answeredPayload?.answers, [firstAnswer]);
});

test("conversation contexts share the daily scratch directory", async () => {
  const chatA = sessionMeta("v1/scratch-A");
  const chatB = sessionMeta("v1/scratch-B");
  const scratchA = (await contextFor(chatA)).localScratchDir;
  const scratchB = (await contextFor(chatB)).localScratchDir;
  assert.equal(scratchA, scratchB);
  assert.match(path.basename(scratchA), /^\d{4}-\d{2}-\d{2}$/);

  const own = await callTool("execute_command", { command: "pwd", cwd: scratchA }, chatA);
  assert.notEqual(own.isError, true);
  assert.match(own.structuredContent?.stdout || "", new RegExp(scratchA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const crossThread = await callTool("execute_command", { command: "pwd", cwd: scratchB }, chatA);
  assert.notEqual(crossThread.isError, true);
  assert.match(crossThread.structuredContent?.stdout || "", new RegExp(scratchB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("write_todos persists per conversation and bridge_context returns only open todo details", async () => {
  const chatA = sessionMeta("v1/todos-A");
  const chatB = sessionMeta("v1/todos-B");
  const first = [
    { id: "inspect", content: "Inspect current state", status: "completed" },
    { id: "implement", content: "Implement the change", status: "in_progress" },
  ];

  const replaced = await callTool("write_todos", { todos: first, merge: false }, chatA);
  assert.deepEqual(replaced.structuredContent?.todos, first);
  assert.deepEqual((await contextFor(chatA)).todos, {
    open: [{ id: "implement", content: "Implement the change", status: "in_progress" }],
    completed: 1,
    cancelled: 0,
  });
  assert.deepEqual((await contextFor(chatB)).todos, { open: [], completed: 0, cancelled: 0 }, "another conversation has an independent todo list");

  const merged = await callTool("write_todos", {
    todos: [
      { id: "implement", content: "Implement the change", status: "completed" },
      { id: "verify", content: "Verify the result", status: "pending" },
    ],
    merge: true,
  }, chatA);
  assert.deepEqual(merged.structuredContent?.todos, [
    { id: "inspect", content: "Inspect current state", status: "completed" },
    { id: "implement", content: "Implement the change", status: "completed" },
    { id: "verify", content: "Verify the result", status: "pending" },
  ]);
  assert.deepEqual((await contextFor(chatA)).todos, {
    open: [{ id: "verify", content: "Verify the result", status: "pending" }],
    completed: 2,
    cancelled: 0,
  });
});

test("runtime_memory persists per conversation and bridge_context returns the current snapshot", async () => {
  const chatA = sessionMeta("v1/runtime-memory-A");
  const chatB = sessionMeta("v1/runtime-memory-B");

  const written = await callTool("runtime_memory", {
    action: "write",
    content: "objective: keep the current long-running task coherent\nnext: verify live behavior",
  }, chatA);
  assert.equal(
    written.structuredContent?.runtimeMemory,
    "objective: keep the current long-running task coherent\nnext: verify live behavior",
  );
  assert.equal(
    (await contextFor(chatA)).runtimeMemory,
    "objective: keep the current long-running task coherent\nnext: verify live behavior",
  );
  assert.equal((await contextFor(chatB)).runtimeMemory, null, "another conversation has independent runtime memory");

  const replaced = await callTool("runtime_memory", {
    action: "write",
    content: "objective: verification complete\nnext: commit",
  }, chatA);
  assert.equal(replaced.structuredContent?.runtimeMemory, "objective: verification complete\nnext: commit");

  const read = await callTool("runtime_memory", { action: "read" }, chatA);
  assert.equal(read.structuredContent?.runtimeMemory, "objective: verification complete\nnext: commit");

  const cleared = await callTool("runtime_memory", { action: "clear" }, chatA);
  assert.equal(cleared.structuredContent?.runtimeMemory, null);
  assert.equal((await contextFor(chatA)).runtimeMemory, null);
});

test("a conversation switching workspaces does not disturb the other conversation", async () => {
  const chatA = sessionMeta("v1/switch-A");
  const chatB = sessionMeta("v1/switch-B");
  await openWorkspace(projectA, chatA);
  await openWorkspace(projectB, chatB);

  await openWorkspace(projectC, chatA);

  assert.equal((await contextFor(chatA)).currentProjectWorkspace, fs.realpathSync(projectC));
  assert.equal((await contextFor(chatB)).currentProjectWorkspace, fs.realpathSync(projectB), "chat B is untouched");
});

test("calls without _meta keep the unscoped global workspace", async () => {
  await openWorkspace(projectA, sessionMeta("v1/scoped-only"));

  const unscoped = await contextFor(undefined);
  assert.equal(unscoped.conversationScope, undefined, "bridge_context no longer exposes conversation ids");
  assert.notEqual(unscoped.currentProjectWorkspace, fs.realpathSync(projectA), "scoped chat did not move the global pointer");

  await openWorkspace(projectB, undefined);
  assert.equal((await contextFor(undefined)).currentProjectWorkspace, fs.realpathSync(projectB));
  assert.equal(
    (await contextFor(sessionMeta("v1/scoped-only"))).currentProjectWorkspace,
    fs.realpathSync(projectA),
    "the scoped chat kept its own workspace",
  );
});

test("a brand new conversation starts with no project selected", async () => {
  await openWorkspace(projectC, undefined);
  const fresh = await contextFor(sessionMeta("v1/never-seen-before"));
  assert.equal(fresh.currentProjectWorkspace, null, "does not inherit the global pointer");
  assert.equal(fresh.conversationScope, undefined);

  // The unscoped/global view is unaffected.
  const global = await contextFor(undefined);
  assert.equal(global.currentProjectWorkspace, fs.realpathSync(projectC));
});

test("a fresh conversation fails closed on write tools instead of using another project", async () => {
  const fresh = sessionMeta("v1/fresh-fail-closed");

  const command = await callTool("execute_command", { command: "pwd" }, fresh);
  assert.equal(command.isError, true, "execute_command refuses to guess a workspace");
  assert.match(JSON.stringify(command), /no current project workspace/);

  const patch = await callTool("apply_patch", {
    patch: "*** Begin Patch\n*** Add File: sneaky.txt\n+oops\n*** End Patch",
  }, fresh);
  assert.equal(patch.isError, true, "apply_patch refuses to write without a selected project");

  // Nothing was written into any project.
  for (const dir of [projectA, projectB, projectC]) {
    assert.equal(fs.existsSync(path.join(dir, "sneaky.txt")), false, `${dir} untouched`);
  }

  // After choosing a project the same call succeeds.
  await openWorkspace(projectA, fresh);
  const after = await callTool("execute_command", { command: "pwd" }, fresh);
  assert.notEqual(after.isError, true);
  assert.match(JSON.stringify(after), /alpha/);
});

test("bridge_context stays compact and carries only execution-critical instructions", async () => {
  const context = await contextFor(sessionMeta("v1/bridge-instructions"));
  assert.equal(context.environment, undefined);
  assert.equal(context.managedProcesses, undefined);
  assert.equal(context.workspaceSelection, undefined);
  assert.equal(Array.isArray(context.instructions), true);
  assert.equal(context.instructions.length, 9);
  assert.match(context.instructions.join("\n"), /local-system skill/i);
  assert.match(context.instructions.join("\n"), /Verify assumptions whose failure/i);
  assert.match(context.instructions.join("\n"), /Keep communication concise and outcome-focused/i);
  assert.match(context.instructions.join("\n"), /within the authorized scope/i);
  assert.match(context.instructions.join("\n"), /projectMemory/i);
  assert.match(context.instructions.join("\n"), /write_todos/i);
  assert.match(context.instructions.join("\n"), /request_user_input/i);
  assert.equal(typeof context.memory?.root, "string");
});

test("codex threadId scopes a conversation just like openai/session", async () => {
  await openWorkspace(projectA, { threadId: "codex-thread-1" });
  await openWorkspace(projectB, { threadId: "codex-thread-2" });
  assert.equal((await contextFor({ threadId: "codex-thread-1" })).currentProjectWorkspace, fs.realpathSync(projectA));
  assert.equal((await contextFor({ threadId: "codex-thread-2" })).currentProjectWorkspace, fs.realpathSync(projectB));
});

test("interleaved concurrent conversations never observe each other's workspace", async () => {
  const chats = [
    { meta: sessionMeta("v1/race-1"), target: projectA },
    { meta: sessionMeta("v1/race-2"), target: projectB },
    { meta: sessionMeta("v1/race-3"), target: projectC },
  ];
  await Promise.all(chats.map((chat) => openWorkspace(chat.target, chat.meta)));

  // Hammer all three conversations at once; each must only ever see its own.
  const rounds = await Promise.all(Array.from({ length: 8 }, () => Promise.all(
    chats.map(async (chat) => (await contextFor(chat.meta)).currentProjectWorkspace),
  )));
  for (const round of rounds) {
    assert.deepEqual(round, chats.map((chat) => fs.realpathSync(chat.target)));
  }
});

test("saved projects remain shared across conversations", async () => {
  const chatA = sessionMeta("v1/shared-A");
  const chatB = sessionMeta("v1/shared-B");
  await callTool("workspace", { action: "save", path: projectA, name: "alpha-shared" }, chatA);

  const listed = await callTool("workspace", { action: "list" }, chatB);
  assert.match(JSON.stringify(listed.structuredContent ?? listed), /alpha-shared/, "chat B sees the project saved by chat A");
});

test("opening a project returns its AGENTS.md and skill names", async () => {
  const chat = sessionMeta("v1/orientation");
  const opened = (await callTool("workspace", { action: "open", path: projectA }, chat)).structuredContent;

  assert.match(opened.projectDoc.name, /AGENTS\.md/i);
  assert.match(opened.projectDoc.content, /always run npm test/i, "instructions arrive without a second call");
  assert.deepEqual(opened.skills.project, ["alpha-only"]);
  assert.equal(Array.isArray(opened.skills.personal), true);
});

test("bridge_context and workspace=open agree on project orientation", async () => {
  const chat = sessionMeta("v1/orientation-parity");
  const opened = (await callTool("workspace", { action: "open", path: projectA }, chat)).structuredContent;
  const context = await contextFor(chat);

  assert.deepEqual(context.projectDoc, opened.projectDoc, "same instructions in both");
  assert.deepEqual(context.skills, opened.skills, "same skill index in both");
  assert.deepEqual(context.globalAgentDoc, opened.globalAgentDoc, "same global instructions in both");
  assert.deepEqual(context.memory, opened.memory, "same memory config in both");
  assert.deepEqual(context.projectMemory, opened.projectMemory, "same project memory in both");
});

test("a project without instructions or skills reports null and empty, not missing", async () => {
  const chat = sessionMeta("v1/orientation-bare");
  const opened = (await callTool("workspace", { action: "open", path: projectB }, chat)).structuredContent;
  assert.equal(opened.projectDoc, null);
  assert.deepEqual(opened.skills.project, []);
});

test("before a project is selected, project skills are null rather than empty", async () => {
  const context = await contextFor(sessionMeta("v1/orientation-unselected"));
  assert.equal(context.currentProjectWorkspace, null);
  assert.equal(context.skills.project, null, "null distinguishes 'not chosen yet' from 'none exist'");
  assert.equal(Array.isArray(context.skills.personal), true, "personal skills are knowable immediately");
  assert.equal(context.projectDoc, null);
  assert.equal(typeof context.globalAgentDoc?.path, "string");
  assert.equal(context.projectMemory, null);
});
