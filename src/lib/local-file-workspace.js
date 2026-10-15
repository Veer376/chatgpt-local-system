import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configuredProjectRoots, loadState, updateConversationStateByKey } from "./config.js";
import { validateThreadFile } from "./local-files.js";
import {
  appendRecoveryAnnotationTurn,
  fileAnnotationRecoverySnapshot,
  normalizeRecoveryTurns,
} from "./local-annotations.js";
import {
  resolveBrowserProjectContext,
  selectBrowserProject,
} from "./local-project-context.js";
import { resolveBrowserThreadState } from "./local-todos.js";
import { recordWorkspaceTrace } from "./local-workspace-trace.js";
import { assertInProjectRoots, canonicalPath, isWithin } from "./paths.js";
import { waitForWorkspaceChange } from "./workspace-watch.js";

const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const MAX_OPEN_FILES = 12;
const MAX_ANNOTATIONS = 300;
const MAX_MEDIA_NOTES = 300;
const MAX_COMMENT_LENGTH = 5_000;
const MAX_QUOTE_LENGTH = 8_000;
const MIN_WIDTH = 420;
const MAX_WIDTH = 1_000;
const MAX_EPHEMERAL_WORKSPACES = 64;
const MAX_PROJECT_CHOICES = 120;
const MAX_DIRECTORY_ENTRIES = 500;
const HIDDEN_TREE_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "Pods",
  "Carthage",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".dart_tool",
  ".swiftpm",
  ".cache",
  ".parcel-cache",
  ".yarn",
  ".expo",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "target",
  "DerivedData",
]);

const ephemeralWorkspaces = new Map();

