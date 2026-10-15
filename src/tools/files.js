import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTwoFilesPatch } from "diff";
import { MAX_STDERR_CHARS, STATE_DIR } from "../lib/config.js";
import { runCommand } from "../lib/exec.js";
import { cloudPreviewOrigin, createS3Preview } from "../lib/cloud-preview.js";
import { parsePorcelainV1Z } from "../lib/local-git.js";
import { destructiveApprovalFailure, recordDestructiveExecution, requestDestructiveApproval } from "../lib/policy.js";
import { assertInWorkspace, currentProjectWorkspace, isWithin, requireCurrentProjectWorkspace, resolveUserPath } from "../lib/paths.js";
import { isMalformedPatchError, patchFailureContext, renderPatchFailure } from "../lib/patch-feedback.js";
import { detectCommandCached } from "./project.js";
import { clip, fail, ok, structured } from "../lib/text.js";
import { registerOptionalAppTool } from "../lib/tool-ui.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE_CONTENT_RESOURCE_TEMPLATE = "preview://sol/{token}";
const PREVIEW_TTL_MS = 10 * 60 * 1_000;
const MAX_PREVIEW_TICKETS = 64;
const MAX_DISPLAY_FILE_PATHS = 20;
const MAX_DISPLAY_CONTENT_CHARS = 2_000_000;
const MAX_DISPLAY_DIFF_BYTES = 6 * 1024 * 1024;
const MAX_DISPLAY_TICKETS = 64;
const DISPLAY_RESUME_TTL_MS = 2 * 24 * 60 * 60 * 1_000;
const MAX_VIEW_IMAGE_RESULTS = 3;
const MAX_VIEW_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_FULL_BINARY_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_BINARY_SAMPLE_BYTES = 64 * 1024;
const previewTickets = new Map();
const displayTickets = new Map();
const previewResumeSecret = loadOrCreatePreviewResumeSecret();
const previewResumeKey = crypto.createHash("sha256").update(`local-system:file-preview:${previewResumeSecret}`).digest();
const displayResumeKey = crypto.createHash("sha256").update(`local-system:display-preview:${previewResumeSecret}`).digest();
const DISPLAY_HTML = fs.readFileSync(path.resolve(here, "../apps/file-preview.html"), "utf8");
const DISPLAY_RESOURCE_URI = `ui://sol/display-${crypto.createHash("sha256")
  .update(`${DISPLAY_HTML}\ncloud-origin:${cloudPreviewOrigin()}`)
  .digest("hex")
  .slice(0, 12)}.html`;
const APPLY_PATCH_HTML = fs.readFileSync(path.resolve(here, "../apps/apply-patch.html"), "utf8");
const APPLY_PATCH_RESOURCE_URI = `ui://sol/apply-patch-${crypto.createHash("sha256").update(APPLY_PATCH_HTML).digest("hex").slice(0, 12)}.html`;

