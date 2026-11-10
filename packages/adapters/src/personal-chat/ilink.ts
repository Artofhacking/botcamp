import { randomInt, randomUUID } from "node:crypto";

/**
 * Personal-chat bot API used by the QR login flow.
 * The first three version numbers have to stay the channel version the bot
 * service recognizes; our own name only rides in the suffix.
 */
const CHANNEL_VERSION = "3.0.1/botcamp";
const BOT_AGENT = "BotCamp/1";
const CLIENT_VERSION = 196609;
const OFFICIAL_ORIGIN = "https://ilinkai.weixin.qq.com";
const QR_WAIT_MS = 35_000;

export interface IlinkSession {
  token: string;
  accountId: string;
  baseUrl: string;
  userId: string;
  contextTokens: Record<string, string>;
}

export interface IlinkQr {
  qrcode: string;
  image: string;
  baseUrl: string;
}

export type IlinkQrState =
  | { kind: "wait" }
  | { kind: "scanned" }
  | { kind: "need_pin" }
  | { kind: "expired" }
  | { kind: "already" }
  | { kind: "redirect"; baseUrl: string }
  | { kind: "confirmed"; session: IlinkSession };

export interface IlinkInbound {
  handle: string;
  from: string;
  text: string;
  contextToken?: string;
}

export class IlinkPauseError extends Error {
  constructor() {
    super("chat app paused");
    this.name = "IlinkPauseError";
  }
}

export interface IlinkClient {
  fetchQr(): Promise<IlinkQr>;
  pollQr(input: {
    qrcode: string;
    baseUrl: string;
    pin?: string;
    signal?: AbortSignal;
  }): Promise<IlinkQrState>;
  getUpdates(
    session: IlinkSession,
    cursor: string,
    signal: AbortSignal,
  ): Promise<{ messages: IlinkInbound[]; cursor: string }>;
  sendText(
    session: IlinkSession,
    peerId: string,
    text: string,
    contextToken?: string,
  ): Promise<string>;
  notify(session: IlinkSession, started: boolean): Promise<void>;
}

/** Only the bot service's own hosts. A login redirect must not become a request to anywhere else. */
export function personalChatOrigin(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "ilinkai.weixin.qq.com" && !host.endsWith(".weixin.qq.com")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createIlinkClient(fetchImpl: typeof fetch = fetch): IlinkClient {
  return {
    fetchQr: () => fetchQr(fetchImpl),
    pollQr: (input) => pollQr(fetchImpl, input),
    getUpdates: (session, cursor, signal) => getUpdates(fetchImpl, session, cursor, signal),
    sendText: (session, peerId, text, contextToken) =>
      sendText(fetchImpl, session, peerId, text, contextToken),
    notify: (session, started) => notify(fetchImpl, session, started),
  };
}

async function fetchQr(fetchImpl: typeof fetch): Promise<IlinkQr> {
  const payload = await postJson(fetchImpl, OFFICIAL_ORIGIN, "/ilink/bot/get_bot_qrcode?bot_type=3", {
    local_token_list: [],
  });
  const qrcode = text(payload.qrcode);
  const image = text(payload.qrcode_img_content);
  if (!qrcode || !image) throw new Error("Chat app did not return a code");
  return { qrcode, image, baseUrl: OFFICIAL_ORIGIN };
}

async function pollQr(
  fetchImpl: typeof fetch,
  input: { qrcode: string; baseUrl: string; pin?: string; signal?: AbortSignal },
): Promise<IlinkQrState> {
  const origin = personalChatOrigin(input.baseUrl) ?? OFFICIAL_ORIGIN;
  const params = new URLSearchParams({ qrcode: input.qrcode });
  if (input.pin) params.set("verify_code", input.pin);
  let payload: Record<string, unknown>;
  try {
    payload = await getJson(
      fetchImpl,
      origin,
      `/ilink/bot/get_qrcode_status?${params.toString()}`,
      input.signal,
      QR_WAIT_MS,
    );
  } catch (error) {
    if (isAbort(error) && input.signal?.aborted) throw error;
    return { kind: "wait" };
  }
  const status = text(payload.status) ?? "wait";
  if (status.includes("need_verifycode")) return { kind: "need_pin" };
  if (status === "scaned") return { kind: "scanned" };
  if (status === "expired" || status === "verify_code_blocked") return { kind: "expired" };
  if (status === "binded_redirect") return { kind: "already" };
  if (status === "scaned_but_redirect") {
    const redirected = personalChatOrigin(text(payload.redirect_host) ?? "");
    return redirected ? { kind: "redirect", baseUrl: redirected } : { kind: "wait" };
  }
  if (status !== "confirmed") return { kind: "wait" };
  const token = text(payload.bot_token);
  const accountId = text(payload.ilink_bot_id);
  const userId = text(payload.ilink_user_id);
  const baseUrl = personalChatOrigin(text(payload.baseurl) ?? "") ?? origin;
  if (!token || !accountId || !userId) throw new Error("Chat app login did not finish");
  return {
    kind: "confirmed",
    session: { token, accountId, baseUrl, userId, contextTokens: {} },
  };
}

async function getUpdates(
  fetchImpl: typeof fetch,
  session: IlinkSession,
  cursor: string,
  signal: AbortSignal,
): Promise<{ messages: IlinkInbound[]; cursor: string }> {
  const payload = await postJson(
    fetchImpl,
    session.baseUrl,
    "/ilink/bot/getupdates",
    { get_updates_buf: cursor, base_info: baseInfo() },
    session.token,
    signal,
    45_000,
  );
  assertOk(payload);
  const next = text(payload.get_updates_buf) || cursor;
  const messages: IlinkInbound[] = [];
  for (const item of Array.isArray(payload.msgs) ? payload.msgs : []) {
    const message = inbound(item, session.accountId);
    if (message) messages.push(message);
  }
  return { messages, cursor: next };
}

async function sendText(
  fetchImpl: typeof fetch,
  session: IlinkSession,
  peerId: string,
  textBody: string,
  contextToken?: string,
): Promise<string> {
  const clientId = randomUUID();
  const payload = await postJson(
    fetchImpl,
    session.baseUrl,
    "/ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: peerId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: 1, text_item: { text: textBody } }],
      },
      base_info: baseInfo(),
    },
    session.token,
  );
  assertOk(payload);
  return clientId;
}

