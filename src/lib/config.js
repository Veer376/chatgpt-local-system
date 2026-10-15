import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeHost } from "./net.js";
import { conversationKey, currentConversationId } from "./conversation.js";

const HOME = os.homedir();
const BRIDGE_SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const DEFAULT_STATE_DIR = path.join(HOME, ".chatgpt-local-system");
const STATE_VERSION = 2;
const CONVERSATION_KEY_RE = /^[a-f0-9]{64}$/;

export const APP_NAME = "chatgpt-local-system";
export const APP_VERSION = "1.0.0";
export const STATE_DIR = path.resolve(expandHome(process.env.BRIDGE_STATE_DIR || DEFAULT_STATE_DIR));
export const STATE_FILE = path.join(STATE_DIR, "state.json");
export const LOG_DIR = path.join(STATE_DIR, "logs");
export const PROC_DIR = path.join(STATE_DIR, "processes");
export const AUDIT_DIR = path.join(STATE_DIR, "audit");
export const AUDIT_FILE = path.join(AUDIT_DIR, "bridge.jsonl");
export const TELEGRAM_BINDING_FILE = path.join(STATE_DIR, "telegram-binding.json");
export const CONVERSATION_DIR = path.join(STATE_DIR, "conversations");
export const SUBAGENT_RUN_DIR = path.join(STATE_DIR, "subagent-runs");
export const SCRATCH_ROOT = path.resolve(expandHome(process.env.BRIDGE_SCRATCH_DIR || path.join(HOME, ".local-system", "scratch")));

export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = readInteger("PORT", 8765, { min: 1, max: 65_535 });
export const MCP_TOKEN = process.env.MCP_TOKEN || "";
export const BODY_LIMIT = process.env.BODY_LIMIT || "2mb";
export const COMMAND_TIMEOUT_MS = readInteger("COMMAND_TIMEOUT_MS", 120_000, { min: 1_000, max: 900_000 });
export const COMMAND_WAIT_MS = readInteger("COMMAND_WAIT_MS", 10_000, { min: 0, max: 300_000 });
export const MAX_STDOUT_CHARS = readInteger("MAX_STDOUT_CHARS", 24_000, { min: 1_000, max: 1_000_000 });
export const MAX_STDERR_CHARS = readInteger("MAX_STDERR_CHARS", 12_000, { min: 1_000, max: 500_000 });
export const MAX_CONCURRENT_TOOLS = readInteger("MAX_CONCURRENT_TOOLS", 8, { min: 1, max: 64 });
export const MAX_PROCESS_LOG_BYTES = readInteger("MAX_PROCESS_LOG_BYTES", 10_000_000, { min: 100_000, max: 1_000_000_000 });
export const PROCESS_RETENTION_DAYS = readInteger("PROCESS_RETENTION_DAYS", 14, { min: 1, max: 365 });
export const MAX_PROCESS_RECORDS = readInteger("MAX_PROCESS_RECORDS", 500, { min: 10, max: 10_000 });
export const CONVERSATION_STATE_TTL_MS = readInteger("CONVERSATION_STATE_TTL_MS", 30 * 24 * 60 * 60 * 1_000, { min: 60_000, max: 365 * 24 * 60 * 60 * 1_000 });
export const MAX_CONVERSATION_STATE_FILES = readInteger("MAX_CONVERSATION_STATE_FILES", 500, { min: 10, max: 100_000 });
const CONVERSATION_PRUNE_INTERVAL_MS = readInteger("CONVERSATION_PRUNE_INTERVAL_MS", 3_600_000, { min: 0, max: 24 * 60 * 60 * 1_000 });
export const PROJECT_DOC_FILENAMES = splitRawList(process.env.PROJECT_DOC_FILENAMES || "AGENTS.md");
export const PROJECT_MEMORY_FILENAME = process.env.PROJECT_MEMORY_FILENAME || "MEMORY.md";
export const GLOBAL_AGENT_DOC_PATH = path.resolve(expandHome(process.env.GLOBAL_AGENT_DOC_PATH || path.join(HOME, ".agents", "AGENTS.md")));
export const MEMORY_ROOT = path.resolve(expandHome(process.env.MEMORY_ROOT || path.join(HOME, ".agents", "skills", "memory")));
export const MAX_PROJECT_DOC_BYTES = readInteger("MAX_PROJECT_DOC_BYTES", 2_000, { min: 200, max: 100_000 });
export const MAX_SKILL_NAMES = readInteger("MAX_SKILL_NAMES", 150, { min: 10, max: 5_000 });
export const CHATGPT_AGENT_BIN = process.env.CHATGPT_AGENT_BIN || "cwa";
export const SUBAGENT_BROWSER = (process.env.SUBAGENT_BROWSER || "").trim().toLowerCase();
export const MAX_CONCURRENT_SUBAGENTS = (() => {
  const raw = Number.parseInt(process.env.MAX_CONCURRENT_SUBAGENTS || "3", 10);
  return Number.isInteger(raw) && raw >= 1 && raw <= 8 ? raw : 3;
})();
export const INTERCEPTOR_BIN = process.env.INTERCEPTOR_BIN || "interceptor";
export const DESTRUCTIVE_AUDIT_FAIL_CLOSED = readBoolean("DESTRUCTIVE_AUDIT_FAIL_CLOSED", true);
export const BYPASS_SECURITY = readBoolean("BYPASS_SECURITY", false);
export const ALLOW_TOOL_ROOT_REGISTRATION = readBoolean("ALLOW_TOOL_ROOT_REGISTRATION", false);
export const INCLUDE_COMMON_WORKSPACE_ROOTS = readBoolean("INCLUDE_COMMON_WORKSPACE_ROOTS", false);
export const FILE_PREVIEW_CLOUD_ENABLED = readBoolean("FILE_PREVIEW_CLOUD_ENABLED", false);
export const FILE_PREVIEW_S3_BUCKET = process.env.FILE_PREVIEW_S3_BUCKET || "";
export const FILE_PREVIEW_AWS_PROFILE = process.env.FILE_PREVIEW_AWS_PROFILE || "";
export const FILE_PREVIEW_AWS_REGION = process.env.FILE_PREVIEW_AWS_REGION || process.env.AWS_REGION || "";
export const FILE_PREVIEW_AWS_BIN = process.env.FILE_PREVIEW_AWS_BIN || "aws";
export const FILE_PREVIEW_PRESIGN_SECONDS = readInteger("FILE_PREVIEW_PRESIGN_SECONDS", 3_600, { min: 60, max: 604_800 });
export const FILE_PREVIEW_CLOUD_TIMEOUT_MS = readInteger("FILE_PREVIEW_CLOUD_TIMEOUT_MS", 300_000, { min: 1_000, max: 900_000 });
export const FILE_PREVIEW_CLOUD_CATEGORIES = new Set(splitList(process.env.FILE_PREVIEW_CLOUD_CATEGORIES || "image,audio,video,pdf"));
export const TOOL_ENV_INHERIT_SECRETS = readBoolean("TOOL_ENV_INHERIT_SECRETS", false);
export const TOOL_ENV_ALLOWLIST = new Set(splitRawList(process.env.TOOL_ENV_ALLOWLIST || ""));
export const TOOL_EXTRA_PATH = splitPathList(process.env.TOOL_EXTRA_PATH || "")
  .map((item) => path.resolve(expandHome(item)));
