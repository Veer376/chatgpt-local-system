import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "sol-inline-images-"));
process.env.BRIDGE_STATE_DIR = state;
process.env.BRIDGE_SCRATCH_DIR = path.join(state, "scratch");
const { currentScratchDir } = await import("../../src/lib/config.js");
const { withInlineImages, extractInlineImages } = await import("../../src/lib/inline-images.js");

test.after(() => fs.rmSync(state, { recursive: true, force: true }));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function scratchFile(name, contents) {
  const file = path.join(currentScratchDir(), name);
  fs.writeFileSync(file, contents);
  return file;
}

const emptyResult = () => ({ content: [{ type: "text", text: "ok" }], structuredContent: {} });

test("a command that announces an image returns it in the same result", () => {
  const file = scratchFile("shot.png", PNG);
  const result = withInlineImages(emptyResult(), { stdout: `done\n@@image ${file}\n`, stderr: "" });
  const image = result.content.find((block) => block.type === "image");
  assert.equal(image?.mimeType, "image/png");
  assert.equal(image.data, PNG.toString("base64"));
  assert.deepEqual(result.structuredContent.images, [file]);
  // The marker is machinery, not output the model should read back.
  assert.doesNotMatch(result.structuredContent.stdout, /@@image/);
  assert.match(result.structuredContent.stdout, /done/);
});

test("a marker on stderr works, so a program with structured stdout can use it", () => {
  const file = scratchFile("stderr-shot.png", PNG);
  const result = withInlineImages(emptyResult(), { stdout: '{"ok":true}', stderr: `@@image ${file}\n` });
  assert.equal(result.content.filter((block) => block.type === "image").length, 1);
  assert.equal(result.structuredContent.stdout, '{"ok":true}');
});

test("an unreadable, oversized, or non-image target is reported rather than dropped", () => {
  const notAnImage = scratchFile("notes.txt", "plain text");
  const result = withInlineImages(emptyResult(), { stdout: `@@image ${notAnImage}\n@@image /etc/hosts\n`, stderr: "" });
  assert.equal(result.content.filter((block) => block.type === "image").length, 0);
  assert.equal(result.structuredContent.imagesSkipped.length, 2);
  assert.match(result.structuredContent.imagesSkipped[0].reason, /not a PNG/);
});

test("attachment is capped so a loop cannot flood the result", () => {
  const file = scratchFile("cap.png", PNG);
  const markers = Array.from({ length: 6 }, () => `@@image ${file}`).join("\n");
  const result = withInlineImages(emptyResult(), { stdout: markers, stderr: "" });
  assert.equal(result.content.filter((block) => block.type === "image").length, 3);
  assert.equal(result.structuredContent.imagesSkipped.length, 3);
});

test("output without a marker is returned untouched", () => {
  const before = emptyResult();
  const after = withInlineImages(before, { stdout: "no images here", stderr: "" });
  assert.equal(after.content.length, 1);
  assert.equal(extractInlineImages("no images here").images.length, 0);
});
