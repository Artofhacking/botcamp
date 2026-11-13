import { createHash, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";

const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETURN_KEY = /^[a-z0-9-]{1,40}$/;
const HANDOFF_TTL_MS = 3 * 60_000;
const MAX_RETURNS = 8;

type HandoffRecord = {
  secretHash: string;
  returns: Record<string, string>;
  claimed?: { to: string; token?: string; error?: string };
};

function identifier(nonce: string) {
  return `desktop-handoff:${nonce}`;
}

function secretHash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function sameSecret(stored: string, given: string) {
  const actual = Buffer.from(secretHash(given));
  const expected = Buffer.from(stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function acceptedReturn(value: string, webOrigin: string) {
  let target: URL;
  let allowed: URL;
  try {
    target = new URL(value);
    allowed = new URL(webOrigin);
  } catch {
    return false;
  }
  return (
    !target.username &&
    !target.password &&
    target.origin === allowed.origin &&
    (target.protocol === "https:" || target.protocol === "http:") &&
    value.length <= 2048
  );
}

function parseRecord(value: string): HandoffRecord | null {
  try {
    const parsed = JSON.parse(value) as HandoffRecord;
    if (!parsed || typeof parsed.secretHash !== "string" || !parsed.returns) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sessionToken(cookie: string | null) {
  if (!cookie || cookie.length > 8192) return null;
  const match = cookie.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  const token = match?.[1];
  if (!token || token.length > 4096 || !token.includes(".")) return null;
  try {
    return decodeURIComponent(token);
  } catch {
    return null;
  }
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

/** The system browser lands here, then the desktop app reads the session once. */
export function desktopHandoff(webOrigin: string): BetterAuthPlugin {
  return {
    id: "desktop-handoff",
    endpoints: {
      desktopHandoffStart: createAuthEndpoint(
        "/desktop-handoff/start",
        { method: "POST" },
        async (ctx) => {
          const body = (ctx.body ?? {}) as {
            nonce?: unknown;
            pollSecret?: unknown;
            returns?: unknown;
          };
          const nonce = typeof body.nonce === "string" ? body.nonce : "";
          const pollSecret = typeof body.pollSecret === "string" ? body.pollSecret : "";
          if (!NONCE.test(nonce) || !NONCE.test(pollSecret)) {
            throw new APIError("BAD_REQUEST", { message: "Invalid handoff" });
          }
          const returns: Record<string, string> = {};
          if (!body.returns || typeof body.returns !== "object" || Array.isArray(body.returns)) {
            throw new APIError("BAD_REQUEST", { message: "Invalid handoff" });
          }
          for (const [key, value] of Object.entries(body.returns)) {
            if (!RETURN_KEY.test(key) || typeof value !== "string" || !acceptedReturn(value, webOrigin)) {
              throw new APIError("BAD_REQUEST", { message: "Invalid handoff" });
            }
            returns[key] = value;
          }
          if (Object.keys(returns).length === 0 || Object.keys(returns).length > MAX_RETURNS) {
            throw new APIError("BAD_REQUEST", { message: "Invalid handoff" });
          }
          const adapter = ctx.context.internalAdapter;
          const existing = await adapter.findVerificationValue(identifier(nonce));
          const previous = existing ? parseRecord(existing.value) : null;
          if (previous && !sameSecret(previous.secretHash, pollSecret)) {
            throw new APIError("CONFLICT", { message: "Handoff already started" });
          }
          if (existing) await adapter.deleteVerificationByIdentifier(identifier(nonce));
          await adapter.createVerificationValue({
            identifier: identifier(nonce),
            value: JSON.stringify({ secretHash: secretHash(pollSecret), returns } satisfies HandoffRecord),
            expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
          });
          return ctx.json({ ok: true });
        },
      ),
      desktopHandoff: createAuthEndpoint("/desktop-handoff", { method: "GET" }, async (ctx) => {
        const url = new URL(ctx.request?.url ?? "http://localhost/");
        const nonce = url.searchParams.get("nonce") ?? "";
        const to = url.searchParams.get("to") ?? "";
        const error = url.searchParams.get("error") ?? "";
        if (!NONCE.test(nonce) || !RETURN_KEY.test(to) || error.length > 200) {
          throw new APIError("BAD_REQUEST", { message: "Invalid handoff" });
        }
        const adapter = ctx.context.internalAdapter;
        const row = await adapter.findVerificationValue(identifier(nonce));
        const record = row ? parseRecord(row.value) : null;
        const returnTo = record?.returns[to];
        if (!record || !returnTo || row!.expiresAt.getTime() <= Date.now()) {
          throw new APIError("BAD_REQUEST", { message: "Invalid handoff" });
        }
        if (!record.claimed) {
          const session = await getSessionFromCtx(ctx).catch(() => null);
          const token = sessionToken(ctx.headers?.get("cookie") ?? null);
          if (!session || !token) {
            if (!error) throw new APIError("BAD_REQUEST", { message: "Invalid handoff" });
            record.claimed = { to, error };
          } else {
            record.claimed = { to, token, ...(error ? { error } : {}) };
          }
          await adapter.deleteVerificationByIdentifier(identifier(nonce));
          await adapter.createVerificationValue({
            identifier: identifier(nonce),
            value: JSON.stringify(record),
            expiresAt: row!.expiresAt,
          });
        }
        const open = new URL("botcamp://sso");
        open.searchParams.set("nonce", nonce);
        open.searchParams.set("returnTo", returnTo);
        if (record.claimed?.error) open.searchParams.set("error", record.claimed.error);
        const href = escapeAttribute(open.href);
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>BotCamp</title><a id="open" href="${href}">打开 BotCamp</a><script>location.replace(document.getElementById("open").href)</script>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          },
        );
      }),
      desktopHandoffPoll: createAuthEndpoint(
        "/desktop-handoff/poll",
        { method: "POST" },
        async (ctx) => {
          const body = (ctx.body ?? {}) as { nonce?: unknown; pollSecret?: unknown };
          const nonce = typeof body.nonce === "string" ? body.nonce : "";
          const pollSecret = typeof body.pollSecret === "string" ? body.pollSecret : "";
          if (!NONCE.test(nonce) || !NONCE.test(pollSecret)) {
            throw new APIError("BAD_REQUEST", { message: "Invalid handoff" });
          }
          const adapter = ctx.context.internalAdapter;
          const row = await adapter.findVerificationValue(identifier(nonce));
          const record = row ? parseRecord(row.value) : null;
          if (!record || !sameSecret(record.secretHash, pollSecret) || row!.expiresAt.getTime() <= Date.now()) {
            throw new APIError("NOT_FOUND", { message: "Handoff not found" });
          }
          if (!record.claimed) return new Response(null, { status: 204 });
          const returnTo = record.returns[record.claimed.to];
          if (!returnTo) throw new APIError("NOT_FOUND", { message: "Handoff not found" });
          const consumed = await adapter.consumeVerificationValue(identifier(nonce));
          if (!consumed) throw new APIError("NOT_FOUND", { message: "Handoff not found" });
          return ctx.json({
            returnTo,
            ...(record.claimed.token ? { token: record.claimed.token } : {}),
            ...(record.claimed.error ? { error: record.claimed.error } : {}),
          });
        },
      ),
    },
  };
}