export const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
// ChatGPT's connector expires blocking tool calls at about two minutes. Keep a safety margin so
// long-running tools can return resumable state before the connector can expire and retry them.
// This is a connector-wide constraint, not a request_user_input-specific timeout.
export const CONNECTOR_TOOL_CALL_EXPIRY_MS = 120_000;
// Long agent turns should yield a concise resumable checkpoint before they drift.
// Production default is 20 minutes; runtime.env can temporarily lower this for testing.
export const TURN_CHECKPOINT_MS = readInteger("TURN_CHECKPOINT_MS", 20 * 60_000, {
  min: 60_000,
  max: 4 * 60 * 60_000,
});
// ChatGPT connector-specific wait budget per tool call (75s to yield cleanly before 120s gateway cutoff):
export const INTERRUPT_CONNECTOR_BUDGET_MS = 75_000;
// Human lifespan for questionnaires (popup stays open for reading/typing):
export const INTERRUPT_USER_TTL_MS = 300_000; // 5 minutes
// Backward-compatibility alias
export const ASK_USER_TIMEOUT_MS = INTERRUPT_CONNECTOR_BUDGET_MS;
const TOOL_UI_ENABLED = readBoolean("TOOL_UI", false);
export const toolUi = Object.freeze({
  enabled: TOOL_UI_ENABLED,
  tools: Object.freeze({
    apply_patch: readBoolean("TOOL_UI_APPLY_PATCH", true),
    display: readBoolean("TOOL_UI_DISPLAY", true),
    execute_command: readBoolean("TOOL_UI_EXECUTE_COMMAND", TOOL_UI_ENABLED),
    write_todos: readBoolean("TOOL_UI_WRITE_TODOS", true),
  }),
});
export const DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE ? path.resolve(expandHome(process.env.DEFAULT_WORKSPACE)) : "";
const DEFAULT_SKILL_ROOTS = [
  path.join(HOME, ".agents", "skills"),
  path.join(HOME, ".local-system", "skills"),
  path.join(HOME, ".local-system", ".agents", "skills"),
];
const PERSONAL_SKILL_ROOTS = (process.env.SKILL_ROOTS
  ? splitPathList(process.env.SKILL_ROOTS)
  : DEFAULT_SKILL_ROOTS);
