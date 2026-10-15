import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getSubagentRun,
  listActiveSubagentTasks,
  registerSubagents,
  startSubagentRun,
  waitSubagentTasks,
} from "../../src/tools/subagents.js";

function tempRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sol-subagents-"));
}

test("MCP invoke fails closed before delegation when Chrome startup is genuinely unavailable", async () => {
  const handlers = new Map();
  const server = {
    registerTool(name, _definition, fn) { handlers.set(name, fn); },
  };
  registerSubagents(server, {
    ensureBrowser: async () => ({
      ready: false,
      required: true,
      action: "launch_failed",
      reason: "SUBAGENT_CHROME_LAUNCH_FAILED",
    }),
  });
  assert.deepEqual([...handlers.keys()].sort(), ["subagent", "subagent_wait"]);
  const result = await handlers.get("subagent")({
    action: "invoke",
    prompt: "must not delegate",
  }, {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.availability, "unavailable");
  assert.equal(result.structuredContent.taskCreated, false);
  assert.equal(result.structuredContent.stage, "chrome_startup");
  assert.equal(result.structuredContent.reason, "SUBAGENT_CHROME_LAUNCH_FAILED");
});

test("model-facing delegation invokes one task and waits only through subagent_wait", async () => {
  const handlers = new Map();
  const definitions = new Map();
  let startedWith = null;
  let waitedFor = null;
  const progressNotifications = [];
  const server = {
    registerTool(name, definition, fn) {
      definitions.set(name, definition);
      handlers.set(name, fn);
    },
  };
  registerSubagents(server, {
    ensureBrowser: async () => ({ ready: true, silentDebugger: false }),
    startTask: async (input) => {
      startedWith = input;
      return {
        runId: "sa_invoke_1",
        status: "running",
        results: [{ id: "research", status: "running" }],
      };
    },
    listActiveTasks: () => [],
    waitTasks: async (taskIds) => {
      waitedFor = taskIds;
      return {
        kind: "subagent_wait",
        task_ids: [...taskIds],
        status: "finished",
        completed: 2,
        failed: 0,
        running: 0,
        wait_timed_out: false,
        wait_cancelled: false,
        results: [
          { task_id: taskIds[0], id: "research", status: "completed", response: "A" },
          { task_id: taskIds[1], id: "review", status: "completed", response: "B" },
        ],
      };
    },
  });

  const invoked = await handlers.get("subagent")({ action: "invoke", prompt: "Investigate", id: "research" }, {});
  assert.equal(invoked.isError, undefined);
  assert.equal(invoked.structuredContent.task_id, "sa_invoke_1");
  assert.equal(invoked.structuredContent.id, "research");
  assert.equal(startedWith.tasks.length, 1);
  assert.deepEqual(startedWith.tasks[0], { id: "research", prompt: "Investigate" });
  assert.equal(startedWith.agentTimeoutMs, 3_600_000);

  const waited = await handlers.get("subagent_wait")({ task_ids: ["sa_invoke_1", "sa_invoke_2"] }, {
    _meta: { progressToken: "subagent-wait-progress" },
    sendNotification(notification) { progressNotifications.push(notification); },
  });
  assert.deepEqual(waitedFor, ["sa_invoke_1", "sa_invoke_2"]);
  assert.equal(progressNotifications[0].method, "notifications/progress");
  assert.equal(progressNotifications[0].params.progressToken, "subagent-wait-progress");
  assert.match(progressNotifications[0].params.message, /Waiting for 2 delegated sub-agent tasks/);
  assert.equal(waited.structuredContent.results[1].response, "B");

  assert.deepEqual(Object.keys(definitions.get("subagent").inputSchema).sort(), ["action", "id", "prompt"]);
  assert.deepEqual(Object.keys(definitions.get("subagent_wait").inputSchema), ["task_ids"]);
  assert.doesNotMatch(definitions.get("subagent").description, /concurr|capacity|limit/i);
});

test("subagent capacity is hidden until reached and returns active task ids without creating work", async () => {
  const handlers = new Map();
  let starts = 0;
  const server = { registerTool(name, _definition, fn) { handlers.set(name, fn); } };
  registerSubagents(server, {
    ensureBrowser: async () => ({ ready: true }),
    listActiveTasks: () => [
      { task_id: "sa_active_1", status: "running" },
      { task_id: "sa_active_2", status: "starting" },
      { task_id: "sa_active_3", status: "running" },
    ],
    maxConcurrent: 3,
    startTask: async () => { starts += 1; throw new Error("must not start"); },
  });

  const result = await handlers.get("subagent")({ action: "invoke", prompt: "fourth" }, {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.availability, "capacity_reached");
  assert.equal(result.structuredContent.taskCreated, false);
  assert.equal(result.structuredContent.reason, "SUBAGENT_CONCURRENCY_LIMIT");
  assert.equal(result.structuredContent.retryable, true);
  assert.deepEqual(result.structuredContent.active_task_ids, ["sa_active_1", "sa_active_2", "sa_active_3"]);
  assert.equal(result.structuredContent.pending_starts, 0);
  assert.match(result.content[0].text, /subagent_wait/i);
  assert.equal(starts, 0);
});

test("concurrent invoke admission cannot exceed the hidden cap while starts are pending", async () => {
  const handlers = new Map();
  const releases = [];
  let startCount = 0;
  const server = { registerTool(name, _definition, fn) { handlers.set(name, fn); } };
  registerSubagents(server, {
    ensureBrowser: async () => ({ ready: true }),
    listActiveTasks: () => [],
    maxConcurrent: 2,
    startTask: async ({ tasks }) => {
      startCount += 1;
      const number = startCount;
      await new Promise((resolve) => releases.push(resolve));
      return {
        runId: `sa_pending_${number}`,
        status: "running",
        results: [{ id: tasks[0].id || `task-${number}`, status: "running" }],
      };
    },
  });

  const invoke = handlers.get("subagent");
  const first = invoke({ action: "invoke", prompt: "one", id: "one" }, {});
  const second = invoke({ action: "invoke", prompt: "two", id: "two" }, {});
  while (startCount < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  const third = await invoke({ action: "invoke", prompt: "three", id: "three" }, {});

  assert.equal(third.isError, true);
  assert.equal(third.structuredContent.reason, "SUBAGENT_CONCURRENCY_LIMIT");
  assert.equal(third.structuredContent.pending_starts, 2);
  assert.deepEqual(third.structuredContent.active_task_ids, []);
  assert.match(third.content[0].text, /earlier subagent invocations return their task_ids/i);
  assert.equal(startCount, 2);

  for (const release of releases) release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.isError, undefined);
  assert.equal(secondResult.isError, undefined);
});

test("failed invocation releases its admission reservation", async () => {
  const handlers = new Map();
  let attempts = 0;
  const server = { registerTool(name, _definition, fn) { handlers.set(name, fn); } };
  registerSubagents(server, {
    ensureBrowser: async () => ({ ready: true }),
    listActiveTasks: () => [],
    maxConcurrent: 1,
    startTask: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic start failure");
      return { runId: "sa_retry_ok", status: "running", results: [{ id: "retry", status: "running" }] };
    },
  });

  const invoke = handlers.get("subagent");
  const failed = await invoke({ action: "invoke", prompt: "first" }, {});
  assert.equal(failed.isError, true);
  const retried = await invoke({ action: "invoke", prompt: "retry", id: "retry" }, {});
  assert.equal(retried.isError, undefined);
  assert.equal(retried.structuredContent.task_id, "sa_retry_ok");
  assert.equal(attempts, 2);
});

test("active task discovery ignores terminal runs and preserves task ids", () => {
  const runDir = tempRunDir();
  for (const id of ["sa_running", "sa_done", "sa_failed"]) {
    fs.writeFileSync(path.join(runDir, `${id}.json`), "{}\n");
  }
  fs.writeFileSync(path.join(runDir, "sa_running.state.json"), "{}\n");
  const statuses = new Map([
    ["sa_running", { status: "running" }],
    ["sa_done", { status: "completed" }],
    ["sa_failed", { status: "failed" }],
  ]);
  const active = listActiveSubagentTasks({ runDir, get: (taskId) => statuses.get(taskId) });
  assert.deepEqual(active, [{ task_id: "sa_running", status: "running" }]);
});

function readyPreflight(hostId = "host_test") {
  return async () => ({
    ok: true,
    stdout: JSON.stringify({
      schema: 1,
      command: "subagents-preflight",
      ok: true,
      ready: true,
      reason: "READY",
      hostId,
      extensionInstanceId: "instance_test",
    }),
    stderr: "",
  });
}

function acceptedGet(runDir, processId) {
  return (runId) => {
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, `${runId}.json`), "utf8"));
    const state = JSON.parse(fs.readFileSync(meta.statePath, "utf8"));
    if (state.status === "starting") {
      state.status = "running";
      state.phase = "accepted";
      state.results = state.results.map((item) => ({ ...item, status: "running", phase: "accepted" }));
      fs.writeFileSync(meta.statePath, `${JSON.stringify(state)}\n`);
    }
    return getSubagentRun(runId, {
      runDir,
      processes: () => [{ id: processId, running: true, state: "running" }],
    });
  };
}

