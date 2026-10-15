import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const annotationsContent = readFileSync(
  new URL("../../extensions/local-system/annotations-content.js", import.meta.url),
  "utf8",
);

test("native ChatGPT selection actions stay visible and receive a left-side Annotate action", () => {
  assert.doesNotMatch(
    annotationsContent,
    /function hideNativeSelectionActions\b/,
    "the native selection toolbar should no longer be hidden",
  );
  assert.doesNotMatch(
    annotationsContent,
    /candidate\.style\.setProperty\("display",\s*"none",\s*"important"\)/,
    "the native selection toolbar should not be forced to display:none",
  );
  assert.match(
    annotationsContent,
    /function enhanceNativeSelectionActions\b/,
    "the native selection toolbar should be enhanced rather than replaced",
  );
  assert.match(
    annotationsContent,
    /data-local-system-native-annotate/,
    "the injected native-toolbar Annotate action should have a stable marker",
  );
  assert.match(
    annotationsContent,
    /candidate\.insertBefore\(annotateButton, askButton\)/,
    "Annotate should be inserted immediately to the left of Ask ChatGPT",
  );
  assert.match(
    annotationsContent,
    /captureCurrentSelection\(\);[\s\S]*?openEditorPopover\(\{ source: draft\.source, range: draft\.range \}\)/,
    "the native-toolbar Annotate action should reuse the existing annotation editor flow",
  );
});

test("the existing floating Annotate button remains available", () => {
  assert.match(
    annotationsContent,
    /button\.className = "ls-annotation-add btn btn-secondary"/,
    "the current floating Annotate button must remain intact",
  );
  assert.match(
    annotationsContent,
    /function showSelectionButton\b/,
    "the current selection button flow must remain intact",
  );
});

test("annotation selection survives tool-block breaks and follows the active selection edge", () => {
  assert.match(annotationsContent, /function selectionSegmentsForRange\b/);
  assert.match(annotationsContent, /if \(role === "tool"\) continue/);
  assert.match(annotationsContent, /segments\.map\(\(segment\) => segment\.source\.quote\)\.join\("\\n"\)/);
  assert.match(annotationsContent, /segments:\s*segments\.map\(\(segment\) => segment\.source\)/);
  assert.doesNotMatch(annotationsContent, /message !== findMessageContainer\(endElement\)/);
  assert.match(annotationsContent, /function selectionFocusRect\b/);
  assert.match(annotationsContent, /function selectionIsBackward\b/);
  assert.match(annotationsContent, /showSelectionButton\(range, selection\)/);
});

test("multi-root annotations retain stable roots and render every selected segment", () => {
  assert.match(annotationsContent, /textRootIndex/);
  assert.match(annotationsContent, /function messageTextRoots\b/);
  assert.match(annotationsContent, /function findMessageTextRootForSource\b/);
  assert.match(annotationsContent, /function rangesForAnnotation\b/);
  assert.match(annotationsContent, /ranges\.push\(\.\.\.annotationRanges\)/);
});

test("saving an annotation immediately returns focus to the ChatGPT composer", () => {
  assert.match(annotationsContent, /function focusComposerAfterAnnotation\b/);
  assert.match(annotationsContent, /renderAll\(\);\s*focusComposerAfterAnnotation\(\);/);
  assert.match(annotationsContent, /LocalSystemSharedRuntime\?\.findComposerEditor\?\.\(\)/);
  assert.match(annotationsContent, /editor\.focus\(\{ preventScroll: true \}\)/);
  assert.match(annotationsContent, /range\.collapse\(false\)/);
});

