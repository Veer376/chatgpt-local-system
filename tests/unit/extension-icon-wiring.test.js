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

test("Local System extension ships matching ls brand icons at Chrome manifest sizes", () => {
  assert.deepEqual(manifest.icons, {
    "16": "icons/website-logo-16.png",
    "32": "icons/website-logo-32.png",
    "48": "icons/website-logo-48.png",
    "128": "icons/website-logo-128.png",
  });
  assert.deepEqual(manifest.action?.default_icon, {
    "16": "icons/website-logo-16.png",
    "32": "icons/website-logo-32.png",
  });

  for (const [size, path] of Object.entries(manifest.icons)) {
    assert.deepEqual(pngSize(path), { width: Number(size), height: Number(size) });
  }
});

test("cache-busting extension PNGs are exact website-logo renders", () => {
  for (const size of [16, 32, 48, 128]) {
    const active = readFileSync(new URL(`icons/website-logo-${size}.png`, extensionRoot));
    const compatibility = readFileSync(new URL(`icons/local-system-${size}.png`, extensionRoot));
    assert.deepEqual(active, compatibility, `${size}px active icon must match canonical compatibility render`);
  }
});

test("extension, website and canonical SVG use the identical original paths", () => {
  const svg = readFileSync(new URL("icons/local-system.svg", extensionRoot), "utf8");
  const canonical = readFileSync(new URL("../../assets/brand/mark.svg", import.meta.url), "utf8");
  const favicon = readFileSync(new URL("../../website/favicon.svg", import.meta.url), "utf8");
  assert.equal(svg, canonical);
  assert.equal(favicon, canonical);
  assert.match(svg, /Bespoke 'l'/);
  assert.match(svg, /Bespoke 's'/);
  assert.match(svg, /#D4FF52/);
  assert.doesNotMatch(svg, /<text\b/); // icon remains font independent
  assert.doesNotMatch(svg, /<(?:image|script|foreignObject)\b/); // no embedded remote artwork or scripts
});

test("social preview is the same raster on the website and in the brand kit", () => {
  const source = readFileSync(new URL("../../assets/brand/social-preview.png", import.meta.url));
  const target = readFileSync(new URL("../../website/social-preview.png", import.meta.url));
  assert.deepEqual(source, target);
  assert.equal(source.readUInt32BE(16), 1200);
  assert.equal(source.readUInt32BE(20), 630);
});
