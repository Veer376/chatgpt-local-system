import { runCommand } from "./exec.js";

export const CHROME_SILENT_DEBUGGER_FLAG = "--silent-debugger-extension-api";
export const MAC_CHROME_APP = "Google Chrome";
export const MAC_CHROME_BINARY = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CHROME_START_TIMEOUT_MS = 10_000;
const CHROME_POLL_INTERVAL_MS = 100;

export function parseMacChromeMainProcesses(stdout) {
  const rows = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (!Number.isInteger(pid) || !command.startsWith(MAC_CHROME_BINARY)) continue;
    rows.push({
      pid,
      command,
      silentDebugger: command.split(/\s+/).includes(CHROME_SILENT_DEBUGGER_FLAG),
    });
  }
  return rows;
}

async function inspectMacChrome({ run = runCommand } = {}) {
  const result = await run(["/bin/ps", "axww", "-o", "pid=,command="], {
    shell: false,
    timeoutMs: 5_000,
    maxStdout: 500_000,
    maxStderr: 20_000,
  });
  if (!result?.ok) {
    return {
      ready: false,
      reason: "SUBAGENT_CHROME_PROCESS_INSPECTION_FAILED",
      processes: [],
    };
  }
  return { ready: true, processes: parseMacChromeMainProcesses(result.stdout) };
}

export async function ensureSilentDebuggerChrome({
  browser = "",
  platform = process.platform,
  run = runCommand,
  sleep = delay,
  startupTimeoutMs = CHROME_START_TIMEOUT_MS,
} = {}) {
  if (String(browser || "").trim().toLowerCase() !== "chrome") {
    return { ready: true, required: false, action: "not_chrome" };
  }
  // This bridge currently knows the exact normal-profile Chrome launcher only
  // on macOS. Do not alter behavior on other platforms until an equally strict
  // same-profile/no-second-instance launcher is implemented there.
  if (platform !== "darwin") {
    return { ready: true, required: false, action: "platform_not_managed" };
  }

  let inspection = await inspectMacChrome({ run });
  if (!inspection.ready) return { ...inspection, required: true };
  if (inspection.processes.length > 1) {
    return {
      ready: false,
      required: true,
      action: "blocked",
      reason: "SUBAGENT_CHROME_MULTIPLE_MAIN_INSTANCES_UNSAFE",
      processCount: inspection.processes.length,
    };
  }
  if (inspection.processes.length === 1) {
    const process = inspection.processes[0];
    return {
      ready: true,
      required: true,
      action: "reused",
      pid: process.pid,
      silentDebugger: process.silentDebugger,
    };
  }

  // No Chrome main process exists. `open -a` without `-n` asks LaunchServices
  // for the normal Google Chrome application. No user-data-dir/profile flag is
  // supplied, so Chrome uses the user's normal profile instead of creating an
  // automation-specific instance.
  const launch = await run([
    "/usr/bin/open",
    "-a",
    MAC_CHROME_APP,
    "--args",
    CHROME_SILENT_DEBUGGER_FLAG,
    "about:blank",
  ], {
    shell: false,
    timeoutMs: 10_000,
    maxStdout: 20_000,
    maxStderr: 20_000,
  });
  if (!launch?.ok) {
    return {
      ready: false,
      required: true,
      action: "launch_failed",
      reason: "SUBAGENT_CHROME_SILENT_LAUNCH_FAILED",
    };
  }

  const deadline = Date.now() + Math.max(1_000, Number(startupTimeoutMs) || CHROME_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(CHROME_POLL_INTERVAL_MS);
    inspection = await inspectMacChrome({ run });
    if (!inspection.ready) return { ...inspection, required: true };
    if (inspection.processes.length > 1) {
      return {
        ready: false,
        required: true,
        action: "blocked",
        reason: "SUBAGENT_CHROME_MULTIPLE_MAIN_INSTANCES_UNSAFE",
        processCount: inspection.processes.length,
      };
    }
    if (inspection.processes.length !== 1) continue;
    const process = inspection.processes[0];
    return {
      ready: true,
      required: true,
      action: "launched",
      pid: process.pid,
      silentDebugger: process.silentDebugger,
    };
  }

  return {
    ready: false,
    required: true,
    action: "launch_timeout",
    reason: "SUBAGENT_CHROME_SILENT_LAUNCH_TIMEOUT",
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
