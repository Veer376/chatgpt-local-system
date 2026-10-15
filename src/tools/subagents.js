import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CHATGPT_AGENT_BIN,
  MAX_CONCURRENT_SUBAGENTS,
  SUBAGENT_BROWSER,
  SUBAGENT_RUN_DIR,
  atomicWriteJson,
  currentScratchDir,
  ensureStateDirs,
} from "../lib/config.js";
import { ensureSilentDebuggerChrome } from "../lib/chrome.js";
import { listProcesses, runCommand, startProcess, stopProcess } from "../lib/exec.js";
import { fail, structured } from "../lib/text.js";

const MAX_WAIT_TASKS = 8;
const MAX_TASKS = 8; // Internal adapter batch ceiling; model-facing subagent always starts exactly one.
const DEFAULT_AGENT_TIMEOUT_MS = 3_600_000;
const MAX_AGENT_TIMEOUT_MS = 21_600_000;
const MIN_SUBAGENT_WAIT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = DEFAULT_AGENT_TIMEOUT_MS + 60_000;
const POLL_INTERVAL_MS = 200;
// Adapter full preflight owns a single 60s browser budget. Keep bridge-side
// ceilings comfortably above that budget so process startup / state-file
// propagation cannot turn a legitimate bounded preflight into a false
// SUBAGENT_RUNNER_ACCEPT_TIMEOUT.
const START_PREFLIGHT_TIMEOUT_MS = 90_000;
const START_ACCEPT_TIMEOUT_MS = 90_000;
const RUN_ID_PATTERN = /^sa_[A-Za-z0-9_-]+$/;
const DELEGATION_BOUNDARY = [
  "Delegation boundary: you are a delegated sub-agent. Complete this task directly.",
  "Do not invoke Local-System.subagent or delegate to another sub-agent.",
  "You may use other available tools, including Local-System tools, when the task requires them.",
].join(" ");