export function registerLocalFileWorkspaceRoutes(app) {
  app.post("/local-ui/file-workspace", async (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const threadId = String(req.body?.threadId || "").trim();
      if (!threadId) {
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          bound: false,
          currentWorkspace: "",
          projectSource: "none",
          threadWorkspace: "",
          workspace: defaultWorkspace(),
        });
      }

      let resolved = resolveBrowserThreadState(threadId);
      let projectContext = resolveBrowserProjectContext(threadId, resolved);
      resolved = projectContext.resolvedThread;
      const action = typeof req.body?.action === "string" ? req.body.action : "get";

      if (action === "watch") {
        const workspaceRoot = projectContext.currentWorkspace;
        if (!workspaceRoot) {
          return res.status(409).set("Cache-Control", "no-store").json({ error: "open a project first" });
        }
        const controller = new AbortController();
        const abortWatch = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.once("close", abortWatch);
        try {
          const watch = await waitForWorkspaceChange(workspaceRoot, {
            since: req.body?.since,
            signal: controller.signal,
            timeoutMs: 25_000,
          });
          if (res.destroyed || res.writableEnded) return undefined;
          return res.set("Cache-Control", "no-store").json({
            ok: true,
            ...projectContextPayload(projectContext),
            watch,
          });
        } catch (error) {
          if (controller.signal.aborted || error?.name === "AbortError" || res.destroyed || res.writableEnded) return undefined;
          throw error;
        } finally {
          res.off("close", abortWatch);
        }
      }

      if (action === "projects") {
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          ...projectContextPayload(projectContext),
          projects: projectChoices(projectContext, { includeHidden: req.body?.includeHidden === true }),
        });
      }

      // Project selection is one operation with two persistence targets:
      // while unbound it persists on the browser thread; once bound it also
      // updates conversation.currentWorkspace, which then becomes authoritative.
      if (action === "select_project" || action === "view_project" || action === "open_project") {
        const selected = validateProjectDirectory(req.body?.path);
        const before = projectContext;
        const selection = selectBrowserProject(threadId, resolved, selected);
        resolved = selection.resolvedThread;
        projectContext = selection;

        let workspace;
        if (selection.bound) {
          const sameProject = selected === before.currentWorkspace;
          workspace = sameProject
            ? normalizeWorkspace(resolved.state?.fileWorkspace, resolved, { workspaceRoot: selected })
            : resetWorkspaceForProject(normalizePersistedWorkspace(resolved.state?.fileWorkspace));
          workspace = persistWorkspace(resolved.conversationKey, workspace);
          ephemeralWorkspaces.delete(threadId);
        } else {
          const previousEphemeral = normalizePersistedWorkspace(
            ephemeralWorkspaces.get(threadId) || defaultWorkspace(),
          );
          workspace = selected === before.currentWorkspace
            ? normalizeWorkspace(previousEphemeral, resolved, { workspaceRoot: selected })
            : resetWorkspaceForProject(previousEphemeral);
          rememberEphemeralWorkspace(threadId, workspace);
        }

        return res.set("Cache-Control", "no-store").json({
          ok: true,
          ...projectContextPayload(projectContext),
          previousWorkspace: selection.previousWorkspace,
          workspace,
        });
      }

      if (action === "list_directory") {
        const workspaceRoot = projectContext.currentWorkspace;
        if (!workspaceRoot) {
          return res.status(409).set("Cache-Control", "no-store").json({ error: "open a project first" });
        }
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          ...projectContextPayload(projectContext),
          ...listProjectDirectory(workspaceRoot, req.body?.path),
        });
      }

      if (action === "context") {
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          ...projectContextPayload(projectContext),
        });
      }

      if (!projectContext.bound) {
        let workspace = normalizeWorkspace(ephemeralWorkspaces.get(threadId), resolved, {
          workspaceRoot: projectContext.currentWorkspace,
        });
        if (action === "update") {
          workspace = applyWorkspaceUpdate(workspace, req.body?.workspace, resolved, {
            workspaceRoot: projectContext.currentWorkspace,
          });
        } else if (action === "open_file") {
          workspace = openWorkspaceFile(workspace, req.body?.path, resolved, {
            workspaceRoot: projectContext.currentWorkspace,
          });
        } else if (action === "upsert_annotation") {
          const annotation = normalizeAnnotation(req.body?.annotation, resolved, {
            requireComment: true,
            workspaceRoot: projectContext.currentWorkspace,
          });
          workspace = upsertWorkspaceAnnotation(workspace, annotation);
        } else if (action === "delete_annotation") {
          const id = String(req.body?.id || "").trim();
          workspace.annotations = workspace.annotations.filter((item) => item.id !== id);
        } else if (action === "upsert_media_note") {
          const note = normalizeMediaNote(req.body?.note, resolved, { workspaceRoot: projectContext.currentWorkspace });
          workspace = upsertWorkspaceMediaNote(workspace, note);
        } else if (action === "delete_media_note") {
          const id = String(req.body?.id || "").trim();
          workspace.mediaNotes = workspace.mediaNotes.filter((item) => item.id !== id);
        } else if (action === "clear_annotations") {
          workspace.annotations = [];
        } else if (action !== "get") {
          return res.status(400).set("Cache-Control", "no-store").json({ error: "unsupported file workspace action" });
        }
        rememberEphemeralWorkspace(threadId, workspace);
        recordWorkspaceTrace({
          stage: `server.workspace.${action}`,
          threadId,
          path: workspace.activePath,
          data: workspaceTraceState(workspace, projectContext),
        });
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          ...projectContextPayload(projectContext),
          workspace,
        });
      }

      let workspace;
      if (projectContext.promotedFromThread && ephemeralWorkspaces.has(threadId)) {
        workspace = normalizeWorkspace(ephemeralWorkspaces.get(threadId), resolved, {
          workspaceRoot: projectContext.currentWorkspace,
        });
        workspace = persistWorkspace(resolved.conversationKey, workspace);
        ephemeralWorkspaces.delete(threadId);
      } else {
        workspace = normalizeWorkspace(resolved.state?.fileWorkspace, resolved, {
          workspaceRoot: projectContext.currentWorkspace,
        });
      }

      if (action === "update") {
        workspace = applyWorkspaceUpdate(workspace, req.body?.workspace, resolved, {
          workspaceRoot: projectContext.currentWorkspace,
        });
        workspace = persistWorkspace(resolved.conversationKey, workspace);
      } else if (action === "open_file") {
        workspace = openWorkspaceFile(workspace, req.body?.path, resolved, {
          workspaceRoot: projectContext.currentWorkspace,
        });
        workspace = persistWorkspace(resolved.conversationKey, workspace);
      } else if (action === "upsert_annotation") {
        const annotation = normalizeAnnotation(req.body?.annotation, resolved, {
          requireComment: true,
          workspaceRoot: projectContext.currentWorkspace,
        });
        const existingIndex = annotation.id
          ? workspace.annotations.findIndex((item) => item.id === annotation.id)
          : -1;
        const now = new Date().toISOString();
        if (existingIndex >= 0) {
          annotation.createdAt = workspace.annotations[existingIndex].createdAt || now;
          annotation.updatedAt = now;
          workspace.annotations[existingIndex] = annotation;
        } else {
          annotation.id = crypto.randomUUID();
          annotation.createdAt = now;
          annotation.updatedAt = now;
          workspace.annotations.push(annotation);
        }
        workspace.annotations = workspace.annotations.slice(-MAX_ANNOTATIONS);
        const recoverySnapshot = fileAnnotationRecoverySnapshot(annotation);
        const annotationTurns = appendRecoveryAnnotationTurn(
          normalizeRecoveryTurns(resolved.state?.annotationTurns, resolved.state?.lastAnnotation),
          recoverySnapshot,
        );
        workspace = persistWorkspace(resolved.conversationKey, workspace, {
          lastAnnotation: recoverySnapshot,
          annotationTurns,
        });
      } else if (action === "delete_annotation") {
        const id = String(req.body?.id || "").trim();
        workspace.annotations = workspace.annotations.filter((item) => item.id !== id);
        workspace = persistWorkspace(resolved.conversationKey, workspace);
      } else if (action === "upsert_media_note") {
        const note = normalizeMediaNote(req.body?.note, resolved, { workspaceRoot: projectContext.currentWorkspace });
        workspace = persistWorkspace(resolved.conversationKey, upsertWorkspaceMediaNote(workspace, note));
      } else if (action === "delete_media_note") {
        const id = String(req.body?.id || "").trim();
        workspace.mediaNotes = workspace.mediaNotes.filter((item) => item.id !== id);
        workspace = persistWorkspace(resolved.conversationKey, workspace);
      } else if (action === "clear_annotations") {
        workspace.annotations = [];
        workspace = persistWorkspace(resolved.conversationKey, workspace);
      } else if (action !== "get") {
        return res.status(400).set("Cache-Control", "no-store").json({ error: "unsupported file workspace action" });
      }

      recordWorkspaceTrace({
        stage: `server.workspace.${action}`,
        threadId,
        path: workspace.activePath,
        data: workspaceTraceState(workspace, projectContext),
      });

      return res.set("Cache-Control", "no-store").json({
        ok: true,
        ...projectContextPayload(projectContext),
        workspace,
      });
    } catch (error) {
      return res.status(statusForWorkspaceError(error)).set("Cache-Control", "no-store").json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function workspaceTraceState(workspace, projectContext) {
  return {
    currentWorkspace: projectContext.currentWorkspace || "",
    bound: projectContext.bound === true,
    activeScrollTop: workspace.activeScrollTop ?? null,
    leftMode: workspace.leftMode ?? null,
    treeCollapsed: workspace.treeCollapsed === true,
    openPathCount: Array.isArray(workspace.openPaths) ? workspace.openPaths.length : 0,
  };
}

function rememberEphemeralWorkspace(threadId, workspace) {
  ephemeralWorkspaces.delete(threadId);
  ephemeralWorkspaces.set(threadId, normalizePersistedWorkspace(workspace));
  while (ephemeralWorkspaces.size > MAX_EPHEMERAL_WORKSPACES) {
    const oldest = ephemeralWorkspaces.keys().next().value;
    ephemeralWorkspaces.delete(oldest);
  }
}

function projectContextPayload(context) {
  return {
    bound: context?.bound === true,
    currentWorkspace: String(context?.currentWorkspace || ""),
    projectSource: String(context?.projectSource || "none"),
    threadWorkspace: String(context?.threadWorkspace || ""),
  };
}

function upsertWorkspaceAnnotation(workspace, annotation) {
  const next = {
    ...workspace,
    annotations: [...workspace.annotations],
  };
  const existingIndex = annotation.id
    ? next.annotations.findIndex((item) => item.id === annotation.id)
    : -1;
  const now = new Date().toISOString();
  if (existingIndex >= 0) {
    annotation.createdAt = next.annotations[existingIndex].createdAt || now;
    annotation.updatedAt = now;
    next.annotations[existingIndex] = annotation;
  } else {
    annotation.id = crypto.randomUUID();
    annotation.createdAt = now;
    annotation.updatedAt = now;
    next.annotations.push(annotation);
  }
  next.annotations = next.annotations.slice(-MAX_ANNOTATIONS);
  return next;
}

function upsertWorkspaceMediaNote(workspace, note) {
  const next = {
    ...workspace,
    mediaNotes: [...workspace.mediaNotes],
  };
  const existingIndex = note.id
    ? next.mediaNotes.findIndex((item) => item.id === note.id)
    : -1;
  const now = new Date().toISOString();
  if (existingIndex >= 0) {
    note.createdAt = next.mediaNotes[existingIndex].createdAt || now;
    note.updatedAt = now;
    next.mediaNotes[existingIndex] = note;
  } else {
    note.id = crypto.randomUUID();
    note.createdAt = now;
    note.updatedAt = now;
    next.mediaNotes.push(note);
  }
  next.mediaNotes = next.mediaNotes.slice(-MAX_MEDIA_NOTES);
  return next;
}

function validateProjectDirectory(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("project path is required");
  const resolved = canonicalPath(assertInProjectRoots(raw));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${resolved} is not a directory`);
  return resolved;
}

function projectChoices(projectContext = {}, { includeHidden = false } = {}) {
  const byPath = new Map();
  const sharedState = loadState();
  const add = (candidate, name = "", description = "", source = "discovered") => {
    try {
      const projectPath = validateProjectDirectory(candidate);
      if (!includeHidden && isHiddenProjectChoice(projectPath)) return;
      if (byPath.has(projectPath)) return;
      byPath.set(projectPath, {
        name: String(name || path.basename(projectPath) || projectPath),
        path: projectPath,
        ...(description ? { description: String(description) } : {}),
        source,
      });
    } catch {
      // Stale saved projects and unreadable directories are omitted.
    }
  };

  for (const saved of Array.isArray(sharedState.savedProjects) ? sharedState.savedProjects : []) {
    add(saved?.path, saved?.name, saved?.description, "saved");
  }

  add(
    projectContext.currentWorkspace,
    path.basename(projectContext.currentWorkspace || ""),
    "",
    projectContext.bound ? "binding" : (projectContext.currentWorkspace ? "thread" : "discovered"),
  );

  for (const root of configuredProjectRoots()) {
    if (includeHidden && hasDotPathSegment(root)) {
      add(root, hiddenProjectRootName(root), "", "authorized");
    }
    if (!isProjectDiscoveryRoot(root, { includeHidden })) continue;
    let children = [];
    try { children = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (byPath.size >= MAX_PROJECT_CHOICES) break;
      if (
        !child.isDirectory()
        || child.isSymbolicLink()
        || (!includeHidden && child.name.startsWith("."))
      ) continue;
      add(path.join(root, child.name), child.name, "", "discovered");
    }
    if (byPath.size >= MAX_PROJECT_CHOICES) break;
  }

  return [...byPath.values()]
    .sort((a, b) => projectChoicePriority(b.source) - projectChoicePriority(a.source) || a.name.localeCompare(b.name))
    .slice(0, MAX_PROJECT_CHOICES);
}

function projectChoicePriority(source) {
  if (source === "binding") return 3;
  if (source === "thread") return 2;
  if (source === "authorized") return 1;
  if (source === "saved") return 1;
  return 0;
}

function isProjectDiscoveryRoot(root, { includeHidden = false } = {}) {
  const normalized = path.resolve(root);
  const basename = path.basename(normalized).toLowerCase();
  const segments = normalized.split(path.sep).filter(Boolean).map((item) => item.toLowerCase());
  if (basename === "downloads") return false;
  if (!includeHidden && segments.includes(".agents") && segments.includes("skills")) return false;
  return true;
}

function hasDotPathSegment(projectPath) {
  return path.resolve(projectPath).split(path.sep).filter(Boolean).some((segment) => segment.startsWith("."));
}

function hiddenProjectRootName(projectPath) {
  const segments = path.resolve(projectPath).split(path.sep).filter(Boolean);
  const hiddenIndex = segments.findIndex((segment) => segment.startsWith("."));
  return hiddenIndex >= 0 ? segments.slice(hiddenIndex).join("/") : (path.basename(projectPath) || projectPath);
}

function isHiddenProjectChoice(projectPath) {
  const segments = path.resolve(projectPath).split(path.sep).filter(Boolean).map((item) => item.toLowerCase());
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === ".agents" && segments[index + 1] === "skills") return true;
  }
  return false;
}

function listProjectDirectory(workspaceRoot, requestedPath) {
  const root = validateProjectDirectory(workspaceRoot);
  const requested = requestedPath ? canonicalPath(String(requestedPath)) : root;
  if (requested !== root && !isWithin(requested, root)) throw new Error("directory is outside the current project");
  const stat = fs.statSync(requested);
  if (!stat.isDirectory()) throw new Error("tree path is not a directory");

  const entries = [];
  let children = fs.readdirSync(requested, { withFileTypes: true });
  children = children
    .filter((entry) => !entry.isSymbolicLink())
    .filter((entry) => !(entry.isDirectory() && HIDDEN_TREE_DIRS.has(entry.name)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  for (const child of children.slice(0, MAX_DIRECTORY_ENTRIES)) {
    if (!child.isDirectory() && !child.isFile()) continue;
    entries.push({
      name: child.name,
      path: path.join(requested, child.name),
      type: child.isDirectory() ? "dir" : "file",
    });
  }

  return {
    root,
    path: requested,
    entries,
    truncated: children.length > MAX_DIRECTORY_ENTRIES,
  };
}

function resetWorkspaceForProject(current) {
  return {
    ...current,
    openPaths: [],
    activePath: "",
    activeScrollTop: 0,
    leftMode: "files",
    treeCollapsed: true,
    editorCollapsed: false,
    annotations: [],
    mediaNotes: [],
  };
}

function defaultWorkspace() {
  return {
    openPaths: [],
    activePath: "",
    activeScrollTop: 0,
    leftMode: "files",
    previewViewByPath: {},
    sidebarOpen: false,
    width: 476,
    treeCollapsed: true,
    editorCollapsed: false,
    treeHeight: 257,
    annotations: [],
    mediaNotes: [],
  };
}

function normalizeWorkspace(value, resolved, { workspaceRoot = "" } = {}) {
  const fallback = defaultWorkspace();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const openPaths = [];
  for (const candidate of Array.isArray(value.openPaths) ? value.openPaths : []) {
    if (openPaths.length >= MAX_OPEN_FILES) break;
    try {
      const file = validateThreadFile(candidate, resolved, { workspaceRoot });
      if (!openPaths.includes(file.path)) openPaths.push(file.path);
    } catch {
      // Stale, removed, or no-longer-authorized tabs are pruned on read.
    }
  }
  const requestedActive = typeof value.activePath === "string" ? path.resolve(value.activePath) : "";
  const activePath = openPaths.includes(requestedActive) ? requestedActive : (openPaths[0] || "");
  const annotations = [];
  for (const candidate of Array.isArray(value.annotations) ? value.annotations : []) {
    if (annotations.length >= MAX_ANNOTATIONS) break;
    try {
      annotations.push(normalizeAnnotation(candidate, resolved, { requireComment: true, workspaceRoot }));
    } catch {
      // Bad legacy entries should not break the whole workspace.
    }
  }
  const mediaNotes = [];
  for (const candidate of Array.isArray(value.mediaNotes) ? value.mediaNotes : []) {
    if (mediaNotes.length >= MAX_MEDIA_NOTES) break;
    try {
      mediaNotes.push(normalizeMediaNote(candidate, resolved, { workspaceRoot }));
    } catch {
      // Bad legacy entries should not break the whole workspace.
    }
  }
  return {
    openPaths,
    activePath,
    activeScrollTop: clampScrollTop(value.activeScrollTop),
    leftMode: normalizeLeftMode(value.leftMode),
    previewViewByPath: normalizePreviewViewByPath(value.previewViewByPath ?? value.markdownViewByPath),
    sidebarOpen: value.sidebarOpen === true,
    width: clampWidth(value.width),
    treeCollapsed: value.treeCollapsed === true,
    editorCollapsed: false,
    treeHeight: clampTreeHeight(value.treeHeight),
    annotations,
    mediaNotes,
  };
}

function applyWorkspaceUpdate(current, patch, resolved, { workspaceRoot = "" } = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return current;
  const openPaths = [];
  const requestedPaths = Array.isArray(patch.openPaths) ? patch.openPaths : current.openPaths;
  for (const candidate of requestedPaths) {
    if (openPaths.length >= MAX_OPEN_FILES) break;
    const file = validateThreadFile(candidate, resolved, { workspaceRoot });
    if (!openPaths.includes(file.path)) openPaths.push(file.path);
  }
  const requestedActive = typeof patch.activePath === "string" ? path.resolve(patch.activePath) : current.activePath;
  const activePath = openPaths.includes(requestedActive) ? requestedActive : (openPaths.at(-1) || "");
  const activePathChanged = activePath !== current.activePath;
  return {
    ...current,
    openPaths,
    activePath,
    activeScrollTop: patch.activeScrollTop === undefined
      ? (activePathChanged ? 0 : clampScrollTop(current.activeScrollTop))
      : clampScrollTop(patch.activeScrollTop),
    leftMode: patch.leftMode === undefined ? normalizeLeftMode(current.leftMode) : normalizeLeftMode(patch.leftMode),
    previewViewByPath: patch.previewViewByPath === undefined
      ? normalizePreviewViewByPath(current.previewViewByPath)
      : normalizePreviewViewByPath(patch.previewViewByPath),
    sidebarOpen: patch.sidebarOpen === undefined ? current.sidebarOpen : patch.sidebarOpen === true,
    width: patch.width === undefined ? current.width : clampWidth(patch.width),
    treeCollapsed: patch.treeCollapsed === undefined ? current.treeCollapsed : patch.treeCollapsed === true,
    editorCollapsed: false,
    treeHeight: patch.treeHeight === undefined ? current.treeHeight : clampTreeHeight(patch.treeHeight),
  };
}

function openWorkspaceFile(current, requestedPath, resolved, { workspaceRoot = "" } = {}) {
  const file = validateThreadFile(requestedPath, resolved, { workspaceRoot });
  const openPaths = current.openPaths.filter((item) => item !== file.path);
  openPaths.push(file.path);
  return {
    ...current,
    openPaths: openPaths.slice(-MAX_OPEN_FILES),
    activePath: file.path,
    activeScrollTop: 0,
  };
}

function normalizeAnnotation(value, resolved, { requireComment = true, workspaceRoot = "" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("annotation is required");
  const file = validateThreadFile(value.path, resolved, { workspaceRoot });
  const comment = typeof value.comment === "string" ? value.comment.trim() : "";
  if (requireComment && !comment) throw new Error("annotation comment is required");
  if (comment.length > MAX_COMMENT_LENGTH) throw new Error("annotation comment is too long");
  const quote = typeof value.quote === "string" ? value.quote : "";
  if (!quote || quote.length > MAX_QUOTE_LENGTH) throw new Error("annotation selection is invalid");
  const sourceQuote = typeof value.sourceQuote === "string" ? value.sourceQuote : "";
  if (sourceQuote.length > MAX_QUOTE_LENGTH) throw new Error("annotation source selection is too long");
  const start = normalizePosition(value.start, "start");
  const end = normalizePosition(value.end, "end");
  if (end.offset <= start.offset) throw new Error("annotation selection is invalid");
  return {
    ...(typeof value.id === "string" && value.id.trim() ? { id: value.id.trim().slice(0, 128) } : {}),
    path: file.path,
    comment,
    quote,
    ...(sourceQuote && sourceQuote !== quote ? { sourceQuote } : {}),
    prefix: typeof value.prefix === "string" ? value.prefix.slice(-160) : "",
    suffix: typeof value.suffix === "string" ? value.suffix.slice(0, 160) : "",
    start,
    end,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

function normalizeMediaNote(value, resolved, { workspaceRoot = "" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("media note is required");
  const file = validateThreadFile(value.path, resolved, { workspaceRoot });
  if (!String(file.mimeType || "").startsWith("video/")) throw new Error("media notes require a video file");
  const comment = typeof value.comment === "string" ? value.comment.trim() : "";
  if (!comment) throw new Error("media note comment is required");
  if (comment.length > MAX_COMMENT_LENGTH) throw new Error("media note comment is too long");
  const time = Number(value.time);
  if (!Number.isFinite(time) || time < 0 || time > 1_000_000_000) throw new Error("media note timestamp is invalid");
  return {
    ...(typeof value.id === "string" && value.id.trim() ? { id: value.id.trim().slice(0, 128) } : {}),
    path: file.path,
    time: Math.round(time * 1000) / 1000,
    comment,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

function normalizePosition(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} position is required`);
  const line = Number(value.line);
  const column = Number(value.column);
  const offset = Number(value.offset);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`${label} position is invalid`);
  }
  return { line, column, offset };
}

