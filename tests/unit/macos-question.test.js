import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { prepareNativePresentationContent, startMacQuestion, startMacQuestionSession } from "../../src/lib/macos-question.js";

const nativeHelper = readFileSync(new URL("../../scripts/macos-ask-user.py", import.meta.url), "utf8");
const nativeUi = readFileSync(new URL("../../scripts/macos-question-ui.html", import.meta.url), "utf8");

test("non-macOS platforms skip the native question UI", async () => {
  const handle = startMacQuestion(
    { requestId: "request-1", question: "Pick", options: ["A"] },
    { platform: "linux" },
  );
  assert.deepEqual(await handle.promise, { status: "unavailable", reason: "unsupported_platform" });
});

test("native helper answered output is normalized for the shared request", async () => {
  const child = fakeChild();
  child.stdin.once("finish", () => {
    child.stdout.end(`${JSON.stringify({
      status: "answered",
      answer: "Custom native answer",
      custom: true,
      optionIndex: null,
    })}\n`);
    child.emit("close", 0);
  });
  const handle = startMacQuestion(
    { requestId: "request-2", question: "Pick", options: ["A", "B"] },
    { platform: "darwin", spawnImpl: () => child },
  );

  assert.deepEqual(await handle.promise, {
    status: "answered",
    answer: "Custom native answer",
    answers: ["Custom native answer"],
    custom: true,
    optionIndex: null,
    optionIndexes: null,
  });
  assert.equal(child.stdinText.includes('"question":"Pick"'), true);
  assert.equal(child.stdinText.includes('"multiSelect":false'), true);
});

test("native helper preserves image attachments and interaction result metadata", async () => {
  const child = fakeChild();
  child.stdin.once("finish", () => {
    child.stdout.end(`${JSON.stringify({
      status: "answered",
      answer: "Attached image",
      answers: ["Attached image"],
      custom: true,
      optionIndex: null,
      optionIndexes: null,
      attachments: [{ path: "/tmp/native-image.webp", name: "native-image.webp", mimeType: "image/webp", bytes: 1234 }],
      skipped: true,
      presentationOnly: true,
    })}\n`);
    child.emit("close", 0);
  });
  const handle = startMacQuestion(
    { requestId: "request-image", question: "Show me", options: [] },
    { platform: "darwin", spawnImpl: () => child },
  );

  assert.deepEqual(await handle.promise, {
    status: "answered",
    answer: "Attached image",
    answers: ["Attached image"],
    custom: true,
    optionIndex: null,
    optionIndexes: null,
    attachments: [{ path: "/tmp/native-image.webp", name: "native-image.webp", mimeType: "image/webp", bytes: 1234 }],
    skipped: true,
    presentationOnly: true,
  });
});

test("native multi-select output keeps every chosen option and its index", async () => {
  const child = fakeChild();
  child.stdin.once("finish", () => {
    child.stdout.end(`${JSON.stringify({
      status: "answered",
      answer: "A, C",
      answers: ["A", "C"],
      custom: false,
      optionIndex: null,
      optionIndexes: [0, 2],
    })}\n`);
    child.emit("close", 0);
  });
  const handle = startMacQuestion(
    { requestId: "request-multi", question: "Pick some", options: ["A", "B", "C"], multiSelect: true },
    { platform: "darwin", spawnImpl: () => child },
  );

  assert.deepEqual(await handle.promise, {
    status: "answered",
    answer: "A, C",
    answers: ["A", "C"],
    custom: false,
    optionIndex: null,
    optionIndexes: [0, 2],
  });
  assert.equal(child.stdinText.includes('"multiSelect":true'), true);
});

test("native helper receives strict no-custom mode for approval prompts", async () => {
  const child = fakeChild();
  child.stdin.once("finish", () => {
    child.stdout.end(`${JSON.stringify({
      status: "answered",
      answer: "Approve",
      custom: false,
      optionIndex: 0,
    })}\n`);
    child.emit("close", 0);
  });
  const handle = startMacQuestion(
    { requestId: "request-strict", question: "Approve?", options: ["Approve", "Deny"], allowCustom: false },
    { platform: "darwin", spawnImpl: () => child },
  );
  const result = await handle.promise;
  assert.equal(result.answer, "Approve");
  assert.equal(JSON.parse(child.stdinText).allowCustom, false);
});


