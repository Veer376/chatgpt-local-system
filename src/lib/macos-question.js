import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentScratchDir } from "./config.js";
import { assertInWorkspace, resolveUserPath } from "./paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(here, "../../scripts/macos-ask-user.py");
const MAX_HELPER_OUTPUT = 16_000;
const SESSION_CLOSE_GRACE_MS = 500;
const MAX_NATIVE_PRESENTATION_MEDIA_BYTES = 100 * 1024 * 1024;
const NATIVE_MEDIA_MIME_TYPES = Object.freeze({
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
});

export function startMacQuestion(
  {
    requestId,
    title = "Question",
    question,
    macQuestion,
    sections = null,
    prompt = null,
    options,
    allowCustom = true,
    multiSelect = false,
    interactionKind = "question",
    content = null,
    presentationOnly = false,
    contentOnly = false,
    questionIndex = 0,
    questionCount = 1,
    expiresAt = null,
  },
  {
    platform = process.platform,
    python = process.env.MACOS_ASK_USER_PYTHON || "python3",
    spawnImpl = spawn,
  } = {},
) {
  if (platform !== "darwin") return inactiveHandle("unsupported_platform");

  let child;
  try {
    child = spawnImpl(python, [HELPER], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return inactiveHandle("launch_failed");
  }

  let stdout = "";
  let stderr = "";
  let settled = false;
  let closing = false;
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });

  const settle = (result) => {
    if (settled) return;
    settled = true;
    resolvePromise(result);
  };

  child.stdout?.on("data", (chunk) => {
    if (stdout.length < MAX_HELPER_OUTPUT) stdout += String(chunk).slice(0, MAX_HELPER_OUTPUT - stdout.length);
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < MAX_HELPER_OUTPUT) stderr += String(chunk).slice(0, MAX_HELPER_OUTPUT - stderr.length);
  });
  child.once("error", () => settle({ status: "unavailable", reason: "launch_failed" }));
  child.once("close", () => {
    if (settled) return;
    if (closing) {
      settle({ status: "cancelled", reason: "resolved_elsewhere" });
      return;
    }
    const parsed = parseHelperResult(stdout);
    settle(parsed || {
      status: "unavailable",
      reason: stderr.trim() ? "helper_failed" : "invalid_helper_response",
    });
  });

  try {
    child.stdin?.end(JSON.stringify(nativeQuestionPayload({
      requestId,
      title,
      question: macQuestion || question,
      sections,
      prompt,
      options,
      allowCustom,
      multiSelect,
      interactionKind,
      content,
      presentationOnly,
      contentOnly,
      questionIndex,
      questionCount,
      expiresAt,
    })));
  } catch {
    closing = true;
    child.kill?.("SIGTERM");
    settle({ status: "unavailable", reason: "launch_failed" });
  }

  return {
    promise,
    close() {
      if (settled || closing) return;
      closing = true;
      child.kill?.("SIGTERM");
    },
  };
}

