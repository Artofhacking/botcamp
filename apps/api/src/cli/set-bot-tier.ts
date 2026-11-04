// `tsx src/cli/set-bot-tier.ts <botId|botName> <small|big>`
// Moves one bot's computer between the deployment's default provider and the burst one.
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { createDb, runAsSystem } from "@rakazo/db";

const [target, tier] = process.argv.slice(2);
const tiers = new Set(["small", "big", "desktop"]);
if (!target || !tier || !tiers.has(tier)) {
  console.error("usage: set-bot-tier <botId|botName> <small|big|desktop>");
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const { prisma, pool } = createDb(process.env.DATABASE_URL!, {
  keyProvider: contentKeyProviderFromEnv(),
});
try {
  await runAsSystem("bot tier admin", async () => {
    const bot = await prisma.bot.findFirst({
      where: { OR: [{ id: target }, { name: target }] },
      select: { id: true, name: true, computerTier: true },
    });
    if (!bot) throw new Error(`no bot matches ${target}`);
    await prisma.bot.update({ where: { id: bot.id }, data: { computerTier: tier } });
    console.log(`${bot.name} (${bot.id}): ${bot.computerTier} -> ${tier}`);
    console.log("restart the bot's computer for the change to take effect");
  });
} finally {
  await pool.end();
}
