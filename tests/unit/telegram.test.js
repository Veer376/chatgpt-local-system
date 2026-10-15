import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelegramQuestionService } from "../../src/lib/telegram.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-telegram-test-"));
const token = "123456:test-token";

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("Telegram option buttons return the selected option and bind the private /start chat", async () => {
  const bindingFile = path.join(base, "option-binding.json");
  let callbackData;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(1)];
      if (callbackData) {
        const data = callbackData;
        callbackData = null;
        return [{
          update_id: 2,
          callback_query: {
            id: "cb-1",
            from: { id: 42 },
            message: { message_id: 101, chat: { id: 42, type: "private" } },
            data,
          },
        }];
      }
      return [];
    }
    if (method === "sendMessage") {
      callbackData = payload.reply_markup.inline_keyboard[1][0].callback_data;
      return { message_id: 101 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Pick one", options: ["A", "B"] });

  assert.deepEqual(result, {
    status: "answered",
    answer: "B",
    answers: ["B"],
    source: "telegram",
    custom: false,
    optionIndex: 1,
    optionIndexes: [1],
  });
  const binding = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
  assert.equal(binding.chatId, "42");
  assert.equal(binding.userId, "42");
  assert.equal(JSON.stringify(binding).includes(token), false, "the bot token is never persisted");
});

test("strict option prompts expose no custom-answer path", async () => {
  const bindingFile = path.join(base, "strict-option-binding.json");
  let callbackData;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(3)];
      if (callbackData) {
        const data = callbackData;
        callbackData = null;
        return [{
          update_id: 4,
          callback_query: {
            id: "strict-cb",
            from: { id: 42 },
            message: { message_id: 111, chat: { id: 42, type: "private" } },
            data,
          },
        }];
      }
      return [];
    }
    if (method === "sendMessage") {
      const keyboard = payload.reply_markup?.inline_keyboard || [];
      assert.deepEqual(keyboard.map((row) => row[0].text), ["Approve", "Deny"]);
      callbackData = keyboard[0][0].callback_data;
      return { message_id: 111 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Approve?", options: ["Approve", "Deny"], allowCustom: false });
  assert.equal(result.answer, "Approve");
  assert.equal(result.custom, false);
  assert.equal(result.optionIndex, 0);
});

