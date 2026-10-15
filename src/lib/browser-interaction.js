import { conversationKey } from "./conversation.js";

const MAX_WAIT_MS = 25_000;
const entries = new Map();
const revisions = new Map();
const waiters = new Map();

export function startBrowserInteraction({
  conversationId,
  requestId,
  kind = "question",
  title = "Question",
  question,
  options = [],
  allowCustom = true,
  multiSelect = false,
  questionIndex = 0,
  questionCount = 1,
  expiresAt = null,
  sections = null,
  prompt = null,
  content = null,
  presentationOnly = false,
  contentOnly = false,
} = {}) {
  if (!conversationId || !requestId || !question) return inactiveHandle();
  const key = conversationKey(conversationId);
  const existing = entries.get(key);
  existing?.settle?.({ status: "cancelled", reason: "superseded" });

  let resolvePromise;
  let settled = false;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  const settle = (result) => {
    if (settled) return;
    settled = true;
    entries.delete(key);
    bump(key);
    resolvePromise(result);
  };
  const interaction = Object.freeze({
    id: String(requestId),
    kind: kind === "approval" ? "approval" : "question",
    title: String(title || (kind === "approval" ? "Approval" : "Question")),
    question: String(question),
    options: Array.isArray(options) ? options.map((value) => String(value)) : [],
    allowCustom: allowCustom !== false,
    multiple: Boolean(multiSelect),
    questionIndex: Math.max(0, Number(questionIndex) || 0),
    questionCount: Math.max(1, Number(questionCount) || 1),
    ...(Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0
      ? { expiresAt: Number(expiresAt) }
      : {}),
    sections: Array.isArray(sections)
      ? sections.map((section) => ({
          label: String(section?.label || ""),
          text: String(section?.text || ""),
          mono: Boolean(section?.mono),
          code: Boolean(section?.code),
        })).filter((section) => section.label && section.text)
      : [],
    prompt: prompt ? String(prompt) : "",
    ...(content ? { content: String(content) } : {}),
    ...(presentationOnly ? { presentationOnly: true } : {}),
    ...(contentOnly ? { contentOnly: true } : {}),
    createdAt: new Date().toISOString(),
  });

  entries.set(key, { interaction, settle });
  bump(key);
  return {
    promise,
    close() {
      const entry = entries.get(key);
      if (entry?.interaction.id === interaction.id) settle({ status: "cancelled", reason: "resolved_elsewhere" });
    },
  };
}

export function browserInteractionSnapshot(key) {
  const entry = entries.get(String(key || ""));
  return {
    revision: revisionFor(key),
    interaction: entry?.interaction || null,
  };
}

export async function waitForBrowserInteractionChange(key, revision, timeoutMs = 20_000) {
  const normalizedKey = String(key || "");
  const normalizedRevision = Number(revision) || 0;
  if (revisionFor(normalizedKey) !== normalizedRevision) return browserInteractionSnapshot(normalizedKey);
  const waitMs = Math.max(250, Math.min(MAX_WAIT_MS, Number(timeoutMs) || 20_000));
  await new Promise((resolve) => {
    const listeners = waiters.get(normalizedKey) || new Set();
    waiters.set(normalizedKey, listeners);
    let timer;
    const finish = () => {
      clearTimeout(timer);
      listeners.delete(finish);
      if (!listeners.size) waiters.delete(normalizedKey);
      resolve();
    };
    listeners.add(finish);
    timer = setTimeout(finish, waitMs);
  });
  return browserInteractionSnapshot(normalizedKey);
}

export function answerBrowserInteraction(key, { requestId, answer, answers, attachments, skip = false } = {}) {
  const normalizedKey = String(key || "");
  const entry = entries.get(normalizedKey);
  if (!entry || entry.interaction.id !== String(requestId || "")) {
    throw new Error("interaction is no longer pending");
  }
  const interaction = entry.interaction;
  const normalizedAttachments = normalizeAttachments(attachments);
  if (skip) {
    if (interaction.kind === "approval") throw new Error("approval requests cannot be skipped");
    entry.settle({
      status: "answered",
      answer: "Skipped",
      answers: ["Skipped"],
      source: "browser",
      custom: true,
      skipped: true,
      optionIndex: null,
      optionIndexes: null,
      ...(normalizedAttachments.length ? { attachments: normalizedAttachments } : {}),
      ...(interaction.presentationOnly ? { presentationOnly: true } : {}),
      ...(interaction.contentOnly ? { contentOnly: true } : {}),
    });
    return { accepted: true };
  }

  const optionValues = interaction.options;
  const submitted = Array.isArray(answers)
    ? answers.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const primary = String(answer ?? submitted[0] ?? "").trim();
  if (!primary && submitted.length === 0) throw new Error("an answer is required");

  if (interaction.multiple) {
    const values = submitted.length ? [...new Set(submitted)] : [primary];
    const indexes = values.map((value) => optionValues.indexOf(value)).filter((index) => index >= 0);
    const custom = indexes.length !== values.length;
    if (custom && !interaction.allowCustom) throw new Error("custom answers are not allowed");
    entry.settle({
      status: "answered",
      answer: values.join(", "),
      answers: values,
      source: "browser",
      custom,
      optionIndex: null,
      optionIndexes: indexes.length ? indexes : null,
      ...(normalizedAttachments.length ? { attachments: normalizedAttachments } : {}),
      ...(interaction.presentationOnly ? { presentationOnly: true } : {}),
    });
    return { accepted: true };
  }

  const optionIndex = optionValues.indexOf(primary);
  const custom = optionIndex < 0;
  if (custom && !interaction.allowCustom) throw new Error("choose one of the available options");
  entry.settle({
    status: "answered",
    answer: primary,
    answers: [primary],
    source: "browser",
    custom,
    optionIndex: optionIndex >= 0 ? optionIndex : null,
    optionIndexes: optionIndex >= 0 ? [optionIndex] : null,
    ...(normalizedAttachments.length ? { attachments: normalizedAttachments } : {}),
    ...(interaction.presentationOnly ? { presentationOnly: true } : {}),
    ...(interaction.contentOnly ? { contentOnly: true } : {}),
  });
  return { accepted: true };
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).flatMap((attachment) => {
    if (!attachment || typeof attachment !== "object") return [];
    const path = String(attachment.path || "").trim();
    const name = String(attachment.name || "").trim();
    const mimeType = String(attachment.mimeType || "application/octet-stream").trim();
    if (!path) return [];
    return [{ path, name: name || path.split(/[\\/]/).pop() || "attachment", mimeType }];
  });
}

export function clearBrowserInteractionsForTests() {
  for (const entry of entries.values()) entry.settle?.({ status: "cancelled", reason: "test_reset" });
  entries.clear();
  revisions.clear();
  for (const listeners of waiters.values()) for (const finish of listeners) finish();
  waiters.clear();
}

function bump(key) {
  const normalizedKey = String(key || "");
  revisions.set(normalizedKey, revisionFor(normalizedKey) + 1);
  const listeners = waiters.get(normalizedKey);
  if (listeners) for (const finish of [...listeners]) finish();
}

function revisionFor(key) {
  return revisions.get(String(key || "")) || 0;
}

function inactiveHandle() {
  return {
    promise: Promise.resolve({ status: "unavailable", reason: "conversation_unavailable" }),
    close() {},
  };
}
