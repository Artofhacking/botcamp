import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createIlinkClient, inbound, personalChatOrigin } from "./ilink.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("personal chat origin", () => {
  it("keeps the bot service hosts and rejects anything else", () => {
    expect(personalChatOrigin("https://ilinkai.weixin.qq.com/path")).toBe(
      "https://ilinkai.weixin.qq.com",
    );
    expect(personalChatOrigin("acct.weixin.qq.com")).toBe("https://acct.weixin.qq.com");
    expect(personalChatOrigin("https://evil.example")).toBeNull();
    expect(personalChatOrigin("http://ilinkai.weixin.qq.com")).toBeNull();
  });
});

describe("personal chat login", () => {
  it("asks for a code and reads the picture", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("AuthorizationType")).toBe("ilink_bot_token");
      expect(headers.get("Authorization")).toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({ local_token_list: [] });
      return jsonResponse({ qrcode: "code-1", qrcode_img_content: "data:image/png;base64,aaa" });
    });
    const client = createIlinkClient(fetchImpl as typeof fetch);
    await expect(client.fetchQr()).resolves.toEqual({
      qrcode: "code-1",
      image: "data:image/png;base64,aaa",
      baseUrl: "https://ilinkai.weixin.qq.com",
    });
  });

  it("saves a confirmed login and sends the phone number on the next check", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.searchParams.get("verify_code") === "2468") {
        return jsonResponse({
          status: "confirmed",
          bot_token: "token-1",
          ilink_bot_id: "bot-1",
          ilink_user_id: "user-1",
          baseurl: "https://acct.weixin.qq.com/ignored",
        });
      }
      return jsonResponse({ status: "confirmed_but_need_verifycode" });
    });
    const client = createIlinkClient(fetchImpl as typeof fetch);
    await expect(
      client.pollQr({ qrcode: "code-1", baseUrl: "https://ilinkai.weixin.qq.com" }),
    ).resolves.toEqual({ kind: "need_pin" });
    await expect(
      client.pollQr({ qrcode: "code-1", baseUrl: "https://ilinkai.weixin.qq.com", pin: "2468" }),
    ).resolves.toMatchObject({
      kind: "confirmed",
      session: {
        token: "token-1",
        accountId: "bot-1",
        userId: "user-1",
        baseUrl: "https://acct.weixin.qq.com",
      },
    });
  });

  it("treats a dropped status check as still waiting", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "AbortError" });
    });
    const client = createIlinkClient(fetchImpl as typeof fetch);
    await expect(
      client.pollQr({ qrcode: "code-1", baseUrl: "https://ilinkai.weixin.qq.com" }),
    ).resolves.toEqual({ kind: "wait" });
  });
});

