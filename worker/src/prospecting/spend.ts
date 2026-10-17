import { BudgetTracker } from "../analysis/budget.ts";
import { ModelCallError } from "../analysis/model.ts";
import type { DiscoveryProvider, SearchRequest, SearchResponse } from "./provider.ts";

export type CallOperation = SearchRequest["operation"] | "ai_screening";
export type CostBasis = "provider_reported" | "computed_from_usage" | "uncertain_worst_case" | "not_billed";

export interface ProviderCallRecord {
  provider: string;
  operation: CallOperation;
  method: string;
  query: string | null;
  params: Record<string, unknown>;
  companyId: string | null;
  status: "succeeded" | "failed" | "refused_budget";
  resultCount: number | null;
  worstCaseUsd: number;
  actualCostUsd: number;
  costBasis: CostBasis;
  requestId: string | null;
  error: string | null;
}

export type RecordCall = (record: ProviderCallRecord) => Promise<string>;

export type Guarded<T> = { ok: true; value: T; callId: string } | { ok: false; refused: boolean; callId: string; error: string };

interface CallMeta {
  provider: string;
  operation: CallOperation;
  method: string;
  query: string | null;
  params: Record<string, unknown>;
  companyId: string | null;
  worstCaseUsd: number;
}

interface Executed<T> {
  value: T;
  costUsd: number;
  basis: CostBasis;
  resultCount: number | null;
  requestId: string | null;
}

/**
 * Every paid call goes through here: refused before sending if its worst case could pass the
 * shared budget, then logged with the actual cost (provider-reported where available).
 */
export class SpendGuard {
  constructor(
    readonly budget: BudgetTracker,
    private readonly record: RecordCall,
  ) {}

  async run<T>(meta: CallMeta, exec: () => Promise<Executed<T>>): Promise<Guarded<T>> {
    const base = { ...meta, worstCaseUsd: round6(meta.worstCaseUsd), requestId: null };
    if (!this.budget.allows(meta.worstCaseUsd)) {
      const error = `Refused: worst case $${meta.worstCaseUsd.toFixed(4)} would pass the $${this.budget.budgetUsd.toFixed(2)} budget ($${this.budget.spentUsd.toFixed(4)} spent)`;
      const callId = await this.record({ ...base, status: "refused_budget", resultCount: null, actualCostUsd: 0, costBasis: "not_billed", error });
      return { ok: false, refused: true, callId, error };
    }
    try {
      const done = await exec();
      this.budget.recordUsage(done.costUsd, 0, 0);
      const callId = await this.record({ ...base, status: "succeeded", resultCount: done.resultCount, actualCostUsd: round6(done.costUsd), costBasis: done.basis, requestId: done.requestId, error: null });
      return { ok: true, value: done.value, callId };
    } catch (err) {
      const billed = err instanceof ModelCallError ? err.possiblyBilled : true;
      if (billed) this.budget.recordUncertain(meta.worstCaseUsd);
      const error = (err as Error).message.slice(0, 500);
      const callId = await this.record({
        ...base,
        status: "failed",
        resultCount: null,
        actualCostUsd: billed ? round6(meta.worstCaseUsd) : 0,
        costBasis: billed ? "uncertain_worst_case" : "not_billed",
        error,
      });
      return { ok: false, refused: false, callId, error };
    }
  }

  search(provider: DiscoveryProvider, req: SearchRequest, companyId: string | null = null): Promise<Guarded<SearchResponse>> {
    return this.run(
      { provider: provider.name, operation: req.operation, method: provider.method(req), query: req.query, params: provider.params(req), companyId, worstCaseUsd: provider.worstCaseUsd(req) },
      async () => {
        const response = await provider.search(req);
        const reported = response.reportedCostUsd;
        return {
          value: response,
          costUsd: reported ?? provider.estimatedCostUsd(req, response.hits.length),
          basis: reported !== null ? "provider_reported" : "computed_from_usage",
          resultCount: response.hits.length,
          requestId: response.requestId,
        };
      },
    );
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
