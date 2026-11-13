// `tsx src/cli/set-weekly-quota.ts <email|userId> [tokens]`
// Reports a member's weekly model-token allowance and this week's spend; with a
// token count it also sets the allowance.
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@botcamp/adapters";
import { createDb, runAsSystem, weekEnd, weeklyTokensUsed } from "@botcamp/db";

const target = process.argv[2];
const requested = process.argv[3];
if (!target) {
  console.error("usage: set-weekly-quota <email|userId> [tokens]");
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const { prisma, pool } = createDb(process.env.DATABASE_URL!, {
  keyProvider: contentKeyProviderFromEnv(),
});
try {
  await runAsSystem("weekly quota admin", async () => {
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: target }, { id: target }] },
      select: { id: true, email: true, weeklyTokenQuota: true },
    });
    if (!user) throw new Error(`no user matches ${target}`);

    if (requested !== undefined) {
      const tokens = Number(requested);
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new Error("tokens must be a non-negative integer");
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { weeklyTokenQuota: BigInt(tokens) },
      });
      console.log(`quota set: ${user.email} -> ${tokens} tokens/week`);
    }

    const used = await weeklyTokensUsed(prisma, user.id);
    const quota = user.weeklyTokenQuota;
    console.log(
      `${user.email}: ${used} / ${quota} tokens this week; resets ${weekEnd().toISOString()}`,
    );
  });
} finally {
  await pool.end();
}
