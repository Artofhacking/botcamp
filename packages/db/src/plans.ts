/**
 * Membership plans. A plan's weekly allowance is quoted at the model's list price and equals
 * the monthly price in yuan — a user paying ¥100 gets ¥100 of tokens every week, which is the
 * deal we advertise. What that costs us is a tenth of it, and less with cache hits.
 */
import { USD_TO_CNY } from "./credits.js";

export const PLAN_IDS = ["free", "pro", "plus", "max", "max_plus"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Model list price for a million tokens, US dollars, at a 50:1 input/output mix. */
export const LIST_USD_PER_MILLION = 0.3176;
export const LIST_YUAN_PER_MILLION = LIST_USD_PER_MILLION * USD_TO_CNY;

export interface Plan {
  id: PlanId;
  label: string;
  /** What the user pays, yuan per month. */
  priceYuan: number;
  /** Weekly token allowance at list price; shown to the user as "¥100 of tokens". */
  weeklyTokens: bigint;
  /**
   * The weekly spending weight, in points: 1000 points is ¥10 of tokens at official prices.
   * It is the only number the quota maths uses, so a change in a model's price cannot change
   * what a plan buys. Users only ever see the percentage of it they have used.
   */
  weeklyPoints: bigint;
  /** Weekly burst-container allowance, in core-seconds. */
  weeklyCoreSeconds: bigint;
}

const tokensForYuan = (yuan: number) =>
  BigInt(Math.round((yuan / LIST_YUAN_PER_MILLION) * 1_000_000));
const coreHours = (hours: number) => BigInt(hours * 3600);
/** One point is a fen of list price: 1000 points is ¥10 of tokens at official prices. */
const pointsForList = (listYuan: number) => BigInt(Math.round(listYuan * 100));

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    label: "Free",
    priceYuan: 0,
    weeklyTokens: tokensForYuan(3),
    weeklyPoints: pointsForList(10),
    weeklyCoreSeconds: coreHours(4),
  },
  pro: {
    id: "pro",
    label: "Pro",
    priceYuan: 100,
    weeklyTokens: tokensForYuan(100),
    weeklyPoints: pointsForList(100),
    weeklyCoreSeconds: coreHours(20),
  },
  plus: {
    id: "plus",
    label: "Plus",
    priceYuan: 200,
    weeklyTokens: tokensForYuan(200),
    weeklyPoints: pointsForList(200),
    weeklyCoreSeconds: coreHours(50),
  },
  max: {
    id: "max",
    label: "Max",
    priceYuan: 500,
    weeklyTokens: tokensForYuan(500),
    weeklyPoints: pointsForList(500),
    weeklyCoreSeconds: coreHours(120),
  },
  max_plus: {
    id: "max_plus",
    label: "Max+",
    priceYuan: 1500,
    weeklyTokens: tokensForYuan(1500),
    weeklyPoints: pointsForList(1500),
    weeklyCoreSeconds: coreHours(336),
  },
};

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

export function planOf(value: string | null | undefined): Plan {
  return PLANS[isPlanId(value) ? value : "free"];
}

/** The list-price value of a token allowance, in yuan — what a user sees they are getting. */
export function listValueYuan(weeklyTokens: bigint | number): number {
  return (Number(weeklyTokens) / 1_000_000) * LIST_YUAN_PER_MILLION;
}

/** The same allowance in dollars, at the configured rate. */
export function listValueUsd(weeklyTokens: bigint | number): number {
  return listValueYuan(weeklyTokens) / USD_TO_CNY;
}
