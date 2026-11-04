/**
 * Credits are the single unit of spend. One credit is one fen (¥0.01), so a plan's quota can
 * be read as money and converted to dollars at the configured rate. Tokens and container time
 * both cost credits, which keeps one balance for everything a user consumes.
 */
export const CREDIT_YUAN = Number(process.env.CREDIT_YUAN ?? 0.01);
export const USD_TO_CNY = Number(process.env.USD_TO_CNY ?? 7.1);
/** What we actually pay of the model's list price. */
export const TOKEN_COST_DISCOUNT = Number(process.env.TOKEN_COST_DISCOUNT ?? 0.1);

/** Model list prices, US dollars per million tokens. */
export const TOKEN_RATES_USD = {
  input: 0.3,
  cacheRead: 0.03,
  cacheWrite: 0.3,
  output: 1.2,
} as const;

export interface TokenCounts {
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  outputTokens?: number | null;
}

/** What a batch of tokens would cost at list price — the basis for the usage points. */
export function tokenListCostYuan(counts: TokenCounts): number {
  const million = 1_000_000;
  const usd =
    ((counts.inputTokens ?? 0) * TOKEN_RATES_USD.input +
      (counts.cacheReadTokens ?? 0) * TOKEN_RATES_USD.cacheRead +
      (counts.cacheWriteTokens ?? 0) * TOKEN_RATES_USD.cacheWrite +
      (counts.outputTokens ?? 0) * TOKEN_RATES_USD.output) /
    million;
  return usd * USD_TO_CNY;
}

/** What a batch of tokens cost us, in yuan, after the channel discount. */
export function tokenCostYuan(counts: TokenCounts): number {
  const million = 1_000_000;
  const usd =
    ((counts.inputTokens ?? 0) * TOKEN_RATES_USD.input +
      (counts.cacheReadTokens ?? 0) * TOKEN_RATES_USD.cacheRead +
      (counts.cacheWriteTokens ?? 0) * TOKEN_RATES_USD.cacheWrite +
      (counts.outputTokens ?? 0) * TOKEN_RATES_USD.output) /
    million;
  return usd * TOKEN_COST_DISCOUNT * USD_TO_CNY;
}

/** Container prices for the burst tiers, yuan per hour (CPU plus memory). */
export const TIER_YUAN_PER_HOUR: Record<string, number> = { big: 0.125, desktop: 0.25 };

/** Container spend for a tier over a number of core-seconds. */
export function containerCostYuan(tier: string, coreSeconds: number | bigint): number {
  const hours = Number(coreSeconds) / 3600;
  return hours * (TIER_YUAN_PER_HOUR[tier] ?? 0.125);
}

export function toCredits(yuan: number): bigint {
  return BigInt(Math.ceil(yuan / CREDIT_YUAN));
}

export function creditsToYuan(credits: number | bigint): number {
  return Number(credits) * CREDIT_YUAN;
}

/** "1,240 积分（约 ¥12.40 / $1.75）" — for console output. */
export function formatCredits(credits: number | bigint): string {
  const yuan = creditsToYuan(credits);
  const usd = yuan / USD_TO_CNY;
  return `${Number(credits).toLocaleString("zh-CN")} 积分（约 ¥${yuan.toFixed(2)} / $${usd.toFixed(2)}）`;
}