export function startMacQuestionSession({
  platform = process.platform,
  python = process.env.MACOS_ASK_USER_PYTHON || "python3",
  spawnImpl = spawn,
} = {}) {
  if (platform !== "darwin") return inactiveSession("unsupported_platform");

  let child;
  try {
    child = spawnImpl(python, [HELPER, "--session"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return inactiveSession("launch_failed");
  }

  const pending = new Map();
  let stdoutBuffer = "";
  let stderr = "";
  let closed = false;
  let closing = false;
  let killTimer = null;

  const settlePending = (result) => {
    for (const { resolve } of pending.values()) resolve(result);
    pending.clear();
  };

  const send = (payload) => {
    if (closed || closing || !child.stdin?.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const consumeLine = (line) => {
    let value;
    try { value = JSON.parse(line); }
    catch { return; }
    if (!value || typeof value !== "object") return;
    if (value.status === "unavailable" && !value.requestId) {
      settlePending({ status: "unavailable", reason: String(value.reason || "helper_failed") });
      return;
    }
    const requestId = String(value.requestId || "");
    if (!requestId) return;
    const entry = pending.get(requestId);
    if (!entry) return;
    const parsed = normalizeHelperValue(value);
    if (!parsed) return;
    pending.delete(requestId);
    entry.resolve(parsed);
  };

  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    if (stdoutBuffer.length > MAX_HELPER_OUTPUT * 4) stdoutBuffer = stdoutBuffer.slice(-MAX_HELPER_OUTPUT * 2);
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) consumeLine(line);
    }
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < MAX_HELPER_OUTPUT) stderr += String(chunk).slice(0, MAX_HELPER_OUTPUT - stderr.length);
  });
  child.once("error", () => {
    if (closed) return;
    closed = true;
    settlePending({ status: "unavailable", reason: "launch_failed" });
  });
  child.once("close", () => {
    if (killTimer) clearTimeout(killTimer);
    if (closed) return;
    closed = true;
    settlePending(closing
      ? { status: "cancelled", reason: "session_closed" }
      : { status: "unavailable", reason: stderr.trim() ? "helper_failed" : "helper_closed" });
  });

  const session = {
    isClosed() {
      return closed || closing;
    },
    ask({
      requestId,
      title = "Question",
      question,
      macQuestion,
      sections = null,
      prompt = null,
      options,
      allowCustom = true,
      multiSelect = false,
      interactionKind = "question",
      content = null,
      presentationOnly = false,
      contentOnly = false,
      questionIndex = 0,
      questionCount = 1,
      expiresAt = null,
    }) {
      if (closed || closing) return inactiveHandle(closing ? "session_closed" : "helper_closed");
      let resolvePromise;
      let settled = false;
      const promise = new Promise((resolve) => { resolvePromise = resolve; });
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };
      pending.set(requestId, { resolve: settle });
      if (!send(nativeQuestionPayload({
        action: "show",
        requestId,
        title,
        question: macQuestion || question,
        sections,
        prompt,
        options,
        allowCustom,
        multiSelect,
        interactionKind,
        content,
        presentationOnly,
        contentOnly,
        questionIndex,
        questionCount,
        expiresAt,
      }))) {
        pending.delete(requestId);
        settle({ status: "unavailable", reason: "helper_write_failed" });
      }
      return {
        promise,
        close({ keepOpen = false } = {}) {
          const entry = pending.get(requestId);
          if (entry) {
            pending.delete(requestId);
            entry.resolve({ status: "cancelled", reason: "resolved_elsewhere" });
            send({ action: "cancel", requestId, keepOpen });
          }
          if (!keepOpen) session.close();
        },
      };
    },
    close() {
      if (closed || closing) return;
      closing = true;
      settlePending({ status: "cancelled", reason: "session_closed" });
      try { child.stdin?.write(`${JSON.stringify({ action: "shutdown" })}\n`); } catch {}
      try { child.stdin?.end(); } catch {}
      killTimer = setTimeout(() => {
        if (!closed) child.kill?.("SIGTERM");
      }, SESSION_CLOSE_GRACE_MS);
      killTimer.unref?.();
    },
  };

  return session;
}

function parseHelperResult(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = normalizeHelperValue(JSON.parse(lines[index]));
      if (parsed) return parsed;
    } catch { /* keep scanning */ }
  }
  return null;
}

function normalizeHelperValue(value) {
  if (!value || typeof value !== "object" || typeof value.status !== "string") return null;
  if (value.status === "answered") {
    const answer = String(value.answer || "").trim();
    if (!answer) return null;
    const answers = Array.isArray(value.answers)
      ? value.answers.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const optionIndexes = Array.isArray(value.optionIndexes)
      ? value.optionIndexes.filter((item) => Number.isInteger(item))
      : [];
    const optionIndex = Number.isInteger(value.optionIndex) ? value.optionIndex : null;
    const attachments = Array.isArray(value.attachments)
      ? value.attachments.slice(0, 5).flatMap((attachment) => {
          if (!attachment || typeof attachment !== "object") return [];
          const attachmentPath = String(attachment.path || "").trim();
          if (!attachmentPath) return [];
          return [{
            path: attachmentPath,
            name: String(attachment.name || path.basename(attachmentPath)),
            mimeType: String(attachment.mimeType || "application/octet-stream"),
            ...(Number.isInteger(attachment.bytes) ? { bytes: attachment.bytes } : {}),
          }];
        })
      : [];
    return {
      status: "answered",
      answer,
      answers: answers.length ? answers : [answer],
      custom: Boolean(value.custom),
      optionIndex,
      optionIndexes: optionIndexes.length ? optionIndexes : optionIndex === null ? null : [optionIndex],
      ...(attachments.length ? { attachments } : {}),
      ...(value.skipped === true ? { skipped: true } : {}),
      ...(value.presentationOnly === true ? { presentationOnly: true } : {}),
      ...(value.contentOnly === true ? { contentOnly: true } : {}),
    };
  }
  if (["unavailable", "dismissed", "cancelled"].includes(value.status)) {
    return { status: value.status, reason: String(value.reason || "") || undefined };
  }
  return null;
}

