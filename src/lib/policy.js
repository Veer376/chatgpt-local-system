import crypto from "node:crypto";
import path from "node:path";
import { BYPASS_SECURITY, DESTRUCTIVE_AUDIT_FAIL_CLOSED } from "./config.js";
import { auditEvent } from "./audit.js";
import { currentConversationId } from "./conversation.js";
import { clip } from "./text.js";
import { userQuestionService } from "./user-question.js";

export const DESTRUCTIVE_PATTERNS = [
  { id: "rm", re: /(^|[;&|()]|\s)(?:(?:\/[A-Za-z0-9._+-]+)+\/)?rm(?:\s|$)/i },
  { id: "rmdir", re: /(^|[;&|()]|\s)(?:rmdir|unlink|shred|srm|trash)(?:\s|$)/i },
  { id: "find-delete", re: /\bfind\b[^\n]*\s-delete\b/i },
  { id: "truncate", re: /\btruncate\b|:\s*>\s*\S+|\bClear-Content\b/i },
  { id: "windows-delete", re: /(^|[&|()]|\s)(?:del|erase|rd)(?:\s+\/[a-z]+)*\s+/i },
  { id: "powershell-delete", re: /\b(?:Remove-Item|Clear-RecycleBin)\b/i },
  { id: "disk-destructive", re: /\b(?:mkfs(?:\.\w+)?|diskpart\s+clean|format\s+[a-z]:|dd\s+(?:if|of)=)/i },
  { id: "interpreter-delete", re: /\b(?:os\.(?:remove|unlink)|shutil\.rmtree|pathlib\.Path\([^)]*\)\.(?:unlink|rmdir)|fs\.(?:rm|unlink|rmdir)(?:Sync)?|File\.(?:delete|unlink))\b/i },
  { id: "git-clean", re: /\bgit\s+(?:-[^\s]+\s+)*clean\b/i },
  { id: "git-reset-hard", re: /\bgit\s+(?:-[^\s]+\s+)*reset\b[^\n]*--hard\b/i },
  { id: "git-checkout-files", re: /\bgit\s+(?:-[^\s]+\s+)*checkout\b[^\n]*\s--(?:\s|$)/i },
  { id: "git-switch-discard", re: /\bgit\s+(?:-[^\s]+\s+)*switch\b[^\n]*(?:--discard-changes|--force|-f)(?:\s|$)/i },
  { id: "git-restore", re: /\bgit\s+(?:-[^\s]+\s+)*restore\b/i },
  { id: "git-branch-delete", re: /\bgit\s+(?:-[^\s]+\s+)*branch\s+(?:-[dD]|--delete|--force-delete)\b/i },
  { id: "git-tag-delete", re: /\bgit\s+(?:-[^\s]+\s+)*tag\s+(?:-d|--delete)\b/i },
  { id: "git-ref-delete", re: /\bgit\s+(?:-[^\s]+\s+)*(?:update-ref\s+(?:-d|--delete)|remote\s+(?:remove|rm)|stash\s+(?:drop|clear)|worktree\s+(?:remove|prune)|reflog\s+(?:delete|expire)|notes\s+(?:remove|prune))\b/i },
  { id: "git-force-push", re: /\bgit\s+(?:-[^\s]+\s+)*push\b[^\n]*(?:--force(?:-with-lease)?|-f|--delete|\s:[^\s]+)(?:\s|$)/i },
  { id: "filesystem-api-delete", re: /\b(?:unlinkSync|rmSync|rmdirSync|deleteFile|deleteDirectory)\b/i },
  { id: "sql-delete", re: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i },
  { id: "container-prune", re: /\b(?:docker|podman)\s+(?:system|image|container|volume)\s+prune\b/i },
  { id: "kubernetes-delete", re: /\bkubectl\s+delete\b/i },
  { id: "empty-trash", re: /\b(?:EmptyTrash|empty.?trash)\b/i },
];

