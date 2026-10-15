import fs from "node:fs";
import path from "node:path";
import {
  GLOBAL_AGENT_DOC_PATH,
  MAX_PROJECT_DOC_BYTES,
  MEMORY_ROOT,
  PROJECT_DOC_FILENAMES,
  PROJECT_MEMORY_FILENAME,
} from "./config.js";
import { skillNameIndex } from "../tools/skills.js";

// What an agent needs on entering a project and cannot infer from tool schemas:
// the project's own instructions, and what skills exist. Built in one place so
// bridge_context and workspace=open can never disagree about project state.

function clipUtf8(raw, maxBytes) {
  const buffer = Buffer.from(raw, "utf8");
  if (buffer.byteLength <= maxBytes) return { text: raw, truncated: false };
  // Decode non-fatally so a split multi-byte character cannot corrupt output,
  // then drop the replacement character it leaves behind.
  const decoded = new TextDecoder("utf8").decode(buffer.subarray(0, maxBytes));
  return { text: `${decoded.replace(/�+$/, "")}\n… truncated …`, truncated: true };
}

export function readGlobalAgentDoc(filePath = GLOBAL_AGENT_DOC_PATH) {
  if (!filePath) return null;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const { text, truncated } = clipUtf8(fs.readFileSync(filePath, "utf8"), MAX_PROJECT_DOC_BYTES);
  return { path: filePath, name: path.basename(filePath), content: text, truncated };
}

// Matched case-insensitively so AGENTS.md, agents.md and Agents.md all resolve,
// on case-sensitive filesystems too.
export function readProjectDoc(workspacePath) {
  if (!workspacePath) return null;
  let entries;
  try {
    entries = fs.readdirSync(workspacePath, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const wanted of PROJECT_DOC_FILENAMES) {
    const target = wanted.toLowerCase();
    const match = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === target);
    if (!match) continue;
    try {
      const raw = fs.readFileSync(path.join(workspacePath, match.name), "utf8");
      const { text, truncated } = clipUtf8(raw, MAX_PROJECT_DOC_BYTES);
      return { name: match.name, content: text, truncated };
    } catch {
      return null;
    }
  }
  return null;
}

export function readProjectMemory(workspacePath) {
  if (!workspacePath) return null;
  let entries;
  try {
    entries = fs.readdirSync(workspacePath, { withFileTypes: true });
  } catch {
    return null;
  }
  const target = PROJECT_MEMORY_FILENAME.toLowerCase();
  const match = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === target);
  if (!match) return null;
  try {
    const raw = fs.readFileSync(path.join(workspacePath, match.name), "utf8");
    const { text, truncated } = clipUtf8(raw, MAX_PROJECT_DOC_BYTES);
    return { name: match.name, content: text, truncated };
  } catch {
    return null;
  }
}

export function projectOrientation(workspacePath = "") {
  return {
    globalAgentDoc: readGlobalAgentDoc(),
    memory: {
      root: MEMORY_ROOT,
      accountsFile: path.join(MEMORY_ROOT, "accounts.md"),
    },
    // null when the project has no instructions file of its own.
    projectDoc: readProjectDoc(workspacePath),
    // null when the project has no MEMORY.md of its own.
    projectMemory: readProjectMemory(workspacePath),
    skills: skillNameIndex({ projectWorkspace: workspacePath || "" }),
  };
}
