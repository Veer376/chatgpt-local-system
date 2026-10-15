import test from "node:test";
import assert from "node:assert/strict";
import { UserQuestionnaireManager } from "../../src/lib/user-question.js";

const questions = [{ question: "Continue?", options: ["Yes", "No"], multiple: false }];
const answer = {
  questionIndex: 0,
  question: "Continue?",
  answer: "Yes",
  answers: ["Yes"],
  source: "test",
  custom: false,
  optionIndex: 0,
  optionIndexes: [0],
  multiple: false,
};

test("a waiting questionnaire resumes without starting the prompt twice", async () => {
  const serviceResult = deferred();
  let calls = 0;
  const manager = makeManager(async (input) => {
    calls += 1;
    assert.equal(input.signal, undefined);
    return serviceResult.promise;
  });

  const waiting = await manager.ask({ conversationId: "conversation-a", questions });
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.request_id, "ask_test_1");
  assert.equal(waiting.answered_count, 0);

  const resumed = manager.ask({ conversationId: "conversation-a" });
  serviceResult.resolve({ status: "answered", answers: [answer] });
  assert.deepEqual(await resumed, {
    status: "answered",
    request_id: "ask_test_1",
    answers: [answer],
    question_count: 1,
  });
  assert.equal(calls, 1);
});

test("cancelling an observer leaves the underlying questionnaire alive", async () => {
  const serviceResult = deferred();
  let receivedInput;
  const manager = makeManager(async (input) => {
    receivedInput = input;
    return serviceResult.promise;
  });
  const controller = new AbortController();
  const observed = manager.ask({ conversationId: "conversation-b", questions, signal: controller.signal });
  controller.abort();

  const waiting = await observed;
  assert.equal(waiting.status, "waiting");
  assert.equal(receivedInput.signal, undefined);
  serviceResult.resolve({ status: "answered", answers: [answer] });
  assert.equal((await manager.ask({ conversationId: "conversation-b" })).status, "answered");
});

test("partial answers are preserved and reported between observation calls", async () => {
  const serviceResult = deferred();
  const manager = makeManager(async ({ onProgress }) => {
    onProgress([answer]);
    return serviceResult.promise;
  });

  const waiting = await manager.ask({
    conversationId: "conversation-c",
    questions: [...questions, { question: "Why?", options: [], multiple: false }],
  });
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(waiting.answers, [answer]);
  assert.equal(waiting.answered_count, 1);
  assert.equal(waiting.next_question_index, 1);

  serviceResult.resolve({ status: "timeout", answers: [answer], timeoutQuestionIndex: 1, timeoutMs: 300_000 });
  const expired = await manager.ask({ conversationId: "conversation-c" });
  assert.equal(expired.status, "expired");
  assert.equal(expired.request_id, waiting.request_id);
  assert.deepEqual(expired.answers, [answer]);
  assert.equal(expired.timeout_question_index, 1);
});

test("repeating the same start call while pending is idempotent", async () => {
  const serviceResult = deferred();
  let calls = 0;
  const manager = makeManager(async () => {
    calls += 1;
    return serviceResult.promise;
  });

  const first = manager.ask({ conversationId: "conversation-d", questions });
  const second = manager.ask({ conversationId: "conversation-d", questions: structuredClone(questions) });
  const [firstWaiting, secondWaiting] = await Promise.all([first, second]);
  assert.equal(firstWaiting.request_id, secondWaiting.request_id);
  assert.equal(calls, 1);
  serviceResult.resolve({ status: "answered", answers: [answer] });
});

test("a different questionnaire cannot replace one that is pending", async () => {
  const serviceResult = deferred();
  const manager = makeManager(async () => serviceResult.promise);
  await manager.ask({ conversationId: "conversation-e", questions });

  await assert.rejects(
    manager.ask({ conversationId: "conversation-e", questions: [{ question: "Different?", options: [], multiple: false }] }),
    /already pending.*ask_test_1/i,
  );
  serviceResult.resolve({ status: "answered", answers: [answer] });
});

test("a completed result remains resumable and a new start replaces it", async () => {
  let calls = 0;
  const manager = makeManager(async () => {
    calls += 1;
    return { status: "answered", answers: [answer] };
  });
  const completed = await manager.ask({ conversationId: "conversation-f", questions });
  assert.equal((await manager.ask({ conversationId: "conversation-f" })).request_id, completed.request_id);

  const repeated = await manager.ask({ conversationId: "conversation-f", questions });
  assert.notEqual(repeated.request_id, completed.request_id);
  assert.equal(calls, 2);
});

test("service failures are cached with their request id for diagnostics", async () => {
  const manager = makeManager(async () => { throw new Error("transport unavailable"); });
  const failed = await manager.ask({ conversationId: "conversation-g", questions });
  assert.deepEqual(failed, {
    status: "failed",
    request_id: "ask_test_1",
    answers: [],
    error: "transport unavailable",
  });
  assert.deepEqual(await manager.ask({ conversationId: "conversation-g" }), failed);
});

test("resume requires conversation state and an existing questionnaire", async () => {
  const manager = makeManager(async () => ({ status: "answered", answers: [answer] }));
  await assert.rejects(manager.ask({ questions }), /conversation-scoped/i);
  await assert.rejects(manager.ask({ conversationId: "missing" }), /available to resume/i);
});

test("terminal results expire from the resume cache", async () => {
  let now = 1_000;
  const manager = new UserQuestionnaireManager({
    serviceFactory: () => ({ askMany: async () => ({ status: "answered", answers: [answer] }) }),
    waitTimeoutMs: 5,
    terminalRetentionMs: 100,
    now: () => now,
    requestIdFactory: () => "ask_ttl",
  });
  await manager.ask({ conversationId: "conversation-h", questions });
  now += 101;
  await assert.rejects(manager.ask({ conversationId: "conversation-h" }), /available to resume/i);
});

function makeManager(askMany) {
  let nextId = 1;
  return new UserQuestionnaireManager({
    serviceFactory: () => ({ askMany }),
    waitTimeoutMs: 5,
    terminalRetentionMs: 60_000,
    requestIdFactory: () => `ask_test_${nextId++}`,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
