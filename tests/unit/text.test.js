import test from "node:test";
import assert from "node:assert/strict";
import { MAX_STDERR_CHARS, MAX_STDOUT_CHARS } from "../../src/lib/config.js";
import { splitArgs, structured } from "../../src/lib/text.js";

test("splitArgs preserves Windows paths and quoted spaces", () => {
  assert.deepEqual(splitArgs('add C:\\repo\\file.txt "two words"'), ["add", "C:\\repo\\file.txt", "two words"]);
  assert.deepEqual(splitArgs("click 400,300"), ["click", "400,300"]);
});

test("splitArgs supports escaped whitespace without stripping ordinary backslashes", () => {
  assert.deepEqual(splitArgs("open hello\\ world C:\\work"), ["open", "hello world", "C:\\work"]);
});

test("structured results return standard MCP content text and omit structuredContent", () => {
  const data = { stdout: "large payload", nested: { value: 42 } };
  const result = structured("Done.", data);
  assert.match(result.content?.[0]?.text || "", /^Done\.\n\n```json/);
  assert.match(result.content?.[0]?.text || "", /large payload/);
  assert.equal(result.structuredContent, undefined);
});

test("structured results keep command-sized stdout and stderr JSON complete", () => {
  const data = {
    ok: false,
    stdout: "o".repeat(MAX_STDOUT_CHARS),
    stderr: "e".repeat(MAX_STDERR_CHARS),
  };
  const result = structured("Command failed.", data);
  const match = result.content?.[0]?.text?.match(/```json\n([\s\S]+?)\n```$/);
  assert.ok(match, "serialized structured payload should not be clipped mid-JSON");
  assert.deepEqual(JSON.parse(match[1]), data);
});