test("strict option prompts ignore typed replies", async () => {
  const bindingFile = path.join(base, "strict-reply-binding.json");
  let sent = false;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(5)];
      if (sent) {
        sent = false;
        return [{
          update_id: 6,
          message: {
            message_id: 122,
            text: "Approve",
            from: { id: 42 },
            chat: { id: 42, type: "private" },
            reply_to_message: { message_id: 121 },
          },
        }];
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      sent = true;
      return { message_id: 121 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 30, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Approve?", options: ["Approve", "Deny"], allowCustom: false });
  assert.equal(result.status, "timeout");
  assert.equal(result.answer, null);
});

test("a reply to the exact bot message is accepted as custom input", async () => {
  const bindingFile = path.join(base, "custom-binding.json");
  let sent = false;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(10)];
      if (sent) {
        sent = false;
        return [{
          update_id: 11,
          message: {
            message_id: 202,
            text: "Use the staging database instead",
            from: { id: 42 },
            chat: { id: 42, type: "private" },
            reply_to_message: { message_id: 201 },
          },
        }];
      }
      return [];
    }
    if (method === "sendMessage") {
      sent = true;
      return { message_id: 201 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Database?", options: ["Production", "Local"] });

  assert.equal(result.status, "answered");
  assert.equal(result.answer, "Use the staging database instead");
  assert.equal(result.custom, true);
  assert.equal(result.optionIndex, null);
});

test("free-text question omits option buttons and uses Telegram ForceReply", async () => {
  const bindingFile = path.join(base, "free-text-binding.json");
  let questionMessageId = null;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(12)];
      if (questionMessageId) {
        const id = questionMessageId;
        questionMessageId = null;
        return [{
          update_id: 13,
          message: {
            message_id: 214,
            text: "Here is my open-ended answer",
            from: { id: 42 },
            chat: { id: 42, type: "private" },
            reply_to_message: { message_id: id },
          },
        }];
      }
      return [];
    }
    if (method === "sendMessage") {
      assert.equal(payload.reply_markup?.force_reply, true);
      assert.equal(payload.reply_markup?.inline_keyboard, undefined);
      questionMessageId = 213;
      return { message_id: 213 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Tell me what you want changed", options: [] });

  assert.equal(result.status, "answered");
  assert.equal(result.answer, "Here is my open-ended answer");
  assert.equal(result.custom, true);
  assert.equal(result.optionIndex, null);
});

test("Custom answer button opens a ForceReply prompt and accepts the typed response", async () => {
  const bindingFile = path.join(base, "force-reply-binding.json");
  let callbackData;
  let customPromptSent = false;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(15)];
      if (callbackData) {
        const data = callbackData;
        callbackData = null;
        return [{
          update_id: 16,
          callback_query: {
            id: "custom-cb",
            from: { id: 42 },
            message: { message_id: 251, chat: { id: 42, type: "private" } },
            data,
          },
        }];
      }
      if (customPromptSent) {
        customPromptSent = false;
        return [{
          update_id: 17,
          message: {
            message_id: 253,
            text: "My typed custom response",
            from: { id: 42 },
            chat: { id: 42, type: "private" },
            reply_to_message: { message_id: 252 },
          },
        }];
      }
      return [];
    }
    if (method === "sendMessage" && payload.reply_markup?.inline_keyboard) {
      callbackData = payload.reply_markup.inline_keyboard.at(-1)[0].callback_data;
      assert.equal(payload.reply_markup.inline_keyboard.at(-1)[0].text, "✏️ Custom answer");
      return { message_id: 251 };
    }
    if (method === "sendMessage" && payload.reply_markup?.force_reply) {
      assert.equal(payload.reply_to_message_id, 251);
      assert.equal(payload.reply_markup.input_field_placeholder, "Type your custom answer…");
      customPromptSent = true;
      return { message_id: 252 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Anything else?", options: ["No"] });

  assert.equal(result.status, "answered");
  assert.equal(result.answer, "My typed custom response");
  assert.equal(result.custom, true);
  assert.equal(result.optionIndex, null);
});

test("unauthorized Telegram callbacks cannot answer a pending question", async () => {
  const bindingFile = path.join(base, "auth-binding.json");
  let callbackData;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(20)];
      if (callbackData) {
        const data = callbackData;
        callbackData = null;
        return [
          {
            update_id: 21,
            callback_query: {
              id: "bad",
              from: { id: 99 },
              message: { message_id: 301, chat: { id: 42, type: "private" } },
              data,
            },
          },
          {
            update_id: 22,
            callback_query: {
              id: "good",
              from: { id: 42 },
              message: { message_id: 301, chat: { id: 42, type: "private" } },
              data,
            },
          },
        ];
      }
      return [];
    }
    if (method === "sendMessage") {
      callbackData = payload.reply_markup.inline_keyboard[0][0].callback_data;
      return { message_id: 301 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Continue?", options: ["Yes", "No"] });
  assert.equal(result.answer, "Yes");
});

test("concurrent questions are correlated independently on one Telegram update stream", async () => {
  const bindingFile = path.join(base, "concurrent-binding.json");
  const sent = [];
  let updateCalls = 0;
  let delivered = false;
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(25)];
      if (!delivered && sent.length === 2) {
        delivered = true;
        return sent.map((item, index) => ({
          update_id: 26 + index,
          callback_query: {
            id: `cb-concurrent-${index}`,
            from: { id: 42 },
            message: { message_id: item.messageId, chat: { id: 42, type: "private" } },
            data: item.callbackData,
          },
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      const messageId = 350 + sent.length;
      sent.push({
        messageId,
        callbackData: payload.reply_markup.inline_keyboard[0][0].callback_data,
      });
      return { message_id: messageId };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const [first, second] = await Promise.all([
    service.ask({ question: "First?", options: ["First answer", "Other"] }),
    service.ask({ question: "Second?", options: ["Second answer", "Other"] }),
  ]);
  assert.equal(first.answer, "First answer");
  assert.equal(second.answer, "Second answer");
});

test("timeout is a normal result so the caller can proceed with its recommendation", async () => {
  const bindingFile = path.join(base, "timeout-binding.json");
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(30)];
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    }
    if (method === "sendMessage") return { message_id: 401 };
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 25, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Pick", options: ["A", "B"], timeoutMs: 25 });
  assert.deepEqual(result, {
    status: "timeout",
    answer: null,
    answers: [],
    source: "timeout",
    custom: false,
    timeoutMs: 25,
  });
});

test("multiple questions are asked sequentially and preserve ordered option/custom answers", async () => {
  const bindingFile = path.join(base, "many-binding.json");
  let updateCalls = 0;
  const sentQuestions = [];
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(35)];
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      sentQuestions.push(payload.text);
      return { message_id: 450 + sentQuestions.length };
    }
    return true;
  });
  let macCall = 0;
  const macUiFactory = ({ options }) => {
    const index = macCall;
    macCall += 1;
    return {
      promise: Promise.resolve(index === 0
        ? { status: "answered", answer: options[1], custom: false, optionIndex: 1 }
        : { status: "answered", answer: "After lunch", custom: true, optionIndex: null }),
      close() {},
    };
  };
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory });
  const progress = [];
  const result = await service.askMany({
    questions: [
      { question: "Database?", options: ["SQLite", "Postgres"] },
      { question: "When should I deploy?", options: ["Now", "Tomorrow"] },
    ],
    onProgress: (answers) => progress.push(answers),
  });

  assert.equal(result.status, "answered");
  assert.deepEqual(sentQuestions, [
    "<b>Question 1 of 2</b>\n<blockquote>Database?</blockquote>",
    "<b>Question 2 of 2</b>\n<blockquote>When should I deploy?</blockquote>",
  ]);
  assert.deepEqual(result.answers, [
    {
      questionIndex: 0,
      question: "Database?",
      answer: "Postgres",
      answers: ["Postgres"],
      source: "macos",
      custom: false,
      optionIndex: 1,
      optionIndexes: [1],
      multiple: false,
    },
    {
      questionIndex: 1,
      question: "When should I deploy?",
      answer: "After lunch",
      answers: ["After lunch"],
      source: "macos",
      custom: true,
      optionIndex: null,
      optionIndexes: null,
      multiple: false,
    },
  ]);
  assert.deepEqual(progress.map((answers) => answers.length), [1, 2]);
  assert.notEqual(progress[1], result.answers);
  assert.notEqual(progress[1][0].answers, result.answers[0].answers);
});


