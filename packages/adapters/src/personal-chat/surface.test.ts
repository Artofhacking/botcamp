import type { MessagingSurface } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { parsePersonalChatThreadId, personalChatThreadId } from "./bridge.js";
import { PersonalChatSurface } from "./surface.js";

describe("personal chat threads", () => {
  it("round-trips an account and the person, including a colon in the person id", () => {
    const threadId = personalChatThreadId("acct", "user:1");
    expect(parsePersonalChatThreadId(threadId)).toEqual({
      provider: "weixin",
      accountId: "acct",
      peerId: "user:1",
    });
    expect(parsePersonalChatThreadId(personalChatThreadId("cli_app", "ou_user", "feishu"))).toEqual(
      {
        provider: "feishu",
        accountId: "cli_app",
        peerId: "ou_user",
      },
    );
    expect(parsePersonalChatThreadId("slack:C1")).toBeNull();
  });
});

describe("personal chat surface", () => {
  it("sends personal-chat replies itself and leaves other apps on the fallback", async () => {
    const send = vi.fn(async () => ({ handle: "sent-1" }));
    const fallbackSend = vi.fn(async () => ({ handle: "other" }));
    const surface = new PersonalChatSurface(
      { send } as unknown as ConstructorParameters<typeof PersonalChatSurface>[0],
      { sendToThread: fallbackSend, platforms: () => [] } as unknown as MessagingSurface,
    );
    await expect(
      surface.sendToThread(
        { threadId: personalChatThreadId("acct", "user-1"), body: "hi" },
        {} as never,
      ),
    ).resolves.toEqual({ handle: "sent-1" });
    expect(send).toHaveBeenCalledWith(personalChatThreadId("acct", "user-1"), "hi");
    await surface.sendToThread({ threadId: "slack:C1", body: "there" }, {} as never);
    expect(fallbackSend).toHaveBeenCalled();
    expect(surface.platforms()).toEqual([]);
  });
});
