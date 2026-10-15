#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { HOST, ensureStateDirs, validateRuntimeConfig } from "./lib/config.js";
import { runWithConversationId } from "./lib/conversation.js";

validateRuntimeConfig(HOST);
ensureStateDirs();

const conversationId = process.env.LOCAL_SYSTEM_CONVERSATION_ID || "local-system";

process.on("uncaughtException", (error) => {
  process.stderr.write(`[stdio] Uncaught exception: ${error?.stack || error?.message || error}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[stdio] Unhandled rejection: ${reason?.stack || reason?.message || reason}\n`);
});

const server = createServer();
const transport = new StdioServerTransport();

await runWithConversationId(conversationId, async () => {
  await server.connect(transport);
});