// A failed patch must carry what the file actually contains, so the agent can
// correct it from this response instead of reading the file in another turn.
function patchFailure(error, diff, root) {
  const files = patchFailureContext(diff, root);
  const data = { status: "failed", cwd: root, error, malformed: isMalformedPatchError(error), diff, files };
  const text = `${clip(renderPatchFailure(error, files), MAX_STDERR_CHARS)}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return {
    content: [{ type: "text", text: clip(text) }],
    isError: true,
  };
}

export function registerFiles(server) {

  server.registerTool("view_image", {
    title: "View image",
    description: "See an image or an ordered batch of local images.",
    inputSchema: {
      paths: z.array(z.string().trim().min(1)).min(1)
        .describe("Image paths, in order."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    try {
      const normalized = normalizePathInput(input, "view_image");
      if (normalized.error) return fail(normalized.error);
      const requested = normalized.paths;
      const selected = requested.slice(0, MAX_VIEW_IMAGE_RESULTS);
      const images = [];
      for (const [index, inputPath] of selected.entries()) {
        const resolved = assertInWorkspace(resolveUserPath(inputPath));
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) return fail(`view_image path ${index + 1} is not a file: ${resolved}`);
        if (stat.size > MAX_VIEW_IMAGE_BYTES) {
          return fail(`view_image path ${index + 1} is too large (${stat.size} bytes; maximum ${MAX_VIEW_IMAGE_BYTES} bytes)`);
        }
        const data = fs.readFileSync(resolved);
        const mimeType = detectModelImageMimeType(data);
        if (!mimeType) return fail(`view_image path ${index + 1} supports JPEG, PNG, WebP, and GIF image files only`);
        images.push({
          name: path.basename(resolved),
          displayPath: displayPathForPreview(resolved),
          bytes: stat.size,
          data: data.toString("base64"),
          mimeType,
        });
      }
      if (images.length === 1 && requested.length === 1) {
        const image = images[0];
        return {
          content: [
            { type: "text", text: `Viewing ${image.name} (${image.mimeType}, ${image.bytes} bytes)` },
            { type: "image", data: image.data, mimeType: image.mimeType },
          ],
        };
      }

      const remaining = requested.length - images.length;
      const summary = remaining > 0
        ? `Viewing the first ${images.length} of ${requested.length} requested images. ${remaining} ${remaining === 1 ? "image was" : "images were"} not returned; call view_image again with the remaining ${remaining === 1 ? "path" : "paths"}.`
        : `Viewing ${images.length} requested images.`;
      const content = [{ type: "text", text: summary }];
      for (const [index, image] of images.entries()) {
        content.push(
          { type: "text", text: `Image ${index + 1} of ${images.length}: ${image.displayPath} (${image.mimeType}, ${image.bytes} bytes)` },
          { type: "image", data: image.data, mimeType: image.mimeType },
        );
      }
      return {
        content,
      };
    } catch (error) {
      return fail(error.message);
    }
  });

  registerOptionalAppTool(server, "display", {
    title: "Display",
    description: "Show local files to the user when requested, especially generated HTML artifacts. File type chooses the presentation automatically.",
    inputSchema: {
      path: z.union([
        z.string().trim().min(1),
        z.array(z.string().trim().min(1)).min(1).max(MAX_DISPLAY_FILE_PATHS),
      ]).optional()
        .describe("Local file path or paths to show. HTML and Markdown files are rendered automatically."),
      changes: z.boolean().optional()
        .describe("Show Git changes for the listed path or paths instead of opening them. With no path, use the current project."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, DISPLAY_RESOURCE_URI, async (input) => {
    try {
      if (input.changes === true) return await createChangesDisplayResult(input);
      return await createFileDisplayResult(input);
    } catch (error) {
      return fail(error.message);
    }
  });

  registerAppTool(server, "load_display_content", {
    title: "Load display content",
    description: "Load content for the active Display UI.",
    inputSchema: {
      token: z.string().regex(/^[A-Za-z0-9_-]{20,}$/),
    },
    _meta: { ui: { visibility: ["app"] } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ token }) => {
    try {
      cleanupDisplayTickets();
      const ticket = displayTickets.get(token);
      if (!ticket || ticket.expiresAt <= Date.now()) {
        displayTickets.delete(token);
        return fail("display content is unknown or expired; run display again");
      }
      return {
        content: [{ type: "text", text: ticket.content }],
      };
    } catch (error) {
      return fail(error.message);
    }
  });

  registerAppTool(server, "refresh_display_content", {
    title: "Refresh display content",
    description: "Refresh an expired Display session.",
    inputSchema: {
      resumeToken: z.string().regex(/^[A-Za-z0-9_-]{40,}$/),
    },
    _meta: { ui: { visibility: ["app"] } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ resumeToken }) => {
    try {
      const source = resolveDisplayResumeToken(resumeToken);
      if (source.type === "html") {
        const resolved = assertInWorkspace(source.path);
        return createDocumentDisplayResult(resolved, "html", { resumeToken });
      }
      if (source.type === "changes") {
        const inputPath = source.paths.length === 1 ? source.paths[0] : source.paths;
        return await createChangesDisplayResult({ changes: true, path: inputPath }, { resumeToken });
      }
      return fail("display session cannot be refreshed; run display again");
    } catch (error) {
      return fail(error.message);
    }
  });

  registerAppTool(server, "refresh_preview_file", {
    title: "Refresh file preview",
    description: "Refresh an expired preview session.",
    inputSchema: {
      resumeToken: z.string().regex(/^[A-Za-z0-9_-]{40,}$/),
    },
    _meta: { ui: { visibility: ["app"] } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ resumeToken }) => {
    try {
      const resolved = resolvePreviewResumeToken(resumeToken);
      return await createPreviewResult(resolved, { resumeToken });
    } catch (error) {
      return fail(error.message);
    }
  });

  registerAppTool(server, "get_cloud_preview_url", {
    title: "Get cloud preview URL",
    description: "Return the preview's short-lived cloud URL.",
    inputSchema: {
      token: z.string().regex(/^[A-Za-z0-9_-]{20,}$/),
    },
    _meta: { ui: { visibility: ["app"] } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ token }) => {
    try {
      cleanupPreviewTickets(previewTickets);
      const ticket = previewTickets.get(token);
      if (!ticket) return fail("cloud preview token is unknown or expired; run display again");
      if (ticket.expiresAt <= Date.now()) {
        previewTickets.delete(token);
        return fail("cloud preview token expired; run display again");
      }
      if (!ticket.cloud?.url) return fail("cloud preview is unavailable; use the local preview fallback");
      if (ticket.cloud.expiresAt <= Date.now()) return fail("cloud preview URL expired; run display again");
      return { content: [{ type: "text", text: ticket.cloud.url }] };
    } catch (error) {
      return fail(error.message);
    }
  });

  registerAppTool(server, "load_preview_file", {
    title: "Load file preview content",
    description: "Load preview bytes for the UI.",
    inputSchema: {
      token: z.string().regex(/^[A-Za-z0-9_-]{20,}$/),
    },
    _meta: { ui: { visibility: ["app"] } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ token }) => {
    try {
      cleanupPreviewTickets(previewTickets);
      const ticket = previewTickets.get(token);
      if (!ticket) return fail("preview token is unknown or expired; run display again");
      if (ticket.expiresAt <= Date.now()) {
        previewTickets.delete(token);
        return fail("preview token expired; run display again");
      }

      const resolved = assertInWorkspace(ticket.path);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return fail("preview source is no longer a file");
      if (ticket.maxBytes <= 0) return fail("this file exceeds the safe inline preview limit");

      const current = previewDescriptor(resolved);
      const maxBytes = Math.max(0, Math.min(ticket.maxBytes, stat.size));
      const data = readPrefix(resolved, maxBytes);
      const mimeType = current.mimeType || ticket.mimeType || "application/octet-stream";

      if (["text", "code", "markdown"].includes(current.category)) {
        return { content: [{ type: "text", text: data.toString("utf8") }] };
      }
      if (current.category === "image") {
        return { content: [{ type: "image", data: data.toString("base64"), mimeType }] };
      }
      if (current.category === "audio") {
        return { content: [{ type: "audio", data: data.toString("base64"), mimeType }] };
      }
      return {
        content: [{
          type: "resource",
          resource: {
            uri: `preview://sol/${token}`,
            mimeType,
            blob: data.toString("base64"),
          },
        }],
      };
    } catch (error) {
      return fail(error.message);
    }
  });

  registerAppTool(server, "open_preview_file", {
    title: "Open file on device",
    description: "Open the previewed file with the OS.",
    inputSchema: {
      token: z.string().regex(/^[A-Za-z0-9_-]{20,}$/),
    },
    _meta: { ui: { visibility: ["app"] } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ token }) => {
    try {
      cleanupPreviewTickets(previewTickets);
      const ticket = previewTickets.get(token);
      if (!ticket) return fail("file-open token is unknown or expired; run display again");
      if (ticket.expiresAt <= Date.now()) {
        previewTickets.delete(token);
        return fail("file-open token expired; run display again");
      }
      const resolved = assertInWorkspace(ticket.path);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return fail("preview source is no longer a file");
      openInDefaultApplication(resolved);
      return ok(`opened ${path.basename(resolved)}`);
    } catch (error) {
      return fail(error.message);
    }
  });


  registerOptionalAppTool(server, "apply_patch", {
    title: "Apply patch",
    description: "Create or edit text files.",
    inputSchema: {
      input: z.string().min(1).max(500_000).describe("Patch text; prefer *** Begin Patch."),
      cwd: z.string().optional().describe("Defaults to the current project; pass localScratchDir for non-project work."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, APPLY_PATCH_RESOURCE_URI, async ({ input, cwd }, extra) => {
    let destructiveApproval = null;
    try {
      const root = assertInWorkspace(cwd ? resolveUserPath(cwd) : requireCurrentProjectWorkspace(), { write: true });
      const diff = normalizePatchInput(input, root);
      if (patchDeletesFile(diff)) {
        destructiveApproval = await requestDestructiveApproval({
          kind: "apply_patch_delete",
          summary: "patch would delete one or more files",
          cwd: root,
          diff,
          diffPreview: diff.slice(0, 4_000),
        }, extra);
        if (!destructiveApproval.approved) return fail(destructiveApprovalFailure(destructiveApproval));
      }
      const gitApply = ["git", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "apply"];
      const check = await runCommand([...gitApply, "--check", "--whitespace=nowarn", "-"], { cwd: root, shell: false, stdin: diff, signal: extra?.signal });
      if (!check.ok) {
        recordDestructiveExecution(destructiveApproval, { ok: false, code: check.code });
        return patchFailure(check.stderr || check.stdout || "git apply --check failed", diff, root);
      }
      const result = await runCommand([...gitApply, "--whitespace=nowarn", "-"], { cwd: root, shell: false, stdin: diff, signal: extra?.signal });
      recordDestructiveExecution(destructiveApproval, { ok: result.ok, code: result.code });
      if (!result.ok) return patchFailure(result.stderr || result.stdout || "git apply failed", diff, root);
      const verifyWith = detectCommandCached(root, "test");
      return structured(
        verifyWith ? `Patch applied. Verify with: ${verifyWith}` : "Patch applied.",
        { status: "applied", cwd: root, diff, ...(verifyWith ? { verifyWith } : {}) },
      );
    } catch (error) {
      recordDestructiveExecution(destructiveApproval, { error: error.message });
      return fail(error.message);
    }
  });

  registerAppResource(server, "Apply Patch Diff", APPLY_PATCH_RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: APPLY_PATCH_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: APPLY_PATCH_HTML }],
  }));


  registerAppResource(server, "Display", DISPLAY_RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    const origin = cloudPreviewOrigin();
    return {
      contents: [{
        uri: DISPLAY_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: DISPLAY_HTML,
        ...(origin ? {
          _meta: {
            ui: {
              csp: {
                resourceDomains: [origin],
                connectDomains: [origin],
              },
            },
          },
        } : {}),
      }],
    };
  });

  server.registerResource(
    "Preview file content",
    new ResourceTemplate(FILE_CONTENT_RESOURCE_TEMPLATE, { list: undefined }),
    {},
    async (uri, variables) => {
      cleanupPreviewTickets(previewTickets);
      const token = String(variables.token || "");
      const ticket = previewTickets.get(token);
      if (!ticket) throw new Error("preview resource is unknown or expired");
      if (ticket.expiresAt <= Date.now()) {
        previewTickets.delete(token);
        throw new Error("preview resource expired; run display again");
      }

      const resolved = assertInWorkspace(ticket.path);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new Error("preview source is no longer a file");
      const current = previewDescriptor(resolved);
      const maxBytes = Math.max(0, Math.min(ticket.maxBytes, stat.size));
      const data = readPrefix(resolved, maxBytes);
      const mimeType = current.mimeType || ticket.mimeType || "application/octet-stream";

      if (["text", "code", "markdown"].includes(current.category)) {
        return { contents: [{ uri: uri.href, mimeType, text: data.toString("utf8") }] };
      }
      return { contents: [{ uri: uri.href, mimeType, blob: data.toString("base64") }] };
    },
  );
}

