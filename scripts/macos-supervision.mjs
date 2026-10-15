import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function delegateToLaunchAgents(repo, action, {
  platform = process.platform,
  home = os.homedir(),
  exists = fs.existsSync,
  run = spawnSync,
} = {}) {
  if (platform !== "darwin") return null;
  const installed = ["server", "tunnel"].map((name) =>
    exists(path.join(home, "Library/LaunchAgents", `com.chatgpt-local-system.${name}.plist`)));
  if (!installed.some(Boolean)) return null;
  if (!installed.every(Boolean)) throw new Error("Incomplete LaunchAgent installation; repair it before starting the stack.");
  const result = run("/bin/bash", [path.join(repo, "scripts/service-macos.sh"), action], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function isDescendant(pid, ancestor, parents) {
  const seen = new Set();
  while (pid > 1 && !seen.has(pid)) {
    if (pid === ancestor) return true;
    seen.add(pid);
    pid = parents.get(pid);
  }
  return false;
}

export function checkOwnership(service, listeners, parents) {
  const state = service.match(/^\s*state = (.+)$/m)?.[1];
  const pid = Number(service.match(/^\s*pid = (\d+)$/m)?.[1]);
  if (state !== "running" || !pid) throw new Error(`LaunchAgent is ${state || "not loaded"}, not running`);
  if (!listeners.length) throw new Error("no listening process");
  if (!listeners.every((listener) => isDescendant(listener, pid, parents))) {
    throw new Error(`port owned outside LaunchAgent (listener PIDs: ${listeners.join(", ")})`);
  }
  return pid;
}