test("file annotation rows open the mapped file and preserve source location metadata", () => {
  assert.match(annotationsContent, /new CustomEvent\("local-system-open-file"/);
  assert.match(annotationsContent, /path:\s*annotation\.path/);
  assert.match(annotationsContent, /line:\s*Number\(annotation\.start\?\.line\) \|\| null/);
  assert.match(annotationsContent, /column:\s*Number\(annotation\.start\?\.column\) \|\| null/);
  assert.match(annotationsContent, /Math\.max\(0, endOffset - startOffset\)/);
});

test("ChatGPT composer always exposes provider-owned annotation sync", () => {
  assert.match(annotationsContent, /composerSyncButton:\s*null/);
  assert.match(annotationsContent, /function renderComposerSyncButton\b/);
  assert.match(annotationsContent, /ComposerIconButton/);
  assert.match(annotationsContent, /className:\s*"ls-annotation-sync-button"/);
  assert.match(annotationsContent, /label:\s*"Sync annotations"/);
  assert.match(annotationsContent, /function syncComposerAnnotations\b/);
  assert.match(annotationsContent, /Promise\.all\(\[[\s\S]*loadAnnotations\(\{ active: true \}\)[\s\S]*loadFileAnnotations\(\{ active: true \}\)/);
  assert.match(annotationsContent, /renderComposerSyncButton\(\);[\s\S]*renderComposerChip\(\)/);
  assert.match(annotationsContent, /\.ls-annotation-sync-button\s*\{/);
  assert.match(annotationsContent, /button\.style\.order = "1000"/);
  assert.match(annotationsContent, /\.ls-annotation-sync-button\s*\{[\s\S]*?margin:\s*0 0 0 auto/);
  assert.match(annotationsContent, /rail\.lastElementChild !== button\)\) rail\.appendChild\(button\)/);
  assert.doesNotMatch(annotationsContent, /if \(!editor \|\| !total\)[\s\S]{0,260}composerSyncButton/);
  assert.doesNotMatch(annotationsContent, /\.ls-annotation-sync-button\s*\{[^}]*background:/);
  assert.doesNotMatch(annotationsContent, /\.ls-annotation-sync-button:hover/);
});

test("annotation markers use a centered chat-bubble geometry", () => {
  assert.match(annotationsContent, /\.ls-annotation-marker\s*\{[\s\S]*?display:\s*grid[\s\S]*?place-items:\s*center[\s\S]*?width:\s*30px[\s\S]*?height:\s*30px/);
  assert.match(annotationsContent, /\.ls-annotation-marker::before\s*\{[\s\S]*?background:\s*var\(--ls-annotation-primary-bg\)[\s\S]*?transform:\s*rotate\(30deg\)/);
  assert.match(annotationsContent, /state\.annotations\.forEach\(\(annotation, index\) =>/);
  assert.match(annotationsContent, /marker\.textContent = String\(index \+ 1\)/);
  assert.match(annotationsContent, /marker\.setAttribute\("aria-label", `Open annotation \$\{index \+ 1\}`\)/);
  assert.doesNotMatch(annotationsContent, /marker\.innerHTML = ICONS\.annotations/);
});

test("annotation chrome uses semantic theme tokens instead of sampled or inverted colors", () => {
  assert.match(annotationsContent, /--ls-annotation-surface:\s*var\(--ls-ui-surface\)/);
  assert.match(annotationsContent, /--ls-annotation-text:\s*var\(--ls-ui-text\)/);
  assert.match(annotationsContent, /--ls-annotation-control-bg:\s*var\(--ls-ui-control-bg\)/);
  assert.match(annotationsContent, /--ls-annotation-primary-bg:\s*var\(--ls-ui-primary-bg\)/);
  assert.match(annotationsContent, /\.ls-annotation-add\s*\{[\s\S]*?background:\s*var\(--ls-annotation-control-bg\) !important[\s\S]*?color:\s*var\(--ls-annotation-text\) !important/);
  assert.match(annotationsContent, /\.ls-annotation-marker\s*\{[\s\S]*?background:\s*var\(--ls-annotation-primary-bg\)[\s\S]*?color:\s*var\(--ls-annotation-primary-text\)/);
  assert.match(annotationsContent, /\.ls-annotation-editor__save\s*\{[\s\S]*?background:\s*var\(--ls-annotation-primary-bg\)[\s\S]*?color:\s*var\(--ls-annotation-primary-text\)/);
  assert.match(annotationsContent, /style\.removeProperty\("--ls-annotation-surface"\)/);
  assert.doesNotMatch(annotationsContent, /--ls-annotation-(?:surface|text):\s*Canvas/);
});

test("ChatGPT annotation geometry uses shared button and annotation radius tokens", () => {
  assert.match(annotationsContent, /\.ls-annotation-add\s*\{[\s\S]*?border-radius:\s*var\(--ls-ui-radius-button,\s*14px\) !important/);
  assert.match(annotationsContent, /\.ls-annotation-editor\s*\{[\s\S]*?border-radius:\s*var\(--ls-ui-radius-annotation,\s*24px\)/);
  assert.match(annotationsContent, /\.ls-annotation-editor--editing\s*\{[\s\S]*?border-radius:\s*var\(--ls-ui-radius-annotation-editing,\s*22px\)/);
  assert.match(annotationsContent, /\.ls-annotation-tooltip\s*\{[\s\S]*?border-radius:\s*var\(--ls-ui-radius-annotation-tooltip,\s*14px\)/);
});

test("ChatGPT annotation editor uses the shared 20 percent narrower width", () => {
  assert.match(annotationsContent, /width:\s*min\(var\(--ls-ui-annotation-editor-width,\s*336px\),\s*calc\(100vw - 16px\)\)/);
});

test("annotation UI typography follows the shared composer scale", () => {
  assert.match(annotationsContent, /--ls-annotation-ui-font-size:\s*var\(--ls-composer-font-size,\s*13px\)/);
  assert.match(annotationsContent, /--ls-annotation-secondary-font-size:\s*calc\(var\(--ls-annotation-ui-font-size\) - 1px\)/);
  assert.match(annotationsContent, /\.ls-annotation-editor__input\s*\{[\s\S]*?font-size:\s*calc\(var\(--ls-annotation-ui-font-size\) \+ 2px\)/);
  assert.match(annotationsContent, /\.ls-annotation-tooltip__comment\s*\{[\s\S]*?font-size:\s*var\(--ls-annotation-ui-font-size\)/);
  assert.match(annotationsContent, /\.ls-annotation-composer-list__header,[\s\S]*?font-size:\s*var\(--ls-annotation-ui-font-size\)/);
  assert.doesNotMatch(annotationsContent, /font-size:\s*(?:10|10\.5|11)px/);
});
