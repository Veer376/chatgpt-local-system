import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("TOOL_UI_WRITE_TODOS disables only the write_todos UI flag", () => {
  const script = `
    const { isToolUiEnabled } = await import('./src/lib/config.js');
    console.log(JSON.stringify({
      todos: isToolUiEnabled('write_todos'),
      patch: isToolUiEnabled('apply_patch'),
      display: isToolUiEnabled('display'),
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      TOOL_UI: "false",
      TOOL_UI_WRITE_TODOS: "false",
      TOOL_UI_APPLY_PATCH: "true",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { todos: false, patch: true, display: true });
});

test("write_todos UI defaults on and remains independently configurable", () => {
  const script = `
    delete process.env.TOOL_UI_WRITE_TODOS;
    const { isToolUiEnabled } = await import('./src/lib/config.js');
    console.log(JSON.stringify({ todos: isToolUiEnabled('write_todos') }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, TOOL_UI: "false", TOOL_UI_WRITE_TODOS: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { todos: true });
});

test("display UI defaults on because presentation is the tool's purpose", () => {
  const script = `
    delete process.env.TOOL_UI_DISPLAY;
    const { isToolUiEnabled } = await import('./src/lib/config.js');
    console.log(JSON.stringify({ display: isToolUiEnabled('display') }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, TOOL_UI: "false", TOOL_UI_DISPLAY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { display: true });
});
