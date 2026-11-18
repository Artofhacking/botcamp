import type { ModelPricing, ModelRates } from "@botcamp/contracts";
import { modelRatesAt, modelRatesCeiling } from "@botcamp/contracts";
import type { Api, Model } from "@earendil-works/pi-ai";

type ModelCost = Model<Api>["cost"];

/**
 * Peak schedules by the cost object they were built into. Copies of a model keep the same
 * cost object, so every copy a run makes still finds its schedule.
 */
const schedules = new WeakMap<ModelCost, ModelPricing>();
/** Costs built from a price someone set, which outranks what a gateway reports. */
const setPrices = new WeakSet<ModelCost>();

/** Whether this cost came from a price set on the model list or a connection. */
export function hasSetPrice(cost: ModelCost): boolean {
  return setPrices.has(cost);
}

export function costOfRates(rates: ModelRates): ModelCost {
  const cost = {
    input: rates.inputPerMillion,
    output: rates.outputPerMillion,
    cacheRead: rates.cacheReadPerMillion ?? rates.inputPerMillion,
    // A rate here makes every call that reports no cache-write count unpriced,
    // and most compatible servers report none.
    cacheWrite: 0,
  };
  setPrices.add(cost);
  return cost;
}

/** The off-peak (or all-day) cost of a price. `modelPricedAt` applies its peak rates per call. */
export function costOfPricing(pricing: ModelPricing): ModelCost {
  const cost = costOfRates(pricing);
  if (pricing.peak) schedules.set(cost, pricing);
  return cost;
}

/** The highest cost a call can be billed at, for holding enough before it starts. */
export function costCeiling(cost: ModelCost): ModelCost {
  const pricing = schedules.get(cost);
  return pricing ? costOfRates(modelRatesCeiling(pricing)) : cost;
}

/** The model with the rates in force at `at`. A model without a schedule is returned as is. */
export function modelPricedAt<T extends Model<Api>>(model: T, at: Date): T {
  const pricing = schedules.get(model.cost);
  return pricing ? { ...model, cost: costOfRates(modelRatesAt(pricing, at)) } : model;
}
