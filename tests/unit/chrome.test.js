import test from "node:test";
import assert from "node:assert/strict";
import {
  CHROME_SILENT_DEBUGGER_FLAG,
  MAC_CHROME_BINARY,
  ensureSilentDebuggerChrome,
  parseMacChromeMainProcesses,
} from "../../src/lib/chrome.js";

function result(stdout = "") {
  return { ok: true, stdout, stderr: "", code: 0 };
}

test("Chrome process parser identifies only the main app and the silent debugger flag", () => {
  const parsed = parseMacChromeMainProcesses([
    ` 101 ${MAC_CHROME_BINARY} ${CHROME_SILENT_DEBUGGER_FLAG}`,
    " 102 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer",
    " 103 /Applications/Dia.app/Contents/MacOS/Dia",
  ].join("\n"));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].pid, 101);
  assert.equal(parsed[0].silentDebugger, true);
});

test("running normal Chrome without the silent flag is reused", async () => {
  const calls = [];
  const run = async (command) => {
    calls.push(command);
    return result(` 201 ${MAC_CHROME_BINARY}\n`);
  };
  const health = await ensureSilentDebuggerChrome({ browser: "chrome", platform: "darwin", run });
  assert.equal(health.ready, true);
  assert.equal(health.action, "reused");
  assert.equal(health.silentDebugger, false);
  assert.equal(calls.length, 1, "must inspect only; no second Chrome launch is allowed");
});

test("Chrome started without the silent flag is still accepted after launch", async () => {
  const calls = [];
  let inspections = 0;
  const run = async (command) => {
    calls.push(command);
    if (command[0] === "/usr/bin/open") return result();
    inspections += 1;
    return inspections === 1 ? result("") : result(` 211 ${MAC_CHROME_BINARY}\n`);
  };
  const health = await ensureSilentDebuggerChrome({
    browser: "chrome",
    platform: "darwin",
    run,
    sleep: async () => {},
  });
  assert.equal(health.ready, true);
  assert.equal(health.action, "launched");
  assert.equal(health.silentDebugger, false);
});

test("running Chrome with the silent flag is reused", async () => {
  const run = async () => result(` 301 ${MAC_CHROME_BINARY} ${CHROME_SILENT_DEBUGGER_FLAG}\n`);
  const health = await ensureSilentDebuggerChrome({ browser: "chrome", platform: "darwin", run });
  assert.equal(health.ready, true);
  assert.equal(health.action, "reused");
  assert.equal(health.pid, 301);
  assert.equal(health.silentDebugger, true);
});

test("absent Chrome is launched once with silent debugging and the normal profile", async () => {
  const calls = [];
  let inspections = 0;
  const run = async (command) => {
    calls.push(command);
    if (command[0] === "/usr/bin/open") return result();
    inspections += 1;
    return inspections === 1
      ? result("")
      : result(` 401 ${MAC_CHROME_BINARY} ${CHROME_SILENT_DEBUGGER_FLAG}\n`);
  };
  const health = await ensureSilentDebuggerChrome({
    browser: "chrome",
    platform: "darwin",
    run,
    sleep: async () => {},
  });
  assert.equal(health.ready, true);
  assert.equal(health.action, "launched");
  const launch = calls.find((command) => command[0] === "/usr/bin/open");
  assert.deepEqual(launch, [
    "/usr/bin/open",
    "-a",
    "Google Chrome",
    "--args",
    CHROME_SILENT_DEBUGGER_FLAG,
    "about:blank",
  ]);
  assert.equal(launch.includes("-n"), false, "must not request a second application instance");
  assert.equal(launch.some((part) => part.startsWith("--user-data-dir")), false, "must use the normal Chrome profile");
});

test("multiple Chrome main instances fail closed", async () => {
  const run = async () => result([
    ` 501 ${MAC_CHROME_BINARY} ${CHROME_SILENT_DEBUGGER_FLAG}`,
    ` 502 ${MAC_CHROME_BINARY}`,
  ].join("\n"));
  const health = await ensureSilentDebuggerChrome({ browser: "chrome", platform: "darwin", run });
  assert.equal(health.ready, false);
  assert.equal(health.reason, "SUBAGENT_CHROME_MULTIPLE_MAIN_INSTANCES_UNSAFE");
});
