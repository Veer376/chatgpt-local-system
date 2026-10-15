import { z } from "zod";
import {
  clearRuntimeMemory,
  loadRuntimeMemory,
  RUNTIME_MEMORY_MAX_CHARS,
  writeRuntimeMemory,
} from "../lib/runtime-memory.js";
import { fail, structured } from "../lib/text.js";

export const RUNTIME_MEMORY_DESCRIPTION = "Read, write, or clear temporary working context for the current conversation so long-running work can resume reliably across turns and checkpoints.";

export function registerRuntimeMemory(server) {
  server.registerTool("runtime_memory", {
    title: "Runtime memory",
    description: RUNTIME_MEMORY_DESCRIPTION,
    inputSchema: {
      action: z.enum(["read", "write", "clear"]),
      content: z.string().min(1).max(RUNTIME_MEMORY_MAX_CHARS).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ action, content }) => {
    try {
      if (action !== "write" && content !== undefined) {
        return fail("runtime_memory content is only valid for write");
      }
      if (action === "read") {
        return structured("Runtime memory returned.", { runtimeMemory: loadRuntimeMemory() });
      }
      if (action === "write") {
        if (content === undefined) return fail("runtime_memory write requires content");
        return structured("Runtime memory updated.", { runtimeMemory: writeRuntimeMemory(content) });
      }
      clearRuntimeMemory();
      return structured("Runtime memory cleared.", { runtimeMemory: null });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
}