describe("personal chat messages", () => {
  const session = {
    token: "token-1",
    accountId: "bot-1",
    baseUrl: "https://ilinkai.weixin.qq.com",
    userId: "user-1",
    contextTokens: { "user-1": "ctx-1" },
  };

  it("keeps direct text and a voice transcript, and drops the bot's own copies", () => {
    expect(
      inbound(
        {
          message_id: 9,
          message_type: 1,
          from_user_id: "user-1",
          context_token: "ctx-2",
          item_list: [{ type: 1, text_item: { text: "hello" } }],
        },
        "bot-1",
      ),
    ).toEqual({ handle: "9", from: "user-1", text: "hello", contextToken: "ctx-2" });
    expect(
      inbound(
        {
          message_id: 10,
          message_type: 1,
          from_user_id: "user-1",
          item_list: [{ type: 3, voice_item: { text: "spoken" } }],
        },
        "bot-1",
      )?.text,
    ).toBe("spoken");
    expect(inbound({ message_id: 11, message_type: 2, from_user_id: "bot-1" }, "bot-1")).toBeNull();
    expect(
      inbound(
        { message_id: 12, message_type: 1, from_user_id: "user-1", group_id: "room" },
        "bot-1",
      ),
    ).toBeNull();
    expect(
      inbound(
        {
          message_id: 13,
          message_type: 1,
          from_user_id: "user-1",
          item_list: [
            {
              type: 2,
              image_item: {
                aeskey: "00112233445566778899aabbccddeeff",
                media: {
                  encrypt_query_param: "query-1",
                  full_url: "https://evil.example/picture",
                },
              },
            },
          ],
        },
        "bot-1",
      ),
    ).toMatchObject({
      handle: "13",
      text: "",
      imageRefs: [{ query: "query-1" }],
    });
  });

  it("downloads a picture from the chat cdn and ignores any other address", async () => {
    const plain = Buffer.from([
      0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
      0xcc,
    ]);
    const key = Buffer.alloc(16, 7);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).endsWith("/ilink/bot/getupdates")) {
        return jsonResponse({
          ret: 0,
          get_updates_buf: "cursor-2",
          msgs: [
            {
              message_id: 14,
              message_type: 1,
              from_user_id: "user-1",
              item_list: [
                {
                  type: 2,
                  image_item: {
                    aeskey: key.toString("hex"),
                    media: {
                      encrypt_query_param: "query-1",
                      full_url: "https://evil.example/picture",
                    },
                  },
                },
              ],
            },
            {
              message_id: 15,
              message_type: 1,
              from_user_id: "user-1",
              item_list: [
                {
                  type: 2,
                  image_item: {
                    aeskey: "ffffffffffffffffffffffffffffffff",
                    media: { encrypt_query_param: "query-2" },
                  },
                },
              ],
            },
          ],
        });
      }
      return new Response(encrypted, { status: 200 });
    });
    const client = createIlinkClient(fetchImpl as typeof fetch);
    const update = await client.getUpdates(session, "cursor-1", new AbortController().signal);
    expect(update.messages[0]).toMatchObject({
      handle: "14",
      text: "",
      images: [{ name: "photo.jpg", mimeType: "image/jpeg" }],
    });
    expect(Buffer.from(update.messages[0]?.images?.[0]?.bytes ?? [])).toEqual(plain);
    expect(update.messages[1]).toMatchObject({ handle: "15", text: "", imageFailed: true });
    expect(update.messages[1]?.images).toBeUndefined();
    expect(urls.filter((url) => url.includes("evil.example"))).toEqual([]);
    expect(
      urls.some((url) => url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/download?")),
    ).toBe(true);
  });

  it("polls with the saved cursor and replies with the context token", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer token-1");
      if (String(url).endsWith("/ilink/bot/getupdates")) {
        return jsonResponse({
          ret: 0,
          get_updates_buf: "cursor-2",
          msgs: [
            {
              message_id: 3,
              message_type: 1,
              from_user_id: "user-1",
              item_list: [{ type: 1, text_item: { text: "ping" } }],
            },
          ],
        });
      }
      return jsonResponse({ ret: 0 });
    });
    const client = createIlinkClient(fetchImpl as typeof fetch);
    await expect(
      client.getUpdates(session, "cursor-1", new AbortController().signal),
    ).resolves.toEqual({
      cursor: "cursor-2",
      messages: [{ handle: "3", from: "user-1", text: "ping" }],
    });
    await expect(client.sendText(session, "user-1", "pong", "ctx-1")).resolves.toEqual(
      expect.any(String),
    );
    expect(bodies[0]).toMatchObject({
      get_updates_buf: "cursor-1",
      base_info: { channel_version: "3.0.1/botcamp", bot_agent: "BotCamp/1" },
    });
    expect(bodies[1]).toMatchObject({
      msg: {
        to_user_id: "user-1",
        message_type: 2,
        context_token: "ctx-1",
        item_list: [{ type: 1, text_item: { text: "pong" } }],
      },
    });
  });

  it("pauses the account when the service asks", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: -14 }));
    const client = createIlinkClient(fetchImpl as typeof fetch);
    await expect(client.getUpdates(session, "", new AbortController().signal)).rejects.toThrow(
      "chat app paused",
    );
  });
});