export function patchDeletesFile(diff) {
  return /^deleted file mode\b/m.test(diff)
    || /^\+\+\+\s+\/dev\/null\b/m.test(diff)
    || /^\+\+\+\s+NUL\b/im.test(diff);
}

export function normalizePatchInput(input, root) {
  const text = String(input || "").replace(/\r\n/g, "\n");
  const common = text.trim();
  if (!common.startsWith("*** Begin Patch")) return text;
  return commonPatchToUnified(common, root);
}

function commonPatchToUnified(input, root) {
  const lines = input.split("\n");
  if (lines.shift()?.trim() !== "*** Begin Patch") throw new Error("patch must start with *** Begin Patch");
  const chunks = [];
  const virtualFiles = new Map();
  let ended = false;

  while (lines.length) {
    const line = lines.shift();
    if (line === "*** End Patch") { ended = true; break; }
    if (!line?.trim()) continue;
    const match = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (!match) throw new Error(`unsupported patch directive: ${line}`);
    const [, action, rawPath] = match;
    const target = resolveCommonPatchTarget(root, rawPath, { mustExist: action !== "Add" });
    const body = [];
    while (lines.length && !lines[0].startsWith("*** ")) body.push(lines.shift());

    if (action === "Add") {
      if (fs.existsSync(target.resolved) || virtualFiles.has(target.resolved)) throw new Error(`patch add target already exists: ${target.relative}`);
      const contentLines = body.filter((item) => item !== "");
      if (contentLines.some((item) => !item.startsWith("+"))) throw new Error(`add-file patch lines must start with +: ${target.relative}`);
      const content = contentLines.map((item) => item.slice(1)).join("\n") + (contentLines.length ? "\n" : "");
      virtualFiles.set(target.resolved, content);
      chunks.push(createAddFileDiff(target.relative, content));
      continue;
    }

    const current = virtualFiles.has(target.resolved)
      ? virtualFiles.get(target.resolved)
      : fs.readFileSync(target.resolved, "utf8");

    if (action === "Delete") {
      if (body.some((item) => item.trim())) throw new Error(`delete-file patch does not accept body lines: ${target.relative}`);
      virtualFiles.set(target.resolved, null);
      chunks.push(createDeleteFileDiff(target.relative, current));
      continue;
    }

    const next = applyCommonUpdate(current, body, target.relative);
    virtualFiles.set(target.resolved, next);
    chunks.push(createTwoFilesPatch(`a/${target.relative}`, `b/${target.relative}`, current, next, "", "", { context: 3 }));
  }

  if (!ended) throw new Error("patch must end with *** End Patch");
  if (lines.some((line) => line.trim())) throw new Error("unexpected content after *** End Patch");
  if (!chunks.length) throw new Error("patch contains no file operations");
  return chunks.join("");
}

