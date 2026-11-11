import { gunzipSync, gzipSync } from "node:zlib";

/** A bot the person confirms by scanning. Separate from the deployment-wide webhook bot. */
export const FEISHU_CHAT_PROVIDER = "feishu";

const FEISHU_ACCOUNTS = "https://accounts.feishu.cn";
const LARK_ACCOUNTS = "https://accounts.larksuite.com";
const FEISHU_OPEN = "https://open.feishu.cn";
const LARK_OPEN = "https://open.larksuite.com";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const ADDONS = {
  scopes: {
    tenant: ["im:message", "im:message:send_as_bot", "im:message.p2p_msg:readonly"],
  },
  events: { items: { tenant: ["im.message.receive_v1"] } },
};

export class FeishuProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuProtocolError";
  }
}

export interface FeishuLogin {
  kind: "feishu";
  deviceCode: string;
  domain: typeof FEISHU_ACCOUNTS | typeof LARK_ACCOUNTS;
  intervalMs: number;
  notBefore: number;
  switched?: boolean;
}

export interface FeishuSession {
  kind: "feishu";
  appId: string;
  appSecret: string;
  openBase: typeof FEISHU_OPEN | typeof LARK_OPEN;
  botOpenId: string;
  userOpenId: string;
}

export interface FeishuInbound {
  handle: string;
  from: string;
  text: string;
}

export type FeishuPoll =
  | { kind: "wait"; login: FeishuLogin }
  | { kind: "expired" }
  | { kind: "confirmed"; session: FeishuSession };

export interface FeishuClient {
  begin(): Promise<{ login: FeishuLogin; image: string; expiresInMs: number }>;
  poll(login: FeishuLogin): Promise<FeishuPoll>;
  sendText(session: FeishuSession, peerId: string, text: string): Promise<string>;
  listen(
    session: FeishuSession,
    signal: AbortSignal,
    onMessage: (message: FeishuInbound) => Promise<void>,
  ): Promise<void>;
}

/** Direct text only. Rooms, the bot's own copies, and other people's chats are ignored. */
export function readFeishuDirectMessage(
  data: unknown,
  boundUser: string,
  botOpenId: string,
): FeishuInbound | null {
  if (!data || typeof data !== "object") return null;
  const event = data as {
    sender?: { sender_type?: string; sender_id?: { open_id?: string } };
    message?: {
      message_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: { key?: string; name?: string }[];
    };
  };
  const message = event.message;
  const from = event.sender?.sender_id?.open_id ?? "";
  if (!message?.message_id || !from) return null;
  if (message.chat_type !== "p2p") return null;
  if (event.sender?.sender_type === "bot" || (botOpenId && from === botOpenId)) return null;
  if (boundUser && from !== boundUser) return null;
  const text = messageText(
    message.message_type ?? "",
    message.content ?? "",
    message.mentions ?? [],
  );
  if (!text) return null;
  return { handle: message.message_id, from, text };
}

export function createFeishuClient(fetchImpl: typeof fetch = fetch): FeishuClient {
  const tokens = new Map<string, { token: string; until: number }>();
  return {
    begin: () => begin(fetchImpl),
    poll: (login) => poll(fetchImpl, login, tokens),
    sendText: (session, peerId, text) => sendText(fetchImpl, tokens, session, peerId, text),
    listen: (session, signal, onMessage) => listen(session, signal, onMessage),
  };
}

