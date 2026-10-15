import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "sol-policy-test-"));
process.env.BRIDGE_STATE_DIR = state;
process.env.BYPASS_SECURITY = "false";
const policy = await import("../../src/lib/policy.js");

test.after(() => fs.rmSync(state, { recursive: true, force: true }));

test("detects destructive POSIX, Windows, git, SQL, and infrastructure commands", () => {
  for (const command of [
    "rm -rf build", "/bin/rm -rf build", "sh -c \"rm -rf build\"", "python -c \"import os; os.remove('x')\"", "dd if=/dev/zero of=x",
    "del /q file.txt", "Remove-Item foo -Recurse", "git reset --hard HEAD",
    "git clean -fd", "git restore file", "git tag -d old", "git stash clear", "git remote remove origin",
    "DROP TABLE users", "kubectl delete pod x",
  ]) assert.equal(policy.looksDestructive(command), true, command);
  for (const command of ["npm test", "git status", "write a summary", "echo hello"]) {
    assert.equal(policy.looksDestructive(command), false, command);
  }
});

test("risky desktop control needs approval while reading the screen does not", () => {
  for (const command of [
    "node scripts/mac.mjs click Safari w.0.1 --expect-label OK",
    "node scripts/mac.mjs type TextEdit hello",
    "node scripts/mac.mjs key Safari return",
    "node scripts/mac.mjs set Notes w.0.2 hi",
    "node scripts/mac.mjs menu Safari File New",
    "node scripts/mac.mjs allow \"Google Chrome\"",
    "node scripts/mac.mjs screenshot --full",
    "screencapture /tmp/x.png",
    "osascript -e 'tell application \"System Events\" to keystroke \"x\"'",
  ]) assert.equal(policy.looksDestructive(command), true, command);
  // Inspection must stay prompt-free, or every snapshot blocks on a human.
  for (const command of [
    "node scripts/mac.mjs snapshot Safari",
    "node scripts/mac.mjs menus Safari --menu File",
    "node scripts/mac.mjs apps",
    "node scripts/mac.mjs doctor",
    "node scripts/mac.mjs allowed",
    "node scripts/mac.mjs revoke Safari",
    "node scripts/mac.mjs launch Safari",
    "node scripts/mac.mjs focus Safari",
    "node scripts/mac.mjs screenshot --app Safari",
  ]) assert.equal(policy.looksDestructive(command), false, command);
});

test("read-only inspection commands may search for destructive words without false approvals", () => {
  for (const command of [
    "rg -n 'truncate|rm|DELETE FROM' src tests",
    "grep -R 'rm -rf' .",
    "git grep 'git reset --hard'",
  ]) assert.equal(policy.looksDestructive(command), false, command);

  for (const command of [
    "rg foo . && rm -rf build",
    'rg "$(rm -rf build)" .',
  ]) assert.equal(policy.looksDestructive(command), true, command);
});

test("structured Git classification catches ref deletion and discard forms", () => {
  for (const argv of [
    ["push", "origin", ":main"], ["push", "--delete", "origin", "main"],
    ["checkout", "HEAD", "--", "file"], ["switch", "--discard-changes", "main"],
  ]) assert.equal(policy.inspectGitDestructive(argv).destructive, true, argv.join(" "));
  assert.equal(policy.inspectGitDestructive(["status", "--short"]).destructive, false);
});

test("human approval preserves the exact operation and wait semantics", async () => {
  const command = `rm ${"x".repeat(12_000)}`;
  let asked;
  const result = await policy.requestDestructiveApproval({
    kind: "process_start",
    command,
    cwd: "/tmp",
    waitMs: 5_000,
    matches: ["rm"],
  }, {
    questionService: {
      async ask(input) {
        asked = input;
        return { status: "answered", answer: "Approve", source: "macos", custom: false, optionIndex: 0 };
      },
    },
  });
  assert.equal(result.approved, true);
  assert.equal(result.outcome, "approved");
  assert.equal(result.item.command, command);
  assert.equal(result.item.waitMs, 5_000);
  assert.deepEqual(asked.options, ["Approve", "Deny"]);
  assert.equal(asked.allowCustom, true);
  assert.equal(asked.title, "Approval");
  assert.match(asked.question, /Working directory: \/tmp/);
  assert.match(asked.question, /Detected risk: rm/);
  assert.equal(asked.macQuestion.includes(command), true, "macOS approval receives the complete destructive command");
  assert.equal(asked.macQuestion.length > asked.question.length, true, "transport-safe text may be clipped without clipping macOS");
});

