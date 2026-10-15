import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRecoveryAnnotationTurn,
  chatAnnotationRecoverySnapshot,
  fileAnnotationRecoverySnapshot,
  normalizeRecoveryTurns,
} from "../../src/lib/local-annotations.js";

function snapshot({ id, messageKey, comment, quote, updatedAt }) {
  return chatAnnotationRecoverySnapshot({
    id,
    comment,
    source: { messageKey, role: "assistant", quote },
    createdAt: updatedAt,
    updatedAt,
  });
}

test("annotation recovery groups annotations by ChatGPT message turn", () => {
  let turns = [];
  turns = appendRecoveryAnnotationTurn(turns, snapshot({
    id: "annotation_1",
    messageKey: "turn:assistant-a",
    comment: "First",
    quote: "Quote one",
    updatedAt: "2026-09-17T10:00:00.000Z",
  }));
  turns = appendRecoveryAnnotationTurn(turns, snapshot({
    id: "annotation_2",
    messageKey: "turn:assistant-a",
    comment: "Second",
    quote: "Quote two",
    updatedAt: "2026-09-17T10:00:01.000Z",
  }));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].annotations.length, 2);

  turns = appendRecoveryAnnotationTurn(turns, snapshot({
    id: "annotation_3",
    messageKey: "turn:assistant-b",
    comment: "Later turn",
    quote: "Quote three",
    updatedAt: "2026-09-17T10:01:00.000Z",
  }));
  assert.equal(turns.length, 2);
  assert.equal(turns.at(-1).key, "chat:turn:assistant-b");
  assert.deepEqual(turns.at(-1).annotations.map((item) => item.id), ["annotation_3"]);
});

test("legacy lastAnnotation migrates into one recovery turn", () => {
  const legacy = snapshot({
    id: "annotation_legacy",
    messageKey: "turn:legacy",
    comment: "Legacy",
    quote: "Old quote",
    updatedAt: "2026-09-17T09:00:00.000Z",
  });
  const turns = normalizeRecoveryTurns(undefined, legacy);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].annotations[0].id, "annotation_legacy");
});

test("file annotation recovery preserves a rendered Markdown source quote", () => {
  const snapshot = fileAnnotationRecoverySnapshot({
    id: "file-markdown-1",
    path: "/tmp/readme.md",
    comment: "Check this",
    quote: "important text",
    sourceQuote: "**important** text",
    start: { line: 2, column: 1, offset: 10 },
    end: { line: 2, column: 19, offset: 28 },
    updatedAt: "2026-09-20T08:00:00.000Z",
  });
  assert.equal(snapshot.quote, "important text");
  assert.equal(snapshot.sourceQuote, "**important** text");
});