function resolveCommonPatchTarget(root, rawPath, { mustExist }) {
  const canonicalRoot = fs.realpathSync.native(root);
  const requested = rawPath.trim();
  if (!requested || path.isAbsolute(requested)) throw new Error(`patch paths must be relative to cwd: ${requested || "<empty>"}`);
  const resolved = assertInWorkspace(path.resolve(canonicalRoot, requested), { write: true });
  const relative = path.relative(canonicalRoot, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`patch path escapes cwd: ${requested}`);
  }
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`patch target does not exist: ${relative}`);
  return { resolved, relative: relative.split(path.sep).join("/") };
}

function applyCommonUpdate(current, body, relative) {
  const working = splitPatchText(current);
  const hunks = [];
  let active = null;
  for (const line of body) {
    if (line.startsWith("@@")) {
      active = [];
      hunks.push(active);
      continue;
    }
    if (line === "\\ No newline at end of file") continue;
    if (!active) {
      if (!line.trim()) continue;
      active = [];
      hunks.push(active);
    }
    if (!/^[ +-]/.test(line)) throw new Error(`invalid update patch line for ${relative}: ${line}`);
    active.push(line);
  }
  if (!hunks.length) throw new Error(`update patch contains no hunks: ${relative}`);

  let cursor = 0;
  for (const hunk of hunks) {
    const oldLines = hunk.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
    const newLines = hunk.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
    if (!oldLines.length) throw new Error(`update hunk needs context or removed lines: ${relative}`);
    let index = findLineSequence(working.lines, oldLines, cursor);
    if (index < 0 && cursor > 0) index = findLineSequence(working.lines, oldLines, 0);
    if (index < 0) throw new Error(`patch context not found in ${relative}`);
    working.lines.splice(index, oldLines.length, ...newLines);
    cursor = index + newLines.length;
  }
  return joinPatchText(working.lines, working.finalNewline);
}

