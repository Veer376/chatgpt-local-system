import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const [invocationPath, statusPath] = process.argv.slice(2);

if (!invocationPath || !statusPath) {
  console.error("managed process runner requires invocation and status paths");
  process.exit(2);
}

function writeStatus(status) {
  const dir = path.dirname(statusPath);
  const temp = path.join(dir, `.${path.basename(statusPath)}.${process.pid}.tmp`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temp, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  fs.renameSync(temp, statusPath);
}

let invocation;
try {
  invocation = JSON.parse(fs.readFileSync(invocationPath, "utf8"));
  try { fs.unlinkSync(invocationPath); } catch {}
} catch (error) {
  writeStatus({
    state: "failed",
    exitCode: null,
    signal: null,
    finishedAt: new Date().toISOString(),
    error: `runner could not load invocation: ${error.message}`,
  });
  console.error(`managed process runner could not load invocation: ${error.message}`);
  process.exit(2);
}

const command = invocation.command;
const shell = invocation.shell === true;
const controlPath = typeof invocation.controlPath === "string" ? invocation.controlPath : "";
const argv = Array.isArray(command)
  ? { file: command[0], args: command.slice(1) }
  : { file: String(command), args: [] };

if (!argv.file) {
  writeStatus({
    state: "failed",
    exitCode: null,
    signal: null,
    finishedAt: new Date().toISOString(),
    error: "runner received an empty command",
  });
  console.error("managed process runner received an empty command");
  process.exit(2);
}

let settled = false;
let controlServer = null;
const cleanupControl = () => {
  try { controlServer?.close(); } catch {}
  if (controlPath && process.platform !== "win32") {
    try { fs.unlinkSync(controlPath); } catch {}
  }
};
const finish = ({ code = null, signal = null, error = null }) => {
  if (settled) return;
  settled = true;
  cleanupControl();
  const state = code === 0 && !signal && !error ? "completed" : "failed";
  writeStatus({
    state,
    exitCode: Number.isInteger(code) ? code : null,
    signal: signal || null,
    finishedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  });
  process.exitCode = Number.isInteger(code) ? code : 1;
};

let child;
try {
  child = spawn(argv.file, argv.args, {
    cwd: process.cwd(),
    env: process.env,
    shell,
    windowsHide: true,
    stdio: ["pipe", "inherit", "inherit"],
  });
} catch (error) {
  finish({ error: error.message });
}

if (child && controlPath) {
  if (process.platform !== "win32") {
    try { fs.unlinkSync(controlPath); } catch {}
  }
  controlServer = net.createServer((socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      if (!child?.stdin?.writable) {
        socket.end("closed");
        return;
      }
      child.stdin.write(Buffer.concat(chunks), (error) => {
        socket.end(error ? `error:${error.message}` : "ok");
      });
    });
  });
  controlServer.on("error", (error) => {
    console.error(`managed process control channel failed: ${error.message}`);
  });
  if (process.platform !== "win32") {
    controlServer.on("listening", () => {
      try { fs.chmodSync(controlPath, 0o600); } catch {}
    });
  }
  controlServer.listen(controlPath);
}

child?.on("error", (error) => {
  console.error(error.message);
  finish({ error: error.message });
});
child?.on("close", (code, signal) => finish({ code, signal }));
