/* global document, window */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";

const source = readFileSync(new URL("../../extensions/local-system/content.js", import.meta.url), "utf8");
const section = (first, last) => {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start);
  assert.ok(start >= 0 && end > start, `missing source section ${first}`);
  return source.slice(start, end);
};

test("new ChatGPT conversation region resolves existing and streamed paths without touching composer or sites", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.platform === "darwin"
        ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
        : {}),
    });
  } catch (error) {
    t.skip(`Chrome unavailable: ${error.message}`);
    return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main><div role="region" aria-label="Conversation" data-app-action-timeline-scroll>
      <div class="thread-content">
        <p id="plain">Open /Users/example/Projects/venture-lab/notes.md for me.</p>
        <p><a id="local-anchor" href="/Users/example/Projects/venture-lab/notes.md">Venture Lab notes</a></p>
        <p><a id="external" href="https://example.com/notes.md">Online notes</a></p>
      </div>
      <div data-thread-scroll-footer><p id="composer">/Users/example/Projects/venture-lab/private.md</p></div>
    </div></main>
    <aside id="sidebar">/Users/example/Projects/venture-lab/sidebar.md</aside>
  `);
  const helpers = [
    section("const LOCAL_FILE_EXTENSION_PATTERN", "const CHATGPT_DISCLAIMER_TEXT"),
    section("const MESSAGE_ROLE_SELECTOR", "const seen = new WeakMap"),
    section("function scan(root)", "function hideChatGptDisclaimer(root)"),
    section("function conversationContentRootFor(node)", "function scheduleInlineFileLinkResolution(link, path"),
  ].join("\n");
  await page.addScriptTag({ content: `
    ${helpers}
    const seen = new WeakMap();
    const CHATGPT_DISCLAIMER_TEXT = "ChatGPT can make mistakes. Check important info.";
    const inlineFilePreviewErrors = new Map();
    const pendingInlineFileScanRoots = new Set();
    const observedConversationRoots = new WeakSet();
    const activeConversationRoots = new WeakSet();
    const conversationVisibilityObserver = null;
    const inlineFileLinkVisibilityObserver = null;
    let inlineFileScanTimer = 0;
    const flushInlineFileScans = () => {
      for (const root of pendingInlineFileScanRoots) if (root.isConnected) scan(root);
      pendingInlineFileScanRoots.clear();
    };
    const cleanPath = (path) => path;
    const cleanDirectoryPath = (path) => path;
    const addPreview = () => {};
    const applyInlineFilePathError = () => {};
    const clearInlineFilePathError = () => {};
    const scheduleInlineFileLinkResolution = (link, path) => {
      link.dataset.resolveState = "ready";
      link.dataset.resolvedPath = path;
    };
    const primeInlineFileLink = async (_link, path) => ({path});
    const traceWorkspace = () => {};
    const requestNativeSidePanel = () => "opened";
    const switchWorkspaceForResolvedFile = async () => {};
    const openFileFromChatGpt = (path) => {window.__opened = path};
    const isAbsoluteLocalFilePath = (value) => value.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(value);
    window.__scan = scan;
    window.__register = registerConversationRoots;
    window.__schedule = scheduleInlineFileScan;
    window.__rootFor = conversationContentRootFor;
  ` });
  const result = await page.evaluate(async () => {
    window.__register(document.body);
    const region = document.querySelector('[aria-label="Conversation"]');
    const registered = [...region.querySelectorAll(".local-system-inline-file-path")];
    const plain = document.querySelector("#plain .local-system-inline-file-path");
    const existingLink = document.querySelector("#local-anchor");
    const initial = {
      count: registered.length,
      plainPath: plain?.dataset.localPath,
      linkedPath: existingLink.dataset.localPath,
      externalHijacked: !!document.querySelector("#external").dataset.localSystemFileAnchor,
      composerHijacked: !!document.querySelector("#composer .local-system-inline-file-path"),
      sidebarHijacked: !!document.querySelector("#sidebar .local-system-inline-file-path"),
      composerRoot: window.__rootFor(document.querySelector("#composer").firstChild),
    };
    const appended = document.createElement("p");
    appended.id = "streamed";
    appended.textContent = "Also check /Users/example/Projects/venture-lab/PLAN.md";
    region.querySelector(".thread-content").append(appended);
    window.__schedule(appended);
    await new Promise((r) => setTimeout(r, 180));
    const streamed = appended.querySelector(".local-system-inline-file-path")?.dataset.localPath;
    existingLink.click();
    await new Promise((r) => setTimeout(r, 20));
    return { initial, streamed, opened: window.__opened };
  });
  assert.equal(result.initial.count, 2);
  assert.equal(result.initial.plainPath, "/Users/example/Projects/venture-lab/notes.md");
  assert.equal(result.initial.linkedPath, "/Users/example/Projects/venture-lab/notes.md");
  assert.equal(result.initial.externalHijacked, false);
  assert.equal(result.initial.composerHijacked, false);
  assert.equal(result.initial.sidebarHijacked, false);
  assert.equal(result.initial.composerRoot, null);
  assert.equal(result.streamed, "/Users/example/Projects/venture-lab/PLAN.md");
  assert.equal(result.opened, "/Users/example/Projects/venture-lab/notes.md");
});
