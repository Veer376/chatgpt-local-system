import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-orientation-"));
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.BRIDGE_SCRATCH_DIR = path.join(base, "scratch");
process.env.GLOBAL_AGENT_DOC_PATH = path.join(base, ".agents", "AGENTS.md");
process.env.MAX_PROJECT_DOC_BYTES = "200";
process.env.MEMORY_ROOT = path.join(base, "memory");
process.env.SKILL_ROOTS = path.join(base, "personal-skills");

const { readGlobalAgentDoc, readProjectDoc, readProjectMemory, projectOrientation } = await import("../../src/lib/orientation.js");

function makeProject(name, files = {}) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
  return dir;
}

function makeSkill(root, name, description = "x") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("a project without an instructions file reports none", () => {
  assert.equal(readProjectDoc(makeProject("no-doc")), null);
});

test("AGENTS.md is returned with its content", () => {
  const dir = makeProject("with-doc", { "AGENTS.md": "Always run npm test.\n" });
  const doc = readProjectDoc(dir);
  assert.equal(doc.name, "AGENTS.md");
  assert.equal(doc.content, "Always run npm test.\n");
  assert.equal(doc.truncated, false);
});

test("the instructions filename is matched case-insensitively", () => {
  const doc = readProjectDoc(makeProject("lower-doc", { "agents.md": "lowercase works" }));
  assert.equal(doc.name, "agents.md");
  assert.match(doc.content, /lowercase works/);
});

test("an oversized instructions file is truncated and flagged", () => {
  const dir = makeProject("big-doc", { "AGENTS.md": "A".repeat(5_000) });
  const doc = readProjectDoc(dir);
  assert.equal(doc.truncated, true);
  assert.ok(Buffer.byteLength(doc.content, "utf8") < 400, "clipped near the configured cap");
  assert.match(doc.content, /truncated/);
});

test("truncation never emits a broken multi-byte character", () => {
  // 'é' is 2 bytes, so a 200-byte cut lands mid-character.
  const dir = makeProject("utf8-doc", { "AGENTS.md": "é".repeat(5_000) });
  const doc = readProjectDoc(dir);
  assert.equal(doc.truncated, true);
  assert.doesNotMatch(doc.content, /�/, "no replacement characters leak through");
});

test("a missing or unreadable directory reports none rather than throwing", () => {
  assert.equal(readProjectDoc(path.join(base, "does-not-exist")), null);
  assert.equal(readProjectDoc(""), null);
  assert.equal(readProjectDoc(undefined), null);
});

test("global agent instructions are returned when configured", () => {
  fs.mkdirSync(path.dirname(process.env.GLOBAL_AGENT_DOC_PATH), { recursive: true });
  fs.writeFileSync(process.env.GLOBAL_AGENT_DOC_PATH, "Read memory when useful.\n");
  const doc = readGlobalAgentDoc();
  assert.equal(doc.name, "AGENTS.md");
  assert.equal(doc.path, process.env.GLOBAL_AGENT_DOC_PATH);
  assert.match(doc.content, /Read memory/);
  assert.equal(doc.truncated, false);
});

test("project memory is returned from the project root when present", () => {
  const dir = makeProject("with-memory", { "MEMORY.md": "Keep schemas minimal.\n" });
  const memory = readProjectMemory(dir);
  assert.equal(memory.name, "MEMORY.md");
  assert.match(memory.content, /schemas minimal/);
  assert.equal(projectOrientation(dir).projectMemory.content, memory.content);
});

test("skills are null before a project is selected and listed after", () => {
  const personal = path.join(base, "personal-skills");
  makeSkill(personal, "alpha-skill");
  makeSkill(personal, "beta-skill");

  const none = projectOrientation("");
  assert.equal(none.skills.personal.includes("alpha-skill"), true);
  assert.equal(none.skills.personal.includes("beta-skill"), true);
  assert.equal(none.skills.personal.includes("local-system"), true, "bridge-owned skills stay discoverable");
  assert.equal(none.skills.project, null, "null means not knowable yet, not empty");
  assert.equal(none.projectDoc, null);
  assert.equal(none.globalAgentDoc.name, "AGENTS.md");
  assert.equal(none.memory.root, process.env.MEMORY_ROOT);
  assert.equal(none.memory.accountsFile, path.join(process.env.MEMORY_ROOT, "accounts.md"));
  assert.equal(none.projectMemory, null);

  const bare = makeProject("bare-project", { "AGENTS.md": "hi" });
  const withBare = projectOrientation(bare);
  assert.deepEqual(withBare.skills.project, [], "empty array means the project genuinely has none");
  assert.equal(withBare.projectDoc.content, "hi");

  const rich = makeProject("rich-project");
  makeSkill(path.join(rich, ".agents", "skills"), "project-only-skill");
  const withRich = projectOrientation(rich);
  assert.deepEqual(withRich.skills.project, ["project-only-skill"]);
  assert.deepEqual(withRich.skills.personal, none.skills.personal, "global skills stay visible");
  assert.equal(withRich.projectDoc, null, "this project has no instructions file");
});

test("names are returned without descriptions to keep the payload small", () => {
  const rich = makeProject("desc-project");
  makeSkill(path.join(rich, ".agents", "skills"), "described", "a very long description ".repeat(40));
  const payload = JSON.stringify(projectOrientation(rich));
  assert.match(payload, /described/);
  assert.doesNotMatch(payload, /a very long description/, "descriptions are not inlined");
});
