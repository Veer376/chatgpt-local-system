/* global document, MouseEvent, window */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";

const content = readFileSync(new URL("../../extensions/local-system/content.js", import.meta.url), "utf8");
const start = content.indexOf("const LOCAL_FILE_EXTENSION_PATTERN =");
const end = content.indexOf("const DIRECTORY_PATH_RE =", start);
const anchorStart = content.indexOf("function localFilePathFromAnchor(");
const anchorEnd = content.indexOf("function contextualFilePath(", anchorStart);
const linkHelpers = `${content.slice(start, end)}\n${content.slice(anchorStart, anchorEnd)}`;

test("rendered local-file hyperlinks open the scoped workspace without hijacking web links", async (t) => {
  const executablePath = process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  } catch (error) {
    t.skip(`No test browser available: ${error.message}`);
    return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main><article data-message-author-role="assistant"><div class="markdown">
      <p><a id="local" href="/Users/example/Projects/venture-lab/notes.md"><span>notes.md</span></a></p>
      <p><a id="web" href="https://example.com/notes.md">Website</a></p>
      <p><a id="relative" href="docs/notes.md">Relative website link</a></p>
      <p><a id="protocol-relative" href="//example.com/notes.md">Other host</a></p>
    </div></article></main>
  `);
  await page.addScriptTag({ content: `
    ${linkHelpers}
    const isAbsoluteLocalFilePath = (value) => value.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(value);
    const conversationContentRootFor = (element) => element.closest('main [data-message-author-role="assistant"]');
    window.__calls = [];
    const traceWorkspace = () => Promise.resolve();
    const requestNativeSidePanel = () => { window.__calls.push('panel'); return 'opened'; };
    const primeInlineFileLink = async (_link, path) => ({ path });
    const scheduleInlineFileLinkResolution = (link, path) => {
      link.dataset.resolveState = 'ready';
      link.dataset.resolvedPath = path;
    };
    const switchWorkspaceForResolvedFile = async (path) => { window.__calls.push('switch:' + path); };
    const openFileFromChatGpt = (path) => { window.__calls.push('open:' + path); };
    window.enhanceLocalFileAnchors = enhanceLocalFileAnchors;
  ` });
  const result = await page.evaluate(async () => {
    window.enhanceLocalFileAnchors(document.body);
    window.enhanceLocalFileAnchors(document.body);
    const anchor = document.querySelector("#local");
    const fileEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(fileEvent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const web = ["web", "relative", "protocol-relative"].map((id) => document.getElementById(id));
    return {
      fileIntercepted: fileEvent.defaultPrevented,
      path: anchor.dataset.localPath,
      caption: anchor.textContent,
      nestedSpanPreserved: !!anchor.querySelector("span"),
      markedWebAnchors: web.filter((item) => item.dataset.localSystemFileAnchor).map((item) => item.id),
      calls: window.__calls,
    };
  });
  assert.equal(result.fileIntercepted, true);
  assert.equal(result.path, "/Users/example/Projects/venture-lab/notes.md");
  assert.equal(result.caption, "notes.md");
  assert.equal(result.nestedSpanPreserved, true);
  assert.deepEqual(result.markedWebAnchors, []);
  assert.deepEqual(result.calls, [
    "panel",
    "switch:/Users/example/Projects/venture-lab/notes.md",
    "open:/Users/example/Projects/venture-lab/notes.md",
  ]);
});
