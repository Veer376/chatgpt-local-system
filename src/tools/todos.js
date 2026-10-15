import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { writeTodos } from "../lib/todos.js";
import { fail, structured } from "../lib/text.js";
import { registerOptionalAppTool } from "../lib/tool-ui.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TODOS_HTML = fs.readFileSync(path.resolve(here, "../apps/todos.html"), "utf8");
const TODOS_RESOURCE_URI = `ui://sol/todos-${crypto.createHash("sha256").update(TODOS_HTML).digest("hex").slice(0, 12)}.html`;

const todoSchema = z.object({
  id: z.string().min(1),
  content: z.string().max(200),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
}).strict();

export function registerTodos(server) {
  registerOptionalAppTool(server, "write_todos", {
    title: "Write todos",
    description: "Update the current conversation's todo list.",
    inputSchema: {
      todos: z.array(todoSchema).min(1),
      merge: z.boolean().describe("true merges by id; false (by default) replaces the list."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, TODOS_RESOURCE_URI, async ({ todos, merge }) => {
    try {
      const updated = writeTodos({ todos, merge });
      return structured("Todos updated.", { todos: updated });
    } catch (error) {
      return fail(error.message);
    }
  });

  registerAppResource(server, "Todos", TODOS_RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: TODOS_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: TODOS_HTML }],
  }));
}
