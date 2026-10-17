export type CaptureState = 'initial_viewport' | 'after_overlay_dismissal' | 'full_page_section';
export type VerificationStatus = 'supported' | 'needs_revision' | 'rejected';
export type Decision = 'approved' | 'rejected' | 'revise';
export type RejectionReason = 'unsupported' | 'generic' | 'commercially_weak' | 'wrong_interpretation' | 'duplicate' | 'other';
export type FindingClass = 'evidence_backed_opportunity' | 'research_hypothesis' | 'low_value_observation';
export type PriorityLevel = 'high' | 'medium' | 'low';
export type AssessmentField = 'finding_class' | 'investigation_priority';
export type OutreachReadiness = 'not_ready' | 'exploratory' | 'ready';

export interface Region {
  image_ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ObservedFact {
  fact_id: string;
  /** Absent on findings produced before page attribution existed. */
  page_ref?: string;
  device?: 'mobile' | 'desktop';
  statement: string;
  evidence_refs: string[];
  region: Region | null;
  text_excerpt: string | null;
}

export interface CriticalUnknown {
  unknown: string;
  severity: 'could_invalidate' | 'affects_priority' | 'minor';
  why_it_matters: string;
  how_to_resolve: string;
  resolution_source: string;
  resolution_effort: 'low' | 'medium' | 'high';
}

export interface Journey {
  steps: Array<{ page_ref: string; role_in_journey: string; fact_ids: string[] }>;
  coherence: string;
}

/** Fields marked optional are absent on findings in the earlier format (before finding-v1.1). */
export interface FindingContent {
  finding_ref: string;
  short_title: string;
  page_type: string;
  finding_class?: FindingClass;
  class_rationale?: string;
  problem_type?: string;
  problem_type_rationale?: string;
  visitor_task: string;
  entry_context: string;
  decision_moment: string;
  journey?: Journey | null;
  observed_facts: ObservedFact[];
  behavioral_inferences?: Array<{ inference_id: string; statement: string; basis_fact_ids: string[] }>;
  existing_site_support?: Array<{ support: string; fact_ids: string[]; how_it_affects_hypothesis: string }>;
  hypothesis: string;
  behavioral_question: string;
  expected_behavior_shift: string;
  intent_signals_to_examine: string[];
  alternative_explanations: string[];
  unknowns?: string[];
  critical_unknowns?: CriticalUnknown[];
  validation_data_needed: string[];
  measurement_plan: { primary_kpi: string; secondary_indicators: string[]; segment_or_context: string };
  possible_next_step: string;
  simpler_alternative_considered: string;
  commercial_relevance: string;
  rpv_pathway?: { levers: string[]; mechanism: string; confirming_evidence: string };
  investigation_priority?: {
    level: PriorityLevel;
    commercial_relevance: string;
    decision_importance: string;
    hypothesis_strength: string;
    effort_to_resolve_unknowns: string;
  };
  confidence: 'low' | 'medium' | 'high';
  confidence_explanation: string;
  evidence_quality: 'strong' | 'adequate' | 'weak';
}

export interface RoleSettings {
  provider: string;
  model: string;
  pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  maxOutputTokens: number;
  imageDetail?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}

export interface CallUsage {
  call_id: string;
  role: ModelCall['role'];
  count_method: 'provider' | 'estimate' | null;
  reasoning_tokens: number | null;
}

/** Older runs predate some of these fields, so every part is optional. */
export interface RunConfig {
  analyst?: RoleSettings;
  verifier?: RoleSettings;
  images?: { maxLongEdge: number; maxPixels: number; jpegQuality: number };
  usage?: {
    calls: CallUsage[];
    reasoning_tokens: number;
    reported_usage_cost_usd: number;
    uncertain_billing_reserved_usd: number;
  };
}

export interface EvidenceManifest {
  pages?: unknown[];
  images?: Array<{ ref: string; estimatedTokens?: number }>;
  unanalysed?: unknown[];
  skipped?: unknown[];
  warnings?: string[];
}

export interface AnalysisRun {
  id: string;
  research_run_id: string;
  company_id: string;
  status: 'running' | 'completed' | 'stopped_budget' | 'failed';
  analyst_provider: string;
  analyst_model: string;
  verifier_provider: string;
  verifier_model: string;
  prompt_versions: Record<string, string>;
  evidence_warnings: string[];
  assessment_summary: string | null;
  no_findings_reason: string | null;
  evidence_limitations: string[];
  finding_count: number;
  budget_usd: number;
  estimated_cost_usd: number;
  billed_cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  model_call_count: number;
  errors: string[];
  started_at: string;
  ended_at: string | null;
  companies: { name: string; canonical_domain: string } | null;
  config: RunConfig | null;
  evidence_manifest: EvidenceManifest | null;
}

export interface ModelCall {
  id: string;
  role: 'analyst' | 'verifier' | 'revision';
  finding_ref: string | null;
  provider: string;
  model: string;
  counted_input_tokens: number | null;
  status: 'succeeded' | 'invalid_output' | 'failed' | 'refused_budget';
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number;
  worst_case_cost_usd: number | null;
  latency_ms: number | null;
  error: string | null;
  validation_errors: string[];
  created_at: string;
}

export interface AnalysisImage {
  id: string;
  ref: string;
  page_evidence_id: string;
  capture_state: CaptureState;
  source_path: string;
  derived_path: string | null;
  crop: { x: number; y: number; width: number; height: number };
  /** Other pages whose screenshot in this state was byte-identical. */
  also_captured_for_evidence_ids: string[];
}

export interface FindingEvidence {
  id: string;
  finding_id: string;
  fact_id: string;
  ref: string;
  page_ref: string | null;
  attribution: 'direct' | 'identical_capture' | null;
  page_evidence_id: string;
  capture_state: string;
  viewport: string;
  url: string | null;
  region: Region | null;
  text_excerpt: string | null;
}

export interface AutomaticCheck {
  check: string;
  passed: boolean;
  severity: 'blocker' | 'revision' | 'warning' | 'info';
  detail: string;
}

export interface ClaimCheck {
  claim_id: string;
  verdict: string;
  reason: string;
  claim: { type: string; text: string } | null;
}

export interface OpportunityAssessment {
  decision_importance: PriorityLevel;
  commercial_relevance: 'strong' | 'plausible' | 'weak';
  rpv_pathway_credible: boolean;
  friction_vs_complexity: string;
  existing_support_considered: boolean;
  missed_existing_support: string[];
  critical_gaps: string[];
  premature_recommendation: boolean;
  recommended_class: FindingClass;
  recommended_priority: PriorityLevel;
  reason: string;
  assignment_notes?: string[];
}

export interface ModelVerdict {
  metadata_consistency: { consistent: boolean; contradictions: string[] };
  page_and_state_check: { correct: boolean; reason: string };
  decision_problem: { meaningful: boolean; reason: string };
  generic_check: { generic: boolean; reason: string };
  evidence_verdict?: VerificationStatus;
}

export interface Verification {
  id: string;
  finding_id: string;
  verifier_model: string | null;
  automatic_checks: AutomaticCheck[];
  claim_checks: ClaimCheck[];
  model_verdict: ModelVerdict | null;
  status: VerificationStatus;
  reason: string;
  /** Null on verifications made before evidence and opportunity were judged separately. */
  evidence_status: VerificationStatus | null;
  opportunity_assessment: OpportunityAssessment | null;
  assigned_class: FindingClass | null;
  assigned_priority: PriorityLevel | null;
  created_at: string;
}

export interface AssessmentOverride {
  id: string;
  finding_id: string;
  field: AssessmentField;
  previous_value: string | null;
  new_value: string;
  reason: string;
  reviewer_id: string;
  created_at: string;
}

export interface ReadinessDecision {
  id: string;
  finding_id: string;
  readiness: OutreachReadiness;
  uncertainty_confirmed: boolean;
  reason: string;
  reviewer_id: string;
  created_at: string;
}

export interface Review {
  id: string;
  finding_id: string;
  decision: Decision;
  rejection_reason: RejectionReason | null;
  notes: string;
  reviewer_id: string;
  created_at: string;
}

export interface Finding {
  id: string;
  finding_ref: string;
  revision_of: string | null;
  short_title: string;
  page_type: string;
  schema_version: string | null;
  finding_class: FindingClass | null;
  investigation_priority: PriorityLevel | null;
  content: FindingContent;
  viewports: string[];
  capture_states: string[];
  confidence: FindingContent['confidence'];
  evidence_quality: FindingContent['evidence_quality'];
  generated_at: string;
}

export interface PageEvidence {
  id: string;
  page_type: string;
  page_slot: string;
  viewport_name: string;
  final_url: string | null;
  screenshot_path: string | null;
  unobstructed_screenshot_path: string | null;
  overlay_dismissal_status: string | null;
}

export interface RunDetail {
  run: AnalysisRun;
  calls: ModelCall[];
  images: AnalysisImage[];
  findings: Finding[];
  evidence: FindingEvidence[];
  verifications: Verification[];
  reviews: Review[];
  overrides: AssessmentOverride[];
  readiness: ReadinessDecision[];
  pages: PageEvidence[];
}

export const REJECTION_REASONS: Array<{ value: RejectionReason; label: string }> = [
  { value: 'unsupported', label: 'Not supported by the evidence' },
  { value: 'generic', label: 'Generic, could apply to any site' },
  { value: 'commercially_weak', label: 'Commercially weak' },
  { value: 'wrong_interpretation', label: 'Wrong interpretation' },
  { value: 'duplicate', label: 'Duplicate of another finding' },
  { value: 'other', label: 'Other (explain in notes)' },
];
