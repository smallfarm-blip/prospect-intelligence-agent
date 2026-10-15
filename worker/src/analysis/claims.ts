import type { ClaimType, Finding } from "./schemas.ts";

export interface Claim {
  id: string;
  type: ClaimType;
  text: string;
  evidenceRefs: string[];
  region: Finding["observed_facts"][number]["region"];
  quote: string | null;
}

/**
 * Splits a finding into separately checkable claims. The verifier sees only these, never the
 * analyst's confidence reasoning or assessment summary.
 */
export function claimsOf(f: Finding): Claim[] {
  const claims: Claim[] = [];
  const add = (type: ClaimType, text: string, extra: Partial<Claim> = {}) =>
    claims.push({ id: `C${claims.length + 1}`, type, text, evidenceRefs: [], region: null, quote: null, ...extra });

  for (const fact of f.observed_facts) {
    add("observed_fact", fact.statement, { evidenceRefs: fact.evidence_refs, region: fact.region, quote: fact.text_excerpt });
  }
  add("visitor_context", `Visitor task: ${f.visitor_task}\nEntry context: ${f.entry_context}\nDecision moment: ${f.decision_moment}`);
  add("hypothesis", `${f.hypothesis}\nBehavioural question: ${f.behavioral_question}\nExpected behaviour shift: ${f.expected_behavior_shift}`);
  add("business_implication", f.commercial_relevance);
  add(
    "validation_metric",
    [
      `Primary KPI: ${f.measurement_plan.primary_kpi}`,
      `Secondary indicators: ${f.measurement_plan.secondary_indicators.join("; ")}`,
      `Segment or context: ${f.measurement_plan.segment_or_context}`,
      `Data needed: ${f.validation_data_needed.join("; ")}`,
    ].join("\n"),
  );
  return claims;
}