async function notify(fetchImpl: typeof fetch, session: IlinkSession, started: boolean) {
  const payload = await postJson(
    fetchImpl,
    session.baseUrl,
    started ? "/ilink/bot/msg/notifystart" : "/ilink/bot/msg/notifystop",
    { base_info: baseInfo() },
    session.token,
  );
  assertOk(payload);
}

/** User text only. The bot's own copies, rooms, and media-only items are not a direct message. */
export function inbound(value: unknown, accountId: string): IlinkInbound | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (text(message.group_id)) return null;
  if (message.message_type === 2) return null;
  const from = text(message.from_user_id);
  if (!from || from === accountId) return null;
  const handle = text(message.message_id) || text(message.client_id);
  if (!handle) return null;
  const parts: string[] = [];
  for (const item of Array.isArray(message.item_list) ? message.item_list : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const written =
      row.type === 1
        ? textField(row.text_item, "text")
        : row.type === 3
          ? textField(row.voice_item, "text")
          : undefined;
    if (written) parts.push(written);
  }
  const body = parts.join("\n").trim();
  if (!body) return null;
  const contextToken = text(message.context_token);
  return { handle, from, text: body, ...(contextToken ? { contextToken } : {}) };
}

function textField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return text((value as Record<string, unknown>)[key]);
}

function assertOk(payload: Record<string, unknown>) {
  const ret = number(payload.ret);
  const errcode = number(payload.errcode);
  if (ret === -14 || errcode === -14) throw new IlinkPauseError();
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    throw new Error("Chat app request failed");
  }
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

async function postJson(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const origin = personalChatOrigin(baseUrl) ?? OFFICIAL_ORIGIN;
  return requestJson(fetchImpl, `${origin}${path}`, {
    method: "POST",
    headers: headers(Boolean(token), token),
    body: JSON.stringify(body),
    signal,
    timeoutMs,
  });
}

async function getJson(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const origin = personalChatOrigin(baseUrl) ?? OFFICIAL_ORIGIN;
  return requestJson(fetchImpl, `${origin}${path}`, {
    method: "GET",
    headers: appHeaders(),
    signal,
    timeoutMs,
  });
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<Record<string, unknown>> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), init.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal,
    });
    if (!response.ok) throw new Error("Chat app request failed");
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Chat app request failed");
    }
    return payload as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function headers(authorized: boolean, token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(randomInt(0, 2 ** 32))).toString("base64"),
    ...(authorized && token ? { Authorization: `Bearer ${token}` } : {}),
    ...appHeaders(),
  };
}

function appHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
  };
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isAbort(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}
