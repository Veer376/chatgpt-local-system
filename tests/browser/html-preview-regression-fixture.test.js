/* global document, getComputedStyle */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(repoRoot, "tests/fixtures/html-preview-regression");
const chromePath = discoverChrome();

const fixtureFiles = new Map([
  ["/index.html", { type: "text/html; charset=utf-8", body: readFileSync(path.join(fixtureRoot, "index.html")) }],
  ["/styles.css", { type: "text/css; charset=utf-8", body: readFileSync(path.join(fixtureRoot, "styles.css")) }],
  ["/app.js", { type: "text/javascript; charset=utf-8", body: readFileSync(path.join(fixtureRoot, "app.js")) }],
  ["/preview-badge.svg", { type: "image/svg+xml", body: readFileSync(path.join(fixtureRoot, "preview-badge.svg")) }],
]);

let browser = null;
let server = null;
let fixtureUrl = "";

test.before(async () => {
  if (!chromePath) return;

  server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const fixture = fixtureFiles.get(url.pathname);
    if (!fixture) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": fixture.type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(fixture.body);
  });
  server.listen(0, "127.0.0.1");
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  fixtureUrl = `http://127.0.0.1:${address.port}/index.html`;

  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  });
});

test.after(async () => {
  await browser?.close();
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
});

test("complex HTML preview fixture works inside the production sandbox shape", { skip: !chromePath }, async () => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 760 } });
  const page = await context.newPage();
  const pageErrors = [];
  const requestFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => requestFailures.push({
    url: request.url(),
    error: request.failure()?.errorText || "unknown",
  }));

  try {
    await page.setContent(
      `<iframe id="preview" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${fixtureUrl}" style="width:100%;height:720px;border:0"></iframe>`,
    );

    const frame = page.frameLocator("#preview");
    await frame.locator("#ready-marker").filter({ hasText: "Regression fixture ready" }).waitFor();

    assert.equal(await page.locator("#preview").getAttribute("sandbox"), "allow-scripts");
    assert.equal(await frame.locator("#runtime-status").textContent(), "JavaScript ready");
    assert.equal(await frame.locator("body").evaluate(() => globalThis.__htmlPreviewRegression?.ready), true);
    assert.equal(await frame.locator(".brand-mark").evaluate((image) => image.complete && image.naturalWidth > 0), true);
    assert.equal(await frame.locator(".brand-mark").evaluate((image) => getComputedStyle(image).width), "36px");

    await frame.locator("#increment").click();
    await frame.locator("#burst").click();
    assert.equal(await frame.locator("#counter-value").textContent(), "11");

    await frame.locator("#note-input").fill("A note typed into the sandboxed HTML preview.");
    assert.equal(await frame.locator("#character-count").textContent(), "45 characters");
    await frame.locator("#note-input").press("Control+Enter");
    assert.equal(await frame.locator("#note-count").textContent(), "1");
    assert.match(await frame.locator("#note-list li").first().textContent(), /A note typed into the sandboxed HTML preview\./);

    assert.equal(await frame.locator("#activity-feed .activity-row").count(), 36);
    const nestedScroll = await frame.locator("#activity-feed").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      };
    });
    assert.ok(nestedScroll.scrollHeight > nestedScroll.clientHeight);
    assert.ok(nestedScroll.scrollTop > 0);

    await frame.locator("[data-filter=\"warn\"]").click();
    assert.equal(await frame.locator("#activity-feed .activity-row").count(), 6);
    assert.equal(await frame.locator("#activity-feed .activity-row[data-status=\"warn\"]").count(), 6);

    await frame.locator("#load-slider").evaluate((input) => {
      input.value = "73";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await frame.locator("#slider-value").textContent(), "73%");
    assert.equal(await frame.locator("#progress-fill").evaluate((node) => node.style.width), "73%");

    await frame.locator("[data-tab=\"events\"]").click();
    assert.match(await frame.locator("#tab-panel").textContent(), /buttons, input, submit, resize, range, and keyboard listeners/i);

    await frame.locator("#display-name").fill("Arya Regression");
    await frame.locator("#scenario").selectOption({ label: "JavaScript execution" });
    await frame.locator("#free-form").fill("focus and typing remain inside the preview");
    await frame.locator("#capture-form").click();
    assert.equal(await frame.locator("#event-count").textContent(), "1");
    assert.match(await frame.locator("#form-output").textContent(), /Arya Regression.*JavaScript execution/);

    const pageScroll = await frame.locator("body").evaluate(() => {
      globalThis.scrollTo(0, document.documentElement.scrollHeight);
      return {
        y: globalThis.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: globalThis.innerHeight,
      };
    });
    assert.ok(pageScroll.scrollHeight > pageScroll.innerHeight);
    assert.ok(pageScroll.y > 0);

    await frame.locator("#theme-toggle").click();
    assert.equal(await frame.locator("body").evaluate((body) => body.classList.contains("high-contrast")), true);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(requestFailures, []);
  } finally {
    await context.close();
  }
});

function discoverChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}
