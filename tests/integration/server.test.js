import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = fs.mkdtempSync(path.join(os.homedir(), ".sol-integration-test-"));
const root = path.join(base, "workspace");
const outside = path.join(base, "outside");
const scratch = path.join(base, "scratch");
fs.mkdirSync(root);
fs.mkdirSync(outside);
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.BRIDGE_SCRATCH_DIR = scratch;
process.env.WORKSPACE_ROOTS = root;
process.env.DEFAULT_WORKSPACE = "";
process.env.MCP_TOKEN = "integration-secret";
process.env.HOST = "127.0.0.1";
process.env.TOOL_UI = "true";
process.env.TOOL_UI_APPLY_PATCH = "true";
process.env.TOOL_UI_EXECUTE_COMMAND = "false";
process.env.TOOL_UI_WRITE_TODOS = "true";
process.env.TOOL_UI_DISPLAY = "true";
process.env.TOOL_UI_DISCOVER_SKILLS = "true";
process.env.FILE_PREVIEW_CLOUD_ENABLED = "false";
process.env.BYPASS_SECURITY = "false";
const TEST_EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
process.env.LOCAL_EXTENSION_ORIGIN = TEST_EXTENSION_ORIGIN;
const { createApp, startHttpServer } = await import("../../src/server.js");
const { EXPECTED_TOOL_NAMES } = await import("../../src/tool-contract.js");
const { setUserQuestionServiceForTests } = await import("../../src/lib/user-question.js");
const { startBrowserInteraction } = await import("../../src/lib/browser-interaction.js");
const { issueBrowserBindingToken, recordRecentWebConversationFromBody } = await import("../../src/lib/local-todos.js");
const { runWithConversationId, conversationKey } = await import("../../src/lib/conversation.js");
const { writeTodos } = await import("../../src/lib/todos.js");
const { currentScratchDir, readConversationState, updateConversationState } = await import("../../src/lib/config.js");
const { recordToolStarted, recordToolCompleted } = await import("../../src/lib/local-tool-activity.js");

let humanResponse = { status: "answered", answer: "Deny", source: "test", custom: false, optionIndex: 1 };
let lastHumanQuestion = null;
setUserQuestionServiceForTests({
  async ask(input) {
    lastHumanQuestion = input;
    return humanResponse;
  },
});

const runtime = startHttpServer({ host: "127.0.0.1", port: 0 });
if (!runtime.httpServer.listening) await once(runtime.httpServer, "listening");
const port = runtime.httpServer.address().port;
const url = `http://127.0.0.1:${port}/mcp`;
const localUiOrigin = `http://127.0.0.1:${port}`;
const extensionSessionResponse = await fetch(`${localUiOrigin}/local-ui/auth/session`, {
  method: "POST",
  headers: { "content-type": "application/json", Origin: TEST_EXTENSION_ORIGIN },
  body: "{}",
});
assert.equal(extensionSessionResponse.status, 200);
const extensionSessionToken = (await extensionSessionResponse.json()).token;
assert.equal(typeof extensionSessionToken, "string");
assert.ok(extensionSessionToken.length >= 32);
const extensionHeaders = (extra = {}) => ({
  "content-type": "application/json",
  "x-local-system-session": extensionSessionToken,
  ...extra,
});
const client = new Client({ name: "integration-test", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: "Bearer integration-secret" } },
});
await client.connect(transport);

test.after(async () => {
  await client.close().catch(() => {});
  await runtime.shutdown("test");
  fs.rmSync(base, { recursive: true, force: true });
});

test("programmatic non-loopback host overrides still enforce bind policy", () => {
  assert.throws(() => createApp({ host: "0.0.0.0" }), /loopback-only/);
});

test("older scratch videos are searchable by normal filename and stream by absolute path", async () => {
  const oldScratchDir = path.join(scratch, "2026-09-01", "generated");
  fs.mkdirSync(oldScratchDir, { recursive: true });
  const mediaPath = path.join(oldScratchDir, "scratch-history-video-proof.mp4");
  const fd = fs.openSync(mediaPath, "w");
  try {
    fs.writeSync(fd, Buffer.from("TEST"));
    fs.ftruncateSync(fd, 130 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }

  const searchResponse = await fetch(`${localUiOrigin}/local-ui/files/search`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ query: "scratch-history-video-proof" }),
  });
  assert.equal(searchResponse.status, 200);
  const searchResult = await searchResponse.json();
  assert.ok(searchResult.files?.some((entry) => entry.path === mediaPath && entry.source === "scratch"));

  const resolveResponse = await fetch(`${localUiOrigin}/local-ui/files/resolve`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ path: mediaPath }),
  });
  assert.equal(resolveResponse.status, 200);
  const descriptor = await resolveResponse.json();
  assert.equal(descriptor.mimeType, "video/mp4");
  assert.equal(descriptor.bytes, 130 * 1024 * 1024);

  const initial = await fetch(descriptor.url, { headers: { Range: "bytes=0-3" } });
  assert.equal(initial.status, 206);
  assert.equal(initial.headers.get("accept-ranges"), "bytes");
  assert.equal(initial.headers.get("content-range"), `bytes 0-3/${descriptor.bytes}`);
  assert.equal(await initial.text(), "TEST");

  const suffix = await fetch(descriptor.url, { headers: { Range: "bytes=-4" } });
  assert.equal(suffix.status, 206);
  assert.equal((await suffix.arrayBuffer()).byteLength, 4);
  const invalid = await fetch(descriptor.url, { headers: { Range: "bytes=9999999999-" } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), `bytes */${descriptor.bytes}`);

  const relativeResponse = await fetch(`${localUiOrigin}/local-ui/files/resolve`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ path: "scratch-history-video-proof.mp4" }),
  });
  assert.notEqual(relativeResponse.status, 200, "a relative reference must not search unrelated scratch history");
});

test("occupied ports surface EADDRINUSE instead of reporting a successful start", async () => {
  const blocker = net.createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const occupiedPort = blocker.address().port;
  const failedRuntime = startHttpServer({ host: "127.0.0.1", port: occupiedPort });
  const [error] = await once(failedRuntime.httpServer, "error");
  assert.equal(error.code, "EADDRINUSE");
  assert.equal(failedRuntime.httpServer.listening, false);
  blocker.close();
  await once(blocker, "close");
});

test("HTTP endpoint enforces bearer authentication", async () => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(response.status, 401);
});

test("local UI rejects the legacy static extension header and requires an issued session", async () => {
  const legacy = await fetch(`${localUiOrigin}/local-ui/todos`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-system-extension": "1" },
    body: JSON.stringify({ threadId: "legacy-static-header" }),
  });
  assert.equal(legacy.status, 401);

  const missing = await fetch(`${localUiOrigin}/local-ui/todos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "missing-extension-session" }),
  });
  assert.equal(missing.status, 401);

  const authenticated = await fetch(`${localUiOrigin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: "valid-extension-session" }),
  });
  assert.equal(authenticated.status, 200);
});

test("local extension routes answer CORS preflight only for the configured extension origin", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const extensionOrigin = TEST_EXTENSION_ORIGIN;
  const safariOrigin = "safari-web-extension://com.example.local-system";
  const previousOrigin = process.env.LOCAL_EXTENSION_ORIGIN;
  process.env.LOCAL_EXTENSION_ORIGIN = extensionOrigin;
  try {
    const allowed = await fetch(`${origin}/local-ui/todos`, {
      method: "OPTIONS",
      headers: {
        Origin: extensionOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-local-system-session",
      },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), extensionOrigin);
    assert.match(allowed.headers.get("access-control-allow-methods") || "", /POST/);
    assert.match(allowed.headers.get("access-control-allow-headers") || "", /X-Local-System-Session/i);

    const safariAllowed = await fetch(`${origin}/local-ui/todos`, {
      method: "OPTIONS",
      headers: {
        Origin: safariOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-local-system-session,authorization,ngrok-skip-browser-warning",
      },
    });
    assert.equal(safariAllowed.status, 204);
    assert.equal(safariAllowed.headers.get("access-control-allow-origin"), safariOrigin);
    assert.match(safariAllowed.headers.get("access-control-allow-headers") || "", /Authorization/i);
    assert.match(safariAllowed.headers.get("access-control-allow-headers") || "", /Ngrok-Skip-Browser-Warning/i);

    const denied = await fetch(`${origin}/local-ui/todos`, {
      method: "OPTIONS",
      headers: {
        Origin: "chrome-extension://pppppppppppppppppppppppppppppppp",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-local-system-session",
      },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);

    const deniedSession = await fetch(`${origin}/local-ui/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://example.com" },
      body: "{}",
    });
    assert.equal(deniedSession.status, 403);
  } finally {
    if (previousOrigin === undefined) delete process.env.LOCAL_EXTENSION_ORIGIN;
    else process.env.LOCAL_EXTENSION_ORIGIN = previousOrigin;
  }
});

test("remote Local System UI requests fail closed and require matching Safari bridge Basic Auth", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const previousPassword = process.env.SAFARI_BRIDGE_PASSWORD;
  const previousUsername = process.env.SAFARI_BRIDGE_USERNAME;
  const remoteHeaders = {
    ...extensionHeaders(),
    "x-forwarded-for": "203.0.113.7",
  };
  const body = JSON.stringify({ threadId: "remote-auth-test-thread" });
  try {
    process.env.SAFARI_BRIDGE_PASSWORD = "";
    process.env.SAFARI_BRIDGE_USERNAME = "mobile-test";
    const unconfigured = await fetch(`${origin}/local-ui/todos`, {
      method: "POST",
      headers: remoteHeaders,
      body,
    });
    assert.equal(unconfigured.status, 503);

    process.env.SAFARI_BRIDGE_PASSWORD = "integration-mobile-secret";
    const unauthorized = await fetch(`${origin}/local-ui/todos`, {
      method: "POST",
      headers: remoteHeaders,
      body,
    });
    assert.equal(unauthorized.status, 401);

    const authorization = `Basic ${Buffer.from("mobile-test:integration-mobile-secret").toString("base64")}`;
    const authorized = await fetch(`${origin}/local-ui/todos`, {
      method: "POST",
      headers: { ...remoteHeaders, authorization },
      body,
    });
    assert.equal(authorized.status, 200);
  } finally {
    if (previousPassword === undefined) delete process.env.SAFARI_BRIDGE_PASSWORD;
    else process.env.SAFARI_BRIDGE_PASSWORD = previousPassword;
    if (previousUsername === undefined) delete process.env.SAFARI_BRIDGE_USERNAME;
    else process.env.SAFARI_BRIDGE_USERNAME = previousUsername;
  }
});

test("unbound browser chats can discover and resolve personal skills ephemerally", async () => {
  const origin = `http://127.0.0.1:${port}`;

  const searchResponse = await fetch(`${origin}/local-ui/skills`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: "", action: "search", query: "local system", active: true }),
  });
  assert.equal(searchResponse.status, 200);
  const searchPayload = await searchResponse.json();
  assert.equal(searchPayload.bound, false);
  assert.equal(searchPayload.skills?.[0]?.name, "local-system");

  const attachResponse = await fetch(`${origin}/local-ui/skills`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: "", action: "attach", name: "local-system", active: true }),
  });
  assert.equal(attachResponse.status, 200);
  const attachPayload = await attachResponse.json();
  assert.equal(attachPayload.bound, false);
  assert.equal(attachPayload.ephemeral, true);
  assert.equal(attachPayload.attachments?.[0]?.name, "local-system");
  assert.match(attachPayload.attachments?.[0]?.path || "", /skills\/local-system\/SKILL\.md$/);
  assert.match(attachPayload.attachments?.[0]?.contents || "", /local system/i);
});

test("local image bridge resolves only authorized images into short-lived opaque URLs", async () => {
  const image = path.join(root, "local-inline.png");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nS8AAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(image, imageBytes);

  const origin = `http://127.0.0.1:${port}`;
  const missingHeader = await fetch(`${origin}/local-image/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: image }),
  });
  assert.equal(missingHeader.status, 403);

  const resolved = await fetch(`${origin}/local-image/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-system-image": "1" },
    body: JSON.stringify({ path: image }),
  });
  assert.equal(resolved.status, 200);
  const descriptor = await resolved.json();
  assert.match(descriptor.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/local-image/[A-Za-z0-9_-]+$`));
  assert.equal(descriptor.mimeType, "image/png");
  assert.equal(descriptor.bytes, imageBytes.length);
  assert.equal(descriptor.url.includes(encodeURIComponent(image)), false, "opaque URL must not expose the local path");

  const served = await fetch(descriptor.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), imageBytes);

  const outsideImage = path.join(outside, "outside.png");
  fs.writeFileSync(outsideImage, imageBytes);
  const denied = await fetch(`${origin}/local-image/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-system-image": "1" },
    body: JSON.stringify({ path: outsideImage }),
  });
  assert.equal(denied.status, 403);

  const conversationId = "v1/local-image-relative";
  const threadId = "8cc5a111-37d2-4d99-98c1-2d8eb7d2a110";
  const sentAt = Date.now();
  runWithConversationId(conversationId, () => updateConversationState({ currentWorkspace: root }));
  recordRecentWebConversationFromBody({
    params: {
      _meta: {
        "openai/session": conversationId,
        "openai/userAgent": "Mozilla/5.0 Chrome/152.0",
      },
    },
  });
  const bindResponse = await fetch(`${origin}/local-ui/thread-bind`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, sentAt }),
  });
  assert.equal((await bindResponse.json()).bound, true);

  const relativeImage = path.join(root, "assets", "relative.png");
  fs.mkdirSync(path.dirname(relativeImage), { recursive: true });
  fs.writeFileSync(relativeImage, imageBytes);
  const relativeResolved = await fetch(`${origin}/local-image/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-system-image": "1" },
    body: JSON.stringify({ path: "assets/relative.png", threadId }),
  });
  assert.equal(relativeResolved.status, 200, "relative images resolve from the current workspace first");
  assert.equal((await relativeResolved.json()).mimeType, "image/png");

  const threadScratch = path.join(scratch, conversationKey(conversationId));
  fs.mkdirSync(threadScratch, { recursive: true });
  fs.writeFileSync(path.join(threadScratch, "scratch-image.png"), imageBytes);
  const scratchResolved = await fetch(`${origin}/local-image/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-system-image": "1" },
    body: JSON.stringify({ path: "scratch-image.png", threadId }),
  });
  assert.equal(scratchResolved.status, 200, "relative images fall back to conversation scratch");
});

