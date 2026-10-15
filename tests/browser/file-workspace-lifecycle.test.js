/* global document, getComputedStyle */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceHtml = path.join(repoRoot, "extensions/local-system/file-workspace.html");
const chromePath = discoverChrome();
let browser = null;

test.before(async () => {
  if (!chromePath) return;
  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--allow-file-access-from-files"],
  });
});

test.after(async () => {
  await browser?.close();
});

test("collapsed project pane hover previews and auto-hides after pointer exit", { skip: !chromePath }, async () => {
  const { page, errors } = await openWorkspace({
    workspace: collapsedWorkspace(),
  });
  try {
    await waitForHydration(page);
    await page.locator("#tree-pane").hover();
    await page.waitForTimeout(190);
    await assertWorkspaceClass(page, "tree-hover-preview", true);

    await page.locator("#editor-pane").hover();
    await page.waitForTimeout(280);
    await assertWorkspaceClass(page, "tree-hover-preview", false);
    await assertWorkspaceClass(page, "tree-collapsed", true);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("clicking Changes while hover-previewed switches mode without pinning the project pane", { skip: !chromePath }, async () => {
  const { page, errors } = await openWorkspace({
    workspace: collapsedWorkspace(),
    gitFiles: gitFiles(8),
  });
  try {
    await waitForHydration(page);
    await page.locator("#tree-pane").hover();
    await page.waitForTimeout(190);
    await assertWorkspaceClass(page, "tree-hover-preview", true);

    await page.locator("#left-mode-git").click();
    await page.waitForFunction(() => document.querySelector("#left-git-panel")?.hidden === false);
    const persisted = await page.evaluate(() => globalThis.__localSystemBehaviorMock.workspace);
    assert.equal(persisted.leftMode, "git");
    assert.equal(persisted.treeCollapsed, true);

    await page.locator("#editor-pane").hover();
    await page.waitForTimeout(280);
    await assertWorkspaceClass(page, "tree-hover-preview", false);
    await assertWorkspaceClass(page, "tree-collapsed", true);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Git Changes owns a real vertical scroll region for large change sets", { skip: !chromePath }, async () => {
  const { page, errors } = await openWorkspace({
    workspace: { ...collapsedWorkspace(), treeCollapsed: false, leftMode: "git" },
    gitFiles: gitFiles(180),
  });
  try {
    await waitForHydration(page);
    await page.waitForFunction(() => document.querySelectorAll(".git-change-row").length >= 150);
    const before = await page.locator("#git-changes-section").evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    assert.ok(before.clientHeight > 0);
    assert.ok(before.scrollHeight > before.clientHeight, `expected Git section to overflow: ${JSON.stringify(before)}`);

    await page.locator("#git-changes-section").evaluate((element) => {
      element.scrollTop = Math.floor(element.scrollHeight * 0.55);
    });
    const after = await page.locator("#git-changes-section").evaluate((element) => element.scrollTop);
    assert.ok(after > 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("unchanged Git refreshes keep Changes rows stable and one click opens the diff", { skip: !chromePath }, async () => {
  const { page, errors } = await openWorkspace({
    workspace: { ...collapsedWorkspace(), treeCollapsed: false, leftMode: "git" },
    gitFiles: gitFiles(4),
  });
  try {
    await waitForHydration(page);
    await page.waitForFunction(() => document.querySelectorAll(".git-change-row").length === 4);
    await page.evaluate(() => {
      globalThis.__stableGitChangeRow = document.querySelector(".git-change-row");
    });
    const baseline = await page.evaluate(() => globalThis.__localSystemBehaviorMock.gitStatusRequests);

    await page.evaluate(() => {
      for (let index = 0; index < 3; index += 1) {
        globalThis.__localSystemBehaviorMock.watchEvents.push({
          kind: "change",
          overflow: false,
          gitOnly: true,
          paths: ["/workspace/.git/index"],
          relativePaths: [".git/index"],
          at: Date.now() + index,
        });
      }
    });
    await page.waitForFunction(
      (minimum) => globalThis.__localSystemBehaviorMock.gitStatusRequests >= minimum,
      baseline + 3,
      { timeout: 5_000 },
    );

    assert.equal(
      await page.evaluate(() => (
        globalThis.__stableGitChangeRow === document.querySelector(".git-change-row")
      )),
      true,
    );

    await page.locator(".git-change-row").first().hover();
    await page.locator(".git-change-row").first().click();
    await page.waitForFunction(() => globalThis.__localSystemBehaviorMock.fileDiffRequests === 1);
    assert.equal(await page.locator("#diff-viewer").isHidden(), false);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("workspace stays visually collapsed during delayed hydration and restores saved open state afterward", { skip: !chromePath }, async () => {
  const { page, errors } = await openWorkspace({
    workspace: { ...collapsedWorkspace(), treeCollapsed: false },
    getDelayMs: 250,
    waitUntil: "domcontentloaded",
  });
  try {
    const initial = await page.locator("#workspace").evaluate((element) => ({
      hydrating: element.classList.contains("workspace-hydrating"),
      collapsed: element.classList.contains("tree-collapsed"),
    }));
    assert.deepEqual(initial, { hydrating: true, collapsed: true });

    await waitForHydration(page);
    const restored = await page.locator("#workspace").evaluate((element) => ({
      hydrating: element.classList.contains("workspace-hydrating"),
      collapsed: element.classList.contains("tree-collapsed"),
    }));
    assert.deepEqual(restored, { hydrating: false, collapsed: false });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("host theme messages update actual workspace theme variables immediately", { skip: !chromePath }, async () => {
  const { page, errors } = await openWorkspace({
    workspace: collapsedWorkspace(),
  });
  try {
    await waitForHydration(page);
    await page.evaluate(() => {
      globalThis.postMessage({
        source: "local-system-host",
        theme: {
          surface: "rgb(17, 18, 19)",
          text: "rgb(231, 232, 233)",
          fontSize: "15px",
        },
      }, "*");
    });
    await page.waitForFunction(() => (
      getComputedStyle(document.documentElement).getPropertyValue("--ls-ui-surface").trim() === "rgb(17, 18, 19)"
    ));
    const theme = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        surface: styles.getPropertyValue("--ls-ui-surface").trim(),
        text: styles.getPropertyValue("--ls-ui-text").trim(),
        fontSize: styles.getPropertyValue("--workspace-ui-font-size").trim(),
      };
    });
    assert.deepEqual(theme, {
      surface: "rgb(17, 18, 19)",
      text: "rgb(231, 232, 233)",
      fontSize: "15px",
    });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("live filesystem events refresh Git and structural tree state without manual refresh", { skip: !chromePath }, async () => {
  const { page, errors } = await openWorkspace({
    workspace: { ...collapsedWorkspace(), treeCollapsed: false },
    gitFiles: gitFiles(2),
    watchEvents: [{
      kind: "rename",
      overflow: false,
      gitOnly: false,
      paths: ["/workspace/new-file.js"],
      relativePaths: ["new-file.js"],
      at: Date.now(),
    }],
  });
  try {
    await waitForHydration(page);
    await page.waitForFunction(() => (
      globalThis.__localSystemBehaviorMock.gitStatusRequests >= 2
      && globalThis.__localSystemBehaviorMock.listDirectoryRequests >= 2
    ));
    const state = await page.evaluate(() => ({
      gitStatusRequests: globalThis.__localSystemBehaviorMock.gitStatusRequests,
      listDirectoryRequests: globalThis.__localSystemBehaviorMock.listDirectoryRequests,
      watchRequests: globalThis.__localSystemBehaviorMock.watchRequests,
    }));
    assert.ok(state.watchRequests >= 1);
    assert.ok(state.gitStatusRequests >= 2);
    assert.ok(state.listDirectoryRequests >= 2);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Auto save persists from Settings and saves after idle without leaving the editor", { skip: !chromePath }, async () => {
  const activePath = "/workspace/README.md";
  const { page, errors } = await openWorkspace({
    workspace: {
      ...collapsedWorkspace(),
      treeCollapsed: false,
      activePath,
      openPaths: [activePath],
      previewViewByPath: { [activePath]: "raw" },
    },
    files: {
      [activePath]: "initial\n",
    },
  });
  try {
    await waitForHydration(page);
    await page.waitForFunction(() => document.querySelector("#file-editor")?.value === "initial\n");

    await page.locator("#ui-settings-toggle").click();
    await page.locator("label.workspace-setting", { hasText: "Auto save" }).click();
    await page.waitForFunction(() => (
      globalThis.__localSystemBehaviorMock.storage.localSystemEditorPreferencesV1?.autoSave === true
    ));

    await page.locator("#file-editor").fill("changed by auto save\n");
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => globalThis.__localSystemBehaviorMock.writeRequests),
      0,
    );
    assert.equal(await page.locator("#save-file-edit").isHidden(), true);
    assert.equal(await page.locator("#cancel-file-edit").isHidden(), true);
    assert.equal(await page.locator("#file-edit-status").isHidden(), true);
    await page.waitForFunction(() => globalThis.__localSystemBehaviorMock.writeRequests === 1);
    await page.waitForFunction(() => (
      globalThis.__localSystemBehaviorMock.files["/workspace/README.md"].content === "changed by auto save\n"
    ));

    assert.equal(await page.locator("#file-editor").inputValue(), "changed by auto save\n");
    assert.equal(await page.locator("#edit-viewer").isHidden(), false);
    assert.equal(await page.locator("#save-file-edit").isHidden(), true);
    assert.equal(await page.locator("#cancel-file-edit").isHidden(), true);
    assert.equal(await page.locator("#file-edit-status").isHidden(), true);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Auto save is single-flight and preserves edits typed during an in-flight save", { skip: !chromePath }, async () => {
  const activePath = "/workspace/README.md";
  const { page, errors } = await openWorkspace({
    workspace: {
      ...collapsedWorkspace(),
      treeCollapsed: false,
      activePath,
      openPaths: [activePath],
      previewViewByPath: { [activePath]: "raw" },
    },
    files: {
      [activePath]: "initial\n",
    },
    storage: {
      localSystemEditorPreferencesV1: { autoSave: true },
    },
    writeDelayMs: 500,
    emitWatchOnWrite: true,
  });
  try {
    await waitForHydration(page);
    await page.waitForFunction(() => document.querySelector("#file-editor")?.value === "initial\n");

    await page.locator("#file-editor").fill("first revision\n");
    await page.waitForFunction(() => globalThis.__localSystemBehaviorMock.writeRequests === 1);
    await page.locator("#file-editor").fill("second revision\n");

    await page.waitForFunction(() => (
      globalThis.__localSystemBehaviorMock.writeRequests >= 2
      && globalThis.__localSystemBehaviorMock.files["/workspace/README.md"].content === "second revision\n"
    ), null, { timeout: 5_000 });
    const result = await page.evaluate(() => ({
      writes: globalThis.__localSystemBehaviorMock.writeRequests,
      maxConcurrentWrites: globalThis.__localSystemBehaviorMock.maxConcurrentWrites,
      content: globalThis.__localSystemBehaviorMock.files["/workspace/README.md"].content,
    }));
    assert.equal(result.content, "second revision\n");
    assert.equal(result.maxConcurrentWrites, 1);
    assert.equal(await page.locator("#file-editor").inputValue(), "second revision\n");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Markdown files keep Preview enabled by default after the generic preview rename", { skip: !chromePath }, async () => {
  const activePath = "/workspace/README.md";
  const { page, errors } = await openWorkspace({
    workspace: {
      ...collapsedWorkspace(),
      treeCollapsed: false,
      activePath,
      openPaths: [activePath],
    },
    files: { [activePath]: "# Preview heading\n\nMarkdown body\n" },
  });
  try {
    await waitForHydration(page);
    await page.locator("#markdown-rendered h1").waitFor();
    assert.equal(await page.locator("#preview-file").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#markdown-rendered h1").textContent(), "Preview heading");
    assert.equal(await page.locator("#edit-viewer").isVisible(), false);

    await page.locator("#preview-file").click();
    assert.equal(await page.locator("#preview-file").getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#markdown-rendered").isVisible(), false);
    assert.equal(await page.locator("#edit-viewer").isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("HTML files open in sandboxed Preview by default and toggle back to editable source", { skip: !chromePath }, async () => {
  const activePath = "/workspace/index.html";
  const initialHtml = '<!doctype html><p>Initial preview</p><script>window.__previewRan = "initial"</script>';
  const { page, errors } = await openWorkspace({
    workspace: {
      ...collapsedWorkspace(),
      treeCollapsed: false,
      activePath,
      openPaths: [activePath],
    },
    files: {
      [activePath]: { content: initialHtml, mimeType: "text/html" },
    },
  });
  try {
    await waitForHydration(page);
    await page.waitForFunction(() => document.querySelector("#html-rendered")?.getAttribute("src"));
    assert.match(
      await page.locator("#html-rendered").getAttribute("src"),
      /^http:\/\/local-system-preview\.test\/index\.html\?content=/,
    );
    assert.equal(await page.locator("#html-rendered").getAttribute("srcdoc"), null);
    const preview = page.frameLocator("#html-rendered");
    await preview.locator("p").waitFor({ timeout: 15_000 });
    assert.ok(page.frames().some((frame) => frame.url().startsWith("http://local-system-preview.test/")),
      `expected HTML preview frame; frames=${page.frames().map((frame) => frame.url()).join(", ")}`);

    assert.equal(await page.locator("#preview-file").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#html-rendered").isVisible(), true);
    assert.equal(await page.locator("#edit-viewer").isVisible(), false);
    assert.equal(await preview.locator("p").textContent(), "Initial preview");
    assert.equal(await preview.locator("body").evaluate(() => globalThis.__previewRan), "initial");

    await page.locator("#preview-file").click();
    assert.equal(await page.locator("#preview-file").getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#html-rendered").isVisible(), false);
    assert.equal(await page.locator("#edit-viewer").isVisible(), true);

    const updatedHtml = '<!doctype html><p>Updated preview</p><script>window.__previewRan = "updated"</script>';
    await page.locator("#file-editor").fill(updatedHtml);
    await page.locator("#preview-file").click();
    await preview.locator("p").filter({ hasText: "Updated preview" }).waitFor();
    assert.equal(await page.locator("#preview-file").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#html-rendered").isVisible(), true);
    assert.equal(await preview.locator("body").evaluate(() => globalThis.__previewRan), "updated");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Cmd+F opens current-file find without a toolbar search button", { skip: !chromePath }, async () => {
  const activePath = "/workspace/notes.txt";
  const { page, errors } = await openWorkspace({
    workspace: {
      ...collapsedWorkspace(),
      treeCollapsed: false,
      activePath,
      openPaths: [activePath],
    },
    files: { [activePath]: "alpha beta alpha\n" },
  });
  try {
    await waitForHydration(page);
    assert.equal(await page.locator("#find-in-file").count(), 0);
    await page.locator("#file-editor").focus();
    await page.keyboard.press("Meta+f");
    assert.equal(await page.locator("#file-find-bar").isVisible(), true);
    assert.equal(await page.locator("#file-find-input").evaluate((node) => document.activeElement === node), true);
    await page.locator("#file-find-input").fill("alpha");
    assert.equal(await page.locator("#file-find-count").textContent(), "1/2");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("paused video offers a 250ms-corrected annotation flow with collapsed timestamp notes", { skip: !chromePath }, async () => {
  const activePath = "/workspace/demo.mp4";
  const { page, errors } = await openWorkspace({
    workspace: {
      ...collapsedWorkspace(),
      treeCollapsed: false,
      activePath,
      openPaths: [activePath],
    },
    files: {
      [activePath]: {
        content: "not-a-real-video",
        mimeType: "video/mp4",
      },
    },
  });
  try {
    await waitForHydration(page);
    await page.waitForFunction(() => document.querySelector("#media-viewer video"));

    await page.evaluate(() => {
      const video = document.querySelector("#media-viewer video");
      video.currentTime = 10;
      video.dispatchEvent(new Event("pause"));
    });

    const annotate = page.locator(".media-annotate-button");
    await annotate.waitFor({ state: "visible" });
    assert.equal(await annotate.textContent(), "Annotate · 00:09.8");
    assert.equal(await annotate.evaluate((node) => node.classList.contains("annotate-selection")), true);
    assert.equal(await page.locator(".media-video-shell").evaluate((node) => getComputedStyle(node).alignSelf), "center");

    await annotate.click();
    const input = page.locator('.media-note-composer textarea[aria-label="Video annotation note"]');
    assert.equal(await page.locator(".media-note-composer").evaluate((node) => node.classList.contains("annotation-editor")), true);
    await page.waitForFunction(() => document.activeElement === document.querySelector('.media-note-composer textarea[aria-label="Video annotation note"]'));
    await input.fill("Cut before the reaction");
    await input.press("Enter");

    await page.waitForFunction(() => globalThis.__localSystemBehaviorMock.workspace.mediaNotes?.length === 1);
    assert.equal(await page.evaluate(() => globalThis.__localSystemBehaviorMock.workspace.mediaNotes[0].time), 9.75);
    assert.equal(await page.locator(".media-notes summary").textContent(), "Notes · 1");
    assert.equal(await page.locator(".media-notes").getAttribute("open"), null);
    assert.equal(await page.locator(".media-video-shell").evaluate((node) => node.classList.contains("has-media-notes")), true);
    assert.equal(await page.locator(".media-video-shell").evaluate((node) => getComputedStyle(node).alignSelf), "start");

    await page.locator(".media-notes summary").click();
    assert.equal(await page.locator(".media-note-seek").textContent(), "00:09.8");
    assert.equal(await page.locator(".media-note-comment").textContent(), "Cut before the reaction");
    await page.locator("#copy-annotations").click();
    assert.match(
      await page.evaluate(() => globalThis.__localSystemBehaviorMock.clipboardText),
      /^\[Annotations\][\s\S]*Timestamp: 00:09\.8[\s\S]*Comment: Cut before the reaction[\s\S]*\[\/Annotations\]$/,
    );
    assert.equal(await page.locator("#copy-annotations svg path").getAttribute("d"), "m5 12 4 4L19 6");
    await page.locator("#copy-path").click();
    assert.equal(await page.evaluate(() => globalThis.__localSystemBehaviorMock.clipboardText), activePath);
    assert.equal(await page.locator("#copy-path svg path").getAttribute("d"), "m5 12 4 4L19 6");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("workspace focus handoff keeps media shortcuts local with accelerated video seeking", { skip: !chromePath }, async () => {
  const activePath = "/workspace/demo.mp4";
  const { page, errors } = await openWorkspace({
    workspace: {
      ...collapsedWorkspace(),
      treeCollapsed: false,
      activePath,
      openPaths: [activePath],
    },
    files: {
      [activePath]: {
        content: "not-a-real-video",
        mimeType: "video/mp4",
      },
    },
  });
  try {
    await waitForHydration(page);
    await page.waitForFunction(() => document.querySelector("#media-viewer video"));

    await page.evaluate(() => {
      globalThis.__workspaceFocusMessages = [];
      globalThis.addEventListener("message", (event) => {
        if (event.data?.source === "local-system-file-workspace") {
          globalThis.__workspaceFocusMessages.push(event.data);
        }
      });
      const video = document.querySelector("#media-viewer video");
      globalThis.__mediaPlayCalls = 0;
      globalThis.__mediaPauseCalls = 0;
      video.play = () => {
        globalThis.__mediaPlayCalls += 1;
        return Promise.resolve();
      };
      video.pause = () => {
        globalThis.__mediaPauseCalls += 1;
      };
      globalThis.postMessage({ source: "local-system-host", action: "restore-focus" }, "*");
    });

    await page.waitForFunction(() => document.activeElement?.tagName === "VIDEO");
    await page.keyboard.press("Meta+b");
    await page.waitForFunction(() => (
      globalThis.__workspaceFocusMessages.some((message) => message.action === "toggle-left-sidebar")
    ));

    await page.keyboard.press("Space");
    assert.equal(await page.evaluate(() => globalThis.__mediaPlayCalls), 1);
    assert.equal(await page.evaluate(() => globalThis.__mediaPauseCalls), 0);

    await page.evaluate(() => {
      const video = document.querySelector("#media-viewer video");
      video.currentTime = 10;
      video.focus();
    });
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#media-viewer video").evaluate((video) => video.currentTime), 10.35);
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#media-viewer video").evaluate((video) => video.currentTime), 10.7);
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#media-viewer video").evaluate((video) => video.currentTime), 11.05);
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator("#media-viewer video").evaluate((video) => video.currentTime), 10.7);

    await page.evaluate(() => {
      const video = document.querySelector("#media-viewer video");
      video.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: "ArrowRight", repeat: false, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.locator("#media-viewer video").evaluate((video) => video.currentTime), 11.05);
    await page.waitForTimeout(1050);
    await page.evaluate(() => {
      const video = document.querySelector("#media-viewer video");
      video.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: "ArrowRight", repeat: true, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.locator("#media-viewer video").evaluate((video) => video.currentTime), 12.05);
    await page.waitForTimeout(1050);
    await page.evaluate(() => {
      const video = document.querySelector("#media-viewer video");
      video.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: "ArrowRight", repeat: true, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.locator("#media-viewer video").evaluate((video) => video.currentTime), 14.05);

    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "media-space-input";
      document.body.appendChild(input);
      input.focus();
    });
    await page.keyboard.press("Space");
    assert.equal(await page.locator("#media-space-input").inputValue(), " ");
    assert.equal(await page.evaluate(() => globalThis.__mediaPlayCalls), 1);
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#media-viewer video").evaluate((video) => video.currentTime), 14.05);

    await page.locator("#media-viewer video").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#media-viewer video").evaluate((video) => video.currentTime), 14.4);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

async function openWorkspace({
  workspace,
  gitFiles = [],
  getDelayMs = 0,
  watchEvents = [],
  files = {},
  storage = {},
  writeDelayMs = 0,
  emitWatchOnWrite = false,
  waitUntil = "domcontentloaded",
} = {}) {
  assert.ok(browser, "Chrome browser did not start");
  const context = await browser.newContext({ viewport: { width: 1120, height: 760 } });
  await context.route("http://local-system-preview.test/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: url.searchParams.get("content") || "",
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.addInitScript(({
    initialWorkspace,
    initialGitFiles,
    initialGetDelayMs,
    initialWatchEvents,
    initialFiles,
    initialStorage,
    initialWriteDelayMs,
    initialEmitWatchOnWrite,
  }) => {
    const fileEntries = Object.fromEntries(
      Object.entries(initialFiles).map(([path, input], index) => {
        const descriptor = input && typeof input === "object"
          ? input
          : { content: input };
        const content = String(descriptor.content ?? "");
        return [
          path,
          {
            content,
            bytes: new TextEncoder().encode(content).byteLength,
            lastModified: 1_000 + index,
            mimeType: descriptor.mimeType || (path.endsWith(".md") ? "text/markdown" : "text/plain"),
          },
        ];
      }),
    );
    const state = {
      currentWorkspace: "/workspace",
      workspace: structuredClone(initialWorkspace),
      gitFiles: structuredClone(initialGitFiles),
      getDelayMs: initialGetDelayMs,
      watchEvents: structuredClone(initialWatchEvents),
      watchVersion: 0,
      watchRequests: 0,
      gitStatusRequests: 0,
      fileDiffRequests: 0,
      listDirectoryRequests: 0,
      files: fileEntries,
      resolveRequests: 0,
      writeRequests: 0,
      activeWrites: 0,
      maxConcurrentWrites: 0,
      writeDelayMs: initialWriteDelayMs,
      emitWatchOnWrite: initialEmitWatchOnWrite,
      storage: structuredClone(initialStorage),
      clipboardText: "",
    };
    globalThis.__localSystemBehaviorMock = state;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          state.clipboardText = String(value);
        },
      },
    });

    const respond = async (message) => {
      if (message?.source === "local-system-extension-api" && message.action === "cancel") {
        return { ok: true };
      }
      if (message?.source === "local-system-extension-api" && message.action === "request") {
        try {
          const payload = await localApi(message.path, message.body || {});
          return { ok: true, payload };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (message?.source === "local-system-workspace") {
        return { ok: true, payload: {} };
      }
      return { ok: true, payload: {} };
    };

    const localApi = async (requestPath, body) => {
      if (requestPath === "/local-ui/file-workspace") {
        if (body.action === "get") {
          if (state.getDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.getDelayMs));
          return {
            currentWorkspace: state.currentWorkspace,
            workspace: structuredClone(state.workspace),
          };
        }
        if (body.action === "update") {
          state.workspace = { ...state.workspace, ...(body.workspace || {}) };
          return {
            currentWorkspace: state.currentWorkspace,
            workspace: structuredClone(state.workspace),
          };
        }
        if (body.action === "upsert_media_note") {
          const note = structuredClone(body.note || {});
          state.workspace.mediaNotes ||= [];
          const index = note.id ? state.workspace.mediaNotes.findIndex((item) => item.id === note.id) : -1;
          if (index >= 0) state.workspace.mediaNotes[index] = { ...state.workspace.mediaNotes[index], ...note };
          else state.workspace.mediaNotes.push({ ...note, id: `media-note-${state.workspace.mediaNotes.length + 1}` });
          return {
            currentWorkspace: state.currentWorkspace,
            workspace: structuredClone(state.workspace),
          };
        }
        if (body.action === "delete_media_note") {
          state.workspace.mediaNotes = (state.workspace.mediaNotes || []).filter((item) => item.id !== body.id);
          return {
            currentWorkspace: state.currentWorkspace,
            workspace: structuredClone(state.workspace),
          };
        }
        if (body.action === "list_directory") {
          state.listDirectoryRequests += 1;
          return {
            currentWorkspace: state.currentWorkspace,
            entries: [
              { type: "file", path: "/workspace/README.md", name: "README.md" },
              { type: "file", path: "/workspace/src/index.js", name: "index.js" },
              { type: "directory", path: "/workspace/src", name: "src" },
            ],
            truncated: false,
          };
        }
        if (body.action === "context") {
          return { currentWorkspace: state.currentWorkspace };
        }
        if (body.action === "watch") {
          state.watchRequests += 1;
          if (state.watchEvents.length) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            state.watchVersion += 1;
            return {
              currentWorkspace: state.currentWorkspace,
              watch: {
                workspace: state.currentWorkspace,
                version: state.watchVersion,
                changed: true,
                timedOut: false,
                event: { version: state.watchVersion, ...state.watchEvents.shift() },
              },
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          return {
            currentWorkspace: state.currentWorkspace,
            watch: {
              workspace: state.currentWorkspace,
              version: state.watchVersion,
              changed: false,
              timedOut: true,
              event: null,
            },
          };
        }
        return {
          currentWorkspace: state.currentWorkspace,
          workspace: structuredClone(state.workspace),
        };
      }
      if (requestPath === "/local-ui/git") {
        if (body.action === "status") {
          state.gitStatusRequests += 1;
          return {
            repository: true,
            branch: "main",
            files: structuredClone(state.gitFiles),
          };
        }
        if (body.action === "file_diff") {
          state.fileDiffRequests += 1;
          return {
            repository: true,
            changed: true,
            path: body.path,
            relativePath: String(body.path || "").replace(/^\/workspace\//, ""),
            diff: [
              "diff --git a/file.js b/file.js",
              "--- a/file.js",
              "+++ b/file.js",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
            truncated: false,
            binary: false,
          };
        }
        return { repository: true, branch: "main", files: [] };
      }
      if (requestPath === "/local-ui/files/resolve") {
        const file = state.files[body.path];
        if (!file) throw new Error("file not found");
        state.resolveRequests += 1;
        return {
          path: body.path,
          name: body.path.split("/").pop(),
          mimeType: file.mimeType,
          bytes: file.bytes,
          lastModified: file.lastModified,
          url: `data:${file.mimeType};charset=utf-8,${encodeURIComponent(file.content)}`,
        };
      }
      if (requestPath === "/local-ui/files/html-preview") {
        const file = state.files[body.path];
        if (!file) throw new Error("file not found");
        return {
          url: `http://local-system-preview.test/index.html?content=${encodeURIComponent(String(body.content || ""))}`,
          expiresAt: Date.now() + 60_000,
        };
      }
      if (requestPath === "/local-ui/files/write") {
        const file = state.files[body.path];
        if (!file) throw new Error("file not found");
        if (
          Number(body.expectedLastModified) !== file.lastModified
          || Number(body.expectedBytes) !== file.bytes
        ) throw new Error("file changed on disk; reload it before saving");
        state.writeRequests += 1;
        state.activeWrites += 1;
        state.maxConcurrentWrites = Math.max(state.maxConcurrentWrites, state.activeWrites);
        try {
          if (state.writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.writeDelayMs));
          file.content = String(body.content);
          file.bytes = new TextEncoder().encode(file.content).byteLength;
          file.lastModified += 1;
          if (state.emitWatchOnWrite) {
            state.watchEvents.push({
              kind: "change",
              overflow: false,
              gitOnly: false,
              paths: [body.path],
              relativePaths: [body.path.replace(/^\/workspace\//, "")],
              at: Date.now(),
            });
          }
          return {
            ok: true,
            path: body.path,
            mimeType: file.mimeType,
            bytes: file.bytes,
            lastModified: file.lastModified,
          };
        } finally {
          state.activeWrites -= 1;
        }
      }
      if (requestPath === "/local-ui/workspace-trace") return { ok: true };
      if (requestPath === "/local-ui/files/search") return { files: [] };
      if (requestPath === "/local-ui/files/content-search") return { matches: [] };
      throw new Error(`Unhandled behavioral-test Local System path: ${requestPath}`);
    };

    globalThis.chrome = {
      runtime: {
        id: "behavioral-test-extension",
        lastError: null,
        sendMessage(message, callback) {
          const result = Promise.resolve().then(() => respond(message));
          if (typeof callback === "function") {
            result.then((value) => callback(value));
            return undefined;
          }
          return result;
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") return { [key]: state.storage[key] };
            return { ...state.storage };
          },
          async set(values) {
            Object.assign(state.storage, values || {});
          },
        },
        onChanged: { addListener() {} },
      },
    };
  }, {
    initialWorkspace: workspace || collapsedWorkspace(),
    initialGitFiles: gitFiles,
    initialGetDelayMs: getDelayMs,
    initialWatchEvents: watchEvents,
    initialFiles: files,
    initialStorage: storage,
    initialWriteDelayMs: writeDelayMs,
    initialEmitWatchOnWrite: emitWatchOnWrite,
  });

  const url = new URL(pathToFileURL(workspaceHtml));
  url.searchParams.set("threadId", "behavioral-thread");
  url.searchParams.set("presentation", "standalone");
  url.searchParams.set("host", "page");
  await page.goto(url.href, { waitUntil });
  return { context, page, errors };
}

async function waitForHydration(page) {
  await page.waitForFunction(() => !document.querySelector("#workspace")?.classList.contains("workspace-hydrating"));
}

async function assertWorkspaceClass(page, className, expected) {
  const actual = await page.locator("#workspace").evaluate((element, name) => element.classList.contains(name), className);
  assert.equal(actual, expected, `workspace class ${className} should be ${expected}`);
}

function collapsedWorkspace() {
  return {
    openPaths: [],
    activePath: "",
    sidebarOpen: true,
    width: 476,
    activeScrollTop: 0,
    leftMode: "files",
    previewViewByPath: {},
    treeCollapsed: true,
    treeHeight: 260,
    annotations: [],
    mediaNotes: [],
  };
}

function gitFiles(count) {
  return Array.from({ length: count }, (_, index) => ({
    absolutePath: `/workspace/src/feature-${String(index + 1).padStart(3, "0")}.js`,
    path: `src/feature-${String(index + 1).padStart(3, "0")}.js`,
    kind: "modified",
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
    additions: (index % 7) + 1,
    deletions: index % 3,
  }));
}

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
