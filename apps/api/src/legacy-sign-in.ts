import { pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { PrismaClient } from "@botcamp/db";

/**
 * One-time bridge for accounts whose password was hashed by the previous BotCamp backend
 * (`pbkdf2$iterations$salt$hash`). The first successful sign-in rewrites the account with the
 * current scheme and drops the imported hash, so this endpoint goes quiet by itself.
 */
export function legacySignInRoutes(deps: { prisma: PrismaClient }) {
  const app = new Hono();

  app.post("/api/auth/legacy-sign-in", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { email?: unknown; password?: unknown }
      | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password) return c.json({ error: "email and password are required" }, 400);

    const legacy = await deps.prisma.legacyCredential.findUnique({ where: { email } });
    if (!legacy) return c.json({ error: "no imported password for this account" }, 404);
    if (!checkLegacyPassword(password, legacy.pwHash)) {
      return c.json({ error: "invalid credentials" }, 401);
    }

    const user = await deps.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) return c.json({ error: "account is missing" }, 409);

    await deps.prisma.account.updateMany({
      where: { userId: user.id, providerId: "credential" },
      data: { password: hashForStorage(password) },
    });
    await deps.prisma.legacyCredential.delete({ where: { email } });
    return c.json({ ok: true });
  });

  return app;
}

/** Current scheme: `salt:key`, scrypt with N=16384, r=16, p=1, 64-byte key. */
function hashForStorage(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 });
  return `${salt}:${key.toString("hex")}`;
}

/** `pbkdf2$<iterations>$<base64 salt>$<base64 hash>`, the format the old backend wrote. */
export function checkLegacyPassword(password: string, stored: string): boolean {
  const [scheme, iterations, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterations || !saltB64 || !hashB64) return false;
  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const derived = pbkdf2Sync(password, salt, Number(iterations), expected.length, "sha256");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