async function startAcceptedRun({ runDir, processId, tasks, now = () => new Date("2026-08-30T12:00:00Z") }) {
  return startSubagentRun(
    { tasks },
    {
      start: () => ({ id: processId }),
      preflight: readyPreflight(),
      get: acceptedGet(runDir, processId),
      runDir,
      now,
    },
  );
}

test("start preflights before creating a detached accepted normal-worker run and injects delegation boundary", async () => {
  const runDir = tempRunDir();
  let captured;
  let preflightCalled = false;
  const start = (command, options) => {
    assert.equal(preflightCalled, true, "browser preflight must finish before detached runner starts");
    captured = { command, options };
    return { id: "p_test_start" };
  };
  const result = await startSubagentRun(
    {
      tasks: [
        { prompt: "Research A" },
        { id: "b", prompt: "Research B" },
      ],
    },
    {
      start,
      preflight: async () => {
        preflightCalled = true;
        return readyPreflight("host_accepted")();
      },
      get: acceptedGet(runDir, "p_test_start"),
      bin: "/tmp/cwa",
      cwd: "/tmp",
      runDir,
      now: () => new Date("2026-08-30T12:00:00Z"),
    },
  );

  assert.equal(result.status, "running");
  assert.equal(result.phase, "accepted");
  assert.equal(result.processRunning, true);
  assert.equal(result.agentTimeoutMs, 3_600_000);
  assert.equal(result.results[0].id, "task-1");
  assert.equal("chatMode" in result.results[0], false);
  assert.equal("chatMode" in result.results[1], false);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.command[0], "/tmp/cwa");
  assert.equal(captured.command[1], "subagents");
  assert.ok(captured.command.includes("--state-json"));
  assert.ok(captured.command.includes("--batch-id"));
  assert.ok(captured.command.includes("3600"));

  const inputPath = captured.command[captured.command.indexOf("--input-json") + 1];
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  assert.equal(payload.batchId, result.runId);
  assert.equal(payload.expectedHostId, "host_accepted");
  assert.equal(payload.expectedExtensionInstanceId, "instance_test");
  assert.equal(payload.expectedBrowserProduct, "chrome");
  assert.equal("chatMode" in payload.tasks[0], false);
  assert.match(payload.tasks[0].prompt, /Do not invoke Local-System\.subagent/);
  assert.match(payload.tasks[0].prompt, /Assigned task:\nResearch A/);
});

