import crypto from "node:crypto";
import { updateConversationStateByKey } from "./config.js";
import { resolveBrowserThreadState } from "./local-todos.js";

const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";
const MAX_ANNOTATIONS = 100;
const MAX_COMMENT_LENGTH = 4_000;
const MAX_QUOTE_LENGTH = 4_000;
const MAX_CONTEXT_LENGTH = 320;
const MAX_MESSAGE_KEY_LENGTH = 320;
const MAX_SOURCE_SEGMENTS = 24;
const MAX_RECOVERY_TURNS = 12;
const MAX_RECOVERY_ANNOTATIONS_PER_TURN = 24;

export function registerLocalAnnotationRoutes(app) {
  app.post("/local-ui/annotations", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const resolved = resolveBrowserThreadState(req.body?.threadId);
      if (!resolved.bound) {
        return res.set("Cache-Control", "no-store").json({ ok: true, bound: false, annotations: [] });
      }

      const action = String(req.body?.action || "list").trim().toLowerCase();
      const existing = normalizeAnnotations(resolved.state?.annotations);
      let annotations = existing;
      let lastAnnotation = normalizeRecoveryAnnotation(resolved.state?.lastAnnotation);
      let annotationTurns = normalizeRecoveryTurns(resolved.state?.annotationTurns, lastAnnotation);

      if (action === "latest") {
        const latestTurn = annotationTurns.at(-1) || null;
        const recovered = latestTurn?.annotations?.map(withCopyText) || [];
        return res.set("Cache-Control", "no-store").json({
          ok: true,
          bound: true,
          annotations: recovered,
          annotation: recovered.at(-1) || null,
          turn: latestTurn ? {
            key: latestTurn.key,
            kind: latestTurn.kind,
            updatedAt: latestTurn.updatedAt,
            count: recovered.length,
          } : null,
        });
      }

      if (action === "upsert") {
        const incoming = normalizeAnnotationInput(req.body?.annotation);
        const now = new Date().toISOString();
        const current = incoming.id ? existing.find((item) => item.id === incoming.id) : null;
        const next = {
          id: current?.id || crypto.randomUUID(),
          comment: incoming.comment,
          source: incoming.source,
          createdAt: current?.createdAt || now,
          updatedAt: now,
        };
        annotations = current
          ? existing.map((item) => item.id === current.id ? next : item)
          : [...existing, next];
        if (annotations.length > MAX_ANNOTATIONS) throw new Error(`annotation limit is ${MAX_ANNOTATIONS}`);
        lastAnnotation = chatAnnotationRecoverySnapshot(next);
        annotationTurns = appendRecoveryAnnotationTurn(annotationTurns, lastAnnotation);
      } else if (action === "delete") {
        const id = normalizeId(req.body?.id);
        annotations = existing.filter((item) => item.id !== id);
      } else if (action === "clear") {
        annotations = [];
      } else if (action !== "list") {
        throw new Error("annotation action must be list, latest, upsert, delete, or clear");
      }

      let state = resolved.state;
      if (action !== "list") {
        state = updateConversationStateByKey(resolved.conversationKey, {
          annotations,
          ...(lastAnnotation ? { lastAnnotation } : {}),
          annotationTurns,
        });
      }

      return res.set("Cache-Control", "no-store").json({
        ok: true,
        bound: true,
        annotations,
        updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /limit/i.test(message) ? 413 : 400;
      return res.status(status).set("Cache-Control", "no-store").json({ error: message });
    }
  });
}

export function chatAnnotationRecoverySnapshot(annotation) {
  if (!annotation || typeof annotation !== "object") return null;
  const source = annotation.source || {};
  const comment = String(annotation.comment || "").trim();
  const quote = String(source.quote || "");
  if (!comment || !quote.trim()) return null;
  return {
    kind: "chat",
    id: String(annotation.id || ""),
    comment,
    quote,
    role: String(source.role || "unknown"),
    messageKey: String(source.messageKey || ""),
    createdAt: normalizeIso(annotation.createdAt),
    updatedAt: normalizeIso(annotation.updatedAt) || normalizeIso(annotation.createdAt) || new Date().toISOString(),
  };
}

