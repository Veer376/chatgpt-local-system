import test from "node:test";
import assert from "node:assert/strict";
import { INTERRUPT_CONNECTOR_BUDGET_MS, INTERRUPT_USER_TTL_MS } from "../../src/lib/config.js";
import { runWithConversation, runWithConversationId } from "../../src/lib/conversation.js";
import { setQuestionnaireManagerForTests } from "../../src/lib/user-question.js";
import { normalizeInterrupt, registerInteraction } from "../../src/tools/interaction.js";

test("one structured question preserves choices and multi-select", () => {
  assert.deepEqual(normalizeInterrupt({
    question: { question: "Checks?", options: ["lint", "unit"], multiple: true },
  }), {
    questions: [
      { question: "Checks?", options: ["lint", "unit"], multiple: true },
    ],
  });
});

test("rich content is attached to the question", () => {
  assert.deepEqual(normalizeInterrupt({
    content: "<section><h1>Review this</h1></section>",
    question: { question: "Ship it?", options: ["Yes", "No"] },
  }), {
    questions: [{
      question: "Ship it?",
      options: ["Yes", "No"],
      multiple: false,
      content: "<section><h1>Review this</h1></section>",
    }],
  });
});

test("content-only interrupts hide the synthetic question but keep custom response input", () => {
  assert.deepEqual(normalizeInterrupt({ content: "Important result" }), {
    questions: [{
      question: "Continue when ready.",
      options: [],
      multiple: false,
      contentOnly: true,
      content: "Important result",
    }],
  });
});

test("omitting content and question selects resume mode", () => {
  assert.deepEqual(normalizeInterrupt({}), { questions: undefined });
});

test("invalid question shapes are rejected", () => {
  assert.match(normalizeInterrupt({ question: {} }).error, /needs question text/i);
  assert.match(
    normalizeInterrupt({ question: { question: "Pick some", multiple: true } }).error,
    /multiple requires at least one option/i,
  );
  assert.match(
    normalizeInterrupt({ question: { question: "B?", options: ["x", "x"] } }).error,
    /options must be unique/i,
  );
});

test("the tool resumes the current conversation with an empty call", async () => {
  let received;
  setQuestionnaireManagerForTests({
    async ask(input) {
      received = input;
      return {
        status: "waiting",
        request_id: "interrupt_resume",
        answers: [],
        question_count: 1,
        answered_count: 0,
        next_question_index: 0,
        wait_timeout_ms: 105_000,
      };
    },
  });
  const { definition, handler } = captureTool();
  const signal = new AbortController().signal;
  const result = await runWithConversationId("thread-resume", () => handler({}, { signal }));

  assert.match(definition.description, /rich content/i);
  assert.equal(definition.inputSchema.content.isOptional(), true);
  assert.equal(definition.inputSchema.question.isOptional(), true);
  assert.equal(definition.inputSchema.questions, undefined);
  assert.equal(received.conversationId, "thread-resume");
  assert.equal(received.questions, undefined);
  assert.equal(received.signal, signal);
  assert.equal(received.waitTimeoutMs, INTERRUPT_USER_TTL_MS);
  assert.equal(result.structuredContent, undefined);
  const embedded = JSON.parse(result.content[0].text.match(/```json\n([\s\S]+?)\n```/)[1]);
  assert.equal(embedded.status, "waiting");
  assert.deepEqual(embedded.required_next_action, {
    tool: "request_user_input",
    arguments: {},
    repeat_while_status: "waiting",
  });
  assert.match(result.content[0].text, /user input request still active/i);
  assert.match(result.content[0].text, /do not return to the user yet/i);
  setQuestionnaireManagerForTests(undefined);
});

test("request_user_input applies 75s budget for OpenAI sessions and 5m for other clients", async () => {
  let receivedInput;
  setQuestionnaireManagerForTests({
    async ask(input) {
      receivedInput = input;
      return {
        status: "waiting",
        request_id: "test_timing",
        answers: [],
        question_count: 1,
        answered_count: 0,
        next_question_index: 0,
        wait_timeout_ms: input.waitTimeoutMs,
      };
    },
  });
  const { handler } = captureTool();

  // 1. OpenAI session: gets 75s connector budget
  await runWithConversation({ body: { params: { _meta: { "openai/session": "s-openai" } } } }, () =>
    handler({ question: { question: "Proceed?" } }, {})
  );
  assert.equal(receivedInput.waitTimeoutMs, INTERRUPT_CONNECTOR_BUDGET_MS);
  assert.equal(receivedInput.conversationId, "s-openai");

  // 2. Claude / other provider session: gets 300s (5m) global budget
  await runWithConversation({ body: { params: { _meta: { sessionId: "s-claude" } } } }, () =>
    handler({ question: { question: "Proceed?" } }, {})
  );
  assert.equal(receivedInput.waitTimeoutMs, INTERRUPT_USER_TTL_MS);
  assert.equal(receivedInput.conversationId, "s-claude");

  // 3. Unscoped caller: gets 300s (5m) global budget
  await handler({ question: { question: "Proceed?" } }, {});
  assert.equal(receivedInput.waitTimeoutMs, INTERRUPT_USER_TTL_MS);

  setQuestionnaireManagerForTests(undefined);
});

function captureTool() {
  let definition;
  let handler;
  registerInteraction({
    registerTool(name, registeredDefinition, registeredHandler) {
      assert.equal(name, "request_user_input");
      definition = registeredDefinition;
      handler = registeredHandler;
    },
  });
  return { definition, handler };
}