test("start rejects the removed chatMode semantic", async () => {
  await assert.rejects(
    startSubagentRun(
      { tasks: [{ prompt: "legacy mode", chatMode: "temporary" }] },
      { runDir: tempRunDir(), preflight: readyPreflight("host_legacy") },
    ),
    /chatMode is no longer supported/,
  );
});

test("preflight failure returns no accepted run and never starts the detached runner", async () => {
  const runDir = tempRunDir();
  let startCalled = false;
  await assert.rejects(
    startSubagentRun(
      { tasks: [{ prompt: "must not start" }] },
      {
        runDir,
        start: () => { startCalled = true; return { id: "p_should_not_start" }; },
        preflight: async () => ({
          ok: false,
          stdout: JSON.stringify({
            schema: 1,
            command: "subagents-preflight",
            ok: false,
            ready: false,
            reason: "HOST_DISCOVERY_UNAVAILABLE",
          }),
          stderr: "",
        }),
      },
    ),
    /HOST_DISCOVERY_UNAVAILABLE/,
  );
  assert.equal(startCalled, false);
  assert.equal(fs.readdirSync(runDir).filter((name) => /^sa_.*\.json$/.test(name)).length, 0);
});

test("start returns an active run when acceptedAt is durable even after phase advances between polls", async () => {
  const runDir = tempRunDir();
  const result = await startSubagentRun(
    { tasks: [{ id: "research", prompt: "research" }] },
    {
      runDir,
      start: () => ({ id: "p_accepted_advanced" }),
      preflight: readyPreflight("host_advanced"),
      get: (runId) => {
        const meta = JSON.parse(fs.readFileSync(path.join(runDir, `${runId}.json`), "utf8"));
        const running = {
          ok: false,
          batchId: runId,
          status: "running",
          phase: "running",
          taskCount: 1,
          completed: 0,
          failed: 0,
          reconciliationRequired: 0,
          running: 1,
          acceptedAt: "2026-08-30T12:00:01Z",
          results: [{
            index: 0,
            id: "research",
            status: "running",
            phase: "delegating",
            reasoning: "default_unproven",
          }],
        };
        fs.writeFileSync(meta.statePath, `${JSON.stringify(running)}\n`);
        return { ...running, runId, processRunning: true };
      },
      now: () => new Date("2026-08-30T12:00:00Z"),
    },
  );
  assert.equal(result.status, "running");
  assert.equal(result.phase, "running");
  assert.equal(result.acceptedAt, "2026-08-30T12:00:01Z");
  assert.equal(result.results[0].phase, "delegating");
  assert.equal(result.processRunning, true);
});

