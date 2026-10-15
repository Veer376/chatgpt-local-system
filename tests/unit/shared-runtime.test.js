import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const threadRouteSource = readFileSync(
  new URL("../../extensions/local-system/thread-route.js", import.meta.url),
  "utf8",
);
const sharedRuntimeSource = readFileSync(
  new URL("../../extensions/local-system/shared-runtime.js", import.meta.url),
  "utf8",
);

function loadRuntime({ href = "https://chatgpt.com/c/thread-123" } = {}) {
  const variables = new Map();
  const style = {
    setProperty(name, value) { variables.set(name, value); },
    removeProperty(name) { variables.delete(name); },
  };
  const sandbox = {
    URL,
    location: { href },
    document: { documentElement: { style } },
    chrome: { storage: { local: null } },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(threadRouteSource, sandbox, { filename: "thread-route.js" });
  vm.runInNewContext(sharedRuntimeSource, sandbox, { filename: "shared-runtime.js" });
  return { runtime: sandbox.LocalSystemSharedRuntime, variables };
}

test("shared runtime resolves provider thread identity through the canonical route parser", () => {
  const { runtime } = loadRuntime();
  assert.equal(runtime.currentThreadId(), "thread-123");
  assert.equal(runtime.currentThreadId("https://claude.ai/chat/claude-456"), "claude-456");
  assert.equal(runtime.currentThreadId("https://chatgpt.com/"), "");
});

test("shared runtime resolves the current ChatGPT composer and header controls with legacy fallbacks", () => {
  const { runtime } = loadRuntime();
  const composer = {
    id: "composer",
  };
  const editor = {
    id: "editor",
    closest(selector) {
      return selector === "form" ? composer : null;
    },
  };
  const share = { id: "share" };
  const root = {
    querySelector(selector) {
      if (selector === 'form[data-chatgpt-composer]') return composer;
      if (selector === '[data-composer-markdown][contenteditable="true"][role="textbox"]') return editor;
      if (selector === 'button[aria-label="Share"]') return share;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  assert.equal(runtime.findComposer(root), composer);
  assert.equal(runtime.findComposerEditor(root), editor);
  assert.equal(runtime.findShareButton(root), share);
  assert.equal(runtime.findHeaderActionButton(root), share);

  const fallbackButton = {
    id: "temporary-chat",
    closest() {
      return null;
    },
  };
  const fallbackRoot = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("data-app-shell-main-titlebar")) {
        return [{ querySelectorAll: () => [fallbackButton] }];
      }
      return [];
    },
  };
  assert.equal(runtime.findHeaderActionButton(fallbackRoot), fallbackButton);

  assert.match(runtime.COMPOSER_SELECTOR, /data-chatgpt-composer/);
  assert.match(runtime.COMPOSER_EDITOR_SELECTOR, /data-composer-markdown/);
  assert.match(runtime.COMPOSER_SELECTOR, /unified-composer/);
  assert.match(runtime.COMPOSER_EDITOR_SELECTOR, /#prompt-textarea/);
});

test("shared runtime normalizes and persists UI visibility with caller-specific defaults", async () => {
  const { runtime } = loadRuntime();
  const writes = [];
  const storage = {
    async get(key) {
      assert.equal(key, runtime.UI_VISIBILITY_STORAGE_KEY);
      return {
        [key]: {
          skills: false,
          activeFile: false,
          ignored: true,
        },
      };
    },
    async set(value) {
      writes.push(value);
    },
  };
  const defaults = Object.freeze({
    activeFile: true,
    skills: true,
    todos: true,
  });

  const loaded = await runtime.loadUiVisibility(storage, defaults);
  assert.deepEqual({ ...loaded }, {
    activeFile: false,
    skills: false,
    todos: true,
  });

  const saved = await runtime.saveUiVisibility(
    { activeFile: true, skills: false, todos: false, ignored: true },
    storage,
    defaults,
  );
  assert.deepEqual({ ...saved }, {
    activeFile: true,
    skills: false,
    todos: false,
  });
  assert.equal(writes.length, 1);
  assert.deepEqual({ ...writes[0][runtime.UI_VISIBILITY_STORAGE_KEY] }, {
    activeFile: true,
    skills: false,
    todos: false,
  });
});

test("shared runtime applies semantic theme tokens and optional aliases consistently", () => {
  const { runtime, variables } = loadRuntime();
  runtime.applyTheme({
    surface: "rgb(1, 2, 3)",
    text: "rgb(240, 241, 242)",
    fontFamily: "Inter",
    fontSize: "14px",
    fontWeight: "500",
    lineHeight: "20px",
    mainFontSize: "16px",
  }, {
    aliases: true,
    composerTypography: true,
    mainFontSizeVariable: "--test-main-font-size",
  });

  assert.equal(variables.get("--ls-ui-surface"), "rgb(1, 2, 3)");
  assert.equal(variables.get("--surface"), "rgb(1, 2, 3)");
  assert.equal(variables.get("--ls-ui-text"), "rgb(240, 241, 242)");
  assert.equal(variables.get("--text"), "rgb(240, 241, 242)");
  assert.equal(variables.get("--ls-composer-font-family"), "Inter");
  assert.equal(variables.get("--ls-composer-font-size"), "14px");
  assert.equal(variables.get("--test-main-font-size"), "16px");

  runtime.clearTheme();
  assert.equal(variables.has("--ls-ui-surface"), false);
  assert.equal(variables.has("--ls-ui-text"), false);
});
