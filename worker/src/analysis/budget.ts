import type { ModelPricing } from "./config.ts";

export function costUsd(pricing: ModelPricing, inputTokens: number, outputTokens: number): number {
  return (inputTokens * pricing.inputUsdPerMTok + outputTokens * pricing.outputUsdPerMTok) / 1_000_000;
}

/** Highest cost a call can reach: counted input plus a safety margin, plus the full output allowance. */
export function worstCaseUsd(pricing: ModelPricing, countedInput: number, margin: number, maxOutputTokens: number): number {
  return costUsd(pricing, Math.ceil(countedInput * (1 + margin)), maxOutputTokens);
}

/**
 * Refuses any call whose worst case would take total spend past the budget. Spend is the
 * provider-reported usage priced at configured rates, plus the worst case of any call whose
 * billing is unknown (e.g. a timeout after the request was sent).
 */
export class BudgetTracker {
  private spent = 0;
  inputTokens = 0;
  outputTokens = 0;

  constructor(readonly budgetUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  allows(worstCase: number): boolean {
    return this.spent + worstCase <= this.budgetUsd + 1e-9;
  }

  recordUsage(cost: number, inputTokens: number, outputTokens: number): void {
    this.spent += cost;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
  }

  recordUncertain(worstCase: number): void {
    this.spent += worstCase;
  }
}
