import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const macosUiSource = readFileSync(new URL("../../scripts/macos-question-ui.html", import.meta.url), "utf8");
const extensionSource = readFileSync(new URL("../../extensions/local-system/interaction-content.js", import.meta.url), "utf8");

function extractRenderer(source) {
  // Extract renderPresentationContent, renderInline, escapeHtml from script text
  const match = source.match(/function renderPresentationContent\([\s\S]*?\n\s*function renderAttachments/);
  if (!match) {
    // If not found before renderAttachments, try before escapeHtml
    const match2 = source.match(/function renderPresentationContent\([\s\S]*?\n\s*function escapeHtml/);
    if (!match2) throw new Error("Could not extract renderPresentationContent");
    const code = `${match2[0].replace(/\n\s*function escapeHtml$/, "")}\nfunction escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }\nexports.render = renderPresentationContent;`;
    const context = { exports: {} };
    vm.createContext(context);
    vm.runInContext(code, context);
    return context.exports.render;
  }
  const code = `${match[0].replace(/\n\s*function renderAttachments$/, "")}\nfunction escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }\nexports.render = renderPresentationContent;`;
  const context = { exports: {} };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.exports.render;
}

const renderMacos = extractRenderer(macosUiSource);
const renderExtension = extractRenderer(extensionSource);

for (const [name, render] of [["macOS Question UI", renderMacos], ["Extension interaction-content", renderExtension]]) {
  test(`${name}: renders markdown headings, paragraphs, and inline code without raw hashes`, () => {
    const input = `### Testing Local System Input\nThis is a verification test to check that Antigravity can call \`request_user_input\` and read your response directly from the embedded JSON in \`content.text\`.`;
    const out = render(input);

    assert.doesNotMatch(out, /###/);
    assert.match(out, /<h3>Testing Local System Input<\/h3>/);
    assert.match(out, /<p>This is a verification test to check that Antigravity can call <code>request_user_input<\/code> and read your response directly from the embedded JSON in <code>content\.text<\/code>\.<\/p>/);
  });

  test(`${name}: renders markdown lists and checkboxes`, () => {
    const input = `- [x] Step 1: Initialized\n- [ ] Step 2: Pending review\n* Plain item`;
    const out = render(input);

    assert.match(out, /<ul>/);
    assert.match(out, /<li><input type="checkbox" disabled checked \/> Step 1: Initialized<\/li>/);
    assert.match(out, /<li><input type="checkbox" disabled \/> Step 2: Pending review<\/li>/);
    assert.match(out, /<li>Plain item<\/li>/);
    assert.match(out, /<\/ul>/);
  });

  test(`${name}: renders fenced code blocks with language`, () => {
    const input = "```javascript\nconst a = 1 < 2;\nconsole.log(a);\n```";
    const out = render(input);

    assert.match(out, /<pre><code class="language-javascript">const a = 1 &lt; 2;\nconsole\.log\(a\);<\/code><\/pre>/);
  });

  test(`${name}: renders GFM tables with alignment`, () => {
    const input = `| Header A | Header B |\n| :--- | ---: |\n| Cell 1 | Cell 2 |`;
    const out = render(input);

    assert.match(out, /<div class="table-wrap"><table>/);
    assert.match(out, /<th style="text-align:left">Header A<\/th>/);
    assert.match(out, /<th style="text-align:right">Header B<\/th>/);
    assert.match(out, /<td style="text-align:left">Cell 1<\/td>/);
    assert.match(out, /<td style="text-align:right">Cell 2<\/td>/);
  });

  test(`${name}: renders blockquotes and horizontal rules`, () => {
    const input = `> Note: Important info\n\n---`;
    const out = render(input);

    assert.match(out, /<blockquote>Note: Important info<\/blockquote>/);
    assert.match(out, /<hr \/>/);
  });

  test(`${name}: preserves full HTML documents as-is`, () => {
    const doc = `<!doctype html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>`;
    const out = render(doc);
    assert.equal(out, doc);
  });

  test(`${name}: preserves HTML fragment tags`, () => {
    const frag = `<section><h1>Review this</h1></section>`;
    const out = render(frag);
    assert.equal(out, frag);
  });

  test(`${name}: supports inline formatting like bold, italic, and links`, () => {
    const input = `Here is **bold**, *italic*, ~~strike~~, and [OpenAI](https://openai.com).`;
    const out = render(input);

    assert.match(out, /<strong>bold<\/strong>/);
    assert.match(out, /<em>italic<\/em>/);
    assert.match(out, /<del>strike<\/del>/);
    assert.match(out, /<a href="https:\/\/openai\.com" target="_blank" rel="noopener noreferrer">OpenAI<\/a>/);
  });
}

test("presentation iframe defines high-contrast text CSS variables for both light and dark themes", () => {
  for (const [name, source] of [["macOS Question UI", macosUiSource], ["Extension interaction-content", extensionSource]]) {
    assert.match(source, /--text:\s*#181818/, `${name} should define light text color #181818`);
    assert.match(source, /--text:\s*#f3f3f3/, `${name} should define dark text color #f3f3f3`);
    assert.match(source, /color:\s*var\(--text\)/, `${name} should apply color: var(--text)`);
    assert.match(source, /themeClass/, `${name} should inject themeClass into iframe html tag`);
  }
});