export function fileAnnotationRecoverySnapshot(annotation) {
  if (!annotation || typeof annotation !== "object") return null;
  const comment = String(annotation.comment || "").trim();
  const quote = String(annotation.quote || "");
  const filePath = String(annotation.path || "").trim();
  if (!comment || !quote.trim() || !filePath) return null;
  return {
    kind: "file",
    id: String(annotation.id || ""),
    comment,
    quote,
    ...(typeof annotation.sourceQuote === "string" && annotation.sourceQuote && annotation.sourceQuote !== quote
      ? { sourceQuote: annotation.sourceQuote }
      : {}),
    path: filePath,
    start: normalizeRecoveryPosition(annotation.start),
    end: normalizeRecoveryPosition(annotation.end),
    createdAt: normalizeIso(annotation.createdAt),
    updatedAt: normalizeIso(annotation.updatedAt) || normalizeIso(annotation.createdAt) || new Date().toISOString(),
  };
}

export function normalizeRecoveryAnnotation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind === "file") return fileAnnotationRecoverySnapshot(value);
  if (value.kind === "chat") {
    return chatAnnotationRecoverySnapshot({
      id: value.id,
      comment: value.comment,
      source: {
        quote: value.quote,
        role: value.role,
        messageKey: value.messageKey,
      },
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    });
  }
  return null;
}

export function normalizeRecoveryTurns(value, legacyLastAnnotation = null) {
  const source = Array.isArray(value) ? value : [];
  const turns = [];
  for (const item of source) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const annotations = (Array.isArray(item.annotations) ? item.annotations : [])
      .map(normalizeRecoveryAnnotation)
      .filter(Boolean)
      .slice(-MAX_RECOVERY_ANNOTATIONS_PER_TURN);
    if (!annotations.length) continue;
    const key = recoveryTurnKey(annotations.at(-1));
    if (!key) continue;
    turns.push({
      key,
      kind: annotations.at(-1).kind,
      updatedAt: latestRecoveryTimestamp(annotations),
      annotations,
    });
  }
  if (!turns.length) {
    const legacy = normalizeRecoveryAnnotation(legacyLastAnnotation);
    if (legacy) return appendRecoveryAnnotationTurn([], legacy);
  }
  return turns.slice(-MAX_RECOVERY_TURNS);
}

export function appendRecoveryAnnotationTurn(value, annotation) {
  const snapshot = normalizeRecoveryAnnotation(annotation);
  if (!snapshot) return normalizeRecoveryTurns(value);
  const key = recoveryTurnKey(snapshot);
  if (!key) return normalizeRecoveryTurns(value);
  const turns = normalizeRecoveryTurns(value);
  const previous = turns.find((turn) => turn.key === key);
  const annotations = previous
    ? previous.annotations.filter((item) => item.id !== snapshot.id)
    : [];
  annotations.push(snapshot);
  const nextTurn = {
    key,
    kind: snapshot.kind,
    updatedAt: latestRecoveryTimestamp(annotations),
    annotations: annotations.slice(-MAX_RECOVERY_ANNOTATIONS_PER_TURN),
  };
  return [...turns.filter((turn) => turn.key !== key), nextTurn].slice(-MAX_RECOVERY_TURNS);
}

function recoveryTurnKey(annotation) {
  if (annotation?.kind === "chat") {
    const messageKey = String(annotation.messageKey || "").trim();
    return messageKey ? `chat:${messageKey}` : "";
  }
  if (annotation?.kind === "file") {
    const filePath = String(annotation.path || "").trim();
    return filePath ? `file:${filePath}` : "";
  }
  return "";
}

function latestRecoveryTimestamp(annotations) {
  return annotations.reduce((latest, annotation) => {
    const timestamp = normalizeIso(annotation.updatedAt) || normalizeIso(annotation.createdAt);
    return !latest || (timestamp && timestamp > latest) ? timestamp : latest;
  }, null) || new Date().toISOString();
}