export function registerSubagents(
  server,
  {
    ensureBrowser = ensureSilentDebuggerChrome,
    startTask = startSubagentRun,
    waitTasks = waitSubagentTasks,
    listActiveTasks = listActiveSubagentTasks,
    maxConcurrent = MAX_CONCURRENT_SUBAGENTS,
  } = {},
) {
  const admission = createSubagentAdmission({ listActiveTasks, maxConcurrent });
  server.registerTool("subagent", {
    title: "Invoke sub-agent",
    description: "Invoke one delegated sub-agent and return its task_id. Collect task_id values and pass them to subagent_wait when results are needed.",
    inputSchema: {
      action: z.enum(["invoke"]),
      prompt: z.string().min(1).max(100_000).describe("Self-contained task for the delegated ChatGPT worker."),
      id: z.string().min(1).max(100).optional().describe("Optional caller label for correlating this task with its result."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ action, prompt, id }) => {
    try {
      if (action !== "invoke") return fail("subagent action must be invoke");
      const chromeHealth = await ensureBrowser({ browser: SUBAGENT_BROWSER });
      if (chromeHealth.ready !== true) {
        throw new SubagentUnavailableError(
          chromeHealth.reason || "SUBAGENT_CHROME_SILENT_DEBUGGER_UNAVAILABLE",
          {
            stage: "chrome_startup",
            reason: chromeHealth.reason || "SUBAGENT_CHROME_SILENT_DEBUGGER_UNAVAILABLE",
            retryable: chromeHealth.action === "launch_timeout",
            health: chromeHealth,
          },
        );
      }
      const reservation = await admission.reserve();
      if (!reservation.ok) {
        const activeTaskIds = reservation.activeTaskIds;
        return subagentStructured(
          capacityMessage(reservation),
          {
            availability: "capacity_reached",
            taskCreated: false,
            reason: "SUBAGENT_CONCURRENCY_LIMIT",
            retryable: true,
            active_task_ids: activeTaskIds,
            pending_starts: reservation.pendingStarts,
          },
          { isError: true },
        );
      }
      try {
        const data = await startTask({
          tasks: [{ ...(id ? { id } : {}), prompt }],
          agentTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
        });
        const result = invocationResult(data);
        return subagentStructured(`Invoked sub-agent task ${result.task_id}.`, result);
      } finally {
        reservation.release();
      }
    } catch (error) {
      if (error instanceof SubagentUnavailableError) {
        return subagentStructured(
          "Sub-agent is unavailable; no task was created. If delegation was explicitly required, report this rather than silently substituting it.",
          {
            availability: "unavailable",
            taskCreated: false,
            ...error.details,
          },
          { isError: true },
        );
      }
      return fail(`sub-agent invoke failed: ${error.message}`);
    }
  });

  server.registerTool("subagent_wait", {
    title: "Wait for sub-agents",
    description: "Wait for task_ids from subagent. Finished tasks return at once and results are kept, so a late wait still gets them. Default: 61 minutes.",
    inputSchema: {
      task_ids: z.array(z.string().regex(RUN_ID_PATTERN)).min(1).max(MAX_WAIT_TASKS).describe("task_id values returned by subagent."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ task_ids }, extra) => {
    const stopHeartbeat = startSubagentWaitHeartbeat({
      progressToken: extra?._meta?.progressToken,
      sendNotification: extra?.sendNotification,
      taskIds: task_ids,
    });
    try {
      const data = await waitTasks(task_ids, { signal: extra?.signal });
      return subagentStructured(waitSummary(data), data);
    } catch (error) {
      return fail(`sub-agent wait failed: ${error.message}`);
    } finally {
      stopHeartbeat();
    }
  });
}

function subagentStructured(summary, value, extra = {}) {
  return {
    ...structured(summary, value, extra),
    structuredContent: value,
  };
}

function capacityMessage({ activeCount, activeTaskIds, pendingStarts }) {
  const countText = `${activeCount} active or starting task${activeCount === 1 ? "" : "s"}`;
  if (activeTaskIds.length > 0) {
    return `Sub-agent capacity is full with ${countText}. Call subagent_wait for the returned active_task_ids, then retry this invocation.`;
  }
  if (pendingStarts > 0) {
    return `Sub-agent capacity is full with ${countText}. Let the earlier subagent invocations return their task_ids, wait for them with subagent_wait, then retry.`;
  }
  return `Sub-agent capacity is full with ${countText}. Wait for earlier sub-agent work to finish, then retry this invocation.`;
}

function createSubagentAdmission({ listActiveTasks, maxConcurrent }) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("maxConcurrent must be a positive integer");
  let pendingStarts = 0;
  let gate = Promise.resolve();

  const withGate = async (fn) => {
    const previous = gate;
    let releaseGate;
    gate = new Promise((resolve) => { releaseGate = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      releaseGate();
    }
  };

  return {
    reserve() {
      return withGate(async () => {
        const active = await Promise.resolve(listActiveTasks());
        const activeTaskIds = active.map((item) => item.task_id);
        const activeCount = activeTaskIds.length + pendingStarts;
        if (activeCount >= maxConcurrent) {
          return { ok: false, activeCount, activeTaskIds, pendingStarts };
        }
        pendingStarts += 1;
        let released = false;
        return {
          ok: true,
          release() {
            if (released) return;
            released = true;
            pendingStarts = Math.max(0, pendingStarts - 1);
          },
        };
      });
    },
  };
}

export function listActiveSubagentTasks({ runDir = SUBAGENT_RUN_DIR, get = null } = {}) {
  ensureStateDirs();
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const observe = typeof get === "function" ? get : (taskId) => getSubagentRun(taskId, { runDir });
  const metaNames = fs.readdirSync(runDir).filter((name) => /^sa_[A-Za-z0-9_-]+\.json$/.test(name));
  const active = [];
  for (const name of metaNames) {
    const taskId = name.slice(0, -".json".length);
    const snapshot = observe(taskId);
    if (isActiveRunStatus(snapshot.status)) {
      active.push({ task_id: taskId, status: snapshot.status });
    }
  }
  return active;
}

function invocationResult(snapshot) {
  const worker = Array.isArray(snapshot?.results) ? snapshot.results[0] : null;
  return {
    kind: "subagent_task",
    task_id: snapshot.runId,
    ...(worker?.id ? { id: worker.id } : {}),
    status: worker?.status || snapshot.status || "running",
  };
}

function startSubagentWaitHeartbeat({ progressToken, sendNotification, taskIds }) {
  if (progressToken == null || typeof sendNotification !== "function") return () => {};
  let progress = 0;
  const send = () => {
    progress += 1;
    void Promise.resolve(sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        message: `Waiting for ${taskIds.length} delegated sub-agent task${taskIds.length === 1 ? "" : "s"} to finish.`,
      },
    })).catch(() => {});
  };
  send();
  const timer = setInterval(send, 20_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function waitSummary(data) {
  if (data.wait_timed_out) {
    return `Sub-agent wait reached its internal observation ceiling with ${data.running} task${data.running === 1 ? "" : "s"} still running. Call subagent_wait again with the same task_ids to continue waiting.`;
  }
  if (data.wait_cancelled) {
    return "Sub-agent wait was interrupted; delegated tasks continue running. Call subagent_wait again with the same task_ids when results are needed.";
  }
  return `Sub-agent wait finished for ${data.results.length} task${data.results.length === 1 ? "" : "s"}: ${data.completed} completed, ${data.failed} failed.`;
}

class SubagentUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SubagentUnavailableError";
    this.details = details;
  }
}

