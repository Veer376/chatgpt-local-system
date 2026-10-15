import { TURN_CHECKPOINT_MS, loadState, saveState } from "./config.js";

export const TURN_CHECKPOINT_MIN_MS = 60_000;
export const TURN_CHECKPOINT_MAX_MS = 4 * 60 * 60_000;

export const TURN_CHECKPOINT_MESSAGE = [
  "This Local System turn has been running for a considerable amount of time.",
  "Bring the work to the nearest natural checkpoint now.",
  "Finish only what is needed to leave the current work coherent and safely resumable; do not continue toward completing the whole task or start another substantial phase.",
  "This is a checkpoint, not a conclusion—do not prematurely narrow or conclude the broader investigation.",
  "Before stopping, update runtime_memory with a compact snapshot of the current objective, state, decisions, blockers, and next action.",
  "Then stop tool work, give a concise continuation summary, and hand control back to the user.",
].join(" ");

export class TurnCheckpointTracker {
  constructor({ thresholdMs = TURN_CHECKPOINT_MS, maxTracked = 128 } = {}) {
    this.thresholdMs = Math.max(1, Number(thresholdMs) || TURN_CHECKPOINT_MS);
    this.maxTracked = Math.max(1, Number(maxTracked) || 128);
    this.turns = new Map();
  }

  begin(conversationId, at = Date.now()) {
    const key = normalizeConversationId(conversationId);
    if (!key) return false;
    this.turns.delete(key);
    this.turns.set(key, {
      startedAt: normalizeTimestamp(at),
      delivered: false,
    });
    this.#prune();
    return true;
  }

  claim(conversationId, at = Date.now(), thresholdMs = this.thresholdMs) {
    const key = normalizeConversationId(conversationId);
    const turn = key ? this.turns.get(key) : null;
    if (!turn || turn.delivered) return null;
    const effectiveThreshold = normalizeCheckpointIntervalMs(thresholdMs);
    if (normalizeTimestamp(at) - turn.startedAt < effectiveThreshold) return null;
    turn.delivered = true;
    return TURN_CHECKPOINT_MESSAGE;
  }

  #prune() {
    while (this.turns.size > this.maxTracked) {
      this.turns.delete(this.turns.keys().next().value);
    }
  }
}

const tracker = new TurnCheckpointTracker();

export function beginTurnCheckpoint(conversationId, at = Date.now()) {
  return tracker.begin(conversationId, at);
}

export function appendTurnCheckpoint(result, {
  conversationId,
  tool,
  at = Date.now(),
} = {}) {
  if (String(tool || "") === "bridge_context") return result;
  const settings = loadTurnCheckpointSettings();
  if (!settings.enabled) return result;
  const message = tracker.claim(conversationId, at, settings.intervalMs);
  if (!message || !result || typeof result !== "object") return result;
  const content = Array.isArray(result.content) ? result.content : [];
  return {
    ...result,
    content: [
      ...content,
      {
        type: "text",
        text: message,
        annotations: {
          audience: ["assistant"],
          priority: 1,
        },
      },
    ],
  };
}

export function loadTurnCheckpointSettings() {
  const state = loadState();
  return normalizeTurnCheckpointSettings(state?.turnCheckpoint);
}

export function saveTurnCheckpointSettings(patch = {}) {
  const state = loadState();
  const current = normalizeTurnCheckpointSettings(state?.turnCheckpoint);
  const next = normalizeTurnCheckpointSettings({
    ...current,
    ...(Object.prototype.hasOwnProperty.call(patch, "enabled")
      ? { enabled: patch.enabled === true }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "intervalMs")
      ? { intervalMs: patch.intervalMs }
      : {}),
  });
  saveState({ ...state, turnCheckpoint: next });
  return next;
}

export function normalizeTurnCheckpointSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled !== false,
    intervalMs: normalizeCheckpointIntervalMs(source.intervalMs ?? TURN_CHECKPOINT_MS),
  };
}

function normalizeConversationId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function normalizeCheckpointIntervalMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return TURN_CHECKPOINT_MS;
  return Math.min(
    TURN_CHECKPOINT_MAX_MS,
    Math.max(TURN_CHECKPOINT_MIN_MS, Math.round(number)),
  );
}
