import fs from "node:fs";
import { z } from "zod";
import { INTERRUPT_CONNECTOR_BUDGET_MS, INTERRUPT_USER_TTL_MS } from "../lib/config.js";
import { currentConversationId, isOpenAiConversation } from "../lib/conversation.js";
import { fail } from "../lib/text.js";
import { questionnaireManager } from "../lib/user-question.js";

const DESCRIPTION = "Request input from the user with optional rich content in Markdown or HTML.";
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_IMAGES = 4;

export function registerInteraction(server) {
  const questionSchema = z.object({
    question: z.string().trim().min(1).max(2_500)
      .describe("Ask the user a question or tell them what to do."),
    options: z.array(z.string().trim().min(1).max(100)).max(10).optional()
      .describe("Optional choices; put the recommended option first when applicable."),
    multiple: z.boolean().optional()
      .describe("Let the user select several options."),
  });

  server.registerTool("request_user_input", {
    title: "Request user input",
    description: DESCRIPTION,
    inputSchema: {
      content: z.string().max(100_000).optional()
        .describe("Rich Markdown or HTML. Local images work in Markdown; local image, video, and audio paths work in HTML."),
      question: questionSchema.optional()
        .describe("One optional question."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => {
    try {
      const normalized = normalizeInterrupt(input);
      if (normalized.error) return fail(normalized.error);
      const conversationId = currentConversationId() || process.env.LOCAL_SYSTEM_CONVERSATION_ID || "local-system";
      const waitTimeoutMs = isOpenAiConversation()
        ? INTERRUPT_CONNECTOR_BUDGET_MS
        : INTERRUPT_USER_TTL_MS;
      const result = await questionnaireManager().ask({
        conversationId,
        questions: normalized.questions,
        signal: extra?.signal,
        waitTimeoutMs,
      });
      if (result.status === "waiting") {
        const requiredNextAction = {
          tool: "request_user_input",
          arguments: {},
          repeat_while_status: "waiting",
        };
        const summary = `USER INPUT REQUEST STILL ACTIVE (request_id: ${result.request_id}). Required next action: immediately call request_user_input({}) again. Repeat while status is waiting; do not return to the user yet.`;
        return buildInterruptResult(summary, {
          ...result,
          required_next_action: requiredNextAction,
        }, result.answers);
      }
      if (result.status === "expired") {
        const summary = `No user response within ${Math.ceil(result.timeout_ms / 1_000)} seconds.`;
        return buildInterruptResult(summary, { ...result }, result.answers);
      }
      if (result.status === "failed") {
        const summary = `request_user_input failed (request_id: ${result.request_id}): ${result.error}`;
        return buildInterruptResult(summary, { ...result }, result.answers, { isError: true });
      }
      const visibleAnswers = result.answers.filter((answer) => (
        !answer.presentationOnly && !(answer.contentOnly && answer.answer === "Continue")
      ));
      const summary = visibleAnswers.length === 0
        ? "User continued."
        : `User answered: ${visibleAnswers[0].answer}`;
      return buildInterruptResult(summary, { ...result }, result.answers);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
}

export function normalizeInterrupt(input = {}) {
  const hasContent = typeof input.content === "string" && input.content.trim().length > 0;
  if (input.question === undefined && !hasContent) return { questions: undefined };

  if (input.question !== undefined) {
    const item = input.question;
    if (typeof item?.question !== "string" || !item.question.trim()) {
      return { error: "request_user_input needs question text" };
    }
    const options = Array.isArray(item.options) ? item.options : [];
    if (new Set(options).size !== options.length) {
      return { error: "request_user_input options must be unique" };
    }
    const multiple = Boolean(item.multiple);
    if (multiple && options.length === 0) {
      return { error: "request_user_input multiple requires at least one option" };
    }
    return { questions: [{
      question: item.question,
      options,
      multiple,
      ...(hasContent ? { content: input.content } : {}),
    }] };
  }

  if (hasContent) {
    return { questions: [{
      question: "Continue when ready.",
      options: [],
      multiple: false,
      contentOnly: true,
      content: input.content,
    }] };
  }
  return { questions: undefined };
}

function buildInterruptResult(summary, payload, answers = [], { isError = false } = {}) {
  const attachments = (Array.isArray(answers) ? answers : [])
    .flatMap((answer) => Array.isArray(answer?.attachments) ? answer.attachments : [])
    .filter((attachment) => attachment && typeof attachment.path === "string");
  if (attachments.length) {
    payload.attachments = attachments;
  }

  const text = `${summary}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const result = {
    content: [{ type: "text", text }],
  };
  if (isError) result.isError = true;

  let added = 0;
  for (const attachment of attachments) {
    if (added >= MAX_INLINE_IMAGES || !String(attachment.mimeType || "").startsWith("image/")) continue;
    try {
      const stat = fs.statSync(attachment.path);
      if (!stat.isFile() || stat.size > MAX_INLINE_IMAGE_BYTES) continue;
      result.content.push({
        type: "image",
        data: fs.readFileSync(attachment.path).toString("base64"),
        mimeType: attachment.mimeType,
      });
      added += 1;
    } catch {}
  }
  return result;
}
