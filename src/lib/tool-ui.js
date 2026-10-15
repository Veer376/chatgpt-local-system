import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { isToolUiEnabled } from "./config.js";

export function registerOptionalAppTool(server, name, definition, resourceUri, handler) {
  if (!isToolUiEnabled(name)) return server.registerTool(name, definition, handler);
  return registerAppTool(server, name, {
    ...definition,
    _meta: { ui: { resourceUri } },
  }, handler);
}
