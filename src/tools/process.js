import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { COMMAND_WAIT_MS, MAX_STDERR_CHARS, MAX_STDOUT_CHARS } from "../lib/config.js";
import { listProcesses, sendProcessInput, startProcess, stopProcess, tailFile, waitProcess } from "../lib/exec.js";
import { destructiveApprovalFailure, inspectDestructive, recordDestructiveExecution, requestDestructiveApproval } from "../lib/policy.js";
import { assertInWorkspace, currentProjectWorkspace, resolveUserPath } from "../lib/paths.js";
import { clip, fail, structured } from "../lib/text.js";
import { withInlineImages } from "../lib/inline-images.js";
import { registerOptionalAppTool } from "../lib/tool-ui.js";

const MANAGE_TASK_ACTIONS = ["list", "status", "send_input", "kill"];
// Records are retained for two weeks, so a listing is unbounded by nature: a
// long-lived bridge accumulates hundreds. Return a working set and let
// action=status fetch the one that matters.
const TASK_LIST_LIMIT = 20;
// Enough of a command to recognize it in a list; more of it comes back in status.
const TASK_LIST_COMMAND_CHARS = 300;
// A command may be 100k characters. Echoing one back whole spends the model's
// context on text it just sent, so identify the command rather than repeat it.
const TASK_COMMAND_CHARS = 2_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const COMMAND_RESULT_RESOURCE_URI = "ui://sol/command-result.html";
const COMMAND_RESULT_HTML = fs.readFileSync(path.resolve(here, "../apps/command-result.html"), "utf8");

export function registerProcess(server) {
  registerOptionalAppTool(server, "execute_command", {
    title: "Execute command",
    description: "Run a local command as a managed task. Images it produces come back inline. Destructive commands pause for approval.",
    inputSchema: {
      command: z.string().min(1).max(100_000),
      cwd: z.string().optional().describe("Defaults to the current project; pass localScratchDir for non-project work."),
      waitMs: z.number().int().min(0).max(300_000).optional()
        .describe("How long to wait for completion before returning a running task. 0 returns immediately; default is 10000 ms."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, COMMAND_RESULT_RESOURCE_URI, async ({ command, cwd, waitMs }, extra) => {
    let destructiveApproval = null;
    let approvalWaitMs = null;
    try {
      const root = cwd ? assertInWorkspace(resolveUserPath(cwd), { write: true }) : currentProjectWorkspace();
      if (!root) return fail("no current project workspace — use workspace action=open first or pass cwd, such as localScratchDir from bridge_context");
      const inspection = inspectDestructive(command);
      if (inspection.destructive) {
        const approvalStartedAt = Date.now();
        destructiveApproval = await requestDestructiveApproval(
          { kind: "process_start", command, cwd: root, waitMs, matches: inspection.matches },
          extra,
        );
        approvalWaitMs = Math.max(0, Date.now() - approvalStartedAt);
        if (!destructiveApproval.approved) return fail(destructiveApprovalFailure(destructiveApproval));
      }
      const meta = startProcess(command, { cwd: root });
      const observed = await waitProcess(meta.id, {
        waitMs: waitMs ?? COMMAND_WAIT_MS,
        lines: 80,
        signal: extra?.signal,
      });
      const data = commandTaskResult(observed);
      if (approvalWaitMs != null) data.approvalWaitMs = approvalWaitMs;
      recordDestructiveExecution(destructiveApproval, { ok: data.running || data.ok, code: data.exitCode });
      return taskResult(commandSummary(data), data);
    } catch (error) {
      recordDestructiveExecution(destructiveApproval, { error: error.message });
      return fail(error.message);
    }
  });

  registerAppResource(server, "Command Result", COMMAND_RESULT_RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: COMMAND_RESULT_RESOURCE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: COMMAND_RESULT_HTML,
    }],
  }));

  server.registerTool("manage_task", {
    title: "Manage task",
    description: "Inspect or control tasks returned by execute_command.",
    inputSchema: {
      action: z.enum(MANAGE_TASK_ACTIONS),
      taskId: z.string().optional().describe("Required for status, send_input, and kill."),
      input: z.string().min(1).max(100_000).optional().describe("For send_input; sent exactly as provided."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ action, taskId, input }) => {
    try {
      if (action === "list") {
        if (taskId || input !== undefined) return fail("taskId and input are not valid for manage_task action=list");
        const page = selectTaskPage(listProcesses());
        const tasks = page.selected.map((item) => taskSnapshot(item, { commandChars: TASK_LIST_COMMAND_CHARS }));
        return structured(
          page.omitted > 0
            ? `Returned ${tasks.length} of ${page.total} managed tasks (${page.running} running); ${page.omitted} older ones omitted.`
            : `Returned ${tasks.length} managed tasks (${page.running} running).`,
          { tasks, total: page.total, returned: tasks.length, running: page.running, omitted: page.omitted },
        );
      }

      if (!taskId) return fail(`taskId is required for manage_task action=${action}`);

      if (action === "status") {
        if (input !== undefined) return fail("input is valid only for manage_task action=send_input");
        const match = findTask(taskId);
        const data = taskSnapshot(match, { logs: true });
        return taskResult(`Task ${taskId} is ${data.state}.`, data);
      }

      if (action === "send_input") {
        if (input === undefined) return fail("input is required for manage_task action=send_input");
        await sendProcessInput(taskId, input);
        const data = taskSnapshot(findTask(taskId), { logs: true });
        return taskResult(`Input sent to task ${taskId}.`, data);
      }

      if (action === "kill") {
        if (input !== undefined) return fail("input is valid only for manage_task action=send_input");
        const data = taskSnapshot(await stopProcess(taskId), { logs: true });
        return taskResult(`Killed task ${taskId}.`, data);
      }

      return fail(`unsupported manage_task action: ${action}`);
    } catch (error) {
      return fail(error.message);
    }
  });



}

