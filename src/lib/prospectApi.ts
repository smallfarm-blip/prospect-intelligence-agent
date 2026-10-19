import { supabase } from '@/lib/supabase';
import type {
  DecisionMakerReview,
  FactAttribute,
  ImportResult,
  ImportRow,
  ProspectBoard,
  ProspectDecision,
  ProspectDecisionKind,
  ProspectDetail,
  ProspectFact,
  ProspectOverride,
  ReviewerFactStatus,
} from '@/lib/prospectTypes';

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`Could not load ${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`Could not load ${what}`);
  return res.data;
}

function saved<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`Could not save ${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`Could not save ${what}`);
  return res.data;
}

export async function loadBoard(): Promise<ProspectBoard> {
  const [prospects, scores, overrides, decisions, calls, segments, research] = await Promise.all([
    supabase.from('prospects').select('*, companies(name, canonical_domain, category, geography)').order('created_at', { ascending: false }).limit(1000),
    supabase.from('prospect_scores').select('*').order('computed_at', { ascending: false }).limit(5000),
    supabase.from('prospect_overrides').select('*').order('created_at', { ascending: false }).limit(5000),
    supabase.from('prospect_decisions').select('*').order('created_at', { ascending: false }).limit(5000),
    supabase.from('provider_calls').select('actual_cost_usd').limit(10000),
    supabase.from('prospect_sources').select('company_id, discovery_segment').not('discovery_segment', 'is', null).limit(10000),
    supabase
      .from('analysis_runs')
      .select('id, company_id, status, finding_count, analyst_model, estimated_cost_usd, billed_cost_usd, started_at, research_runs(estimated_cost_usd)')
      .order('started_at', { ascending: false })
      .limit(1000),
  ]);
  const spend = must(calls, 'search and screening costs') as Array<{ actual_cost_usd: number | null }>;
  return {
    prospects: must(prospects, 'prospects') as ProspectBoard['prospects'],
    scores: must(scores, 'scores') as ProspectBoard['scores'],
    overrides: must(overrides, 'score changes') as ProspectBoard['overrides'],
    decisions: must(decisions, 'qualification decisions') as ProspectBoard['decisions'],
    segments: must(segments, 'discovery segments') as ProspectBoard['segments'],
    research: must(research, 'existing research') as unknown as ProspectBoard['research'],
    spentUsd: spend.reduce((s, c) => s + Number(c.actual_cost_usd ?? 0), 0),
  };
}

export async function loadProspectDetail(companyId: string): Promise<ProspectDetail> {
  const [facts, sources, signals, people] = await Promise.all([
    supabase.from('prospect_facts').select('*').eq('company_id', companyId).order('checked_at', { ascending: false }),
    supabase.from('prospect_sources').select('*, provider_calls(provider, query, method)').eq('company_id', companyId).order('created_at', { ascending: false }),
    supabase.from('screening_signals').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
    supabase.from('decision_makers').select('*, decision_maker_reviews(*)').eq('company_id', companyId).order('discovered_at'),
  ]);
  const decisionMakers = must(people, 'decision-makers') as ProspectDetail['decisionMakers'];
  for (const d of decisionMakers) d.decision_maker_reviews.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return {
    facts: must(facts, 'facts') as ProspectDetail['facts'],
    sources: must(sources, 'sources') as ProspectDetail['sources'],
    signals: must(signals, 'screening signals') as ProspectDetail['signals'],
    decisionMakers,
  };
}

/** previous_value and reviewer_id are filled in by the database. */
export async function submitProspectOverride(input: { companyId: string; field: 'score' | 'fit_status'; newValue: string; reason: string }): Promise<ProspectOverride> {
  return saved(
    await supabase.from('prospect_overrides').insert({ company_id: input.companyId, field: input.field, new_value: input.newValue, reason: input.reason.trim() }).select('*').single(),
    'change',
  ) as ProspectOverride;
}

export async function submitProspectDecision(input: {
  companyId: string;
  decision: ProspectDecisionKind;
  reason: string;
  expectedCostUsd: number | null;
  reviewSeconds: number;
}): Promise<ProspectDecision> {
  return saved(
    await supabase
      .from('prospect_decisions')
      .insert({
        company_id: input.companyId,
        decision: input.decision,
        reason: input.reason.trim(),
        expected_cost_usd: input.decision === 'request_research' ? input.expectedCostUsd : null,
        review_seconds: Math.min(86400, Math.max(0, Math.round(input.reviewSeconds))),
      })
      .select('*')
      .single(),
    'decision',
  ) as ProspectDecision;
}

export async function submitReviewerFact(input: {
  companyId: string;
  attribute: FactAttribute;
  valueText: string;
  valueNumber: number | null;
  status: ReviewerFactStatus;
  sourceUrl: string | null;
  excerpt: string | null;
  notes: string | null;
}): Promise<ProspectFact> {
  return saved(
    await supabase
      .from('prospect_facts')
      .insert({
        company_id: input.companyId,
        attribute: input.attribute,
        value_text: input.valueText.trim(),
        value_number: input.valueNumber,
        status: input.status,
        source_url: input.sourceUrl,
        excerpt: input.excerpt,
        notes: input.notes,
      })
      .select('*')
      .single(),
    'fact',
  ) as ProspectFact;
}

export async function submitDecisionMakerReview(input: { decisionMakerId: string; decision: 'confirmed' | 'rejected'; sourceUrl: string | null; notes: string | null }): Promise<DecisionMakerReview> {
  return saved(
    await supabase
      .from('decision_maker_reviews')
      .insert({ decision_maker_id: input.decisionMakerId, decision: input.decision, source_url: input.sourceUrl, notes: input.notes })
      .select('*')
      .single(),
    'contact review',
  ) as DecisionMakerReview;
}

export async function existingDomains(domains: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(domains.filter(Boolean))];
  const out = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 200) {
    const rows = must(await supabase.from('companies').select('name, canonical_domain').in('canonical_domain', unique.slice(i, i + 200)), 'existing companies') as Array<{ name: string; canonical_domain: string }>;
    for (const r of rows) out.set(r.canonical_domain, r.name);
  }
  return out;
}

export async function importProspects(origin: 'manual_entry' | 'csv_import', rows: ImportRow[]): Promise<ImportResult[]> {
  const res = await supabase.rpc('import_prospects', { p_origin: origin, p_rows: rows });
  if (res.error) throw new Error(`Could not import companies: ${res.error.message}`);
  if (!Array.isArray(res.data)) throw new Error('Could not import companies: unexpected response');
  return res.data as ImportResult[];
}
