import { resolveActiveScopeKey } from "./conversation.js";
import { readConversationStateByKey, updateConversationStateByKey } from "./config.js";

const VALID_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

export function loadTodos(scopeOptions) {
  const scope = resolveActiveScopeKey(scopeOptions);
  const state = readConversationStateByKey(scope.key);
  return normalizeTodos(state?.todos);
}

export function writeTodos({ todos, merge }, scopeOptions) {
  const incoming = normalizeTodos(todos);
  if (incoming.length !== todos.length) throw new Error("invalid todo item");
  const seen = new Set();
  for (const item of incoming) {
    if (seen.has(item.id)) throw new Error(`duplicate todo id: ${item.id}`);
    seen.add(item.id);
  }

  const scope = resolveActiveScopeKey(scopeOptions);
  const next = merge ? mergeTodos(loadTodos(scopeOptions), incoming) : incoming;
  updateConversationStateByKey(scope.key, { todos: next });
  return next;
}

function mergeTodos(existing, incoming) {
  const replacements = new Map(incoming.map((item) => [item.id, item]));
  const existingIds = new Set(existing.map((item) => item.id));
  return [
    ...existing.map((item) => replacements.get(item.id) || item),
    ...incoming.filter((item) => !existingIds.has(item.id)),
  ];
}

function normalizeTodos(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => typeof item.id === "string" && item.id.length > 0)
    .filter((item) => typeof item.content === "string" && item.content.length <= 200)
    .filter((item) => VALID_STATUSES.has(item.status))
    .map((item) => ({ id: item.id, content: item.content, status: item.status }));
}
