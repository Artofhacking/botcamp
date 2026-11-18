import type { MessagingSurface } from "@botcamp/adapter-kit";
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
    expect(surface.platforms()).toEqual([
      { provider: "weixin", capabilities: { direct: true, groups: false, receipt: "typing" } },
    ]);
  });

  it("shows and clears the WeChat typing bubble but no other chat app's", async () => {
    const startTyping = vi.fn(async () => undefined);
    const stopTyping = vi.fn(async () => undefined);
    const fallbackAcknowledge = vi.fn(async () => undefined);
    const fallbackStop = vi.fn(async () => undefined);
    const surface = new PersonalChatSurface(
      { startTyping, stopTyping } as unknown as ConstructorParameters<
        typeof PersonalChatSurface
      >[0],
      {
        platforms: () => [],
        acknowledge: fallbackAcknowledge,
        stopTyping: fallbackStop,
      } as unknown as MessagingSurface,
    );

    await surface.acknowledge(personalChatThreadId("acct", "user-1"), "h-1", {} as never);
    await surface.stopTyping(personalChatThreadId("acct", "user-1"), {} as never);
    expect(startTyping).toHaveBeenCalledWith(personalChatThreadId("acct", "user-1"));
    expect(stopTyping).toHaveBeenCalledWith(personalChatThreadId("acct", "user-1"));
    expect(fallbackAcknowledge).not.toHaveBeenCalled();

    const feishu = personalChatThreadId("cli_app", "ou_user", "feishu");
    await surface.acknowledge(feishu, "h-2", {} as never);
    await surface.stopTyping(feishu, {} as never);
    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(fallbackAcknowledge).not.toHaveBeenCalled();
    expect(fallbackStop).not.toHaveBeenCalled();

    await surface.acknowledge("slack:C1", "h-3", {} as never);
    await surface.stopTyping("slack:C1", {} as never);
    expect(fallbackAcknowledge).toHaveBeenCalledWith("slack:C1", "h-3", {} as never);
    expect(fallbackStop).toHaveBeenCalledWith("slack:C1", {} as never);
  });
});
