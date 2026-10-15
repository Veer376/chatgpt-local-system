import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const manifest = JSON.parse(readFileSync(new URL("../../extensions/local-system/manifest.json", import.meta.url), "utf8"));
const script = readFileSync(new URL("../../extensions/local-system/thread-runtime-guard.js", import.meta.url), "utf8");

function loadGuard({ disabled = false } = {}) {
  const listeners = new Map();
  const replacements = [];
  const storage = new Map(disabled ? [["local-system:thread-hard-navigation", "off"]] : []);
  const location = {
    href: "https://chatgpt.com/c/current",
    pathname: "/c/current",
    search: "",
    replace(value) {
      replacements.push(String(value));
      const url = new URL(String(value));
      this.href = url.toString();
      this.pathname = url.pathname;
      this.search = url.search;
    },
  };
  const context = {
    URL,
    location,
    localStorage: { getItem: (key) => storage.get(key) ?? null },
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  context.globalThis = context;
  vm.runInNewContext(script, context, { filename: "thread-runtime-guard.js" });
  return { listener: listeners.get("click"), replacements };
}

function clickFor(href, overrides = {}) {
  const state = { prevented: false, stopped: false };
  const anchor = { tagName: "A", href, target: "", download: false };
  return {
    state,
    event: {
      button: 0,
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      composedPath: () => [anchor],
      preventDefault: () => { state.prevented = true; },
      stopPropagation: () => { state.stopped = true; },
      ...overrides,
    },
  };
}

test("hard thread navigation is disabled in the extension manifest", () => {
  const entry = manifest.content_scripts.find((item) => item.js?.includes("thread-runtime-guard.js"));
  assert.equal(entry, undefined);
});

test("normal clicks to another conversation use replacement navigation", () => {
  const harness = loadGuard();
  const click = clickFor("https://chatgpt.com/c/next?model=x");
  harness.listener(click.event);
  assert.equal(harness.replacements[0], "https://chatgpt.com/c/next?model=x");
  assert.equal(click.state.prevented, true);
  assert.equal(click.state.stopped, true);
});

test("project conversation clicks also use replacement navigation", () => {
  const harness = loadGuard();
  const projectUrl = "https://chatgpt.com/g/g-p-6a8dc9cf106c8191a5bb9a21214fe3e8/c/6aa6b2fc-02a4-83e8-971b-9dd1a7433360";
  const click = clickFor(projectUrl);
  harness.listener(click.event);
  assert.equal(harness.replacements[0], projectUrl);
  assert.equal(click.state.prevented, true);
  assert.equal(click.state.stopped, true);
});

test("same-thread, modified, external, and new-tab clicks keep normal browser behavior", () => {
  const cases = [
    clickFor("https://chatgpt.com/c/current"),
    clickFor("https://chatgpt.com/c/next", { metaKey: true }),
    clickFor("https://example.com/c/next"),
    clickFor("https://chatgpt.com/c/next", { composedPath: () => [{ tagName: "A", href: "https://chatgpt.com/c/next", target: "_blank", download: false }] }),
  ];
  for (const click of cases) {
    const harness = loadGuard();
    harness.listener(click.event);
    assert.equal(harness.replacements.length, 0);
    assert.equal(click.state.prevented, false);
  }
});

test("hard-navigation kill switch leaves ChatGPT SPA routing untouched", () => {
  const harness = loadGuard({ disabled: true });
  const click = clickFor("https://chatgpt.com/c/next");
  harness.listener(click.event);
  assert.equal(harness.replacements.length, 0);
  assert.equal(click.state.prevented, false);
});