export function prepareNativePresentationContent(
  content,
  {
    resolveMedia = resolveNativePresentationMedia,
    tokenFactory = () => crypto.randomBytes(12).toString("hex"),
  } = {},
) {
  if (typeof content !== "string" || content.length === 0) return { content, presentationMedia: [] };

  const presentationMedia = [];
  const mediaByPath = new Map();
  const localUrl = (reference, { imageOnly = false } = {}) => {
    const raw = String(reference || "").trim();
    if (!raw || !isPotentialLocalMediaReference(raw)) return raw;
    try {
      const media = resolveMedia(raw);
      if (!media || (imageOnly && !String(media.mimeType || "").startsWith("image/"))) return raw;
      let id = mediaByPath.get(media.path);
      if (!id) {
        id = tokenFactory();
        mediaByPath.set(media.path, id);
        presentationMedia.push({ id, ...media });
      }
      return `local-system-media://media/${id}`;
    } catch {
      return raw;
    }
  };

  let rewritten = content;
  rewritten = rewritten.replace(/\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi, (match, attr, quote, reference) => {
    const next = localUrl(reference, { imageOnly: String(attr).toLowerCase() === "poster" });
    return next === reference ? match : `${attr}=${quote}${next}${quote}`;
  });
  rewritten = rewritten.replace(/\b(src|poster)\s*=\s*([^\s>"']+)/gi, (match, attr, reference) => {
    const next = localUrl(reference, { imageOnly: String(attr).toLowerCase() === "poster" });
    return next === reference ? match : `${attr}=${next}`;
  });
  rewritten = rewritten.replace(/\bsrcset\s*=\s*(["'])([^"']+)\1/gi, (match, quote, value) => {
    let changed = false;
    const next = value.split(",").map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return candidate;
      const [reference, ...descriptor] = trimmed.split(/\s+/);
      const mapped = localUrl(reference, { imageOnly: true });
      if (mapped !== reference) changed = true;
      return [mapped, ...descriptor].join(" ");
    }).join(", ");
    return changed ? `srcset=${quote}${next}${quote}` : match;
  });
  rewritten = rewritten.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g, (match, alt, reference, title = "") => {
    const next = localUrl(reference, { imageOnly: true });
    return next === reference ? match : `![${alt}](${next}${title || ""})`;
  });

  return { content: rewritten, presentationMedia };
}

function resolveNativePresentationMedia(reference) {
  const filePath = nativeMediaPath(reference);
  const resolved = assertInWorkspace(resolveUserPath(filePath));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("presentation media path is not a file");
  if (stat.size > MAX_NATIVE_PRESENTATION_MEDIA_BYTES) {
    throw new Error("presentation media exceeds 100 MiB limit");
  }
  const mimeType = NATIVE_MEDIA_MIME_TYPES[path.extname(resolved).toLowerCase()];
  if (!mimeType) throw new Error("unsupported presentation media type");
  return { path: resolved, mimeType, bytes: stat.size };
}

function nativeMediaPath(reference) {
  const raw = String(reference || "").trim();
  if (/^file:/i.test(raw)) return fileURLToPath(raw);
  const pathOnly = raw.split(/[?#]/, 1)[0];
  if (!/%[0-9a-f]{2}/i.test(pathOnly)) return pathOnly;
  try { return decodeURIComponent(pathOnly); } catch { return pathOnly; }
}

function isPotentialLocalMediaReference(reference) {
  if (!reference || reference.startsWith("#") || reference.startsWith("//")) return false;
  if (/^file:/i.test(reference)) return true;
  if (/^[A-Za-z]:[\\/]/.test(reference)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) return false;
  const pathOnly = reference.split(/[?#]/, 1)[0];
  return Boolean(NATIVE_MEDIA_MIME_TYPES[path.extname(pathOnly).toLowerCase()]);
}

function nativeQuestionPayload({
  action,
  requestId,
  title,
  question,
  sections,
  prompt,
  options,
  allowCustom,
  multiSelect,
  interactionKind,
  content,
  presentationOnly,
  contentOnly,
  questionIndex,
  questionCount,
  expiresAt,
}) {
  const safeRequestId = String(requestId || "interrupt").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "interrupt";
  const prepared = prepareNativePresentationContent(content);
  return {
    ...(action ? { action } : {}),
    requestId,
    title,
    question,
    sections,
    prompt,
    options,
    allowCustom,
    multiSelect,
    interactionKind: interactionKind === "approval" ? "approval" : "question",
    content: prepared.content,
    ...(prepared.presentationMedia.length ? { presentationMedia: prepared.presentationMedia } : {}),
    presentationOnly: Boolean(presentationOnly),
    contentOnly: Boolean(contentOnly),
    questionIndex: Math.max(0, Number(questionIndex) || 0),
    questionCount: Math.max(1, Number(questionCount) || 1),
    expiresAt: Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0 ? Number(expiresAt) : null,
    attachmentDir: path.join(currentScratchDir(), "interrupts", safeRequestId),
  };
}

function inactiveSession(reason) {
  return {
    ask() { return inactiveHandle(reason); },
    close() {},
  };
}

function inactiveHandle(reason) {
  return {
    promise: Promise.resolve({ status: "unavailable", reason }),
    close() {},
  };
}