test("start returns a terminal run when it completed after acceptance between bridge polls", async () => {
  const runDir = tempRunDir();
  const result = await startSubagentRun(
    { tasks: [{ id: "fast", prompt: "fast" }] },
    {
      runDir,
      start: () => ({ id: "p_fast_terminal" }),
      preflight: readyPreflight("host_fast"),
      get: (runId) => {
        const meta = JSON.parse(fs.readFileSync(path.join(runDir, `${runId}.json`), "utf8"));
        const completed = {
          ok: true,
          batchId: runId,
          status: "completed",
          phase: "terminal",
          taskCount: 1,
          completed: 1,
          failed: 0,
          reconciliationRequired: 0,
          running: 0,
          acceptedAt: "2026-08-30T12:00:01Z",
          results: [{
            index: 0,
            id: "fast",
            status: "completed",
            reasoning: "default_unproven",
            response: "FAST_OK",
          }],
        };
        fs.writeFileSync(meta.statePath, `${JSON.stringify(completed)}\n`);
        return { ...completed, runId, processRunning: false };
      },
      now: () => new Date("2026-08-30T12:00:00Z"),
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.acceptedAt, "2026-08-30T12:00:01Z");
  assert.equal(result.results[0].response, "FAST_OK");
});

test("terminal state without acceptedAt is still rejected as a failed start", async () => {
  const runDir = tempRunDir();
  await assert.rejects(
    startSubagentRun(
      { tasks: [{ id: "never-accepted", prompt: "x" }] },
      {
        runDir,
        start: () => ({ id: "p_never_accepted" }),
        preflight: readyPreflight("host_never"),
        get: (runId) => ({
          runId,
          status: "failed",
          phase: "preflight_failed",
          taskCount: 1,
          completed: 0,
          failed: 1,
          running: 0,
          results: [{
            id: "never-accepted",
            status: "failed",
            error: { type: "Preflight", message: "NO_ACCEPT" },
          }],
          processRunning: false,
        }),
        now: () => new Date("2026-08-30T12:00:00Z"),
      },
    ),
    /NO_ACCEPT/,
  );
});

test("run observation exposes partial completed results while the detached run remains active", async () => {
  const runDir = tempRunDir();
  const result = await startAcceptedRun({
    runDir,
    processId: "p_partial",
    tasks: [{ id: "a", prompt: "A" }, { id: "b", prompt: "B" }],
  });
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, `${result.runId}.json`), "utf8"));
  const state = JSON.parse(fs.readFileSync(meta.statePath, "utf8"));
  state.completed = 1;
  state.running = 1;
  state.results[0] = { ...state.results[0], status: "completed", response: "A_OK" };
  fs.writeFileSync(meta.statePath, `${JSON.stringify(state)}\n`);

  const observed = getSubagentRun(result.runId, {
    runDir,
    processes: () => [{ id: "p_partial", running: true, state: "running" }],
  });
  assert.equal(observed.status, "running");
  assert.equal(observed.completed, 1);
  assert.equal(observed.running, 1);
  assert.equal(observed.results[0].response, "A_OK");
});

