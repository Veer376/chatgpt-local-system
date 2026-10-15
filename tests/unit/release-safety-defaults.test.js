import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("destructive operation confirmation is the default without an explicit bypass", () => {
  const env = { ...process.env };
  delete env.BYPASS_SECURITY;
  const configUrl = pathToFileURL(path.join(root, "src/lib/config.js")).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module", "-e",
    `import { BYPASS_SECURITY } from ${JSON.stringify(configUrl)}; process.stdout.write(String(BYPASS_SECURITY));`,
  ], { cwd: tmpdir(), env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "false");
  const template = readFileSync(path.join(root, ".env.example"), "utf8");
  assert.match(template, /^BYPASS_SECURITY=false$/m);
});
