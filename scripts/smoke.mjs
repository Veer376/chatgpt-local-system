#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EXPECTED_TOOL_NAMES } from "../src/tool-contract.js";
import { httpUrl } from "../src/lib/net.js";

const config = loadRuntimeConfig();
const url = config.MCP_URL || httpUrl(config.HOST || "127.0.0.1", config.PORT || "8765", "/mcp");
const headers = config.MCP_TOKEN ? { Authorization: `Bearer ${config.MCP_TOKEN}` } : undefined;
let scratch = null;
const client = new Client({ name: "bridge-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: headers ? { headers } : undefined });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools
    .filter((tool) => !tool._meta?.ui?.visibility?.includes("app") || tool._meta?.ui?.visibility?.includes("model"))
    .map((tool) => tool.name)
    .sort();
  const expected = [...EXPECTED_TOOL_NAMES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`tool contract mismatch\nexpected=${expected.join(",")}\nactual=${names.join(",")}`);
  }

  const contextResult = await call("bridge_context", {});
  assertOk(contextResult, "bridge_context");
  const fullText = textOf(contextResult);
  const jsonMatch = fullText.match(/```json\s*([\s\S]*?)\s*```/);
  const context = contextResult.structuredContent || (jsonMatch ? JSON.parse(jsonMatch[1]) : null);
  if (!context?.localScratchDir || !Array.isArray(context.instructions) || !context.platform) {
    throw new Error(`bridge_context returned an invalid structured payload: ${fullText}`);
  }
  if (!fullText.startsWith("Bridge context returned.")) throw new Error(`bridge_context returned verbose text: ${fullText}`);

  const scratchBase = config.SMOKE_WORKSPACE
    ? expandHome(config.SMOKE_WORKSPACE)
    : context.localScratchDir;
  fs.mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
  scratch = fs.mkdtempSync(path.join(scratchBase, "run-"));

  assertOk(await call("execute_command", { command: "git init -q", cwd: scratch }), "execute_command git init");
  const createPatch = "*** Begin Patch\n*** Add File: roundtrip.txt\n+one\n*** End Patch";
  assertOk(await call("apply_patch", { cwd: scratch, input: createPatch }), "apply_patch create");

  const inspectCommand = process.platform === "win32" ? "type roundtrip.txt" : "cat roundtrip.txt";
  const inspected = await call("execute_command", { command: inspectCommand, cwd: scratch });
  assertOk(inspected, "execute_command inspect");
  if (!textOf(inspected).startsWith("Command succeeded.")) throw new Error(`execute_command returned verbose text: ${textOf(inspected)}`);
  if (!(inspected.structuredContent?.stdout || "").includes("one")) throw new Error("execute_command did not return stdout in structuredContent");

  const searchCommand = process.platform === "win32" ? 'findstr /n "one" roundtrip.txt' : "grep -n 'one' roundtrip.txt";
  const searched = await call("execute_command", { command: searchCommand, cwd: scratch });
  assertOk(searched, "execute_command search");
  if (!(searched.structuredContent?.stdout || "").includes("one")) throw new Error("execute_command search did not find created content");

  const editPatch = "*** Begin Patch\n*** Update File: roundtrip.txt\n@@\n-one\n+two\n*** End Patch";
  assertOk(await call("apply_patch", { cwd: scratch, input: editPatch }), "apply_patch edit");


  console.log(JSON.stringify({ url, toolCount: names.length, tools: names, patchInspectSearch: true, context }, null, 2));
} finally {
  await client.close().catch(() => {});
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result && !result.structuredContent) {
    const text = textOf(result);
    const match = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (match) {
      try {
        result.structuredContent = JSON.parse(match[1]);
      } catch {}
    }
  }
  return result;
}

function textOf(result) {
  return (result.content || []).map((item) => item.text || "").join("\n");
}

function loadRuntimeConfig() {
  const candidates = [process.env.BRIDGE_ENV_FILE, defaultRuntimeEnv(), path.resolve(".env")].filter(Boolean);
  let fileConfig = {};
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      fileConfig = dotenv.parse(fs.readFileSync(candidate));
      break;
    }
  }
  return { ...fileConfig, ...process.env };
}

function defaultRuntimeEnv() {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "chatgpt-local-system", "runtime.env")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "chatgpt-local-system", "runtime.env");
}

function expandHome(value) {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
}

function assertOk(result, name) {
  const text = textOf(result);
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}
