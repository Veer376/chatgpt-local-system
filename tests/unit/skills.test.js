import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_ROOTS } from "../../src/lib/config.js";
import { discoverSkills } from "../../src/tools/skills.js";

function createSkill(root, name, description) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
}

test("default personal skill roots include the direct Local System skills directory", () => {
  assert.equal(SKILL_ROOTS.includes(path.join(os.homedir(), ".local-system", "skills")), true);
});

test("discover_skills normalizes separators, ranks matches, and paginates with opaque cursors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-skills-test-"));
  try {
    createSkill(root, "youtube-seo", "Optimize YouTube titles, descriptions, and discoverability.");
    createSkill(root, "youtube-analytics", "Analyze YouTube channel and video performance.");
    createSkill(root, "mcp-builder", "Build and review MCP servers.");
    createSkill(path.join(root, ".system"), "skill-creator", "Create and update skills.");
    createSkill(root, ".retired-skill", "A disabled personal skill.");
    for (let index = 0; index < 12; index += 1) createSkill(root, `generic-${index}`, `Generic skill ${index}`);

    const exact = discoverSkills({ roots: [root], query: "/youtube_seo" });
    assert.equal(exact.skills[0].name, "youtube-seo");
    assert.equal(exact.nextCursor, undefined);

    const related = discoverSkills({ roots: [root], query: "youtube" });
    assert.deepEqual(related.skills.map((skill) => skill.name), ["youtube-analytics", "youtube-seo"]);

    const page = discoverSkills({ roots: [root] });
    assert.equal(page.total, 15);
    assert.equal(page.skills.some((skill) => skill.name === "skill-creator"), false);
    assert.equal(page.skills.some((skill) => skill.name === ".retired-skill"), false);
    assert.equal(page.skills.every((skill) => skill.scope === "personal"), true);
    assert.equal(page.skills.length, 10);
    assert.ok(page.nextCursor);

    assert.match(page.nextCursor || "", /^[A-Za-z0-9_-]+$/);

    const next = discoverSkills({ roots: [root], cursor: page.nextCursor });
    assert.equal(next.skills.length, 5);
    assert.equal(next.nextCursor, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discover_skills includes current-project skills and labels duplicate names by scope", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-project-skills-test-"));
  const personalRoot = path.join(base, "personal");
  const project = path.join(base, "project");
  const projectRoot = path.join(project, ".agents", "skills");
  try {
    createSkill(personalRoot, "shared-skill", "Personal instructions.");
    createSkill(projectRoot, "shared-skill", "Project instructions.");
    createSkill(projectRoot, "project-only", "Project-only instructions.");
    createSkill(path.join(projectRoot, ".system"), "hidden-system-skill", "Must stay hidden.");
    createSkill(path.join(project, "skills"), "wrong-location", "Must not be discovered.");

    const shared = discoverSkills({ roots: [personalRoot], projectWorkspace: project, query: "shared skill" });
    assert.deepEqual(shared.skills.map((skill) => skill.scope), ["project", "personal"]);
    assert.equal(shared.skills[0].description, "Project instructions.");

    const first = discoverSkills({ roots: [personalRoot], projectWorkspace: project });
    const allSkills = [...first.skills];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = discoverSkills({ roots: [personalRoot], projectWorkspace: project, cursor });
      allSkills.push(...page.skills);
      cursor = page.nextCursor;
    }
    const all = { skills: allSkills };
    assert.equal(all.skills.some((skill) => skill.name === "project-only" && skill.scope === "project"), true);
    assert.equal(all.skills.some((skill) => skill.name === "hidden-system-skill"), false);
    assert.equal(all.skills.some((skill) => skill.name === "wrong-location"), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("discover_skills merges multiple personal skill roots", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-personal-skills-test-"));
  const firstRoot = path.join(base, "first");
  const secondRoot = path.join(base, "second");
  try {
    createSkill(firstRoot, "first-personal-skill", "First personal source.");
    createSkill(secondRoot, "local-system-skill", "Local System personal source.");

    const result = discoverSkills({ roots: [firstRoot, secondRoot] });

    assert.deepEqual(result.roots, [firstRoot, secondRoot].map((root) => fs.realpathSync.native(root)));
    assert.deepEqual(result.skills.map((skill) => skill.name), ["first-personal-skill", "local-system-skill"]);
    assert.equal(result.skills.every((skill) => skill.scope === "personal"), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});


test("discover_skills cursor is bound to the original query and fails closed when invalid", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-skills-cursor-test-"));
  try {
    for (let index = 0; index < 12; index += 1) createSkill(root, `alpha-${index}`, `Alpha skill ${index}`);
    const first = discoverSkills({ roots: [root], query: "alpha" });
    assert.ok(first.nextCursor);
    assert.throws(() => discoverSkills({ roots: [root], query: "beta", cursor: first.nextCursor }), /invalid discover_skills cursor/i);
    assert.throws(() => discoverSkills({ roots: [root], cursor: "not-a-valid-cursor" }), /invalid discover_skills cursor/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discover_skills cuts the incidental-match tail instead of returning most of the library", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-skills-relevance-test-"));
  try {
    createSkill(root, "local-system", "Use Local System when work depends on files, commands, or state on this machine.");
    createSkill(root, "local-scheduler", "Schedule recurring jobs.");
    createSkill(root, "computer-use", "Control local macOS apps: launch, click, and type.");
    createSkill(root, "codex-agent", "Delegate work to the local Codex CLI.");
    createSkill(root, "youtube", "Manage a channel from a local checkout.");
    createSkill(root, "semantic-guardian", "Guard the semantics of any instructional system.");

    // Every one of these mentions "local" or "system", so an unfiltered search
    // returns the whole shelf. Only the skill the query actually names should.
    const exact = discoverSkills({ roots: [root], query: "local-system" });
    assert.deepEqual(exact.skills.map((skill) => skill.name), ["local-system"]);
    assert.equal(exact.total, 1);

    // A single-word query has no strong name match to rank against, so
    // description matches stay: narrowing must not become a dead end.
    const broad = discoverSkills({ roots: [root], query: "local" });
    assert.deepEqual(broad.skills.map((skill) => skill.name).sort(), ["local-scheduler", "local-system"]);

    // A word that matches nothing should narrow the result, not empty it.
    const noisy = discoverSkills({ roots: [root], query: "the local system skill" });
    assert.equal(noisy.skills[0].name, "local-system");
    assert.ok(noisy.total >= 1);

    // A description carrying the query verbatim outranks the cut.
    const phrase = discoverSkills({ roots: [root], query: "macos apps" });
    assert.deepEqual(phrase.skills.map((skill) => skill.name), ["computer-use"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discover_skills does not let a one-letter word match every skill", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-skills-prefix-test-"));
  try {
    createSkill(root, "alpha", "A skill.");
    createSkill(root, "beta", "S is a lonely token.");
    createSkill(root, "system-tools", "System tooling.");

    // "s" is a prefix of "system", but a bare letter is not evidence that
    // system-tools is what the caller meant.
    assert.deepEqual(discoverSkills({ roots: [root], query: "s" }).skills.map((skill) => skill.name), ["beta"]);
    assert.deepEqual(discoverSkills({ roots: [root], query: "system" }).skills.map((skill) => skill.name), ["system-tools"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discover_skills reads YAML block scalars and returns one path per skill", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-skills-frontmatter-test-"));
  try {
    fs.mkdirSync(path.join(root, "folded"), { recursive: true });
    fs.writeFileSync(path.join(root, "folded", "SKILL.md"), [
      "---",
      "name: folded",
      "description: >",
      "  Robust local Python task scheduler for macOS.",
      "  Schedules scripts using native launchd with catch-up on wake.",
      "---",
      "# folded",
    ].join("\n"));

    fs.mkdirSync(path.join(root, "literal"), { recursive: true });
    fs.writeFileSync(path.join(root, "literal", "SKILL.md"), [
      "---",
      "name: literal",
      "description: |",
      "  First line.",
      "  Second line.",
      "---",
      "# literal",
    ].join("\n"));

    // A block scalar used to reach the agent as the literal string ">", which
    // left the skill describing nothing and unreachable by content search.
    const folded = discoverSkills({ roots: [root], query: "launchd" });
    assert.deepEqual(folded.skills.map((skill) => skill.name), ["folded"]);
    assert.equal(folded.skills[0].description, "Robust local Python task scheduler for macOS. Schedules scripts using native launchd with catch-up on wake.");

    const literal = discoverSkills({ roots: [root], query: "literal" });
    assert.equal(literal.skills[0].description, "First line.\nSecond line.");

    // The directory locates SKILL.md, its scripts, and its references. Sending
    // the same path back three ways was a quarter of the payload.
    assert.deepEqual(Object.keys(literal.skills[0]).sort(), ["description", "name", "path", "scope"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