test("native helper receives the macOS-specific full question and title", async () => {
  const child = fakeChild();
  child.stdin.once("finish", () => {
    child.stdout.end(`${JSON.stringify({
      status: "answered",
      answer: "Approve",
      custom: false,
      optionIndex: 0,
    })}\n`);
    child.emit("close", 0);
  });
  const full = `command ${"x".repeat(8_000)}`;
  const handle = startMacQuestion(
    {
      requestId: "request-full",
      title: "Approval",
      question: "short transport-safe question",
      macQuestion: full,
      options: ["Approve", "Deny"],
    },
    { platform: "darwin", spawnImpl: () => child },
  );

  await handle.promise;
  const payload = JSON.parse(child.stdinText);
  assert.equal(payload.title, "Approval");
  assert.equal(payload.question, full);
});

test("native helper receives the modern interaction model and a scratch attachment directory", async () => {
  const child = fakeChild();
  child.stdin.once("finish", () => {
    child.stdout.end(`${JSON.stringify({
      status: "answered",
      answer: "Approve",
      custom: false,
      optionIndex: 0,
    })}\n`);
    child.emit("close", 0);
  });
  const expiresAt = Date.now() + 60_000;
  const handle = startMacQuestion(
    {
      requestId: "request-modern",
      title: "Approval",
      question: "Approve?",
      options: ["Approve", "Deny"],
      interactionKind: "approval",
      content: "<strong>Preview</strong>",
      questionIndex: 1,
      questionCount: 3,
      expiresAt,
    },
    { platform: "darwin", spawnImpl: () => child },
  );
  await handle.promise;
  const payload = JSON.parse(child.stdinText);
  assert.equal(payload.interactionKind, "approval");
  assert.equal(payload.content, "<strong>Preview</strong>");
  assert.equal(payload.questionIndex, 1);
  assert.equal(payload.questionCount, 3);
  assert.equal(payload.expiresAt, expiresAt);
  assert.match(payload.attachmentDir, /interrupts[\\/]request-modern$/);
});

test("native questionnaire session keeps one helper alive across sequential questions", async () => {
  const child = fakeChild();
  let spawns = 0;
  const session = startMacQuestionSession({
    platform: "darwin",
    spawnImpl: () => { spawns += 1; return child; },
  });
  assert.equal(session.isClosed(), false);

  const first = session.ask({
    requestId: "session-1",
    title: "Question 1 of 2",
    question: "First?",
    options: ["A", "B"],
  });
  first.close({ keepOpen: true });
  assert.deepEqual(await first.promise, { status: "cancelled", reason: "resolved_elsewhere" });

  const second = session.ask({
    requestId: "session-2",
    title: "Question 2 of 2",
    question: "Second?",
    options: ["C", "D"],
  });
  child.stdout.write(`${JSON.stringify({
    requestId: "session-2",
    status: "answered",
    answer: "D",
    custom: false,
    optionIndex: 1,
  })}\n`);
  assert.deepEqual(await second.promise, {
    status: "answered",
    answer: "D",
    answers: ["D"],
    custom: false,
    optionIndex: 1,
    optionIndexes: [1],
  });
  second.close({ keepOpen: false });
  assert.equal(session.isClosed(), true);

  const commands = child.stdinText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(spawns, 1);
  assert.deepEqual(commands.slice(0, 3).map((item) => item.action), ["show", "cancel", "show"]);
  assert.equal(commands[1].keepOpen, true);
  assert.equal(commands[2].title, "Question 2 of 2");
  assert.equal(commands.at(-1).action, "shutdown");
});

test("closing the native handle terminates a still-open popup", async () => {
  const child = fakeChild();
  const handle = startMacQuestion(
    { requestId: "request-3", question: "Pick", options: ["A"] },
    { platform: "darwin", spawnImpl: () => child },
  );
  handle.close();

  assert.equal(child.killedWith, "SIGTERM");
  assert.deepEqual(await handle.promise, { status: "cancelled", reason: "resolved_elsewhere" });
});

