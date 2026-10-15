import test from "node:test";
import assert from "node:assert/strict";
import { checkOwnership, delegateToLaunchAgents } from "../../scripts/macos-supervision.mjs";

test("loaded but crashing service cannot pass because an unrelated server is ready", () => {
  assert.throws(() => checkOwnership("state = spawn scheduled\nlast exit code = 1", [49885], new Map()), /not running/);
});

test("listener must belong to the running service, including nested wrappers", () => {
  const service = "state = running\npid = 100";
  const parents = new Map([[101, 100], [102, 101], [201, 200]]);
  assert.equal(checkOwnership(service, [102], parents), 100);
  assert.throws(() => checkOwnership(service, [201], parents), /outside LaunchAgent/);
  assert.throws(() => checkOwnership(service, [102, 201], parents), /outside LaunchAgent/);
  assert.throws(() => checkOwnership(service, [], parents), /no listening process/);
});

test("installed services receive restart instead of starting an unmanaged stack", () => {
  const calls = [];
  const result = delegateToLaunchAgents("/repo", "restart", {
    platform: "darwin", home: "/user", exists: () => true,
    run: (...args) => { calls.push(args); return { status: 0 }; },
  });
  assert.equal(result, 0);
  assert.deepEqual(calls[0].slice(0, 2), ["/bin/bash", ["/repo/scripts/service-macos.sh", "restart"]]);
});

test("failed supervised restart does not fall back to unmanaged execution", () => {
  assert.equal(delegateToLaunchAgents("/repo", "restart", {
    platform: "darwin", exists: () => true, run: () => ({ status: 1 }),
  }), 1);
  assert.throws(() => delegateToLaunchAgents("/repo", "restart", {
    platform: "darwin", exists: (file) => file.endsWith("server.plist"),
  }), /Incomplete/);
});

test("uninstalled and non-macOS stacks retain foreground execution", () => {
  assert.equal(delegateToLaunchAgents("/repo", "start", { platform: "darwin", exists: () => false }), null);
  assert.equal(delegateToLaunchAgents("/repo", "start", { platform: "linux", exists: () => true }), null);
});