// Commands that are not destructive but act on the user's live desktop or widen
// what the agent may operate. Reading the screen is not here on purpose: gating
// every snapshot would put an approval prompt in front of ordinary inspection.
export const RISKY_PATTERNS = [
  { id: "ui-control", re: /\bmac\.mjs\s+(?:click|act|set|type|key|menu)\b/i },
  { id: "ui-authorize", re: /\bmac\.mjs\s+allow\b/i },
  { id: "screen-capture", re: /\bmac\.mjs\s+screenshot\b[^\n]*--full\b|\bscreencapture\b(?![^\n]*\s-R\b)/i },
  // Raw AppleScript reaches the same capability without going through the adapter.
  { id: "applescript-input", re: /\bosascript\b[\s\S]*?\b(?:keystroke|key code)\b/i },
  { id: "applescript-ui-action", re: /\bosascript\b[\s\S]*?\b(?:perform action|click at|set value of|set frontmost)\b/i },
];

const SAFE_INSPECTION_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "cat", "head", "tail", "ls", "pwd", "wc", "stat", "file", "tree"]);
const SAFE_GIT_INSPECTION_COMMANDS = new Set(["status", "diff", "grep", "log", "show", "ls-files", "rev-parse"]);

export function inspectDestructive(command) {
  const text = String(command || "").trim();
  if (isClearlyReadOnlyInspectionCommand(text)) return { destructive: false, matches: [], command: text };
  const scanText = text.replace(/["'`]/g, " ");
  const rules = [...DESTRUCTIVE_PATTERNS, ...RISKY_PATTERNS];
  const matches = text ? rules.filter(({ re }) => re.test(text) || re.test(scanText)).map(({ id }) => id) : [];
  return { destructive: matches.length > 0, matches, command: text };
}

function isClearlyReadOnlyInspectionCommand(command) {
  if (!command || hasShellControlOutsideSingleQuotes(command)) return false;
  const first = command.match(/^\s*([^\s]+)/)?.[1] || "";
  const executable = path.basename(first.replace(/^["']|["']$/g, "")).toLowerCase();
  if (SAFE_INSPECTION_COMMANDS.has(executable)) return true;
  if (executable !== "git") return false;
  const match = command.match(/^\s*git\s+(?:-[^\s]+\s+)*([^\s]+)/i);
  return SAFE_GIT_INSPECTION_COMMANDS.has((match?.[1] || "").toLowerCase());
}

function hasShellControlOutsideSingleQuotes(command) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1] || "";
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote === "'") { if (char === "'") quote = ""; continue; }
    if (quote === '"') {
      if (char === '"') { quote = ""; continue; }
      if (char === "`" || (char === "$" && next === "(")) return true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "`" || char === ";" || char === "\n" || char === "|" || char === "&" || char === ">" || char === "<") return true;
    if (char === "$" && next === "(") return true;
  }
  return false;
}

export function looksDestructive(command) {
  return inspectDestructive(command).destructive;
}

export function inspectGitDestructive(argv) {
  const args = argv.map((value) => String(value).toLowerCase());
  const commandIndex = args.findIndex((value) => !value.startsWith("-"));
  if (commandIndex < 0) return { destructive: false, matches: [] };
  const command = args[commandIndex];
  const rest = args.slice(commandIndex + 1);
  const has = (...flags) => rest.some((value) => flags.includes(value));
  const matches = [];
  if (command === "rm" || command === "clean") matches.push(`git-${command}`);
  if (command === "reset" && has("--hard")) matches.push("git-reset-hard");
  if (command === "restore") matches.push("git-restore");
  if (command === "checkout" && (has("--", "-f", "--force"))) matches.push("git-checkout-discard");
  if (command === "switch" && has("--discard-changes", "-f", "--force")) matches.push("git-switch-discard");
  if (command === "branch" && has("-d", "-D", "--delete", "--force-delete")) matches.push("git-branch-delete");
  if (command === "tag" && has("-d", "--delete")) matches.push("git-tag-delete");
  if (command === "push" && (has("-f", "--force", "--force-with-lease", "--delete") || rest.some((value) => /^:[^:]+/.test(value)))) matches.push("git-push-delete-or-force");
  if (command === "remote" && ["remove", "rm"].includes(rest[0])) matches.push("git-remote-delete");
  if (command === "stash" && ["drop", "clear"].includes(rest[0])) matches.push("git-stash-delete");
  if (command === "worktree" && ["remove", "prune"].includes(rest[0])) matches.push("git-worktree-delete");
  if (command === "update-ref" && has("-d", "--delete")) matches.push("git-ref-delete");
  if (command === "reflog" && ["delete", "expire"].includes(rest[0])) matches.push("git-reflog-delete");
  if (command === "notes" && ["remove", "prune"].includes(rest[0])) matches.push("git-notes-delete");
  return { destructive: matches.length > 0, matches };
}

export async function requestDestructiveApproval(action, {
  signal,
  _meta,
  sendNotification,
  questionService = userQuestionService(),
  bypassSecurity = BYPASS_SECURITY,
} = {}) {
  const item = normalizeAction(action);
  const fingerprintValue = fingerprint(item);
  const previewText = preview({ ...item, fingerprint: fingerprintValue });

  if (bypassSecurity) {
    auditEvent("destructive.approved", {
      fingerprint: fingerprintValue,
      kind: item.kind,
      cwd: item.cwd,
      path: item.path,
      preview: previewText,
      source: "bypass_security",
    });
    return {
      approved: true,
      outcome: "approved",
      item,
      fingerprint: fingerprintValue,
    };
  }

  const requested = auditEvent("destructive.approval_requested", {
    fingerprint: fingerprintValue,
    kind: item.kind,
    cwd: item.cwd,
    path: item.path,
    preview: previewText,
  });
  if (!requested && DESTRUCTIVE_AUDIT_FAIL_CLOSED) {
    return {
      approved: false,
      outcome: "audit_failed",
      reason: "destructive action blocked because audit persistence failed",
      item,
      fingerprint: fingerprintValue,
    };
  }

  const stopHeartbeat = startApprovalHeartbeat({
    progressToken: _meta?.progressToken,
    sendNotification,
  });
  let response;
  try {
    const prompt = approvalQuestions(item, fingerprintValue);
    response = await questionService.ask({
      conversationId: currentConversationId(),
      interactionKind: "approval",
      title: "Approval",
      question: prompt.telegram,
      questionHtml: prompt.telegramHtml,
      macQuestion: prompt.macos,
      sections: prompt.sections,
      prompt: prompt.prompt,
      options: ["Approve", "Deny"],
      allowCustom: true,
      signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    auditEvent("destructive.approval_unavailable", { fingerprint: fingerprintValue, kind: item.kind, reason });
    return { approved: false, outcome: "unavailable", reason, item, fingerprint: fingerprintValue };
  } finally {
    stopHeartbeat();
  }

  const approved = response?.status === "answered"
    && response?.custom === false
    && response?.optionIndex === 0
    && response?.answer === "Approve";
  const redirected = response?.status === "answered"
    && response?.custom === true
    && typeof response?.answer === "string"
    && response.answer.trim().length > 0;
  const outcome = approved
    ? "approved"
    : redirected
      ? "redirected"
      : response?.status === "timeout"
        ? "timeout"
        : "denied";
  const audited = auditEvent(`destructive.${outcome}`, {
    fingerprint: fingerprintValue,
    kind: item.kind,
    cwd: item.cwd,
    path: item.path,
    source: response?.source,
  });
  if (approved && !audited && DESTRUCTIVE_AUDIT_FAIL_CLOSED) {
    return {
      approved: false,
      outcome: "audit_failed",
      reason: "destructive action blocked because approval audit persistence failed",
      item,
      fingerprint: fingerprintValue,
    };
  }
  return {
    approved,
    outcome,
    ...(redirected ? { humanInstruction: response.answer.trim() } : {}),
    response,
    item,
    fingerprint: fingerprintValue,
  };
}

export function destructiveApprovalFailure(result) {
  if (result?.outcome === "timeout") {
    return "Human approval timed out; no destructive action was executed. If this operation is still necessary, invoke the original tool call again to request fresh approval. Otherwise continue without it.";
  }
  if (result?.outcome === "redirected") {
    return `Human instruction: ${result.humanInstruction}. No destructive action was executed. Follow the human instruction instead of retrying this operation unless the human instruction itself requires a fresh tool call.`;
  }
  if (result?.outcome === "unavailable") return `Destructive action was not executed because human approval is unavailable: ${result.reason}`;
  if (result?.outcome === "audit_failed") return result.reason || "Destructive action was blocked because approval could not be audited.";
  return "Destructive action was not executed because the human denied it.";
}

export function recordDestructiveExecution(approval, { ok = true, code = null, error = null } = {}) {
  if (!approval?.approved) return false;
  return auditEvent(error ? "destructive.execution_failed" : "destructive.executed", {
    fingerprint: approval.fingerprint,
    kind: approval.item?.kind,
    cwd: approval.item?.cwd,
    path: approval.item?.path,
    ok: error ? false : ok,
    code,
    ...(error ? { error: clip(error, 2_000) } : {}),
  });
}

function normalizeAction(action) {
  const out = { ...action };
  for (const key of ["command", "action", "summary", "cwd", "path"]) {
    if (out[key] != null) out[key] = String(out[key]);
  }
  if (out.diff != null) out.diff = String(out.diff);
  return out;
}

function preview(item) {
  const display = {
    kind: item.kind,
    summary: item.summary,
    cwd: item.cwd,
    path: item.path,
    command: item.command ? clip(item.command, 4_000) : undefined,
    action: item.action ? clip(item.action, 4_000) : undefined,
    waitMs: item.waitMs,
    tool: item.tool,
    request: item.request ? {
      method: item.request.method || "GET",
      url: item.request.url,
      bodySha256: item.request.body == null ? undefined : crypto.createHash("sha256").update(String(item.request.body)).digest("hex"),
      headerNames: Object.keys(item.request.headers || {}).sort(),
    } : undefined,
    diffSha256: item.diff == null ? undefined : crypto.createHash("sha256").update(item.diff).digest("hex"),
    diffPreview: item.diff == null ? item.diffPreview : clip(item.diff, 4_000),
    fingerprint: item.fingerprint,
  };
  return clip(JSON.stringify(display, null, 2), 8_000);
}

function approvalQuestions(item, fingerprintValue) {
  // Sections carry the full text. Only the Telegram rendering is clipped: a message has a hard
  // transport limit, while the macOS panel scrolls and must show the operation in full.
  const sections = [];
  if (item.command) sections.push({ label: "Command", text: item.command, mono: true, code: true });
  else if (item.action) sections.push({ label: "Action", text: item.action, mono: true, code: true });
  else if (item.summary) sections.push({ label: "Summary", text: item.summary });
  if (item.path) sections.push({ label: "Path", text: item.path, mono: true });
  if (item.cwd) sections.push({ label: "Working directory", text: item.cwd, mono: true });
  if (item.request?.url) sections.push({ label: "Request", text: `${item.request.method || "GET"} ${item.request.url}`, mono: true });
  if (item.matches?.length) sections.push({ label: "Detected risk", text: item.matches.join(", ") });
  if (item.diff || item.diffPreview) sections.push({ label: "Diff", text: String(item.diff || item.diffPreview), mono: true });
  sections.push({ label: "Fingerprint", text: fingerprintValue.slice(0, 16), mono: true });
  if (sections.length === 1) sections.unshift({ label: "Action", text: `${item.kind || "destructive"} action` });

  const prompt = "Approve this operation?";
  const heading = "Destructive action approval";
  const render = (list) => [heading, "", ...list.map((s) => `${s.label}: ${s.text}`), "", prompt].join("\n");
  const clipped = sections.map((s) => ({ ...s, text: clip(s.text, 2_400) }));
  // `language-bash` makes Telegram syntax-highlight the command, which is the only way to get
  // real colour on the part that matters most.
  const html = clip([
    `🛑 <b>${escapeHtml(heading)}</b>`,
    "",
    ...clipped.map(({ label, text, mono, code }) => {
      const title = `<b>${escapeHtml(label)}</b>`;
      if (code) return `${title}\n<pre><code class="language-bash">${escapeHtml(text)}</code></pre>`;
      return mono ? `${title}\n<pre>${escapeHtml(text)}</pre>` : `${title}\n${escapeHtml(text)}`;
    }),
    "",
    `<b>${escapeHtml(prompt)}</b>`,
  ].join("\n"), 3_600);

  return {
    telegram: clip(render(clipped), 3_600),
    telegramHtml: html,
    macos: render(sections),
    sections,
    prompt,
    heading,
  };
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function startApprovalHeartbeat({ progressToken, sendNotification }) {
  if (progressToken == null || typeof sendNotification !== "function") return () => {};
  let progress = 0;
  const send = () => {
    progress += 1;
    void Promise.resolve(sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        message: "Waiting for explicit human approval in ChatGPT, macOS, or Telegram.",
      },
    })).catch(() => {});
  };
  send();
  const timer = setInterval(send, 20_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function fingerprint(value) {
  const stable = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  return crypto.createHash("sha256").update(stable).digest("hex");
}
