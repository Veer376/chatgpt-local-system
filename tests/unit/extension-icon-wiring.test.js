import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionRoot = new URL("../../extensions/local-system/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", extensionRoot), "utf8"));

function pngSize(path) {
  const bytes = readFileSync(new URL(path, extensionRoot));
  assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a", `${path} is a PNG`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

test("Local System extension ships the ~ls icon at Chrome manifest sizes", () => {
  assert.deepEqual(manifest.icons, {
    "16": "icons/local-system-16.png",
    "32": "icons/local-system-32.png",
    "48": "icons/local-system-48.png",
    "128": "icons/local-system-128.png",
  });
  assert.deepEqual(manifest.action?.default_icon, {
    "16": "icons/local-system-16.png",
    "32": "icons/local-system-32.png",
  });

  for (const [size, path] of Object.entries(manifest.icons)) {
    assert.deepEqual(pngSize(path), { width: Number(size), height: Number(size) });
  }
});

test("canonical extension icon remains code-defined SVG", () => {
  const svg = readFileSync(new URL("icons/local-system.svg", extensionRoot), "utf8");
  assert.match(svg, /Local System ~ls icon/);
  assert.match(svg, /stroke="#10A37F"/);
  assert.match(svg, />ls<\/text>/);
});