function splitPatchText(text) {
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body ? body.split("\n") : [], finalNewline };
}

function joinPatchText(lines, finalNewline) {
  if (!lines.length) return finalNewline ? "\n" : "";
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

function findLineSequence(lines, needle, start) {
  outer: for (let index = Math.max(0, start); index <= lines.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function createAddFileDiff(relative, content) {
  const lines = splitPatchText(content).lines;
  const header = `diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n`;
  if (!lines.length) return header;
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

function createDeleteFileDiff(relative, content) {
  const lines = splitPatchText(content).lines;
  const header = `diff --git a/${relative} b/${relative}\ndeleted file mode 100644\n--- a/${relative}\n+++ /dev/null\n`;
  if (!lines.length) return header;
  return `${header}@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join("\n")}\n`;
}

async function createFileDisplayResult(input) {
  const unique = normalizeDisplayPaths(input.path);
  if (!unique.length) return fail("display requires a file path");
  const resolved = unique.map((inputPath) => assertInWorkspace(resolveUserPath(inputPath)));
  if (resolved.length === 1) {
    const documentType = displayDocumentType(resolved[0]);
    if (documentType) return createDocumentDisplayResult(resolved[0], documentType);
    return await createPreviewResult(resolved[0]);
  }
  return await createPreviewSetResult(resolved);
}

async function createChangesDisplayResult(input, { resumeToken = null } = {}) {
  const requested = normalizeDisplayPaths(input.path);
  const resolvedRequested = requested.map((inputPath) => (
    assertInWorkspace(resolveUserPath(inputPath), { write: true })
  ));
  const workspaceRoot = requested.length
    ? resolvedRequested[0]
    : assertInWorkspace(requireCurrentProjectWorkspace());
  const resumePaths = requested.length ? resolvedRequested : [workspaceRoot];
  const durableResumeToken = resumeToken || createDisplayResumeToken({
    type: "changes",
    paths: resumePaths,
  });
  let gitCwd = workspaceRoot;
  try {
    if (!fs.statSync(gitCwd).isDirectory()) gitCwd = path.dirname(gitCwd);
  } catch {
    gitCwd = path.dirname(gitCwd);
  }

  const repoResult = await runCommand(
    ["git", "-C", gitCwd, "rev-parse", "--show-toplevel"],
    { cwd: gitCwd, shell: false, maxStdout: 32_000, maxStderr: 32_000 },
  );
  if (!repoResult.ok) return fail("display changes requires a Git repository");

  const repoRoot = assertInWorkspace(String(repoResult.stdout || "").trim());
  const scopes = requested.length
    ? [...new Set(resolvedRequested.map((resolved) => {
      if (!isWithin(resolved, repoRoot)) {
        throw new Error(`display changes paths must belong to the same Git repository: ${resolved}`);
      }
      return path.relative(repoRoot, resolved).split(path.sep).join("/") || ".";
    }))]
    : [path.relative(repoRoot, workspaceRoot).split(path.sep).join("/") || "."];
  const statusResult = await runCommand(
    ["git", "-C", repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=dirty", "--", ...scopes],
    { cwd: repoRoot, shell: false, maxStdout: MAX_DISPLAY_DIFF_BYTES, maxStderr: 32_000 },
  );
  if (!statusResult.ok) return fail(statusResult.stderr || "could not read Git changes");

  const entries = parsePorcelainV1Z(statusResult.stdout);
  const branchResult = await runCommand(
    ["git", "-C", repoRoot, "symbolic-ref", "--short", "-q", "HEAD"],
    { cwd: repoRoot, shell: false, maxStdout: 8_000, maxStderr: 8_000 },
  );
  const headResult = await runCommand(
    ["git", "-C", repoRoot, "rev-parse", "--verify", "HEAD"],
    { cwd: repoRoot, shell: false, maxStdout: 8_000, maxStderr: 8_000 },
  );
  const branch = String(branchResult.stdout || "").trim() || (headResult.ok ? "detached" : "unborn");
  const title = `Changes · ${path.basename(repoRoot)}`;

  if (!entries.length) {
    return displayToolResult("Prepared a clean working-tree display.", {
      kind: "display",
      type: "changes",
      title,
      branch,
      clean: true,
      files: [],
      truncated: false,
      resumeToken: durableResumeToken,
    });
  }

  const trackedArgs = headResult.ok
    ? ["git", "-C", repoRoot, "diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=3", "HEAD", "--", ...scopes]
    : ["git", "-C", repoRoot, "diff", "--cached", "--no-ext-diff", "--no-color", "--find-renames", "--unified=3", "--", ...scopes];
  const trackedResult = await runCommand(trackedArgs, {
    cwd: repoRoot,
    shell: false,
    maxStdout: MAX_DISPLAY_DIFF_BYTES * 2,
    maxStderr: 32_000,
  });
  if (!trackedResult.ok && String(trackedResult.stderr || "").trim()) {
    return fail(trackedResult.stderr || "could not build Git diff");
  }

  const chunks = [];
  if (String(trackedResult.stdout || "").trim()) chunks.push(String(trackedResult.stdout).trimEnd());
  for (const entry of entries) {
    if (!entry.untracked) continue;
    const absolutePath = assertInWorkspace(path.resolve(repoRoot, entry.path));
    const chunk = untrackedDisplayDiff(absolutePath, entry.path);
    if (chunk) chunks.push(chunk.trimEnd());
  }

  const bounded = boundDisplayDiff(chunks.filter(Boolean).join("\n"));
  const token = createDisplayContentTicket(bounded.content);
  return displayToolResult(`Prepared a changes display for ${entries.length} file${entries.length === 1 ? "" : "s"}.`, {
    kind: "display",
    type: "changes",
    title,
    branch,
    clean: false,
    files: entries.map((entry) => ({
      path: entry.path,
      code: entry.code,
      kind: entry.kind,
      staged: entry.staged,
      unstaged: entry.unstaged,
      untracked: entry.untracked,
    })),
    token,
    truncated: bounded.truncated,
    resumeToken: durableResumeToken,
  });
}

function createDocumentDisplayResult(resolved, type, { resumeToken = null } = {}) {
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return fail(`not a file: ${resolved}`);
  if (stat.size > MAX_DISPLAY_CONTENT_CHARS) {
    return fail(`display source exceeds ${MAX_DISPLAY_CONTENT_CHARS} bytes`);
  }
  const content = fs.readFileSync(resolved, "utf8");
  const token = createDisplayContentTicket(content);
  const durableResumeToken = resumeToken || createDisplayResumeToken({
    type,
    path: resolved,
  });
  return displayToolResult(`Prepared a ${type === "html" ? "HTML artifact" : "Markdown"} display.`, {
    kind: "display",
    type,
    title: path.basename(resolved),
    token,
    resumeToken: durableResumeToken,
  });
}

function normalizeDisplayPaths(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const unique = [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
  if (unique.length > MAX_DISPLAY_FILE_PATHS) {
    throw new Error(`display can show at most ${MAX_DISPLAY_FILE_PATHS} files at once`);
  }
  return unique;
}

function displayDocumentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  return null;
}

function displayToolResult(summary, structuredContent) {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

function createDisplayContentTicket(content) {
  cleanupDisplayTickets();
  const token = crypto.randomBytes(18).toString("base64url");
  displayTickets.set(token, {
    content: String(content || ""),
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  });
  trimDisplayTickets();
  return token;
}

function loadOrCreatePreviewResumeSecret() {
  const secretPath = path.join(STATE_DIR, "preview-resume.key");
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    return readPreviewResumeSecret(secretPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const secret = crypto.randomBytes(32).toString("base64url");
  try {
    fs.writeFileSync(secretPath, `${secret}\n`, { flag: "wx", mode: 0o600 });
    return secret;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return readPreviewResumeSecret(secretPath);
  }
}

function readPreviewResumeSecret(secretPath) {
  const stat = fs.lstatSync(secretPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("preview resume key must be a regular, non-symlink file");
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("preview resume key must be owned by the current user");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("preview resume key must be mode 0600");
    }
  }
  const secret = fs.readFileSync(secretPath, "utf8").trim();
  if (secret.length < 32) throw new Error("preview resume key is invalid");
  return secret;
}

function createDisplayResumeToken(source) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", displayResumeKey, iv);
  cipher.setAAD(Buffer.from("local-system:display-preview:v1", "utf8"));
  const payload = {
    version: 1,
    source,
    expiresAt: Date.now() + DISPLAY_RESUME_TTL_MS,
  };
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([1]), iv, tag, encrypted]).toString("base64url");
}

function resolveDisplayResumeToken(token) {
  try {
    const raw = Buffer.from(String(token || ""), "base64url");
    if (raw.length < 30 || raw[0] !== 1) throw new Error("invalid display resume token");
    const iv = raw.subarray(1, 13);
    const tag = raw.subarray(13, 29);
    const encrypted = raw.subarray(29);
    const decipher = crypto.createDecipheriv("aes-256-gcm", displayResumeKey, iv);
    decipher.setAAD(Buffer.from("local-system:display-preview:v1", "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const payload = JSON.parse(plaintext);
    if (payload?.version !== 1 || !payload?.source || Number(payload.expiresAt) <= Date.now()) {
      throw new Error("expired display resume token");
    }
    if (payload.source.type === "html") {
      if (typeof payload.source.path !== "string" || !payload.source.path) throw new Error("invalid display resume source");
      return { type: "html", path: assertInWorkspace(payload.source.path) };
    }
    if (payload.source.type === "changes") {
      if (!Array.isArray(payload.source.paths) || payload.source.paths.length < 1 || payload.source.paths.length > MAX_DISPLAY_FILE_PATHS) {
        throw new Error("invalid display resume source");
      }
      return {
        type: "changes",
        paths: payload.source.paths.map((sourcePath) => assertInWorkspace(sourcePath)),
      };
    }
    throw new Error("invalid display resume source");
  } catch {
    throw new Error("display session cannot be refreshed; run display again");
  }
}

function cleanupDisplayTickets() {
  const now = Date.now();
  for (const [token, ticket] of displayTickets) {
    if (!ticket || ticket.expiresAt <= now) displayTickets.delete(token);
  }
}

function trimDisplayTickets() {
  while (displayTickets.size > MAX_DISPLAY_TICKETS) {
    const oldest = displayTickets.keys().next().value;
    if (!oldest) break;
    displayTickets.delete(oldest);
  }
}

function boundDisplayDiff(value) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= MAX_DISPLAY_DIFF_BYTES) {
    return { content: text, truncated: false };
  }
  let end = Math.min(text.length, MAX_DISPLAY_DIFF_BYTES);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > MAX_DISPLAY_DIFF_BYTES) {
    end = Math.floor(end * 0.9);
  }
  const boundary = text.lastIndexOf("\n", end);
  return {
    content: text.slice(0, boundary > 0 ? boundary + 1 : end),
    truncated: true,
  };
}

function untrackedDisplayDiff(filePath, relativePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return ""; }
  if (!stat.isFile()) return "";
  const relative = String(relativePath || path.basename(filePath)).split(path.sep).join("/");
  if (stat.size > MAX_DISPLAY_CONTENT_CHARS) {
    return [
      `diff --git a/${relative} b/${relative}`,
      "new file mode 100644",
      "Binary files /dev/null and b/" + relative + " differ",
      "",
    ].join("\n");
  }
  const raw = fs.readFileSync(filePath);
  if (raw.includes(0)) {
    return [
      `diff --git a/${relative} b/${relative}`,
      "new file mode 100644",
      "Binary files /dev/null and b/" + relative + " differ",
      "",
    ].join("\n");
  }
  return createAddFileDiff(relative, raw.toString("utf8").replace(/\r\n?/g, "\n"));
}

// Legacy helper implementations remain in git history for rollback with the hidden file tools.

function openInDefaultApplication(filePath) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [filePath];
  } else if (process.platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "& { param([string]$p) Start-Process -LiteralPath $p }",
      filePath,
    ];
  } else {
    command = "xdg-open";
    args = [filePath];
  }

  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (result.error) throw new Error(`could not open file: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`could not open file${detail ? `: ${detail}` : ""}`);
  }
}

async function createPreviewResult(resolved, { resumeToken = null } = {}) {
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return fail(`not a file: ${resolved}`);

  cleanupPreviewTickets(previewTickets);
  const descriptor = previewDescriptor(resolved);
  const policy = previewReadPolicy(descriptor.category, stat.size);
  const token = crypto.randomBytes(18).toString("base64url");
  const resourceUri = policy.maxBytes > 0 ? `preview://sol/${token}` : null;
  let cloud = null;
  try {
    cloud = await createS3Preview(resolved, descriptor);
  } catch (error) {
    console.warn(`[file-preview] cloud preview unavailable for ${path.basename(resolved)}; using local fallback: ${error.message}`);
  }

  previewTickets.set(token, {
    path: resolved,
    category: descriptor.category,
    mimeType: descriptor.mimeType,
    maxBytes: policy.maxBytes,
    cloud,
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  });
  trimPreviewTickets(previewTickets);

  const durableResumeToken = resumeToken || createPreviewResumeToken(resolved);
  const file = {
    name: path.basename(resolved),
    displayPath: displayPathForPreview(resolved),
    mimeType: descriptor.mimeType,
    category: descriptor.category,
    language: descriptor.language,
    bytes: stat.size,
    previewBytes: policy.maxBytes > 0 ? Math.min(stat.size, policy.maxBytes) : 0,
    truncated: policy.maxBytes > 0 && policy.maxBytes < stat.size,
    resourceUri,
    openToken: token,
    resumeToken: durableResumeToken,
    cloud: Boolean(cloud),
  };
  return {
    content: [{ type: "text", text: `Prepared file display for ${path.basename(resolved)}.` }],
    structuredContent: { kind: "display", type: "file", file },
    file,
  };
}

