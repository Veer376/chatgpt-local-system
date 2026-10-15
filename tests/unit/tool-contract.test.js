import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_TOOL_NAMES } from "../../src/tool-contract.js";

const AUTHORITATIVE_11 = [
  "apply_patch", "bridge_context", "discover_skills",
  "execute_command", "display", "view_image", "manage_task", "workspace", "request_user_input", "write_todos", "runtime_memory",
];

test("the exposed MCP contract is exactly the authoritative 11 tools", () => {
  assert.equal(EXPECTED_TOOL_NAMES.length, 11);
  assert.equal(new Set(EXPECTED_TOOL_NAMES).size, 11);
  assert.deepEqual([...EXPECTED_TOOL_NAMES].sort(), AUTHORITATIVE_11.sort());
});
