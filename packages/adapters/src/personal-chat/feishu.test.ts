import { describe, expect, it, vi } from "vitest";
import type { FeishuSession } from "./feishu.js";
import {
  createFeishuClient,
  decodeFeishuAddons,
  FeishuProtocolError,
  readFeishuDirectMessage,
} from "./feishu.js";

const sdk = vi.hoisted(() => ({
  deliver: undefined as ((data: unknown) => void) | undefined,
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  LoggerLevel: { error: 1 },
  EventDispatcher: class {
    register(handles: Record<string, (data: unknown) => void>) {
      sdk.deliver = handles["im.message.receive_v1"];
      return this;
    }
  },
  WSClient: class {
    start() {
      sdk.deliver?.({
        sender: { sender_type: "user", sender_id: { open_id: "ou_other" } },
        message: {
          message_id: "om_room",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "room" }),
        },
      });
      sdk.deliver?.({
        sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
        message: {
          message_id: "om_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      });
      return Promise.resolve();
    }

    getConnectionStatus() {
      return { state: "connected" };
    }

    close() {}
  },
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function form(init?: RequestInit): URLSearchParams {
  if (!(init?.body instanceof URLSearchParams)) throw new Error("expected a form body");
  return init.body;
}

const session: FeishuSession = {
  kind: "feishu",
  appId: "cli_a1b2c3d4e5f67890",
  appSecret: "secret",
  openBase: "https://open.feishu.cn",
  botOpenId: "ou_bot",
  userOpenId: "ou_user",
};

describe("feishu confirm page", () => {
  it("asks for a personal bot and keeps the requested direct-message access", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = form(init);
      expect(body.get("action")).toBe("begin");
      expect(body.get("archetype")).toBe("PersonalAgent");
      expect(body.get("auth_method")).toBe("client_secret");
      expect(body.get("request_user_info")).toBe("open_id");
      return jsonResponse({
        device_code: "device-1",
        user_code: "user-1",
        verification_uri_complete: "https://open.feishu.cn/page/cli?user_code=user-1",
        expires_in: 600,
        interval: 5,
      });
    });
    const client = createFeishuClient(fetchImpl as typeof fetch);
    const started = await client.begin();
    const page = new URL(started.image);
    expect(page.origin).toBe("https://open.feishu.cn");
    expect(page.searchParams.get("from")).toBe("sdk");
    expect(page.searchParams.get("source")).toBe("node-sdk/botcamp");
    expect(page.searchParams.get("tp")).toBe("sdk");
    expect(page.searchParams.get("name")).toBe("BotCamp");
    expect(decodeFeishuAddons(page.searchParams.get("addons") ?? "")).toEqual({
      scopes: {
        tenant: ["im:message", "im:message:send_as_bot", "im:message.p2p_msg:readonly"],
      },
      events: { items: { tenant: ["im.message.receive_v1"] } },
    });
    expect(started.login).toMatchObject({
      deviceCode: "device-1",
      domain: "https://accounts.feishu.cn",
      intervalMs: 5_000,
    });
    expect(started.expiresInMs).toBe(600_000);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://accounts.feishu.cn/oauth/v1/app/registration",
      expect.anything(),
    );
  });

  it("rejects a confirm page on any other host", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        device_code: "device-1",
        verification_uri_complete: "https://evil.example/page",
      }),
    );
    const client = createFeishuClient(fetchImpl as typeof fetch);
    await expect(client.begin()).rejects.toBeInstanceOf(FeishuProtocolError);
  });
});

