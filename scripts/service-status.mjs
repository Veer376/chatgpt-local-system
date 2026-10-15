#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { checkOwnership } from "./macos-supervision.mjs";
import { httpUrl } from "../src/lib/net.js";

const [host, port, tunnelPort, waitMs = "0", ngrokEnabled = "false"] = process.argv.slice(2);
const domain = `gui/${process.getuid()}`;
const command = (bin, args) => spawnSync(bin, args, { encoding: "utf8", timeout: 3000 }).stdout || "";

async function inspect() {
  const parents = new Map(command("ps", ["-axo", "pid=,ppid="]).trim().split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number)));
  const errors = [];
  const services = [
    ["server", port, httpUrl(host, port, "/readyz")],
    ["tunnel", tunnelPort, httpUrl("127.0.0.1", tunnelPort, "/readyz")],
  ];
  if (ngrokEnabled === "true") services.push(["ngrok", "4048", "http://127.0.0.1:4048/api/tunnels"]);
  for (const [name, listenPort, url] of services) {
    try {
      const service = command("launchctl", ["print", `${domain}/com.chatgpt-local-system.${name}`]);
      const listeners = command("lsof", ["-nP", "-t", `-iTCP:${listenPort}`, "-sTCP:LISTEN"])
        .trim().split(/\s+/).filter(Boolean).map(Number);
      checkOwnership(service, listeners, parents);
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`readiness HTTP ${response.status}`);
      if (name === "server" && (await response.json()).ready !== true) throw new Error("server not ready");
      if (name === "tunnel" && (await response.text()).trim() !== "ready") throw new Error("tunnel not ready");
      if (name === "ngrok") {
        const body = await response.json();
        if (!body.tunnels?.some((tunnel) => tunnel.name === "local-system" && tunnel.public_url?.startsWith("https://"))) {
          throw new Error("local-system HTTPS tunnel not registered");
        }
      }
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  return errors;
}

const deadline = Date.now() + Number(waitMs);
let errors;
do {
  errors = await inspect();
  if (!errors.length || Date.now() >= deadline) break;
  await sleep(500);
} while (errors.length);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Server and tunnel${ngrokEnabled === "true" ? " and ngrok" : ""} ready; listeners belong to their LaunchAgents. Remote connector connectivity must be checked separately.`);
}
