import { z } from "zod";

const text = (min = 1, max = 1200) => z.string().trim().min(min).max(max);
const REF = /^(IMG-\d{2,3}|TXT-P\d{1,3})$/;
const PAGE_REF = /^P\d{1,3}$/;
const FACT_ID = /^F\d{1,2}$/;

export const SCHEMA_VERSION = "finding-v1.1";
export const FINDING_CLASSES = ["evidence_backed_opportunity", "research_hypothesis", "low_value_observation"] as const;
export const PRIORITY_LEVELS = ["high", "medium", "low"] as const;
export const UNKNOWN_SEVERITIES = ["could_invalidate", "affects_priority", "minor"] as const;

export const RegionSchema = z
  .object({
    image_ref: z.string().regex(/^IMG-\d{2,3}$/),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .describe("Area of the cited image, as fractions (0-1) of that image's width and height");

export const ObservedFactSchema = z.object({
  fact_id: z.string().regex(FACT_ID),
  page_ref: z.string().regex(PAGE_REF).describe("The one page (P1, P2...) this fact is about. Every cited reference must belong to this page."),
  device: z.enum(["mobile", "desktop"]).describe("Device of that page's capture"),
  statement: text(10, 600).describe("Something directly visible in a screenshot or present in page text. No interpretation. Name the capture state using the standard terms."),
  evidence_refs: z.array(z.string().regex(REF)).min(1).max(6),
  region: RegionSchema.nullable(),
  text_excerpt: z.string().max(400).nullable().describe("Exact quote from page text or screenshot, if the fact rests on wording"),
});

export const JourneySchema = z
  .object({
    steps: z
      .array(
        z.object({
          page_ref: z.string().regex(PAGE_REF),
          role_in_journey: text(5, 300),
          fact_ids: z.array(z.string().regex(FACT_ID)).min(1).max(6),
        }),
      )
      .min(2)
      .max(5),
    coherence: text(10, 500).describe("Why these pages form one plausible visitor journey"),
  })
  .describe("Ordered visitor journey when evidence from more than one page is used");

export const BehavioralInferenceSchema = z.object({
  inference_id: z.string().regex(/^I\d{1,2}$/),
  statement: text(10, 500).describe("An informed behavioural inference, phrased as likely or possible, never as observed"),
  basis_fact_ids: z.array(z.string().regex(FACT_ID)).min(1).max(6),
});

export const ExistingSupportSchema = z.object({
  support: text(5, 300).describe("Something the site already provides for this decision (guidance, controls, recommendations)"),
  fact_ids: z.array(z.string().regex(FACT_ID)).min(1).max(6),
  how_it_affects_hypothesis: text(10, 400),
});

export const CriticalUnknownSchema = z.object({
  unknown: text(5, 400),
  severity: z.enum(UNKNOWN_SEVERITIES).describe("could_invalidate: the hypothesis or recommendation could be wrong if this resolves the other way"),
  why_it_matters: text(5, 400),
  how_to_resolve: text(5, 400),
  resolution_source: z.enum(["page_interaction", "first_party_data", "qualitative_research", "other"]),
  resolution_effort: z.enum(["low", "medium", "high"]),
});

export const RpvPathwaySchema = z.object({
  levers: z.array(z.enum(["conversion", "average_order_value", "product_mix", "return_rate", "repeat_purchase"])).min(1).max(5),
  mechanism: text(10, 500).describe("How the behaviour could plausibly change revenue per visitor. Qualitative; no figures."),
  confirming_evidence: text(10, 400).describe("First-party evidence that would show the effect is real"),
});

export const InvestigationPrioritySchema = z.object({
  level: z.enum(PRIORITY_LEVELS),
  commercial_relevance: text(5, 400),
  decision_importance: text(5, 400),
  hypothesis_strength: text(5, 400),
  effort_to_resolve_unknowns: text(5, 400),
});

export const FindingSchema = z.object({
  finding_ref: z.string().regex(/^F-\d{1,2}$/),
  short_title: text(5, 120),
  page_type: z.enum(["homepage", "plp", "pdp", "cross_page"]),
  finding_class: z.enum(FINDING_CLASSES),
  class_rationale: text(10, 500),
  problem_type: z.enum(["decision_complexity", "experience_friction", "relevance_gap", "information_gap", "journey_orchestration"]),
  problem_type_rationale: text(10, 500).describe("Why this is (or is not) real friction rather than an inherently complex decision"),
  visitor_task: text(10, 400),
  entry_context: text(10, 400).describe("Where this visitor's journey plausibly starts, and why"),
  decision_moment: text(15, 500),
  journey: JourneySchema.nullable(),
  observed_facts: z.array(ObservedFactSchema).min(1).max(8),
  behavioral_inferences: z.array(BehavioralInferenceSchema).max(6),
  existing_site_support: z.array(ExistingSupportSchema).max(5),
  hypothesis: text(20, 900).describe("Inference, clearly not an observation"),
  behavioral_question: text(15, 500),
  expected_behavior_shift: text(10, 500),
  intent_signals_to_examine: z.array(text(5, 300)).max(6).describe("Signals that could be examined in first-party data; none were measured"),
  alternative_explanations: z.array(text(5, 400)).min(1).max(6),
  critical_unknowns: z.array(CriticalUnknownSchema).max(6),
  validation_data_needed: z.array(text(5, 400)).min(1).max(8),
  measurement_plan: z.object({
    primary_kpi: text(3, 200),
    secondary_indicators: z.array(text(3, 200)).min(1).max(6),
    segment_or_context: text(3, 400),
  }),
  possible_next_step: text(10, 600),
  simpler_alternative_considered: text(10, 500).describe("Why a simpler UX change would or would not address this before any personalization"),
  commercial_relevance: text(10, 700).describe("Qualitative only; no projected figures"),
  rpv_pathway: RpvPathwaySchema,
  investigation_priority: InvestigationPrioritySchema,
  confidence: z.enum(["low", "medium", "high"]),
  confidence_explanation: text(10, 500),
  evidence_quality: z.enum(["strong", "adequate", "weak"]),
});

export const AnalystOutputSchema = z
  .object({
    assessment_summary: text(10, 1500),
    evidence_limitations: z.array(text(5, 400)).max(10),
    no_findings_reason: z.string().max(1000).nullable(),
    findings: z.array(FindingSchema).max(5),
  })
  .superRefine((o, ctx) => {
    if (!o.findings.length && !o.no_findings_reason?.trim()) {
      ctx.addIssue({ code: "custom", path: ["no_findings_reason"], message: "Required when there are no findings" });
    }
    const refs = o.findings.map((f) => f.finding_ref);
    if (new Set(refs).size !== refs.length) ctx.addIssue({ code: "custom", path: ["findings"], message: "finding_ref values must be unique" });
  });

export const RevisionOutputSchema = z.object({
  revised: z.boolean(),
  withdrawal_reason: z.string().max(800).nullable(),
  finding: FindingSchema.nullable(),
});

export const CLAIM_TYPES = ["observed_fact", "behavioral_inference", "visitor_context", "hypothesis", "business_implication", "validation_metric"] as const;

export const OpportunityAssessmentSchema = z.object({
  decision_importance: z.enum(["high", "medium", "low"]),
  commercial_relevance: z.enum(["strong", "plausible", "weak"]),
  rpv_pathway_credible: z.boolean(),
  friction_vs_complexity: text(5, 500).describe("Is this real friction, or an inherently complex decision the site already supports?"),
  existing_support_considered: z.boolean(),
  missed_existing_support: z.array(text(5, 300)).max(5).describe("Visible site features that address this decision but the finding ignores"),
  critical_gaps: z.array(text(5, 400)).max(6).describe("Missing evidence that could invalidate the recommendation"),
  premature_recommendation: z.boolean().describe("True if it recommends changing an experience whose behaviour has not been observed"),
  recommended_class: z.enum(FINDING_CLASSES),
  recommended_priority: z.enum(PRIORITY_LEVELS),
  reason: text(10, 800),
});

export const VerifierOutputSchema = z.object({
  claim_checks: z
    .array(
      z.object({
        claim_id: z.string().regex(/^C\d{1,2}$/),
        verdict: z.enum(["demonstrated", "partially_demonstrated", "not_demonstrated", "contradicted", "appropriately_framed", "overstated"]),
        evidence_refs_checked: z.array(z.string()).max(10),
        reason: text(5, 600),
      }),
    )
    .min(1),
  page_and_state_check: z.object({ correct: z.boolean(), reason: text(5, 500) }),
  metadata_consistency: z.object({ consistent: z.boolean(), contradictions: z.array(text(5, 400)).max(6) }),
  decision_problem: z.object({ meaningful: z.boolean(), reason: text(5, 500) }),
  generic_check: z.object({ generic: z.boolean(), reason: text(5, 500) }),
  evidence_verdict: z.enum(["supported", "needs_revision", "rejected"]).describe("Facts, citations, page identity and capture state only; ignore commercial value"),
  opportunity_assessment: OpportunityAssessmentSchema,
  overall: z.enum(["supported", "needs_revision", "rejected"]),
  overall_reason: text(10, 800),
});

export type Finding = z.infer<typeof FindingSchema>;
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;
export type RevisionOutput = z.infer<typeof RevisionOutputSchema>;
export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export type FindingClass = (typeof FINDING_CLASSES)[number];
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];
export type OpportunityAssessment = z.infer<typeof OpportunityAssessmentSchema>;

/** JSON schema handed to the provider as the single tool the model must call. */
export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}
