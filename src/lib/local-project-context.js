import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  STATE_DIR,
  ensureStateDirs,
  updateConversationStateByKey,
} from "./config.js";

const THREAD_PROJECTS_FILE = path.join(STATE_DIR, "browser-thread-projects.json");
const THREAD_PROJECTS_VERSION = 1;
const MAX_THREAD_PROJECTS = 512;

export function resolveBrowserProjectContext(threadId, resolvedThread) {
  const savedWorkspace = savedBrowserThreadProject(threadId);
  const boundWorkspace = boundConversationProject(resolvedThread);

  if (resolvedThread?.bound && boundWorkspace) {
    if (savedWorkspace !== boundWorkspace) saveBrowserThreadProject(threadId, boundWorkspace);
    return {
      resolvedThread,
      bound: true,
      currentWorkspace: boundWorkspace,
      projectSource: "binding",
      threadWorkspace: boundWorkspace,
      promotedFromThread: false,
    };
  }

  if (
    resolvedThread?.bound
    && savedWorkspace
    && typeof resolvedThread.conversationKey === "string"
    && resolvedThread.conversationKey
  ) {
    const nextState = updateConversationStateByKey(resolvedThread.conversationKey, {
      currentWorkspace: savedWorkspace,
      workspaceSelection: selectionMetadata("thread-fallback", ""),
    });
    return {
      resolvedThread: { ...resolvedThread, state: nextState },
      bound: true,
      currentWorkspace: savedWorkspace,
      projectSource: "binding",
      threadWorkspace: savedWorkspace,
      promotedFromThread: true,
    };
  }

  return {
    resolvedThread,
    bound: resolvedThread?.bound === true,
    currentWorkspace: savedWorkspace,
    projectSource: savedWorkspace ? "thread" : "none",
    threadWorkspace: savedWorkspace,
    promotedFromThread: false,
  };
}

export function selectBrowserProject(threadId, resolvedThread, workspacePath) {
  const selected = normalizeWorkspacePath(workspacePath);
  const previousWorkspace = boundConversationProject(resolvedThread) || savedBrowserThreadProject(threadId);
  saveBrowserThreadProject(threadId, selected);

  if (
    resolvedThread?.bound
    && typeof resolvedThread.conversationKey === "string"
    && resolvedThread.conversationKey
  ) {
    const nextState = previousWorkspace === selected
      ? resolvedThread.state
      : updateConversationStateByKey(resolvedThread.conversationKey, {
        currentWorkspace: selected,
        workspaceSelection: selectionMetadata("user", previousWorkspace),
      });
    return {
      resolvedThread: { ...resolvedThread, state: nextState },
      bound: true,
      currentWorkspace: selected,
      projectSource: "binding",
      threadWorkspace: selected,
      previousWorkspace,
      promotedFromThread: false,
    };
  }

  return {
    resolvedThread,
    bound: false,
    currentWorkspace: selected,
    projectSource: "thread",
    threadWorkspace: selected,
    previousWorkspace,
    promotedFromThread: false,
  };
}

export function effectiveBrowserProject(threadId, resolvedThread) {
  return resolveBrowserProjectContext(threadId, resolvedThread).currentWorkspace;
}

export function savedBrowserThreadProject(threadId) {
  const key = threadProjectKey(threadId);
  if (!key) return "";
  const projects = readThreadProjects();
  const record = projects[key];
  return typeof record?.workspace === "string" ? record.workspace : "";
}

export function saveBrowserThreadProject(threadId, workspacePath) {
  const key = threadProjectKey(threadId);
  const workspace = normalizeWorkspacePath(workspacePath);
  if (!key || !workspace) return;

  const projects = readThreadProjects();
  const previous = projects[key];
  if (previous?.workspace === workspace) return;
  projects[key] = {
    workspace,
    updatedAt: new Date().toISOString(),
  };
  trimThreadProjects(projects);
  writeThreadProjects(projects);
}

export function clearBrowserThreadProject(threadId) {
  const key = threadProjectKey(threadId);
  if (!key) return;
  const projects = readThreadProjects();
  if (!(key in projects)) return;
  delete projects[key];
  writeThreadProjects(projects);
}

function boundConversationProject(resolvedThread) {
  if (!resolvedThread?.bound) return "";
  return typeof resolvedThread.state?.currentWorkspace === "string"
    ? resolvedThread.state.currentWorkspace.trim()
    : "";
}

function selectionMetadata(source, previousWorkspace) {
  return {
    source,
    changedAt: new Date().toISOString(),
    previousWorkspace: previousWorkspace || null,
  };
}

function normalizeWorkspacePath(workspacePath) {
  return String(workspacePath || "").trim();
}

function threadProjectKey(threadId) {
  const normalized = String(threadId || "").trim();
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function readThreadProjects() {
  ensureStateDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(THREAD_PROJECTS_FILE, "utf8"));
    if (parsed?.version !== THREAD_PROJECTS_VERSION) return {};
    return parsed?.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)
      ? { ...parsed.projects }
      : {};
  } catch {
    return {};
  }
}

function writeThreadProjects(projects) {
  ensureStateDirs();
  const tmp = `${THREAD_PROJECTS_FILE}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const body = `${JSON.stringify({ version: THREAD_PROJECTS_VERSION, projects }, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, THREAD_PROJECTS_FILE);
  fs.chmodSync(THREAD_PROJECTS_FILE, 0o600);
}

function trimThreadProjects(projects) {
  const entries = Object.entries(projects);
  if (entries.length <= MAX_THREAD_PROJECTS) return;
  entries
    .sort((a, b) => (Date.parse(a[1]?.updatedAt || "") || 0) - (Date.parse(b[1]?.updatedAt || "") || 0))
    .slice(0, entries.length - MAX_THREAD_PROJECTS)
    .forEach(([key]) => delete projects[key]);
}