test("subagent_wait aggregates independently invoked task ids and returns immediately when terminal", async () => {
  const snapshots = new Map([
    ["sa_one", { status: "completed", results: [{ id: "one", status: "completed", response: "ONE_OK" }] }],
    ["sa_two", { status: "failed", results: [{ id: "two", status: "failed", error: { type: "WorkerError", message: "boom" } }] }],
  ]);
  const result = await waitSubagentTasks(["sa_one", "sa_two"], { get: (taskId) => snapshots.get(taskId) });
  assert.equal(result.status, "finished");
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.running, 0);
  assert.equal(result.wait_timed_out, false);
  assert.deepEqual(result.results.map((item) => item.task_id), ["sa_one", "sa_two"]);
  assert.equal(result.results[0].response, "ONE_OK");
  assert.equal(result.results[1].error.message, "boom");
});

test("subagent_wait enforces a 30-minute minimum internal observation ceiling", async () => {
  await assert.rejects(
    () => waitSubagentTasks(["sa_running"], {
      waitTimeoutMs: (30 * 60_000) - 1,
      get: () => ({ status: "completed", results: [{ id: "work", status: "completed", response: "DONE" }] }),
    }),
    /at least 1800000 ms/,
  );

  const result = await waitSubagentTasks(["sa_done"], {
    waitTimeoutMs: 30 * 60_000,
    get: () => ({ status: "completed", results: [{ id: "work", status: "completed", response: "DONE" }] }),
  });
  assert.equal(result.status, "finished");
  assert.equal(result.results[0].response, "DONE");
});

test("subagent_wait keeps delegated tasks alive when its observation is interrupted", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await waitSubagentTasks(["sa_running"], {
    signal: controller.signal,
    get: () => ({ status: "running", results: [{ id: "work", status: "running" }] }),
  });
  assert.equal(result.status, "running");
  assert.equal(result.wait_cancelled, true);
  assert.equal(result.running, 1);
});

test("runner termination reconciliation is persisted instead of leaving stale running state", async () => {
  const runDir = tempRunDir();
  const started = await startAcceptedRun({
    runDir,
    processId: "p_reconcile",
    tasks: [{ id: "a", prompt: "A" }],
  });
  const observed = getSubagentRun(started.runId, {
    runDir,
    processes: () => [{ id: "p_reconcile", running: false, state: "failed", exitCode: 3 }],
  });
  assert.equal(observed.status, "failed");
  assert.equal(observed.running, 0);
  assert.equal(observed.results[0].error.type, "RunnerTerminated");
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, `${started.runId}.json`), "utf8"));
  const persisted = JSON.parse(fs.readFileSync(meta.statePath, "utf8"));
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.phase, "runner_terminated");
  assert.equal(persisted.results[0].error.type, "RunnerTerminated");
});

test("missing managed process record fails closed and persists terminal state", async () => {
  const runDir = tempRunDir();
  const started = await startAcceptedRun({
    runDir,
    processId: "p_missing",
    tasks: [{ id: "a", prompt: "A" }],
  });
  const observed = getSubagentRun(started.runId, { runDir, processes: () => [] });
  assert.equal(observed.status, "failed");
  assert.match(observed.results[0].error.message, /state missing/);
});