test("multiple questions reuse one macOS session and keep it open between answers", async () => {
  const bindingFile = path.join(base, "many-mac-session-binding.json");
  let updateCalls = 0;
  let sends = 0;
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(37)];
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      sends += 1;
      return { message_id: 470 + sends };
    }
    return true;
  });

  const nativeCalls = [];
  const handleCloses = [];
  let sessionCloses = 0;
  const macUiSessionFactory = () => ({
    ask(args) {
      nativeCalls.push(args);
      const index = nativeCalls.length - 1;
      return {
        promise: Promise.resolve({
          status: "answered",
          answer: index === 0 ? args.options[0] : args.options[1],
          custom: false,
          optionIndex: index === 0 ? 0 : 1,
        }),
        close({ keepOpen = false } = {}) { handleCloses.push(keepOpen); },
      };
    },
    close() { sessionCloses += 1; },
  });

  const service = new TelegramQuestionService({
    token,
    bindingFile,
    timeoutMs: 1_000,
    fetchImpl,
    macUiFactory: noMacUi,
    macUiSessionFactory,
  });
  const result = await service.askMany({
    questions: [
      { question: "First native question?", options: ["A", "B"], content: "<strong>Native preview</strong>" },
      { question: "Second native question?", options: ["C", "D"] },
    ],
  });

  assert.equal(result.status, "answered");
  assert.equal(nativeCalls.length, 2);
  assert.deepEqual(nativeCalls.map((item) => item.title), ["Question 1 of 2", "Question 2 of 2"]);
  assert.deepEqual(nativeCalls.map((item) => item.macQuestion), ["First native question?", "Second native question?"]);
  assert.deepEqual(nativeCalls.map((item) => item.questionIndex), [0, 1]);
  assert.deepEqual(nativeCalls.map((item) => item.questionCount), [2, 2]);
  assert.deepEqual(nativeCalls.map((item) => item.interactionKind), ["question", "question"]);
  assert.equal(nativeCalls.every((item) => item.allowCustom === true), true);
  assert.equal(nativeCalls[0].content, "<strong>Native preview</strong>");
  assert.equal(nativeCalls.every((item) => Number.isFinite(item.expiresAt)), true);
  assert.deepEqual(handleCloses, [true, true]);
  assert.equal(sessionCloses, 0);
  service.close();
  assert.equal(sessionCloses, 1);
});

