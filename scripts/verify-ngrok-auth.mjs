#!/usr/bin/env node
import fs from "node:fs";
import dotenv from "dotenv";

const file = process.argv[2];
let token = "";
try {
  if (!file) throw new Error("missing configuration");
  token = String(dotenv.parse(fs.readFileSync(file)).MCP_TOKEN || "");
} catch {
  console.error("ngrok installation requires a readable runtime.env with MCP_TOKEN.");
  process.exit(2);
}
if (token.length < 32) {
  console.error("Refusing unauthenticated public MCP access: configure a unique MCP_TOKEN of at least 32 characters and an authenticated client before enabling ngrok.");
  process.exit(2);
}
// Do not output or log credentials.