function persistWorkspace(conversationKey, workspace, extraPatch = {}) {
  return normalizePersistedWorkspace(updateConversationStateByKey(conversationKey, {
    fileWorkspace: workspace,
    ...extraPatch,
  }).fileWorkspace);
}

function normalizePersistedWorkspace(value) {
  return {
    openPaths: Array.isArray(value?.openPaths) ? value.openPaths : [],
    activePath: typeof value?.activePath === "string" ? value.activePath : "",
    activeScrollTop: clampScrollTop(value?.activeScrollTop),
    leftMode: normalizeLeftMode(value?.leftMode),
    previewViewByPath: normalizePreviewViewByPath(value?.previewViewByPath ?? value?.markdownViewByPath),
    sidebarOpen: value?.sidebarOpen === true,
    width: clampWidth(value?.width),
    treeCollapsed: value?.treeCollapsed === true,
    editorCollapsed: false,
    treeHeight: clampTreeHeight(value?.treeHeight),
    annotations: Array.isArray(value?.annotations) ? value.annotations : [],
    mediaNotes: Array.isArray(value?.mediaNotes) ? value.mediaNotes : [],
  };
}

function normalizePreviewViewByPath(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = [];
  for (const [filePath, mode] of Object.entries(value)) {
    if (entries.length >= 200) break;
    if (typeof filePath !== "string" || !filePath) continue;
    if (mode !== "raw" && mode !== "rendered") continue;
    entries.push([filePath, mode]);
  }
  return Object.fromEntries(entries);
}

function clampWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 476;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(number)));
}

function clampTreeHeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 257;
  const rounded = Math.round(number);
  // Migrate previous untouched defaults while preserving genuinely customized
  // pane widths. 257px is 35% wider than the former 190px default.
  if (rounded === 280 || rounded === 224 || rounded === 190) return 257;
  return Math.max(120, Math.min(720, rounded));
}

function clampScrollTop(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(10_000_000, Math.round(number));
}

function normalizeLeftMode(value) {
  return new Set(["files", "git", "search"]).has(value) ? value : "files";
}

function statusForWorkspaceError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/outside|protected path|authorized roots/i.test(message)) return 403;
  if (/ENOENT|not a file/i.test(message)) return 404;
  if (/exceeds/i.test(message)) return 413;
  return 400;
}
