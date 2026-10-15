import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const manifest = JSON.parse(readFileSync(new URL("../../extensions/local-system/manifest.json", import.meta.url), "utf8"));
const script = readFileSync(new URL("../../extensions/local-system/interaction-content.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../extensions/local-system/interaction-content.css", import.meta.url), "utf8");
const background = readFileSync(new URL("../../extensions/local-system/background.js", import.meta.url), "utf8");
const extensionApi = readFileSync(new URL("../../extensions/local-system/extension-api.js", import.meta.url), "utf8");

function extractLocalMediaHelpers(source) {
  const match = source.match(/function collectLocalPresentationMedia\([\s\S]*?\n\s*function renderPresentationContent/);
  if (!match) throw new Error("Could not extract local presentation media helpers");
  const code = `${match[0].replace(/\n\s*function renderPresentationContent$/, "")}
exports.collect = collectLocalPresentationMedia;
exports.isLocal = isLocalPresentationMedia;
exports.path = localPresentationPath;`;
  const context = { exports: {} };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.exports;
}

test("interaction composer surface uses the background-owned Local System API and long polling", () => {
  const content = manifest.content_scripts.find((item) => item.js?.includes("interaction-content.js"));
  assert.ok(content.js.includes("interaction-content.js"));
  assert.ok(content.css.includes("interaction-content.css"));
  assert.ok(content.js.indexOf("extension-api.js") < content.js.indexOf("annotations-content.js"));
  assert.ok(content.js.indexOf("interaction-content.js") > content.js.indexOf("annotations-content.js"));
  assert.match(script, /action:\s*"wait"/);
  assert.match(script, /timeoutMs:\s*WAIT_MS/);
  assert.match(background, /"\/local-ui\/interactions"/);
  assert.match(extensionApi, /LocalSystemExtensionApi/);
  assert.doesNotMatch(background, /x-local-system-extension":\s*"1"/);
});

test("question UI renders above the composer with options, free response, skip and next", () => {
  assert.match(script, /document\.body\.append\(host\)/);
  assert.match(script, /positionHost\(composer\)/);
  assert.match(script, /host\.style\.bottom/);
  assert.doesNotMatch(script, /composer\.before\(host\)/);
  assert.match(script, /ls-interaction-option/);
  assert.match(script, /Or write your own response/);
  assert.match(script, /response\.addEventListener\("click", \(\) => input\.focus/);
  assert.match(script, /actionButton\("Skip"\)/);
  assert.match(script, /questionCount > 1 \? "Next" : "Submit"/);
  assert.match(css, /\.ls-interaction-card\s*\{/);
  assert.match(css, /border-radius:\s*var\(--ls-ui-radius-floating,\s*14px\)/);
  assert.match(css, /box-shadow:\s*var\(--ls-ui-shadow-dialog/);
  assert.match(css, /\.ls-interaction-button\s*\{[^}]*border-radius:\s*var\(--ls-ui-radius-button,\s*14px\)/s);
  assert.doesNotMatch(css, /\.ls-interaction-card\s*\{[^}]*border:\s*1px/s);
  assert.match(css, /\.ls-interaction-host\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*2147483000;[^}]*pointer-events:\s*auto;/s);
});

test("question UI mirrors the request_user_input question deadline with a live countdown", () => {
  assert.match(script, /Number\(interaction\.expiresAt\)/);
  assert.match(script, /startCountdown\(timer, expiresAt\)/);
  assert.match(script, /globalThis\.setInterval\(update, 1_000\)/);
  assert.match(script, /remainingSeconds <= 30/);
  assert.match(css, /\.ls-interaction-timer/);
  assert.match(css, /data-urgency="critical"/);
});

test("interrupt UI supports sandboxed rich content and image input", () => {
  assert.match(script, /frame\.setAttribute\("sandbox", "allow-same-origin"\)/);
  assert.match(script, /Content-Security-Policy/);
  assert.match(script, /action:\s*"upload"/);
  assert.match(script, /addEventListener\("paste"/);
  assert.match(script, /addEventListener\("drop"/);
  assert.match(script, /attachmentInput\.click\(\)/);
  assert.match(css, /\.ls-interaction-rich__frame/);
  assert.match(css, /\.ls-interaction-attachments/);
  assert.match(css, /\.ls-interaction-rich\s*\{[^}]*border:0;[^}]*background:transparent;/s);
  assert.match(css, /\.ls-interaction-rich__zoom-label/);
  assert.match(script, /Math\.max\(\.5, Math\.min\(2,/);
  assert.match(script, /frame\.style\.transform = `scale\(\$\{zoom\}\)`/);
  assert.ok(script.includes('stage.style.width = `${zoom * 100}%`;'));
  assert.ok(script.includes('contentResizeObserver = new ResizeObserver(syncContentHeight);'));
  assert.ok(script.includes('head.append(richPresentation.controls);'));
  assert.match(css, /\.ls-interaction-rich__viewport\s*\{[^}]*max-height:min\(460px,52vh\);[^}]*overflow-y:auto;/s);
});

test("rich content resolves ordinary local Markdown and HTML media references through authorized file tickets", () => {
  const helpers = extractLocalMediaHelpers(script);
  const content = [
    "![Reference](./assets/reference.png)",
    '<video controls src="/Users/test/project/output.mp4"></video>',
    '<video controls poster="../assets/poster.webp"><source src="./clips/scene.mov"></video>',
    '<img src="https://example.com/remote.png">',
  ].join("\n");

  assert.deepEqual(
    Array.from(helpers.collect(content)).sort(),
    ["./assets/reference.png", "/Users/test/project/output.mp4", "../assets/poster.webp", "./clips/scene.mov"].sort(),
  );
  assert.equal(helpers.isLocal("https://example.com/remote.png"), false);
  assert.equal(helpers.isLocal("data:image/png;base64,abc"), false);
  assert.equal(helpers.path("./clips/my%20scene.mp4"), "./clips/my scene.mp4");
  assert.match(script, /apiRequest\("\/local-ui\/files\/resolve"/);
  assert.match(script, /img-src data: blob: \$\{allowedOrigins\}/);
  assert.match(script, /media-src data: blob: \$\{allowedOrigins\}/);
});

test("content-only interrupt UI hides its synthetic question but keeps custom response input", () => {
  assert.match(script, /!interaction\.presentationOnly && !interaction\.contentOnly/);
  assert.match(script, /!interaction\.presentationOnly && interaction\.allowCustom !== false/);
  assert.match(script, /interaction\.presentationOnly \|\| interaction\.contentOnly/);
  assert.match(script, /interaction\.contentOnly \? "Continue"/);
});

test("submitting one question cannot clear a newer question that arrived concurrently", () => {
  assert.match(script, /if \(payload\?\.interaction\?\.id && payload\.interaction\.id !== hiddenRequestId\) \{\s*setInteraction\(payload\.interaction\);/s);
  assert.match(script, /else if \(activeInteraction\?\.id === interaction\.id\) \{\s*clearInteraction\(\);/s);
  assert.doesNotMatch(script, /revision = Number\(payload\?\.revision\) \|\| revision;\s*clearInteraction\(\);/s);
});

test("interaction UI avoids per-mutation style/layout work while ChatGPT is streaming", () => {
  assert.match(script, /if \(!host\?\.isConnected \|\| !observedComposer\?\.isConnected\) scheduleInteractionLayout\(\)/);
  assert.doesNotMatch(script, /new MutationObserver\([^]*ensureMounted\(\)[^]*\)\.observe/);
  assert.match(script, /new ResizeObserver\(\(\) => scheduleInteractionLayout\(\)\)/);
});

test("approval UI reuses the composer surface with explicit deny and approve actions", () => {
  assert.match(script, /interaction\.kind === "approval"/);
  assert.match(script, /actionButton\("Deny", "danger"\)/);
  assert.match(script, /actionButton\("Approve", "primary"\)/);
  assert.match(script, /Or write a different instruction/);
  assert.match(script, /renderSections\(interaction\.sections\)/);
});
