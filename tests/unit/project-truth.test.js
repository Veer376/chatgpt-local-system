import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXPECTED_TOOL_NAMES } from "../../src/tool-contract.js";

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
const readme = read("README.md");
const setup = read("docs/CHATGPT_SETUP.md");
const operations = read("docs/OPERATIONS.md");
const envExample = read(".env.example");
const packageJson = JSON.parse(read("package.json"));
const safariRouter = read("scripts/safari-mobile-router.mjs");
const toolCount = EXPECTED_TOOL_NAMES.length;

test("project docs describe the authoritative model-facing tool contract", () => {
  assert.equal(toolCount, 11);
  assert.match(readme, new RegExp(`Exact ${toolCount}-tool contract`));
  assert.match(readme, new RegExp(`exactly ${toolCount} model tools`));
  assert.ok(setup.includes(`exactly **${toolCount} model tools**`));
  assert.match(operations, new RegExp(`frozen ${toolCount}-tool contract`));

  for (const source of [readme, setup, operations]) {
    assert.doesNotMatch(source, /(?:exactly\s+)?10 model tools|10-tool contract|12-tool contract|exact 12-tool/i);
  }
});

test("project docs use current model-facing tool names", () => {
  assert.match(readme, /### request_user_input/);
  assert.doesNotMatch(readme, /### ask_user|call `ask_user`/);
  assert.match(readme, /`display`, `view_image`, `apply_patch`/);
  assert.doesNotMatch(readme, /`show_file`/);
  assert.match(envExample, /TOOL_UI_DISPLAY/);
  assert.doesNotMatch(envExample, /TOOL_UI_SHOW_FILE|show_file|Cross-device ask_user|macOS ask_user|used by ask_user/);
});

test("documented runtime entry points exist in package scripts", () => {
  assert.equal(packageJson.scripts["start:all"], "npm run build && node scripts/restart-all.mjs");
  assert.ok(packageJson.scripts["start:all"]);
});

test("Safari router advertises the current Local System session header", () => {
  assert.match(safariRouter, /x-local-system-session/);
  assert.doesNotMatch(safariRouter, /x-local-system-extension/);
});
