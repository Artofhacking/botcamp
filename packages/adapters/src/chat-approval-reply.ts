import type { AgentRuntime, AgentRuntimeEvent } from "@botcamp/adapter-kit";
import type { MessageBlock } from "@botcamp/contracts";
import type { ChatApprovalChoice, ChatApprovalClassifyInput } from "@botcamp/core";
import {
  buildChatApprovalReplyPrompt,
  CHAT_APPROVAL_REPLY_RUBRIC,
  chatApprovalNotice,
  parseChatApprovalReply,
  redactSecrets,
} from "@botcamp/core";
import { autoReviewTimeoutMs } from "./auto-review.js";
import { formatCurrentTimeInstruction } from "./current-time.js";
import { resolveDeploymentModel } from "./deployment-model.js";

export type ChatApprovalUsage = (
  event: Extract<AgentRuntimeEvent, { type: "usage" }>,
  attribution: {
    spaceId: string;
    userId: string;
    botId: string;
    runId: string;
    parentRunId: string;
    operationId: string;
    operationKind: "setup";
  },
) => Promise<unknown>;

/**
 * The card stays for the app. A chat channel also gets the question as text,
 * because the card itself is not delivered.
 */
export function approvalPauseBlocks(
  ask: MessageBlock,
  options: { plainTextChannel: boolean; appOnly: boolean; secrets: readonly string[] },
): MessageBlock[] {
  if (!options.plainTextChannel || ask.kind !== "ask") return [ask];
  const notice = redactSecrets(
    chatApprovalNotice({ title: ask.text, detail: ask.detail, appOnly: options.appOnly }),
    options.secrets,
  );
  return [{ kind: "text", text: notice }, ask];
}

export function createChatApprovalReplyClassifier(options: {
  runtime: AgentRuntime;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onUsage?: ChatApprovalUsage;
}): (input: ChatApprovalClassifyInput) => Promise<ChatApprovalChoice> {
  const env = options.env ?? process.env;
  return (input) =>
    judgeChatApprovalReply(options.runtime, env, options.timeoutMs, options.onUsage, input);
}

async function judgeChatApprovalReply(
  runtime: AgentRuntime,
  env: NodeJS.ProcessEnv,
  timeoutMs: number | undefined,
  onUsage: ChatApprovalUsage | undefined,
  input: ChatApprovalClassifyInput,
): Promise<ChatApprovalChoice> {
  const deployment = resolveDeploymentModel(env);
  // No deployment model means we cannot judge. Leave the approval pending.
  if (!deployment.configured) return "not_an_answer";
  const limit = timeoutMs ?? autoReviewTimeoutMs(env);
  const timeoutSignal = AbortSignal.timeout(limit);
  const signal = timeoutSignal;
  let text = "";
  let failed = false;
  const record = async (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => {
    await onUsage?.(event, {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      runId: input.runId,
      parentRunId: input.runId,
      operationId: `chat-approval:${input.runId}`,
      operationKind: "setup",
    });
  };
  try {
    for await (const event of runtime.run(
      {
        botId: input.botId,
        threadId: input.threadId,
        runId: `${input.runId}:chat-approval`,
        usageOperationKind: "setup",
        onUsage: record,
        prompt: buildChatApprovalReplyPrompt({ request: input.request, reply: input.reply }),
        instructions: [
          formatCurrentTimeInstruction(),
          `You classify one chat reply under ${CHAT_APPROVAL_REPLY_RUBRIC}. Output strict JSON only. No tools. No markdown.`,
        ].join(" "),
        history: [],
        tools: [],
        model: {
          provider: deployment.provider,
          id: deployment.model,
          apiKey: deployment.key,
          baseUrl: deployment.baseUrl,
        },
      },
      {
        operationId: `chat-approval:${input.runId}`,
        traceId: `chat-approval:${input.runId}`,
        spaceId: input.spaceId,
        userId: input.userId,
        signal,
      },
    )) {
      if (event.type === "usage" && !event.accounted) await record(event);
      if (
        event.type === "text" &&
        /^(?:I hit a problem:|Unknown model )/i.test(event.text.trim())
      ) {
        failed = true;
      }
      if (event.type === "done" && event.text) {
        const body = event.text.trim();
        if (/^(?:I hit a problem:|Unknown model )/i.test(body)) failed = true;
        else text = body;
      }
    }
  } catch {
    return "not_an_answer";
  }
  if (failed || !text) return "not_an_answer";
  return parseChatApprovalReply(text);
}
