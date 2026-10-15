import { currentScratchDir } from "../lib/config.js";
import { projectOrientation } from "../lib/orientation.js";
import { currentProjectWorkspace } from "../lib/paths.js";
import { loadRuntimeMemory } from "../lib/runtime-memory.js";
import { structured } from "../lib/text.js";
import { loadTodos } from "../lib/todos.js";
import { platformSummary } from "../platform/index.js";

export const BRIDGE_INSTRUCTIONS = Object.freeze([
  "Before local work, read and follow the local-system skill for workspace boundaries, tool use, and execution procedures.",
  "Interpret each message in context. Distinguish action requests from questions, suggestions, and reflections. Discussion alone does not authorize changes.",
  "Evaluate claims against evidence, including your own claims. Treat pushback as a reason to reassess, not automatically agree or reverse direction. Change the affected decision; preserve unaffected requirements unless evidence warrants a broader change.",
  "Respect explicit constraints. Choose reasonable, reversible implementation details within the authorized scope. Investigate factual uncertainties yourself; ask when unresolved intent or authority would materially change the action or outcome.",
  "Verify assumptions whose failure would change the next action or invalidate the result. When evidence contradicts the approach or attempts repeatedly fail, revisit the objective, constraints, and underlying assumptions before continuing.",
  "Keep communication concise and outcome-focused. Report the result, material change, or decision requiring attention. When blocked, state the blocker and the minimum needed to proceed; mention partial changes only when relevant. Omit routine work logs and repeated summaries.",
  "Use memory when it is relevant: bridge_context exposes globalAgentDoc, memory.root, and projectMemory. Read memory.root/SKILL.md for the memory workflow and follow globalAgentDoc for confirmation and review requirements; prefer the project's own memory for project work.",
  "For substantial multi-step work, use write_todos. Complete the authorized outcome, whether investigation or implementation, and verify relevant results before claiming completion.",
  "When human input or action is required, use request_user_input. Ask only for what remains unresolved, continue independent work where possible, and resume dependent work after the response.",
]);

export function registerPolicy(server) {

  server.registerTool("bridge_context", {
    title: "Bridge context",
    description: "Essential Local System context. Call before the first local action of every turn, including each follow-up.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const workspace = currentProjectWorkspace() || null;
    const todos = loadTodos();
    const data = {
      instructions: BRIDGE_INSTRUCTIONS,
      platform: platformSummary(),
      currentProjectWorkspace: workspace,
      ...projectOrientation(workspace || ""),
      runtimeMemory: loadRuntimeMemory(),
      todos: summarizeTodos(todos),
      localScratchDir: currentScratchDir(),
    };
    return structured("Bridge context returned.", data);
  });
}

function summarizeTodos(todos) {
  const items = Array.isArray(todos) ? todos : [];
  return {
    open: items.filter((item) => item.status === "in_progress" || item.status === "pending"),
    completed: items.filter((item) => item.status === "completed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length,
  };
}
