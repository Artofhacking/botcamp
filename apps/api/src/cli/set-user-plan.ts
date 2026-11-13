// `tsx src/cli/set-user-plan.ts <email|userId> <free|pro|plus|max|max_plus> [--tokens N] [--core-hours N]`
// Moves a user onto a plan, applying the plan's quotas unless explicit overrides are given.
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@botcamp/adapters";
import { createDb, isPlanId, PLANS, runAsSystem } from "@botcamp/db";

const args = process.argv.slice(2);
const [target, planId] = args;
if (!target || !isPlanId(planId)) {
  console.error(`usage: set-user-plan <email|userId> <${Object.keys(PLANS).join("|")}>`);
  process.exit(2);
}
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const tokens = flag("--tokens");
const coreHours = flag("--core-hours");

await unwrapEnvFromKeyManager();
const { prisma, pool } = createDb(process.env.DATABASE_URL!, {
  keyProvider: contentKeyProviderFromEnv(),
});
try {
  await runAsSystem("plan admin", async () => {
    const user = await prisma.user.findFirst({
      where: { OR: [{ id: target }, { email: target }] },
      select: { id: true, email: true, plan: true },
    });
    if (!user) throw new Error(`no user matches ${target}`);
    const plan = PLANS[planId];
    const weeklyTokens = tokens ? BigInt(tokens) : plan.weeklyTokens;
    const weeklyCoreSeconds = coreHours
      ? BigInt(Math.round(Number(coreHours) * 3600))
      : plan.weeklyCoreSeconds;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        plan: plan.id,
        weeklyTokenQuota: weeklyTokens,
        weeklyCoreSecondsQuota: weeklyCoreSeconds,
      },
    });
    console.log(
      `${user.email}: ${user.plan} -> ${plan.id} | tokens/week ${weeklyTokens} | core-hours/week ${Number(weeklyCoreSeconds) / 3600}`,
    );
  });
} finally {
  await pool.end();
}
