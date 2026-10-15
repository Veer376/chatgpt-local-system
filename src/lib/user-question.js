import {
  INTERRUPT_CONNECTOR_BUDGET_MS,
  INTERRUPT_USER_TTL_MS,
  TELEGRAM_BINDING_FILE,
  TELEGRAM_BOT_TOKEN,
} from "./config.js";
import crypto from "node:crypto";
import { TelegramQuestionService } from "./telegram.js";

let sharedQuestionService;
let sharedQuestionnaireManager;

export function userQuestionService() {
  sharedQuestionService ||= new TelegramQuestionService({
    token: TELEGRAM_BOT_TOKEN,
    bindingFile: TELEGRAM_BINDING_FILE,
    timeoutMs: INTERRUPT_USER_TTL_MS,
  });
  return sharedQuestionService;
}

export function questionnaireManager() {
  sharedQuestionnaireManager ||= new UserQuestionnaireManager();
  return sharedQuestionnaireManager;
}

export class UserQuestionnaireManager {
  constructor({
    serviceFactory = userQuestionService,
    waitTimeoutMs = INTERRUPT_CONNECTOR_BUDGET_MS,
    questionTimeoutMs = INTERRUPT_USER_TTL_MS,
    terminalRetentionMs = 30 * 60 * 1_000,
    now = Date.now,
    requestIdFactory = () => `interrupt_${crypto.randomBytes(9).toString("base64url")}`,
  } = {}) {
    if (typeof serviceFactory !== "function") throw new Error("request_user_input requires a question service factory");
    if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs <= 0) throw new Error("request_user_input wait timeout is invalid");
    if (!Number.isInteger(questionTimeoutMs) || questionTimeoutMs <= 0) throw new Error("request_user_input question timeout is invalid");
    if (!Number.isInteger(terminalRetentionMs) || terminalRetentionMs <= 0) throw new Error("request_user_input retention timeout is invalid");
    this.serviceFactory = serviceFactory;
    this.waitTimeoutMs = waitTimeoutMs;
    this.questionTimeoutMs = questionTimeoutMs;
    this.terminalRetentionMs = terminalRetentionMs;
    this.now = now;
    this.requestIdFactory = requestIdFactory;
    this.records = new Map();
  }

  async ask({ conversationId, questions, signal, waitTimeoutMs = this.waitTimeoutMs } = {}) {
    const scope = String(conversationId || "").trim();
    if (!scope) throw new Error("request_user_input requires a conversation-scoped request");
    this.#prune();

    const fingerprint = questions ? JSON.stringify(questions) : null;
    let record = this.records.get(scope);
    if (questions) {
      if (record?.state === "pending" && record.fingerprint !== fingerprint) {
        throw new Error(`Another request_user_input interaction is already pending for this conversation (request_id: ${record.requestId})`);
      }
      if (!record || record.state !== "pending") {
        record = this.#start(scope, questions, fingerprint);
      }
    } else if (!record) {
      throw new Error("No request_user_input interaction is available to resume for this conversation");
    }

    return this.#observe(record, signal, waitTimeoutMs);
  }

  #start(scope, questions, fingerprint) {
    let settle;
    const record = {
      requestId: this.requestIdFactory(),
      fingerprint,
      questions,
      answers: [],
      state: "pending",
      result: null,
      finishedAt: null,
      settled: new Promise((resolve) => { settle = resolve; }),
      settle,
    };
    this.records.set(scope, record);

    // The questionnaire deliberately receives no MCP AbortSignal. A cancelled tool call stops
    // only its observer; destructive approvals bypass this manager and remain fail-closed.
    Promise.resolve()
      .then(() => this.serviceFactory().askMany({
        conversationId: scope,
        questions,
        timeoutMs: this.questionTimeoutMs,
        onProgress: (answers) => {
          if (record.state === "pending") record.answers = cloneAnswers(answers);
        },
      }))
      .then(
        (result) => this.#finish(record, result),
        (error) => this.#fail(record, error),
      );
    return record;
  }

  async #observe(record, signal, waitTimeoutMs = this.waitTimeoutMs) {
    if (record.state !== "pending") return cloneResult(record.result);
    const timeout = Number.isInteger(waitTimeoutMs) && waitTimeoutMs > 0 ? waitTimeoutMs : this.waitTimeoutMs;
    const reason = await waitForRecord(record.settled, signal, timeout);
    if (reason === "settled" || record.state !== "pending") return cloneResult(record.result);
    return {
      status: "waiting",
      request_id: record.requestId,
      answers: cloneAnswers(record.answers),
      question_count: record.questions.length,
      answered_count: record.answers.length,
      next_question_index: Math.min(record.answers.length, record.questions.length - 1),
      wait_timeout_ms: timeout,
    };
  }

  #finish(record, result) {
    if (record.state !== "pending") return;
    record.finishedAt = this.now();
    if (result?.status === "answered") {
      record.state = "answered";
      record.result = {
        status: "answered",
        request_id: record.requestId,
        answers: cloneAnswers(result.answers),
        question_count: record.questions.length,
      };
    } else if (result?.status === "timeout") {
      record.state = "expired";
      record.result = {
        status: "expired",
        request_id: record.requestId,
        answers: cloneAnswers(result.answers),
        question_count: record.questions.length,
        timeout_question_index: result.timeoutQuestionIndex,
        timeout_ms: result.timeoutMs,
      };
    } else {
      this.#fail(record, new Error("request_user_input returned an invalid interaction result"));
      return;
    }
    record.settle();
  }

  #fail(record, error) {
    if (record.state !== "pending") return;
    record.state = "failed";
    record.finishedAt = this.now();
    record.result = {
      status: "failed",
      request_id: record.requestId,
      answers: cloneAnswers(record.answers),
      error: error instanceof Error ? error.message : String(error),
    };
    record.settle();
  }

  #prune() {
    const cutoff = this.now() - this.terminalRetentionMs;
    for (const [scope, record] of this.records) {
      if (record.state !== "pending" && record.finishedAt < cutoff) this.records.delete(scope);
    }
  }
}

export function setUserQuestionServiceForTests(service) {
  sharedQuestionService = service;
  sharedQuestionnaireManager = undefined;
}

export function setQuestionnaireManagerForTests(manager) {
  sharedQuestionnaireManager = manager;
}

function waitForRecord(settled, signal, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(reason);
    };
    const onAbort = () => finish("cancelled");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    settled.then(() => finish("settled"));
  });
}

function cloneAnswers(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.map((answer) => ({
    ...answer,
    answers: Array.isArray(answer?.answers) ? [...answer.answers] : answer?.answers,
    optionIndexes: Array.isArray(answer?.optionIndexes) ? [...answer.optionIndexes] : answer?.optionIndexes,
    ...(Array.isArray(answer?.attachments) && answer.attachments.length
      ? { attachments: answer.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  }));
}

function cloneResult(result) {
  return result ? { ...result, answers: cloneAnswers(result.answers) } : null;
}