async function begin(
  fetchImpl: typeof fetch,
): Promise<{ login: FeishuLogin; image: string; expiresInMs: number }> {
  const payload = await postForm(fetchImpl, `${FEISHU_ACCOUNTS}${REGISTRATION_PATH}`, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  const deviceCode = field(payload, "device_code");
  const userCode = field(payload, "user_code");
  const complete = field(payload, "verification_uri_complete");
  const page =
    feishuPage(complete) ??
    (userCode
      ? feishuPage(`${FEISHU_OPEN}/page/cli?user_code=${encodeURIComponent(userCode)}`)
      : null);
  if (!deviceCode || !page) throw new FeishuProtocolError("Feishu did not return a code");
  const image = registrationPage(page);
  const expiresIn = positiveInt(fieldNumber(payload, "expires_in"), 600);
  return {
    login: {
      kind: "feishu",
      deviceCode,
      domain: FEISHU_ACCOUNTS,
      intervalMs: positiveInt(fieldNumber(payload, "interval"), 5) * 1000,
      notBefore: 0,
    },
    image,
    expiresInMs: expiresIn * 1000,
  };
}

async function poll(
  fetchImpl: typeof fetch,
  login: FeishuLogin,
  tokens: Map<string, { token: string; until: number }>,
): Promise<FeishuPoll> {
  if (login.notBefore > Date.now()) return { kind: "wait", login };
  const payload = await postForm(fetchImpl, `${login.domain}${REGISTRATION_PATH}`, {
    action: "poll",
    device_code: login.deviceCode,
  });
  const user = userInfo(payload);
  if (user.tenantBrand === "lark" && login.domain === FEISHU_ACCOUNTS && !login.switched) {
    return poll(
      fetchImpl,
      { ...login, domain: LARK_ACCOUNTS, switched: true, notBefore: 0 },
      tokens,
    );
  }
  const appId = field(payload, "client_id");
  const appSecret = field(payload, "client_secret");
  if (appId && appSecret) {
    const openBase = user.tenantBrand === "lark" ? LARK_OPEN : FEISHU_OPEN;
    let botOpenId = "";
    try {
      botOpenId = await botOpenIdFor(fetchImpl, tokens, openBase, appId, appSecret);
    } catch {
      botOpenId = "";
    }
    return {
      kind: "confirmed",
      session: {
        kind: "feishu",
        appId,
        appSecret,
        openBase,
        botOpenId,
        userOpenId: user.openId,
      },
    };
  }
  const error = field(payload, "error");
  if (error === "access_denied" || error === "expired_token" || error === "invalid_grant") {
    return { kind: "expired" };
  }
  if (error && error !== "authorization_pending" && error !== "slow_down") {
    throw new FeishuProtocolError("Feishu did not finish linking");
  }
  const intervalMs = login.intervalMs + (error === "slow_down" ? 5_000 : 0);
  return {
    kind: "wait",
    login: { ...login, intervalMs, notBefore: Date.now() + intervalMs },
  };
}

async function sendText(
  fetchImpl: typeof fetch,
  tokens: Map<string, { token: string; until: number }>,
  session: FeishuSession,
  peerId: string,
  text: string,
): Promise<string> {
  const token = await tenantToken(
    fetchImpl,
    tokens,
    session.openBase,
    session.appId,
    session.appSecret,
  );
  const payload = await postJson(
    fetchImpl,
    `${session.openBase}/open-apis/im/v1/messages?receive_id_type=open_id`,
    { receive_id: peerId, msg_type: "text", content: JSON.stringify({ text }) },
    token,
  );
  const code = fieldNumber(payload, "code");
  const messageId = nestedString(payload, "data", "message_id");
  if (code !== 0 || !messageId) throw new FeishuProtocolError("Feishu did not accept the message");
  return messageId;
}

async function listen(
  session: FeishuSession,
  signal: AbortSignal,
  onMessage: (message: FeishuInbound) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return;
  if (!/^cli_[0-9a-f]{16}$/i.test(session.appId)) {
    throw new FeishuProtocolError("Feishu app id is not usable");
  }
  const sdk = await import("@larksuiteoapi/node-sdk");
  let finish: ((error?: Error) => void) | undefined;
  const ws = new sdk.WSClient({
    appId: session.appId,
    appSecret: session.appSecret,
    domain: session.openBase,
    loggerLevel: sdk.LoggerLevel.error,
    autoReconnect: true,
    source: "botcamp",
    onError(error: Error) {
      finish?.(error);
    },
  });
  const dispatcher = new sdk.EventDispatcher({}).register({
    "im.message.receive_v1": (data) => {
      const message = readFeishuDirectMessage(data, session.userOpenId, session.botOpenId);
      if (!message) return;
      void onMessage(message).catch(() => undefined);
    },
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      finish = undefined;
      signal.removeEventListener("abort", onAbort);
      ws.close({ force: true });
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => done();
    finish = done;
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void ws
      .start({ eventDispatcher: dispatcher })
      .then(() => {
        if (ws.getConnectionStatus().state === "failed") {
          done(new FeishuProtocolError("Feishu connection failed"));
        }
      })
      .catch((error: unknown) => {
        done(error instanceof Error ? error : new FeishuProtocolError("Feishu connection failed"));
      });
  });
}

function registrationPage(page: string): string {
  const url = new URL(page);
  url.searchParams.set("from", "sdk");
  url.searchParams.set("source", "node-sdk/botcamp");
  url.searchParams.set("tp", "sdk");
  url.searchParams.set("name", "BotCamp");
  url.searchParams.set("addons", encodeAddons(ADDONS));
  const image = feishuPage(url.toString());
  if (!image) throw new FeishuProtocolError("Feishu did not return a code");
  return image;
}

function encodeAddons(addons: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(addons), "utf8"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Test helper: the confirm page decodes this query value. */
export function decodeFeishuAddons(encoded: string): unknown {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return JSON.parse(gunzipSync(Buffer.from(padded + pad, "base64")).toString("utf8"));
}

async function botOpenIdFor(
  fetchImpl: typeof fetch,
  tokens: Map<string, { token: string; until: number }>,
  openBase: string,
  appId: string,
  appSecret: string,
): Promise<string> {
  const token = await tenantToken(fetchImpl, tokens, openBase, appId, appSecret);
  const payload = await getJson(fetchImpl, `${openBase}/open-apis/bot/v3/info`, token);
  if (fieldNumber(payload, "code") !== 0) return "";
  return nestedString(payload, "bot", "open_id");
}

async function tenantToken(
  fetchImpl: typeof fetch,
  tokens: Map<string, { token: string; until: number }>,
  openBase: string,
  appId: string,
  appSecret: string,
): Promise<string> {
  const cached = tokens.get(appId);
  if (cached && cached.until > Date.now()) return cached.token;
  const payload = await postJson(
    fetchImpl,
    `${openBase}/open-apis/auth/v3/tenant_access_token/internal`,
    { app_id: appId, app_secret: appSecret },
  );
  const token = field(payload, "tenant_access_token");
  if (fieldNumber(payload, "code") !== 0 || !token) {
    throw new FeishuProtocolError("Feishu did not grant access");
  }
  const expire = positiveInt(fieldNumber(payload, "expire"), 120);
  tokens.set(appId, { token, until: Date.now() + Math.max(expire - 60, 30) * 1000 });
  return token;
}

function userInfo(payload: Record<string, unknown>): { openId: string; tenantBrand: string } {
  const body = registrationBody(payload);
  const raw = body.user_info ?? payload.user_info;
  if (!raw || typeof raw !== "object") return { openId: "", tenantBrand: "" };
  const info = raw as Record<string, unknown>;
  return {
    openId: typeof info.open_id === "string" ? info.open_id : "",
    tenantBrand: typeof info.tenant_brand === "string" ? info.tenant_brand : "",
  };
}

function messageText(
  type: string,
  content: string,
  mentions: { key?: string; name?: string }[],
): string {
  const replaceMentions = (value: string) => {
    let next = value;
    for (const mention of mentions) {
      if (mention.key) next = next.replaceAll(mention.key, `@${mention.name ?? ""}`);
    }
    return next.trim();
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const record = parsed as Record<string, unknown>;
  if (type === "text" && typeof record.text === "string") return replaceMentions(record.text);
  if (type !== "post") return "";
  const posts = (record.post ?? record) as Record<string, unknown>;
  const post = Array.isArray(posts.content)
    ? posts
    : ((posts.zh_cn ?? posts.en_us ?? Object.values(posts)[0]) as
        | Record<string, unknown>
        | undefined);
  if (!post || typeof post !== "object") return "";
  const rich = post as {
    title?: string;
    content?: { tag?: string; text?: string; href?: string; user_name?: string }[][];
  };
  const lines = (rich.content ?? []).map((row) =>
    row
      .map((item) =>
        item.tag === "a"
          ? `${item.text ?? ""}${item.href ? ` (${item.href})` : ""}`
          : item.tag === "at"
            ? `@${item.user_name ?? ""}`
            : (item.text ?? ""),
      )
      .join(""),
  );
  return replaceMentions([rich.title, ...lines].filter(Boolean).join("\n"));
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(15_000),
  });
  return readJson(response);
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  token?: string,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return readJson(response);
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return readJson(response);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > 1_000_000) throw new FeishuProtocolError("Feishu response was too large");
  try {
    const payload = JSON.parse(text) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new FeishuProtocolError("Feishu response was not usable");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FeishuProtocolError) throw error;
    throw new FeishuProtocolError("Feishu response was not usable");
  }
}

function registrationBody(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    if (record.device_code || record.client_id || record.error || record.user_info) return record;
  }
  return payload;
}

function field(payload: Record<string, unknown>, key: string): string {
  const body = registrationBody(payload);
  const value = body[key] ?? payload[key];
  return typeof value === "string" ? value : "";
}

function fieldNumber(payload: Record<string, unknown>, key: string): number {
  const body = registrationBody(payload);
  const value = body[key] ?? payload[key];
  return typeof value === "number" ? value : 0;
}

function nestedString(payload: Record<string, unknown>, parent: string, key: string): string {
  const value = payload[parent];
  if (!value || typeof value !== "object") return "";
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" ? child : "";
}

function positiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function feishuPage(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (
      host !== "feishu.cn" &&
      !host.endsWith(".feishu.cn") &&
      host !== "larksuite.com" &&
      !host.endsWith(".larksuite.com")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
