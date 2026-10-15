import fs from "node:fs";
import path from "node:path";
import { SKILL_ROOTS, updateConversationStateByKey } from "./config.js";
import { resolveBrowserThreadState } from "./local-todos.js";
import { discoverSkills } from "../tools/skills.js";

const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const MAX_ATTACHED_SKILLS = 12;
const MAX_SKILL_BYTES = 1024 * 1024;

export function registerLocalSkillRoutes(app) {
  app.post("/local-ui/skills", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const action = String(req.body?.action || "search").trim().toLowerCase();
      const threadId = typeof req.body?.threadId === "string" ? req.body.threadId.trim() : "";
      const resolved = threadId
        ? resolveBrowserThreadState(threadId)
        : { bound: false, state: null, conversationKey: null };
      const projectWorkspace = resolved.bound && typeof resolved.state?.currentWorkspace === "string"
        ? resolved.state.currentWorkspace
        : "";

      if (action === "search") {
        const query = typeof req.body?.query === "string" ? req.body.query.slice(0, 500) : "";
        const result = discoverSkills({
          roots: SKILL_ROOTS,
          projectWorkspace,
          query,
        });

        return res.set("Cache-Control", "no-store").json({
          ok: true,
          bound: resolved.bound,
          total: result.total,
          skills: result.skills.map(({ name, description, scope }) => ({ name, description, scope })),
        });
      }

      if (action === "attach" && !resolved.bound) {
        const attachment = resolveSkillAttachment(req.body?.name, "");
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          bound: false,
          ephemeral: true,
          attachments: [attachment],
          updatedAt: null,
        });
      }

      if (!resolved.bound) {
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          bound: false,
          attachments: [],
          updatedAt: null,
        });
      }

      const existing = normalizeAttachedSkillRefs(resolved.state?.attachedSkills);
      let attachedRefs = existing;

      if (action === "attach") {
        const attachment = resolveSkillAttachment(req.body?.name, projectWorkspace);
        attachedRefs = [
          ...existing.filter((item) => item.path !== attachment.path),
          { name: attachment.name, path: attachment.path },
        ];
        if (attachedRefs.length > MAX_ATTACHED_SKILLS) {
          throw new Error(`attached skill limit is ${MAX_ATTACHED_SKILLS}`);
        }
      } else if (action === "delete") {
        const targetPath = String(req.body?.path || "").trim();
        const targetName = String(req.body?.name || "").trim().toLowerCase();
        if (!targetPath && !targetName) throw new Error("skill path or name is required");
        attachedRefs = existing.filter((item) => {
          if (targetPath && item.path === targetPath) return false;
          if (targetName && item.name.toLowerCase() === targetName) return false;
          return true;
        });
      } else if (action === "clear") {
        attachedRefs = [];
      } else if (action !== "list") {
        throw new Error("skill action must be search, list, attach, delete, or clear");
      }

      let state = resolved.state;
      if (action !== "list") {
        state = updateConversationStateByKey(resolved.conversationKey, { attachedSkills: attachedRefs });
      }

      const attachments = hydrateAttachedSkills(attachedRefs, projectWorkspace);
      // If a skill was removed or moved on disk, do not keep a stale reference
      // indefinitely. This also ensures every returned attachment still belongs
      // to one of the currently registered skill roots.
      if (attachments.length !== attachedRefs.length) {
        const prunedRefs = attachments.map(({ name, path: skillPath }) => ({ name, path: skillPath }));
        state = updateConversationStateByKey(resolved.conversationKey, { attachedSkills: prunedRefs });
      }

      return res.set("Cache-Control", "no-store").json({
        ok: true,
        bound: true,
        attachments,
        updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /limit|exceeds/i.test(message) ? 413 : /not found|unavailable/i.test(message) ? 404 : 400;
      return res.status(status).set("Cache-Control", "no-store").json({
        error: message,
      });
    }
  });
}

function normalizeAttachedSkillRefs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = String(item.name || "").trim();
    const skillPath = String(item.path || "").trim();
    if (!name || name.length > 256 || !path.isAbsolute(skillPath) || skillPath.length > 8_192) continue;
    if (seen.has(skillPath)) continue;
    seen.add(skillPath);
    normalized.push({ name, path: skillPath });
    if (normalized.length >= MAX_ATTACHED_SKILLS) break;
  }
  return normalized;
}

function resolveSkillAttachment(nameInput, projectWorkspace) {
  const requestedName = String(nameInput || "").trim();
  if (!requestedName || requestedName.length > 256) throw new Error("skill name is required");

  const result = discoverSkills({
    roots: SKILL_ROOTS,
    projectWorkspace,
    query: requestedName,
  });
  const requestedLower = requestedName.toLowerCase();
  const skill = result.skills.find((item) => String(item.name || "").toLowerCase() === requestedLower);
  if (!skill?.path) throw new Error(`skill not found: ${requestedName}`);
  return readSkillAttachment(skill);
}

function hydrateAttachedSkills(refs, projectWorkspace) {
  const hydrated = [];
  for (const ref of refs) {
    try {
      const result = discoverSkills({
        roots: SKILL_ROOTS,
        projectWorkspace,
        query: ref.name,
      });
      const candidate = result.skills.find((item) => {
        if (!item?.path) return false;
        const skillFile = path.resolve(item.path, "SKILL.md");
        return skillFile === path.resolve(ref.path);
      });
      if (!candidate) continue;
      hydrated.push(readSkillAttachment(candidate));
    } catch {
      // A disappeared, unreadable, or no-longer-registered skill is pruned by
      // the caller rather than leaking a stale filesystem reference to the UI.
    }
  }
  return hydrated;
}

function readSkillAttachment(skill) {
  const skillFile = path.resolve(skill.path, "SKILL.md");
  const stat = fs.statSync(skillFile);
  if (!stat.isFile()) throw new Error(`skill is unavailable: ${skill.name}`);
  if (stat.size > MAX_SKILL_BYTES) throw new Error(`skill exceeds ${Math.round(MAX_SKILL_BYTES / 1024)} KiB limit`);
  const contents = fs.readFileSync(skillFile, "utf8");
  return {
    name: String(skill.name || path.basename(skill.path)),
    path: skillFile,
    scope: skill.scope || "personal",
    reference: `[$${String(skill.name || path.basename(skill.path))}](${skillFile})`,
    contents,
  };
}
