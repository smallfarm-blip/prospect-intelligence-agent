export type FitStatus = 'verified_fit' | 'probable_fit' | 'needs_qualification' | 'not_fit';
export const FIT_STATUSES: FitStatus[] = ['verified_fit', 'probable_fit', 'needs_qualification', 'not_fit'];

export type ProspectDecisionKind = 'shortlist' | 'hold' | 'defer' | 'reject' | 'reopen' | 'request_research';
export type Confidence = 'low' | 'medium' | 'high';
export type DiscoverySegment = 'emerging' | 'growing' | 'established';
export const DISCOVERY_SEGMENTS: DiscoverySegment[] = ['emerging', 'growing', 'established'];
export type FactStatus = 'verified' | 'provider_estimate' | 'inferred' | 'unknown' | 'contradicted';
export type ReviewerFactStatus = 'verified' | 'inferred' | 'contradicted';

export const FACT_ATTRIBUTES = [
  'revenue_annual_usd',
  'employee_count',
  'hq_country',
  'category',
  'business_model',
  'sells_dtc',
  'founded_year',
  'funding_total_usd',
  'ecommerce_platform',
  'experimentation_tools',
  'promotion_tools',
  'catalog_size',
  'leadership_model',
] as const;
export type FactAttribute = (typeof FACT_ATTRIBUTES)[number];

export interface ScoreItem {
  key: string;
  label: string;
  max: number;
  evidence: number;
  potential: number;
  status: string;
  note: string;
}

export interface ScoreComponent {
  key: string;
  label: string;
  max: number;
  evidence: number;
  potential: number;
  items: ScoreItem[];
}

export type AssessmentKey = 'commercial_capacity' | 'need_for_help' | 'accessibility' | 'opportunity_relevance';
export type AssessmentLevel = 'strong' | 'moderate' | 'weak' | 'unknown';

export interface Assessment {
  key: AssessmentKey;
  label: string;
  level: AssessmentLevel;
  strengths: string[];
  risks: string[];
  unknowns: string[];
}

export const NEXT_ACTION_KEYS = ['verify_commercial_capacity', 'validate_business_need', 'confirm_decision_maker', 'investigate_website', 'defer'] as const;
export type NextActionKey = (typeof NEXT_ACTION_KEYS)[number];

export interface NextAction {
  key: NextActionKey;
  label: string;
  explanation: string;
  step: string;
  evidence: string[];
  keyUnknown: string;
  priority: number;
}

export interface Qualification {
  assessments: Assessment[];
  tradeOffs: string[];
  fitBasis?: string[];
  nextAction?: NextAction;
}

export interface ProspectScore {
  id: string;
  company_id: string;
  scoring_version: string;
  evidence_score: number;
  potential_min: number;
  potential_max: number;
  confidence: Confidence;
  coverage: number;
  fit_status: FitStatus;
  components: ScoreComponent[];
  unresolved: string[];
  reasons_to_investigate: string[];
  commercial_relevance: string;
  organizational_fit: string;
  recommended_action: string;
  qualification: Qualification | null;
  computed_at: string;
}

export interface ProspectRow {
  company_id: string;
  origin: string;
  pilot: string | null;
  description: string | null;
  excluded_reason: string | null;
  excluded_rule: string | null;
  screened_at: string | null;
  screening_summary: string | null;
  created_at: string;
  companies: { name: string; canonical_domain: string; category: string | null; geography: string | null } | null;
}

export type OverrideField = 'score' | 'fit_status' | 'next_action';

export interface ProspectOverride {
  id: string;
  company_id: string;
  field: OverrideField;
  previous_value: string | null;
  new_value: string;
  reason: string;
  created_at: string;
}

export interface ProspectDecision {
  id: string;
  company_id: string;
  decision: ProspectDecisionKind;
  reason: string;
  expected_cost_usd: number | null;
  review_seconds: number | null;
  created_at: string;
}

export interface ProspectFact {
  id: string;
  company_id: string;
  attribute: FactAttribute;
  value_text: string;
  value_number: number | null;
  status: FactStatus;
  source_type: string;
  source_url: string | null;
  provider: string | null;
  excerpt: string | null;
  notes: string | null;
  checked_at: string;
}

export interface ProspectSource {
  id: string;
  kind: string;
  url: string;
  title: string | null;
  published_at: string | null;
  excerpt: string | null;
  rank: number | null;
  outcome: string | null;
  discovery_segment: DiscoverySegment | null;
  created_at: string;
  provider_calls: { provider: string; query: string | null; method: string | null } | null;
}

export interface ScreeningSignal {
  id: string;
  signal_type: string;
  title: string;
  observed_evidence: string;
  interpretation: string;
  business_relevance: string;
  critical_unknowns: string[];
  next_validation: string;
  source_urls: string[];
  confidence: Confidence;
  model: string | null;
  created_at: string;
}

export interface DecisionMakerReview {
  id: string;
  decision_maker_id: string;
  decision: 'confirmed' | 'rejected';
  source_url: string | null;
  notes: string | null;
  created_at: string;
}

export interface DecisionMakerRow {
  id: string;
  name: string;
  title: string | null;
  role_category: string;
  profile_url: string | null;
  source_url: string | null;
  provider: string | null;
  source_published_at: string | null;
  match_confidence: Confidence | null;
  employment_status: 'current' | 'undated' | 'unverified' | null;
  role_started_on: string | null;
  match_basis: string | null;
  discovered_at: string;
  decision_maker_reviews: DecisionMakerReview[];
}

export interface ProspectDetail {
  facts: ProspectFact[];
  sources: ProspectSource[];
  signals: ScreeningSignal[];
  decisionMakers: DecisionMakerRow[];
}

export interface ResearchRunSummary {
  id: string;
  company_id: string;
  status: string;
  finding_count: number;
  analyst_model: string;
  estimated_cost_usd: number;
  billed_cost_usd: number | null;
  started_at: string;
  research_runs: { estimated_cost_usd: number | null } | null;
}

export interface ProspectBoard {
  prospects: ProspectRow[];
  scores: ProspectScore[];
  overrides: ProspectOverride[];
  decisions: ProspectDecision[];
  segments: Array<{ company_id: string; discovery_segment: DiscoverySegment }>;
  research: ResearchRunSummary[];
  spentUsd: number;
}

export interface ImportRow {
  name: string;
  domain: string;
  category?: string;
  country?: string;
  notes?: string;
}

export interface ImportResult {
  domain: string;
  name: string;
  outcome: 'new' | 'duplicate' | 'invalid';
  company_id?: string;
}