test("concurrent questions share one macOS session instead of opening competing native windows", async () => {
  const bindingFile = path.join(base, "shared-mac-queue-binding.json");
  let sessionFactoryCalls = 0;
  let sessionCloses = 0;
  const nativeCalls = [];
  const handleCloses = [];
  const macUiSessionFactory = () => {
    sessionFactoryCalls += 1;
    return {
      ask(args) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        nativeCalls.push({ args, resolve });
        return {
          promise,
          close({ keepOpen = false } = {}) { handleCloses.push(keepOpen); },
        };
      },
      close() { sessionCloses += 1; },
    };
  };
  const service = new TelegramQuestionService({
    token: "",
    bindingFile,
    timeoutMs: 1_000,
    fetchImpl: fakeTelegram(async () => []),
    macUiFactory: noMacUi,
    macUiSessionFactory,
    browserUiFactory: () => null,
  });

  const first = service.ask({ conversationId: "conversation-a", question: "First pending request?", options: ["A"] });
  const second = service.ask({ conversationId: "conversation-b", question: "Second pending request?", options: ["B"] });

  assert.equal(sessionFactoryCalls, 1);
  assert.deepEqual(nativeCalls.map(({ args }) => args.question), ["First pending request?", "Second pending request?"]);

  nativeCalls[0].resolve({ status: "answered", answer: "A", answers: ["A"], custom: false, optionIndex: 0 });
  nativeCalls[1].resolve({ status: "answered", answer: "B", answers: ["B"], custom: false, optionIndex: 0 });
  assert.equal((await first).answer, "A");
  assert.equal((await second).answer, "B");
  assert.deepEqual(handleCloses, [true, true]);

  service.close();
  assert.equal(sessionCloses, 1);
});

test("a question timeout stops the questionnaire before later questions open", async () => {
  const bindingFile = path.join(base, "many-timeout-binding.json");
  let updateCalls = 0;
  let sends = 0;
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(38)];
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    }
    if (method === "sendMessage") {
      sends += 1;
      return { message_id: 480 + sends };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 30, fetchImpl, macUiFactory: noMacUi });
  const result = await service.askMany({
    questions: [
      { question: "First?", options: ["A"] },
      { question: "Second?", options: ["B"] },
    ],
    timeoutMs: 30,
  });

  assert.equal(result.status, "timeout");
  assert.equal(result.timeoutQuestionIndex, 0);
  assert.equal(sends, 1, "a timed-out questionnaire does not open later questions");
});

test("multiple questions share one questionnaire response window", async () => {
  const bindingFile = path.join(base, "shared-questionnaire-window-binding.json");
  let updateCalls = 0;
  const sendTimes = [];
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(39)];
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      sendTimes.push(Date.now());
      return { message_id: 490 + sendTimes.length };
    }
    return true;
  });
  // Each answer takes 60ms. The first completes inside the 100ms questionnaire budget; the second
  // receives only the remaining time and must time out instead of receiving a fresh 100ms window.
  const macUiFactory = () => ({
    promise: new Promise((resolve) => setTimeout(
      () => resolve({ status: "answered", answer: "ok", custom: true, optionIndex: null }),
      60,
    )),
    close() {},
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 100, fetchImpl, macUiFactory });
  const result = await service.askMany({
    questions: [{ question: "Slow one?" }, { question: "Second?" }, { question: "Third?" }],
    timeoutMs: 100,
  });

  assert.equal(result.status, "timeout");
  assert.equal(result.answers.length, 1, "only answers completed inside the shared budget survive");
  assert.equal(result.timeoutQuestionIndex, 1);
  assert.equal(result.timeoutMs, 100);
  assert.equal(sendTimes.length, 2);
});

