import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("extensions/local-system/manifest.json"));
const background = read("extensions/local-system/background.js");
const content = read("extensions/local-system/content.js");
const mainWorld = read("extensions/local-system/thread-tail-clamp.js");
const policy = read("src/tools/policy.js");

test("browser binding observes bridge_context in MAIN world without adding webRequest permission", () => {
  assert.equal(manifest.permissions.includes("webRequest"), false);
  const mainWorldScripts = manifest.content_scripts.find((entry) => entry.world === "MAIN");
  assert.ok(mainWorldScripts?.js.includes("thread-tail-clamp.js"));
  assert.match(mainWorld, /message\?\.method !== "tools\/call"/);
  assert.match(mainWorld, /message\?\.params\?\.name !== "bridge_context"/);
  assert.match(mainWorld, /"openai\/session"/);
  assert.match(mainWorld, /local-system-mcp-observer/);
  assert.match(content, /action: "bind-thread-observed"/);
  assert.match(background, /\/local-ui\/thread-bind-observed/);
});

test("bridge_context is a plain MCP tool with no UI template", () => {
  assert.match(policy, /server\.registerTool\("bridge_context"/);
  assert.doesNotMatch(policy, /registerAppTool|registerAppResource|resourceUri|binding-context/);
});

test("content script retains the legacy send-time binding fallback", () => {
  assert.match(content, /source === "local-system-binding-app"/);
  assert.match(content, /action: "bind-thread-token"/);
  assert.match(content, /LEGACY_BIND_FALLBACK_DELAY_MS = 5_000/);
  assert.match(content, /pendingLocalSystemBind = null/);
  assert.match(content, /source: "token"/);
});