async function createPreviewSetResult(resolvedPaths) {
  for (const resolved of resolvedPaths) {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return fail(`not a file: ${resolved}`);
  }

  const files = [];
  for (const resolved of resolvedPaths) {
    const result = await createPreviewResult(resolved);
    if (result.isError) return result;
    files.push(result.file);
  }
  const imageCount = files.filter((file) => file.category === "image").length;
  const label = imageCount === files.length ? "images" : "files";
  return {
    content: [{ type: "text", text: `Prepared file display for ${files.length} ${label}.` }],
    structuredContent: { kind: "display", type: "file", file: files[0], files },
    file: files[0],
    files,
  };
}

export function normalizePathInput(input = {}, toolName = "tool") {
  if (Object.hasOwn(input, "path")) return { error: `${toolName} accepts paths only; path is not supported` };
  const hasPaths = Array.isArray(input.paths) && input.paths.length > 0;
  if (hasPaths) return { paths: [...input.paths] };
  return { error: `${toolName} requires a non-empty paths array` };
}

function createPreviewResumeToken(filePath) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", previewResumeKey, iv);
  cipher.setAAD(Buffer.from("local-system:file-preview:v1", "utf8"));
  const plaintext = Buffer.from(JSON.stringify({ version: 1, path: filePath }), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([1]), iv, tag, encrypted]).toString("base64url");
}