export async function startSubagentRun(
  { tasks, agentTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS },
  {
    bin = CHATGPT_AGENT_BIN,
    cwd,
    start = startProcess,
    preflight = runCommand,
    stop = stopProcess,
    get = null,
    runDir = SUBAGENT_RUN_DIR,
    now = () => new Date(),
    sleep = delay,
  } = {},
) {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_TASKS) throw new Error(`tasks must contain between 1 and ${MAX_TASKS} items`);
  if (!Number.isInteger(agentTimeoutMs) || agentTimeoutMs < 30_000 || agentTimeoutMs > MAX_AGENT_TIMEOUT_MS) {
    throw new Error(`agentTimeoutMs must be between 30000 and ${MAX_AGENT_TIMEOUT_MS}`);
  }
  const workDir = cwd || currentScratchDir();
  ensureStateDirs();
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const normalizedTasks = normalizeRunTasks(tasks);
  const browserEnv = SUBAGENT_BROWSER
    ? { CWA_BROWSER_NATIVE_PREFERRED_BROWSER: SUBAGENT_BROWSER }
    : undefined;
  const preflightResult = await preflight([bin, "subagents-preflight"], {
    cwd: workDir,
    shell: false,
    env: browserEnv,
    timeoutMs: START_PREFLIGHT_TIMEOUT_MS,
    maxStdout: 100_000,
    maxStderr: 100_000,
  });
  const preflightPayload = parsePreflightOutput(preflightResult.stdout);
  if (!preflightResult.ok || preflightPayload?.ready !== true) {
    const stderr = String(preflightResult.stderr || "").trim();
    throw new SubagentUnavailableError(
      preflightPayload?.reason || stderr || "SUBAGENT_PREFLIGHT_UNAVAILABLE",
      {
        stage: "preflight",
        reason: preflightPayload?.reason || "SUBAGENT_PREFLIGHT_UNAVAILABLE",
        retryable: isRetryablePreflightReason(preflightPayload?.reason),
        ...(preflightPayload ? { health: preflightPayload } : {}),
      },
    );
  }
  const runId = createRunId(now());
  const inputPath = path.join(runDir, `${runId}.input.json`);
  const statePath = path.join(runDir, `${runId}.state.json`);
  const metaPath = path.join(runDir, `${runId}.json`);
  const timeoutSeconds = agentTimeoutMs / 1000;
  const payload = {
    batchId: runId,
    timeout: timeoutSeconds,
    statePath,
    expectedHostId: preflightPayload.hostId || null,
    expectedExtensionInstanceId: preflightPayload.extensionInstanceId || null,
    expectedBrowserProduct: preflightPayload.browserProduct || SUBAGENT_BROWSER || null,
    tasks: normalizedTasks.map((task) => ({
      id: task.id,
      prompt: `${DELEGATION_BOUNDARY}\n\nAssigned task:\n${task.prompt}`,
    })),
  };
  writePrivateJson(inputPath, payload);
  atomicWriteJson(statePath, initialRunState(runId, normalizedTasks, { status: "starting", phase: "preflight" }));
  let processMeta;
  try {
    processMeta = start([
      bin, "subagents", "--input-json", inputPath, "--timeout", String(timeoutSeconds),
      "--batch-id", runId, "--state-json", statePath,
    ], { cwd: workDir, shell: false, env: browserEnv });
  } catch (error) {
    cleanupInput(inputPath);
    try { fs.unlinkSync(statePath); } catch {}
    throw error;
  }
  const meta = {
    schema: 1,
    runId,
    processId: processMeta.id,
    createdAt: now().toISOString(),
    agentTimeoutMs,
    taskCount: normalizedTasks.length,
    tasks: normalizedTasks.map(({ id }, index) => ({ index, id })),
    inputPath,
    statePath,
    cancelledAt: null,
  };
  atomicWriteJson(metaPath, meta);
  const observe = typeof get === "function"
    ? get
    : (id) => getSubagentRun(id, { runDir });
  const deadline = Date.now() + START_ACCEPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = observe(runId);
    const accepted = typeof snapshot.acceptedAt === "string" && Boolean(snapshot.acceptedAt);
    // acceptedAt is the durable acceptance proof. Worker phases can advance
    // from accepted -> delegating -> streaming between bridge polling ticks, so
    // the transient phase string must never be required once acceptedAt exists.
    if (
      isActiveRunStatus(snapshot.status) &&
      snapshot.processRunning &&
      (accepted || snapshot.phase === "accepted")
    ) {
      return snapshot;
    }
    // The detached runner can also finish between two bridge polling intervals.
    // If acceptedAt was persisted, downstream browser preflight succeeded and
    // that terminal state is a legitimate run outcome, not a start failure.
    if (accepted && !isActiveRunStatus(snapshot.status)) {
      return snapshot;
    }
    if (!isActiveRunStatus(snapshot.status)) {
      throw new SubagentUnavailableError(
        snapshot.failureReason || snapshot.results.find((item) => item.error)?.error?.message || "SUBAGENT_RUNNER_REJECTED_START",
        {
          stage: snapshot.failureStage || snapshot.phase || "runner_preflight",
          reason: snapshot.failureReason || "SUBAGENT_RUNNER_REJECTED_START",
          retryable: true,
          runnerState: snapshot.status,
        },
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  try { await stop(processMeta.id); } catch {}
  const timedOut = {
    ...readProgress(statePath, meta),
    ok: false,
    status: "failed",
    phase: "start_accept_timeout",
    failureStage: "runner_acceptance",
    failureReason: "SUBAGENT_RUNNER_ACCEPT_TIMEOUT",
    running: 0,
    results: normalizedTasks.map((task, index) => ({
      index,
      id: task.id,
      status: "failed",
      reasoning: "default_unproven",
      error: { type: "RunnerAcceptanceTimeout", message: "SUBAGENT_RUNNER_ACCEPT_TIMEOUT" },
    })),
  };
  timedOut.failed = timedOut.results.length;
  atomicWriteJson(statePath, timedOut);
  cleanupInput(inputPath);
  throw new SubagentUnavailableError("SUBAGENT_RUNNER_ACCEPT_TIMEOUT", {
    stage: "runner_acceptance",
    reason: "SUBAGENT_RUNNER_ACCEPT_TIMEOUT",
    retryable: true,
  });
}

export function getSubagentRun(runId, { runDir = SUBAGENT_RUN_DIR, processes = listProcesses } = {}) {
  const meta = readRunMeta(runId, runDir);
  const processRecord = processes().find((item) => item.id === meta.processId) || null;
  const observed = readProgress(meta.statePath, meta);
  const terminal = synthesizeTerminalState(observed, meta, processRecord);
  if (JSON.stringify(terminal) !== JSON.stringify(observed)) {
    atomicWriteJson(meta.statePath, terminal);
  }
  if (!isActiveRunStatus(terminal.status)) cleanupInput(meta.inputPath);
  return {
    ...terminal,
    runId: meta.runId,
    processId: meta.processId,
    createdAt: meta.createdAt,
    agentTimeoutMs: meta.agentTimeoutMs,
    processRunning: Boolean(processRecord?.running),
    ...(meta.cancelledAt ? { cancelledAt: meta.cancelledAt } : {}),
  };
}

export async function waitSubagentTasks(
  taskIds,
  {
    waitTimeoutMs = DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
    signal,
    get = getSubagentRun,
    sleep = delay,
  } = {},
) {
  if (!Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > MAX_WAIT_TASKS) {
    throw new Error(`task_ids must contain between 1 and ${MAX_WAIT_TASKS} task ids`);
  }
  if (new Set(taskIds).size !== taskIds.length) throw new Error("task_ids must not contain duplicates");
  for (const taskId of taskIds) {
    if (typeof taskId !== "string" || !RUN_ID_PATTERN.test(taskId)) throw new Error(`invalid sub-agent task_id: ${taskId}`);
  }
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < MIN_SUBAGENT_WAIT_TIMEOUT_MS) {
    throw new Error(`internal sub-agent wait timeout must be at least ${MIN_SUBAGENT_WAIT_TIMEOUT_MS} ms`);
  }

  let snapshots = taskIds.map((taskId) => get(taskId));
  const deadline = Date.now() + waitTimeoutMs;
  while (snapshots.some((snapshot) => isActiveRunStatus(snapshot.status))) {
    if (signal?.aborted) return waitTaskResult(taskIds, snapshots, { waitCancelled: true });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return waitTaskResult(taskIds, snapshots, { waitTimedOut: true });
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    snapshots = taskIds.map((taskId) => get(taskId));
  }
  return waitTaskResult(taskIds, snapshots);
}