export const SKILL_ROOTS = [BRIDGE_SKILL_ROOT, ...PERSONAL_SKILL_ROOTS]
  .map((item) => path.resolve(expandHome(item)));

export function builtInRoots(platform = process.platform) {
  if (!INCLUDE_COMMON_WORKSPACE_ROOTS) return [];
  const common = [
    path.join(HOME, "Desktop"),
    path.join(HOME, "Documents"),
    path.join(HOME, "Downloads"),
    path.join(HOME, "Developer"),
    path.join(HOME, "dev"),
    path.join(HOME, "src"),
    path.join(HOME, "projects"),
    path.join(HOME, "code"),
    path.join(HOME, "workspace"),
    path.join(HOME, "workspaces"),
    path.join(HOME, "ghq"),
  ];
  if (platform === "win32") {
    for (const envName of ["USERPROFILE", "OneDrive", "OneDriveCommercial"]) {
      if (process.env[envName]) common.push(process.env[envName]);
    }
  }
  return common.map((item) => path.resolve(item));
}

export function extraRoots() {
  return splitPathList(process.env.WORKSPACE_ROOTS || "").map((item) => path.resolve(expandHome(item))).filter(isDirectory);
}

export function configuredDenyPaths() {
  const platformDefaults = process.platform === "win32"
    ? [
        process.env.WINDIR,
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        process.env.ProgramData,
        path.join(HOME, ".ssh"),
        path.join(HOME, ".aws"),
        path.join(HOME, ".kube"),
        path.join(process.env.APPDATA || HOME, "Microsoft", "Credentials"),
      ]
    : [
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/private/etc",
        "/private/var/db",
        "/Library/Apple",
        path.join(HOME, "Library", "Keychains"),
        path.join(HOME, ".ssh"),
        path.join(HOME, ".aws"),
        path.join(HOME, ".kube"),
        path.join(HOME, ".config", "gcloud"),
      ];
  return [...platformDefaults, ...splitPathList(process.env.BRIDGE_DENY_PATHS || "")]
    .filter(Boolean)
    .map((item) => path.resolve(expandHome(item)));
}

export function ensureStateDirs() {
  for (const dir of [STATE_DIR, LOG_DIR, PROC_DIR, AUDIT_DIR, CONVERSATION_DIR, SUBAGENT_RUN_DIR, SCRATCH_ROOT]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function currentScratchDir() {
  const now = new Date();
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
  const dir = path.join(SCRATCH_ROOT, day);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.realpathSync.native(dir);
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    currentWorkspace: DEFAULT_WORKSPACE,
    extraRoots: [],
    savedProjects: [],
  };
}

function readGlobalState() {
  if (!fs.existsSync(STATE_FILE)) return defaultState();
  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch {
    return defaultState();
  }
}

function conversationStateFileByKey(key) {
  const normalized = String(key || "").trim();
  if (!CONVERSATION_KEY_RE.test(normalized)) throw new Error("invalid conversation state key");
  return path.join(CONVERSATION_DIR, `${normalized}.json`);
}

export function readConversationStateByKey(key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(conversationStateFileByKey(key), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof Error && error.message === "invalid conversation state key") throw error;
    return null;
  }
}

export function readConversationState(conversationId = currentConversationId()) {
  if (!conversationId) return null;
  return readConversationStateByKey(conversationKey(conversationId));
}

function readConversationWorkspace(conversationId) {
  const parsed = readConversationState(conversationId);
  return typeof parsed?.currentWorkspace === "string" ? parsed.currentWorkspace : null;
}

export function updateConversationState(patch, conversationId = currentConversationId()) {
  ensureStateDirs();
  if (!conversationId) throw new Error("conversation-scoped state requires a conversation id");
  return updateConversationStateByKey(conversationKey(conversationId), patch);
}

