import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configuredProjectRoots, currentScratchDir, loadState, saveState, updateConversationState } from "../lib/config.js";
import { currentConversationId } from "../lib/conversation.js";
import { projectOrientation } from "../lib/orientation.js";
import { assertInProjectRoots, canonicalPath, currentProjectWorkspace, resolveUserPath } from "../lib/paths.js";
import { fail, structured } from "../lib/text.js";

const WORKSPACE_ACTIONS = ["list", "save", "open"];

export function registerWorkspace(server) {
  server.registerTool("workspace", {
    title: "Workspace",
    description: "List saved projects, save a shortcut, or select this conversation's project.",
    inputSchema: {
      action: z.enum(WORKSPACE_ACTIONS),
      path: z.string().optional().describe("Required for save/open."),
      name: z.string().min(1).max(120).optional().describe("For save; defaults to the directory name."),
      description: z.string().max(500).optional().describe("For save."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ action, path: input, name, description }) => {
    try {
      if (action === "list") return listWorkspaces();
      if (action === "save") return saveProject({ input, name, description });
      if (action === "open") return openWorkspace(input);
      return fail(`unsupported workspace action: ${action}`);
    } catch (error) {
      return fail(error.message);
    }
  });
}

function listWorkspaces() {
  const state = loadState();
  const data = {
    currentProjectWorkspace: currentProjectWorkspace() || null,
    savedProjects: normalizeProjects(state.savedProjects),
    authorizedProjectRoots: configuredProjectRoots(),
    localScratchDir: currentScratchDir(),
  };
  return structured("Workspace context returned.", data);
}

function saveProject({ input, name, description }) {
  if (!input) return fail("path is required for workspace action=save");
  const requested = resolveUserPath(input);
  let resolved;
  try {
    resolved = canonicalPath(assertInProjectRoots(requested));
  } catch (error) {
    return fail(`WORKSPACE SAVE BLOCKED: ${error.message}`);
  }
  if (!fs.statSync(resolved).isDirectory()) return fail(`${resolved} is not a directory`);

  const state = loadState();
  const savedProjects = normalizeProjects(state.savedProjects);
  const record = {
    name: name?.trim() || path.basename(resolved) || resolved,
    path: resolved,
    ...(description?.trim() ? { description: description.trim() } : {}),
  };
  const index = savedProjects.findIndex((item) => item.path === resolved);
  if (index >= 0) savedProjects[index] = record;
  else savedProjects.push(record);
  state.savedProjects = savedProjects.sort((a, b) => a.name.localeCompare(b.name));
  saveState(state);
  return structured(`Saved workspace ${record.name}.`, { savedProject: record, savedProjects: state.savedProjects });
}

function openWorkspace(input) {
  if (!input) return fail("path is required for workspace action=open");
  const resolved = canonicalPath(assertInProjectRoots(resolveUserPath(input)));
  if (!fs.statSync(resolved).isDirectory()) return fail(`${resolved} is not a directory`);
  const state = loadState();
  const previousWorkspace = state.currentWorkspace || "";
  state.currentWorkspace = resolved;
  saveState(state);
  if (currentConversationId()) {
    updateConversationState({
      workspaceSelection: {
        source: "agent",
        changedAt: new Date().toISOString(),
        previousWorkspace: previousWorkspace || null,
      },
    });
  }
  const saved = normalizeProjects(state.savedProjects).find((item) => item.path === resolved);
  const label = saved ? `${saved.name} (${resolved})` : resolved;
  // Opening a project is the moment its instructions and skills become
  // knowable, and it is now mandatory before any project work.
  return structured(`current project workspace = ${label}`, {
    currentProjectWorkspace: resolved,
    ...projectOrientation(resolved),
  });
}

function normalizeProjects(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.path === "string" && typeof item.name === "string")
    .filter((item) => {
      try { return Boolean(assertInProjectRoots(item.path)); }
      catch { return false; }
    })
    .map((item) => ({ name: item.name, path: item.path, ...(item.description ? { description: item.description } : {}) }));
}
