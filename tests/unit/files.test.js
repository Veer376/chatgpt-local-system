import test from "node:test";
import assert from "node:assert/strict";
import { normalizePathInput } from "../../src/tools/files.js";

test("paths inputs preserve order without sharing the input array", () => {
  const paths = ["/one.png", "/two.png"];
  const normalized = normalizePathInput({ paths }, "view_image");
  assert.deepEqual(normalized, { paths });
  assert.notEqual(normalized.paths, paths);
});

test("the singular path input is rejected", () => {
  assert.match(
    normalizePathInput({ path: "/one.png" }, "view_image").error,
    /accepts paths only; path is not supported/i,
  );
});

test("a non-empty paths array is required", () => {
  assert.match(normalizePathInput({}, "view_image").error, /requires a non-empty paths array/i);
  assert.match(normalizePathInput({ paths: [] }, "view_image").error, /requires a non-empty paths array/i);
});