describe("feishu confirmation", () => {
  const login = {
    kind: "feishu" as const,
    deviceCode: "device-1",
    domain: "https://accounts.feishu.cn" as const,
    intervalMs: 5_000,
    notBefore: 0,
  };

  it("waits, and does not ask again until the interval has passed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "authorization_pending" }, 400));
    const client = createFeishuClient(fetchImpl as typeof fetch);
    const waiting = await client.poll(login);
    expect(waiting.kind).toBe("wait");
    if (waiting.kind !== "wait") return;
    expect(waiting.login.notBefore).toBeGreaterThan(Date.now());
    await client.poll(waiting.login);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("slows down when asked", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "slow_down" }, 400));
    const client = createFeishuClient(fetchImpl as typeof fetch);
    const waiting = await client.poll(login);
    expect(waiting).toMatchObject({ kind: "wait", login: { intervalMs: 10_000 } });
  });

  it("treats a denied or unknown result as finished or unusable", async () => {
    const denied = vi.fn(async () => jsonResponse({ error: "access_denied" }, 400));
    await expect(createFeishuClient(denied as typeof fetch).poll(login)).resolves.toEqual({
      kind: "expired",
    });
    const broken = vi.fn(async () => jsonResponse({ error: "server_error" }, 400));
    await expect(createFeishuClient(broken as typeof fetch).poll(login)).rejects.toBeInstanceOf(
      FeishuProtocolError,
    );
  });

  it("saves the bot when the person confirms, even if the bot profile is missing", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://accounts.feishu.cn")) {
        return jsonResponse({
          data: {
            client_id: session.appId,
            client_secret: session.appSecret,
            user_info: { open_id: "ou_user", tenant_brand: "feishu" },
          },
        });
      }
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-1", expire: 7200 });
      }
      return jsonResponse({ code: 1, msg: "missing" });
    });
    const client = createFeishuClient(fetchImpl as typeof fetch);
    await expect(client.poll(login)).resolves.toEqual({
      kind: "confirmed",
      session: { ...session, botOpenId: "" },
    });
  });

  it("follows a Lark account onto the Lark hosts", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith("https://accounts.feishu.cn")) {
        return jsonResponse({ user_info: { tenant_brand: "lark", open_id: "ou_user" } });
      }
      if (url.startsWith("https://accounts.larksuite.com")) {
        return jsonResponse({
          client_id: session.appId,
          client_secret: session.appSecret,
          user_info: { tenant_brand: "lark", open_id: "ou_user" },
        });
      }
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-1", expire: 7200 });
      }
      return jsonResponse({ code: 0, bot: { open_id: "ou_bot" } });
    });
    const client = createFeishuClient(fetchImpl as typeof fetch);
    const confirmed = await client.poll(login);
    expect(confirmed).toMatchObject({
      kind: "confirmed",
      session: {
        openBase: "https://open.larksuite.com",
        userOpenId: "ou_user",
        botOpenId: "ou_bot",
      },
    });
    expect(urls[0]).toBe("https://accounts.feishu.cn/oauth/v1/app/registration");
    expect(urls[1]).toBe("https://accounts.larksuite.com/oauth/v1/app/registration");
    expect(urls[2]?.startsWith("https://open.larksuite.com/")).toBe(true);
  });
});

describe("feishu messages", () => {
  it("sends direct text with a cached tenant token", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          app_id: session.appId,
          app_secret: session.appSecret,
        });
        return jsonResponse({ code: 0, tenant_access_token: "t-1", expire: 7200 });
      }
      expect(url).toBe("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t-1");
      const body = JSON.parse(String(init?.body)) as {
        receive_id?: string;
        content?: string;
        msg_type?: string;
      };
      expect(body.receive_id).toBe("ou_user");
      expect(body.msg_type).toBe("text");
      expect(JSON.parse(body.content ?? "")).toEqual({ text: expect.any(String) });
      return jsonResponse({ code: 0, data: { message_id: "om_sent" } });
    });
    const client = createFeishuClient(fetchImpl as typeof fetch);
    await expect(client.sendText(session, "ou_user", "hello")).resolves.toBe("om_sent");
    await expect(client.sendText(session, "ou_user", "again")).resolves.toBe("om_sent");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps a direct text or post, and drops rooms, other people, and the bot", () => {
    const text = {
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_id: "om_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello @_user_1" }),
        mentions: [{ key: "@_user_1", name: "Ada" }],
      },
    };
    expect(readFeishuDirectMessage(text, "ou_user", "ou_bot")).toEqual({
      handle: "om_1",
      from: "ou_user",
      text: "hello @Ada",
    });
    expect(
      readFeishuDirectMessage(
        {
          sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
          message: {
            message_id: "om_2",
            chat_type: "p2p",
            message_type: "post",
            content: JSON.stringify({
              zh_cn: {
                title: "Note",
                content: [
                  [
                    { tag: "text", text: "see " },
                    { tag: "a", text: "docs", href: "https://example.com" },
                  ],
                ],
              },
            }),
          },
        },
        "",
        "ou_bot",
      ),
    ).toEqual({ handle: "om_2", from: "ou_user", text: "Note\nsee docs (https://example.com)" });
    expect(
      readFeishuDirectMessage(
        { ...text, message: { ...text.message, chat_type: "group" } },
        "",
        "",
      ),
    ).toBeNull();
    expect(readFeishuDirectMessage(text, "ou_other", "ou_bot")).toBeNull();
    expect(
      readFeishuDirectMessage(
        {
          sender: { sender_type: "bot", sender_id: { open_id: "ou_bot" } },
          message: text.message,
        },
        "ou_user",
        "ou_bot",
      ),
    ).toBeNull();
  });

  it("delivers a direct message without waiting for the reply to finish", async () => {
    const client = createFeishuClient(vi.fn() as typeof fetch);
    const controller = new AbortController();
    const seen: string[] = [];
    await client.listen(session, controller.signal, async (message) => {
      seen.push(message.handle);
      controller.abort();
      return new Promise(() => undefined);
    });
    expect(seen).toEqual(["om_1"]);
  });

  it("refuses an app id the long connection cannot use", async () => {
    const client = createFeishuClient(vi.fn() as typeof fetch);
    await expect(
      client.listen(
        { ...session, appId: "not-an-app" },
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(FeishuProtocolError);
  });
});
