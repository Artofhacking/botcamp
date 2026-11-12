import { describe, expect, it } from "vitest";
import {
  formatLinkedChatChannels,
  isMessagingChannelRun,
  messagingDmSurfaceNote,
  resolveSyncChannels,
} from "./messaging-prompts.js";

describe("isMessagingChannelRun", () => {
  const channelBlock = {
    kind: "channel_message" as const,
    provider: "sendblue",
    channelId: "ch-1",
    fromAddress: "+15551234567",
    fromLabel: "Alice",
    text: "hi",
  };

  it("detects channel runs from the source message blocks", () => {
    expect(isMessagingChannelRun("messaging", [channelBlock])).toBe(true);
    expect(isMessagingChannelRun("messaging", [{ kind: "text", text: "hi" }])).toBe(false);
    expect(isMessagingChannelRun("user", [channelBlock])).toBe(false);
    expect(isMessagingChannelRun("messaging", undefined)).toBe(false);
  });
});

describe("sync_channels", () => {
  it("keeps linked channel ids and drops the rest", () => {
    expect(resolveSyncChannels(["Feishu", "weixin", "weixin", "nope"], ["weixin"])).toEqual({
      ok: true,
      channels: ["weixin"],
    });
  });

  it("refuses a request that names nothing linked", () => {
    expect(resolveSyncChannels(["slack"], ["weixin", "feishu"])).toEqual({
      ok: false,
      error: "None of those channels are linked. Linked channels: weixin, feishu.",
    });
    expect(resolveSyncChannels([], [])).toEqual({
      ok: false,
      error: "Name at least one linked chat channel.",
    });
  });

  it("tells the model that a reply stays on its arrival channel", () => {
    expect(messagingDmSurfaceNote()).toContain("sync_channels");
    expect(messagingDmSurfaceNote(false)).not.toContain("sync_channels");
    expect(messagingDmSurfaceNote()).toContain("not copied to the other linked channels");
    expect(formatLinkedChatChannels(["weixin", "feishu"])).toBe(
      "Linked chat channels: WeChat (weixin), Feishu (feishu).",
    );
    expect(formatLinkedChatChannels([])).toBeUndefined();
  });
});