test("multiple private users cannot silently claim the same bot", async () => {
  const bindingFile = path.join(base, "ambiguous-binding.json");
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") return [startUpdate(40, 42), startUpdate(41, 77)];
    throw new Error(`unexpected ${method}`);
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 100, fetchImpl, macUiFactory: noMacUi });
  await assert.rejects(
    () => service.ask({ question: "Pick", options: ["A"] }),
    /multiple private users/i,
  );
});

test("macOS answer wins the shared request and removes the Telegram controls", async () => {
  const bindingFile = path.join(base, "mac-wins-binding.json");
  let resolveMac;
  let macClosed = false;
  let updateCalls = 0;
  const edits = [];
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(50)];
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      setTimeout(() => resolveMac({
        status: "answered",
        answer: "Mac choice",
        custom: false,
        optionIndex: 1,
        attachments: [{ path: "/tmp/mac-image.webp", name: "mac-image.webp", mimeType: "image/webp" }],
      }), 5);
      return { message_id: 501 };
    }
    if (method === "editMessageReplyMarkup") edits.push(payload);
    return true;
  });
  const macUiFactory = () => ({
    promise: new Promise((resolve) => { resolveMac = resolve; }),
    close() { macClosed = true; },
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory });
  const result = await service.ask({ question: "Choose", options: ["Telegram", "Mac choice"] });

  assert.equal(result.source, "macos");
  assert.equal(result.answer, "Mac choice");
  assert.equal(result.optionIndex, 1);
  assert.deepEqual(result.attachments, [{ path: "/tmp/mac-image.webp", name: "mac-image.webp", mimeType: "image/webp" }]);
  assert.equal(macClosed, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(edits.some((item) => item.message_id === 501 && item.reply_markup?.inline_keyboard?.length === 0), true);
});

test("Telegram answer closes a still-open macOS question window", async () => {
  const bindingFile = path.join(base, "telegram-wins-binding.json");
  let callbackData;
  let macClosed = false;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(60)];
      if (callbackData) {
        const data = callbackData;
        callbackData = null;
        return [{
          update_id: 61,
          callback_query: {
            id: "telegram-wins",
            from: { id: 42 },
            message: { message_id: 601, chat: { id: 42, type: "private" } },
            data,
          },
        }];
      }
      return [];
    }
    if (method === "sendMessage") {
      callbackData = payload.reply_markup.inline_keyboard[0][0].callback_data;
      return { message_id: 601 };
    }
    return true;
  });
  const macUiFactory = () => ({
    promise: new Promise(() => {}),
    close() { macClosed = true; },
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory });
  const result = await service.ask({ question: "Choose", options: ["Telegram answer", "Other"] });

  assert.equal(result.source, "telegram");
  assert.equal(result.answer, "Telegram answer");
  assert.equal(macClosed, true);
});

