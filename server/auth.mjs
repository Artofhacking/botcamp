/**
 * Session auth: cookie `botcamp_session` or `Authorization: Bearer <token>`.
 * Resolves authenticated owner_user_id — never a hardcoded global OWNER for data routes.
 */
import crypto from "node:crypto";
import { kvGet, kvSet, kvDelete } from "./kv.mjs";

export const SESSION_COOKIE = "botcamp_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function listDemoUsers() {
  return kvGet("system:demo_users") || [];
}

export function findDemoUser(username) {
  const u = String(username || "").trim().toLowerCase();
  return listDemoUsers().find((d) => d.username.toLowerCase() === u) || null;
}

export function createSession(ownerUserId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const record = {
    token,
    owner_user_id: ownerUserId,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  kvSet(`session:${token}`, record);
  return record;
}

export function destroySession(token) {
  if (token) kvDelete(`session:${token}`);
}

export function resolveSession(token) {
  if (!token) return null;
  const record = kvGet(`session:${token}`);
  if (!record) return null;
  if (Date.parse(record.expires_at) < Date.now()) {
    kvDelete(`session:${token}`);
    return null;
  }
  return record;
}

export function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  if (req.cookies?.[SESSION_COOKIE]) {
    return req.cookies[SESSION_COOKIE];
  }
  return null;
}

/** Express middleware — sets req.ownerUserId or 401. */
export function requireAuth(req, res, next) {
  const token = extractToken(req);
  const session = resolveSession(token);
  if (!session) {
    return res.status(401).json({ error: "unauthorized", message: "需要登录" });
  }
  req.ownerUserId = session.owner_user_id;
  req.sessionToken = token;
  next();
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}
