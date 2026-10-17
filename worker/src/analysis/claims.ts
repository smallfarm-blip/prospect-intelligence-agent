import type { ClaimType, Finding } from "./schemas.ts";
import { isScreenshotQuote, quoteSegments } from "./quotes.ts";

export interface Claim {
  id: string;
  type: ClaimType;
  text: string;
  evidenceRefs: string[];
  region: Finding["observed_facts"][number]["region"];
  quote: string | null;
  pageRef: string | null;
  device: string | null;
}

/**
 * Splits a finding into separately checkable claims. The verifier sees only these, never the
 * analyst's confidence reasoning or assessment summary.
 */
export function claimsOf(f: Finding): Claim[] {
  const claims: Claim[] = [];
  const add = (type: ClaimType, text: string, extra: Partial<Claim> = {}) =>
    claims.push({ id: `C${claims.length + 1}`, type, text, evidenceRefs: [], region: null, quote: null, pageRef: null, device: null, ...extra });

  for (const fact of f.observed_facts) {
    const screenshotQuote = isScreenshotQuote(fact);
    add("observed_fact", `[${fact.fact_id} | page ${fact.page_ref} | ${fact.device}] ${fact.statement}`, {
      evidenceRefs: fact.evidence_refs,
      region: fact.region,
      quote: screenshotQuote ? null : fact.text_excerpt,
      pageRef: fact.page_ref,
      device: fact.device,
    });
    const segments = quoteSegments(fact);
    if (screenshotQuote && segments.length) {
      const images = fact.evidence_refs.filter((ref) => ref.startsWith("IMG-"));
      add(
        "observed_fact",
        `[${fact.fact_id} | page ${fact.page_ref} | ${fact.device}] Screenshot wording: each of the following is legible, word for word, in the cited screenshot(s) ${images.join(", ")}: ${segments.map((s) => `"${s}"`).join("; ")}`,
        { evidenceRefs: images, region: fact.region, pageRef: fact.page_ref, device: fact.device },
      );
    }
  }
  for (const inf of f.behavioral_inferences) {
    add("behavioral_inference", `${inf.statement}\nBased on: ${inf.basis_fact_ids.join(", ")}`);
  }
  const journey = f.journey
    ? `\nJourney: ${f.journey.steps.map((s, i) => `${i + 1}. ${s.page_ref} (${s.fact_ids.join(", ")}): ${s.role_in_journey}`).join(" ")}\nCoherence: ${f.journey.coherence}`
    : "";
  add("visitor_context", `Visitor task: ${f.visitor_task}\nEntry context: ${f.entry_context}\nDecision moment: ${f.decision_moment}${journey}`);
  const support = f.existing_site_support.length
    ? `\nExisting site support considered: ${f.existing_site_support.map((s) => `${s.support} (${s.fact_ids.join(", ")}): ${s.how_it_affects_hypothesis}`).join("; ")}`
    : "\nExisting site support considered: none listed";
  add(
    "hypothesis",
    `Problem type: ${f.problem_type.replace(/_/g, " ")}. ${f.problem_type_rationale}\n${f.hypothesis}\nBehavioural question: ${f.behavioral_question}\nExpected behaviour shift: ${f.expected_behavior_shift}${support}`,
  );
  add(
    "business_implication",
    `${f.commercial_relevance}\nRevenue-per-visitor pathway (${f.rpv_pathway.levers.join(", ").replace(/_/g, " ")}): ${f.rpv_pathway.mechanism}\nWould be confirmed by: ${f.rpv_pathway.confirming_evidence}`,
  );
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
