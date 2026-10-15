import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("Safari iOS refresh supports install without foregrounding the containing app", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "safari-ios-refresh.mjs"), "utf8");
  assert.match(source, /const options = new Set\(process\.argv\.slice\(2\)\)/);
  assert.match(source, /if \(!options\.has\("--no-launch"\)\)/);
});

test("Safari iOS refresh rebuilds the generated wrapper when new extension resources appear", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "safari-ios-refresh.mjs"), "utf8");
  assert.match(source, /missingProjectResources\(projectPath, stagedExtension\)/);
  assert.match(source, /"--rebuild-project", projectPath/);
  assert.match(source, /fs\.readdirSync\(extensionPath, \{ withFileTypes: true \}\)/);
});

test("Safari iOS watcher serializes refreshes and keeps Safari open", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "safari-ios-watch.mjs"), "utf8");
  assert.match(source, /fs\.watch\(extensionDir, \{ recursive: true \}/);
  assert.match(source, /if \(refreshProcess\) return;/);
  assert.match(source, /refreshQueued = true/);
  assert.match(source, /\[refreshScript, "--no-launch"\]/);
});

test("Safari mobile build leaves short-lived file and image capability GETs free of Basic Auth", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "prepare-safari-ios.mjs"), "utf8");
  assert.match(source, /const isCapabilityTicket = method === "GET"/);
  assert.match(source, /headers\.set\("ngrok-skip-browser-warning", "1"\)/);
  assert.match(source, /else \{[\s\S]*headers\.set\("authorization"/);
  assert.match(source, /AbortSignal\\\.timeout/);
  assert.match(source, /10_000/);
});

test("Safari mobile router permits only token-shaped GET capability tickets without Basic Auth", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "safari-mobile-router.mjs"), "utf8");
  assert.match(source, /CAPABILITY_TICKET_PATH/);
  assert.match(source, /ngrok-skip-browser-warning/);
  assert.match(source, /if \(!isCapabilityTicketRequest\(req\) && !authorizationMatches/);
  assert.match(source, /String\(req\?\.method \|\| ""\)\.toUpperCase\(\) !== "GET"/);
});
