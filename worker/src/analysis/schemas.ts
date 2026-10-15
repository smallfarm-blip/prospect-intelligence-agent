import { z } from "zod";

const text = (min = 1, max = 1200) => z.string().trim().min(min).max(max);
const REF = /^(IMG-\d{2,3}|TXT-P\d{1,3})$/;

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
  fact_id: z.string().regex(/^F\d{1,2}$/),
  statement: text(10, 600).describe("Something directly visible in a screenshot or present in page text. No interpretation."),
  evidence_refs: z.array(z.string().regex(REF)).min(1).max(6),
  region: RegionSchema.nullable(),
  text_excerpt: z.string().max(400).nullable().describe("Exact quote from page text or screenshot, if the fact rests on wording"),
});

export const FindingSchema = z.object({
  finding_ref: z.string().regex(/^F-\d{1,2}$/),
  short_title: text(5, 120),
  page_type: z.enum(["homepage", "plp", "pdp", "cross_page"]),
  visitor_task: text(10, 400),
  entry_context: text(10, 400).describe("Where this visitor's journey plausibly starts, and why"),
  decision_moment: text(15, 500),
  observed_facts: z.array(ObservedFactSchema).min(1).max(8),
  hypothesis: text(20, 900).describe("Inference, clearly not an observation"),
  behavioral_question: text(15, 500),
  expected_behavior_shift: text(10, 500),
  intent_signals_to_examine: z.array(text(5, 300)).max(6).describe("Signals that could be examined in first-party data; none were measured"),
  alternative_explanations: z.array(text(5, 400)).min(1).max(6),
  unknowns: z.array(text(5, 400)).max(6),
  validation_data_needed: z.array(text(5, 400)).min(1).max(8),
  measurement_plan: z.object({
    primary_kpi: text(3, 200),
    secondary_indicators: z.array(text(3, 200)).min(1).max(6),
    segment_or_context: text(3, 400),
  }),
  possible_next_step: text(10, 600),
  simpler_alternative_considered: text(10, 500).describe("Why a simpler UX change would or would not address this before any personalization"),
  commercial_relevance: text(10, 700).describe("Qualitative only; no projected figures"),
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

export const CLAIM_TYPES = ["observed_fact", "visitor_context", "hypothesis", "business_implication", "validation_metric"] as const;

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
  overall: z.enum(["supported", "needs_revision", "rejected"]),
  overall_reason: text(10, 800),
});

export type Finding = z.infer<typeof FindingSchema>;
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;
export type RevisionOutput = z.infer<typeof RevisionOutputSchema>;
export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** JSON schema handed to the provider as the single tool the model must call. */
export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}
