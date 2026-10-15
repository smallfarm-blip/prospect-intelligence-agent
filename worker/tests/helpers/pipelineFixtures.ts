import type { EvidencePack, PackImage } from "../../src/analysis/evidence.ts";
import type { AnalysisSink, CallRecord, FindingRecord, RunFinish, RunStart, VerificationRecord } from "../../src/analysis/pipeline.ts";
import type { AnalysisLimits, ModelSettings } from "../../src/analysis/config.ts";
import type { Finding, VerifierOutput } from "../../src/analysis/schemas.ts";

export class MemorySink implements AnalysisSink {
  run: (RunStart & Partial<RunFinish>) | null = null;
  images: PackImage[] = [];
  calls: CallRecord[] = [];
  findings: Array<FindingRecord & { id: string }> = [];
  verifications: Array<VerificationRecord & { finding_id: string }> = [];

  async createRun(row: RunStart) {
    this.run = { ...row };
    return "ar-1";
  }
  async saveImages(_runId: string, images: PackImage[]) {
    this.images = images;
  }
  async recordCall(_runId: string, call: CallRecord) {
    this.calls.push(call);
    return `call-${this.calls.length}`;
  }
  async saveFinding(_runId: string, _pack: EvidencePack, f: FindingRecord) {
    const id = `fd-${this.findings.length + 1}`;
    this.findings.push({ ...f, id });
    return id;
  }
  async saveVerification(findingId: string, v: VerificationRecord) {
    this.verifications.push({ ...v, finding_id: findingId });
  }
  async finishRun(_runId: string, fields: RunFinish) {
    this.run = { ...this.run!, ...fields };
  }
}

export const MODEL: ModelSettings = { provider: "anthropic", model: "claude-sonnet-5-5", pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 }, maxOutputTokens: 12_000 };
export const VERIFIER: ModelSettings = { ...MODEL, maxOutputTokens: 4_000 };
export const PIPE_LIMITS: AnalysisLimits = { budgetUsd: 2.5, inputCountMargin: 0.1, maxImages: 40, maxSectionsPerPage: 4, maxPageTextChars: 6000, maxVerifierImages: 8 };

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_ref: "F-1",
    short_title: "Shade choice happens before any guidance on mobile PDP",
    page_type: "pdp",
    visitor_task: "Choose the right concealer shade without seeing it in person",
    entry_context: "Likely arrives on the PDP directly from search or social for a named product",
    decision_moment: "Selecting a shade before adding to bag on a small screen",
    observed_facts: [
      {
        fact_id: "F1",
        statement: "The product page shows the price and an Add to bag control in the first screen.",
        evidence_refs: ["IMG-02", "TXT-P1"],
        region: { image_ref: "IMG-02", x: 0.05, y: 0.4, width: 0.9, height: 0.2 },
        text_excerpt: "Add to bag $28",
      },
    ],
    hypothesis: "Visitors unsure of their shade may hesitate at the shade selector because guidance appears only further down.",
    behavioral_question: "Do mobile visitors who open shade guidance add to bag more confidently than those who do not?",
    expected_behavior_shift: "Fewer shade-selector loops before add to bag",
    intent_signals_to_examine: ["Repeated shade swatch taps in one session"],
    alternative_explanations: ["Returning customers already know their shade"],
    unknowns: ["How many PDP sessions start from search"],
    validation_data_needed: ["Share of mobile PDP sessions that tap more than three swatches"],
    measurement_plan: { primary_kpi: "Revenue per visitor on mobile PDP sessions", secondary_indicators: ["Add-to-bag rate after swatch interaction"], segment_or_context: "First-time mobile visitors landing on PDPs" },
    possible_next_step: "Review session recordings of mobile PDP visits that interact with swatches",
    simpler_alternative_considered: "Moving the existing shade guide link next to the swatches may be enough; no personalization needed",
    commercial_relevance: "Shade uncertainty may lead to abandoned or returned purchases, which would affect revenue per visitor.",
    confidence: "medium",
    confidence_explanation: "Visible layout is clear; behaviour is unmeasured",
    evidence_quality: "adequate",
    ...overrides,
  };
}

export function analystReply(findings: Finding[], noFindingsReason: string | null = null) {
  return {
    assessment_summary: "Mobile PDP shade selection is the clearest decision moment in this evidence.",
    evidence_limitations: ["Only one session per page"],
    no_findings_reason: noFindingsReason,
    findings,
  };
}

export function verifierReply(claimCount: number, overrides: Partial<VerifierOutput> = {}, factVerdict: VerifierOutput["claim_checks"][number]["verdict"] = "demonstrated"): VerifierOutput {
  return {
    claim_checks: Array.from({ length: claimCount }, (_, i) => ({
      claim_id: `C${i + 1}`,
      verdict: i === 0 ? factVerdict : "appropriately_framed",
      evidence_refs_checked: ["IMG-02"],
      reason: "Checked against the cited evidence",
    })),
    page_and_state_check: { correct: true, reason: "Correct page and state" },
    metadata_consistency: { consistent: true, contradictions: [] },
    decision_problem: { meaningful: true, reason: "A real shade decision" },
    generic_check: { generic: false, reason: "Specific to this PDP" },
    overall: "supported",
    overall_reason: "Facts are visible and inferences framed as questions",
    ...overrides,
  };
}