export function updateConversationStateByKey(key, patch) {
  ensureStateDirs();
  const current = readConversationStateByKey(key) || {};
  const next = {
    ...current,
    ...patch,
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(conversationStateFileByKey(key), next);
  pruneConversationStates();
  return next;
}

// `currentWorkspace` and todo state are conversation-scoped. `extraRoots` and
// `savedProjects` are shared configuration and stay global on purpose, so a
// project saved in one chat is visible in every chat.
//
// A conversation starts with no project selected. It deliberately does not
// inherit the global pointer, which is whatever some other caller last left
// behind; every write path fails closed with actionable guidance until the
// conversation opens a workspace of its own.
export function loadState() {
  ensureStateDirs();
  const base = readGlobalState();
  const conversationId = currentConversationId();
  if (!conversationId) return base;
  return { ...base, currentWorkspace: readConversationWorkspace(conversationId) ?? "" };
}

export function saveState(next) {
  ensureStateDirs();
  const normalized = normalizeState(next);
  const conversationId = currentConversationId();
  if (!conversationId) {
    atomicWriteJson(STATE_FILE, normalized);
    return;
  }
  updateConversationState({ currentWorkspace: normalized.currentWorkspace || "" }, conversationId);
  // Shared fields still persist globally, but the global workspace pointer is
  // preserved: one conversation must never move another conversation's
  // workspace, nor the default inherited by the next new conversation.
  const globalState = readGlobalState();
  const merged = normalizeState({ ...normalized, currentWorkspace: globalState.currentWorkspace });
  // Only rewrite the shared file when shared data actually changed. Opening a
  // workspace changes nothing global, so it must not race another conversation
  // that is concurrently saving a project.
  if (JSON.stringify(merged) !== JSON.stringify(globalState)) {
    atomicWriteJson(STATE_FILE, merged);
  }
}

let lastPruneAt = 0;

export function pruneConversationStates({ force = false, now = Date.now() } = {}) {
  if (!force && now - lastPruneAt < CONVERSATION_PRUNE_INTERVAL_MS) return 0;
  lastPruneAt = now;
  let entries;
  try {
    entries = fs.readdirSync(CONVERSATION_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(CONVERSATION_DIR, entry.name);
    try {
      files.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
    } catch { /* raced with another prune */ }
  }
  let removed = 0;
  const survivors = [];
  for (const file of files) {
    if (now - file.mtimeMs > CONVERSATION_STATE_TTL_MS) {
      try { fs.rmSync(file.filePath, { force: true }); removed += 1; } catch { /* ignore */ }
    } else {
      survivors.push(file);
    }
  }
  if (survivors.length > MAX_CONVERSATION_STATE_FILES) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of survivors.slice(0, survivors.length - MAX_CONVERSATION_STATE_FILES)) {
      try { fs.rmSync(file.filePath, { force: true }); removed += 1; } catch { /* ignore */ }
    }
  }
  return removed;
}

function normalizeState(input) {
  const source = input && typeof input === "object" ? input : {};
  const savedProjects = Array.isArray(source.savedProjects)
    ? source.savedProjects
    : Array.isArray(source.workspaces)
      ? source.workspaces
      : [];
  const rest = { ...source };
  delete rest.workspaces;
  return { ...defaultState(), ...rest, version: STATE_VERSION, savedProjects };
}

export function configuredProjectRoots() {
  const state = loadState();
  return [...new Set([
    ...builtInRoots(),
    ...extraRoots(),
    ...(state.extraRoots || []).map((item) => path.resolve(item)),
  ])].filter(isDirectory);
}

export function toolWorkspaceRoots() {
  ensureStateDirs();
  return [...new Set([...configuredProjectRoots(), SCRATCH_ROOT])].filter(isDirectory);
}

export function validateRuntimeConfig(effectiveHost = HOST) {
  if (!isLoopbackHost(effectiveHost)) {
    throw new Error(`Refusing HOST=${effectiveHost}; this bridge is intentionally loopback-only. Put an independently authenticated TLS proxy in front only after a separate security review.`);
  }
}

export function isLoopbackHost(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(normalizeHost(host).toLowerCase());
}

export function isToolUiEnabled(toolName) {
  if (Object.hasOwn(toolUi.tools, toolName)) return toolUi.tools[toolName];
  const envName = `TOOL_UI_${String(toolName).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
  return readBoolean(envName, toolUi.enabled);
}

export function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function expandHome(input) {
  if (!input) return input;
  if (input === "~") return HOME;
  if (String(input).startsWith("~/") || String(input).startsWith("~\\")) {
    return path.join(HOME, String(input).slice(2));
  }
  return input;
}

function splitPathList(value) {
  if (!value) return [];
  return value
    .split(new RegExp(`[${escapeRegExp(path.delimiter)}\\n]`))
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitList(value) {
  return splitRawList(value).map((item) => item.toLowerCase());
}

function splitRawList(value) {
  return String(value).split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readBoolean(name, fallback) {
  const raw = process.env[name] ?? process.env[name.toLowerCase()] ?? process.env[name.toUpperCase()];
  if (raw == null || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(raw).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(raw).toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function readInteger(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