function withCopyText(annotation) {
  if (annotation.kind === "file") {
    const start = annotation.start || {};
    const end = annotation.end || {};
    const location = start.line
      ? `lines ${start.line}:${start.column || 1}${end.line ? `-${end.line}:${end.column || 1}` : ""}`
      : "selected text";
    return {
      ...annotation,
      copyText: [
        "<Annotations>",
        `- File: ${JSON.stringify(annotation.path)} (${location})`,
        `  Selected text: ${JSON.stringify(annotation.quote)}`,
        `  Comment: ${annotation.comment}`,
        "</Annotations>",
      ].join("\n"),
    };
  }
  return {
    ...annotation,
    copyText: [
      "<Annotations>",
      `- Selected text: ${JSON.stringify(annotation.quote)}`,
      `  Comment: ${annotation.comment}`,
      "</Annotations>",
    ].join("\n"),
  };
}

function normalizeRecoveryPosition(value) {
  if (!value || typeof value !== "object") return null;
  const line = Number(value.line);
  const column = Number(value.column);
  const offset = Number(value.offset);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1 || !Number.isInteger(offset) || offset < 0) {
    return null;
  }
  return { line, column, offset };
}

export function normalizeAnnotations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeStoredAnnotation(item))
    .filter(Boolean)
    .slice(0, MAX_ANNOTATIONS);
}

function normalizeStoredAnnotation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let id;
  try { id = normalizeId(value.id); } catch { return null; }
  let incoming;
  try {
    incoming = normalizeAnnotationInput({
      id,
      comment: value.comment,
      source: value.source,
    });
  } catch {
    return null;
  }
  const createdAt = normalizeIso(value.createdAt) || new Date(0).toISOString();
  const updatedAt = normalizeIso(value.updatedAt) || createdAt;
  return {
    id,
    comment: incoming.comment,
    source: incoming.source,
    createdAt,
    updatedAt,
  };
}

function normalizeAnnotationInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("annotation is required");
  const comment = String(value.comment || "").trim();
  if (!comment) throw new Error("annotation comment is required");
  if (comment.length > MAX_COMMENT_LENGTH) throw new Error(`annotation comment exceeds ${MAX_COMMENT_LENGTH} characters`);
  const source = normalizeSource(value.source);
  const result = { comment, source };
  if (value.id != null && String(value.id).trim()) result.id = normalizeId(value.id);
  return result;
}

function normalizeSource(value) {
  const source = normalizeSourcePart(value);
  if (value?.segments == null) return source;
  if (!Array.isArray(value.segments)) throw new Error("annotation source segments must be an array");
  if (value.segments.length < 1 || value.segments.length > MAX_SOURCE_SEGMENTS) {
    throw new Error(`annotation source segments must contain 1-${MAX_SOURCE_SEGMENTS} entries`);
  }
  const segments = value.segments.map((segment) => normalizeSourcePart(segment));
  return { ...source, segments };
}

function normalizeSourcePart(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("annotation source is required");
  const quote = String(value.quote || "");
  if (!quote.trim()) throw new Error("annotation source quote is required");
  if (quote.length > MAX_QUOTE_LENGTH) throw new Error(`annotation quote exceeds ${MAX_QUOTE_LENGTH} characters`);

  const messageKey = String(value.messageKey || "").trim();
  if (!messageKey || messageKey.length > MAX_MESSAGE_KEY_LENGTH) throw new Error("annotation messageKey is invalid");
  const start = normalizeOffset(value.start, "start");
  const end = normalizeOffset(value.end, "end");
  if (end < start) throw new Error("annotation end must be greater than or equal to start");
  const textRootIndex = normalizeTextRootIndex(value.textRootIndex);

  return {
    messageKey,
    role: ["assistant", "user", "tool", "unknown"].includes(value.role) ? value.role : "unknown",
    ...(textRootIndex != null ? { textRootIndex } : {}),
    quote,
    prefix: String(value.prefix || "").slice(-MAX_CONTEXT_LENGTH),
    suffix: String(value.suffix || "").slice(0, MAX_CONTEXT_LENGTH),
    start,
    end,
  };
}

function normalizeTextRootIndex(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000) throw new Error("annotation textRootIndex is invalid");
  return number;
}

function normalizeOffset(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 5_000_000) throw new Error(`annotation ${field} offset is invalid`);
  return number;
}

function normalizeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error("invalid annotation id");
  return id;
}

function normalizeIso(value) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
