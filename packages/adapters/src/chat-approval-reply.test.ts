import type { AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { ChatApprovalClassifyInput } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { approvalPauseBlocks, createChatApprovalReplyClassifier } from "./chat-approval-reply.js";

const input: ChatApprovalClassifyInput = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  runId: "run-1",
  request: "Review before send mail\n\nTo Ada",
  reply: "同意",
};

const configured = { OPENROUTER_API_KEY: "test-key" };

function runtimeReturning(text: string, extra: AgentRuntimeEvent[] = []): AgentRuntime {
  return {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { streaming: false, compaction: false, tools: false, scripted: true },
    }),
    abort: async () => undefined,
    run: async function* () {
      for (const event of extra) yield event;
      yield { type: "done", text };
    },
  };
}

describe("chat approval reply classifier", () => {
  it("does not call a model when the deployment has none", async () => {
    const run = vi.fn();
    const classify = createChatApprovalReplyClassifier({
      runtime: { run } as unknown as AgentRuntime,
      env: {},
    });
    expect(await classify(input)).toBe("not_an_answer");
    expect(run).not.toHaveBeenCalled();
  });

  it("maps a confident checker result and records its usage apart from the run", async () => {
    const onUsage = vi.fn(async () => undefined);
    const classify = createChatApprovalReplyClassifier({
      runtime: runtimeReturning('{"choice":"allow_once","confidence":0.91}', [
        {
          type: "usage",
          provider: "openrouter",
          model: "openai/gpt-6-luna",
          inputTokens: 12,
          outputTokens: 4,
          operationKind: "answer",
        },
      ]),
      env: configured,
      onUsage,
    });
    expect(await classify(input)).toBe("allow_once");
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "usage", inputTokens: 12 }),
      expect.objectContaining({
        runId: "run-1",
        operationId: "chat-approval:run-1",
        operationKind: "setup",
      }),
    );
  });

  it("fails closed when the checker errors or runs out of time", async () => {
    const broken = createChatApprovalReplyClassifier({
      runtime: {
        ...runtimeReturning(""),
        run: () => {
          throw new Error("checker down");
        },
      },
      env: configured,
    });
    expect(await broken(input)).toBe("not_an_answer");

    const hanging = createChatApprovalReplyClassifier({
      runtime: {
        ...runtimeReturning(""),
        run: (_request, context) =>
          (async function* () {
            await new Promise((_resolve, reject) => {
              const signal = context?.signal;
              if (!signal) {
                reject(new Error("missing signal"));
                return;
              }
              const fail = () => reject(signal.reason ?? new Error("aborted"));
              if (signal.aborted) fail();
              else signal.addEventListener("abort", fail, { once: true });
            });
            yield { type: "done" as const, text: '{"choice":"allow_once","confidence":1}' };
          })(),
      },
      env: configured,
      timeoutMs: 200,
    });
    expect(await hanging(input)).toBe("not_an_answer");
  });
});

describe("approval pause text", () => {
  const ask = {
    kind: "ask" as const,
    approvalEffectId: "effect-1",
    text: "Review before send mail",
    detail: "token sk-live-secret",
    status: "pending" as const,
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  };

  it("adds the reply hint on a chat channel and hides secret values", () => {
    const blocks = approvalPauseBlocks(ask, {
      plainTextChannel: true,
      appOnly: false,
      secrets: ["sk-live-secret"],
    });
    expect(blocks[0]).toEqual({
      kind: "text",
      text: "Review before send mail\n\ntoken [redacted]\n\nReply yes or 同意 to allow this once, or no or 拒绝 to deny it.",
    });
    expect(blocks[1]).toBe(ask);
    expect(JSON.stringify(blocks[0])).not.toContain("sk-live-secret");
  });

  it("leaves an app card as the card alone", () => {
    expect(
      approvalPauseBlocks(ask, { plainTextChannel: false, appOnly: false, secrets: [] }),
    ).toEqual([ask]);
  });

  it("tells a computer request to be answered in the app", () => {
    const blocks = approvalPauseBlocks(
      { ...ask, text: "Run on your computer?", detail: undefined },
      { plainTextChannel: true, appOnly: true, secrets: [] },
    );
    expect(blocks[0]).toEqual({
      kind: "text",
      text: "Run on your computer?\n\nAnswer this in the app. A message here cannot allow it.",
    });
    expect(JSON.stringify(blocks[0])).not.toContain("Reply yes");
  });
});