test("approval waiting emits MCP progress when the caller supplied a progress token", async () => {
  const notifications = [];
  const result = await policy.requestDestructiveApproval({
    kind: "shell",
    command: "rm -f x",
    cwd: "/tmp",
  }, {
    _meta: { progressToken: "approval-progress" },
    async sendNotification(notification) {
      notifications.push(notification);
    },
    questionService: {
      async ask() {
        return { status: "answered", answer: "Approve", source: "telegram", custom: false, optionIndex: 0 };
      },
    },
  });
  assert.equal(result.approved, true);
  assert.equal(notifications.length >= 1, true);
  assert.equal(notifications[0].method, "notifications/progress");
  assert.equal(notifications[0].params.progressToken, "approval-progress");
  assert.match(notifications[0].params.message, /waiting for explicit human approval/i);
});

test("only the explicit Approve option authorizes destructive work", async () => {
  const action = { kind: "shell", command: "rm -f x", cwd: "/tmp" };
  const cases = [
    {
      response: { status: "answered", answer: "Deny", source: "telegram", custom: false, optionIndex: 1 },
      outcome: "denied",
    },
    {
      response: { status: "answered", answer: "Use a reversible archive instead", source: "telegram", custom: true, optionIndex: null },
      outcome: "redirected",
      instruction: "Use a reversible archive instead",
    },
    {
      response: { status: "answered", answer: "Approve", source: "telegram", custom: true, optionIndex: null },
      outcome: "redirected",
      instruction: "Approve",
    },
    {
      response: { status: "timeout", answer: null, source: "timeout", custom: false, timeoutMs: 300_000 },
      outcome: "timeout",
    },
  ];
  for (const { response, outcome, instruction } of cases) {
    const result = await policy.requestDestructiveApproval(action, {
      questionService: { async ask() { return response; } },
    });
    assert.equal(result.approved, false);
    assert.equal(result.outcome, outcome);
    if (instruction) {
      assert.equal(result.humanInstruction, instruction);
      assert.match(policy.destructiveApprovalFailure(result), new RegExp(instruction));
      assert.match(policy.destructiveApprovalFailure(result), /follow the human instruction instead/i);
    } else {
      assert.match(policy.destructiveApprovalFailure(result), /not executed|denied|timed out/i);
    }
    if (outcome === "timeout") {
      assert.match(policy.destructiveApprovalFailure(result), /invoke the original tool call again/i);
      assert.match(policy.destructiveApprovalFailure(result), /otherwise continue without it/i);
    }
  }
});

test("unavailable human interaction fails closed", async () => {
  const result = await policy.requestDestructiveApproval(
    { kind: "shell", command: "rm -f x", cwd: "/tmp" },
    { questionService: { async ask() { throw new Error("interaction offline"); } } },
  );
  assert.equal(result.approved, false);
  assert.equal(result.outcome, "unavailable");
  assert.match(policy.destructiveApprovalFailure(result), /interaction offline/);
});

test("approval content is structured per field and HTML-escaped for Telegram", async () => {
  let asked;
  await policy.requestDestructiveApproval({
    kind: "shell",
    command: 'rm -rf "$HOME/x" && echo <done>',
    cwd: "/tmp/demo",
    matches: ["rm-recursive-force"],
  }, {
    questionService: {
      async ask(input) {
        asked = input;
        return { status: "answered", answer: "Approve", source: "macos", custom: false, optionIndex: 0 };
      },
    },
  });

  assert.deepEqual(
    asked.sections.map((section) => section.label),
    ["Command", "Working directory", "Detected risk", "Fingerprint"],
  );
  assert.equal(asked.sections[0].mono, true);
  assert.equal(asked.sections[0].text, 'rm -rf "$HOME/x" && echo <done>');
  assert.equal(asked.prompt, "Approve this operation?");
  assert.match(asked.questionHtml, /&amp;&amp; echo &lt;done&gt;/, "shell metacharacters cannot break the markup");
  assert.match(asked.questionHtml, /<pre><code class="language-bash">/, "the command is highlighted, not just monospaced");
  assert.equal(asked.questionHtml.includes("<done>"), false);
});

test("BYPASS_SECURITY=true bypasses human approval without asking questionService", async () => {
  let asked = false;
  const result = await policy.requestDestructiveApproval({
    kind: "process_start",
    command: "rm -rf /tmp/test-bypass",
    cwd: "/tmp",
    matches: ["rm"],
  }, {
    bypassSecurity: true,
    questionService: {
      async ask() {
        asked = true;
        return { status: "answered", answer: "Approve", source: "macos", custom: false, optionIndex: 0 };
      },
    },
  });
  assert.equal(result.approved, true);
  assert.equal(result.outcome, "approved");
  assert.equal(asked, false, "questionService must not be called when bypassSecurity is true");
});
