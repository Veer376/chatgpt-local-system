import { readConversationState, updateConversationState } from "./config.js";

export const RUNTIME_MEMORY_MAX_CHARS = 6_000;

export function loadRuntimeMemory() {
  const value = readConversationState()?.runtimeMemory;
  return typeof value === "string" ? value : null;
}

export function writeRuntimeMemory(content) {
  validateRuntimeMemoryContent(content);
  updateConversationState({ runtimeMemory: content });
  return content;
}

export function clearRuntimeMemory() {
  updateConversationState({ runtimeMemory: null });
  return null;
}

function validateRuntimeMemoryContent(content) {
  if (typeof content !== "string" || content.length < 1) {
    throw new Error("runtime_memory write requires content");
  }
  if (content.length > RUNTIME_MEMORY_MAX_CHARS) {
    throw new Error(`runtime_memory content must be ${RUNTIME_MEMORY_MAX_CHARS} characters or fewer`);
  }
}