test("unbound chats can search, attach, edit, and stage authorized local files", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "9dd6b222-48e3-4eaa-87d2-3e9fc8e3b221";
  const file = path.join(root, "unbound-file.txt");
  fs.writeFileSync(file, "before\n");

  const searchResponse = await fetch(`${origin}/local-ui/files/search`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, query: "unbound file", active: true }),
  });
  assert.equal(searchResponse.status, 200);
  const search = await searchResponse.json();
  assert.equal(search.bound, false);
  assert.equal(search.files?.[0]?.path, file);

  const resolveResponse = await fetch(`${origin}/local-ui/files/resolve`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, path: file, active: true }),
  });
  assert.equal(resolveResponse.status, 200);
  const descriptor = await resolveResponse.json();
  assert.equal(descriptor.name, "unbound-file.txt");

  const workspaceUpdate = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      action: "update",
      workspace: { openPaths: [file], activePath: file, sidebarOpen: true, width: 720 },
    }),
  });
  assert.equal(workspaceUpdate.status, 200);
  const staged = await workspaceUpdate.json();
  assert.equal(staged.bound, false);
  assert.equal(staged.workspace?.activePath, file);
  assert.equal(staged.workspace?.sidebarOpen, true);
  assert.equal(staged.workspace?.treeCollapsed, true, "project tree defaults to collapsed");

  const writeResponse = await fetch(`${origin}/local-ui/files/write`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      path: file,
      content: "after\n",
      expectedLastModified: descriptor.lastModified,
      expectedBytes: descriptor.bytes,
      active: true,
    }),
  });
  assert.equal(writeResponse.status, 200);
  assert.equal(fs.readFileSync(file, "utf8"), "after\n");
});

test("absolute Local System scratch files open and edit without becoming the selected project", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "scratch-authorized-root-" + Date.now();
  const scratchFile = path.join(currentScratchDir(), "workspace-authorized-scratch.md");
  fs.writeFileSync(scratchFile, "scratch before\n");

  try {
    const selectResponse = await fetch(`${origin}/local-ui/file-workspace`, {
      method: "POST",
      headers: extensionHeaders(),
      body: JSON.stringify({ threadId, action: "select_project", path: root }),
    });
    assert.equal(selectResponse.status, 200);
    assert.equal((await selectResponse.json()).currentWorkspace, fs.realpathSync(root));

    const resolveResponse = await fetch(`${origin}/local-ui/files/resolve`, {
      method: "POST",
      headers: extensionHeaders(),
      body: JSON.stringify({ threadId, path: scratchFile, active: false }),
    });
    assert.equal(resolveResponse.status, 200);
    const descriptor = await resolveResponse.json();
    assert.equal(descriptor.path, fs.realpathSync(scratchFile));

    const openResponse = await fetch(`${origin}/local-ui/file-workspace`, {
      method: "POST",
      headers: extensionHeaders(),
      body: JSON.stringify({ threadId, action: "open_file", path: scratchFile }),
    });
    assert.equal(openResponse.status, 200);
    const opened = await openResponse.json();
    assert.equal(opened.currentWorkspace, fs.realpathSync(root));
    assert.equal(opened.workspace.activePath, fs.realpathSync(scratchFile));
    assert.ok(opened.workspace.openPaths.includes(fs.realpathSync(scratchFile)));

    const writeResponse = await fetch(`${origin}/local-ui/files/write`, {
      method: "POST",
      headers: extensionHeaders(),
      body: JSON.stringify({
        threadId,
        path: scratchFile,
        content: "scratch after\n",
        expectedLastModified: descriptor.lastModified,
        expectedBytes: descriptor.bytes,
        active: false,
      }),
    });
    assert.equal(writeResponse.status, 200);
    assert.equal(fs.readFileSync(scratchFile, "utf8"), "scratch after\n");

    const contextResponse = await fetch(`${origin}/local-ui/file-workspace`, {
      method: "POST",
      headers: extensionHeaders(),
      body: JSON.stringify({ threadId, action: "context" }),
    });
    assert.equal(contextResponse.status, 200);
    assert.equal((await contextResponse.json()).currentWorkspace, fs.realpathSync(root));
  } finally {
    fs.rmSync(scratchFile, { force: true });
  }
});

