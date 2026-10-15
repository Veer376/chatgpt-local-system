import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.homedir(), ".sol-path-test-"));
const root = path.join(base, "root");
const outside = path.join(base, "outside");
fs.mkdirSync(root);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.BRIDGE_SCRATCH_DIR = path.join(base, "scratch");
process.env.WORKSPACE_ROOTS = root;
process.env.DEFAULT_WORKSPACE = "";
const paths = await import("../../src/lib/paths.js");
const config = await import("../../src/lib/config.js");
const { runWithConversationId } = await import("../../src/lib/conversation.js");

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("grants only explicit roots by default", () => {
  assert.deepEqual(config.configuredProjectRoots(), [fs.realpathSync(root)]);
  assert.deepEqual(config.toolWorkspaceRoots(), [fs.realpathSync(root), fs.realpathSync(config.SCRATCH_ROOT)]);
});

test("uses path-relative containment instead of vulnerable string prefixes", () => {
  assert.equal(paths.isWithin(path.join(root, "file"), root), true);
  assert.equal(paths.isWithin(path.join(root, "..agents"), root), true);
  assert.equal(paths.isWithin(path.join(root, "..config", "file"), root), true);
  assert.equal(paths.isWithin(`${root}-collision/file`, root), false);
  assert.equal(paths.isWithin(path.dirname(root), root), false);
});

test("migrates legacy workspace metadata to saved project shortcuts", () => {
  fs.mkdirSync(path.dirname(config.STATE_FILE), { recursive: true });
  fs.writeFileSync(config.STATE_FILE, JSON.stringify({
    version: 1,
    currentWorkspace: root,
    extraRoots: [],
    workspaces: [{ name: "Legacy Project", path: root, description: "Legacy metadata" }],
  }));

  const migrated = config.loadState();
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.savedProjects, [{ name: "Legacy Project", path: root, description: "Legacy metadata" }]);
  assert.equal(Object.hasOwn(migrated, "workspaces"), false);

  config.saveState(migrated);
  const persisted = JSON.parse(fs.readFileSync(config.STATE_FILE, "utf8"));
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.savedProjects, migrated.savedProjects);
  assert.equal(Object.hasOwn(persisted, "workspaces"), false);
});

test("keeps project selection separate from Local System scratch", () => {
  const scratch = config.currentScratchDir();
  const previousScratch = path.join(config.SCRATCH_ROOT, "2000-01-01");
  fs.mkdirSync(previousScratch, { recursive: true });
  assert.equal(paths.assertInProjectRoots(root), fs.realpathSync(root));
  assert.throws(() => paths.assertInProjectRoots(config.SCRATCH_ROOT), /scratch cannot be selected or saved as a project/);
  assert.throws(() => paths.assertInProjectRoots(scratch), /scratch cannot be selected or saved as a project/);
  assert.equal(paths.assertInWorkspace(scratch), scratch);
  assert.equal(paths.assertInWorkspace(previousScratch), fs.realpathSync(previousScratch));
  assert.throws(() => paths.assertInProjectRoots(outside), /outside authorized project roots/);

  config.saveState({ ...config.loadState(), currentWorkspace: scratch });
  assert.equal(paths.currentProjectWorkspace(), "");
  config.saveState({ ...config.loadState(), currentWorkspace: root });
  assert.equal(paths.currentProjectWorkspace(), fs.realpathSync(root));
});

test("shares one short scratch directory per local day", () => {
  const scratchA = runWithConversationId("v1/thread-A", () => config.currentScratchDir());
  const scratchB = runWithConversationId("v1/thread-B", () => config.currentScratchDir());

  assert.equal(scratchA, scratchB);
  assert.match(path.basename(scratchA), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(fs.statSync(scratchA).isDirectory(), true);
  assert.equal(runWithConversationId("v1/thread-A", () => paths.assertInWorkspace(scratchA)), scratchA);
  assert.equal(runWithConversationId("v1/thread-A", () => paths.assertInWorkspace(scratchB)), scratchB);
});

test("resolves symlinks before enforcing workspace authority", { skip: process.platform === "win32" && !canSymlink() }, () => {
  const link = path.join(root, "escape");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => paths.assertInWorkspace(path.join(link, "secret.txt")), /outside Local System workspace roots/);
  assert.throws(() => paths.assertInWorkspace(path.join(link, "new.txt"), { write: true }), /outside Local System workspace roots/);
  const dangling = path.join(root, "dangling");
  fs.symlinkSync(path.join(outside, "not-created.txt"), dangling, "file");
  assert.throws(() => paths.assertInWorkspace(dangling, { write: true }), /dangling symlink/);
});

function canSymlink() {
  try {
    const from = path.join(base, "symlink-probe-target");
    const to = path.join(base, "symlink-probe");
    fs.mkdirSync(from);
    fs.symlinkSync(from, to, "junction");
    fs.rmSync(to, { recursive: true, force: true });
    return true;
  } catch { return false; }
}