test("browser answer wins the shared request and closes macOS and Telegram surfaces", async () => {
  const bindingFile = path.join(base, "browser-wins-binding.json");
  let macClosed = false;
  let browserClosed = false;
  let updateCalls = 0;
  const edits = [];
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(81)];
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") return { message_id: 811 };
    if (method === "editMessageReplyMarkup") edits.push(payload);
    return true;
  });
  const macUiFactory = () => ({
    promise: new Promise(() => {}),
    close() { macClosed = true; },
  });
  const browserUiFactory = ({ conversationId, question, questionIndex, questionCount }) => {
    assert.equal(conversationId, "v1/browser-wins");
    assert.equal(question, "Choose");
    assert.equal(questionIndex, 0);
    assert.equal(questionCount, 1);
    return {
      promise: new Promise((resolve) => setTimeout(() => resolve({
          status: "answered",
          answer: "Browser answer",
          answers: ["Browser answer"],
          source: "browser",
          custom: false,
          optionIndex: 0,
          optionIndexes: [0],
        }), 5)),
      close() { browserClosed = true; },
    };
  };
  const service = new TelegramQuestionService({
    token,
    bindingFile,
    timeoutMs: 1_000,
    fetchImpl,
    macUiFactory,
    browserUiFactory,
  });
  const result = await service.ask({
    conversationId: "v1/browser-wins",
    question: "Choose",
    options: ["Browser answer", "Other"],
  });

  assert.equal(result.source, "browser");
  assert.equal(result.answer, "Browser answer");
  assert.equal(macClosed, true);
  assert.equal(browserClosed, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(edits.some((item) => item.message_id === 811 && item.reply_markup?.inline_keyboard?.length === 0), true);
});

test("browser ask_user remains available when Telegram is not linked", async () => {
  const service = new TelegramQuestionService({
    token: "",
    bindingFile: path.join(base, "browser-without-telegram.json"),
    timeoutMs: 1_000,
    fetchImpl: async () => { throw new Error("Telegram should not be required for browser fallback"); },
    macUiFactory: noMacUi,
    browserUiFactory: ({ conversationId, question }) => {
      assert.equal(conversationId, "v1/browser-no-telegram");
      assert.equal(question, "Choose");
      return {
        promise: Promise.resolve({
          status: "answered",
          answer: "Browser answer",
          answers: ["Browser answer"],
          source: "browser",
          custom: false,
          optionIndex: 0,
          optionIndexes: [0],
        }),
        close() {},
      };
    },
  });

  const result = await service.ask({
    conversationId: "v1/browser-no-telegram",
    question: "Choose",
    options: ["Browser answer", "Other"],
  });
  assert.equal(result.source, "browser");
  assert.equal(result.answer, "Browser answer");
  assert.equal(result.optionIndex, 0);
});

test("cancelling ask_user closes both native and Telegram interaction surfaces", async () => {
  const bindingFile = path.join(base, "cancel-binding.json");
  const controller = new AbortController();
  let macClosed = false;
  let updateCalls = 0;
  const edits = [];
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(70)];
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      setTimeout(() => controller.abort(), 5);
      return { message_id: 701 };
    }
    if (method === "editMessageReplyMarkup") edits.push(payload);
    return true;
  });
  const macUiFactory = () => ({
    promise: new Promise(() => {}),
    close() { macClosed = true; },
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory });

  await assert.rejects(
    () => service.ask({ question: "Choose", options: ["A"], signal: controller.signal }),
    /cancelled while waiting/i,
  );
  assert.equal(macClosed, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(edits.some((item) => item.message_id === 701 && item.reply_markup?.inline_keyboard?.length === 0), true);
});

test("Telegram multi-select toggles options, redraws the keyboard, and returns every pick on Done", async () => {
  const bindingFile = path.join(base, "multi-select-binding.json");
  let requestId = null;
  let updateCalls = 0;
  const queue = [];
  const keyboards = [];
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(60)];
      const next = queue.shift();
      if (!next) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return [];
      }
      return [{
        update_id: 60 + updateCalls,
        callback_query: {
          id: `cb-${updateCalls}`,
          from: { id: 42 },
          message: { message_id: 801, chat: { id: 42, type: "private" } },
          data: `ask:${requestId}:${next}`,
        },
      }];
    }
    if (method === "sendMessage") {
      requestId = payload.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
      keyboards.push(payload.reply_markup.inline_keyboard);
      assert.match(payload.text, /then press Done/);
      queue.push("0", "2", "done");
      return { message_id: 801 };
    }
    if (method === "editMessageReplyMarkup" && payload.reply_markup?.inline_keyboard?.length) {
      keyboards.push(payload.reply_markup.inline_keyboard);
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Which checks?", options: ["lint", "unit", "e2e"], multiSelect: true });

  assert.deepEqual(result, {
    status: "answered",
    answer: "lint, e2e",
    answers: ["lint", "e2e"],
    source: "telegram",
    custom: false,
    optionIndex: null,
    optionIndexes: [0, 2],
  });
  const labels = keyboards.map((rows) => rows.map((row) => row[0].text));
  assert.deepEqual(labels[0], ["⬜️ lint", "⬜️ unit", "⬜️ e2e", "✅ Done", "✏️ Custom answer"]);
  assert.deepEqual(labels.at(-1).slice(0, 3), ["☑️ lint", "⬜️ unit", "☑️ e2e"]);
});