function waitTaskResult(taskIds, snapshots, { waitTimedOut = false, waitCancelled = false } = {}) {
  const results = snapshots.map((snapshot, index) => modelWaitTask(taskIds[index], snapshot));
  const completed = results.filter((item) => item.status === "completed").length;
  const running = results.filter((item) => item.status === "running" || item.status === "starting").length;
  const failed = results.length - completed - running;
  return {
    kind: "subagent_wait",
    task_ids: [...taskIds],
    status: running > 0 ? "running" : "finished",
    completed,
    failed,
    running,
    wait_timed_out: Boolean(waitTimedOut),
    wait_cancelled: Boolean(waitCancelled),
    results,
  };
}

function modelWaitTask(taskId, snapshot) {
  const worker = Array.isArray(snapshot?.results) ? snapshot.results[0] : null;
  const status = worker?.status || snapshot?.status || "failed";
  return {
    task_id: taskId,
    ...(worker?.id ? { id: worker.id } : {}),
    status,
    ...(typeof worker?.response === "string" ? { response: worker.response } : {}),
    ...(worker?.error ? { error: worker.error } : {}),
  };
}


function normalizeRunTasks(tasks) {
  const used = new Set();
  return tasks.map((task, index) => {
    if (!task || typeof task !== "object") throw new Error(`tasks[${index}] must be an object`);
    if (typeof task.prompt !== "string" || !task.prompt.trim()) throw new Error(`tasks[${index}].prompt is required`);
    if ("chatMode" in task || "chat_mode" in task) {
      throw new Error(`tasks[${index}].chatMode is no longer supported; sub-agents use normal worker chats`);
    }
    let id = typeof task.id === "string" && task.id.trim() ? task.id.trim() : `task-${index + 1}`;
    if (used.has(id)) {
      if (task.id) throw new Error(`duplicate sub-agent task id: ${id}`);
      let suffix = 2;
      while (used.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    used.add(id);
    return { id, prompt: task.prompt };
  });
}

function createRunId(now) {
  return `sa_${now.getTime().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function initialRunState(runId, tasks, { status = "running", phase = status } = {}) {
  return {
    schema: 1,
    batchId: runId,
    status,
    phase,
    ok: false,
    executionMode: "parallel",
    reasoning: "default_unproven",
    taskCount: tasks.length,
    completed: 0,
    failed: 0,
    running: isActiveRunStatus(status) ? tasks.length : 0,
    durationMs: 0,
    results: tasks.map((task, index) => ({ index, id: task.id, status: "running", reasoning: "default_unproven" })),
  };
}

function readRunMeta(runId, runDir) {
  if (!RUN_ID_PATTERN.test(String(runId || ""))) throw new Error(`invalid sub-agent run id ${runId}`);
  const metaPath = path.join(runDir, `${runId}.json`);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { throw new Error(`unknown sub-agent run ${runId}`); }
  if (meta?.runId !== runId || typeof meta.processId !== "string" || !Array.isArray(meta.tasks)) throw new Error(`invalid sub-agent run metadata for ${runId}`);
  return meta;
}

function readProgress(statePath, meta) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed?.batchId === meta.runId && Array.isArray(parsed.results)) return parsed;
  } catch {}
  return initialRunState(
    meta.runId,
    meta.tasks.map((task) => ({ id: task.id })),
    { status: "starting", phase: "state_recovery" },
  );
}

function synthesizeTerminalState(progress, meta, processRecord) {
  if (meta.cancelledAt) {
    const results = progress.results.map((item) => item.status === "running" ? { ...item, status: "cancelled" } : item);
    return { ...progress, ok: false, status: "cancelled", running: 0, cancelled: results.filter((item) => item.status === "cancelled").length, results };
  }
  if (!isActiveRunStatus(progress.status) || processRecord?.running) return progress;
  const processState = processRecord?.state || "missing";
  const results = progress.results.map((item) => item.status === "running" ? {
    ...item,
    status: "failed",
    phase: "runner_terminated",
    error: { type: "RunnerTerminated", message: `sub-agent runner ended with state ${processState}` },
  } : item);
  const reconciliationRequired = results.filter((item) => item.status === "reconciliation_required").length;
  return {
    ...progress,
    ok: false,
    status: reconciliationRequired ? "reconciliation_required" : "failed",
    phase: "runner_terminated",
    completed: results.filter((item) => item.status === "completed").length,
    failed: results.filter((item) => item.status === "failed").length,
    reconciliationRequired,
    running: 0,
    results,
  };
}

function isActiveRunStatus(status) {
  return status === "starting" || status === "running";
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
}

function cleanupInput(inputPath) {
  try { fs.unlinkSync(inputPath); } catch {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePreflightOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || parsed.command !== "subagents-preflight") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isRetryablePreflightReason(reason) {
  const normalized = String(reason || "");
  return !/(?:PROTOCOL_MISMATCH|EXTENSION_ID_MISMATCH)/.test(normalized);
}