function resolvePreviewResumeToken(token) {
  try {
    const raw = Buffer.from(String(token || ""), "base64url");
    if (raw.length < 30 || raw[0] !== 1) throw new Error("invalid preview resume token");
    const iv = raw.subarray(1, 13);
    const tag = raw.subarray(13, 29);
    const encrypted = raw.subarray(29);
    const decipher = crypto.createDecipheriv("aes-256-gcm", previewResumeKey, iv);
    decipher.setAAD(Buffer.from("local-system:file-preview:v1", "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const payload = JSON.parse(plaintext);
    if (payload?.version !== 1 || typeof payload.path !== "string" || !payload.path) throw new Error("invalid preview resume token");
    return assertInWorkspace(payload.path);
  } catch {
    throw new Error("preview session cannot be refreshed; run display again");
  }
}

function previewDescriptor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = mimeTypeForPath(filePath);
  const language = highlightLanguageForPath(filePath);

  if (ext === ".md" || ext === ".markdown" || mimeType === "text/markdown") return { category: "markdown", mimeType, language: "markdown" };
  if (mimeType.startsWith("image/")) return { category: "image", mimeType, language: null };
  if (mimeType.startsWith("audio/")) return { category: "audio", mimeType, language: null };
  if (mimeType.startsWith("video/")) return { category: "video", mimeType, language: null };
  if (mimeType === "application/pdf") return { category: "pdf", mimeType, language: null };
  if (language) return { category: "code", mimeType, language };
  if (mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) return { category: "text", mimeType, language: null };
  return { category: "binary", mimeType, language: null };
}

function previewReadPolicy(category, bytes) {
  if (["text", "code", "markdown"].includes(category)) {
    return { maxBytes: Math.max(1, Math.min(bytes, MAX_TEXT_PREVIEW_BYTES)) };
  }
  if (["image", "audio", "video", "pdf"].includes(category)) {
    if (bytes > MAX_FULL_BINARY_PREVIEW_BYTES) {
      return {
        maxBytes: 0,
        reason: `Inline ${category} preview is capped at ${MAX_FULL_BINARY_PREVIEW_BYTES / (1024 * 1024)} MiB; this file is larger, so only metadata is shown.`,
      };
    }
    return { maxBytes: Math.max(1, bytes) };
  }
  return { maxBytes: Math.max(1, Math.min(bytes, MAX_BINARY_SAMPLE_BYTES)) };
}

function displayPathForPreview(filePath) {
  const root = currentProjectWorkspace();
  if (!root) return path.basename(filePath);
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return path.basename(filePath);
  return relative;
}

function cleanupPreviewTickets(tickets) {
  const now = Date.now();
  for (const [token, ticket] of tickets) {
    if (!ticket || ticket.expiresAt <= now) tickets.delete(token);
  }
}

function trimPreviewTickets(tickets) {
  while (tickets.size > MAX_PREVIEW_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (!oldest) break;
    tickets.delete(oldest);
  }
}

function readPrefix(filePath, maxBytes) {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".log", ".csv", ".tsv", ".ini", ".conf", ".cfg", ".env", ".properties",
  ".rst", ".tex", ".sql", ".graphql", ".gql", ".toml", ".lock",
]);

export function detectModelImageMimeType(data) {
  if (!Buffer.isBuffer(data) || data.length < 3) return null;
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

const MIME_TYPES = Object.freeze({
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".jsx": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".fish": "text/x-shellscript",
  ".java": "text/x-java-source",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cc": "text/x-c++",
  ".cpp": "text/x-c++",
  ".cxx": "text/x-c++",
  ".hpp": "text/x-c++",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".rb": "text/x-ruby",
  ".php": "text/x-php",
  ".swift": "text/x-swift",
  ".kt": "text/x-kotlin",
  ".kts": "text/x-kotlin",
  ".sql": "application/sql",
  ".graphql": "application/graphql",
  ".gql": "application/graphql",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".wasm": "application/wasm",
});

function mimeTypeForPath(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function highlightLanguageForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
    ".py": "python",
    ".json": "json", ".jsonl": "json",
    ".yaml": "yaml", ".yml": "yaml",
    ".css": "css",
    ".html": "xml", ".htm": "xml", ".xml": "xml",
    ".svg": null,
    ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    ".java": "java",
    ".c": "cpp", ".h": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    ".go": "go",
    ".rs": "rust",
    ".sql": "sql",
    ".md": "markdown", ".markdown": "markdown",
  })[ext] || null;
}