// Running tasks are the only ones still actionable, so they are never what gets
// dropped when the retained history is longer than one page.
export function selectTaskPage(all, limit = TASK_LIST_LIMIT) {
  const running = all.filter((item) => item.running);
  const selected = [...running, ...all.filter((item) => !item.running)].slice(0, limit);
  return { selected, total: all.length, running: running.length, omitted: Math.max(0, all.length - selected.length) };
}

// structuredContent is what the model reads, and nothing else clips it. Images
// are extracted first because the markers live at the end of a stream, which is
// exactly what a size cap would cut off.
function taskResult(summary, data) {
  if (data) {
    if (data.stdout) data.stdout = clip(data.stdout, MAX_STDOUT_CHARS, { tail: true });
    if (data.stderr) data.stderr = clip(data.stderr, MAX_STDERR_CHARS, { tail: true });
  }
  return withInlineImages(structured(summary, data), data);
}

function commandSummary(result) {
  if (result.waitCancelled && result.running) return `Stopped waiting; task ${result.taskId} is still running.`;
  if (result.running) return `Command is still running as task ${result.taskId}.`;
  if (result.ok) return "Command succeeded.";
  return `Command failed${result.exitCode == null ? "." : ` with exit code ${result.exitCode}.`}`;
}

function commandTaskResult(record) {
  const task = taskSnapshot(record, { logs: true });
  const ok = task.state === "completed" && task.exitCode === 0;
  if (task.running) {
    return {
      taskId: task.taskId,
      running: true,
      stdout: task.stdout,
      stderr: task.stderr,
      ...(task.waitTimedOut ? { waitTimedOut: true } : {}),
      ...(task.waitCancelled ? { waitCancelled: true } : {}),
    };
  }
  return {
    ok,
    stdout: task.stdout,
    stderr: task.stderr,
    ...(!ok && task.exitCode != null ? { exitCode: task.exitCode } : {}),
    ...(!ok && task.signal ? { signal: task.signal } : {}),
  };
}

function findTask(taskId) {
  const match = listProcesses().find((item) => item.id === taskId);
  if (!match) throw new Error(`unknown managed task ${taskId}`);
  return match;
}

function taskSnapshot(record, { logs = false, commandChars = TASK_COMMAND_CHARS } = {}) {
  const data = {
    taskId: record.id,
    command: clip(record.command, commandChars),
    cwd: record.cwd,
    startedAt: record.startedAt,
    state: record.state,
    running: Boolean(record.running),
    exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null,
    signal: record.signal || null,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
    ...(record.waitTimedOut !== undefined ? { waitTimedOut: Boolean(record.waitTimedOut) } : {}),
    ...(record.waitCancelled ? { waitCancelled: true } : {}),
  };
  if (logs) {
    data.stdout = record.stdout ?? tailFile(record.stdoutPath, 80);
    data.stderr = record.stderr ?? tailFile(record.stderrPath, 80);
  }
  return data;
}
