// `tsx src/cli/import-legacy-users.ts <users.json>`
//
// Brings accounts over from the previous BotCamp deployment. Passwords stay with their
// original PBKDF2 hash in legacy_credentials; the first sign-in upgrades them in place.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@botcamp/adapters";
import { createDb, PLANS, runAsSystem } from "@botcamp/db";

interface LegacyUser {
  email: string;
  name?: string;
  pwHash: string;
  status?: string;
  createdAt?: number;
}

/** Placeholder hash in the current scheme, so a normal sign-in fails cleanly until upgraded. */
function placeholderHash(): string {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(randomBytes(32).toString("hex"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 });
  return `${salt}:${key.toString("hex")}`;
}

const path = process.argv[2];
if (!path) {
  console.error("usage: import-legacy-users <users.json>");
  process.exit(2);
}
const users = JSON.parse(readFileSync(path, "utf8")) as LegacyUser[];

await unwrapEnvFromKeyManager();
const { prisma, pool } = createDb(process.env.DATABASE_URL!, {
  keyProvider: contentKeyProviderFromEnv(),
});
const plan = PLANS.free;
let created = 0;
let skipped = 0;
let imported = 0;

try {
  await runAsSystem("migrate accounts from the previous deployment", async () => {
    for (const legacy of users) {
      const email = legacy.email.trim().toLowerCase();
      if (legacy.status && legacy.status !== "active") {
        skipped += 1;
        continue;
      }
      const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (existing) {
        skipped += 1;
        console.log(`${email}: 已存在，跳过`);
        continue;
      }
      const userId = randomUUID().replace(/-/g, "");
      await prisma.user.create({
        data: {
          id: userId,
          email,
          name: legacy.name?.trim() || email.split("@")[0] || "BotCamp",
          // The old backend never verified addresses, and users signed in with a password.
          emailVerified: true,
          createdAt: legacy.createdAt ? new Date(legacy.createdAt * 1000) : new Date(),
          plan: plan.id,
          weeklyTokenQuota: plan.weeklyTokens,
          weeklyCoreSecondsQuota: plan.weeklyCoreSeconds,
          accounts: {
            create: {
              id: randomUUID().replace(/-/g, ""),
              accountId: userId,
              providerId: "credential",
              // A placeholder: the legacy hash takes over until the first sign-in upgrades it.
              password: placeholderHash(),
            },
          },
        },
      });
      if (legacy.pwHash) {
        await prisma.legacyCredential.upsert({
          where: { email },
          create: { email, pwHash: legacy.pwHash },
          update: { pwHash: legacy.pwHash },
        });
        imported += 1;
      }
      created += 1;
      console.log(`${email}: 已导入`);
    }
  });
  console.log(`完成：新建 ${created}，带原密码 ${imported}，跳过 ${skipped}`);
} finally {
  await pool.end();
}