test("Telegram multi-select refuses Done with nothing selected and keeps waiting", async () => {
  const bindingFile = path.join(base, "multi-empty-binding.json");
  let requestId = null;
  let updateCalls = 0;
  const queue = [];
  const callbackAnswers = [];
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(70)];
      const next = queue.shift();
      if (!next) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return [];
      }
      return [{
        update_id: 70 + updateCalls,
        callback_query: {
          id: `cb-${updateCalls}`,
          from: { id: 42 },
          message: { message_id: 811, chat: { id: 42, type: "private" } },
          data: `ask:${requestId}:${next}`,
        },
      }];
    }
    if (method === "sendMessage") {
      requestId = payload.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
      queue.push("done", "1", "done");
      return { message_id: 811 };
    }
    if (method === "answerCallbackQuery") callbackAnswers.push(payload.text);
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Which checks?", options: ["lint", "unit"], multiSelect: true });

  assert.equal(result.answer, "unit");
  assert.deepEqual(result.optionIndexes, [1]);
  assert.equal(callbackAnswers.includes("Pick at least one option first"), true);
});

test("multi-select is per question and reaches the native UI as multiSelect", async () => {
  const bindingFile = path.join(base, "many-multi-binding.json");
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(80)];
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") return { message_id: 820 + updateCalls };
    return true;
  });
  const macArgs = [];
  const macUiFactory = (args) => {
    macArgs.push(args);
    const index = macArgs.length - 1;
    return {
      promise: Promise.resolve(index === 0
        ? {
            status: "answered",
            answer: "lint, e2e",
            answers: ["lint", "e2e"],
            custom: false,
            optionIndex: null,
            optionIndexes: [0, 2],
          }
        : { status: "answered", answer: "Now", answers: ["Now"], custom: false, optionIndex: 0, optionIndexes: [0] }),
      close() {},
    };
  };
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory });
  const result = await service.askMany({
    questions: [
      { question: "Which checks?", options: ["lint", "unit", "e2e"], multiple: true },
      { question: "Deploy when?", options: ["Now", "Later"], multiple: false },
    ],
  });

  assert.deepEqual(macArgs.map((item) => item.multiSelect), [true, false]);
  assert.deepEqual(result.answers[0], {
    questionIndex: 0,
    question: "Which checks?",
    answer: "lint, e2e",
    answers: ["lint", "e2e"],
    source: "macos",
    custom: false,
    optionIndex: null,
    optionIndexes: [0, 2],
    multiple: true,
  });
  assert.deepEqual(result.answers[1].answers, ["Now"]);
  assert.equal(result.answers[1].multiple, false);
});

test("ForceReply is never selective, so the reply box actually opens in the private chat", async () => {
  const bindingFile = path.join(base, "force-reply-selective-binding.json");
  let questionMessageId = null;
  let updateCalls = 0;
  const replyMarkups = [];
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(90)];
      if (questionMessageId) {
        const id = questionMessageId;
        questionMessageId = null;
        return [{
          update_id: 91,
          message: {
            message_id: 902,
            text: "123456",
            from: { id: 42 },
            chat: { id: 42, type: "private" },
            reply_to_message: { message_id: id },
          },
        }];
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      replyMarkups.push(payload.reply_markup);
      questionMessageId = 901;
      return { message_id: 901 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "What is the code you were sent?", options: [] });

  assert.equal(result.answer, "123456");
  assert.equal(replyMarkups[0].force_reply, true);
  assert.equal("selective" in replyMarkups[0], false, "selective would suppress the reply box for this user");
});

