import assert from "node:assert/strict";
import test from "node:test";
import {
  answerBrowserInteraction,
  browserInteractionSnapshot,
  clearBrowserInteractionsForTests,
  startBrowserInteraction,
  waitForBrowserInteractionChange,
} from "../../src/lib/browser-interaction.js";
import { conversationKey } from "../../src/lib/conversation.js";

test.afterEach(() => clearBrowserInteractionsForTests());

test("browser interaction publishes a question and accepts an option answer", async () => {
  const conversationId = "browser-question-conversation";
  const key = conversationKey(conversationId);
  const handle = startBrowserInteraction({
    conversationId,
    requestId: "ask_1",
    question: "Choose one",
    options: ["A", "B"],
    questionIndex: 1,
    questionCount: 3,
  });

  const snapshot = browserInteractionSnapshot(key);
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.interaction, {
    id: "ask_1",
    kind: "question",
    title: "Question",
    question: "Choose one",
    options: ["A", "B"],
    allowCustom: true,
    multiple: false,
    questionIndex: 1,
    questionCount: 3,
    sections: [],
    prompt: "",
    createdAt: snapshot.interaction.createdAt,
  });

  answerBrowserInteraction(key, { requestId: "ask_1", answer: "B" });
  assert.deepEqual(await handle.promise, {
    status: "answered",
    answer: "B",
    answers: ["B"],
    source: "browser",
    custom: false,
    optionIndex: 1,
    optionIndexes: [1],
  });
  assert.equal(browserInteractionSnapshot(key).interaction, null);
  assert.equal(browserInteractionSnapshot(key).revision, 2);
});

test("browser interaction long wait wakes when a request appears", async () => {
  const conversationId = "browser-wait-conversation";
  const key = conversationKey(conversationId);
  const waiting = waitForBrowserInteractionChange(key, 0, 2_000);
  queueMicrotask(() => startBrowserInteraction({
    conversationId,
    requestId: "ask_wait",
    question: "Ready?",
    options: ["Yes"],
  }));
  const snapshot = await waiting;
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.interaction.id, "ask_wait");
});

test("browser interaction exposes the exact question deadline", () => {
  const conversationId = "browser-deadline-conversation";
  const key = conversationKey(conversationId);
  const expiresAt = Date.now() + 300_000;
  startBrowserInteraction({
    conversationId,
    requestId: "ask_deadline",
    question: "Answer before time runs out",
    expiresAt,
  });
  assert.equal(browserInteractionSnapshot(key).interaction.expiresAt, expiresAt);
});

test("browser content-only interaction accepts custom text without options", async () => {
  const conversationId = "browser-content-only-conversation";
  const key = conversationKey(conversationId);
  const handle = startBrowserInteraction({
    conversationId,
    requestId: "ask_content_only",
    question: "Continue when ready.",
    content: "<strong>Preview</strong>",
    contentOnly: true,
  });

  const interaction = browserInteractionSnapshot(key).interaction;
  assert.equal(interaction.contentOnly, true);
  assert.deepEqual(interaction.options, []);
  answerBrowserInteraction(key, { requestId: "ask_content_only", answer: "My custom response" });
  assert.deepEqual(await handle.promise, {
    status: "answered",
    answer: "My custom response",
    answers: ["My custom response"],
    source: "browser",
    custom: true,
    optionIndex: null,
    optionIndexes: null,
    contentOnly: true,
  });
});

test("browser approval cannot be skipped and supports an explicit decision", async () => {
  const conversationId = "browser-approval-conversation";
  const key = conversationKey(conversationId);
  const handle = startBrowserInteraction({
    conversationId,
    requestId: "approval_1",
    kind: "approval",
    title: "Approval",
    question: "Approve this operation?",
    options: ["Approve", "Deny"],
    allowCustom: true,
    sections: [{ label: "Command", text: "rm file", mono: true }],
  });
  assert.throws(
    () => answerBrowserInteraction(key, { requestId: "approval_1", skip: true }),
    /cannot be skipped/,
  );
  answerBrowserInteraction(key, { requestId: "approval_1", answer: "Approve" });
  const result = await handle.promise;
  assert.equal(result.source, "browser");
  assert.equal(result.custom, false);
  assert.equal(result.optionIndex, 0);
});

test("browser multi-select preserves selected options and custom input", async () => {
  const conversationId = "browser-multi-conversation";
  const key = conversationKey(conversationId);
  const handle = startBrowserInteraction({
    conversationId,
    requestId: "ask_multi",
    question: "Which checks?",
    options: ["lint", "unit"],
    multiSelect: true,
  });
  answerBrowserInteraction(key, {
    requestId: "ask_multi",
    answers: ["lint", "manual review"],
  });
  assert.deepEqual(await handle.promise, {
    status: "answered",
    answer: "lint, manual review",
    answers: ["lint", "manual review"],
    source: "browser",
    custom: true,
    optionIndex: null,
    optionIndexes: [0],
  });
});