test("HTML workspace preview serves current source and relative project assets through an opaque route", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "9dd6b222-48e3-4eaa-87d2-3e9fc8e3b299";
  const previewDir = path.join(root, "html-preview");
  const htmlFile = path.join(previewDir, "index.html");
  const scriptFile = path.join(previewDir, "app.js");
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(htmlFile, "<p>disk source</p>");
  fs.writeFileSync(scriptFile, "window.previewAssetLoaded = true;\n");

  const response = await fetch(`${origin}/local-ui/files/html-preview`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      path: htmlFile,
      content: '<!doctype html><script src="./app.js"></script><p>unsaved preview source</p>',
      active: true,
    }),
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.match(preview.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/local-preview/[A-Za-z0-9_-]+/index\\.html$`));
  assert.equal(preview.url.includes(encodeURIComponent(htmlFile)), false, "preview URL must not expose the local path");

  const documentResponse = await fetch(preview.url);
  assert.equal(documentResponse.status, 200);
  assert.match(documentResponse.headers.get("content-type") || "", /^text\/html/);
  assert.equal(await documentResponse.text(), '<!doctype html><script src="./app.js"></script><p>unsaved preview source</p>');

  const assetResponse = await fetch(new URL("app.js", preview.url));
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get("content-type") || "", /^text\/javascript/);
  assert.equal(assetResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(await assetResponse.text(), "window.previewAssetLoaded = true;\n");
});

test("a browser send intent binds when the matching web MCP conversation arrives", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "9ef7c333-59f4-4fbb-98e3-4f0ad9f4c332";
  const conversationId = "v1/browser-send-intent";
  const sentAt = Date.now();

  const intentResponse = await fetch(`${origin}/local-ui/thread-bind-intent`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, sentAt }),
  });
  assert.equal(intentResponse.status, 200);
  const intent = await intentResponse.json();
  assert.equal(intent.registered, true);
  assert.equal(intent.bound, false);

  runWithConversationId(conversationId, () => {
    updateConversationState({ currentWorkspace: root });
    writeTodos({ todos: [{ id: "intent", content: "Intent matched", status: "pending" }], merge: false });
  });
  recordRecentWebConversationFromBody({
    params: {
      _meta: {
        "openai/session": conversationId,
        "openai/userAgent": "Mozilla/5.0 Chrome/152.0",
      },
    },
  });

  const todosResponse = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, active: false }),
  });
  assert.equal(todosResponse.status, 200);
  const todos = await todosResponse.json();
  assert.equal(todos.bound, true);
  assert.deepEqual(todos.todos, [{ id: "intent", content: "Intent matched", status: "pending" }]);

  const contextResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "context", active: false }),
  });
  const context = await contextResponse.json();
  assert.equal(context.bound, true);
  assert.equal(context.currentWorkspace, root);

});

test("bound browser threads can receive and answer pending Local System interactions", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "b783a617-3cdf-4b65-a94c-bef7e62ecfee";
  const conversationId = "v1/browser-interaction-route";
  const sentAt = Date.now();

  const intentResponse = await fetch(`${origin}/local-ui/thread-bind-intent`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, sentAt }),
  });
  assert.equal(intentResponse.status, 200);
  recordRecentWebConversationFromBody({
    params: {
      _meta: {
        "openai/session": conversationId,
        "openai/userAgent": "Mozilla/5.0 Chrome/152.0",
      },
    },
  });

  const handle = startBrowserInteraction({
    conversationId,
    requestId: "ask_route_1",
    question: "Choose",
    options: ["One", "Two"],
    questionIndex: 0,
    questionCount: 2,
  });
  const getResponse = await fetch(`${origin}/local-ui/interactions`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ action: "get", threadId }),
  });
  assert.equal(getResponse.status, 200);
  const pending = await getResponse.json();
  assert.equal(pending.bound, true);
  assert.equal(pending.interaction?.id, "ask_route_1");
  assert.equal(pending.interaction?.questionCount, 2);

  const response = await fetch(`${origin}/local-ui/interactions`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ action: "respond", threadId, requestId: "ask_route_1", answer: "Two" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).interaction, null);
  const result = await handle.promise;
  assert.equal(result.source, "browser");
  assert.equal(result.answer, "Two");
  assert.equal(result.optionIndex, 1);
});

test("file workspace watch long-poll reports external filesystem changes", async () => {
  const threadId = "watch-route-" + Date.now();
  const selectResponse = await fetch(localUiOrigin + "/local-ui/file-workspace", {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "select_project", path: root }),
  });
  assert.equal(selectResponse.status, 200);

  const watchResponsePromise = fetch(localUiOrigin + "/local-ui/file-workspace", {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "watch", since: 0 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const watchedFile = path.join(root, "watch-" + Date.now() + ".txt");
  fs.writeFileSync(watchedFile, "external change\n");
  try {
    const watchResponse = await watchResponsePromise;
    assert.equal(watchResponse.status, 200);
    const payload = await watchResponse.json();
    assert.equal(payload.watch?.changed, true);
    assert.ok(Number(payload.watch?.version) >= 1);
    assert.equal(payload.watch?.workspace, fs.realpathSync(root));
    assert.equal(payload.watch?.event?.gitOnly, false);
  } finally {
    fs.rmSync(watchedFile, { force: true });
  }
});

test("project picker keeps dot folders clean by default and includes them on request", async () => {
  const visibleProject = path.join(root, "visible-picker-project");
  const hiddenProject = path.join(root, ".hidden-picker-project");
  fs.mkdirSync(visibleProject, { recursive: true });
  fs.mkdirSync(hiddenProject, { recursive: true });
  const threadId = "project-picker-hidden-" + Date.now();
  try {
    const projectsResponse = await fetch(`${localUiOrigin}/local-ui/file-workspace`, {
      method: "POST",
      headers: extensionHeaders(),
      body: JSON.stringify({ threadId, action: "projects" }),
    });
    assert.equal(projectsResponse.status, 200);
    const projects = await projectsResponse.json();
    assert.ok(projects.projects.some((project) => project.path === fs.realpathSync(visibleProject)));
    assert.equal(projects.projects.some((project) => project.path === fs.realpathSync(hiddenProject)), false);

    const hiddenResponse = await fetch(`${localUiOrigin}/local-ui/file-workspace`, {
      method: "POST",
      headers: extensionHeaders(),
      body: JSON.stringify({ threadId, action: "projects", includeHidden: true }),
    });
    assert.equal(hiddenResponse.status, 200);
    const withHidden = await hiddenResponse.json();
    assert.ok(withHidden.projects.some((project) => project.path === fs.realpathSync(hiddenProject)));
  } finally {
    fs.rmSync(visibleProject, { recursive: true, force: true });
    fs.rmSync(hiddenProject, { recursive: true, force: true });
  }
});

test("file workspace project selection updates the authoritative bound project and keeps thread fallback synchronized", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "6a0c2dc6-9497-4c21-9f72-27d848459f86";
  const conversationId = "v1/browser-project-switch";
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const nested = path.join(projectB, "src");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(projectB, "node_modules"), { recursive: true });
  const oldFile = path.join(projectA, "old.js");
  const newFile = path.join(nested, "index.js");
  fs.writeFileSync(oldFile, "old\n");
  fs.writeFileSync(newFile, "new\nworkspace-search-needle lives here\n");

  runWithConversationId(conversationId, () => {
    updateConversationState({
      currentWorkspace: projectA,
      fileWorkspace: {
        openPaths: [oldFile],
        activePath: oldFile,
        sidebarOpen: true,
        width: 680,
        treeCollapsed: false,
        editorCollapsed: false,
        treeHeight: 280,
        annotations: [{
          id: "old-project-note",
          path: oldFile,
          comment: "Old project annotation",
          quote: "old",
          prefix: "",
          suffix: "\n",
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 4, offset: 3 },
        }],
      },
    });
  });
  const sentAt = Date.now();
  recordRecentWebConversationFromBody({
    params: {
      _meta: {
        "openai/session": conversationId,
        "openai/userAgent": "Mozilla/5.0 Chrome/152.0",
      },
    },
  });
  const bindResponse = await fetch(`${origin}/local-ui/thread-bind`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, sentAt }),
  });
  assert.equal(bindResponse.status, 200);
  assert.equal((await bindResponse.json()).bound, true);

  const projectsResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "projects" }),
  });
  assert.equal(projectsResponse.status, 200);
  const projects = await projectsResponse.json();
  assert.ok(projects.projects.some((item) => item.path === projectA));
  assert.ok(projects.projects.some((item) => item.path === projectB));
  assert.equal(projects.bound, true);
  assert.equal(projects.currentWorkspace, projectA);
  assert.equal(projects.projectSource, "binding");
  assert.equal(projects.threadWorkspace, projectA);

  const switchResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "select_project", path: projectB }),
  });
  assert.equal(switchResponse.status, 200);
  const switched = await switchResponse.json();
  assert.equal(switched.previousWorkspace, projectA);
  assert.equal(switched.currentWorkspace, projectB);
  assert.equal(switched.projectSource, "binding");
  assert.equal(switched.threadWorkspace, projectB);
  assert.deepEqual(switched.workspace.openPaths, []);
  assert.equal(switched.workspace.activePath, "");
  assert.deepEqual(switched.workspace.annotations, [], "file annotations from the previous project do not bleed into the new project");

  const openFileResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "open_file", path: newFile }),
  });
  assert.equal(openFileResponse.status, 200);
  const openedFile = await openFileResponse.json();
  assert.deepEqual(openedFile.workspace.openPaths, [newFile]);
  assert.equal(openedFile.workspace.activePath, newFile);
  assert.equal(openedFile.workspace.activeScrollTop, 0);

  const uiStateResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      action: "update",
      workspace: {
        leftMode: "git",
        activeScrollTop: 437,
        treeCollapsed: true,
        previewViewByPath: { [newFile]: "raw" },
      },
    }),
  });
  assert.equal(uiStateResponse.status, 200);
  const uiState = await uiStateResponse.json();
  assert.equal(uiState.workspace.leftMode, "git");
  assert.equal(uiState.workspace.activeScrollTop, 437);
  assert.equal(uiState.workspace.treeCollapsed, true);
  assert.equal(uiState.workspace.previewViewByPath[newFile], "raw");

  const persistedUiStateResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "get" }),
  });
  assert.equal(persistedUiStateResponse.status, 200);
  const persistedUiState = await persistedUiStateResponse.json();
  assert.equal(persistedUiState.workspace.leftMode, "git");
  assert.equal(persistedUiState.workspace.activeScrollTop, 437);
  assert.equal(persistedUiState.workspace.previewViewByPath[newFile], "raw");
  assert.equal(switched.workspace.sidebarOpen, true, "switching projects preserves whether the project pane is open");
  assert.equal(switched.workspace.treeCollapsed, true, "switching projects defaults the project tree to collapsed");
  assert.equal(switched.workspace.treeHeight, 257, "the previous Files-pane defaults migrate to the new wider width");
  const storedAfterSwitch = runWithConversationId(conversationId, () => readConversationState());
  assert.equal(storedAfterSwitch.currentWorkspace, projectB, "project picker updates the authoritative bound workspace");
  assert.equal(storedAfterSwitch.workspaceSelection?.source, "user");
  assert.equal(storedAfterSwitch.workspaceSelection?.previousWorkspace, projectA);

  const rootListResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "list_directory" }),
  });
  assert.equal(rootListResponse.status, 200);
  const rootList = await rootListResponse.json();
  assert.deepEqual(rootList.entries.map((item) => [item.name, item.type]), [["src", "dir"]]);

  const nestedListResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "list_directory", path: nested }),
  });
  assert.equal(nestedListResponse.status, 200);
  const nestedList = await nestedListResponse.json();
  assert.deepEqual(nestedList.entries.map((item) => [item.name, item.type]), [["index.js", "file"]]);

  const textSearchResponse = await fetch(`${origin}/local-ui/files/content-search`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, query: "workspace-search-needle" }),
  });
  assert.equal(textSearchResponse.status, 200);
  const textSearch = await textSearchResponse.json();
  assert.equal(textSearch.currentWorkspace, projectB);
  assert.equal(textSearch.total, 1);
  assert.equal(textSearch.matches?.[0]?.path, newFile);
  assert.equal(textSearch.matches?.[0]?.line, 2);
  assert.match(textSearch.matches?.[0]?.preview || "", /workspace-search-needle lives here/);

  const workspaceOnlySearchResponse = await fetch(`${origin}/local-ui/files/search`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, query: "old.js", workspaceOnly: true }),
  });
  assert.equal(workspaceOnlySearchResponse.status, 200);
  const workspaceOnlySearch = await workspaceOnlySearchResponse.json();
  assert.deepEqual(workspaceOnlySearch.files, [], "workspace search does not leak file results from another authorized project");

  const emptySidebarResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "update", workspace: { openPaths: [], activePath: "", sidebarOpen: true, editorCollapsed: true } }),
  });
  assert.equal(emptySidebarResponse.status, 200);
  const emptySidebar = await emptySidebarResponse.json();
  assert.equal(emptySidebar.workspace.sidebarOpen, true, "tree-only sidebar stays open with no file tabs");
  assert.equal(emptySidebar.workspace.editorCollapsed, false, "legacy editor-collapse requests are ignored");

  const returnToBoundResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "select_project", path: projectA }),
  });
  assert.equal(returnToBoundResponse.status, 200);
  const returned = await returnToBoundResponse.json();
  assert.equal(returned.currentWorkspace, projectA);
  assert.equal(returned.projectSource, "binding");
  assert.equal(returned.threadWorkspace, projectA);
  assert.deepEqual(returned.workspace.openPaths, [], "switching projects starts a clean file set for the selected project");

  runWithConversationId(conversationId, () => updateConversationState({ currentWorkspace: projectB }));
  const reboundContextResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "context" }),
  });
  assert.equal(reboundContextResponse.status, 200);
  const reboundContext = await reboundContextResponse.json();
  assert.equal(reboundContext.currentWorkspace, projectB, "bound conversation changes supersede the saved thread fallback");
  assert.equal(reboundContext.projectSource, "binding");
  assert.equal(reboundContext.threadWorkspace, projectB, "thread fallback self-heals to the authoritative bound project");
});

test("thread-saved project is the unbound fallback but an existing bound workspace wins after binding", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "dbfe8f21-31b7-4ed5-a49b-18dd79d4a337";
  const conversationId = "v1/browser-project-before-bind";
  const previousProject = path.join(root, "prebind-old-project");
  const selectedProject = path.join(root, "prebind-selected-project");
  fs.mkdirSync(previousProject, { recursive: true });
  fs.mkdirSync(selectedProject, { recursive: true });
  const selectedRelativeFile = path.join(selectedProject, "library", "story.md");
  fs.mkdirSync(path.dirname(selectedRelativeFile), { recursive: true });
  fs.writeFileSync(selectedRelativeFile, "selected project story\n");

  const stageResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "select_project", path: selectedProject }),
  });
  assert.equal(stageResponse.status, 200);
  const staged = await stageResponse.json();
  assert.equal(staged.bound, false);
  assert.equal(staged.currentWorkspace, selectedProject);
  assert.equal(staged.projectSource, "thread");
  assert.equal(staged.threadWorkspace, selectedProject);

  const threadProjectsFile = path.join(process.env.BRIDGE_STATE_DIR, "browser-thread-projects.json");
  const persistedThreadProjects = JSON.parse(fs.readFileSync(threadProjectsFile, "utf8"));
  assert.ok(
    Object.values(persistedThreadProjects.projects || {}).some((item) => item?.workspace === selectedProject),
    "thread project fallback persists on disk across browser/server restarts",
  );

  const relativeResolveBeforeBindResponse = await fetch(`${origin}/local-ui/files/resolve`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, path: "library/story.md", active: true }),
  });
  assert.equal(relativeResolveBeforeBindResponse.status, 200);
  const relativeResolveBeforeBind = await relativeResolveBeforeBindResponse.json();
  assert.equal(relativeResolveBeforeBind.path, selectedRelativeFile);
  assert.equal(await (await fetch(relativeResolveBeforeBind.url)).text(), "selected project story\n");

  runWithConversationId(conversationId, () => updateConversationState({ currentWorkspace: previousProject }));
  const sentAt = Date.now();
  recordRecentWebConversationFromBody({
    params: {
      _meta: {
        "openai/session": conversationId,
        "openai/userAgent": "Mozilla/5.0 Chrome/152.0",
      },
    },
  });
  const bindResponse = await fetch(`${origin}/local-ui/thread-bind`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, sentAt }),
  });
  assert.equal(bindResponse.status, 200);
  assert.equal((await bindResponse.json()).bound, true);

  const contextResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "context" }),
  });
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();
  assert.equal(context.bound, true);
  assert.equal(context.currentWorkspace, previousProject);
  assert.equal(context.projectSource, "binding");
  assert.equal(context.threadWorkspace, previousProject);
  const stored = runWithConversationId(conversationId, () => readConversationState());
  assert.equal(stored.currentWorkspace, previousProject, "existing binding is authoritative");
});

test("thread-saved project is promoted when a newly bound conversation has no current workspace", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "1e21ab77-81ad-41e4-a451-a7cfa574f398";
  const conversationId = "v1/browser-project-fallback-promotion";
  const selectedProject = path.join(root, "prebind-fallback-project");
  fs.mkdirSync(selectedProject, { recursive: true });

  const stageResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "select_project", path: selectedProject }),
  });
  assert.equal(stageResponse.status, 200);
  const staged = await stageResponse.json();
  assert.equal(staged.bound, false);
  assert.equal(staged.currentWorkspace, selectedProject);
  assert.equal(staged.projectSource, "thread");

  runWithConversationId(conversationId, () => updateConversationState({ currentWorkspace: "" }));
  const sentAt = Date.now();
  recordRecentWebConversationFromBody({
    params: {
      _meta: {
        "openai/session": conversationId,
        "openai/userAgent": "Mozilla/5.0 Chrome/152.0",
      },
    },
  });
  const bindResponse = await fetch(`${origin}/local-ui/thread-bind`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, sentAt }),
  });
  assert.equal(bindResponse.status, 200);
  assert.equal((await bindResponse.json()).bound, true);

  const contextResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "context" }),
  });
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();
  assert.equal(context.bound, true);
  assert.equal(context.currentWorkspace, selectedProject);
  assert.equal(context.projectSource, "binding");
  assert.equal(context.threadWorkspace, selectedProject);
  const stored = runWithConversationId(conversationId, () => readConversationState());
  assert.equal(stored.currentWorkspace, selectedProject);
  assert.equal(stored.workspaceSelection?.source, "thread-fallback");
});

test("local Git bridge returns status, gutter ranges, and read-only textual diffs", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "git-workspace-test-thread";
  const gitWorkspace = path.join(root, "git-ui-workspace");
  fs.mkdirSync(gitWorkspace, { recursive: true });

  const git = (...args) => spawnSync("git", args, { cwd: gitWorkspace, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("config", "user.email", "local-system@example.test").status, 0);
  assert.equal(git("config", "user.name", "Local System Test").status, 0);
  fs.writeFileSync(path.join(gitWorkspace, "tracked.txt"), "before\n");
  fs.writeFileSync(path.join(gitWorkspace, "deleted.txt"), "gone\n");
  assert.equal(git("add", "tracked.txt", "deleted.txt").status, 0);
  assert.equal(git("commit", "-q", "-m", "baseline").status, 0);
  fs.writeFileSync(path.join(gitWorkspace, "tracked.txt"), "after\n");
  fs.rmSync(path.join(gitWorkspace, "deleted.txt"));
  fs.writeFileSync(path.join(gitWorkspace, "untracked.txt"), "fresh\n");

  const workspaceResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "select_project", path: gitWorkspace }),
  });
  assert.equal(workspaceResponse.status, 200);

  const gitRequest = async (body) => {
    const response = await fetch(`${origin}/local-ui/git`, {
      method: "POST",
      headers: extensionHeaders(),
      body: JSON.stringify({ threadId, ...body }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const status = await gitRequest({ action: "status", force: true });
  assert.equal(status.repository, true);
  assert.equal(status.repoRoot, fs.realpathSync(gitWorkspace));
  assert.ok(status.files.some((file) => file.path === "tracked.txt" && file.unstaged));
  assert.ok(status.files.some((file) => file.path === "deleted.txt" && file.kind === "deleted"));
  assert.ok(status.files.some((file) => file.path === "untracked.txt" && file.untracked));

  const changes = await gitRequest({ action: "file_changes", path: path.join(gitWorkspace, "tracked.txt") });
  assert.equal(changes.changed, true);
  assert.ok(changes.ranges.some((range) => range.type === "modified"));

  const trackedDiff = await gitRequest({ action: "file_diff", path: path.join(gitWorkspace, "tracked.txt") });
  assert.match(trackedDiff.diff, /-before/);
  assert.match(trackedDiff.diff, /\+after/);

  const deletedDiff = await gitRequest({ action: "file_diff", path: path.join(gitWorkspace, "deleted.txt") });
  assert.match(deletedDiff.diff, /deleted file mode/);
  assert.match(deletedDiff.diff, /-gone/);

  const untrackedDiff = await gitRequest({ action: "file_diff", path: path.join(gitWorkspace, "untracked.txt") });
  assert.match(untrackedDiff.diff, /new file mode/);
  assert.match(untrackedDiff.diff, /--- \/dev\/null/);
  assert.match(untrackedDiff.diff, /\+fresh/);

  const displayChanges = await call("display", { changes: true, path: gitWorkspace });
  assertOk(displayChanges);
  assert.equal(displayChanges.structuredContent?.kind, "display");
  assert.equal(displayChanges.structuredContent?.type, "changes");
  assert.equal(displayChanges.structuredContent?.clean, false);
  assert.equal(typeof displayChanges.structuredContent?.resumeToken, "string");
  assert.equal(displayChanges.structuredContent?.files?.length, 3);
  assert.ok(displayChanges.structuredContent.files.some((file) => file.path === "tracked.txt"));
  assert.ok(displayChanges.structuredContent.files.some((file) => file.path === "deleted.txt"));
  assert.ok(displayChanges.structuredContent.files.some((file) => file.path === "untracked.txt"));
  assert.doesNotMatch(textOf(displayChanges), /-before|\+after|\+fresh/);
  const loadedChanges = await call("load_display_content", { token: displayChanges.structuredContent.token });
  assert.match(textOf(loadedChanges), /-before/);
  assert.match(textOf(loadedChanges), /\+after/);
  assert.match(textOf(loadedChanges), /deleted file mode/);
  assert.match(textOf(loadedChanges), /\+fresh/);

  const filteredChanges = await call("display", {
    changes: true,
    path: [
      path.join(gitWorkspace, "tracked.txt"),
      path.join(gitWorkspace, "untracked.txt"),
    ],
  });
  assertOk(filteredChanges);
  assert.equal(filteredChanges.structuredContent?.files?.length, 2);
  assert.ok(filteredChanges.structuredContent.files.some((file) => file.path === "tracked.txt"));
  assert.ok(filteredChanges.structuredContent.files.some((file) => file.path === "untracked.txt"));
  assert.ok(!filteredChanges.structuredContent.files.some((file) => file.path === "deleted.txt"));
  const loadedFilteredChanges = await call("load_display_content", { token: filteredChanges.structuredContent.token });
  assert.match(textOf(loadedFilteredChanges), /-before/);
  assert.match(textOf(loadedFilteredChanges), /\+after/);
  assert.match(textOf(loadedFilteredChanges), /\+fresh/);
  assert.doesNotMatch(textOf(loadedFilteredChanges), /deleted file mode/);

  fs.writeFileSync(path.join(gitWorkspace, "tracked.txt"), "after again\n");
  const refreshedChanges = await call("refresh_display_content", {
    resumeToken: filteredChanges.structuredContent.resumeToken,
  });
  assertOk(refreshedChanges);
  assert.equal(refreshedChanges.structuredContent?.type, "changes");
  assert.equal(refreshedChanges.structuredContent?.resumeToken, filteredChanges.structuredContent.resumeToken);
  assert.notEqual(refreshedChanges.structuredContent?.token, filteredChanges.structuredContent.token);
  const reloadedChanges = await call("load_display_content", { token: refreshedChanges.structuredContent.token });
  assert.match(textOf(reloadedChanges), /\+after again/);
  assert.doesNotMatch(textOf(reloadedChanges), /deleted file mode/);
});

test("local todo bridge binds the active browser thread and remains thread-scoped", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const conversationId = "v1/test-browser-session";
  const threadId = "6aa38eee-15b0-83e8-ba77-ad04592b5ceb";
  const otherThreadId = "7bb49fff-26c1-94f9-cb88-be15603c6dfc";
  const stealingThreadId = "8cc50aaa-37d2-45aa-a977-cf26714d7abc";
  const sentAt = Date.now();

  runWithConversationId(conversationId, () => {
    writeTodos({
      todos: [{ id: "a", content: "First todo", status: "in_progress" }],
      merge: false,
    });
  });
  recordRecentWebConversationFromBody({
    params: {
      _meta: {
        "openai/session": conversationId,
        "openai/userAgent": "Mozilla/5.0 Chrome/152.0",
      },
    },
  });

  const denied = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, active: true }),
  });
  assert.equal(denied.status, 401);

  const passiveResponse = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, active: true }),
  });
  assert.equal(passiveResponse.status, 200);
  const passive = await passiveResponse.json();
  assert.equal(passive.bound, false, "passive todo polling must never claim a recent Local System conversation");

  const ephemeralSkillResponse = await fetch(`${origin}/local-ui/skills`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: otherThreadId, action: "attach", name: "local-system", active: true }),
  });
  assert.equal(ephemeralSkillResponse.status, 200);
  const ephemeralSkill = await ephemeralSkillResponse.json();
  assert.equal(ephemeralSkill.bound, false);
  assert.equal(ephemeralSkill.ephemeral, true);

  const otherPassiveResponse = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: otherThreadId, active: true }),
  });
  assert.equal((await otherPassiveResponse.json()).bound, false, "skill use must not create a browser-thread binding");

  const bindResponse = await fetch(`${origin}/local-ui/thread-bind`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, sentAt }),
  });
  assert.equal(bindResponse.status, 200);
  assert.equal((await bindResponse.json()).bound, true);

  const boundResponse = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, active: true }),
  });
  assert.equal(boundResponse.status, 200);
  const bound = await boundResponse.json();
  assert.equal(bound.bound, true);
  assert.deepEqual(bound.todos, [{ id: "a", content: "First todo", status: "in_progress" }]);

  recordToolStarted({
    conversationId,
    requestId: "req_dashboard_activity",
    tool: "execute_command",
    args: { command: "echo dashboard" },
    at: Date.now() - 25,
  });
  recordToolCompleted({
    conversationId,
    requestId: "req_dashboard_activity",
    result: { content: [{ type: "text", text: "dashboard\n" }] },
    at: Date.now(),
    durationMs: 25,
  });
  const activityListResponse = await fetch(`${origin}/local-ui/activity`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "list", limit: 5 }),
  });
  assert.equal(activityListResponse.status, 200);
  const activityList = await activityListResponse.json();
  assert.equal(activityList.bound, true);
  assert.equal(activityList.calls?.[0]?.id, "req_dashboard_activity");
  assert.equal(activityList.calls?.[0]?.arguments?.command, "echo dashboard");

  // A second browser tab must never steal a Local System conversation that is
  // already owned by another ChatGPT thread, even if that conversation is the
  // most recent web MCP caller. This is the cross-thread todo/workspace leak
  // regression: previously the old owner was deleted and all state moved.
  const stealingSentAt = Date.now();
  recordRecentWebConversationFromBody({
    params: {
      _meta: {
        "openai/session": conversationId,
        "openai/userAgent": "Mozilla/5.0 Chrome/152.0",
      },
    },
  });
  const stealingBindResponse = await fetch(`${origin}/local-ui/thread-bind`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: stealingThreadId, sentAt: stealingSentAt }),
  });
  assert.equal(stealingBindResponse.status, 200);
  const stealingBind = await stealingBindResponse.json();
  assert.equal(stealingBind.bound, false);
  assert.equal(stealingBind.conflict, true);

  const originalAfterStealAttempt = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, active: false }),
  });
  assert.equal((await originalAfterStealAttempt.json()).bound, true);

  const stealingThreadAfterAttempt = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: stealingThreadId, active: false }),
  });
  assert.equal((await stealingThreadAfterAttempt.json()).bound, false);

  const noWorkspaceFile = path.join(root, "bound-no-workspace.txt");
  fs.writeFileSync(noWorkspaceFile, "available without a current workspace\n");
  const noWorkspaceSearchResponse = await fetch(`${origin}/local-ui/files/search`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, query: "", active: false }),
  });
  assert.equal(noWorkspaceSearchResponse.status, 200);
  const noWorkspaceSearch = await noWorkspaceSearchResponse.json();
  assert.equal(noWorkspaceSearch.bound, true);
  assert.equal(noWorkspaceSearch.currentWorkspace, "");
  assert.ok(
    noWorkspaceSearch.files?.some((file) => file.path === noWorkspaceFile),
    "a bound thread without currentWorkspace should browse authorized roots on empty @@ / quick-open",
  );

  const projectSkill = path.join(root, ".agents", "skills", "local-ui-project-skill");
  fs.mkdirSync(projectSkill, { recursive: true });
  const projectSkillContents = "---\nname: local-ui-project-skill\ndescription: Skill exposed through the local composer palette.\n---\n\n# Local UI project skill\nUse the test project context.\n";
  const projectSkillFile = path.join(projectSkill, "SKILL.md");
  fs.writeFileSync(projectSkillFile, projectSkillContents);
  runWithConversationId(conversationId, () => updateConversationState({ currentWorkspace: root }));

  const contextResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "context", active: false }),
  });
  assert.equal(contextResponse.status, 200);
  const contextPayload = await contextResponse.json();
  assert.equal(contextPayload.bound, true);
  assert.equal(contextPayload.currentWorkspace, root);

  const skillResponse = await fetch(`${origin}/local-ui/skills`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, query: "local ui project skill", active: false }),
  });
  assert.equal(skillResponse.status, 200);
  const skillPayload = await skillResponse.json();
  assert.equal(skillPayload.bound, true);
  assert.equal(skillPayload.skills?.[0]?.name, "local-ui-project-skill");
  assert.equal(skillPayload.skills?.[0]?.scope, "project");

  const attachSkillResponse = await fetch(`${origin}/local-ui/skills`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "attach", name: "local-ui-project-skill", active: false }),
  });
  assert.equal(attachSkillResponse.status, 200);
  const attachedSkillPayload = await attachSkillResponse.json();
  assert.equal(attachedSkillPayload.attachments?.length, 1);
  assert.equal(attachedSkillPayload.attachments?.[0]?.name, "local-ui-project-skill");
  assert.equal(attachedSkillPayload.attachments?.[0]?.path, projectSkillFile);
  assert.equal(attachedSkillPayload.attachments?.[0]?.reference, `[$local-ui-project-skill](${projectSkillFile})`);
  assert.equal(attachedSkillPayload.attachments?.[0]?.contents, projectSkillContents);

  const attachedSkillListResponse = await fetch(`${origin}/local-ui/skills`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "list", active: false }),
  });
  assert.equal(attachedSkillListResponse.status, 200);
  assert.equal((await attachedSkillListResponse.json()).attachments?.[0]?.path, projectSkillFile);

  const deleteSkillResponse = await fetch(`${origin}/local-ui/skills`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "delete", path: projectSkillFile, active: false }),
  });
  assert.equal(deleteSkillResponse.status, 200);
  assert.deepEqual((await deleteSkillResponse.json()).attachments, []);

  const attachFile = path.join(root, "quick-open-attachment.txt");
  fs.writeFileSync(attachFile, "attach-me-through-local-ui\n");
  const searchableTodo = path.join(root, "docs", "TODO");
  fs.mkdirSync(path.dirname(searchableTodo), { recursive: true });
  fs.writeFileSync(searchableTodo, "project todo\n");
  for (const ignoredDir of ["vendor", "node_modules", "Pods", ".gradle", "build"]) {
    const ignoredTodo = path.join(root, ignoredDir, "nested", "TODO");
    fs.mkdirSync(path.dirname(ignoredTodo), { recursive: true });
    fs.writeFileSync(ignoredTodo, "dependency todo\n");
  }
  const fileSearchResponse = await fetch(`${origin}/local-ui/files/search`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, query: "quick open attach", active: false }),
  });
  assert.equal(fileSearchResponse.status, 200);
  const fileSearch = await fileSearchResponse.json();
  assert.equal(fileSearch.bound, true);
  assert.equal(fileSearch.files?.[0]?.name, "quick-open-attachment.txt");
  assert.equal(fileSearch.files?.[0]?.path, attachFile);

  const relativeFileResolveResponse = await fetch(`${origin}/local-ui/files/resolve`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, path: "quick-open-attachment.txt", active: false }),
  });
  assert.equal(relativeFileResolveResponse.status, 200);
  const relativeFileResolve = await relativeFileResolveResponse.json();
  assert.equal(relativeFileResolve.path, attachFile);
  assert.equal(relativeFileResolve.name, "quick-open-attachment.txt");
  assert.match(relativeFileResolve.url || "", /\/local-file\//);
  const relativeFileFetch = await fetch(relativeFileResolve.url);
  assert.equal(relativeFileFetch.status, 200);
  assert.equal(await relativeFileFetch.text(), "attach-me-through-local-ui\n");

  const ignoredDirectorySearchResponse = await fetch(`${origin}/local-ui/files/search`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, query: "todo", active: false }),
  });
  assert.equal(ignoredDirectorySearchResponse.status, 200);
  const ignoredDirectorySearch = await ignoredDirectorySearchResponse.json();
  assert.ok(ignoredDirectorySearch.files?.some((file) => file.path === searchableTodo));
  assert.equal(
    ignoredDirectorySearch.files?.some((file) => /\/(vendor|node_modules|Pods|\.gradle|build)\//.test(file.path)),
    false,
    "quick-open should not index dependency, cache, or build directories",
  );

  const workspaceUpdateResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      action: "update",
      workspace: {
        openPaths: [attachFile],
        activePath: attachFile,
        sidebarOpen: true,
        width: 777,
      },
    }),
  });
  assert.equal(workspaceUpdateResponse.status, 200);
  const workspaceUpdate = await workspaceUpdateResponse.json();
  assert.equal(workspaceUpdate.workspace?.activePath, attachFile);
  assert.equal(workspaceUpdate.workspace?.sidebarOpen, true);
  assert.equal(workspaceUpdate.workspace?.width, 777);

  const annotationResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      action: "upsert_annotation",
      annotation: {
        path: attachFile,
        quote: "attach-me",
        comment: "Review this file selection",
        prefix: "",
        suffix: "-through-local-ui",
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 10, offset: 9 },
      },
    }),
  });
  assert.equal(annotationResponse.status, 200);
  const annotationPayload = await annotationResponse.json();
  assert.equal(annotationPayload.workspace?.annotations?.length, 1);
  assert.equal(annotationPayload.workspace?.annotations?.[0]?.path, attachFile);
  assert.equal(annotationPayload.workspace?.annotations?.[0]?.start?.line, 1);
  const fileAnnotationId = annotationPayload.workspace?.annotations?.[0]?.id;
  assert.match(fileAnnotationId || "", /^[0-9a-f-]{36}$/i);

  const latestFileAnnotationResponse = await fetch(`${origin}/local-ui/annotations`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "latest", active: false }),
  });
  const latestFileAnnotation = await latestFileAnnotationResponse.json();
  assert.equal(latestFileAnnotation.annotation?.kind, "file");
  assert.equal(latestFileAnnotation.annotation?.comment, "Review this file selection");
  assert.match(latestFileAnnotation.annotation?.copyText || "", /Review this file selection/);

  const deleteAnnotationResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "delete_annotation", id: fileAnnotationId }),
  });
  assert.equal(deleteAnnotationResponse.status, 200);
  assert.equal((await deleteAnnotationResponse.json()).workspace?.annotations?.length, 0);

  const videoFile = path.join(root, "review-demo.mp4");
  fs.writeFileSync(videoFile, "not-a-real-video");
  const mediaNoteResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      action: "upsert_media_note",
      note: {
        path: videoFile,
        time: 9.6,
        comment: "Cut before the reaction",
      },
    }),
  });
  assert.equal(mediaNoteResponse.status, 200);
  const mediaNotePayload = await mediaNoteResponse.json();
  assert.equal(mediaNotePayload.workspace?.mediaNotes?.length, 1);
  assert.equal(mediaNotePayload.workspace?.mediaNotes?.[0]?.path, videoFile);
  assert.equal(mediaNotePayload.workspace?.mediaNotes?.[0]?.time, 9.6);
  assert.equal(mediaNotePayload.workspace?.mediaNotes?.[0]?.comment, "Cut before the reaction");
  const mediaNoteId = mediaNotePayload.workspace?.mediaNotes?.[0]?.id;
  assert.match(mediaNoteId || "", /^[0-9a-f-]{36}$/i);

  const deleteMediaNoteResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "delete_media_note", id: mediaNoteId }),
  });
  assert.equal(deleteMediaNoteResponse.status, 200);
  assert.equal((await deleteMediaNoteResponse.json()).workspace?.mediaNotes?.length, 0);

  const outsideFile = path.join(outside, "not-authorized.txt");
  fs.writeFileSync(outsideFile, "nope\n");
  const forbiddenWorkspaceResponse = await fetch(`${origin}/local-ui/file-workspace`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      action: "update",
      workspace: { openPaths: [outsideFile], activePath: outsideFile, sidebarOpen: true },
    }),
  });
  assert.equal(forbiddenWorkspaceResponse.status, 403);

  const fileResolveResponse = await fetch(`${origin}/local-ui/files/resolve`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, path: attachFile, active: false }),
  });
  assert.equal(fileResolveResponse.status, 200);
  const fileDescriptor = await fileResolveResponse.json();
  assert.equal(fileDescriptor.name, "quick-open-attachment.txt");
  assert.match(fileDescriptor.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/local-file/[A-Za-z0-9_-]+$`));
  const downloadedFile = await fetch(fileDescriptor.url);
  assert.equal(downloadedFile.status, 200);
  assert.equal(await downloadedFile.text(), "attach-me-through-local-ui\n");

  const fileWriteResponse = await fetch(`${origin}/local-ui/files/write`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      path: attachFile,
      content: "edited-through-local-ui\n",
      expectedLastModified: fileDescriptor.lastModified,
      expectedBytes: fileDescriptor.bytes,
      active: false,
    }),
  });
  assert.equal(fileWriteResponse.status, 200);
  const writtenDescriptor = await fileWriteResponse.json();
  assert.equal(writtenDescriptor.bytes, Buffer.byteLength("edited-through-local-ui\n"));
  assert.equal(fs.readFileSync(attachFile, "utf8"), "edited-through-local-ui\n");

  const staleWriteResponse = await fetch(`${origin}/local-ui/files/write`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      path: attachFile,
      content: "stale overwrite\n",
      expectedLastModified: fileDescriptor.lastModified,
      expectedBytes: fileDescriptor.bytes,
      active: false,
    }),
  });
  assert.equal(staleWriteResponse.status, 409);
  assert.match((await staleWriteResponse.json()).error, /changed on disk/i);

  const outsideResolve = await fetch(`${origin}/local-ui/files/resolve`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, path: path.join(outside, "outside.txt"), active: false }),
  });
  assert.equal(outsideResolve.status, 403);

  const outsideWrite = await fetch(`${origin}/local-ui/files/write`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      path: path.join(outside, "outside.txt"),
      content: "nope\n",
      expectedLastModified: 0,
      expectedBytes: 0,
      active: false,
    }),
  });
  assert.equal(outsideWrite.status, 403);

  const testMessageKey = ["fixture", "annotation", "source"].join("-");
  const annotationSource = {
    messageKey: testMessageKey,
    role: "assistant",
    quote: "selected response text",
    prefix: "before ",
    suffix: " after",
    start: 7,
    end: 29,
    textRootIndex: 0,
    segments: [
      {
        messageKey: testMessageKey,
        role: "assistant",
        quote: "selected response text",
        prefix: "before ",
        suffix: " after",
        start: 7,
        end: 29,
        textRootIndex: 0,
      },
      {
        messageKey: testMessageKey,
        role: "assistant",
        quote: "continued response text",
        prefix: "later ",
        suffix: " done",
        start: 3,
        end: 26,
        textRootIndex: 1,
      },
    ],
  };
  const annotationCreateResponse = await fetch(`${origin}/local-ui/annotations`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      action: "upsert",
      active: false,
      annotation: { comment: "Make this more precise", source: annotationSource },
    }),
  });
  assert.equal(annotationCreateResponse.status, 200);
  const annotationCreate = await annotationCreateResponse.json();
  assert.equal(annotationCreate.annotations?.length, 1);
  assert.equal(annotationCreate.annotations?.[0]?.comment, "Make this more precise");
  assert.equal(annotationCreate.annotations?.[0]?.source?.quote, "selected response text");
  assert.equal(annotationCreate.annotations?.[0]?.source?.textRootIndex, 0);
  assert.equal(annotationCreate.annotations?.[0]?.source?.segments?.length, 2);
  assert.equal(annotationCreate.annotations?.[0]?.source?.segments?.[1]?.textRootIndex, 1);
  assert.equal(annotationCreate.annotations?.[0]?.source?.segments?.[1]?.quote, "continued response text");
  assert.match(annotationCreate.annotations?.[0]?.id || "", /^[A-Za-z0-9_-]{8,128}$/);

  const annotationId = annotationCreate.annotations[0].id;
  const annotationUpdateResponse = await fetch(`${origin}/local-ui/annotations`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId,
      action: "upsert",
      active: false,
      annotation: { id: annotationId, comment: "Updated annotation", source: annotationSource },
    }),
  });
  const annotationUpdate = await annotationUpdateResponse.json();
  assert.equal(annotationUpdate.annotations?.length, 1);
  assert.equal(annotationUpdate.annotations?.[0]?.id, annotationId);
  assert.equal(annotationUpdate.annotations?.[0]?.comment, "Updated annotation");

  const annotationClearResponse = await fetch(`${origin}/local-ui/annotations`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "clear", active: false }),
  });
  assert.deepEqual((await annotationClearResponse.json()).annotations, []);
  const latestAnnotationResponse = await fetch(`${origin}/local-ui/annotations`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "latest", active: false }),
  });
  const latestAnnotation = await latestAnnotationResponse.json();
  assert.equal(latestAnnotation.annotation?.kind, "chat");
  assert.equal(latestAnnotation.annotation?.comment, "Updated annotation");
  assert.equal(latestAnnotation.annotations?.length, 1);
  assert.equal(latestAnnotation.turn?.kind, "chat");
  assert.equal(latestAnnotation.turn?.count, 1);
  assert.match(latestAnnotation.annotation?.copyText || "", /selected response text/);
  assert.match(latestAnnotation.annotation?.copyText || "", /Updated annotation/);

  const annotationOtherThreadResponse = await fetch(`${origin}/local-ui/annotations`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: otherThreadId, action: "list", active: false }),
  });
  const annotationOtherThread = await annotationOtherThreadResponse.json();
  assert.equal(annotationOtherThread.bound, false);
  assert.deepEqual(annotationOtherThread.annotations, []);

  const annotationDeleteResponse = await fetch(`${origin}/local-ui/annotations`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, action: "delete", id: annotationId, active: false }),
  });
  const annotationDelete = await annotationDeleteResponse.json();
  assert.deepEqual(annotationDelete.annotations, []);

  runWithConversationId(conversationId, () => {
    writeTodos({
      todos: [{ id: "a", content: "First todo", status: "completed" }],
      merge: true,
    });
  });
  const refreshedResponse = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, active: false }),
  });
  const refreshed = await refreshedResponse.json();
  assert.deepEqual(refreshed.todos, [{ id: "a", content: "First todo", status: "completed" }]);

  const unrelatedResponse = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: otherThreadId, active: false }),
  });
  const unrelated = await unrelatedResponse.json();
  assert.equal(unrelated.bound, false);
  assert.deepEqual(unrelated.todos, []);
});