test("a plain typed message answers the only pending question without a reply", async () => {
  const bindingFile = path.join(base, "plain-message-binding.json");
  let sent = false;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(95)];
      if (sent) {
        sent = false;
        return [{
          update_id: 96,
          message: {
            message_id: 912,
            text: "just typed straight into the chat",
            from: { id: 42 },
            chat: { id: 42, type: "private" },
          },
        }];
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      sent = true;
      return { message_id: 911 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 1_000, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Anything else?", options: [] });

  assert.equal(result.answer, "just typed straight into the chat");
  assert.equal(result.custom, true);
  assert.equal(result.source, "telegram");
});

test("a bare slash command is not swallowed as the answer", async () => {
  const bindingFile = path.join(base, "slash-message-binding.json");
  let sent = false;
  let updateCalls = 0;
  const fetchImpl = fakeTelegram(async (method) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(97)];
      if (sent) {
        sent = false;
        return [{
          update_id: 98,
          message: {
            message_id: 922,
            text: "/start",
            from: { id: 42 },
            chat: { id: 42, type: "private" },
          },
        }];
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      sent = true;
      return { message_id: 921 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 40, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({ question: "Anything else?", options: [], timeoutMs: 40 });
  assert.equal(result.status, "timeout");
});

test("structured approval text is sent to Telegram as HTML", async () => {
  const bindingFile = path.join(base, "approval-html-binding.json");
  let updateCalls = 0;
  const sends = [];
  const fetchImpl = fakeTelegram(async (method, payload) => {
    if (method === "getUpdates") {
      updateCalls += 1;
      if (updateCalls === 1) return [startUpdate(120)];
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    if (method === "sendMessage") {
      sends.push(payload);
      return { message_id: 1_001 };
    }
    return true;
  });
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 30, fetchImpl, macUiFactory: noMacUi });
  await service.ask({
    question: "plain fallback",
    questionHtml: "<b>Destructive action approval</b>\n<pre>rm -rf x</pre>",
    options: ["Approve", "Deny"],
    timeoutMs: 30,
  });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].parse_mode, "HTML");
  assert.match(sends[0].text, /<pre>rm -rf x<\/pre>/);
});

test("a rejected HTML message falls back to plain text instead of failing the question", async () => {
  const bindingFile = path.join(base, "approval-fallback-binding.json");
  let updateCalls = 0;
  const attempts = [];
  const fetchImpl = async (url, options) => {
    const method = String(url).split("/").at(-1);
    const payload = JSON.parse(options.body || "{}");
    if (method === "sendMessage") {
      attempts.push(payload);
      if (payload.parse_mode === "HTML") {
        return {
          ok: false,
          status: 400,
          async json() { return { ok: false, description: "Bad Request: can't parse entities" }; },
        };
      }
      return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 1_002 } }; } };
    }
    let result = true;
    if (method === "getUpdates") {
      updateCalls += 1;
      result = updateCalls === 1 ? [startUpdate(125)] : [];
      if (updateCalls > 1) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return { ok: true, status: 200, async json() { return { ok: true, result }; } };
  };
  const service = new TelegramQuestionService({ token, bindingFile, timeoutMs: 30, fetchImpl, macUiFactory: noMacUi });
  const result = await service.ask({
    question: "plain fallback text",
    questionHtml: "<b>unclosed",
    options: ["Approve", "Deny"],
    timeoutMs: 30,
  });

  assert.equal(result.status, "timeout", "the question still went out and simply went unanswered");
  assert.deepEqual(attempts.map((a) => a.parse_mode ?? "plain"), ["HTML", "plain"]);
  assert.equal(attempts[1].text, "plain fallback text");
});

function startUpdate(updateId, userId = 42) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text: "/start",
      from: { id: userId, is_bot: false },
      chat: { id: userId, type: "private" },
    },
  };
}

function fakeTelegram(handler) {
  return async (url, options) => {
    const method = String(url).split("/").at(-1);
    const payload = JSON.parse(options.body || "{}");
    const result = await handler(method, payload);
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, result }; },
    };
  };
}

function noMacUi() {
  return { promise: Promise.resolve({ status: "unavailable", reason: "test" }), close() {} };
}