test("modern macOS popup uses WKWebView with selectable text, edit shortcuts, rich content and image input", () => {
  assert.match(nativeHelper, /WKWebView/);
  assert.match(nativeHelper, /install_edit_menu/);
  assert.match(nativeHelper, /"Copy", "copy:"/);
  assert.match(nativeHelper, /"Paste", "paste:"/);
  assert.match(nativeHelper, /persist_attachments/);
  assert.match(nativeUi, /user-select:\s*text/);
  assert.match(nativeUi, /body\s*\{[^}]*padding:\s*0;/s);
  assert.match(nativeUi, /\.card\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s);
  assert.match(nativeUi, /addEventListener\('paste'/);
  assert.match(nativeUi, /addEventListener\('drop'/);
  assert.match(nativeUi, /native\('chooseImages'\)/);
  assert.match(nativeUi, /frame\.setAttribute\('sandbox', 'allow-same-origin'\)/);
  assert.match(nativeUi, /Or write a different instruction/);
  assert.match(nativeUi, /--ls-ui-radius-button:\s*14px/);
  assert.match(nativeUi, /border-radius:\s*var\(--ls-ui-radius-button\)/);
  assert.match(nativeHelper, /setURLSchemeHandler_forURLScheme_/);
  assert.match(nativeHelper, /Accept-Ranges/);
  assert.match(nativeUi, /img-src data: blob: local-system-media:/);
  assert.match(nativeUi, /media-src data: blob: local-system-media:/);
  assert.match(nativeUi, /\.rich\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(nativeUi, /rich-zoom-label/);
  assert.match(nativeUi, /Math\.max\(\.5, Math\.min\(2,/);
  assert.match(nativeUi, /frame\.style\.transform = `scale\(\$\{zoom\}\)`/);
  assert.match(nativeUi, /stage\.style\.width = `\$\{zoom \* 100\}%`/);
  assert.match(nativeUi, /contentResizeObserver = new ResizeObserver\(syncContentHeight\)/);
  assert.match(nativeUi, /head\.append\(richPresentation\.controls\)/);
  assert.match(nativeUi, /\.rich-viewport\s*\{[^}]*max-height:\s*min\(460px, 52vh\);[^}]*overflow-y:\s*auto;/s);
});

test("macOS questions first appear as a compact top-right non-focus-stealing notification", () => {
  assert.match(nativeHelper, /COMPACT_WIDTH\s*=\s*380/);
  assert.match(nativeHelper, /COMPACT_HEIGHT\s*=\s*92/);
  assert.match(nativeHelper, /COMPACT_MIN_HEIGHT\s*=\s*72/);
  assert.match(nativeHelper, /COMPACT_MAX_HEIGHT\s*=\s*140/);
  assert.match(nativeHelper, /def _place_top_right/);
  assert.match(nativeHelper, /self\.panel\.orderFrontRegardless\(\)/);
  assert.match(nativeHelper, /elif action == "expand":\s*\n\s*self\._expand_request\(\)/);
  assert.match(nativeHelper, /self\._evaluate\("window\.__localSystemExpand\(\)"\)/);
  assert.match(nativeHelper, /panel\.setFloatingPanel_\(True\)/);
  assert.match(nativeHelper, /panel\.setLevel_\(NSFloatingWindowLevel\)/);
  assert.match(nativeHelper, /self\.panel\.setStyleMask_\(NSWindowStyleMaskBorderless\)/);
  assert.match(nativeHelper, /self\.panel\.setHasShadow_\(True\)/);
  assert.match(nativeHelper, /content_view\.layer\(\)\.setCornerRadius_\(14\.0\)/);
  const showRequest = nativeHelper.match(/def show_request\(self, payload\):([\s\S]*?)\n\s*@objc\.python_method\n\s*def cancel_request/);
  assert.ok(showRequest);
  assert.doesNotMatch(showRequest[1], /activateIgnoringOtherApps/);
  assert.match(nativeUi, /\.compact-card\s*\{/);
  assert.match(nativeUi, /native\('expand'\)/);
  assert.match(nativeUi, /card\.addEventListener\('click', \(\) => native\('expand'\)\)/);
  assert.doesNotMatch(nativeUi, /View request/);
  assert.match(nativeUi, /Agent needs input/);
  assert.match(nativeUi, /window\.__localSystemExpand\s*=\s*\(\)\s*=>/);
  assert.match(nativeUi, /html\.compact-mode,\s*\nbody\.compact-mode\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(nativeUi, /body\.compact-mode\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0;/s);
  assert.match(nativeUi, /\.compact-message\s*\{[^}]*-webkit-line-clamp:\s*3;/s);
});

test("macOS session queues concurrent requests in one panel and exposes the pending count", () => {
  assert.match(nativeHelper, /self\.request_queue = \[\]/);
  assert.match(nativeHelper, /self\.request_queue\.append\(dict\(payload\)\)/);
  assert.match(nativeHelper, /window\.__localSystemQueue\(\{count\}\)/);
  assert.match(nativeHelper, /"pendingCount": 1 \+ len\(self\.request_queue\)/);
  assert.match(nativeHelper, /def _activate_next_request\(self, compact\):/);
  assert.match(nativeHelper, /payload = self\.request_queue\.pop\(0\)/);
  assert.match(nativeUi, /\.pending-badge\s*\{/);
  assert.match(nativeUi, /dataset\.pendingBadge = 'true'/);
  assert.match(nativeUi, /window\.__localSystemQueue\s*=\s*\(count\)\s*=>/);
  assert.match(nativeUi, /compactMode = request\?\.compact !== false/);
});

test("native presentation rewrites ordinary local Markdown and HTML media without changing remote URLs", () => {
  let token = 0;
  const media = new Map([
    ["./reference.png", { path: "/safe/reference.png", mimeType: "image/png", bytes: 101 }],
    ["/safe/video.mp4", { path: "/safe/video.mp4", mimeType: "video/mp4", bytes: 202 }],
    ["../poster.webp", { path: "/safe/poster.webp", mimeType: "image/webp", bytes: 303 }],
  ]);
  const prepared = prepareNativePresentationContent(
    [
      "![Reference](./reference.png)",
      '<img src="https://example.com/remote.png">',
      '<video controls poster="../poster.webp" src="/safe/video.mp4"></video>',
    ].join("\n"),
    {
      resolveMedia(reference) {
        const result = media.get(reference);
        if (!result) throw new Error("not local test media");
        return result;
      },
      tokenFactory: () => String(++token).padStart(24, "0"),
    },
  );

  assert.match(prepared.content, /!\[Reference\]\(local-system-media:\/\/media\/[0-9]{24}\)/);
  assert.match(prepared.content, /src="https:\/\/example\.com\/remote\.png"/);
  assert.match(prepared.content, /poster="local-system-media:\/\/media\/[0-9]{24}"/);
  assert.match(prepared.content, /src="local-system-media:\/\/media\/[0-9]{24}"/);
  assert.deepEqual(
    prepared.presentationMedia.map(({ path, mimeType, bytes }) => ({ path, mimeType, bytes })).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "/safe/reference.png", mimeType: "image/png", bytes: 101 },
      { path: "/safe/poster.webp", mimeType: "image/webp", bytes: 303 },
      { path: "/safe/video.mp4", mimeType: "video/mp4", bytes: 202 },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
  assert.equal(new Set(prepared.presentationMedia.map((item) => item.id)).size, 3);
});

test("ordinary native questions always keep a custom response field even when options are present", () => {
  assert.match(nativeHelper, /allow_custom = True if kind == "question" else bool\(payload\.get\("allowCustom", True\)\)/);
  assert.match(nativeUi, /request\.kind === 'question' \|\| request\.allowCustom !== false/);
});

test("content-only native questions hide synthetic question/options but keep response input", () => {
  assert.match(nativeUi, /!request\.presentationOnly && !request\.contentOnly/);
  assert.match(nativeUi, /request\.kind === 'approval' \|\| request\.contentOnly \? \[\]/);
  assert.match(nativeUi, /request\.presentationOnly \|\| request\.contentOnly/);
  assert.match(nativeUi, /request\.contentOnly \? 'Continue'/);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinText = "";
  child.stdin.on("data", (chunk) => { child.stdinText += String(chunk); });
  child.killedWith = null;
  child.kill = (signal) => {
    child.killedWith = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}