test("MCP lists the exposed model tools plus app-only helpers", async () => {
  const tools = await client.listTools();
  const modelTools = tools.tools.filter((tool) => !tool._meta?.ui?.visibility?.includes("app") || tool._meta?.ui?.visibility?.includes("model"));
  const modelNames = modelTools.map((tool) => tool.name).sort();
  assert.deepEqual(modelNames, [...EXPECTED_TOOL_NAMES].sort());
  assert.equal(tools.tools.every((tool) => tool.inputSchema?.type === "object"), true);

  const displayTool = tools.tools.find((tool) => tool.name === "display");
  assert.equal(displayTool?.title, "Display");
  assert.match(displayTool?.description || "", /show local files/i);
  assert.match(displayTool?.description || "", /HTML artifacts/i);
  assert.doesNotMatch(displayTool?.description || "", /Git|diff|changes/i);
  assert.equal(displayTool?.annotations?.readOnlyHint, false);
  assert.equal(displayTool?.annotations?.openWorldHint, true);
  const viewImageTool = tools.tools.find((tool) => tool.name === "view_image");
  assert.equal(viewImageTool?.title, "View image");
  assert.match(viewImageTool?.description || "", /see an image/i);
  assert.equal(viewImageTool?.annotations?.readOnlyHint, true);
  assert.equal(viewImageTool?.annotations?.destructiveHint, false);
  assert.equal(viewImageTool?.annotations?.openWorldHint, false);
  assert.equal(viewImageTool?._meta?.ui, undefined);
  assert.deepEqual(Object.keys(viewImageTool?.inputSchema?.properties || {}), ["paths"]);
  assert.deepEqual(viewImageTool?.inputSchema?.required, ["paths"]);
  assert.equal(viewImageTool?.inputSchema?.properties?.paths?.maxItems, undefined);
  assert.doesNotMatch(viewImageTool?.description || "", /three|3|max/i);
  assert.deepEqual(
    Object.keys(displayTool?.inputSchema?.properties || {}).sort(),
    ["changes", "path"],
  );
  assert.equal(displayTool?.inputSchema?.required, undefined);
  assert.equal(displayTool?.inputSchema?.properties?.changes?.type, "boolean");
  assert.match(displayTool?.inputSchema?.properties?.changes?.description || "", /Git changes.*listed path/i);
  assert.match(displayTool?.inputSchema?.properties?.path?.description || "", /HTML and Markdown.*rendered automatically/i);
  const requestUserInputTool = tools.tools.find((tool) => tool.name === "request_user_input");
  assert.equal(requestUserInputTool?.annotations?.readOnlyHint, false);
  assert.equal(requestUserInputTool?.annotations?.destructiveHint, false);
  assert.equal(requestUserInputTool?.annotations?.openWorldHint, true);
  assert.deepEqual(Object.keys(requestUserInputTool?.inputSchema?.properties || {}).sort(), ["content", "question"]);
  assert.equal(requestUserInputTool?.inputSchema?.required, undefined);
  const requestUserInputQuestion = requestUserInputTool?.inputSchema?.properties?.question;
  assert.deepEqual(Object.keys(requestUserInputQuestion?.properties || {}).sort(), ["multiple", "options", "question"]);
  assert.deepEqual(requestUserInputQuestion?.required, ["question"]);
  assert.equal(requestUserInputQuestion?.properties?.multiple?.type, "boolean");
  const writeTodosTool = tools.tools.find((tool) => tool.name === "write_todos");
  assert.deepEqual(Object.keys(writeTodosTool?.inputSchema?.properties || {}).sort(), ["merge", "todos"]);
  assert.deepEqual(writeTodosTool?.inputSchema?.required?.sort(), ["merge", "todos"]);
  assert.equal(writeTodosTool?.inputSchema?.properties?.todos?.minItems, 1);
  assert.deepEqual(writeTodosTool?.inputSchema?.properties?.todos?.items?.required?.sort(), ["content", "id", "status"]);
  assert.equal(writeTodosTool?.inputSchema?.properties?.todos?.items?.properties?.content?.maxLength, 200);
  assert.deepEqual(writeTodosTool?.inputSchema?.properties?.todos?.items?.properties?.status?.enum, ["pending", "in_progress", "completed", "cancelled"]);
  assert.match(writeTodosTool?._meta?.ui?.resourceUri || "", /^ui:\/\/sol\/todos-[a-f0-9]{12}\.html$/);
  const cloudPreviewTool = tools.tools.find((tool) => tool.name === "get_cloud_preview_url");
  assert.deepEqual(cloudPreviewTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(cloudPreviewTool?.annotations?.readOnlyHint, true);
  const loadPreviewTool = tools.tools.find((tool) => tool.name === "load_preview_file");
  assert.deepEqual(loadPreviewTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(loadPreviewTool?.annotations?.readOnlyHint, true);
  const loadDisplayTool = tools.tools.find((tool) => tool.name === "load_display_content");
  assert.deepEqual(loadDisplayTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(loadDisplayTool?.annotations?.readOnlyHint, true);
  const refreshDisplayTool = tools.tools.find((tool) => tool.name === "refresh_display_content");
  assert.deepEqual(refreshDisplayTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(refreshDisplayTool?.annotations?.readOnlyHint, true);
  assert.equal(refreshDisplayTool?.annotations?.openWorldHint, true);
  const refreshPreviewTool = tools.tools.find((tool) => tool.name === "refresh_preview_file");
  assert.deepEqual(refreshPreviewTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(refreshPreviewTool?.annotations?.readOnlyHint, true);
  assert.equal(refreshPreviewTool?.annotations?.openWorldHint, true);
  const openPreviewTool = tools.tools.find((tool) => tool.name === "open_preview_file");
  assert.deepEqual(openPreviewTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(openPreviewTool?.annotations?.destructiveHint, false);
  const displayResourceUri = displayTool?._meta?.ui?.resourceUri || "";
  assert.match(displayResourceUri, /^ui:\/\/sol\/display-[a-f0-9]{12}\.html$/);
  const applyPatchResourceUri = tools.tools.find((tool) => tool.name === "apply_patch")?._meta?.ui?.resourceUri || "";
  assert.match(applyPatchResourceUri, /^ui:\/\/sol\/apply-patch-[a-f0-9]{12}\.html$/);
  const todosResourceUri = writeTodosTool?._meta?.ui?.resourceUri || "";
  assert.match(todosResourceUri, /^ui:\/\/sol\/todos-[a-f0-9]{12}\.html$/);
  assert.equal(
    tools.tools.find((tool) => tool.name === "discover_skills")?._meta?.ui?.resourceUri,
    "ui://sol/skills-browser.html",
  );
  assert.equal(tools.tools.find((tool) => tool.name === "execute_command")?._meta?.ui, undefined);
  for (const name of EXPECTED_TOOL_NAMES) {
    const tool = tools.tools.find((item) => item.name === name);
    const maxDescriptionLength = name === "runtime_memory" ? 160 : 140;
    assert.ok((tool?.description || "").length <= maxDescriptionLength, `${name} description is too long`);
    for (const property of Object.values(tool?.inputSchema?.properties || {})) {
      if (property.description) assert.ok(property.description.length <= 120, `${name} input description is too long`);
    }
  }
  const patchTool = tools.tools.find((tool) => tool.name === "apply_patch");
  assert.equal(patchTool?.inputSchema?.properties?.input?.type, "string");
  assert.equal(patchTool?.inputSchema?.properties?.diff, undefined);
  assert.match(patchTool?.inputSchema?.properties?.input?.description || "", /Begin Patch/, "patch format is stated once, on the param");
  assert.doesNotMatch(patchTool?.description || "", /Begin Patch/, "and is not duplicated in the description");
  const workspaceTool = tools.tools.find((tool) => tool.name === "workspace");
  assert.deepEqual([...workspaceTool.inputSchema.properties.action.enum].sort(), ["list", "open", "save"]);
  assert.equal(workspaceTool.inputSchema.properties.maxDepth, undefined);
  assert.equal(workspaceTool.inputSchema.properties.maxEntries, undefined);
  assert.doesNotMatch(workspaceTool.description || "", /execute_command/, "no cross-tool aside");
  const executeCommandTool = tools.tools.find((tool) => tool.name === "execute_command");
  const manageTaskTool = tools.tools.find((tool) => tool.name === "manage_task");
  assert.equal(tools.tools.some((tool) => tool.name === "subagent"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "subagent_wait"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "subagents"), false);
  assert.equal(executeCommandTool?.inputSchema?.properties?.timeoutMs, undefined);
  assert.equal(executeCommandTool?.inputSchema?.properties?.waitMs?.minimum, 0);
  assert.equal(executeCommandTool?.inputSchema?.properties?.waitMs?.maximum, 300_000);
  assert.match(executeCommandTool?.inputSchema?.properties?.waitMs?.description || "", /returns immediately|running task/i);
  assert.deepEqual([...(manageTaskTool?.inputSchema?.properties?.action?.enum || [])].sort(), ["kill", "list", "send_input", "status"]);
  assert.deepEqual(Object.keys(manageTaskTool?.inputSchema?.properties || {}).sort(), ["action", "input", "taskId"]);
  const runtimeMemoryTool = tools.tools.find((tool) => tool.name === "runtime_memory");
  assert.equal(
    runtimeMemoryTool?.description,
    "Read, write, or clear temporary working context for the current conversation so long-running work can resume reliably across turns and checkpoints.",
  );
  assert.deepEqual(Object.keys(runtimeMemoryTool?.inputSchema?.properties || {}).sort(), ["action", "content"]);
  assert.deepEqual(runtimeMemoryTool?.inputSchema?.required, ["action"]);
  assert.deepEqual(runtimeMemoryTool?.inputSchema?.properties?.action?.enum, ["read", "write", "clear"]);
  assert.equal(runtimeMemoryTool?.inputSchema?.properties?.content?.minLength, 1);
  assert.equal(runtimeMemoryTool?.inputSchema?.properties?.content?.maxLength, 6000);

});

test("bridge_context keeps text concise and structured context complete", async () => {
  const context = await call("bridge_context", {});
  assert.equal(context.isError, undefined);
  assert.equal(Array.isArray(context.structuredContent?.instructions), true);
  assert.equal(context.structuredContent?.instructions?.length, 9);
  assert.equal(context.structuredContent?.environment, undefined);
  assert.equal(context.structuredContent?.managedProcesses, undefined);
  assert.equal(typeof context.structuredContent?.platform?.adapter, "string");
  assert.equal(context.structuredContent?.currentProjectWorkspace, null);
  assert.equal(path.dirname(context.structuredContent?.localScratchDir || ""), fs.realpathSync(scratch));
  assert.match(path.basename(context.structuredContent?.localScratchDir || ""), /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(context.structuredContent?.todos, { open: [], completed: 0, cancelled: 0 });
  assert.equal(context.structuredContent?.runtimeMemory, null);
  const instructions = context.structuredContent?.instructions.join("\n") || "";
  assert.match(instructions, /local-system skill/i);
  assert.match(instructions, /Keep communication concise and outcome-focused/i);
  assert.match(instructions, /within the authorized scope/i);
  assert.match(instructions, /write_todos/i);
  assert.match(instructions, /request_user_input/i);
  assert.match(instructions, /projectMemory/i);
  assert.match(instructions, /Verify assumptions whose failure/i);
  assert.equal(typeof context.structuredContent?.memory?.root, "string");
  assert.equal(typeof context.structuredContent?.globalAgentDoc, "object");
  assert.equal(context.structuredContent?.projectMemory, null);
  assert.equal(textOf(context), "Bridge context returned.");
  assert.doesNotMatch(textOf(context), /instructions|localScratchDir|todos|runtimeMemory/);
});

test("MCP App resources are registered and self-contained", async () => {
  const resources = await client.listResources();
  const tools = await client.listTools();
  const displayResourceUri = tools.tools.find((tool) => tool.name === "display")?._meta?.ui?.resourceUri;
  const applyPatchResourceUri = tools.tools.find((tool) => tool.name === "apply_patch")?._meta?.ui?.resourceUri;
  assert.match(displayResourceUri, /^ui:\/\/sol\/display-[a-f0-9]{12}\.html$/);
  assert.match(applyPatchResourceUri || "", /^ui:\/\/sol\/apply-patch-[a-f0-9]{12}\.html$/);
  const expected = new Map([
    [displayResourceUri, /Display/],
    [applyPatchResourceUri, /Apply Patch Diff/],
    ["ui://sol/command-result.html", /Command Result/],
    ["ui://sol/skills-browser.html", /Skills/],
  ]);
  for (const [uri, marker] of expected) {
    assert.ok(resources.resources.some((resource) => resource.uri === uri));
    const resource = await client.readResource({ uri });
    const html = resource.contents?.[0]?.text || "";
    assert.match(html, marker);
    assert.match(html, /id="root"/);
    if (uri === "ui://sol/command-result.html") {
      assert.doesNotMatch(html, /Waiting for command result/);
      assert.match(html, /ui\/notifications\/tool-input/);
    }
    if (uri === displayResourceUri) {
      assert.match(html, /get_cloud_preview_url/);
      assert.match(html, /load_preview_file/);
      assert.match(html, /refresh_preview_file/);
      assert.match(html, /open_preview_file/);
      assert.match(html, /load_display_content/);
      assert.match(html, /data-display-diff-index/);
      assert.match(html, /data-html-artifact/);
      assert.match(html, /data-preview-previous/);
      assert.match(html, /data-preview-next/);
      assert.match(html, /aria-live/);
    }
    if (uri === applyPatchResourceUri) {
      assert.match(html, /line-no/);
      assert.match(html, /Changed files/);
      assert.match(html, /highlight/);
    }
  }
});

test("view_image returns model-visible pixels without user-facing UI metadata", async () => {
  const png = path.join(root, "vision.png");
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nS8AAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(png, pngBytes);

  const result = await call("view_image", { paths: [png] });
  assertOk(result);
  assert.equal(result.content?.[0]?.type, "text");
  assert.match(result.content?.[0]?.text || "", /Viewing vision\.png/);
  assert.equal(result.content?.[1]?.type, "image");
  assert.equal(result.content?.[1]?.mimeType, "image/png");
  assert.equal(result.content?.[1]?.data, pngBytes.toString("base64"));
  assert.equal(result.structuredContent, undefined);

  const batchPaths = [1, 2, 3, 4].map((number) => {
    const target = path.join(root, `vision-${number}.png`);
    fs.copyFileSync(png, target);
    return target;
  });
  const batch = await call("view_image", { paths: batchPaths });
  assertOk(batch);
  assert.equal(batch.content.filter((item) => item.type === "image").length, 3);
  assert.match(textOf(batch), /first 3 of 4 requested images/i);
  assert.match(textOf(batch), /call view_image again with the remaining path/i);
  assert.match(textOf(batch), /vision-1\.png/);
  assert.match(textOf(batch), /vision-3\.png/);
  assert.doesNotMatch(textOf(batch), /vision-4\.png/);
  assert.equal(batch.structuredContent, undefined);

  const pair = await call("view_image", { paths: batchPaths.slice(0, 2) });
  assertOk(pair);
  assert.equal(pair.content.filter((item) => item.type === "image").length, 2);
  assert.match(textOf(pair), /Viewing 2 requested images/i);
  assert.doesNotMatch(textOf(pair), /call view_image again/i);

  assertError(await call("view_image", { path: png }), /paths/i);

  const disguised = path.join(root, "not-really-an-image.png");
  fs.writeFileSync(disguised, "not an image");
  assertError(await call("view_image", { paths: [disguised] }), /supports JPEG, PNG, WebP, and GIF/);

  const outsidePng = path.join(outside, "outside-vision.png");
  fs.copyFileSync(png, outsidePng);
  assertError(await call("view_image", { paths: [outsidePng] }), /outside Local System workspace roots/);
});

test("display file mode keeps history lightweight and exposes typed resources for text and media", async () => {
  const markdown = path.join(root, "story.md");
  fs.writeFileSync(markdown, "# Story\n\nHello **world**.\n");
  const markdownResult = await call("display", { path: markdown });
  assertOk(markdownResult);
  assert.equal(markdownResult.structuredContent?.kind, "display");
  assert.equal(markdownResult.structuredContent?.type, "file");
  assert.equal(markdownResult.structuredContent?.file?.category, "markdown");
  assert.equal(markdownResult.structuredContent?.file?.mimeType, "text/markdown");
  assert.match(markdownResult.structuredContent?.file?.resourceUri || "", /^preview:\/\/sol\/[A-Za-z0-9_-]+$/);
  assert.match(markdownResult.structuredContent?.file?.openToken || "", /^[A-Za-z0-9_-]{20,}$/);
  assert.match(markdownResult.structuredContent?.file?.resumeToken || "", /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(markdownResult.structuredContent?.file?.path, undefined);
  assert.ok(JSON.stringify(markdownResult.structuredContent).length < 2_000);

  const markdownResource = await client.readResource({ uri: markdownResult.structuredContent.file.resourceUri });
  assert.equal(markdownResource.contents?.[0]?.mimeType, "text/markdown");
  assert.match(markdownResource.contents?.[0]?.text || "", /Hello \*\*world\*\*/);
  const markdownFallback = await call("load_preview_file", { token: markdownResult.structuredContent.file.openToken });
  assert.equal(markdownFallback.content?.[0]?.type, "text");
  assert.match(markdownFallback.content?.[0]?.text || "", /Hello \*\*world\*\*/);

  const refreshedMarkdown = await call("refresh_preview_file", {
    resumeToken: markdownResult.structuredContent.file.resumeToken,
  });
  assertOk(refreshedMarkdown);
  assert.notEqual(refreshedMarkdown.structuredContent?.file?.openToken, markdownResult.structuredContent.file.openToken);
  assert.equal(refreshedMarkdown.structuredContent?.file?.resumeToken, markdownResult.structuredContent.file.resumeToken);
  assert.equal(refreshedMarkdown.structuredContent?.file?.path, undefined);
  const refreshedFallback = await call("load_preview_file", { token: refreshedMarkdown.structuredContent.file.openToken });
  assert.match(refreshedFallback.content?.[0]?.text || "", /Hello \*\*world\*\*/);

  const python = path.join(root, "example.py");
  fs.writeFileSync(python, "def greet(name):\n    return f'hello {name}'\n");
  const pythonResult = await call("display", { path: python });
  assert.equal(pythonResult.structuredContent?.file?.category, "code");
  assert.equal(pythonResult.structuredContent?.file?.language, "python");
  const pythonResource = await client.readResource({ uri: pythonResult.structuredContent.file.resourceUri });
  assert.match(pythonResource.contents?.[0]?.text || "", /def greet/);

  const png = path.join(root, "preview.png");
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nS8AAAAASUVORK5CYII=", "base64"));
  const pngResult = await call("display", { path: png });
  assert.equal(pngResult.structuredContent?.file?.category, "image");
  assert.equal(pngResult.structuredContent?.file?.mimeType, "image/png");
  const pngResource = await client.readResource({ uri: pngResult.structuredContent.file.resourceUri });
  assert.equal(pngResource.contents?.[0]?.mimeType, "image/png");
  assert.equal(typeof pngResource.contents?.[0]?.blob, "string");
  assert.ok(pngResource.contents[0].blob.length > 0);
  const pngFallback = await call("load_preview_file", { token: pngResult.structuredContent.file.openToken });
  assert.equal(pngFallback.content?.[0]?.type, "image");
  assert.equal(pngFallback.content?.[0]?.mimeType, "image/png");
  assert.ok((pngFallback.content?.[0]?.data || "").length > 0);

  const secondPng = path.join(root, "preview-second.png");
  fs.copyFileSync(png, secondPng);
  const imageBatch = await call("display", { path: [png, secondPng] });
  assertOk(imageBatch);
  assert.match(textOf(imageBatch), /Prepared file display for 2 images/i);
  assert.equal(imageBatch.structuredContent?.files?.length, 2);
  assert.equal(imageBatch.structuredContent?.file?.name, "preview.png");
  assert.deepEqual(imageBatch.structuredContent.files.map((file) => file.category), ["image", "image"]);

  const textBatch = await call("display", { path: [markdown, python] });
  assertOk(textBatch);
  assert.match(textOf(textBatch), /Prepared file display for 2 files/i);
  assert.deepEqual(textBatch.structuredContent?.files?.map((file) => file.category), ["markdown", "code"]);

  const mixedBatch = await call("display", { path: [markdown, png] });
  assertOk(mixedBatch);
  assert.deepEqual(mixedBatch.structuredContent?.files?.map((file) => file.category), ["markdown", "image"]);
  assertError(await call("display", {}), /requires a file path/i);

  const audio = path.join(root, "sample.mp3");
  fs.writeFileSync(audio, Buffer.from("ID3minimal-audio-test"));
  const audioResult = await call("display", { path: audio });
  assert.equal(audioResult.structuredContent?.file?.category, "audio");
  assert.equal(audioResult.structuredContent?.file?.mimeType, "audio/mpeg");
  const audioResource = await client.readResource({ uri: audioResult.structuredContent.file.resourceUri });
  assert.equal(audioResource.contents?.[0]?.mimeType, "audio/mpeg");
  assert.equal(typeof audioResource.contents?.[0]?.blob, "string");
  const audioFallback = await call("load_preview_file", { token: audioResult.structuredContent.file.openToken });
  assert.equal(audioFallback.content?.[0]?.type, "audio");
  assert.equal(audioFallback.content?.[0]?.mimeType, "audio/mpeg");

  const video = path.join(root, "sample.mp4");
  fs.writeFileSync(video, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
  const videoResult = await call("display", { path: video });
  assert.equal(videoResult.structuredContent?.file?.category, "video");
  assert.equal(videoResult.structuredContent?.file?.mimeType, "video/mp4");
  const videoResource = await client.readResource({ uri: videoResult.structuredContent.file.resourceUri });
  assert.equal(videoResource.contents?.[0]?.mimeType, "video/mp4");
  assert.equal(typeof videoResource.contents?.[0]?.blob, "string");
  const videoFallback = await call("load_preview_file", { token: videoResult.structuredContent.file.openToken });
  assert.equal(videoFallback.content?.[0]?.type, "resource");
  assert.equal(videoFallback.content?.[0]?.resource?.mimeType, "video/mp4");
  assert.equal(typeof videoFallback.content?.[0]?.resource?.blob, "string");

  const pdf = path.join(root, "sample.pdf");
  fs.writeFileSync(pdf, Buffer.from("%PDF-1.4\n% fallback transport test\n"));
  const pdfResult = await call("display", { path: pdf });
  assert.equal(pdfResult.structuredContent?.file?.category, "pdf");
  const pdfFallback = await call("load_preview_file", { token: pdfResult.structuredContent.file.openToken });
  assert.equal(pdfFallback.content?.[0]?.type, "resource");
  assert.equal(pdfFallback.content?.[0]?.resource?.mimeType, "application/pdf");
  assert.equal(typeof pdfFallback.content?.[0]?.resource?.blob, "string");

  const unknown = path.join(root, "payload.bin");
  fs.writeFileSync(unknown, Buffer.from([0, 1, 2, 3, 255]));
  const unknownResult = await call("display", { path: unknown });
  assert.equal(unknownResult.structuredContent?.file?.category, "binary");
  assert.equal(unknownResult.structuredContent?.file?.mimeType, "application/octet-stream");
  const unknownResource = await client.readResource({ uri: unknownResult.structuredContent.file.resourceUri });
  assert.equal(typeof unknownResource.contents?.[0]?.blob, "string");

  const templates = await client.listResourceTemplates();
  assert.ok(templates.resourceTemplates.some((template) => template.uriTemplate === "preview://sol/{token}"));

  assertError(await call("open_preview_file", { token: "this-token-does-not-exist-12345" }), /unknown or expired/);
  assertError(await call("refresh_preview_file", { resumeToken: "A".repeat(40) }), /cannot be refreshed/);

  const outsidePng = path.join(outside, "outside.png");
  fs.copyFileSync(png, outsidePng);
  assertError(await call("display", { path: outsidePng }), /outside Local System workspace roots/);
});

test("display infers rendered document presentation from local file paths", async () => {
  const htmlContent = "<main><h1>Artifact</h1><script>globalThis.bad=true</script></main>";
  const htmlFile = path.join(root, "artifact.html");
  fs.writeFileSync(htmlFile, htmlContent);
  const html = await call("display", { path: htmlFile });
  assertOk(html);
  assert.equal(html.structuredContent?.kind, "display");
  assert.equal(html.structuredContent?.type, "html");
  assert.equal(html.structuredContent?.title, "artifact.html");
  assert.equal(typeof html.structuredContent?.resumeToken, "string");
  assert.doesNotMatch(textOf(html), /globalThis\.bad/);
  const loadedHtml = await call("load_display_content", { token: html.structuredContent.token });
  assert.equal(textOf(loadedHtml), htmlContent);

  fs.writeFileSync(htmlFile, "<main><h1>Artifact refreshed</h1></main>");
  const refreshedHtml = await call("refresh_display_content", {
    resumeToken: html.structuredContent.resumeToken,
  });
  assertOk(refreshedHtml);
  assert.equal(refreshedHtml.structuredContent?.type, "html");
  assert.equal(refreshedHtml.structuredContent?.resumeToken, html.structuredContent.resumeToken);
  assert.notEqual(refreshedHtml.structuredContent?.token, html.structuredContent.token);
  const reloadedHtml = await call("load_display_content", { token: refreshedHtml.structuredContent.token });
  assert.match(textOf(reloadedHtml), /Artifact refreshed/);

  const markdownFile = path.join(root, "display-document.md");
  fs.writeFileSync(markdownFile, "# From file\n");
  const markdownFromFile = await call("display", { path: markdownFile });
  assertOk(markdownFromFile);
  assert.equal(markdownFromFile.structuredContent?.type, "file");
  assert.equal(markdownFromFile.structuredContent?.file?.category, "markdown");

  assertError(await call("display", {}), /requires a file path/i);
  assertError(await call("load_display_content", { token: "this-token-does-not-exist-12345" }), /unknown or expired/i);
  assertError(await call("refresh_display_content", { resumeToken: "A".repeat(40) }), /cannot be refreshed/i);
});

test("workspace/file/patch tools round-trip inside configured authority", async () => {
  const saved = await call("workspace", { action: "save", path: root, name: "Integration Workspace", description: "Temporary integration-test project" });
  assert.equal(assertOk(saved), "Saved workspace Integration Workspace.");
  assert.equal(saved.structuredContent?.savedProject?.name, "Integration Workspace");
  assert.equal(Array.isArray(saved.structuredContent?.savedProjects), true);
  assertOk(await call("workspace", { action: "open", path: root }));
  const listed = await call("workspace", { action: "list" });
  assert.equal(assertOk(listed), "Workspace context returned.");
  assert.doesNotMatch(textOf(listed), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(listed.structuredContent?.currentProjectWorkspace, fs.realpathSync(root));
  const localScratchDir = listed.structuredContent?.localScratchDir;
  assert.equal(path.dirname(localScratchDir), fs.realpathSync(scratch));
  assert.match(path.basename(localScratchDir), /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(listed.structuredContent?.authorizedProjectRoots, [fs.realpathSync(root)]);
  assert.equal(Array.isArray(listed.structuredContent?.savedProjects), true);
  assert.equal(listed.structuredContent?.savedProjects?.[0]?.name, "Integration Workspace");
  assertError(await call("workspace", { action: "open", path: scratch }), /scratch cannot be selected or saved as a project/);
  assertError(await call("workspace", { action: "save", path: scratch }), /scratch cannot be selected or saved as a project/);
  spawnSync("git", ["init", "-q"], { cwd: root });
  const file = path.join(root, "hello.txt");
  const createPatch = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
  const created = await call("apply_patch", { cwd: root, input: createPatch });
  assert.equal(assertOk(created), "Patch applied.");
  assert.equal(created.structuredContent?.status, "applied");
  assert.match(created.structuredContent?.diff || "", /\+\+\+ b\/hello\.txt/);
  assert.equal(fs.readFileSync(file, "utf8"), "hello\n");

  const inspectCommand = process.platform === "win32" ? "type hello.txt" : "cat hello.txt";
  const inspectResult = await call("execute_command", { command: inspectCommand, cwd: root });
  assertOk(inspectResult);
  assert.match(inspectResult.structuredContent?.stdout || "", /hello/);
  const searchCommand = process.platform === "win32" ? 'findstr /n "hello" hello.txt' : "grep -n 'hello' hello.txt";
  const searchResult = await call("execute_command", { command: searchCommand, cwd: root });
  assertOk(searchResult);
  assert.match(searchResult.structuredContent?.stdout || "", /1.*hello/);

  const editPatch = "*** Begin Patch\n*** Update File: hello.txt\n@@\n-hello\n+world\n*** End Patch";
  assertOk(await call("apply_patch", { cwd: root, input: editPatch }));
  assert.equal(fs.readFileSync(file, "utf8"), "world\n");

  const stalePatch = "*** Begin Patch\n*** Update File: hello.txt\n@@\n-stale-context\n+wrong\n*** End Patch";
  assertError(await call("apply_patch", { cwd: root, input: stalePatch }), /patch context not found/i);
  assert.equal(fs.readFileSync(file, "utf8"), "world\n");

  const recoveredPatch = "*** Begin Patch\n*** Update File: hello.txt\n@@\n-world\n+patched\n*** End Patch";
  assertOk(await call("apply_patch", { cwd: root, input: recoveredPatch }));
  assert.equal(fs.readFileSync(file, "utf8"), "patched\n");

  const spacedDir = path.join(root, "dir with spaces");
  fs.mkdirSync(spacedDir);
  const spacedPatch = "*** Begin Patch\n*** Add File: dir with spaces/file name.txt\n+space-safe\n*** End Patch";
  assertOk(await call("apply_patch", { cwd: root, input: spacedPatch }));
  assert.equal(fs.readFileSync(path.join(spacedDir, "file name.txt"), "utf8"), "space-safe\n");

  const multiPatch = "*** Begin Patch\n*** Add File: ui-one.js\n+const one = 1;\n*** Add File: ui-two.py\n+print('two')\n*** End Patch";
  const multiResult = await call("apply_patch", { cwd: root, input: multiPatch });
  assert.equal(assertOk(multiResult), "Patch applied.");
  assert.match(multiResult.structuredContent?.diff || "", /\+\+\+ b\/ui-one\.js/);
  assert.match(multiResult.structuredContent?.diff || "", /\+\+\+ b\/ui-two\.py/);
  assert.ok(((multiResult.structuredContent?.diff || "").match(/@@ -0,0 \+1,1 @@/g) || []).length >= 2);

  const unifiedPatch = "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-patched\n+unified-still-works\n";
  assertOk(await call("apply_patch", { cwd: root, input: unifiedPatch }));
  assert.equal(fs.readFileSync(file, "utf8"), "unified-still-works\n");

  const defaultCwd = await call("execute_command", { command: "node --version" });
  assertOk(defaultCwd);
  const defaultPwd = await call("execute_command", { command: process.platform === "win32" ? "cd" : "pwd" });
  assert.match(defaultPwd.structuredContent?.stdout || "", new RegExp(fs.realpathSync(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const scratchCwd = await call("execute_command", { command: process.platform === "win32" ? "cd" : "pwd", cwd: localScratchDir });
  assertOk(scratchCwd);
  assert.match(scratchCwd.structuredContent?.stdout || "", new RegExp(localScratchDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("command and skill tools return UI-ready structured payloads", async () => {
  const commandResult = await call("execute_command", { command: "printf 'ui-command-ok\\n'", cwd: root });
  assert.equal(assertOk(commandResult), "Command succeeded.");
  assert.doesNotMatch(textOf(commandResult), /ui-command-ok/);
  assert.equal(commandResult.structuredContent?.ok, true);
  assert.match(commandResult.structuredContent?.stdout || "", /ui-command-ok/);
  assert.deepEqual(Object.keys(commandResult.structuredContent).sort(), ["ok", "stderr", "stdout"]);

  const projectSkill = path.join(root, ".agents", "skills", "integration-project-skill");
  fs.mkdirSync(projectSkill, { recursive: true });
  fs.writeFileSync(path.join(projectSkill, "SKILL.md"), "---\nname: integration-project-skill\ndescription: Integration project instructions.\n---\n");
  await call("workspace", { action: "open", path: root });
  const skillsResult = await call("discover_skills", { query: "integration project skill" });
  assert.match(assertOk(skillsResult), /^Found \d+ of \d+ skills\.$/);
  assert.doesNotMatch(textOf(skillsResult), /integration-project-skill/);
  assert.equal(Array.isArray(skillsResult.structuredContent?.skills), true);
  assert.equal(typeof skillsResult.structuredContent?.total, "number");
  assert.equal(skillsResult.structuredContent?.skills?.[0]?.name, "integration-project-skill");
  assert.equal(skillsResult.structuredContent?.skills?.[0]?.scope, "project");
});

test("human denial blocks destructive execution in the originating tool call", async () => {
  const victim = path.join(root, "reject-me.txt");
  fs.writeFileSync(victim, "keep me");
  const command = process.platform === "win32" ? `del /q "${victim}"` : `rm -f '${victim}'`;
  humanResponse = { status: "answered", answer: "Deny", source: "test", custom: false, optionIndex: 1 };
  lastHumanQuestion = null;
  const blocked = await call("execute_command", { command, cwd: root });
  assertError(blocked, /human denied/i);
  assert.equal(fs.existsSync(victim), true);
  assert.deepEqual(lastHumanQuestion?.options, ["Approve", "Deny"]);
  assert.equal(lastHumanQuestion?.allowCustom, true);
  assert.match(lastHumanQuestion?.question || "", /rm -f|del \/q/i);
});

test("execute_command hands long work to manage_task without stopping it", async () => {
  assertOk(await call("workspace", { action: "open", path: root }));

  const quickCommand = `"${process.execPath}" -e "console.log('quick-finished')"`;
  const quickResult = await call("execute_command", { command: quickCommand, waitMs: 3_000 });
  assert.equal(assertOk(quickResult), "Command succeeded.");
  assert.doesNotMatch(textOf(quickResult), /quick-finished/);
  const quick = quickResult.structuredContent;
  assert.equal(quick?.taskId, undefined);
  assert.equal(quick?.state, undefined);
  assert.equal(quick?.running, undefined);
  assert.equal(quick?.exitCode, undefined);
  assert.equal(quick?.waitTimedOut, undefined);
  assert.match(quick?.stdout || "", /quick-finished/);

  const delayedCommand = `"${process.execPath}" -e "setTimeout(() => console.log('wait-finished'), 450)"`;
  const firstResult = await call("execute_command", { command: delayedCommand, waitMs: 0 });
  assertOk(firstResult);
  const first = firstResult.structuredContent;
  assert.equal(first?.state, undefined);
  assert.equal(first?.running, true);
  assert.equal(first?.waitTimedOut, true);
  assert.match(first?.taskId || "", /^p_[A-Za-z0-9_]+$/);

  await new Promise((resolve) => setTimeout(resolve, 700));
  const completedResult = await call("manage_task", { action: "status", taskId: first.taskId });
  const completed = completedResult.structuredContent;
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.running, false);
  assert.equal(completed?.exitCode, 0);
  assert.match(completed?.stdout || "", /wait-finished/);

  const listResult = await call("manage_task", { action: "list" });
  assert.match(assertOk(listResult), /^Returned \d+ managed tasks \(\d+ running\)\.$/);
  assert.equal(Array.isArray(listResult.structuredContent?.tasks), true);
});

test("manage_task can send input to and kill durable command tasks", async () => {
  let inputTaskId = null;
  let longTaskId = null;
  try {
    const inputCommand = `"${process.execPath}" -e "process.stdin.setEncoding('utf8'); process.stdin.once('data', d => { console.log('received:' + d.trim()); process.exit(0); })"`;
    const startedInput = await call("execute_command", { command: inputCommand, waitMs: 0 });
    inputTaskId = startedInput.structuredContent?.taskId;
    assert.match(inputTaskId || "", /^p_[A-Za-z0-9_]+$/);
    assertOk(await call("manage_task", { action: "send_input", taskId: inputTaskId, input: "bridge-input\n" }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const inputStatus = await call("manage_task", { action: "status", taskId: inputTaskId });
    assert.equal(inputStatus.structuredContent?.state, "completed");
    assert.match(inputStatus.structuredContent?.stdout || "", /received:bridge-input/);

    const longCommand = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
    const startedLong = await call("execute_command", { command: longCommand, waitMs: 0 });
    longTaskId = startedLong.structuredContent?.taskId;
    assert.match(longTaskId || "", /^p_[A-Za-z0-9_]+$/);
    const killed = await call("manage_task", { action: "kill", taskId: longTaskId });
    assert.equal(killed.structuredContent?.state, "stopped");
    assert.equal(killed.structuredContent?.running, false);
  } finally {
    for (const taskId of [inputTaskId, longTaskId].filter(Boolean)) {
      await call("manage_task", { action: "kill", taskId });
    }
  }
});

test("bridge internal state is not exposed as a file-tool workspace", async () => {
  fs.mkdirSync(path.join(base, "state"), { recursive: true });
  fs.writeFileSync(path.join(base, "state", "state.json"), "{}\n");
  assertError(await call("display", { path: path.join(base, "state", "state.json") }), /outside Local System workspace roots/);
});

test("symlink escapes are rejected", { skip: process.platform === "win32" }, async () => {
  fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
  fs.symlinkSync(outside, path.join(root, "escape"), "dir");
  assertError(await call("display", { path: path.join(root, "escape", "secret.txt") }), /outside Local System workspace roots/);
});

test("destructive requests validate cwd before asking for human approval", async () => {
  lastHumanQuestion = null;
  const rejected = await call("execute_command", { command: "rm --version", cwd: outside });
  const text = assertError(rejected, /outside Local System workspace roots/);
  assert.equal(rejected.structuredContent, undefined);
  assert.equal(lastHumanQuestion, null);
  assert.doesNotMatch(text, /human approval/i);
});

test("destructive execute_command stays pending until the human answers", async () => {
  const victim = path.join(root, "pending-approval-delete-me.txt");
  fs.writeFileSync(victim, "temporary");
  const command = process.platform === "win32" ? `del /q "${victim}"` : `rm -f '${victim}'`;
  let releaseApproval;
  humanResponse = new Promise((resolve) => { releaseApproval = resolve; });
  let settled = false;
  const pending = call("execute_command", { command, cwd: root, waitMs: 3_000 }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "the tool call must remain open while human approval is pending");
  assert.equal(fs.existsSync(victim), true, "the destructive command must not start before approval");

  releaseApproval({ status: "answered", answer: "Approve", source: "test", custom: false, optionIndex: 0 });
  const executed = await pending;
  assertOk(executed);
  assert.equal((executed.structuredContent?.approvalWaitMs || 0) >= 40, true);
  assert.equal(fs.existsSync(victim), false);
});

test("custom human approval response redirects the agent without executing", async () => {
  const victim = path.join(root, "approval-redirect-delete-me.txt");
  fs.writeFileSync(victim, "temporary");
  const command = process.platform === "win32" ? `del /q "${victim}"` : `rm -f '${victim}'`;
  const instruction = "Keep this file and inspect why it exists first";
  humanResponse = { status: "answered", answer: instruction, source: "test", custom: true, optionIndex: null };
  lastHumanQuestion = null;
  const result = await call("execute_command", { command, cwd: root });
  const text = assertError(result, /Human instruction:/i);
  assert.match(text, new RegExp(instruction));
  assert.match(text, /No destructive action was executed/i);
  assert.equal(fs.existsSync(victim), true);
  assert.equal(lastHumanQuestion?.allowCustom, true);
});

test("destructive approval timeout tells the agent to retry only if still necessary", async () => {
  const victim = path.join(root, "approval-timeout-delete-me.txt");
  fs.writeFileSync(victim, "temporary");
  const command = process.platform === "win32" ? `del /q "${victim}"` : `rm -f '${victim}'`;
  humanResponse = { status: "timeout", answer: null, source: "timeout", custom: false, timeoutMs: 300_000 };
  const result = await call("execute_command", { command, cwd: root });
  const text = assertError(result, /invoke the original tool call again/i);
  assert.match(text, /otherwise continue without it/i);
  assert.equal(fs.existsSync(victim), true);
});

test("explicit human approval executes the exact destructive command and patch inline", async () => {
  const victim = path.join(root, "delete-me.txt");
  fs.writeFileSync(victim, "temporary");
  const command = process.platform === "win32" ? `del /q "${victim}"` : `rm -f '${victim}'`;
  humanResponse = { status: "answered", answer: "Approve", source: "test", custom: false, optionIndex: 0 };
  lastHumanQuestion = null;
  const executed = await call("execute_command", { command, cwd: root, waitMs: 3_000 });
  assertOk(executed);
  assert.equal(typeof executed.structuredContent?.approvalWaitMs, "number");
  assert.equal(fs.existsSync(victim), false);
  assert.match(lastHumanQuestion?.question || "", /delete-me\.txt/);
  assert.equal(lastHumanQuestion?.allowCustom, true);

  const patchVictim = path.join(root, "patch-victim.txt");
  fs.writeFileSync(patchVictim, "content\n");
  const deletePatch = "*** Begin Patch\n*** Delete File: patch-victim.txt\n*** End Patch";
  lastHumanQuestion = null;
  const patchResult = await call("apply_patch", { cwd: root, input: deletePatch });
  assertOk(patchResult);
  assert.equal(fs.existsSync(patchVictim), false);
  assert.match(lastHumanQuestion?.question || "", /patch would delete one or more files/i);
  assert.equal(lastHumanQuestion?.allowCustom, true);
});

test("destructive execute_command preserves waitMs handoff after human approval", { skip: process.platform === "win32" }, async () => {
  const victim = path.join(root, "waitms-delete-me.txt");
  fs.writeFileSync(victim, "temporary");
  const command = `sh -c 'sleep 0.35; rm -f "${victim}"'`;
  humanResponse = { status: "answered", answer: "Approve", source: "test", custom: false, optionIndex: 0 };
  const started = await call("execute_command", { command, cwd: root, waitMs: 0 });
  assert.equal(started.structuredContent?.running, true);
  const taskId = started.structuredContent?.taskId;
  assert.match(taskId || "", /^p_[A-Za-z0-9_]+$/);
  assert.equal(fs.existsSync(victim), true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const status = await call("manage_task", { action: "status", taskId });
  assert.equal(status.structuredContent?.state, "completed");
  assert.equal(status.structuredContent?.exitCode, 0);
  assert.equal(fs.existsSync(victim), false);
});

test("execute_command caps the output it puts in the model's context", async () => {
  await call("workspace", { action: "open", path: root });
  // tailFile keeps the last 80 lines but up to 256 KB, and structuredContent is
  // never clipped anywhere else, so a single long line used to arrive whole.
  const command = `"${process.execPath}" -e "process.stdout.write('x'.repeat(200000))"`;
  const result = await call("execute_command", { command, waitMs: 20_000 });
  assertOk(result);
  const stdout = result.structuredContent?.stdout || "";
  assert.ok(stdout.length < 30_000, `stdout was ${stdout.length} chars`);
  assert.match(stdout, /truncated \d+ chars/);
  // The tail is what a caller needs: the end of a log holds the outcome.
  assert.match(stdout, /x{100}$/);
});

function unpackToolResult(result) {
  if (result && !result.structuredContent && Array.isArray(result.content)) {
    const text = result.content.find((b) => b?.type === "text")?.text;
    if (typeof text === "string") {
      const match = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (match) {
        try {
          result.structuredContent = JSON.parse(match[1]);
        } catch {}
      }
    }
  }
  return result;
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return unpackToolResult(result);
}

function textOf(result) {
  const raw = (result?.content || []).map((item) => item?.text || "").join("\n");
  const jsonIndex = raw.indexOf("\n\n```json\n");
  return jsonIndex !== -1 ? raw.slice(0, jsonIndex) : raw;
}

function assertOk(result) {
  const text = textOf(result);
  assert.equal(Boolean(result.isError), false, text);
  return text;
}

function assertError(result, pattern) {
  const raw = (result?.content || []).map((item) => item?.text || "").join("\n");
  assert.equal(Boolean(result.isError), true, raw);
  assert.match(raw, pattern);
  return raw;
}

test("browser binding token deterministically binds one ChatGPT thread to one MCP conversation", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "d6a9730d-cc46-45bf-a15f-28c6796fd3f1";
  const otherThreadId = "914ec738-17fc-4da9-8596-5959f93d1aec";
  const conversationId = "v1/token-browser-session";

  runWithConversationId(conversationId, () => {
    updateConversationState({ currentWorkspace: root });
    writeTodos({ todos: [{ id: "token", content: "Token binding", status: "pending" }], merge: false });
  });
  const token = issueBrowserBindingToken(conversationId);
  assert.match(token, /^[A-Za-z0-9_-]{24,128}$/);

  const bindResponse = await fetch(`${origin}/local-ui/thread-bind-token`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, token }),
  });
  assert.equal(bindResponse.status, 200);
  assert.equal((await bindResponse.json()).bound, true);

  const todosResponse = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, active: false }),
  });
  const todos = await todosResponse.json();
  assert.equal(todos.bound, true);
  assert.deepEqual(todos.todos, [{ id: "token", content: "Token binding", status: "pending" }]);

  const stealResponse = await fetch(`${origin}/local-ui/thread-bind-token`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId: otherThreadId, token }),
  });
  const steal = await stealResponse.json();
  assert.equal(steal.bound, false);
  assert.equal(steal.conflict, true);
  assert.equal(steal.reason, "token-already-bound");
});

test("observed bridge_context conversation deterministically binds the browser thread without an MCP App", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const threadId = "871bbafd-f38f-4dca-8940-ab853c26e570";
  const conversationId = "v1/observed-browser-session";

  runWithConversationId(conversationId, () => {
    updateConversationState({ currentWorkspace: root });
    writeTodos({ todos: [{ id: "observed", content: "Observed binding", status: "pending" }], merge: false });
  });

  recordRecentWebConversationFromBody({
    method: "tools/call",
    params: {
      name: "bridge_context",
      _meta: {
        "openai/session": conversationId,
        "openai/userAgent": "Mozilla/5.0 test-browser",
      },
    },
  });

  const bindResponse = await fetch(`${origin}/local-ui/thread-bind-observed`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, conversationId }),
  });
  assert.equal(bindResponse.status, 200);
  const bind = await bindResponse.json();
  assert.equal(bind.bound, true);

  const todosResponse = await fetch(`${origin}/local-ui/todos`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ threadId, active: false }),
  });
  const todos = await todosResponse.json();
  assert.equal(todos.bound, true);
  assert.deepEqual(todos.todos, [{ id: "observed", content: "Observed binding", status: "pending" }]);

  const unseenResponse = await fetch(`${origin}/local-ui/thread-bind-observed`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({
      threadId: "1673ccb8-fb3e-4ec9-a9d9-0bea8bbb69b8",
      conversationId: "v1/not-observed-by-mcp",
    }),
  });
  assert.equal(unseenResponse.status, 200);
  const unseen = await unseenResponse.json();
  assert.equal(unseen.bound, false);
  assert.equal(unseen.observed, false);
});
