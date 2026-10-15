import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startBrowserInteraction } from "./browser-interaction.js";
import { startMacQuestion, startMacQuestionSession } from "./macos-question.js";

const TELEGRAM_API = "https://api.telegram.org";
const POLL_SECONDS = 20;
const API_TIMEOUT_MS = 25_000;
const MAX_POLL_FAILURES = 3;
const MAX_CUSTOM_ANSWER_CHARS = 4_000;
const DEBUG = process.env.ASK_USER_DEBUG === "1";

const DEBUG_FILE = process.env.ASK_USER_DEBUG_FILE || "/tmp/ask-user-debug.log";

function debugLog(label, value) {
  if (!DEBUG) return;
  // Written straight to a file: routing this through stdout depends on how the bridge was
  // launched, and it silently produced nothing at least once.
  try {
    fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${label} ${JSON.stringify(value)}\n`);
  } catch { /* never break a question */ }
}

export class TelegramQuestionService {
  constructor({
    token,
    bindingFile,
    timeoutMs,
    fetchImpl = globalThis.fetch,
    macUiFactory = startMacQuestion,
    macUiSessionFactory,
    browserUiFactory = startBrowserInteraction,
  } = {}) {
    this.token = String(token || "").trim();
    this.bindingFile = bindingFile;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.macUiFactory = macUiFactory;
    this.macUiSessionFactory = macUiSessionFactory === undefined && macUiFactory === startMacQuestion
      ? startMacQuestionSession
      : macUiSessionFactory;
    this.browserUiFactory = browserUiFactory;
    this.binding = null;
    this.ready = false;
    this.setupPromise = null;
    this.nextOffset = null;
    this.pending = new Map();
    this.pollingPromise = null;
    this.sharedMacSession = null;
  }

  #getSharedMacSession() {
    if (this.sharedMacSession?.isClosed?.()) this.sharedMacSession = null;
    if (this.sharedMacSession || typeof this.macUiSessionFactory !== "function") return this.sharedMacSession;
    this.sharedMacSession = this.macUiSessionFactory();
    return this.sharedMacSession;
  }

  async ask({
    conversationId,
    question,
    options = [],
    signal,
    timeoutMs = this.timeoutMs,
    allowCustom = true,
    multiSelect = false,
    title = "Question",
    macQuestion,
    questionHtml = null,
    sections = null,
    prompt = null,
    heading = null,
    macSession = null,
    keepMacUiOpen = false,
    interactionKind = "question",
    questionIndex = 0,
    questionCount = 1,
    content = null,
    presentationOnly = false,
    contentOnly = false,
  }) {
    if (signal?.aborted) throw new Error("request_user_input was cancelled before the question was sent");
    const startedAt = Date.now();
    const requestId = crypto.randomBytes(9).toString("base64url");
    const hasOptions = options.length > 0;
    const multiple = multiSelect && hasOptions;
    const selection = new Set();
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return {
        status: "timeout",
        answer: null,
        answers: [],
        source: "timeout",
        custom: false,
        timeoutMs,
      };
    }

    const sharedMacSession = macSession || this.#getSharedMacSession();
    const usesSharedMacSession = !macSession && Boolean(sharedMacSession);

    return new Promise((resolve, reject) => {
      const entry = {
        requestId,
        messageId: null,
        chatId: null,
        userId: null,
        options,
        allowCustom,
        multiple,
        selection,
        resolve,
        reject,
        timer: null,
        signal,
        abortHandler: null,
        customPromptMessageId: null,
        macUi: null,
        browserUi: null,
        keepMacUiOpen: keepMacUiOpen || usesSharedMacSession,
      };
      entry.timer = setTimeout(() => {
        this.#finish(requestId, {
          status: "timeout",
          answer: null,
          answers: [],
          source: "timeout",
          custom: false,
          timeoutMs,
        });
      }, remainingMs);
      entry.abortHandler = () => this.#reject(requestId, new Error("request_user_input was cancelled while waiting for the user"));
      signal?.addEventListener("abort", entry.abortHandler, { once: true });
      this.pending.set(requestId, entry);
      const telegramStart = this.#startTelegramUi(entry, {
        question,
        questionHtml,
        heading,
        options,
        allowCustom,
        multiple,
        selection,
      });

      // Preserve the original Telegram-first behavior for callers that have no browser
      // conversation identity. This keeps Telegram-only safety/setup failures fail-closed and
      // ensures the native macOS surface does not win before Telegram has even been published.
      if (!conversationId) {
        void telegramStart.then((telegramStarted) => {
          if (this.pending.get(requestId) !== entry) return;
          const macStarted = this.#startMacUi(entry, {
            title, question, macQuestion, sections, prompt, options, allowCustom, multiSelect: multiple, macSession: sharedMacSession,
            interactionKind, questionIndex, questionCount, expiresAt: startedAt + timeoutMs, content, presentationOnly, contentOnly,
          });
          if (!telegramStarted && !macStarted) this.#reject(requestId, new Error("request_user_input has no available response surface"));
        }).catch((error) => {
          this.#reject(requestId, error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }

      const macStarted = this.#startMacUi(entry, {
        title, question, macQuestion, sections, prompt, options, allowCustom, multiSelect: multiple, macSession: sharedMacSession,
        interactionKind, questionIndex, questionCount, expiresAt: startedAt + timeoutMs, content, presentationOnly, contentOnly,
      });
      const browserStarted = this.#startBrowserUi(entry, {
        conversationId,
        title,
        question: macQuestion || question,
        sections,
        prompt,
        options,
        allowCustom,
        multiSelect: multiple,
        interactionKind,
        questionIndex,
        questionCount,
        expiresAt: startedAt + timeoutMs,
        content,
        presentationOnly,
        contentOnly,
      });
      void telegramStart.then((telegramStarted) => {
        if (telegramStarted || macStarted || browserStarted) return;
        this.#reject(requestId, new Error("request_user_input has no available response surface"));
      }).catch((error) => {
        if (macStarted || browserStarted) return;
        this.#reject(requestId, error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async #startTelegramUi(entry, { question, questionHtml, heading, options, allowCustom, multiple, selection }) {
    try {
      this.#assertConfigured();
      const binding = await this.#ensureReady();
      if (this.pending.get(entry.requestId) !== entry) return false;
      const hasOptions = options.length > 0;
      const replyMarkup = hasOptions
        ? buildOptionKeyboard({ requestId: entry.requestId, options, allowCustom, multiple, selection })
        : {
            // No `selective`: it targets only @mentioned users or the sender of the replied-to
            // message, so in this private chat it stopped the reply box from ever opening.
            force_reply: true,
            input_field_placeholder: "Type your answer…",
          };
      const hint = multiple ? "Tap every option that applies, then press Done." : "";
      const body = questionHtml || [
        heading ? `<b>${escapeHtml(heading)}</b>` : "",
        `<blockquote>${escapeHtml(question)}</blockquote>`,
      ].filter(Boolean).join("\n");
      const sent = await this.#send({
        chatId: binding.chatId,
        html: [body, hint && `<i>${escapeHtml(hint)}</i>`].filter(Boolean).join("\n\n"),
        plain: [heading, question, hint].filter(Boolean).join("\n\n"),
        replyMarkup,
      });
      if (!Number.isInteger(sent?.message_id)) throw new Error("Telegram sendMessage returned no message id");
      if (this.pending.get(entry.requestId) !== entry) {
        void this.#api("editMessageReplyMarkup", {
          chat_id: binding.chatId,
          message_id: sent.message_id,
          reply_markup: { inline_keyboard: [] },
        }, { timeoutMs: 5_000 }).catch(() => {});
        return false;
      }
      entry.messageId = sent.message_id;
      entry.chatId = String(binding.chatId);
      entry.userId = String(binding.userId);
      debugLog("sent", {
        requestId: entry.requestId,
        messageId: sent.message_id,
        hasOptions,
        multiple,
        allowCustom,
        markup: hasOptions ? "inline_keyboard" : "force_reply",
      });
      this.#startPoller();
      return true;
    } catch (error) {
      debugLog("telegram.unavailable", { reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async askMany({ conversationId, questions, signal, timeoutMs = this.timeoutMs, onProgress }) {
    const answers = [];
    const deadlineAt = Date.now() + timeoutMs;
    for (let index = 0; index < questions.length; index += 1) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          return {
            status: "timeout",
            answers,
            timeoutQuestionIndex: index,
            timeoutMs,
          };
        }
        const item = questions[index];
        const manyQuestions = questions.length > 1;
        const result = await this.ask({
          conversationId,
          question: item.question,
          heading: manyQuestions ? `Question ${index + 1} of ${questions.length}` : null,
          macQuestion: item.question,
          title: manyQuestions ? `Question ${index + 1} of ${questions.length}` : "Question",
          options: Array.isArray(item.options) ? item.options : [],
          allowCustom: true,
          multiSelect: Boolean(item.multiple),
          signal,
          timeoutMs: remainingMs,
          keepMacUiOpen: true,
          questionIndex: index,
          questionCount: questions.length,
          content: item.content || null,
          presentationOnly: Boolean(item.presentationOnly),
          contentOnly: Boolean(item.contentOnly),
        });
        if (result.status === "timeout") {
          return {
            status: "timeout",
            answers,
            timeoutQuestionIndex: index,
            timeoutMs,
          };
        }
        answers.push({
          questionIndex: index,
          question: item.question,
          answer: result.answer,
          answers: Array.isArray(result.answers) ? result.answers : [result.answer],
          source: result.source,
          custom: result.custom,
          optionIndex: result.optionIndex,
          optionIndexes: Array.isArray(result.optionIndexes) ? result.optionIndexes : null,
          multiple: Boolean(item.multiple),
          ...(Array.isArray(result.attachments) && result.attachments.length ? { attachments: result.attachments } : {}),
          ...(item.presentationOnly ? { presentationOnly: true } : {}),
          ...(item.contentOnly ? { contentOnly: true } : {}),
        });
        onProgress?.(answers.map((answer) => ({
          ...answer,
          answers: [...answer.answers],
          optionIndexes: Array.isArray(answer.optionIndexes) ? [...answer.optionIndexes] : null,
        })));
    }
    return { status: "answered", answers };
  }

  close() {
    this.sharedMacSession?.close?.();
    this.sharedMacSession = null;
  }

  // Telegram rejects a whole message when its markup will not parse, which would turn a
  // formatting problem into a failed question. Fall back to plain text instead.
  async #send({ chatId, html, plain, replyMarkup }) {
    if (html) {
      try {
        return await this.#api("sendMessage", {
          chat_id: chatId,
          text: html,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        }, { timeoutMs: 10_000 });
      } catch (error) {
        debugLog("html.rejected", { reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return this.#api("sendMessage", {
      chat_id: chatId,
      text: plain,
      reply_markup: replyMarkup,
    }, { timeoutMs: 10_000 });
  }

  #assertConfigured() {
    if (!this.token) {
      throw new Error("Telegram request_user_input is not configured. Add TELEGRAM_BOT_TOKEN to the Local System runtime.env and restart Local System.");
    }
    if (!this.bindingFile) throw new Error("Telegram request_user_input binding path is not configured");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Telegram request_user_input timeout is invalid");
    if (typeof this.fetchImpl !== "function") throw new Error("Telegram request_user_input requires fetch support");
  }

  async #ensureReady() {
    if (this.ready && this.binding) return this.binding;
    if (!this.setupPromise) {
      this.setupPromise = this.#prepare().finally(() => { this.setupPromise = null; });
    }
    return this.setupPromise;
  }

  async #prepare() {
    const updates = await this.#drainBacklog();
    const saved = this.#loadBinding();
    if (saved) {
      this.binding = saved;
    } else {
      const candidates = uniqueStartCandidates(updates);
      if (candidates.length === 0) {
        throw new Error("Telegram bot is not linked yet. Open the bot in Telegram, press Start, then call request_user_input again.");
      }
      if (candidates.length > 1) {
        throw new Error("Telegram bot has Start messages from multiple private users; use a fresh personal bot before enabling request_user_input.");
      }
      this.binding = candidates[0];
      this.#saveBinding(this.binding);
    }
    this.ready = true;
    return this.binding;
  }

  async #drainBacklog() {
    const collected = [];
    let offset;
    for (let page = 0; page < 10; page += 1) {
      const updates = await this.#api("getUpdates", {
        ...(offset == null ? {} : { offset }),
        timeout: 0,
        limit: 100,
        allowed_updates: ["message", "callback_query"],
      }, { timeoutMs: 10_000 });
      if (!Array.isArray(updates)) throw new Error("Telegram getUpdates returned an invalid result");
      collected.push(...updates);
      if (updates.length) offset = Math.max(...updates.map((item) => Number(item.update_id))) + 1;
      if (updates.length < 100) break;
    }
    if (collected.length) this.nextOffset = Math.max(...collected.map((item) => Number(item.update_id))) + 1;
    else this.nextOffset ??= 0;
    return collected;
  }

  #startPoller() {
    if (this.pollingPromise) return;
    this.pollingPromise = this.#pollLoop().finally(() => {
      this.pollingPromise = null;
      if (this.pending.size) this.#startPoller();
    });
  }

  async #pollLoop() {
    let failures = 0;
    while (this.pending.size) {
      let updates;
      try {
        updates = await this.#api("getUpdates", {
          offset: this.nextOffset,
          timeout: POLL_SECONDS,
          limit: 100,
          allowed_updates: ["message", "callback_query"],
        }, { timeoutMs: API_TIMEOUT_MS });
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          for (const requestId of [...this.pending.keys()]) this.#reject(requestId, error);
          return;
        }
        await delay(500 * failures);
        continue;
      }
      if (!Array.isArray(updates)) {
        const error = new Error("Telegram getUpdates returned an invalid result");
        for (const requestId of [...this.pending.keys()]) this.#reject(requestId, error);
        return;
      }
      debugLog("poll", { received: updates.length, pending: this.pending.size, nextOffset: this.nextOffset });
      for (const update of updates) {
        if (Number.isInteger(update?.update_id)) this.nextOffset = Math.max(this.nextOffset || 0, update.update_id + 1);
        await this.#dispatch(update);
      }
    }
  }

  async #dispatch(update) {
    const callback = update?.callback_query;
    if (callback) {
      const match = String(callback.data || "").match(/^ask:([A-Za-z0-9_-]{12}):(custom|done|\d{1,2})$/);
      if (!match) return;
      const [, requestId, rawChoice] = match;
      const entry = this.pending.get(requestId);
      if (!entry) return;
      const authorized = String(callback.from?.id ?? "") === entry.userId
        && String(callback.message?.chat?.id ?? "") === entry.chatId
        && callback.message?.message_id === entry.messageId;
      if (!authorized) {
        void this.#api("answerCallbackQuery", { callback_query_id: callback.id, text: "Not authorized" }, { timeoutMs: 5_000 }).catch(() => {});
        return;
      }
      if (rawChoice === "custom") {
        debugLog("custom.tapped", { requestId, allowCustom: entry.allowCustom, multiple: entry.multiple, messageId: entry.messageId });
        if (!entry.allowCustom) return;
        void this.#api("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "Type your custom answer",
        }, { timeoutMs: 5_000 }).catch(() => {});
        try {
          const prompt = await this.#api("sendMessage", {
            chat_id: entry.chatId,
            text: "Type your custom answer below.",
            reply_to_message_id: entry.messageId,
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Type your custom answer…",
            },
          }, { timeoutMs: 5_000 });
          debugLog("custom.prompt", { requestId, promptMessageId: prompt?.message_id ?? null, stillPending: this.pending.has(requestId) });
          if (Number.isInteger(prompt?.message_id)) {
            if (this.pending.has(requestId)) entry.customPromptMessageId = prompt.message_id;
            else void this.#api("deleteMessage", { chat_id: entry.chatId, message_id: prompt.message_id }, { timeoutMs: 5_000 }).catch(() => {});
          }
        } catch {
          // The original question remains replyable even if the UX prompt cannot be sent.
        }
        return;
      }
      if (rawChoice === "done") {
        if (!entry.multiple) return;
        const chosen = [...entry.selection].sort((a, b) => a - b);
        if (chosen.length === 0) {
          void this.#api("answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Pick at least one option first",
          }, { timeoutMs: 5_000 }).catch(() => {});
          return;
        }
        void this.#api("answerCallbackQuery", { callback_query_id: callback.id, text: "Received" }, { timeoutMs: 5_000 }).catch(() => {});
        const selected = chosen.map((optionIndex) => entry.options[optionIndex]);
        this.#finish(requestId, {
          status: "answered",
          answer: selected.join(", "),
          answers: selected,
          source: "telegram",
          custom: false,
          optionIndex: chosen.length === 1 ? chosen[0] : null,
          optionIndexes: chosen,
        });
        return;
      }
      const index = Number(rawChoice);
      if (!Number.isInteger(index) || index < 0 || index >= entry.options.length) return;
      if (entry.multiple) {
        if (entry.selection.has(index)) entry.selection.delete(index);
        else entry.selection.add(index);
        void this.#api("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: `${entry.selection.has(index) ? "Selected" : "Cleared"}: ${entry.options[index]}`,
        }, { timeoutMs: 5_000 }).catch(() => {});
        void this.#api("editMessageReplyMarkup", {
          chat_id: entry.chatId,
          message_id: entry.messageId,
          reply_markup: buildOptionKeyboard({
            requestId,
            options: entry.options,
            allowCustom: entry.allowCustom,
            multiple: true,
            selection: entry.selection,
          }),
        }, { timeoutMs: 5_000 }).catch(() => {});
        return;
      }
      void this.#api("answerCallbackQuery", { callback_query_id: callback.id, text: "Received" }, { timeoutMs: 5_000 }).catch(() => {});
      this.#finish(requestId, {
        status: "answered",
        answer: entry.options[index],
        answers: [entry.options[index]],
        source: "telegram",
        custom: false,
        optionIndex: index,
        optionIndexes: [index],
      });
      return;
    }

    const message = update?.message;
    if (!message || typeof message.text !== "string") {
      debugLog("update.ignored", { keys: Object.keys(update || {}), hasText: typeof update?.message?.text });
      return;
    }
    debugLog("message", {
      messageId: message.message_id,
      from: message.from?.id,
      chat: message.chat?.id,
      chatType: message.chat?.type,
      replyTo: message.reply_to_message?.message_id ?? null,
      text: String(message.text).slice(0, 60),
      pending: this.pending.size,
    });
    const fromBoundUser = (entry) => String(message.from?.id ?? "") === entry.userId
      && String(message.chat?.id ?? "") === entry.chatId;
    const repliedTo = message.reply_to_message?.message_id;
    let match = null;
    for (const [requestId, entry] of this.pending) {
      if (!fromBoundUser(entry)) continue;
      if (repliedTo === entry.messageId || repliedTo === entry.customPromptMessageId) {
        match = [requestId, entry];
        break;
      }
    }
    if (!match && !repliedTo && !/^\//.test(message.text.trim())) {
      // Telegram only shows a reply box for an explicit reply, so a plain typed message is the
      // natural way to answer. It is unambiguous when exactly one question is waiting.
      const candidates = [...this.pending].filter(([, entry]) => fromBoundUser(entry));
      if (candidates.length === 1) match = candidates[0];
    }
    debugLog("match", match
      ? { requestId: match[0], via: repliedTo ? "reply" : "plain", allowCustom: match[1].allowCustom }
      : { requestId: null, replyTo: repliedTo ?? null, pending: [...this.pending.keys()] });
    if (match) {
      const [requestId, entry] = match;
      if (!entry.allowCustom) return;
      const answer = message.text.trim().slice(0, MAX_CUSTOM_ANSWER_CHARS);
      if (!answer) return;
      this.#finish(requestId, {
        status: "answered",
        answer,
        answers: [answer],
        source: "telegram",
        custom: true,
        optionIndex: null,
        optionIndexes: null,
      });
    }
  }

  #startMacUi(entry, {
    title,
    question,
    macQuestion,
    sections,
    prompt,
    options,
    allowCustom,
    multiSelect,
    macSession,
    interactionKind,
    questionIndex,
    questionCount,
    expiresAt,
    content,
    presentationOnly,
    contentOnly,
  }) {
    const factory = macSession && typeof macSession.ask === "function"
      ? (args) => macSession.ask(args)
      : this.macUiFactory;
    if (typeof factory !== "function") return false;
    let handle;
    try {
      handle = factory({
        requestId: entry.requestId,
        title,
        question,
        macQuestion,
        sections,
        prompt,
        options,
        allowCustom,
        multiSelect,
        interactionKind,
        questionIndex,
        questionCount,
        expiresAt,
        content,
        presentationOnly,
        contentOnly,
      });
    } catch {
      return false;
    }
    if (!handle || typeof handle.promise?.then !== "function") return false;
    entry.macUi = handle;
    Promise.resolve(handle.promise).then((result) => {
      if (result?.status !== "answered") return;
      const answer = String(result.answer || "").trim();
      if (!answer) return;
      const answers = Array.isArray(result.answers) && result.answers.length ? result.answers : [answer];
      const optionIndexes = Array.isArray(result.optionIndexes) && result.optionIndexes.length
        ? result.optionIndexes
        : Number.isInteger(result.optionIndex) ? [result.optionIndex] : null;
      this.#finish(entry.requestId, {
        status: "answered",
        answer,
        answers,
        source: "macos",
        custom: Boolean(result.custom),
        optionIndex: Number.isInteger(result.optionIndex) ? result.optionIndex : null,
        optionIndexes,
        ...(Array.isArray(result.attachments) && result.attachments.length ? { attachments: result.attachments } : {}),
        ...(result.skipped === true ? { skipped: true } : {}),
        ...(result.presentationOnly === true ? { presentationOnly: true } : {}),
        ...(result.contentOnly === true ? { contentOnly: true } : {}),
      });
    }).catch(() => {});
    return true;
  }

  #startBrowserUi(entry, {
    conversationId,
    title,
    question,
    sections,
    prompt,
    options,
    allowCustom,
    multiSelect,
    interactionKind,
    questionIndex,
    questionCount,
    expiresAt,
    content,
    presentationOnly,
    contentOnly,
  }) {
    if (typeof this.browserUiFactory !== "function" || !conversationId) return false;
    let handle;
    try {
      handle = this.browserUiFactory({
        conversationId,
        requestId: entry.requestId,
        kind: interactionKind,
        title,
        question,
        sections,
        prompt,
        options,
        allowCustom,
        multiSelect,
        questionIndex,
        questionCount,
        expiresAt,
        content,
        presentationOnly,
        contentOnly,
      });
    } catch {
      return false;
    }
    if (!handle || typeof handle.promise?.then !== "function") return false;
    entry.browserUi = handle;
    Promise.resolve(handle.promise).then((result) => {
      if (result?.status !== "answered") return;
      this.#finish(entry.requestId, result);
    }).catch(() => {});
    return true;
  }

  #finish(requestId, result) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abortHandler);
    entry.macUi?.close?.({ keepOpen: entry.keepMacUiOpen });
    entry.browserUi?.close?.();
    this.#clearTelegramUi(entry);
    entry.resolve(result);
    return true;
  }

  #reject(requestId, error) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abortHandler);
    entry.macUi?.close?.({ keepOpen: entry.keepMacUiOpen });
    entry.browserUi?.close?.();
    this.#clearTelegramUi(entry);
    entry.reject(error);
    return true;
  }

  #clearTelegramUi(entry) {
    if (!entry.chatId || !Number.isInteger(entry.messageId)) return;
    void this.#api("editMessageReplyMarkup", {
      chat_id: entry.chatId,
      message_id: entry.messageId,
      reply_markup: { inline_keyboard: [] },
    }, { timeoutMs: 5_000 }).catch(() => {});
    if (entry.customPromptMessageId) {
      void this.#api("deleteMessage", {
        chat_id: entry.chatId,
        message_id: entry.customPromptMessageId,
      }, { timeoutMs: 5_000 }).catch(() => {});
    }
  }

  #loadBinding() {
    try {
      const value = JSON.parse(fs.readFileSync(this.bindingFile, "utf8"));
      if (value?.botKey !== botKey(this.token)) return null;
      if (!value.chatId || !value.userId) return null;
      return { chatId: String(value.chatId), userId: String(value.userId) };
    } catch {
      return null;
    }
  }

  #saveBinding(binding) {
    const target = path.resolve(this.bindingFile);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({
      botKey: botKey(this.token),
      chatId: String(binding.chatId),
      userId: String(binding.userId),
      boundAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  async #api(method, payload, { timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || API_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await this.fetchImpl(`${TELEGRAM_API}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
          signal: controller.signal,
        });
      } catch (error) {
        const detail = String(error instanceof Error ? error.message : error).replaceAll(this.token, "[REDACTED]");
        const suffix = controller.signal.aborted ? " timed out" : ` failed: ${detail}`;
        throw new Error(`Telegram ${method}${suffix}`);
      }
      let body;
      try { body = await response.json(); }
      catch { throw new Error(`Telegram ${method} returned a non-JSON response`); }
      if (!response.ok || body?.ok !== true) {
        const description = typeof body?.description === "string" ? body.description : `HTTP ${response.status}`;
        throw new Error(`Telegram ${method} failed: ${description}`);
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function buildOptionKeyboard({ requestId, options, allowCustom, multiple, selection }) {
  const rows = options.map((option, index) => [{
    text: multiple ? `${selection?.has(index) ? "☑️" : "⬜️"} ${option}` : option,
    callback_data: `ask:${requestId}:${index}`,
  }]);
  if (multiple) rows.push([{ text: "✅ Done", callback_data: `ask:${requestId}:done` }]);
  if (allowCustom) rows.push([{ text: "✏️ Custom answer", callback_data: `ask:${requestId}:custom` }]);
  return { inline_keyboard: rows };
}

function uniqueStartCandidates(updates) {
  const candidates = new Map();
  for (const update of updates || []) {
    const message = update?.message;
    if (message?.chat?.type !== "private") continue;
    if (!/^\/start(?:@\w+)?(?:\s|$)/i.test(String(message.text || ""))) continue;
    if (message.from?.is_bot) continue;
    const chatId = message.chat?.id;
    const userId = message.from?.id;
    if (chatId == null || userId == null) continue;
    candidates.set(`${userId}:${chatId}`, { chatId: String(chatId), userId: String(userId) });
  }
  return [...candidates.values()];
}

function botKey(token) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
