import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const manifestUrl = new URL("../../extensions/local-system/manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
const background = readFileSync(new URL("../../extensions/local-system/background.js", import.meta.url), "utf8");
const extensionApi = readFileSync(new URL("../../extensions/local-system/extension-api.js", import.meta.url), "utf8");
const annotations = readFileSync(new URL("../../extensions/local-system/annotations-content.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../../src/server.js", import.meta.url), "utf8");

test("provider pages no longer receive a web-accessible privileged API bridge", () => {
  const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources || []);
  assert.equal(resources.includes("api-bridge.html"), false);
  assert.equal(resources.includes("api-bridge.js"), false);
  assert.equal(resources.includes("extension-api.js"), false);
  assert.equal(existsSync(new URL("../../extensions/local-system/api-bridge.html", import.meta.url)), false);
  assert.equal(existsSync(new URL("../../extensions/local-system/api-bridge.js", import.meta.url)), false);
  assert.doesNotMatch(annotations, /ensureApiBridge|local-system-api-request|local-system-api-bridge/);
});

test("all privileged Local System JSON calls are owned by the extension background", () => {
  const content = manifest.content_scripts.find((entry) => entry.js?.includes("annotations-content.js"));
  assert.ok(content);
  assert.ok(content.js.indexOf("extension-api.js") >= 0);
  assert.ok(content.js.indexOf("extension-api.js") < content.js.indexOf("annotations-content.js"));
  assert.match(extensionApi, /chrome\.runtime\.sendMessage/);
  assert.match(background, /LOCAL_API_PATHS = new Set/);
  assert.match(background, /turn-checkpoint/);
  assert.match(background, /"\/local-ui\/files\/html-preview"/);
  assert.match(background, /proxyLocalApiRequest/);
  assert.match(background, /sender\?\.id !== chrome\.runtime\.id/);
  assert.match(background, /"x-local-system-session": session\.token/);
  assert.doesNotMatch(background, /"x-local-system-extension": "1"/);
});

test("localhost Local UI access uses random server sessions rather than the old static trust header", () => {
  assert.match(server, /crypto\.randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(server, /req\.get\("x-local-system-session"\)/);
  assert.match(server, /extensionSession\.verify\(token\)/);
  assert.doesNotMatch(server, /ALLOWED_CORS_HEADERS = "[^"]*X-Local-System-Extension/);
});
